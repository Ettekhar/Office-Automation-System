/**
 * scratch/verify-tab-meta-cache.mjs
 *
 * Verifies src/tabMetaCache.js — the shared, bounded tab-list cache that fixed
 * the worker's "My Sites" infinite loading:
 *
 *   1. a lookup is bounded (never hangs a page),
 *   2. a failure is REMEMBERED (the next row must not start another lookup —
 *      that per-row retry was the actual bug),
 *   3. concurrent callers share ONE in-flight lookup,
 *   4. the test hooks really reset/measure.
 *
 * The one real network call is a deliberate bogus spreadsheet id, so the Sheets
 * API answers 4xx (or the timeout fires) — either way the result must be null
 * within the documented bound. Everything else is in-memory.
 *
 * Run:  node scratch/verify-tab-meta-cache.mjs
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'officeos-tabmeta-'));
process.env.OFFICEOS_DATA_DIR = dataDir;

const {
  getTabMetaCached, _resetTabMetaCache, _stats,
  TAB_META_TTL_MS, TAB_META_FAIL_TTL_MS, TAB_META_LOOKUP_TIMEOUT_MS,
} = await import('../src/tabMetaCache.js');

let pass = 0;
let fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  \u2705 ${name}`); }
  else { fail++; console.log(`  \u274c ${name}${extra ? ' — ' + extra : ''}`); }
};

const ms = () => Number(process.hrtime.bigint() / 1000000n);

console.log('\ntabMetaCache — shared bounded tab-list cache\n');

// ── 1. documented knobs have not drifted ─────────────────────────────────────
check('success TTL is 10 minutes', TAB_META_TTL_MS === 10 * 60 * 1000);
check('failure TTL is 1 minute', TAB_META_FAIL_TTL_MS === 60 * 1000);
check('lookup timeout is 3 seconds', TAB_META_LOOKUP_TIMEOUT_MS === 3000);
check('the bound is tighter than the old per-row 8s wait', TAB_META_LOOKUP_TIMEOUT_MS < 8000);

// ── 2. an empty id is free (a site with no account config must not stall) ────
_resetTabMetaCache();
let t0 = ms();
const emptyRes = await getTabMetaCached('');
const emptyMs = ms() - t0;
check('empty spreadsheet id resolves null instantly', emptyRes === null && emptyMs < 50, `${emptyMs}ms`);
check('empty id does not count as a lookup', _stats().lookups === 0);

// ── 3. a cold lookup is bounded and never throws ─────────────────────────────
_resetTabMetaCache();
const bogus = '__verify-tab-meta-cache__';
t0 = ms();
const first = await getTabMetaCached(bogus);
const firstMs = ms() - t0;
const boundedOk = first === null || (first && Array.isArray(first.titles) && first.gidByTitle instanceof Map);
check('cold lookup settles with null or a tab list (never throws)', boundedOk, JSON.stringify(first));
check(`cold lookup is bounded by the ${TAB_META_LOOKUP_TIMEOUT_MS}ms timeout`, firstMs <= TAB_META_LOOKUP_TIMEOUT_MS + 700, `took ${firstMs}ms`);
check('the lookup was attempted exactly once', _stats().lookups === 1, `lookups=${_stats().lookups}`);

// ── 4. THE BUG: a failure must be remembered, not retried per row ────────────
// 20 rows all failing used to mean 20 sequential lookups. Now the second and
// every following call must be a memory hit.
t0 = ms();
const calls = [];
for (let i = 0; i < 20; i++) calls.push(await getTabMetaCached(bogus));
const warmMs = ms() - t0;
const allSame = calls.every((r) => (r === null) === (first === null));
check('20 repeat calls agree with the first result', allSame);
check('20 repeat calls add ZERO new lookups', _stats().lookups === 1, `lookups=${_stats().lookups}`);
check('20 repeat calls are effectively free (<50ms total)', warmMs < 50, `${warmMs}ms`);

// ── 5. concurrent callers share one in-flight lookup ─────────────────────────
_resetTabMetaCache();
const inflightId = '__verify-tab-meta-inflight__';
t0 = ms();
const [a, b, c] = await Promise.all([
  getTabMetaCached(inflightId),
  getTabMetaCached(inflightId),
  getTabMetaCached(inflightId),
]);
const inflightMs = ms() - t0;
check('3 concurrent callers started exactly 1 lookup', _stats().lookups === 1, `lookups=${_stats().lookups}`);
check('3 concurrent callers share one bounded wait', inflightMs <= TAB_META_LOOKUP_TIMEOUT_MS + 700, `${inflightMs}ms`);
check('3 concurrent callers got the same answer',
  (a === null || b === null || c === null) ? (a === null && b === null && c === null) : (a === b && b === c));
check('nothing is left in flight afterwards', _stats().inflight === 0);

// ── 6. reset is a real reset ─────────────────────────────────────────────────
_resetTabMetaCache();
check('reset clears the counters', _stats().lookups === 0 && _stats().cached === 0 && _stats().inflight === 0);

try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
