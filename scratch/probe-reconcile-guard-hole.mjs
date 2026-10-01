/**
 * probe-reconcile-guard-hole.mjs — READ-ONLY. Writes nothing.
 *
 * FINDING UNDER TEST
 * ------------------
 * server.js:1021-1026 builds the overlay for a matched month entry:
 *
 *     const rawVal  = (entry.status || '').trim();     // "" when the month is blank
 *     const normMap = { ..., '': 'todo' };
 *     const normVal = normMap[(rawVal||'').toLowerCase()] || 'todo';
 *     return { ...row,
 *              maintenanceStatus: normVal,        // -> "todo"  ALWAYS, even for ""
 *              maintenanceRaw:    rawVal || '',   // -> ""      (the honest blank)
 *              _origMaintenanceRaw: row.maintenanceRaw || '' };
 *
 * The rank guard is then called (server.js:1053) with:
 *     incomingRaw:     row.maintenanceRaw     -> ""
 *     incomingStatus:  row.maintenanceStatus  -> "todo"   <-- TRUTHY
 *
 * maintenanceStatus.js:225 guards empty sources with:
 *     if (!inRaw && !incomingStatus) return { write:false, reason:'empty-source-would-downgrade' }
 *
 * Because incomingStatus is the fabricated "todo", `!incomingStatus` is false, the
 * empty-source branch is SKIPPED, and the guard falls through to the rank compare:
 *     from = rank("To Do") = 1
 *     to   = rank("" || "todo") = rank("todo") = 1
 *     1 < 1 is false  ->  { write: true }
 *
 * So a blank month column is laundered into a real "todo" status, ranks equal to the
 * work it should never touch, and the guard waves it through. The row is then written
 * with maintenanceRaw "" -> the sheet cell is BLANKED.
 *
 * This is the "placeholder is not honest" rule violated one layer upstream of the
 * guard: the guard was never given the chance to see that the source said nothing.
 *
 * The second, smaller defect is server.js:1058:
 *     return decision.write ? { row, decision } : { row, decision };
 * Both arms are identical, so refused decisions survive `.filter(Boolean)` at 1061
 * and are still handed to the writer at 1148.
 */
import { readFileSync } from 'fs';
import {
  findMonthlyHistoryEntry, shouldWriteReconciledStatus,
  maintenanceStatusRank,
} from '../src/maintenanceStatus.js';

const MONTHS = ['September 26'];
const USERS = ['Saiful'];

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

// Verbatim from server.js:1021-1026
const normMap = {
  'updated & backup': 'completed', 'completed': 'completed',
  'in progress': 'in_progress', 'to do': 'todo', 'todo': 'todo',
  'pending': 'pending', '': 'todo',
};

let totalMismatch = 0, totalAllowed = 0, totalBlankWrites = 0;
const casualties = [];

for (const USER of USERS) {
  for (const MONTH of MONTHS) {
    const mine = drRows.filter((r) => String(r.userName || r.user || '').trim().toLowerCase() === USER.toLowerCase());
    console.log(`\n${'#'.repeat(72)}\n# ${USER} / "${MONTH}" — ${mine.length} record(s)\n${'#'.repeat(72)}`);

    for (const r of mine) {
      const site = sitesByDomain.get(norm(r.siteUrl || r.url));
      const label = `row ${r.rowIndex ?? '?'}  ${norm(r.siteUrl || r.url)}`;
      if (!site) { console.log(`\n  ${label}\n     no site record -> untouched`); continue; }

      const entry = findMonthlyHistoryEntry(site.monthlyHistory || [], MONTH);
      if (!entry) { console.log(`\n  ${label}\n     no "${MONTH}" entry -> untouched`); continue; }

      // ── replicate the overlay exactly ──
      const rawVal = String(entry.status || '').trim();
      const normVal = normMap[rawVal.toLowerCase()] || 'todo';
      const rowMaintenanceRaw = rawVal || '';
      const rowMaintenanceStatus = normVal;
      const _origMaintenanceRaw = String(r.maintenanceRaw || '').trim();

      const curRaw = _origMaintenanceRaw;
      const newRaw = rowMaintenanceRaw.trim();
      if (curRaw.toLowerCase() === newRaw.toLowerCase()) continue; // no mismatch

      totalMismatch++;
      const decision = shouldWriteReconciledStatus({
        incomingRaw: newRaw,
        incomingStatus: rowMaintenanceStatus,   // <-- the fabricated "todo"
        currentRaw: curRaw,
      });

      const blanksRealWork = decision.write && newRaw === '' && curRaw !== '';
      const allowed = decision.write;

      console.log(`\n  ${label}`);
      console.log(`     cell currently     : "${curRaw}"  [rank ${maintenanceStatusRank(curRaw)}]`);
      console.log(`     month "${MONTH}"    : "${newRaw}"  [rank ${maintenanceStatusRank(newRaw)}]  (empty = no information)`);
      console.log(`     overlay produced   : maintenanceRaw="${rowMaintenanceRaw}"  maintenanceStatus="${rowMaintenanceStatus}"`);
      console.log(`     guard verdict      : write=${decision.write}  reason=${decision.reason || 'n/a'}`);

      if (allowed) {
        totalAllowed++;
        console.log(`     => WOULD WRITE "${rowMaintenanceRaw}" into the cell`);
      }
      if (blanksRealWork) {
        totalBlankWrites++;
        casualties.push({ USER, MONTH, row: r.rowIndex ?? '?', url: norm(r.siteUrl || r.url), lost: curRaw });
        console.log(`     *** HOLE: blank source (no information) was allowed to overwrite recorded work ***`);
        console.log(`         the honest reason would have been "empty-source-would-downgrade"`);
      }
    }
  }
}

console.log(`\n${'='.repeat(72)}`);
console.log(`mismatches evaluated      : ${totalMismatch}`);
console.log(`guard ALLOWED the write   : ${totalAllowed}`);
console.log(`writes that BLANK real work: ${totalBlankWrites}`);
console.log('='.repeat(72));
if (casualties.length) {
  console.log('\nrows that would lose recorded work:');
  for (const c of casualties) console.log(`  ${c.USER}!${c.row}  ${c.url}  would lose "${c.lost}"`);
}
console.log('\nREAD-ONLY. Nothing written.');
