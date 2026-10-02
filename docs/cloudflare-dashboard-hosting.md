# Hosting the master dashboard on Cloudflare

The master dashboard (`src/server.js` + `public/`) runs on Cloudflare as its own
Worker, `officeos-dashboard`. It is **separate** from the mailer relay
(`officeos-mailer`) and from the pre-existing dev-assistant.

```
npm run dashboard:deploy      # deploy
npm run dashboard:dev         # local Worker runtime
npm run dashboard:logs        # tail live logs
npm test:dashboard            # 146 offline assertions
npm run test:dashboard:mutation   # 22/22 mutations caught
npm run test:dashboard:live       # sweep the deployed read-only routes
```

Live: `https://officeos-dashboard.taion16240.workers.dev`

---

## The important part: no application code was changed

`src/server.js`, `src/db.js`, `src/sheets.js` and the other 13 modules in the
dashboard's import graph are **byte-for-byte identical** to the version on your
laptop. Not "ported" — identical. The email path, the ClickUp path and the
report logic are not edited, forked or reimplemented.

You can check that yourself at any time:

```bash
git diff --name-only HEAD -- src/ public/     # must print nothing
```

`verify-dashboard-hosting.mjs` asserts this on every run.

## Why it needed doing at all

A Worker has no filesystem and no listening socket, so the dashboard cannot
simply be pointed at. This was tested rather than assumed — importing the real
dependency tree into `workerd` fails **at startup**, before serving anything:

```
service core:user:wfprobe: Uncaught TypeError: The "path" argument must be
of type string or an instance of URL. Received undefined
  at fileURLToPath in src/db.js
X The Workers runtime failed to start.
```

`src/db.js` calls `fileURLToPath(import.meta.url)` at module top level, and
`src/server.js` calls `server.listen(3000)`. Neither can work in a Worker.

## How it works: shims, not a rewrite

`cloudflare-worker/dashboard-wrangler.toml` uses wrangler's `[alias]` table to
redirect each Node-only module at bundler level:

| Node module | replaced by | what it does |
|---|---|---|
| `node:fs`, `fs` | `dashboard/kv-shim.js` | `data/*.json` → Workers KV |
| `node:http`, `http` | `dashboard/http-shim.js` | captures the request handler |
| `node:url`, `url` | `dashboard/url-shim.js` | survives the `import.meta.url` crash |
| `googleapis` | `dashboard/google-shim.js` | REST + WebCrypto RS256 JWT |
| `google-auth-library` | `dashboard/google-shim.js` | the `JWT` class |
| `nodemailer` | `dashboard/nodemailer-stub.js` | **throws on purpose** |
| `dotenv/config` | `dashboard/dotenv-stub.js` | no disk, no-op |

`public/` is served by Workers static assets, byte-identical to the local files.

### The synchronous-filesystem problem

This is the part that shaped the design. `src/db.js` is **synchronous**:

```js
export function dbRead(name)  { return fs.existsSync(fp(name)) ? JSON.parse(fs.readFileSync(fp(name),'utf8')) : null }
export function dbWrite(name, d) { fs.writeFileSync(fp(name), JSON.stringify(d, null, 2), 'utf8') }
```

KV is asynchronous. Porting `db.js` to KV properly would mean threading
`await` through 1967 lines and every one of the 153 routes that call it. So
`kv-shim.js` keeps the **synchronous signature** by serving reads from an
in-memory map warmed once per isolate, and turning writes into KV puts that the
caller does not await. `db.js` cannot tell the difference.

**What that costs, stated plainly:**

- Writes are not awaited. Same last-write-wins as a JSON file — no behaviour
  change.
- The cache is **per-isolate and eventually consistent**. Many isolates, no
  shared memory; an isolate warmed 30s ago will not see a write another isolate
  made 5s ago. Fine for one superadmin and a few tabs. **Not** fine for
  concurrent multi-user editing.
- `rag-index.json` (1.9 MB) and `assistant-metrics.json` are in `NEVER_WRITE`.
  Writing them from a Worker throws instead of corrupting a local artefact.

---

## Two things this deployment is deliberately more powerful than

**1. It can delete columns from live client spreadsheets.**
`src/sheets.js` issues `deleteDimension` (column cleanup) and `batchUpdate` row
reconciliation. That is why every route except the health check is behind a
gate, and why the gate **fails closed** — an unset `ADMIN_TOKEN` refuses
everything rather than opening the surface.

**2. The service account needs the full `spreadsheets` scope, not `readonly`.**
The mailer Worker deliberately requests `spreadsheets.readonly`. The dashboard
writes, so it cannot. The key behind this Worker is strictly more powerful than
the one behind the mailer.

### A GET that writes

`GET /api/master/daily-review` looks read-only but runs a background reconcile
that issues `batchUpdate` against a live sheet. On a laptop that is a surprise;
on a public URL it means any authenticated browser prefetch or link-preview bot
can mutate client data. It was not called during verification and is excluded
from the live sweep.

`GET /api/master/sheets/cache-status` and anything matching `sync` are excluded
for the same reason. `npm run test:dashboard:live` enforces this.

---

## Signing in

The gate accepts both:

```
Authorization: Bearer <token>     # scripts, curl, the local agent
Authorization: Basic <base64>     # a browser
```

A browser cannot set an `Authorization` header on a navigation, so the `401`
carries `WWW-Authenticate: Basic realm="OfficeOS Master Dashboard"`. The
browser raises its own sign-in dialog — **any username, and the token as the
password.** Verified: with the challenge present, `master-app.js` and
`master.css` load and all 28 read-only routes answer.

Without this the hosted dashboard was unusable in a browser — it returned a bare
`401` JSON blob with no way forward. That was found by actually opening the URL,
not by reading the code.

### The token

A **dedicated** `DASHBOARD_ADMIN_TOKEN`, separate from the mailer's
`ADMIN_TOKEN`, because this surface is more dangerous. It lives in `.env`
(gitignored) and as a Worker secret. Never in the toml.

### Recommended: put it behind Cloudflare Access

The bearer token is a shared secret with no expiry, no revocation and no idea
who used it. Cloudflare Access gives you real identity, a session, per-user
audit, and no token to leak. The gate here is defence in depth, not a
replacement.

---

## The sheet id trap (found by asking "why is this hardcoded?")

`src/` resolves sheets like this in ~15 places:

```js
process.env.CW_SPREADSHEET_ID || '<a stale test sheet, hardcoded in src/db.js>'
```

On the laptop that is harmless — `.env` always supplies the variable, so the
literal never runs. **A Worker has no `.env`,** so the variable is unset, the
literal wins, and the cloud copy reads a *different spreadsheet* than the laptop.

Three distinct sheets exist across the candidates, all test copies. Ids are
abbreviated here deliberately — this file is committed to a public repository, and
`npm run probe:sheets` prints the full ids for anyone who needs them:

| source | sheet title |
|---|---|
| `.env` / Sheet Manager | 2TEST_AUTOMATION_CW- Web Maintenance Report |
| `src/config.js` default | Automation --- CW- Web Maintenance Report |
| `src/db.js` literal | TEST AUTIOMATION of CW- Web Maintenance Report |

The Worker was reading the third. The tell was in the data — `/api/master/months`
filters header cells at index ≥ 9, and the live sheet has an extra leading
column, so the month list came back offset by one:

```
local  -> "Maintenance Report URL, Backup URL, March 22, …"
Worker -> "Backup URL, March 22, April 22, …"
```

Both returned HTTP 200. Both looked healthy. No error, no warning, nothing in the
logs — just different data.

**Fixed without touching `src/`:** `[vars]` in `dashboard-wrangler.toml` now
pins `CW_SPREADSHEET_ID` and `RM_SPREADSHEET_ID` to the Sheet Manager values.
Worker and laptop now return byte-identical month lists (57/57).

**Still open:** the literals in `src/` disagree with the sheet manager. The
durable fix is to delete the `|| literal` so a missing id throws instead of
silently defaulting. That is a `src/` edit, so it is not done.

`scratch/audit-hardcoded-sheet-ids.mjs` prints the full map and gates on
Worker/laptop agreement. Mutations D23 and D24 prove that gate bites.

---

## State: the hosted copy is currently EMPTY

`data/*.json` on the laptop has 701 records / 1.05 MB. Cloudflare KV has none,
so hosted `/api/master/stats` reports 0 sites even though the sheet has 104.
Everything that reads the **sheet** works (months, overview, site counts); only
the KV-backed records are blank.

Nothing has been seeded. `npm run dashboard:seed:dryrun` prints exactly what
would be uploaded, and uploads nothing.

Seeding is a decision, not a formality: it creates a **second writable copy** of
client data — site URLs, team names, domain expiry dates — in Cloudflare, where
the sheet sync can now drift from it. The alternative is to leave the dashboard
on the laptop behind Access, where the data already is.

## What is verified

```
verify-dashboard-hosting        148/148
mutation-dashboard-hosting      24/24 caught, all targets restored
audit-hardcoded-sheet-ids       8/8, Worker and laptop resolve the same sheets
live sweep                      28/28 read-only routes 200
frontend                        0 console errors, 104 sites / 187 tasks
assets                          byte-identical to public/
sheet agreement                 month lists byte-identical, 57/57
```

The live sweep only calls routes `classify-routes.mjs` proved read-only. No
POST, PUT or DELETE is ever sent, and no dry run is involved — it is a real read
against the real sheets.
