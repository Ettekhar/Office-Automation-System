/**
 * verify-worker-budget.mjs — the Worker's free-plan budget guards.
 *
 * The cron sweep is sized for 50 subrequests/invocation and 1,000 KV writes/day.
 * The two manual "check all" buttons used to ignore both: they posted {} and the
 * Worker tried to probe ~98 sites (≈294 subrequests) and, on the legacy route,
 * write KV once per site. This test pins the guards in place so a future edit
 * cannot quietly reintroduce the blowout.
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

const {
  CLOUD_SLICE_SIZE, MAX_PROBES_PER_SITE, WORKER_SUBREQUEST_CAP,
  resolveSweepScope, selectCandidates,
} = await import('../src/uptimeMonitor.js');

const uptimeSrc = fs.readFileSync(path.join(here, '../src/uptime.js'), 'utf8');
const monitorSrc = fs.readFileSync(path.join(here, '../src/uptimeMonitor.js'), 'utf8');
const serverSrc = fs.readFileSync(path.join(here, '../src/server.js'), 'utf8');

let pass = 0;
let fail = 0;
const t = (name, fn) => {
  try { fn(); pass++; console.log('  \u2713 ' + name); }
  catch (e) { fail++; console.error('  \u2717 ' + name + ' \u2014 ' + e.message); }
};

console.log('\nworker budget guards\n');

t('the worst-case sweep fits the 50-subrequest cap', () => {
  assert.ok(CLOUD_SLICE_SIZE * MAX_PROBES_PER_SITE <= WORKER_SUBREQUEST_CAP,
    `${CLOUD_SLICE_SIZE} x ${MAX_PROBES_PER_SITE} > ${WORKER_SUBREQUEST_CAP}`);
  assert.equal(CLOUD_SLICE_SIZE, 12);
});

t('a probe never follows redirects (one subrequest per probe)', () => {
  assert.ok(/redirect:\s*'manual'/.test(uptimeSrc), 'probe() must set redirect: manual');
  assert.ok(/const answered =/.test(uptimeSrc), 'the opaque-redirect helper must exist');
});

t('worker: "all" becomes one 12-site batch', () => {
  const s = resolveSweepScope({ isWorker: true });
  assert.equal(s.limit, 12);
  assert.equal(s.cap, 12);
  assert.equal(s.capped, true);
  assert.equal(s.siteIds, null);
});

t('worker: an oversized limit is clamped and flagged', () => {
  const s = resolveSweepScope({ isWorker: true, limit: 500 });
  assert.equal(s.limit, 12);
  assert.equal(s.capped, true);
});

t('worker: a small explicit limit is respected', () => {
  const s = resolveSweepScope({ isWorker: true, limit: 5 });
  assert.equal(s.limit, 5);
  assert.equal(s.capped, false);
});

t('worker: an oversized id list is clamped', () => {
  const ids = Array.from({ length: 40 }, (_, i) => 'site-' + i);
  const s = resolveSweepScope({ isWorker: true, siteIds: ids });
  assert.equal(s.siteIds.length, 12);
  assert.equal(s.capped, true);
});

t('worker: a targeted check keeps its ids', () => {
  const s = resolveSweepScope({ isWorker: true, siteIds: ['one'] });
  assert.deepEqual(s.siteIds, ['one']);
  assert.equal(s.limit, 12);
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

t('both manual check-all routes are worker-aware', () => {
  assert.ok(/resolveSweepScope\(\{/.test(serverSrc), 'sweep route must resolve a scope');
  const hits = (serverSrc.match(/__OFFICEOS_WORKER__/g) || []).length;
  assert.ok(hits >= 2, `expected both routes to check the worker flag, found ${hits}`);
  const checkAll = serverSrc.indexOf('Check all (stream progress via SSE)');
  const guard = serverSrc.indexOf("runSweep({ limit: scope.limit, source: 'manual' })");
  assert.ok(guard > 0 && guard < checkAll, 'the worker guard must run before the SSE all-check');
});

t('the cron path still uses the bounded slice', () => {
  assert.ok(/limit:\s*opts\.limit \|\| CLOUD_SLICE_SIZE/.test(monitorSrc));
});

t('daily budget arithmetic leaves headroom', () => {
  const ticksPerDay = 144;                 // */10
  const kvWritesPerSweep = 2;              // sites + meta
  const kvWritesPerDay = ticksPerDay * kvWritesPerSweep;
  assert.ok(kvWritesPerDay <= 1000, `${kvWritesPerDay} KV writes/day exceeds 1,000`);
  assert.ok(CLOUD_SLICE_SIZE * MAX_PROBES_PER_SITE <= WORKER_SUBREQUEST_CAP);
  const worstSubrequests = ticksPerDay * CLOUD_SLICE_SIZE * MAX_PROBES_PER_SITE;
  assert.ok(worstSubrequests < 144 * WORKER_SUBREQUEST_CAP, 'each tick must stay under its own cap');
  console.log(`    ${kvWritesPerDay} KV writes/day, ${worstSubrequests} probe subrequests/day across ${ticksPerDay} ticks`);
});

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
