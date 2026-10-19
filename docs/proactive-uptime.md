# Proactive uptime monitoring

The dashboard used to only know whether a site was down if somebody opened the
Uptime Monitor and clicked "Check all". It now checks on its own, on a timer, and
tells you — everywhere in the UI.

## What runs, where

| Where | What | Cadence |
| --- | --- | --- |
| This machine (Node server) | full sweep of every monitored site | `UPTIME_MONITOR_INTERVAL_MS`, default **180 s** |
| Cloudflare Worker | bounded slice of the fleet | cron `*/10 * * * *` (`dashboard-wrangler.toml`) |
| Browser tab | polls `GET /api/master/uptime-snapshot`, repaints dots, shows outage banner/badge/toast | every 60 s, only while the tab is visible |

The Node scheduler and the Worker cron never both run: `dashboard-worker.js` sets
`globalThis.__OFFICEOS_WORKER__ = true`, so `startLocalScheduler()` stands down
inside a Worker isolate and the `scheduled()` handler takes over.

## What counts as down

Two things, deliberately:

- **2 consecutive failures** flip a site to `offline`; **2 consecutive successes**
  flip it back. One blip is not an outage, and a site does not flicker.
- A site needs a **URL** and must not be **Deactive** to be monitored at all.
  Anything else is listed in the Uptime view as *not monitored* and is excluded
  from the counts, so the numbers on screen always match the banner.

Each check escalates only as far as it must:

1. `HEAD` on the URL in the sheet — the common case, one request.
2. `GET` with `Range: bytes=0-0` — for servers that hang or 405 on `HEAD`.
3. `GET` on the **site root** — for a listed path the site refuses to serve us
   (a bot-guarded `/wp-admin/`, say). The site is reported **up**, with a
   `root only` chip explaining which path did not answer.

Cells are cleaned before use: `Note:https://site.com/` is read as
`https://site.com/`, not as an invalid URL pretending to be an outage.

### When the machine itself goes offline

A laptop losing Wi-Fi fails **every** probe in the same sweep. That is not a
fleet outage, so it is not recorded as one: if at least 12 probes were attempted
and 80% or more of them failed, the sweep is discarded — no site record changes,
no alert, no KV write of false state. The discard is noted in
`data/meta.json → uptimeMeta.lastSkippedSweepAt` and in the server log.

The guard backs off: after **2** consecutive discarded sweeps the results are
trusted anyway, so a real mass outage is still reported (about 9 minutes late)
rather than hidden forever. Small and targeted sweeps are never guarded.

## What you see

- **Pinned banner** — one banner, from any view, listing the down sites with a
  *View* button. Dismissible per outage set (in that browser session only).
- **Nav badge** — red count next to *Uptime Monitor* in the sidebar.
- **Toast** — one per new outage transition, never repeated for the same one.
- **Uptime view** — monitor status bar (running/idle, mode, cadence, last sweep,
  down count), the four stat cards over the monitored set only, and rows with
  response time, an age stamp, a failure reason on down rows, a `root only` chip
  where that applies, and `not monitored` where the site is skipped.
- **Everywhere else** — the uptime pills in the All Sites table and other views
  are repainted in place from the snapshot (matched by site id, then URL), so the
  green/red dots are current without opening the Uptime view.

## Where the state lives

`data/sites.json` (per site): `uptimeStatus`, `uptimeFails`, `uptimePasses`,
`uptimeDownSince`, `uptimeLastError`, `uptimeNote`, `uptimeResponseTime`,
`uptimeStatusCode`, `lastUptimeCheck`.

`data/meta.json`: `uptimeMeta` (sweep counters, mode, cadence, last transition)
and `uptimeAlerts` (the capped transition feed the UI turns into toasts).

A sweep writes the site list **once** and the metadata **once** — no matter how
many sites it checked. That is what keeps the KV write budget intact.

## Free-plan budgeting (why the numbers are what they are)

KV allows 1,000 writes and 100,000 reads per day; Workers allow 50 subrequests
per invocation.

- Cloud cron: every 10 min → **144 ticks/day**, each checking at most
  `CLOUD_SLICE_SIZE` (12) sites and writing **2 KV keys** (sites + meta) →
  **~288 KV writes/day**, well inside 1,000. Reads are per-request and far below
  100,000.
- 12 is a **worst case**, not an average: one site can cost 3 subrequests
  (`HEAD` → ranged `GET` → site root), and the free plan allows 50 subrequests
  per invocation. The cron warms **2 keys** (`sites`, `meta`) and writes 2, so
  12 × 3 + 2 + 2 = **40 ≤ 50**. A 40-site slice blows that cap as soon as a
  dozen sites need a fallback rung — i.e. exactly during an incident.
- **KV operations are subrequests too.** This is what bit the first version of
  the guard (2026-10-19): the cron called `ensureWarm()`, which reads all 24
  `STATE_KEYS` — 24 of the 50 subrequests — and the tail of a cold tick then ran
  out mid-slice. The resulting platform error ("Too many subrequests by single
  Worker invocation") was recorded as a **site failure** and pushed three
  healthy sites to DOWN. Fixed by warming only `sites` + `meta` in
  `scheduled()`, and by classifying platform errors as `infra` rather than
  "offline" (see below).
- Coverage with the laptop off: 144 ticks × 12 = 1,728 site-checks/day over ~98
  monitored sites — every site roughly 17 times a day (~85 min cadence).
- The cloud slice takes the worst sites first (down → never checked → stalest),
  so a worker-only deployment still covers the whole fleet over several runs.
- Changing the cadence is a one-line change in `dashboard-wrangler.toml`;
  changing the slice is `CLOUD_SLICE_SIZE`.

## Knobs (all optional, all read-only)

| Variable | Default | Effect |
| --- | --- | --- |
| `UPTIME_MONITOR_ENABLED` | `true` | `false` stops the local scheduler; the manual sweep endpoint still works |
| `UPTIME_MONITOR_INTERVAL_MS` | `180000` | local sweep cadence |
| `UPTIME_PROBE_TIMEOUT_MS` | `7000` | per-probe ceiling |
| `UPTIME_MASS_FAILURE_GUARD` | `true` | `false` disables the "machine has no network" guard |
| `UPTIME_MASS_FAILURE_SKIPS` | `2` | consecutive all-fail sweeps to discard before trusting them |

Turning the monitor off leaves the last known state on the records, so the dots
keep showing what was last seen rather than going blank.

## Deploying the Worker

`npm run dashboard:deploy` is what puts the cron in the cloud — the local
scheduler does not need it.

`dashboard-wrangler.toml` keeps `[triggers]` at the **end** of the file on
purpose. In TOML every bare key after a table header belongs to that table, so a
`[triggers]` placed above `name` / `main` / `compatibility_date` /
`compatibility_flags` / `workers_dev` makes wrangler read those as `triggers.*`.
It then sees no `main`, treats the Worker as assets-only, and aborts with
`Cannot use assets with a binding in an assets-only Worker`.

Validate without deploying:

```
npx wrangler deploy --dry-run --config cloudflare-worker/dashboard-wrangler.toml
```

After a deploy, confirm which build is actually live (the asset query string is
the tell — `v=20261019_uptime_v7` or later, not `design_v3`):

```
curl -s https://<worker>/master.html | grep -o 'v=20[0-9]*_[A-Za-z0-9_]*'
```

## Worker budget (free plan)

The Worker gets 50 subrequests per invocation, 1,000 KV writes/day and 100k
requests/day. Four rules keep uptime inside that:

- **Probes never follow redirects** (`redirect: 'manual'`). One probe = one
  subrequest, always; a 3xx (or an opaque redirect with status 0) counts as
  "serving", because the origin answered. Before this, an http→https→www chain
  cost extra subrequests and a redirect-heavy tick could blow the cap.
- **KV reads and writes spend the same budget as probes.** The cron handler
  warms exactly the two keys `runSweep()` touches (`sites`, `meta`); it does not
  call `ensureWarm()` (24 reads). Cron worst case: 2 reads + 12 × 3 probes + 2
  writes = **40**. A manual sweep runs after the request path has already warmed
  all 24 keys, so its batch is smaller: `WORKER_MANUAL_BATCH` (6) → 24 + 18 + 2 =
  **44**. 144 ticks/day × 2 writes = 288 writes/day, well inside 1,000.
- **Platform errors are never site failures.** `probe()` marks
  "Too many subrequests…", "Worker exceeded CPU…", "Network connection lost",
  etc. as `infra`; `checkSite()` returns `status: 'unknown'` and `sweepTargets()`
  drops the result before `applyResult()`. A budget overrun therefore cannot
  move a fail counter, fire a "down" toast, or write a false status to KV — it
  shows up as `skippedInfra` in the sweep response and in
  `monitor.lastSweepSkippedInfra`. Genuine failures ("fetch failed", DNS, TLS,
  timeouts) are unaffected and still count.
- **Manual sweeps are clamped on Workers** by `resolveSweepScope()` in
  `src/uptimeMonitor.js`. Both "check all" buttons post no scope; the Worker
  turns that into one 6-site batch (`scope.capped: true`, `workerBatch: true`)
  instead of ~294 subrequests, and the legacy `/api/master/check-uptime`
  all-check (which used to write KV once per site) is short-circuited to the
  same bounded sweep. Local behaviour stays unbounded (`cap: 0`).

`node scratch/verify-worker-budget.mjs` pins all of this down.

## Tests

```
node scratch/verify-uptime-monitor.mjs   # hysteresis, sweep priority, probe ladder, real sweeps
node scratch/verify-cache-layer.mjs      # sheets SWR + persistence, db memoisation
node scratch/verify-worker-budget.mjs    # subrequest + KV guards, no network
node scratch/verify-assignments.mjs      # My Tasks asks store (separate feature)
```

Both run against a throwaway `OFFICEOS_DATA_DIR` and a throwaway local HTTP
server. Neither touches live data, Google, or the network beyond `127.0.0.1`.

## Rolling it back

`backups/uptime-perf-20261019/` holds the pre-change bytes of every file this
work touched, plus `rollback.ps1` and `restore.ps1`. See the README there.
