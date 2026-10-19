/**
 * verify-worker-budget.mjs — the Worker's free-plan budget guards.
 *
 * The cron sweep is sized for 50 subrequests/invocation and 1,000 KV writes/day.
 * The two manual "check all" buttons used to ignore both: they posted {} and the
 * Worker tried to probe ~98 sites (≈294 subrequests) and, on the legacy route,
 * write KV once per site. This test pins the guards in place so a future edit
 * cannot quietly reintroduce the blowout.
 *
 * 2026-10-19: the first version of these guards counted only the probes and
 * forgot the KV operations share the same 50-subrequest budget. Cold cron ticks
 * spent 24 reads warming all STATE_KEYS, then ran out mid-slice; the resulting
 * "Too many subrequests" error was recorded as a SITE FAILURE and pushed three
 * healthy sites to DOWN. Two fixes are pinned here:
 *   1. the cron warms only the two keys it reads (2 reads, not 24);
 *   2. platform errors are classified `infra` and dropped by the sweep, never
 *      applied to a site's hysteresis.
 *
 * Run: node scratch/verify-worker-budget.mjs
 */
import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
process.env.OFFICEOS_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'officeos-budget-'));
process.env.DB_MEMO = 'false';
process.env.UPTIME_MASS_FAILURE_GUARD = 'true';

const {
  CLOUD_SLICE_SIZE, MAX_PROBES_PER_SITE, WORKER_SUBREQUEST_CAP,
  WORKER_MANUAL_BATCH, WORKER_FULL_WARM_READS, CLOUD_WARM_READS, SWEEP_KV_WRITES,
  resolveSweepScope, selectCandidates, runSweep,
} = await import('../src/uptimeMonitor.js');
const { isInfraError, checkSite } = await import('../src/uptime.js');
const db = await import('../src/db.js');

const uptimeSrc = fs.readFileSync(path.join(here, '../src/uptime.js'), 'utf8');
const monitorSrc = fs.readFileSync(path.join(here, '../src/uptimeMonitor.js'), 'utf8');
const serverSrc = fs.readFileSync(path.join(here, '../src/server.js'), 'utf8');
const workerSrc = fs.readFileSync(path.join(here, '../cloudflare-worker/dashboard-worker.js'), 'utf8');

let pass = 0;
let fail = 0;
const t = (name, fn) => {
  try { fn(); pass++; console.log('  \u2713 ' + name); }
  catch (e) { fail++; console.error('  \u2717 ' + name + ' \u2014 ' + e.message); }
};
const ta = async (name, fn) => {
  try { await fn(); pass++; console.log('  \u2713 ' + name); }
  catch (e) { fail++; console.error('  \u2717 ' + name + ' \u2014 ' + e.message); }
};

const INFRA_MSG = 'Too many subrequests by single Worker invocation. To configure this limit, refer to https://developers.cloudflare.com/workers/wrangler/configuration/#limits';
const withFetch = async (impl, fn) => {
  const real = globalThis.fetch;
  globalThis.fetch = impl;
  try { return await fn(); } finally { globalThis.fetch = real; }
};

console.log('\nworker budget guards\n');

t('constants describe the real free-plan budget', () => {
  assert.equal(WORKER_SUBREQUEST_CAP, 50);
  assert.equal(MAX_PROBES_PER_SITE, 3);
  assert.equal(CLOUD_SLICE_SIZE, 12);
  assert.equal(WORKER_MANUAL_BATCH, 6);
  assert.equal(WORKER_FULL_WARM_READS, 24);
  assert.equal(CLOUD_WARM_READS, 2);
  assert.equal(SWEEP_KV_WRITES, 2);
});

t('cron worst case fits 50 subrequests (warm + probes + writes)', () => {
  const worst = CLOUD_WARM_READS + CLOUD_SLICE_SIZE * MAX_PROBES_PER_SITE + SWEEP_KV_WRITES;
  assert.ok(worst <= WORKER_SUBREQUEST_CAP, `${worst} > ${WORKER_SUBREQUEST_CAP}`);
  assert.equal(worst, 40);
});

t('manual worst case fits 50 subrequests (24-key warm + probes + writes)', () => {
  const worst = WORKER_FULL_WARM_READS + WORKER_MANUAL_BATCH * MAX_PROBES_PER_SITE + SWEEP_KV_WRITES;
  assert.ok(worst <= WORKER_SUBREQUEST_CAP, `${worst} > ${WORKER_SUBREQUEST_CAP}`);
  assert.equal(worst, 44);
});

t('manual batch keeps at least 4 subrequests of margin for future writes', () => {
  const spare = WORKER_SUBREQUEST_CAP
    - (WORKER_FULL_WARM_READS + WORKER_MANUAL_BATCH * MAX_PROBES_PER_SITE + SWEEP_KV_WRITES);
  assert.ok(spare >= 4, `only ${spare} subrequests spare`);
});

t('a probe never follows redirects (one subrequest per probe)', () => {
  assert.ok(/redirect:\s*'manual'/.test(uptimeSrc), 'probe() must set redirect: manual');
  assert.ok(/const answered =/.test(uptimeSrc), 'the opaque-redirect helper must exist');
});

t('cron: "all" becomes one 12-site batch', () => {
  const s = resolveSweepScope({ isWorker: true, maxSites: CLOUD_SLICE_SIZE });
  assert.equal(s.limit, 12);
  assert.equal(s.cap, 12);
  assert.equal(s.capped, true);
  assert.equal(s.siteIds, null);
});

t('manual: "all" becomes one 6-site batch', () => {
  const s = resolveSweepScope({ isWorker: true, maxSites: WORKER_MANUAL_BATCH });
  assert.equal(s.limit, 6);
  assert.equal(s.cap, 6);
  assert.equal(s.capped, true);
});

t('worker: an oversized limit is clamped and flagged', () => {
  const s = resolveSweepScope({ isWorker: true, limit: 500, maxSites: WORKER_MANUAL_BATCH });
  assert.equal(s.limit, 6);
  assert.equal(s.capped, true);
});

t('worker: a small explicit limit is respected', () => {
  const s = resolveSweepScope({ isWorker: true, limit: 5, maxSites: WORKER_MANUAL_BATCH });
  assert.equal(s.limit, 5);
  assert.equal(s.capped, false);
});

t('worker: an oversized id list is clamped', () => {
  const ids = Array.from({ length: 40 }, (_, i) => 'site-' + i);
  const s = resolveSweepScope({ isWorker: true, siteIds: ids, maxSites: WORKER_MANUAL_BATCH });
  assert.equal(s.siteIds.length, 6);
  assert.equal(s.capped, true);
});

t('worker: a targeted check keeps its ids', () => {
  const s = resolveSweepScope({ isWorker: true, siteIds: ['one'], maxSites: WORKER_MANUAL_BATCH });
  assert.deepEqual(s.siteIds, ['one']);
  assert.equal(s.limit, 6);
});

t('local sweeps stay unbounded unless asked', () => {
  const all = resolveSweepScope({});
  assert.equal(all.limit, 0);
  assert.equal(all.capped, false);
  assert.equal(all.cap, 0);
  assert.equal(resolveSweepScope({ limit: 50 }).limit, 50);
  assert.deepEqual(resolveSweepScope({ siteIds: ['a', 'b'] }).siteIds, ['a', 'b']);
});

t('selectCandidates honours the cloud slice on a 40-site fleet', () => {
  const sites = Array.from({ length: 40 }, (_, i) => ({
    id: 's' + i,
    url: 'https://example.com/' + i,
    status: 'active',
    uptimeStatus: i === 7 ? 'offline' : 'online',
    lastUptimeCheck: new Date(Date.now() - i * 60_000).toISOString(),
  }));
  const picked = selectCandidates(sites, { limit: CLOUD_SLICE_SIZE });
  assert.equal(picked.length, 12);
  assert.equal(picked[0].id, 's7', 'down sites come first');
});

t('both manual check-all routes use the smaller manual batch', () => {
  const hits = serverSrc.match(/maxSites:\s*WORKER_MANUAL_BATCH/g) || [];
  assert.equal(hits.length, 2, `expected both routes to pass maxSites, found ${hits.length}`);
  const workerFlags = (serverSrc.match(/__OFFICEOS_WORKER__/g) || []).length;
  assert.ok(workerFlags >= 2, `expected both routes to check the worker flag, found ${workerFlags}`);
  const checkAll = serverSrc.indexOf('Check all (stream progress via SSE)');
  const guard = serverSrc.indexOf("runSweep({ limit: scope.limit, source: 'manual' })");
  assert.ok(guard > 0 && guard < checkAll, 'the worker guard must run before the SSE all-check');
});

t('the cron path still uses the bounded slice', () => {
  assert.ok(/limit:\s*opts\.limit \|\| CLOUD_SLICE_SIZE/.test(monitorSrc));
});

t('the cron handler warms only sites + meta, never the whole state', () => {
  const at = workerSrc.indexOf('async scheduled(');
  assert.ok(at > 0, 'scheduled() not found');
  const body = workerSrc.slice(at, workerSrc.indexOf('\n};', at));
  assert.ok(/kvShim\.warm\(env\.DASHBOARD_KV, \['sites', 'meta'\]\)/.test(body),
    "scheduled() must warm exactly ['sites', 'meta']");
  assert.ok(!/await ensureWarm\(/.test(body),
    'scheduled() must not warm all 24 STATE_KEYS — those reads share the probe budget');
});

t('infra errors are recognised, real site errors are not', () => {
  assert.equal(isInfraError(INFRA_MSG), true);
  assert.equal(isInfraError('Worker exceeded CPU time limit.'), true);
  assert.equal(isInfraError('Network connection lost.'), true);
  assert.equal(isInfraError('Error 1102: worker exceeded resource limits'), true);
  assert.equal(isInfraError('fetch failed'), false, '"fetch failed" is evidence about the site');
  assert.equal(isInfraError('getaddrinfo ENOTFOUND example.com'), false);
  assert.equal(isInfraError('Timeout'), false, 'a timeout is a real availability signal');
  assert.equal(isInfraError(''), false);
});

await ta('checkSite: a platform error becomes unknown/infra, not offline', async () => {
  let calls = 0;
  const out = await withFetch(async () => { calls++; throw new Error(INFRA_MSG); },
    () => checkSite('https://example.com/some/page'));
  assert.equal(out.status, 'unknown');
  assert.equal(out.infra, true);
  assert.equal(calls, 1, 'the ladder must stop at the first infra failure');
  assert.ok(/Too many subrequests/.test(out.error));
});

await ta('checkSite: a DNS failure stays offline (and climbs the ladder)', async () => {
  let calls = 0;
  const out = await withFetch(async () => { calls++; throw new Error('getaddrinfo ENOTFOUND example.com'); },
    () => checkSite('https://example.com/some/page'));
  assert.equal(out.status, 'offline');
  assert.ok(!out.infra);
  assert.equal(calls, 3, 'HEAD -> ranged GET -> site root');
});

await ta('checkSite: 200 is online', async () => {
  const out = await withFetch(async () => ({ status: 200, body: { cancel: async () => {} } }),
    () => checkSite('https://example.com/'));
  assert.equal(out.status, 'online');
  assert.equal(out.statusCode, 200);
});

await ta('runSweep: infra failures never reach a site (online stays online, twice)', async () => {
  db.setSites([{ id: 'infra-1', url: 'https://example.com/', status: 'active', uptimeStatus: 'online', uptimeFails: 0 }]);
  const meta0 = db.getMeta() || {};
  const alerts0 = (meta0.uptimeAlerts || []).length;

  await withFetch(async () => { throw new Error(INFRA_MSG); }, async () => {
    for (let i = 0; i < 2; i++) {
      const r = await runSweep({ source: 'manual' });
      assert.equal(r.checked, 0, 'nothing may be applied');
      assert.equal(r.skippedInfra, 1);
      assert.equal(r.transitions.length, 0, 'no transition may fire');
    }
  });

  const site = db.getSites().find(s => s.id === 'infra-1');
  assert.equal(site.uptimeStatus, 'online', 'two infra sweeps must not mark it down');
  assert.equal(site.uptimeFails || 0, 0, 'the fail counter must not move');
  assert.equal((db.getMeta().uptimeAlerts || []).length, alerts0, 'no alert may be written');
  assert.equal(db.getMeta().uptimeMeta.lastSweepSkippedInfra, 1);
});

await ta('runSweep: a real answer still applies after infra skips', async () => {
  await withFetch(async () => ({ status: 200, body: { cancel: async () => {} } }), async () => {
    const r = await runSweep({ source: 'manual' });
    assert.equal(r.checked, 1);
    assert.equal(r.online, 1);
    assert.equal(r.skippedInfra, 0);
  });
  assert.equal(db.getSites().find(s => s.id === 'infra-1').uptimeStatus, 'online');
});

await ta('runSweep: an all-infra batch is not a mass failure', async () => {
  const sites = Array.from({ length: 20 }, (_, i) => ({
    id: 'm' + i, url: 'https://example.com/' + i, status: 'active', uptimeStatus: 'online',
  }));
  db.setSites(sites);
  const r = await withFetch(async () => { throw new Error(INFRA_MSG); },
    () => runSweep({ source: 'cloud', limit: 12 }));
  assert.equal(r.skipped, undefined, 'must not be discarded as a local-network event');
  assert.equal(r.checked, 0);
  assert.equal(r.skippedInfra, 12);
  assert.ok(db.getSites().every(s => s.uptimeStatus === 'online'), 'every site keeps its status');
});

t('daily budget arithmetic leaves headroom', () => {
  const ticksPerDay = 144;                 // */10
  const kvWritesPerDay = ticksPerDay * SWEEP_KV_WRITES;
  assert.ok(kvWritesPerDay <= 1000, `${kvWritesPerDay} KV writes/day exceeds 1,000`);
  const worstSubrequests = ticksPerDay * (CLOUD_WARM_READS + CLOUD_SLICE_SIZE * MAX_PROBES_PER_SITE + SWEEP_KV_WRITES);
  assert.ok(worstSubrequests <= ticksPerDay * WORKER_SUBREQUEST_CAP, 'each tick must stay under its own cap');
  console.log(`    ${kvWritesPerDay} KV writes/day, ${worstSubrequests} subrequests/day across ${ticksPerDay} ticks`);
});

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
