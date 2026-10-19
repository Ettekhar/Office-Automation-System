/**
 * scratch/verify-uptime-monitor.mjs
 *
 * Verifies the proactive uptime monitor (src/uptimeMonitor.js) WITHOUT touching
 * live data or the network beyond a throwaway local HTTP server:
 *
 *   1. hysteresis state machine (applyResult)
 *   2. sweep priority + exclusions (selectCandidates)
 *   3. a real end-to-end sweep against a local server, including the
 *      "one state write per sweep" promise and the transition log
 *
 * Run:  node scratch/verify-uptime-monitor.mjs
 * Exit: 0 when every assertion passes, 1 otherwise.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';

// ── Isolate all state into a throwaway dir BEFORE importing the modules ──────
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'officeos-uptime-'));
process.env.OFFICEOS_DATA_DIR = dataDir;
process.env.UPTIME_MONITOR_ENABLED = 'false'; // never arm the interval scheduler in tests
process.env.UPTIME_PROBE_TIMEOUT_MS = '400';  // keep the probe ladder fast in tests

// Count state writes so we can prove a sweep writes the site list exactly once.
let siteWrites = 0;
let metaWrites = 0;
const origWrite = fs.writeFileSync;
fs.writeFileSync = (p, data, ...rest) => {
  const s = String(p);
  if (s.endsWith('sites.json')) siteWrites++;
  if (s.endsWith('meta.json')) metaWrites++;
  return origWrite.call(fs, p, data, ...rest);
};

const db = await import('../src/db.js');
const mon = await import('../src/uptimeMonitor.js');

let pass = 0;
let fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  \u2705 ${name}`); }
  else { fail++; console.log(`  \u274c ${name} ${extra}`); }
};
const section = (t) => console.log(`\n${t}`);

// ════════════════════════════════════════════════════════════════════════════
section('1. Consecutive-failure hysteresis (applyResult)');

const base = { id: 's1', url: 'https://example.com', uptimeStatus: 'unknown' };
const down = { status: 'offline', error: 'Timeout', checkedAt: '2026-10-19T10:00:00.000Z' };
const up = { status: 'online', statusCode: 200, responseTime: 120, checkedAt: '2026-10-19T10:00:00.000Z' };

let r1 = mon.applyResult(base, down);
check('unknown + 1 failure stays unknown (no premature alarm)', r1.site.uptimeStatus === 'unknown', `got ${r1.site.uptimeStatus}`);
check('unknown + 1 failure records the pending fail count', r1.site.uptimeFails === 1 && !r1.transition);

let r2 = mon.applyResult(r1.site, { ...down, checkedAt: '2026-10-19T10:03:00.000Z' });
check('unknown + 2 failures in a row => offline', r2.site.uptimeStatus === 'offline', `got ${r2.site.uptimeStatus}`);
check('going offline emits a down transition', r2.transition && r2.transition.type === 'down');
check('downSince is stamped', r2.site.uptimeDownSince === '2026-10-19T10:03:00.000Z');

let r3 = mon.applyResult(r2.site, { ...up, checkedAt: '2026-10-19T10:06:00.000Z' });
check('offline + 1 pass stays offline (hysteresis on the way back)', r3.site.uptimeStatus === 'offline', `got ${r3.site.uptimeStatus}`);
check('offline + 1 pass emits no transition', !r3.transition);

let r4 = mon.applyResult(r3.site, { ...up, checkedAt: '2026-10-19T10:09:00.000Z' });
check('offline + 2 passes => online', r4.site.uptimeStatus === 'online', `got ${r4.site.uptimeStatus}`);
check('recovery emits an up transition carrying the outage duration',
  r4.transition && r4.transition.type === 'up' && r4.transition.downMs === 6 * 60 * 1000,
  `got ${JSON.stringify(r4.transition)}`);
check('recovery clears downSince', r4.site.uptimeDownSince === null);

let r5 = mon.applyResult({ ...base, uptimeStatus: 'online' }, down);
check('online + 1 failure does not flap to offline', r5.site.uptimeStatus === 'online');
check('a later success resets the fail streak',
  mon.applyResult(r5.site, up).site.uptimeFails === 0);

let r6 = mon.applyResult(base, up);
check('first ever success goes straight to online (no ceremony)', r6.site.uptimeStatus === 'online' && !r6.transition);

// ════════════════════════════════════════════════════════════════════════════
section('2. Sweep priority + exclusions (selectCandidates)');

const fleet = [
  { id: 'a', url: 'https://a.test', uptimeStatus: 'online', lastUptimeCheck: '2026-10-19T12:00:00.000Z' },
  { id: 'b', url: 'https://b.test', uptimeStatus: 'offline', lastUptimeCheck: '2026-10-19T12:00:00.000Z' },
  { id: 'c', url: 'https://c.test', uptimeStatus: 'unknown', lastUptimeCheck: null },
  { id: 'd', url: 'https://d.test', uptimeStatus: 'online', lastUptimeCheck: '2026-10-19T09:00:00.000Z' },
  { id: 'e', url: 'https://e.test', status: 'Deactive', uptimeStatus: 'online' },
  { id: 'f', url: '   ', uptimeStatus: 'unknown' },
];
const ordered = mon.selectCandidates(fleet).map(s => s.id);
check('down sites are checked first', ordered[0] === 'b', ordered.join(','));
check('never-checked sites come next', ordered[1] === 'c', ordered.join(','));
check('then the stalest online site', ordered[2] === 'd', ordered.join(','));
check('Deactive sites are never monitored', !ordered.includes('e'));
check('sites without a URL are never monitored', !ordered.includes('f'));
check('a limit takes the top of the priority list', mon.selectCandidates(fleet, { limit: 2 }).map(s => s.id).join(',') === 'b,c');
check('an explicit siteIds filter wins', mon.selectCandidates(fleet, { siteIds: ['d'] }).map(s => s.id).join(',') === 'd');

// ════════════════════════════════════════════════════════════════════════════
section('3. End-to-end sweep against a throwaway local server');

let badMode = 500; // flip this to make the /bad path healthy
const server = http.createServer((req, res) => {
  if (req.url === '/ok') { res.writeHead(200); res.end('ok'); return; }
  res.writeHead(badMode); res.end('nope');
});
await new Promise(res => server.listen(0, '127.0.0.1', res));
const port = server.address().port;
const okUrl = `http://127.0.0.1:${port}/ok`;
const badUrl = `http://127.0.0.1:${port}/bad`;

db.setSites([
  { id: 'ok', url: okUrl, status: 'Active', account: 'CW' },
  { id: 'bad', url: badUrl, status: 'Active', account: 'RM' },
  { id: 'off', url: `http://127.0.0.1:59999/dead`, status: 'Active', account: 'CW' },
  { id: 'deact', url: badUrl, status: 'Deactive', account: 'CW' },
  { id: 'nourl', url: '', status: 'Active', account: 'CW' },
]);
db.setMeta({});

const before = siteWrites;
const s1 = await mon.runSweep({ source: 'test' });
check('sweep reports what it checked', s1.checked === 3, `checked ${s1.checked}`);
check('a whole sweep writes the site list exactly once', siteWrites - before === 1, `writes ${siteWrites - before}`);

const byId = () => new Map(db.getSites().map(s => [s.id, s]));
let sites = byId();
check('reachable site is online after one sweep', sites.get('ok').uptimeStatus === 'online');
check('unreachable site is NOT reported down after one sweep', sites.get('bad').uptimeStatus === 'unknown', sites.get('bad').uptimeStatus);
check('response time is recorded', typeof sites.get('ok').uptimeResponseTime === 'number');
check('lastUptimeCheck is stamped', !!sites.get('ok').lastUptimeCheck);
check('Deactive site is untouched', !sites.get('deact').lastUptimeCheck && !sites.get('deact').uptimeStatus);
check('URL-less site is untouched', !sites.get('nourl').lastUptimeCheck);

const s2 = await mon.runSweep({ source: 'test' });
sites = byId();
check('second consecutive failure flips the site down', sites.get('bad').uptimeStatus === 'offline', sites.get('bad').uptimeStatus);
check('the sweep reports the down transition', s2.transitions.some(t => t.type === 'down' && t.siteId === 'bad'));
check('the transition is persisted for the UI alert feed',
  (db.getMeta().uptimeAlerts || []).some(a => a.type === 'down' && a.siteId === 'bad'));
check('downSince is stamped on the record', !!sites.get('bad').uptimeDownSince);

const snapDown = mon.getSnapshot();
check('snapshot counts both outages (bad + refused port)', snapDown.summary.downCount === 2, JSON.stringify(snapDown.summary));
check('snapshot lists the down site for the banner', snapDown.down.some(d => d.id === 'bad'));
check('snapshot covers only monitorable sites', snapDown.summary.total === 3, String(snapDown.summary.total));
check('snapshot is a pure read (no extra site write)', siteWrites - before === 2, `writes ${siteWrites - before}`);
check('snapshot exposes the monitor state', snapDown.monitor && snapDown.monitor.enabled === false);

badMode = 200; // /bad starts answering again — the recovery half of the cycle
const s3 = await mon.runSweep({ source: 'test' });
sites = byId();
check('a single good result does not clear the outage yet', sites.get('bad').uptimeStatus === 'offline', sites.get('bad').uptimeStatus);
check('the good result is counted as a recovery pass', (sites.get('bad').uptimePasses || 0) >= 1, String(sites.get('bad').uptimePasses));

const s4 = await mon.runSweep({ source: 'test' });
sites = byId();
check('second good result recovers the site', sites.get('bad').uptimeStatus === 'online', sites.get('bad').uptimeStatus);
check('recovery transition is logged', s4.transitions.some(t => t.type === 'up' && t.siteId === 'bad'));
check('snapshot drops the recovered site from the down list', !mon.getSnapshot().down.some(d => d.id === 'bad'));
check('snapshot still reports the genuinely dead port', mon.getSnapshot().summary.downCount === 1, JSON.stringify(mon.getSnapshot().summary));
check('sweep metadata advances every run', db.getMeta().uptimeMeta.sweepCount >= 4, JSON.stringify(db.getMeta().uptimeMeta));

// A targeted sweep must only touch the sites it was asked about.
const s5 = await mon.runSweep({ source: 'test', siteIds: ['ok'] });
check('targeted sweep checks only the requested site', s5.checked === 1, `checked ${s5.checked}`);

// ════════════════════════════════════════════════════════════════════════════
section('4. Spreadsheet URL cells are sanitised before checking (sanitizeUrl)');

const { sanitizeUrl } = await import('../src/uptime.js');
check('strips a "Note:" prefix that used to fake an outage',
  sanitizeUrl('Note:https://morrisonhouse.com/') === 'https://morrisonhouse.com/',
  sanitizeUrl('Note:https://morrisonhouse.com/'));
check('pulls the URL out of trailing prose',
  sanitizeUrl('https://example.com (main site)') === 'https://example.com');
check('trims a trailing comma/period from a pasted link',
  sanitizeUrl(' https://example.com/page, ') === 'https://example.com/page');
check('leaves a bare domain alone', sanitizeUrl('example.com') === 'example.com');
check('an empty cell stays empty', sanitizeUrl('   ') === '');

// ════════════════════════════════════════════════════════════════════════════
section('5. The probe ladder (HEAD -> ranged GET -> site root)');

// A deliberately awkward host: a guarded path that never answers, a path that
// rejects HEAD, and a root that is perfectly healthy.
const awkward = http.createServer((req, res) => {
  if (req.url === '/') { res.writeHead(200); res.end('root ok'); return; }
  if (req.url === '/no-head') {
    if (req.method === 'HEAD') { res.writeHead(405); res.end(); return; }
    res.writeHead(200); res.end('get ok'); return;
  }
  if (req.url === '/guarded') return; // never responds, like a bot-guarded admin path
  res.writeHead(404); res.end('nope');
});
await new Promise(res => awkward.listen(0, '127.0.0.1', res));
const awkwardBase = `http://127.0.0.1:${awkward.address().port}`;

const { checkSite } = await import('../src/uptime.js');

const viaGet = await checkSite(`${awkwardBase}/no-head`);
check('a HEAD-hostile path is still reported online (ranged GET)', viaGet.status === 'online', JSON.stringify(viaGet));

const guarded = await checkSite(`${awkwardBase}/guarded`);
check('a guarded path falls back to the site root and stays online', guarded.status === 'online', JSON.stringify(guarded));
check('and it carries a note saying which path failed', !!guarded.note && guarded.note.includes('/guarded'), JSON.stringify(guarded));

// Black hole: every path hangs, so all three rungs fail and it is genuinely down.
const blackhole = http.createServer(() => { /* never responds */ });
await new Promise(res => blackhole.listen(0, '127.0.0.1', res));
const dead = await checkSite(`http://127.0.0.1:${blackhole.address().port}/anything`);
check('a host that answers nothing is reported down', dead.status === 'offline', JSON.stringify(dead));
check('and the failure says it timed out', dead.error === 'Timeout', JSON.stringify(dead));

await new Promise(res => awkward.close(res));
await new Promise(res => blackhole.close(res));

await new Promise(res => server.close(res));
// Let undici's dead-port socket finish closing before we exit, otherwise Node
// trips a libuv assertion during teardown on Windows.
await new Promise(r => setTimeout(r, 300));
console.log(`\n${fail === 0 ? '\u2705 ALL PASSED' : '\u274c FAILURES'} — ${pass} passed, ${fail} failed`);
console.log(`(throwaway data dir: ${dataDir})`);
process.exit(fail === 0 ? 0 : 1);