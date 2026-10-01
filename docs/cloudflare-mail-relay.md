# Cloudflare mail relay

How the two halves of the system fit together, and how to deploy it.

---

## The shape of it

```
  Google Sheets (CW / RM)
            |
            |  read-only
            v
  +----------------------------------+
  |  Cloudflare Worker               |   the planner and the ledger
  |  cloudflare-worker/             |   - reads the master tab
  |    mailer-worker.js              |   - decides who is due a report
  |    schema.sql  (D1)              |   - writes a job per site
  +----------------------------------+   - serves the after-action report
            |                                    ^
            |  POST /api/jobs/next               |  GET /api/report
            |  (bearer RELAY_TOKEN)              |  GET /api/report.md
            v                                    |  GET /api/overview
  +----------------------------------+           |
  |  localMailAgent.js               |  POST /api/jobs/result
  |  runs on THIS machine            |---------------+
  |  - the only thing that sends mail|  (status, subject, body, clickup)
  +----------------------------------+
            |
            v
       SMTP  /  ClickUp
```

**Local never builds the run. The Worker does.** That is what lets a superadmin
queue work from anywhere, and what keeps the local machine as the only mail sender.

The Worker is also not a copy of the eligibility rules. It imports
`findHeaderRow`, `detectColumns`, `resolveMonthColumn`, `isActive`,
`isMarkedDone`, `isValidWebsiteUrl`, `parseContacts` and `findMatchingTab`
straight from `src/reportUtils.js`. Only the ~25-line walk down the rows is local
to the Worker, and that walk is pinned against `src/index.js` by
`scratch/verify-worker-parity.mjs`.

---

## Why the Worker does not build the email

`buildEmail` lives in `src/mailer.js` next to the per-account signature block and
the CID image specs, and that file imports `nodemailer` and `fs`. It cannot be
imported into a Worker. The alternative — copying the template — would leave two
templates, and the copy would be the one mailing real clients.

So the Worker decides **who** and the local agent builds **what**. There is
exactly one email template, and it is unchanged.

---

## Deploy

One-time:

```bash
npm install                     # installs wrangler as a devDependency
npx wrangler login              # opens a browser; approve the request
npx wrangler d1 create officeos-mailer
```

Copy the `database_id` from that output into
`cloudflare-worker/mailer-wrangler.toml`, replacing
`REPLACE_WITH_D1_DATABASE_ID`.

Create the tables:

```bash
npm run worker:schema
```

**`--remote` is not optional.** `wrangler d1 execute` writes to a local miniflare
SQLite file by default and reports success while leaving the real database
untouched, so a schema applied without `--remote` produces a Worker that answers
`500 D1_ERROR: no such table` on every endpoint that reads the ledger. The npm
script passes `--remote`.

Set the three secrets. Each one is a single line on stdin, so the service
account has to be minified first:

```bash
npx wrangler secret put RELAY_TOKEN --config cloudflare-worker/mailer-wrangler.toml
npx wrangler secret put ADMIN_TOKEN  --config cloudflare-worker/mailer-wrangler.toml

# the whole service-account.json on ONE line — this is the fiddly one
node -e "process.stdout.write(JSON.stringify(require('./service-account.json')))" \
  | npx wrangler secret put GOOGLE_SERVICE_ACCOUNT_JSON --config cloudflare-worker/mailer-wrangler.toml

# the two master-sheet ids, from .env, so they never enter git
(Get-Content .env | Select-String '^CW_SPREADSHEET_ID=').Split('=')[1].Trim() \
  | npx wrangler secret put CW_SPREADSHEET_ID --config cloudflare-worker/mailer-wrangler.toml
(Get-Content .env | Select-String '^RM_SPREADSHEET_ID=').Split('=')[1].Trim() \
  | npx wrangler secret put RM_SPREADSHEET_ID --config cloudflare-worker/mailer-wrangler.toml
```

`RELAY_TOKEN` is any long random string; the agent must present the same value.
`ADMIN_TOKEN` gates the superadmin endpoints. **If you skip it, the admin
endpoints are open to the internet** — see the note below.

Deploy:

```bash
npm run worker:deploy
```

This writes the deployed URL to stdout. Put it in `.env`:

```
MAILER_WORKER_URL=https://officeos-mailer.<your-subdomain>.workers.dev
RELAY_TOKEN=<the same value you put in the Worker secret>
AGENT_NAME=operator-laptop
```

`CW_SPREADSHEET_ID` and `RM_SPREADSHEET_ID` also ship as `REPLACE_WITH_…`
placeholders, because the config file is committed and this remote is public. Copy
them out of `.env` before deploying.

Leaving them as placeholders is safe here, which is the opposite of the CLI's
behaviour. `accountsFor()` drops any account whose id is blank or still a
placeholder, so a deploy you forgot comes up with **zero** configured accounts and
`/api/health` says `configuredAccounts: []` — and `/api/run` refuses by name
without ever reaching Google. `npm run send` has no equivalent guard, which is the
failure mode described at the end of this document.

---

## Running it

```bash
npm run relay:once            # drain whatever is pending, then exit
npm run relay:once -- --dry-run   # build every message, send nothing
npm run relay                 # poll until Ctrl-C
```

`--dry-run` still reads the report tabs and still builds the full message, so it
exercises everything except the SMTP handoff. Useful after a deploy.

---

## A dry run must never arm the queue

This is the sharpest edge in the system, and it is worth stating plainly.

`pending` is the only status `/api/jobs/next` hands out. So a planning run that
writes `pending` has *armed real client mail*, whether or not anyone intended a
send — the next `npm run relay` goes out to real people with no further question.
A rehearsal that does that is not a rehearsal.

Two independent locks, because the consequence is mail to real clients:

1. **The Worker.** A run created with `{"dryRun":true}` queues its jobs as
   `dry-run`, not `pending`. No agent can ever claim them. They are still written
   to the ledger, because "who *would* get mail, and who would be skipped and why"
   is exactly what a rehearsal is for. `/api/report` counts them under
   `summary.dryRun`, separately from `pending`, and the markdown says
   `queued by a DRY RUN (not sendable)`.

2. **The agent.** `runJob` refuses any job whose `status` is neither `pending` nor
   `claimed`, and reports it as skipped with the status named. It should be
   unreachable. It is checked anyway, because the cost is one comparison and the
   alternative is real mail from a replayed or mis-queried job.

Lock 2 is deliberately permissive about a *missing* `status`: that is the shape
`/api/jobs/next` actually returns, so treating it as a refusal would break every
real send.

Verified against the live deployment: a dry run leaves zero claimable jobs, and
`/api/jobs/next` returns an empty list afterwards.

One consequence to know about: `/api/jobs/next` **claims** — it is not a query.
Calling it consumes the pending pool, so a "let me just look" call empties the
queue.

---

## The API

All routes return JSON. The two marked `admin` take the `ADMIN_TOKEN` bearer.

| Route | Method | Token | What it does |
|---|---|---|---|
| `/api/health` | GET | none | which accounts are configured, whether the secrets are set |
| `/api/run` | POST | admin | plan a run: read the sheets, write a job per site. `{"dryRun":true}` plans without arming anything |
| `/api/jobs/next` | GET | `RELAY_TOKEN` | claim up to `?limit=` (max 20) pending jobs. **This has a side effect — it claims** |
| `/api/jobs/result` | POST | `RELAY_TOKEN` | report the outcome of one job |
| `/api/report` | GET | admin | the full after-action report, JSON |
| `/api/report.md` | GET | admin | the same thing as markdown |
| `/api/overview` | GET | admin | per-site status, for the dashboard |
| `/api/runs` | GET | admin | recent runs |

An unknown path returns a 404 that lists the real ones, so a typo is
self-correcting.

### The report

`/api/report` answers the question the whole thing exists for:

```jsonc
{
  "summary": {
    "total": 19, "sent": 12, "failed": 0, "skipped": 4, "pending": 3,
    "clickupSent": 9, "clickupSkipped": 2, "clickupDryRun": 0, "clickupFailed": 1,
    "recipients": 17
  },
  "jobs": [ /* every job: status, subject, full body, clickup outcome */ ],
  "didNotGetMail": [
    { "websiteUrl": "...", "account": "CW", "status": "skipped",
      "reason": "no matching report tab", "recipients": ["a@b.com"] }
  ]
}
```

`didNotGetMail` is the important half. A count cannot tell you *why* a site was
passed over; this lists every non-sent site with the reason and, where the
contacts were resolved before the skip, who would have received the mail.

`clickupStatus` is deliberately four-valued:

- `sent` — the task was actually closed
- `skipped` — there was no task id to act on
- `dry-run` — ClickUp was asked but declined, usually because
  `CLICKUP_AUTO_CLOSE_ENABLED` is off
- `failed` — it raised

A dry run is never recorded as `sent`. That distinction is the entire reason the
agent and the Worker separate "we mailed them" from "we updated their task".

### Markdown for the RAG system

`/api/report.md` is the same content as markdown, which is what a chunking loader
wants. One job per section, with the subject, the recipients, the ClickUp outcome
and the full body.

---

## Running the tests

Three suites, all offline, none of which can send mail:

```bash
npm run test:worker:parity    # the Worker's planner vs the real src/index.js
npm run test:worker:api       # routes, auth, the D1 ledger, the report
npm run test:agent:email      # the agent's email vs the product's own output
```

The parity suite runs the **real** `src/index.js` as a child process against a
fixture and requires it to agree with the Worker on every row. Nothing inside
`src/` is stubbed — only `src/sheets.js` is swapped, at Node's module resolution
boundary.

The email suite lets the product write its own dry-run preview, then requires the
agent's independently-built message to match that file, body and subject, for both
CW and RM. A per-account signature is exactly where a regression would hide, so
both are checked.

Each suite has a mutation harness next to it:

```bash
node scratch/mutation-worker-parity.mjs   # 8 mutations
node scratch/mutation-worker-api.mjs      # 12 mutations
node scratch/mutation-agent-email.mjs     # 8 mutations
```

These break the code in realistic ways — a guard deleted, a column index nudged,
two guards swapped, a ClickUp dry run reported as a real close, an unpasted
placeholder accepted as a real spreadsheet — and require the suite to go red.
28/28 are caught. A suite that cannot fail is not a test.

---

## Things worth knowing

**A missing `.env` makes `npm run send` mail from the wrong sheet.** With no
`.env`, `src/config.js` falls back to a stale spreadsheet id with 81 rows and 77
URLs, and the run proceeds with no error. Two sites on that sheet are stale. The
Worker does not have this failure mode, because its spreadsheet ids are explicit
`[vars]` rather than a fallback.

**`ADMIN_TOKEN` unset means the admin endpoints are open.** `/api/run`,
`/api/report` and `/api/overview` are readable and `/api/run` is callable by
anyone who finds the URL. `/api/health` will tell you whether it is set. If you
have any reason to leave it off, put Cloudflare Access in front of the Worker.

**The agent needs the report tab to exist.** It reads
`<matchedTab>` at `A1:D200` — the same range the CLI uses. A site whose tab is
missing is skipped by the planner, not discovered later by the agent.

**Conditional notes are resolved locally, on purpose.** The note-to-tab matching
reads the live report tab, so the agent does it rather than the Worker. A note
paragraph in an email therefore comes from `src/db.js` on this machine, not from
D1.

**One thing no fixture can prove.** The conditional-note paragraph needs a live
note in the database to fire, and no fixture can reach one. Rather than write a
note into the live database to find out, `verify-agent-email.mjs` requires the
agent to contain the CLI's `getConditionalNotes({ account, enabledOnly: true })`
call and to pass the resolved notes into `buildEmail`. That is a structural check
and the suite says so — it is not a behavioural one. If a real note ever fails to
appear in a relayed email, that is the gap to look at first.

**ClickUp will not write unless it is enabled.** `CLICKUP_AUTO_CLOSE_ENABLED`
must be `true` in `.env` for `completeClickUpMaintenanceTask` to change anything.
Left off, the agent records `dry-run` and the report says so. That is the
existing guard, untouched.

**One machine at a time.** The claim in `/api/jobs/next` moves a job out of
`pending` in the same statement that hands it over, so two agents will not pick up
the same job. There is no lease expiry: if an agent claims a job and then dies,
that job stays `claimed` and will not be re-offered. It is still visible in the
report as a site that did not get mail, which is the honest outcome — but nobody
is automatically going to send it.

---

## What was deliberately not changed

`buildEmail`, `sendReportEmail` and `completeClickUpMaintenanceTask` are called,
not edited. Neither is anything else in `src/`. The only pre-existing file this
work modified is `package.json`, to add `wrangler` as a devDependency and the
`relay` / `worker:*` / `test:worker:*` scripts. A devDependency cannot affect
mail-sending logic.

There is also a pre-existing bug this work found and did **not** fix:
`src/index.js` passes `reportMonth.month` to
`completeClickUpMaintenanceTask`, but `resolveMonthColumn` returns a field called
`monthName`. The ClickUp comment therefore reads "the month of undefined 2026".
The agent builds that field correctly. Fixing the CLI is a one-word change, but
it is in existing code and was not asked for.
