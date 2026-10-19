/**
 * uptimeMonitor.js — PROACTIVE uptime monitoring.
 *
 * WHY THIS EXISTS
 * ---------------
 * Previously a site's uptime status only ever changed when a human asked for
 * it: opening the Uptime Monitor fired a one-shot sweep, and there were per-row
 * and bulk "check now" buttons. Between clicks nothing was checked, so the
 * dashboard could show a green "Online" dot for a site that had been dead for
 * hours. Uptime was presented as monitoring but behaved as an on-demand probe.
 *
 * This module makes it continuous:
 *
 *   - a background sweep re-checks sites on an interval and WRITES ONE TIME,
 *     so a sweep costs a single state write no matter how many sites change;
 *   - sites are checked in priority order (offline first, then never-checked,
 *     then the stalest) so a small slice per run still keeps the fleet fresh;
 *   - a site must fail DOWN_THRESHOLD times in a row before it is reported
 *     down, and pass UP_THRESHOLD times in a row before it is reported back
 *     up. One slow TLS handshake no longer raises an alarm;
 *   - every transition is appended to a capped event log the UI reads to raise
 *     a toast/banner without polling diffing anything itself.
 *
 * WHERE IT RUNS
 * -------------
 *   local  — src/server.js starts startLocalScheduler() at boot. Full sweeps
 *            every UPTIME_MONITOR_INTERVAL_MS (default 3 min). This is the
 *            fast path while the operator's machine + dashboard are running.
 *   cloud  — cloudflare-worker/dashboard-worker.js exports a scheduled()
 *            handler that calls runSweep() with a bounded slice per cron tick,
 *            so monitoring continues with the laptop off. Workers cap
 *            subrequests, and KV bills writes, which is why the cloud path
 *            uses a slice (CLOUD_SLICE_SIZE) rather than the whole fleet.
 *
 * Nothing here writes to ClickUp, email, or any sheet — it only HTTP-checks
 * site URLs and updates the dashboard's own state (data/sites.json, meta).
 */

import { checkSite } from './uptime.js';
import * as db from './db.js';

/** Consecutive failures before a site is reported down. */
export const DOWN_THRESHOLD = 2;
/** Consecutive passes before a down site is reported back up. */
export const UP_THRESHOLD = 2;
/**
 * Sites per cloud sweep.
 *
 * Sized by the WORST case, not the average: a probe climbs the ladder (HEAD ->
 * ranged GET -> site root), so one site can cost 3 subrequests, and the free
 * plan caps a single invocation at 50. 12 x 3 = 36 leaves headroom for the
 * warm-up and for the KV reads/writes the sweep itself performs. A larger slice
 * looks cheaper only while every site answers its HEAD — the moment several
 * sites go flaky the invocation blows the cap and the whole tick is lost,
 * exactly when the monitor matters most.
 */
export const CLOUD_SLICE_SIZE = 12;
/** Worst-case subrequests one site can cost (the full probe ladder). */
export const MAX_PROBES_PER_SITE = 3;
/** How many transitions to keep for the UI alert feed. */
const EVENTS_CAP = 60;
/** Parallel HTTP checks in flight at once. */
const CONCURRENCY = 10;

/**
 * Mass-failure guard. A laptop losing Wi-Fi, or the office DNS dying, fails
 * every probe in the same sweep. Recording that would flip the whole fleet to
 * offline, fill the alert feed, and — in the Worker — write the false state to
 * KV. When at least MASS_FAILURE_MIN probes were attempted and this share of
 * them failed, the sweep is treated as a local-network event and discarded.
 * If it persists for MASS_FAILURE_MAX_SKIPS sweeps it is more likely real, and
 * the results are applied normally.
 */
const MASS_FAILURE_MIN = 12;
const MASS_FAILURE_RATIO = 0.8;
const MASS_FAILURE_MAX_SKIPS = 2;

let timer = null;
let state = {
  enabled: false,
  mode: null,          // 'local' | 'cloud'
  intervalMs: 0,
  startedAt: null,
  runs: 0,
  lastRunAt: null,
  lastError: null,
  massFailureStreak: 0,
};

function nowIso() { return new Date().toISOString(); }

/** Sites we monitor: active only, with a usable URL. */
function monitorable(sites) {
  return sites.filter(s => s && s.url && String(s.url).trim() && String(s.status || '').toLowerCase() !== 'deactive');
}

function isUnknown(site) {
  return !site.uptimeStatus || site.uptimeStatus === 'unknown';
}

/**
 * Pure state machine: fold one check result into a site record.
 * Exported so scratch/verify-uptime-monitor.mjs can test the hysteresis
 * without any network.
 *
 * @returns {{ site: object, transition: null | { type:'down'|'up', ... } }}
 */
export function applyResult(site, result) {
  const at = (result && result.checkedAt) || nowIso();
  const s = { ...site };
  // Normalise: records that have never been checked carry no uptimeStatus at
  // all. Make it explicit so every reader (tables, badges, snapshot) sees one
  // of online | offline | unknown instead of undefined.
  if (!s.uptimeStatus) s.uptimeStatus = 'unknown';
  const wasDown = s.uptimeStatus === 'offline';
  const unknown = s.uptimeStatus === 'unknown';
  let transition = null;

  if (result && result.status === 'online') {
    s.uptimeFails = 0;
    s.uptimePasses = (s.uptimePasses || 0) + 1;
    s.uptimeLastOnlineAt = at;
    s.uptimeLastError = null;
    // A reachable site can still come with a caveat (e.g. the listed path is
    // guarded but the site root answered). Keep it on the record so the row can
    // explain itself; cleared the moment the site genuinely fails.
    s.uptimeNote = (result && result.note) || null;
    if (unknown) {
      // First ever successful check — no ceremony, just come online.
      s.uptimeStatus = 'online';
      s.uptimeDownSince = null;
    } else if (wasDown && s.uptimePasses >= UP_THRESHOLD) {
      transition = {
        type: 'up',
        siteId: s.id,
        url: s.url,
        at,
        downSince: s.uptimeDownSince || null,
        downMs: s.uptimeDownSince ? Math.max(0, Date.parse(at) - Date.parse(s.uptimeDownSince)) : null,
      };
      s.uptimeStatus = 'online';
      s.uptimeDownSince = null;
    }
  } else {
    s.uptimePasses = 0;
    s.uptimeFails = (s.uptimeFails || 0) + 1;
    s.uptimeLastError = (result && result.error) || 'Unreachable';
    s.uptimeNote = null;
    // One failure is noise (slow TLS, DNS blip) — only a streak is an outage.
    if (!wasDown && s.uptimeFails >= DOWN_THRESHOLD) {
      s.uptimeStatus = 'offline';
      s.uptimeDownSince = s.uptimeDownSince || at;
      transition = {
        type: 'down',
        siteId: s.id,
        url: s.url,
        account: s.account || null,
        at,
        statusCode: (result && result.statusCode) || null,
        error: (result && result.error) || null,
      };
    } else if (wasDown) {
      s.uptimeDownSince = s.uptimeDownSince || at;
    }
  }

  if (result) {
    if (result.statusCode !== undefined && result.statusCode !== null) s.uptimeStatusCode = result.statusCode;
    s.uptimeResponseTime = (result.status !== undefined && result.responseTime !== undefined) ? result.responseTime : s.uptimeResponseTime;
  }
  s.lastUptimeCheck = at;
  s.uptimeChecks = (s.uptimeChecks || 0) + 1;
  return { site: s, transition };
}

/**
 * Which sites to check this run, in priority order:
 *   0 = currently down (re-check every run)
 *   1 = never checked / unknown
 *   2 = everything else, stalest first
 * A `limit` of 0 means "all".
 */
export function selectCandidates(sites, { limit = 0, siteIds = null } = {}) {
  let pool = monitorable(sites);
  if (Array.isArray(siteIds) && siteIds.length) {
    const want = new Set(siteIds);
    pool = pool.filter(s => want.has(s.id));
  }
  const rank = (s) => {
    if (s.uptimeStatus === 'offline') return 0;
    if (isUnknown(s)) return 1;
    return 2;
  };
  const staleness = (s) => {
    const t = s.lastUptimeCheck ? Date.parse(s.lastUptimeCheck) : 0;
    return Number.isFinite(t) ? t : 0;
  };
  const ordered = pool.slice().sort((a, b) => {
    const r = rank(a) - rank(b);
    if (r !== 0) return r;
    return staleness(a) - staleness(b);
  });
  return limit > 0 ? ordered.slice(0, limit) : ordered;
}

/** Run `checkSite` over a list with bounded concurrency. */
async function sweepTargets(targets) {
  const results = new Map();
  let cursor = 0;
  const lanes = Math.max(1, Math.min(CONCURRENCY, targets.length || 1));
  await Promise.all(Array.from({ length: lanes }, async () => {
    while (cursor < targets.length) {
      const site = targets[cursor++];
      let result;
      try {
        result = await checkSite(site.url);
      } catch (e) {
        result = { status: 'offline', error: (e && e.message) || 'Check failed', checkedAt: nowIso() };
      }
      results.set(site.id, result);
    }
  }));
  return results;
}

/**
 * One sweep.
 *
 * @param {object} [opts]
 * @param {number} [opts.limit]     max sites this run (0 / undefined = all)
 * @param {string} [opts.source]    'local' | 'cloud' | 'manual'
 * @param {string[]} [opts.siteIds] check only these site ids (manual, targeted)
 * @returns {Promise<object>} summary
 */
export async function runSweep(opts = {}) {
  const { limit = 0, source = 'local', siteIds = null } = opts;
  const startedAt = Date.now();

  const targets = selectCandidates(db.getSites(), { limit, siteIds });
  if (!targets.length) {
    return { ok: true, checked: 0, source, note: 'no monitorable sites', transitions: [] };
  }

  const results = await sweepTargets(targets);

  // ── Mass-failure guard ────────────────────────────────────────────────────
  // Distinguish "one site is down" from "this machine has no network". The
  // latter is not a fleet outage and must not be written into the records.
  const guardOn = String(process.env.UPTIME_MASS_FAILURE_GUARD ?? 'true').toLowerCase() !== 'false';
  const attempted = results.size;
  const failed = Array.from(results.values()).filter(r => r.status !== 'online').length;
  const massFailure = guardOn && attempted >= MASS_FAILURE_MIN && failed / attempted >= MASS_FAILURE_RATIO;

  if (massFailure) {
    const parsedSkips = Number(process.env.UPTIME_MASS_FAILURE_SKIPS);
    const skipLimit = Number.isFinite(parsedSkips) && parsedSkips >= 0 ? parsedSkips : MASS_FAILURE_MAX_SKIPS;

    if (state.massFailureStreak < skipLimit) {
      state.massFailureStreak++;
      const at = nowIso();
      const meta = db.getMeta() || {};
      db.setMeta({
        uptimeMeta: {
          ...(meta.uptimeMeta || {}),
          lastSkippedSweepAt: at,
          lastSkippedSweepChecked: attempted,
          lastSkippedSweepFailed: failed,
          lastSkippedSweepStreak: state.massFailureStreak,
          lastSkippedSweepReason: 'mass failure - presumed local network loss; results discarded',
        },
      });
      state.runs++;
      state.lastRunAt = at;
      state.lastError = `mass failure: ${failed}/${attempted} probes failed - sweep discarded`;
      const allDown = monitorable(db.getSites()).filter(s => s.uptimeStatus === 'offline');
      return {
        ok: true,
        skipped: true,
        reason: 'mass-failure',
        source,
        checked: 0,
        online: 0,
        offline: 0,
        unknown: 0,
        attempted,
        failed,
        transitions: [],
        downCount: allDown.length,
        tookMs: Date.now() - startedAt,
        lastSweepAt: at,
        note: 'mass failure discarded - local network suspected',
      };
    }

    // Persistent: past the skip budget, so trust it and fall through.
    state.massFailureStreak++;
  } else {
    state.massFailureStreak = 0;
  }

  // Re-read immediately before writing so the write window is as small as it
  // can be: any site edited while the checks were in flight keeps its edit.
  const fresh = db.getSites();
  const byId = new Map(fresh.map(s => [s.id, s]));
  const transitions = [];
  let changed = 0;
  let online = 0;
  let offline = 0;
  let unknown = 0;

  for (const [siteId, result] of results) {
    const current = byId.get(siteId);
    if (!current) continue;
    const { site, transition } = applyResult(current, result);
    byId.set(siteId, site);
    changed++;
    if (transition) transitions.push(transition);
    if (site.uptimeStatus === 'offline') offline++;
    else if (site.uptimeStatus === 'online') online++;
    else unknown++;
  }

  // ONE write for the whole sweep — this is what keeps the cloud cron inside
  // the free KV write budget.
  if (changed) db.setSites(Array.from(byId.values()));

  const finishedAt = nowIso();
  const meta = db.getMeta() || {};
  const alerts = [...(meta.uptimeAlerts || []), ...transitions].slice(-EVENTS_CAP);
  const prevMeta = meta.uptimeMeta || {};
  db.setMeta({
    uptimeAlerts: alerts,
    uptimeMeta: {
      lastSweepAt: finishedAt,
      lastSweepMs: Date.now() - startedAt,
      lastSweepSource: source,
      lastSweepChecked: changed,
      lastSweepOnline: online,
      lastSweepOffline: offline,
      lastSweepUnknown: unknown,
      sweepCount: (prevMeta.sweepCount || 0) + 1,
      lastTransitionAt: transitions.length ? finishedAt : prevMeta.lastTransitionAt || null,
    },
  });

  state.runs++;
  state.lastRunAt = finishedAt;
  state.lastError = null;

  const all = db.getSites();
  const down = monitorable(all).filter(s => s.uptimeStatus === 'offline');
  return {
    ok: true,
    source,
    checked: changed,
    online,
    offline,
    unknown,
    transitions,
    downCount: down.length,
    tookMs: Date.now() - startedAt,
    lastSweepAt: finishedAt,
  };
}

/**
 * Fast read path for the UI. Pure DB read — no Google, no HTTP, no network.
 * Returns compact per-site rows plus the down list and the recent transitions.
 */
export function getSnapshot() {
  const sites = monitorable(db.getSites());
  const meta = db.getMeta() || {};
  const down = [];
  const rows = [];
  let online = 0;
  let offline = 0;
  let unknown = 0;

  for (const s of sites) {
    const status = s.uptimeStatus || 'unknown';
    if (status === 'offline') offline++;
    else if (status === 'online') online++;
    else unknown++;
    rows.push({
      id: s.id,
      u: s.url,
      s: status,
      c: s.uptimeStatusCode ?? null,
      ms: s.uptimeResponseTime ?? null,
      at: s.lastUptimeCheck || null,
      f: s.uptimeFails || 0,
      n: s.uptimeNote || null,
    });
    if (status === 'offline') {
      down.push({
        id: s.id,
        url: s.url,
        account: s.account || null,
        downSince: s.uptimeDownSince || s.lastUptimeCheck || null,
        statusCode: s.uptimeStatusCode ?? null,
        error: s.uptimeLastError || null,
      });
    }
  }

  down.sort((a, b) => String(a.downSince).localeCompare(String(b.downSince)));
  const alerts = (meta.uptimeAlerts || []).slice(-20);

  return {
    ok: true,
    generatedAt: nowIso(),
    summary: { total: sites.length, online, offline, unknown, downCount: down.length },
    sites: rows,
    down,
    alerts,
    lastSweepAt: (meta.uptimeMeta && meta.uptimeMeta.lastSweepAt) || null,
    monitor: {
      enabled: state.enabled,
      mode: state.mode,
      intervalMs: state.intervalMs,
      startedAt: state.startedAt,
      runs: state.runs,
      lastRunAt: state.lastRunAt,
      lastError: state.lastError,
    },
  };
}

/** What the monitor is doing right now (used by the status chip in the UI). */
export function getMonitorState() {
  return { ...state };
}

function isWorker() {
  return typeof globalThis !== 'undefined' && globalThis.__OFFICEOS_WORKER__ === true;
}

/**
 * Start the local (Node) scheduler. No-op in the Cloudflare Worker (the cron
 * trigger + scheduled() handler cover that path) and when disabled by env:
 *
 *   UPTIME_MONITOR_ENABLED=false      turn the background monitor off
 *   UPTIME_MONITOR_INTERVAL_MS=60000  override the sweep interval (default 3 min)
 *
 * Never edits .env — these are read-only knobs with safe defaults.
 */
export function startLocalScheduler(opts = {}) {
  if (isWorker()) return false;
  if (timer) return true;

  const enabled = String(process.env.UPTIME_MONITOR_ENABLED ?? 'true').toLowerCase() !== 'false';
  state.enabled = enabled;
  state.mode = 'local';
  if (!enabled) {
    console.log('[uptime] Background monitor disabled (UPTIME_MONITOR_ENABLED=false)');
    return false;
  }

  const parsed = Number(opts.intervalMs || process.env.UPTIME_MONITOR_INTERVAL_MS || 0);
  const intervalMs = Number.isFinite(parsed) && parsed >= 15000 ? parsed : 3 * 60 * 1000;
  state.intervalMs = intervalMs;
  state.startedAt = nowIso();

  const tick = async () => {
    try {
      const r = await runSweep({ source: 'local' });
      if (r.skipped) {
        console.warn(`[uptime] sweep discarded: ${r.failed}/${r.attempted} probes failed — probable local network loss (nothing recorded)`);
        return;
      }
      const downNote = r.downCount ? ` — ${r.downCount} DOWN` : '';
      console.log(`[uptime] sweep: ${r.checked} checked (${r.online} up, ${r.offline} down, ${r.unknown} unknown) in ${r.tookMs}ms${downNote}`);
      if (r.transitions && r.transitions.length) {
        for (const t of r.transitions) {
          console.log(`[uptime] ${t.type === 'down' ? '🔴 DOWN' : '🟢 UP'} ${t.url}${t.error ? ' (' + t.error + ')' : ''}`);
        }
      }
    } catch (e) {
      state.lastError = (e && e.message) || String(e);
      console.warn('[uptime] sweep failed:', state.lastError);
    }
  };

  // Don't compete with boot work (cloud settings pull, report mirror): first
  // sweep lands shortly after startup, then on the interval.
  const first = setTimeout(tick, 20000);
  if (first.unref) first.unref();
  timer = setInterval(tick, intervalMs);
  if (timer.unref) timer.unref();

  console.log(`[uptime] Background monitor ON — full sweep every ${Math.round(intervalMs / 1000)}s`);
  return true;
}

/** Stop the local scheduler (tests / shutdown). */
export function stopLocalScheduler() {
  if (timer) { clearInterval(timer); timer = null; }
  state.enabled = false;
  return true;
}

/**
 * Cloud entry point called by the Worker's scheduled() handler. Marks the mode
 * so the UI can tell whether the cloud cron is alive, then sweeps a bounded
 * slice in priority order.
 */
export async function runCloudSweep(opts = {}) {
  state.mode = 'cloud';
  state.enabled = true;
  if (!state.startedAt) state.startedAt = nowIso();
  if (!state.intervalMs) state.intervalMs = opts.intervalMs || 10 * 60 * 1000;
  return runSweep({ limit: opts.limit || CLOUD_SLICE_SIZE, source: 'cloud' });
}