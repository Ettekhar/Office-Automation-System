/**
 * verify-reconcile-guard.mjs — READ-ONLY.
 *
 * Guards the three fixes:
 *   1. strict month matching   — "sep" must not reach "September 22"
 *   2. empty status is not "not done"
 *   3. the rank guard          — a cell already reading Completed is never
 *                               downgraded to To Do
 *
 * Every assertion is anchored to a real site/month pair taken from the live
 * data, because the bug was found by looking at real data, not a fixture.
 */
import * as db from '../src/db.js';
import {
  findMonthlyHistoryEntry, parseMonthLabel, shouldWriteReconciledStatus,
  maintenanceStatusRank, normalizeMaintenanceStatusText,
} from '../src/maintenanceStatus.js';

const sites = db.getSites({}) || [];
const drRows = db.getDailyReview({}) || [];
const clean = (u) => (u || '').toLowerCase().replace(/^https?:\/\//, '').replace(/\/$/, '');

let pass = 0, fail = 0;
const t = (n, c, e) => { if (c) { pass++; console.log(`  ok   ${n}`); } else { fail++; console.log(`  FAIL ${n}${e !== undefined ? '  ' + JSON.stringify(e) : ''}`); } };

// ── 1. the real site that produced the damage ──
console.log(`\n=== 1. hqdallasrooftop.com — the case that would have destroyed work ===`);
const hq = sites.find((s) => clean(s.url).includes('hqdallasrooftop'));
const hqRow = drRows.find((r) => r.userName === 'Taion' && clean(r.siteUrl).includes('hqdallasrooftop'));
console.log(`  Daily Review cell : "${hqRow.maintenanceRaw}" (rank ${maintenanceStatusRank(hqRow.maintenanceRaw)})`);

const askSep = findMonthlyHistoryEntry(hq.monthlyHistory || [], 'sep');
t('"sep" no longer matches the 2022 entry "September 22"', !askSep || askSep.month !== 'September 22', askSep && askSep.month);
console.log(`  ask "sep"       -> ${askSep ? `"${askSep.month}" status "${askSep.status}"` : 'NO MATCH (row left alone)'}`);
const askSept = findMonthlyHistoryEntry(hq.monthlyHistory || [], 'september');
t('"september" still matches the current entry exactly', askSept && askSept.month === 'September', askSept && askSept.month);
console.log(`  ask "september" -> ${askSept ? `"${askSept.month}" status "${askSept.status}"` : 'NO MATCH'}`);

// ── 2. parseMonthLabel ──
console.log(`\n=== 2. month label parsing ===`);
const P = (s) => { const r = parseMonthLabel(s); return r ? `${r.name}/${r.year || '-'}` : 'null'; };
console.log(`  "September 26"   -> ${P('September 26')}`);
console.log(`  "september"      -> ${P('september')}`);
console.log(`  "sep"            -> ${P('sep')}`);
console.log(`  "2026-09"        -> ${P('2026-09')}`);
console.log(`  "february24"     -> ${P('february24')}`);
console.log(`  "October 2024"   -> ${P('October 2024')}`);
console.log(`  "Augus 23"       -> ${P('Augus 23')}   <- typo, must not match`);
console.log(`  "octobor"        -> ${P('octobor')}      <- typo, must not match`);
console.log(`  "" (empty)       -> ${P('')}`);
t('"September 26" parses to september/2026', P('September 26') === 'september/2026', P('September 26'));
t('"2026-09" parses to september/2026', P('2026-09') === 'september/2026', P('2026-09'));
t('"february24" (no space) parses', P('february24') === 'february/2024', P('february24'));
t('"September" has no year', P('september') === 'september/-', P('september'));
t('a typo label refuses to match anything', P('Augus 23') === 'null' && P('octobor') === 'null', [P('Augus 23'), P('octobor')]);
t('an EMPTY label refuses to match anything (the includes("") landmine)', P('') === 'null', P(''));

// ── 3. the year asymmetry, which is the actual fix ──
console.log(`\n=== 3. year-qualified entries never satisfy a bare query ===`);
const hist = [
  { month: 'September 22', status: '' },
  { month: 'September',    status: 'Updated & Backup' },
];
t('bare "September" does NOT match "September 22"', findMonthlyHistoryEntry(hist, 'September').month === 'September', findMonthlyHistoryEntry(hist, 'September').month);
t('bare "sep" resolves to the bare "September", never to "September 22"', findMonthlyHistoryEntry(hist, 'sep')?.month === 'September', findMonthlyHistoryEntry(hist, 'sep')?.month);
t('"September 26" IS satisfied by a bare "September" (intended behaviour kept)',
  findMonthlyHistoryEntry(hist, 'September 26')?.month === 'September', findMonthlyHistoryEntry(hist, 'September 26')?.month);
t('"September 22" matches its own year exactly', findMonthlyHistoryEntry(hist, 'September 22')?.month === 'September 22');
t('an unrelated month never matches', findMonthlyHistoryEntry(hist, 'March') === null, findMonthlyHistoryEntry(hist, 'March'));
t('a null/empty history is safe', findMonthlyHistoryEntry(null, 'September') === null);
t('a null/empty query is safe', findMonthlyHistoryEntry(hist, '') === null);
t('a history entry with no month label is never matched', findMonthlyHistoryEntry([{ status: 'Completed' }], 'September') === null);

// ── 4. the rank guard ──
console.log(`\n=== 4. rank guard: never downgrade ===`);
const D = (o) => shouldWriteReconciledStatus(o);
const cases = [
  ['Completed stays Completed', { incomingRaw: 'Updated & Backup', currentRaw: 'Updated & Backup' }, false, 'already-equal'],
  ['blank cell accepts Completed', { incomingRaw: 'Updated & Backup', currentRaw: '' }, true],
  ['blank cell accepts To Do', { incomingRaw: 'To Do', currentRaw: '' }, true],
  ['Completed refuses To Do', { incomingRaw: 'To Do', currentRaw: 'Updated & Backup' }, false, 'downgrade-refused'],
  ['Completed refuses blank', { incomingRaw: '', currentRaw: 'Updated & Backup' }, false, 'empty-source-would-downgrade'],
  ['In Progress refuses To Do', { incomingRaw: 'To Do', currentRaw: 'In Progress' }, false, 'downgrade-refused'],
  ['In Progress accepts Completed (upgrade)', { incomingRaw: 'Completed', currentRaw: 'In Progress' }, true],
  ['To Do accepts In Progress (upgrade)', { incomingRaw: 'In Progress', currentRaw: 'To Do' }, true],
  ['unrecognised incoming is refused', { incomingRaw: 'banana', currentRaw: 'To Do' }, false, 'unrecognised-incoming-value'],
  // Casing is NOT the reconcile's job. "completed" and "Completed" are the same
  // state, so this is a no-op rather than a write; canonicalising casing across
  // every tab is the backfill pass's separate responsibility.
  ['a casing-only difference is a no-op, not a write', { incomingRaw: 'Completed', currentRaw: 'completed' }, false, 'already-equal'],
];
for (const [name, input, expectWrite, expectReason] of cases) {
  const r = D(input);
  const okWrite = r.write === expectWrite;
  const okReason = !expectReason || r.reason === expectReason;
  t(name, okWrite && okReason, r);
}
t('the exact damage case is refused', D({ incomingRaw: '', incomingStatus: 'todo', currentRaw: 'Updated & Backup' }).write === false, D({ incomingRaw: '', incomingStatus: 'todo', currentRaw: 'Updated & Backup' }));

// ── 5. re-run the exposure scan that found 42 rows ──
// MEASURE THE GUARD, NOT THE RANK. This scan used to assert
// `rank(month) < rank(cell) === 0` — that no month match is even CAPABLE of
// cutting recorded work. That is not the property that protects data, and it
// drifts the moment somebody is assigned a site whose month columns are blank
// while its cell already records work. That is exactly what happened on
// 2026-09-27 (Saiful quick-assigned, Saiful!21 "To Do", "September 26" blank):
// the row became "exposed" by the rank test while the guard refused to touch
// it, so the suite failed for a row the system protects. The question that
// matters is whether the guard would ALLOW the write. The rank-visible count is
// still printed, as an early warning, but it is no longer the assertion.
console.log(`\n=== 5. exposure scan after the fix ===`);
let stillExposed = 0;   // destructive writes the GUARD would let through -> must be 0
let rankVisible = 0;    // rows a rank comparison would notice -> informational
let blankVisible = 0;   // blank month columns over a filled cell -> informational
let allowedUpgrades = 0;// forward progress the guard must keep allowing
const still = [];
for (const r of drRows) {
  const s = sites.find((x) => { const a = clean(x.url), b = clean(r.siteUrl); return a === b || a.includes(b) || b.includes(a); });
  if (!s) continue;
  for (const m of ['sep', 'oct', '2026-09', 'September', 'september']) {
    const e = findMonthlyHistoryEntry(s.monthlyHistory || [], m);
    if (!e) continue;
    const cur = (r.maintenanceRaw || '').trim();
    if (!cur) continue;
    const inc = (e.status || '').trim();
    if (maintenanceStatusRank(inc) < maintenanceStatusRank(cur)) rankVisible++;
    if (inc === '') blankVisible++;
    // The real question. Mirrors the fixed server.js call site: a blank source
    // must reach the guard as a blank status, never as the overlay's "todo".
    // Passing the fabricated "todo" is the 2026-09-27 bug; this is the shape
    // that would let a rank-1 cell be blanked by a rank-1 non-answer.
    const d = shouldWriteReconciledStatus({
      incomingRaw: inc,
      incomingStatus: inc ? 'todo' : null,
      currentRaw: cur,
    });
    // "Exposure" is a DESTRUCTIVE write getting through - a blank landing on a
    // cell that records work, or a status going backwards. A guard that allows
    // an UPGRADE is working, not leaking: "In Progress" -> "Updated & Backup"
    // is recorded work moving forward and must be written. Counting every
    // allowed write flagged 22 legitimate upgrades as if they were damage.
    const destructive = inc === '' || maintenanceStatusRank(inc) < maintenanceStatusRank(cur);
    if (d.write && destructive) {
      stillExposed++;
      still.push(`  ${r.userName} ${s.url} ask "${m}" matched "${e.month}" ("${e.status}") would cut "${cur}"`);
    }
    if (d.write && !destructive) allowedUpgrades++;
  }
}
if (still.length) still.slice(0, 10).forEach((x) => console.log(x));
console.log(`  rows a rank comparison notices  : ${rankVisible}   (informational only)`);
console.log(`  blank month over a filled cell  : ${blankVisible}   (informational only)`);
console.log(`  legitimate forward progress     : ${allowedUpgrades}   (must be written)`);
console.log(`  DESTRUCTIVE writes allowed      : ${stillExposed}`);
t('no month match can cut recorded work (the guard refuses every one)', stillExposed === 0, stillExposed);

// ── 6. vocabulary unchanged by the move ──
console.log(`\n=== 6. vocabulary intact after moving module ===`);
t('"Updated & Backup" -> "Completed"', normalizeMaintenanceStatusText('Updated & Backup') === 'Completed');
t('"inprogress" -> "In Progress"', normalizeMaintenanceStatusText('inprogress') === 'In Progress');
t('unknown wording returned verbatim', normalizeMaintenanceStatusText('banana') === 'banana');
t('blank ranks 0', maintenanceStatusRank('') === 0);
t('Completed ranks 3', maintenanceStatusRank('Completed') === 3);

console.log(`\n${pass} passed, ${fail} failed`);
console.log('READ-ONLY. Nothing written.');
process.exit(fail ? 1 : 0);
