/**
 * probe-reconcile-write.mjs — READ-ONLY.
 *
 * Answers: "[batch-sync] wrote 1 cell in the Taion tab — why, and is it safe?"
 *
 * The batch-sync log line is emitted by the RECONCILE path in server.js, not by
 * the unassign path. Unassigning goes through softRemoveSiteRowFromUserTab(),
 * which writes "Unassigned" into the assignment-marker column and never calls
 * batchUpdateDailyReviewTab(). So this line is a monthly-status correction that
 * happened to run at the same moment.
 *
 * This reproduces the same comparison offline so the exact cell and value are
 * visible, and flags whether the write would BLANK or DOWNGRADE a cell.
 */
import * as db from '../src/db.js';
import { findMonthlyHistoryEntry, shouldWriteReconciledStatus, maintenanceStatusRank } from '../src/maintenanceStatus.js';
import { dailyReviewMaintenanceCellValue } from '../src/sheets.js';

const drRows = db.getDailyReview({}) || [];
const sites = db.getSites({}) || [];

// The month the UI would send. Derive it the way a human would: the current one.
const now = new Date();
const MONTHS = ['january','february','march','april','may','june','july','august','september','october','november','december'];
const currentMonthNames = [
  `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`,
  MONTHS[now.getMonth()],
  MONTHS[now.getMonth()].slice(0, 3),
];

console.log(`\n=== 1. which month does the reconcile use? ===`);
const monthsSeen = new Set();
for (const s of sites) for (const h of (s.monthlyHistory || [])) monthsSeen.add((h.month || '').trim());
console.log(`  today is ${now.toDateString()}`);
console.log(`  candidates the UI would send: ${currentMonthNames.map((m) => `"${m}"`).join(', ')}`);
console.log(`  month values present in monthlyHistory: ${[...monthsSeen].filter(Boolean).sort().slice(-8).map((m) => `"${m}"`).join(', ')}`);

// Uses the SAME matcher and the SAME rank guard the server now uses, so this
// previews production rather than re-deriving the old behaviour.
const normMap = {
  'updated & backup': 'completed', 'completed': 'completed',
  'in progress': 'in_progress', 'to do': 'todo', 'todo': 'todo',
  'pending': 'pending', '': 'todo',
};

for (const month of currentMonthNames) {
  const writes = [], refusals = [];
  for (const row of drRows) {
    if (row.userName !== 'Taion') continue;
    const clean = (u) => (u || '').toLowerCase().replace(/^https?:\/\//, '').replace(/\/$/, '');
    const site = sites.find((s) => {
      const a = clean(s.url), b = clean(row.siteUrl);
      return a === b || a.includes(b) || b.includes(a);
    });
    if (!site) continue;
    const entry = findMonthlyHistoryEntry(site.monthlyHistory || [], month);
    if (!entry) continue;
    const rawVal = (entry.status || '').trim();
    const orig = (row.maintenanceRaw || '').trim();
    if (orig.toLowerCase() === rawVal.toLowerCase()) continue;

    const decision = shouldWriteReconciledStatus({ incomingRaw: rawVal, incomingStatus: normMap[rawVal.toLowerCase()] || 'todo', currentRaw: orig });
    const rec = {
      siteUrl: site.url, rowIndex: row.rowIndex,
      dailyReviewCell: orig, cwmSheetCell: rawVal,
      fromRank: maintenanceStatusRank(orig), toRank: maintenanceStatusRank(rawVal),
      matchedMonth: entry.month,
      cellValueWritten: dailyReviewMaintenanceCellValue({ maintenanceStatus: normMap[rawVal.toLowerCase()] || 'todo', maintenanceRaw: rawVal }),
      reason: decision.reason,
    };
    (decision.write ? writes : refusals).push(rec);
  }

  console.log(`\n=== 2. reconcile for month "${month}" — Taion rows ===`);
  if (!writes.length && !refusals.length) { console.log(`  (nothing to do for this month)`); continue; }
  for (const m of writes) {
    console.log(`  WRITE  ${m.siteUrl}  (row ${m.rowIndex ?? '?'})  matched month "${m.matchedMonth}"`);
    console.log(`     "${m.dailyReviewCell}" -> "${m.cellValueWritten}"   rank ${m.fromRank} -> ${m.toRank}`);
  }
  for (const m of refusals) {
    console.log(`  KEEP   ${m.siteUrl}  (row ${m.rowIndex ?? '?'})  matched month "${m.matchedMonth}"`);
    console.log(`     stays "${m.dailyReviewCell}"   refused: ${m.reason}`);
  }
  console.log(`  -> ${writes.length} cell(s) written, ${refusals.length} downgrade(s) refused.`);
}

console.log(`\n=== 3. the unassign path, for contrast ===`);
console.log(`  unassign -> softRemoveSiteRowFromUserTab() -> writes ASSIGNMENT_MARKER_ON_UNASSIGN`);
console.log(`           into the assignment-marker column, never the Maintenance column,`);
console.log(`           and never via batchUpdateDailyReviewTab(). So it cannot emit`);
console.log(`           "[batch-sync] ... wrote N cell(s)".`);

console.log('\nREAD-ONLY. Nothing written.');
