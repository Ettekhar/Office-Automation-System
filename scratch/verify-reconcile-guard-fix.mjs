/**
 * verify-reconcile-guard-fix.mjs — READ-ONLY. Writes nothing. Regression test.
 *
 * Guards the 2026-09-27 fix in src/server.js. The bug it locks down:
 *
 *   The overlay at server.js:1021-1031 sets maintenanceStatus = normMap[''] = "todo"
 *   for a BLANK month column, so the UI has something to render. The guard call
 *   then passed that fabricated status as incomingStatus. shouldWriteReconciledStatus
 *   refuses empty sources via `if (!inRaw && !incomingStatus)`, so a truthy
 *   "todo" skipped that branch entirely and the rank compare saw
 *       from = rank("To Do") = 1 , to = rank("" || "todo") = 1 , 1 < 1 === false
 *   -> write allowed -> the cell was blanked. Confirmed live on Saiful!21.
 *
 * Two things are verified, and both matter:
 *
 *   A. BEHAVIOUR. Mirror the fixed call site and prove that across every
 *      (row, month) pair in the real data, zero blank month columns are allowed
 *      to overwrite a cell that records work. The pre-fix mirroring of the same
 *      loop found 54 such pairs (all the same cell, Saiful!21).
 *
 *   B. THE DEPLOYED SOURCE. A behaviour test that only exercises a hand-copy of
 *      the call site proves nothing about the file that actually runs. So this
 *      also asserts that src/server.js still contains the fix, and no longer
 *      contains the two defects. If someone reverts server.js, this fails even
 *      though the mirrored logic below is still correct.
 */
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import {
  findMonthlyHistoryEntry, shouldWriteReconciledStatus, maintenanceStatusRank,
} from '../src/maintenanceStatus.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

let pass = 0, fail = 0;
const ok = (cond, label, extra = '') => {
  if (cond) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}${extra ? ` -- ${extra}` : ''}`); }
};

// ─────────────────────────────────────────────────────────────────────────────
// A. BEHAVIOUR
// ─────────────────────────────────────────────────────────────────────────────
const load = (p, keys) => {
  const j = JSON.parse(readFileSync(join(ROOT, 'data', p), 'utf8'));
  if (Array.isArray(j)) return j;
  for (const k of keys) if (Array.isArray(j[k])) return j[k];
  return Object.values(j).find(Array.isArray) || [];
};
const drRows = load('daily-review.json', ['records', 'dailyReview']);
const siteRows = load('sites.json', ['sites', 'records']);

const norm = (u) => String(u || '').toLowerCase().replace(/^https?:\/\//, '').replace(/\/$/, '');
const sitesByDomain = new Map();
for (const s of siteRows) sitesByDomain.set(norm(s.url || s.domain), s);

const months = [];
for (const s of siteRows) {
  for (const e of (s.monthlyHistory || [])) {
    const m = e.month || e.label || e.name;
    if (m && !months.includes(m)) months.push(m);
  }
}

// verbatim from server.js:1021-1026
const normMap = {
  'updated & backup': 'completed', 'completed': 'completed',
  'in progress': 'in_progress', 'to do': 'todo', 'todo': 'todo',
  'pending': 'pending', '': 'todo',
};

// The fixed call site, mirrored.
const decideFixed = (newRaw, rowStatus, curRaw) =>
  shouldWriteReconciledStatus({
    incomingRaw: newRaw,
    incomingStatus: newRaw ? rowStatus : null,   // <-- THE FIX
    currentRaw: curRaw,
  });

console.log('\n=== A. behaviour: fixed call site against real data ===');
console.log(`  ${drRows.length} records, ${siteRows.length} sites, ${months.length} month labels\n`);

let pairs = 0, allowed = 0;
const blankOverWork = [];
const rankDowngrades = [];
for (const r of drRows) {
  if (r.rowIndex == null) continue;
  const site = sitesByDomain.get(norm(r.siteUrl || r.url));
  if (!site) continue;
  for (const month of months) {
    const entry = findMonthlyHistoryEntry(site.monthlyHistory || [], month);
    if (!entry) continue;
    pairs++;
    const rawVal = String(entry.status || '').trim();
    const curRaw = String(r.maintenanceRaw || '').trim();
    if (curRaw.toLowerCase() === rawVal.toLowerCase()) continue;
    const rowStatus = normMap[rawVal.toLowerCase()] || 'todo';
    const d = decideFixed(rawVal, rowStatus, curRaw);
    if (!d.write) continue;
    allowed++;
    if (rawVal === '' && curRaw !== '') blankOverWork.push({ month, row: r.rowIndex, url: norm(r.siteUrl || r.url), lost: curRaw });
    if (maintenanceStatusRank(rawVal) < maintenanceStatusRank(curRaw)) rankDowngrades.push({ month, row: r.rowIndex, lost: curRaw, got: rawVal });
  }
}
console.log(`  (row, month) pairs reaching the writer : ${pairs}`);
console.log(`  guard ALLOWED                          : ${allowed}`);
console.log(`  blank-over-work                        : ${blankOverWork.length}`);
console.log(`  rank downgrades                        : ${rankDowngrades.length}\n`);

ok(blankOverWork.length === 0, 'no blank month column may overwrite a cell that records work',
  blankOverWork.slice(0, 5).map((b) => `${b.row}/${b.month} loses "${b.lost}"`).join('; '));
ok(rankDowngrades.length === 0, 'no rank downgrade may be written',
  rankDowngrades.slice(0, 5).map((b) => `${b.row}/${b.month} "${b.lost}"->"${b.got}"`).join('; '));

// The damaged shape, DERIVED from live data rather than pinned to a coordinate.
//
// This block used to assert a hardcoded fixture: daily-review rowIndex 21,
// userName 'saiful', month 'September 26'. That coordinate is not stable. The
// site (qualityinnparkersburg.com) was later unassigned from Saiful through the
// app, which removed its daily-review record and left the sheet row correctly
// marked 'Unassigned' — so the incident could no longer be found and the suite
// failed for a reason that had nothing to do with the fix. The other 30
// assertions, including the exhaustive count, all still passed.
//
// Same lesson as the E15 fixtures: derive the invariant from the data instead of
// pinning a moment. What is actually claimed is stronger than the original: on
// ANY real (row, month) pair where the month column carries no information and
// the cell records work, the fixed guard refuses. Every such pair is checked
// below, not just one cell.
console.log('\n=== A1b. the damaged shape, derived from live data ===');
const damageShape = [];
for (const r of drRows) {
  if (r.rowIndex == null) continue;
  const site = sitesByDomain.get(norm(r.siteUrl || r.url));
  if (!site) continue;
  for (const month of months) {
    const entry = findMonthlyHistoryEntry(site.monthlyHistory || [], month);
    if (!entry) continue;
    const rawVal = String(entry.status || '').trim();
    const curRaw = String(r.maintenanceRaw || '').trim();
    if (rawVal === '' && curRaw !== '' && curRaw.toLowerCase() !== rawVal.toLowerCase()) {
      damageShape.push({
        rowIndex: r.rowIndex, url: norm(r.siteUrl || r.url),
        user: String(r.userName || r.user || '?'), month, curRaw,
      });
    }
  }
}
console.log(`  real (row, month) pairs where a blank month column would overwrite recorded work: ${damageShape.length}`);
for (const d0 of damageShape.slice(0, 4)) {
  console.log(`    e.g. ${d0.user} row ${d0.rowIndex} (${d0.url}) / "${d0.month}"  cell="${d0.curRaw}"`);
}
if (damageShape.length) {
  // Aggregate over every pair rather than one assertion per pair: the coverage is
  // identical but the signal stays readable, and a failure names every offender.
  const allowedToBlank = [];
  const wrongReason = [];
  for (const d0 of damageShape) {
    const dec = decideFixed('', normMap[''] || 'todo', d0.curRaw);
    if (dec.write) allowedToBlank.push(`${d0.user} row ${d0.rowIndex}/${d0.month} loses "${d0.curRaw}"`);
    else if (dec.reason !== 'empty-source-would-downgrade') wrongReason.push(`${d0.user} row ${d0.rowIndex}/${d0.month} -> "${dec.reason}"`);
  }
  ok(allowedToBlank.length === 0,
    `no blank month column is allowed to overwrite recorded work (${damageShape.length} real pairs)`,
    allowedToBlank.slice(0, 5).join('; '));
  ok(wrongReason.length === 0,
    'every such refusal is for the right reason (empty-source-would-downgrade)',
    wrongReason.slice(0, 5).join('; '));
  // The pinned incident itself, for the record. Kept as a NOTE, not an assertion:
  // the site was later unassigned from Saiful, which is the app behaving
  // correctly and is not something this fix can or should prevent.
  const named = damageShape.find((d0) => /qualityinnparkersburg/i.test(d0.url));
  console.log(named
    ? `  note: the originally damaged cell (${named.user} row ${named.rowIndex}, ${named.url}) still has the no-information shape and is refused.`
    : '  note: the originally damaged site (qualityinnparkersburg.com) no longer has a daily-review');
  console.log('        record for that user — it was unassigned later, so it is not a (row, month)');
  console.log('        pair any more. The shape above is still covered; see A2 for the unit-level lock.');
} else {
  // Loud, not silent. If the shape is absent from live data the suite says so and
  // points at the coverage that still locks the behaviour down.
  console.log('    ^ none present in live data right now: the affected site was later');
  console.log('      unassigned, which removed its daily-review record entirely. That is');
  console.log('      the app working correctly, not a gap in the guard. The behaviour is');
  console.log('      still locked down by A2 below, which drives this exact shape directly.');
}

// Unit-level: the fabrication must not be able to promote a blank, for ANY status
// the overlay might produce.
console.log('\n=== A2. the fabrication can never promote a blank source ===');
const statusesTheOverlayCanMake = ['todo', 'completed', 'in_progress', 'pending'];
for (const s of statusesTheOverlayCanMake) {
  for (const cur of ['To Do', 'In Progress', 'Completed', 'Updated & Backup']) {
    const d = decideFixed('', s, cur);
    ok(d.write === false, `blank source cannot displace "${cur}" (overlay offered "${s}")`,
      `got write=${d.write} reason=${d.reason}`);
  }
}

// And a real value must still be allowed to move work FORWARD. A fix that blocks
// everything is not a fix, it is an outage.
console.log('\n=== A3. genuine forward progress still writes ===');
const forward = [
  ['To Do', 'In Progress'], ['To Do', 'Completed'], ['In Progress', 'Completed'],
  ['Pending', 'In Progress'], ['To Do', 'Updated & Backup'],
];
for (const [cur, next] of forward) {
  const d = decideFixed(next, normMap[next.toLowerCase()], cur);
  ok(d.write === true, `"${cur}" -> "${next}" is allowed through`, `refused: ${d.reason}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// B. THE DEPLOYED SOURCE
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n=== B. deployed src/server.js actually carries the fix ===');
const src = readFileSync(join(ROOT, 'src', 'server.js'), 'utf8');

ok(/incomingStatus:\s*newRaw\s*\?\s*row\.maintenanceStatus\s*:\s*null/.test(src),
  'fix 1: blank source reaches the guard as a blank status (not the fabricated "todo")');

ok(!/return\s+decision\.write\s*\?\s*\{\s*row,\s*decision\s*\}\s*:\s*\{\s*row,\s*decision\s*\}/.test(src),
  'fix 2a: the dead ternary (both arms identical) is gone');

ok(/\.filter\(Boolean\)\s*\r?\n?\s*\.filter\(d\s*=>\s*d\.decision\.write\)\s*\r?\n?\s*\.map\(d\s*=>\s*d\.row\)/.test(src),
  'fix 2b: only guard-approved rows reach the writer');

ok(!/d\.decision\.reason\s*===\s*'downgrade-refused'/.test(src),
  'fix 2c: the restore list no longer matches on a single reason string');

ok(/d\.decision\.reason\s*===?\s*'empty-source-would-downgrade'|!d\.decision\.write\s*\)/.test(src),
  'fix 2d: every refusal is captured for the restore block');

ok(/_monthLabel:\s*month/.test(src),
  'fix 3: the overlay carries the month so a refusal can name it');

ok(/no information in the month column/.test(src),
  'fix 3: the empty-source refusal logs in plain words, not "undefined -> undefined"');

console.log(`\n${'='.repeat(70)}`);
console.log(`  ${pass} passed, ${fail} failed`);
console.log('='.repeat(70));
console.log('\nREAD-ONLY. Nothing written to any sheet or to data/.');
process.exit(fail ? 1 : 0);
