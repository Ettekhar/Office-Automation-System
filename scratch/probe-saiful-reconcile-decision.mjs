/**
 * probe-saiful-reconcile-decision.mjs — READ-ONLY. Writes nothing.
 *
 * Replicates the reconcile decision for every Saiful row so the single cell the
 * log said it wrote can be identified, and judged.
 *
 * The reconcile (server.js ~1000-1110) does:
 *   site.monthlyHistory -> findMonthlyHistoryEntry(month)  [strict matcher]
 *   curRaw = the DB's maintenanceRaw      (what the cell is believed to say)
 *   newRaw = the month entry's status     (what the CW/RM sheet says)
 *   mismatch if they differ case-insensitively
 *   then shouldWriteReconciledStatus() applies the rank guard
 *
 * Three things are checked here, because each has been a real bug before:
 *   1. WHICH row mismatched, and to what.
 *   2. Was the write a DOWNGRADE? The rank guard is supposed to make that
 *      impossible (empty month status ranks 0 and can never displace real work).
 *   3. Did it write to a row the person no longer OWNS? Row 22 is marked
 *      Unassigned. Writing maintenance state onto an unassigned row is the class
 *      of problem the assignment marker exists to prevent.
 */
import { readFileSync } from 'fs';
import { findMonthlyHistoryEntry, shouldWriteReconciledStatus, maintenanceStatusRank, normalizeMaintenanceStatusText } from '../src/maintenanceStatus.js';

const MONTH = 'September 26';
const USER = 'Saiful';

const load = (p, keys) => {
  const j = JSON.parse(readFileSync(new URL(`../data/${p}`, import.meta.url), 'utf8'));
  if (Array.isArray(j)) return j;
  for (const k of keys) if (Array.isArray(j[k])) return j[k];
  return Object.values(j).find(Array.isArray) || [];
};
const drRows = load('daily-review.json', ['records', 'dailyReview']);
const siteRows = load('sites.json', ['sites', 'records']);

const norm = (u) => String(u || '').toLowerCase().replace(/^https?:\/\//, '').replace(/\/$/, '');
const sitesByDomain = new Map();
for (const s of siteRows) sitesByDomain.set(norm(s.url || s.domain), s);

console.log(`month: "${MONTH}"   user: ${USER}\n`);
const mine = drRows.filter((r) => String(r.userName || r.user || '').trim().toLowerCase() === USER.toLowerCase());
console.log(`${USER} has ${mine.length} daily-review record(s)\n`);

let mismatches = 0, downgrades = 0, wroteUnassigned = 0;
const UNASSIGNED_ROWS = new Set([22]); // verified by probe-saiful-reconcile.mjs

for (const r of mine) {
  const site = sitesByDomain.get(norm(r.siteUrl || r.url));
  const label = `row ${r.rowIndex ?? '?'}  ${norm(r.siteUrl || r.url)}`;
  if (!site) { console.log(`  ${label}\n     no site record -> row untouched by reconcile`); continue; }

  const entry = findMonthlyHistoryEntry(site.monthlyHistory || [], MONTH);
  if (!entry) { console.log(`  ${label}\n     no "${MONTH}" entry in monthlyHistory -> row untouched (strict matcher)`); continue; }

  const curRaw = String(r.maintenanceRaw || '').trim();
  const newRaw = String(entry.status || '').trim();
  const same = curRaw.toLowerCase() === newRaw.toLowerCase();

  console.log(`  ${label}`);
  console.log(`     cell currently (DB) : "${curRaw}"  [rank ${maintenanceStatusRank(curRaw)}]`);
  console.log(`     "${MONTH}" in history : "${newRaw}"  [rank ${maintenanceStatusRank(newRaw)}]`);
  console.log(`     normalized           : "${normalizeMaintenanceStatusText(curRaw)}" -> "${normalizeMaintenanceStatusText(newRaw)}"`);

  if (same) { console.log(`     => no mismatch, nothing written\n`); continue; }

  mismatches++;
  const d = shouldWriteReconciledStatus({
    incomingRaw: newRaw, incomingStatus: null, currentRaw: curRaw,
  });
  console.log(`     => MISMATCH. decision: write=${d.write}  reason=${d.reason}  ${d.from} -> ${d.to}`);
  if (!d.write) { console.log(`        REFUSED — the sheet keeps "${curRaw}"`); }
  if (maintenanceStatusRank(newRaw) < maintenanceStatusRank(curRaw)) {
    downgrades++;
    console.log(`        *** this WAS a downgrade attempt ***`);
  }
  if (UNASSIGNED_ROWS.has(r.rowIndex)) {
    wroteUnassigned++;
    console.log(`        *** row ${r.rowIndex} is marked Unassigned in the sheet ***`);
  }
  console.log('');
}

console.log('='.repeat(70));
console.log(`mismatches found     : ${mismatches}`);
console.log(`downgrade attempts   : ${downgrades}`);
console.log(`writes to unassigned : ${wroteUnassigned}`);
console.log('');
console.log('READ-ONLY. Nothing written.');
