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

- Cloud cron: every 10 min, at most `CLOUD_SLICE_SIZE` (40) sites per run →
  6 runs/hour → **288 scheduled runs/day → ~576 KV writes/day** for state, well
  inside 1,000. Reads are per-request and far below 100,000.
- The cloud slice takes the worst sites first (down → never checked → stalest),
  so a worker-only deployment still covers the whole fleet over several runs.
- Tightening is a one-line change in `dashboard-wrangler.toml`.

## Knobs (all optional, all read-only)

| Variable | Default | Effect |
| --- | --- | --- |
| `UPTIME_MONITOR_ENABLED` | `true` | `false` stops the local scheduler; the manual sweep endpoint still works |
| `UPTIME_MONITOR_INTERVAL_MS` | `180000` | local sweep cadence |
| `UPTIME_PROBE_TIMEOUT_MS` | `7000` | per-probe ceiling |

Turning the monitor off leaves the last known state on the records, so the dots
keep showing what was last seen rather than going blank.

## Tests

```
node scratch/verify-uptime-monitor.mjs   # hysteresis, sweep priority, probe ladder, real sweeps
node scratch/verify-cache-layer.mjs      # sheets SWR + persistence, db memoisation
```

Both run against a throwaway `OFFICEOS_DATA_DIR` and a throwaway local HTTP
server. Neither touches live data, Google, or the network beyond `127.0.0.1`.

## Rolling it back

`backups/uptime-perf-20261019/` holds the pre-change bytes of every file this
work touched, plus `rollback.ps1` and `restore.ps1`. See the README there.
