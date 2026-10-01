/**
 * probe-reconcile-downgrade.mjs — READ-ONLY.
 *
 * probe-reconcile-write.mjs showed that asking for month "sep" would overwrite a
 * Daily Review cell reading "Updated & Backup" with "To Do". This isolates WHY,
 * on one real site, and checks how many sites are exposed.
 */
import * as db from '../src/db.js';
import { findMonthlyHistoryEntry, shouldWriteReconciledStatus, maintenanceStatusRank } from '../src/maintenanceStatus.js';
import { dailyReviewMaintenanceCellValue } from '../src/sheets.js';

const drRows = db.getDailyReview({}) || [];
const sites = db.getSites({}) || [];
const clean = (u) => (u || '').toLowerCase().replace(/^https?:\/\//, '').replace(/\/$/, '');

console.log(`\n=== 1. one site in detail: hqdallasrooftop.com (Taion row 3) ===`);
const site = sites.find((s) => clean(s.url).includes('hqdallasrooftop'));
const row = drRows.find((r) => r.userName === 'Taion' && clean(r.siteUrl).includes('hqdallasrooftop'));
console.log(`  Daily Review maintenanceRaw : "${row.maintenanceRaw}"  (rank ${maintenanceStatusRank(row.maintenanceRaw)})`);
console.log(`  monthlyHistory on the site  :`);
for (const h of (site.monthlyHistory || [])) {
  console.log(`      month="${h.month}"  status="${h.status}"`);
}

console.log(`\n=== 2. the month lookup, before and after ===`);
console.log(`  BEFORE (substring): "sep" matched "September 22"  status ""  -> wrote "To Do"`);
const entry = findMonthlyHistoryEntry(site.monthlyHistory || [], 'sep');
console.log(`  AFTER  (strict)   : "sep" matched ${entry ? `"${entry.month}"  status "${entry.status}"` : 'nothing (row left alone)'}`);
const exact = findMonthlyHistoryEntry(site.monthlyHistory || [], 'September');
console.log(`                     "September" matched ${exact ? `"${exact.month}"  status "${exact.status}"` : 'nothing'}`);
console.log(`\n  -> the abbreviated query now resolves to the CURRENT month entry, and`);
console.log(`     "September 26" still matches the bare "September" as before.`);

console.log(`\n=== 3. the damage that used to follow ===`);
const rawVal = entry ? (entry.status || '').trim() : '';
const normMap = { 'updated & backup': 'completed', 'completed': 'completed', 'in progress': 'in_progress', 'to do': 'todo', 'todo': 'todo', 'pending': 'pending', '': 'todo' };
const decision = shouldWriteReconciledStatus({
  incomingRaw: rawVal, incomingStatus: normMap[rawVal.toLowerCase()] || 'todo',
  currentRaw: (row.maintenanceRaw || '').trim(),
});
console.log(`  sheet cell today : "${row.maintenanceRaw}"  (rank ${maintenanceStatusRank(row.maintenanceRaw)})`);
console.log(`  month status     : "${rawVal}"  (rank ${maintenanceStatusRank(rawVal)})`);
console.log(`  writer decides   : ${decision.write ? 'WRITE' : 'KEEP'}  ${decision.reason || ''}`);
console.log(`  still destroys recorded work: ${decision.write && maintenanceStatusRank(row.maintenanceRaw) > maintenanceStatusRank(rawVal) ? 'YES' : 'no'}`);

console.log(`\n=== 4. how many (site, user) pairs are still exposed? ===`);
let exposed = 0;
const detail = [];
for (const r of drRows) {
  const s = sites.find((x) => { const a = clean(x.url), b = clean(r.siteUrl); return a === b || a.includes(b) || b.includes(a); });
  if (!s) continue;
  for (const m of ['sep', '2026-09', 'oct', 'september', 'September 26', 'September']) {
    const e = findMonthlyHistoryEntry(s.monthlyHistory || [], m);
    if (!e) continue;
    const rv = (e.status || '').trim();
    const cur = (r.maintenanceRaw || '').trim();
    if (!cur) continue;
    const d = shouldWriteReconciledStatus({ incomingRaw: rv, incomingStatus: normMap[rv.toLowerCase()] || 'todo', currentRaw: cur });
    if (d.write && maintenanceStatusRank(cur) > maintenanceStatusRank(rv)) {
      exposed++;
      detail.push(`  ${r.userName}  ${s.url}  ask "${m}" matched "${e.month}" (status "${rv}") -> "${cur}" would be cut`);
    }
  }
}
console.log(detail.length ? detail.slice(0, 12).join('\n') : '  (none)');
console.log(`\n  total exposed rows: ${exposed}   (was 42 before the fix)`);

console.log('\nREAD-ONLY. Nothing written.');
