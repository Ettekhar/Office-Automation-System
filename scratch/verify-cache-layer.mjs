/**
 * scratch/verify-cache-layer.mjs
 *
 * Verifies the data-fetching work: stale-while-revalidate in src/sheetsCache.js +
 * src/sheets.js readThrough(), and read memoisation in src/db.js.
 *
 * No network, no Google, no live data: everything runs against a throwaway
 * OFFICEOS_DATA_DIR, and the Sheets client is never touched because readThrough()
 * takes the fetcher as an argument.
 *
 * Run:  node scratch/verify-cache-layer.mjs
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'officeos-cache-'));
process.env.OFFICEOS_DATA_DIR = dataDir;
// Short fresh window / long stale window so the test can cross the boundary in ms.
process.env.SHEETS_CACHE_TTL_MS = '300';
process.env.SHEETS_SWR_MAX_STALE_MS = '60000';

const cache = await import('../src/sheetsCache.js');
const { readThrough } = await import('../src/sheets.js');
const db = await import('../src/db.js');

let pass = 0;
let fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  \u2705 ${name}`); }
  else { fail++; console.log(`  \u274c ${name} ${extra}`); }
};
const section = (t) => console.log(`\n${t}`);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ════════════════════════════════════════════════════════════════════════════
section('1. Fresh window: a repeat read costs nothing');

let calls = 0;
const key = cache.tabValuesCacheKey('SHEET1', 'Website List', 'A1:ZZ2000');
// Mirrors the real readers: the fetcher itself is what fills the cache.
const fetcher = async () => {
  calls++;
  const value = [{ url: 'https://a.test', n: calls }];
  cache.cacheSet(key, value);
  return value;
};

const first = await readThrough(key, fetcher);
check('a miss fetches for real', calls === 1 && first.length === 1);
const second = await readThrough(key, fetcher);
check('a fresh hit does not call the fetcher', calls === 1, `calls=${calls}`);
check('the fresh hit returns the same data', JSON.stringify(second) === JSON.stringify(first));

// ════════════════════════════════════════════════════════════════════════════
section('2. Stale window: instant answer + background refresh');

await sleep(400); // cross the 300 ms fresh window
const staleAnswer = await readThrough(key, fetcher);
check('a stale read answers immediately instead of waiting', staleAnswer.length === 1);
check('the stale answer is the last known good value', JSON.stringify(staleAnswer) === JSON.stringify(first));
check('a background refresh was queued', calls === 2, `calls=${calls}`);
await sleep(500); // let the queued refresh finish
const afterRefresh = await readThrough(key, fetcher);
check('the background refresh repopulated the cache', JSON.stringify(afterRefresh) !== JSON.stringify(first), JSON.stringify(afterRefresh));

const stats = cache.getCacheStatus().stats;
check('stale serves are counted', stats.staleServes >= 1, JSON.stringify(stats));
check('cache status reports the SWR window', cache.getCacheStatus().maxStaleMs === 60000);

// ════════════════════════════════════════════════════════════════════════════
section('3. Beyond the stale window: fetch again (nothing ancient is served)');

const oldKey = cache.tabValuesCacheKey('SHEET2', 'Old', 'A1:ZZ10');
cache.cacheSet(oldKey, [['ancient']]);
check('a value past the stale window is not served as stale',
  cache.peekStale(oldKey, { maxAgeMs: -1 }) === null);

// ════════════════════════════════════════════════════════════════════════════
section('4. Invalidation is a hard delete (a write must never serve the old value)');

cache.cacheSet(cache.tabValuesCacheKey('SHEET3', 'T', 'A1:ZZ5'), [['v1']]);
const k3 = cache.tabValuesCacheKey('SHEET3', 'T', 'A1:ZZ5');
check('value is cached', cache.cacheGet(k3) !== undefined);
cache.invalidateCacheForSpreadsheet('SHEET3');
check('spreadsheet invalidation removes it outright', cache.cacheGet(k3) === undefined && cache.peekStale(k3) === null);
cache.cacheSet(k3, [['v2']]);
cache.invalidateCache();
check('full invalidation removes everything', cache.cacheGet(k3) === undefined);

// ════════════════════════════════════════════════════════════════════════════
section('5. Persistence: a restart starts warm, not cold');

const kp = cache.tabValuesCacheKey('SHEET9', 'Warm', 'A1:ZZ3');
cache.cacheSet(kp, [['persisted-row']]);
cache.flushCache();
const persistedFile = path.join(dataDir, 'sheets-cache.json');
check('the cache was written to disk', fs.existsSync(persistedFile));
const parsed = JSON.parse(fs.readFileSync(persistedFile, 'utf8'));
check('the disk copy holds the entry', !!parsed.entries[kp], Object.keys(parsed.entries).join(','));

// A SECOND process is the only honest way to test "restart": it imports the
// module fresh against the same data dir and must see the value immediately.
const probe = `
import fs from 'fs';
process.env.OFFICEOS_DATA_DIR = ${JSON.stringify(dataDir)};
process.env.SHEETS_CACHE_TTL_MS = '300';
process.env.SHEETS_SWR_MAX_STALE_MS = '60000';
const c = await import(${JSON.stringify(new URL('../src/sheetsCache.js', import.meta.url).href)});
const stale = c.peekStale(${JSON.stringify(kp)});
const v = stale && stale.value;
console.log(JSON.stringify({ hit: !!v, value: v && v[0] && v[0][0], loaded: c.getCacheStats().loadedFromDisk }));
`;
const probeOut = execFileSync(process.execPath, ['--input-type=module', '-e', probe], { encoding: 'utf8' }).trim();
const probeRes = JSON.parse(probeOut.split('\n').pop());
check('a fresh process serves the value from disk (stale, self-refreshing)', probeRes.hit === true, probeOut);
check('and reports it as a warm start', probeRes.loaded >= 1, probeOut);

// ════════════════════════════════════════════════════════════════════════════
section('6. Database read memoisation (db.js)');

db.dbWrite('memo-probe', [{ id: 1, v: 'written' }]);
const r1 = db.dbRead('memo-probe');
const r2 = db.dbRead('memo-probe');
check('repeat reads are served from memory', r1 === r2);
check('the memo is reported as enabled', db.getDbMemoStatus().enabled === true);

db.dbWrite('memo-probe', [{ id: 1, v: 'rewritten' }]);
const r3 = db.dbRead('memo-probe');
check('a write invalidates the memo immediately', r3[0].v === 'rewritten', JSON.stringify(r3));
check('and the new read is a different object', r3 !== r1);

db.dbInvalidate('memo-probe');
check('explicit invalidation works', db.dbRead('memo-probe')[0].v === 'rewritten');

// ════════════════════════════════════════════════════════════════════════════
console.log(`\n${fail === 0 ? '\u2705 ALL PASSED' : '\u274c FAILURES'} — ${pass} passed, ${fail} failed`);
console.log(`(throwaway data dir: ${dataDir})`);
process.exit(fail === 0 ? 0 : 1);