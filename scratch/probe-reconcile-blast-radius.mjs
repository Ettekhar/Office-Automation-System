/**
 * probe-reconcile-blast-radius.mjs — READ-ONLY. Writes nothing.
 *
 * probe-reconcile-guard-hole.mjs proved the hole on Saiful!21 for "September 26".
 * This sizes it: the same overlay runs for every user tab and every month the
 * viewer can select, so the question is how many (row, month) pairs would have a
 * blank month column laundered into "todo" and allowed to overwrite a cell that
 * already records work.
 *
 * Only pairs that can actually reach the writer are counted:
 *   - the record has a rowIndex (something to write to)
 *   - the site HAS an entry for that month (otherwise the strict matcher
 *     short-circuits at server.js:1018 and the row is untouched)
 *   - the month column is blank ("" -> the fabricated "todo")
 *   - the cell currently records something (rank > 0), i.e. work that would be lost
 */
import { readFileSync } from 'fs';
import { findMonthlyHistoryEntry, shouldWriteReconciledStatus, maintenanceStatusRank } from '../src/maintenanceStatus.js';

const load = (p, keys) => {
  const j = JSON.parse(readFileSync(new URL(`../data/${p}`, import.meta.url), 'utf8'));
  if (Array.isArray(j)) return j;
  for (const k of keys) if (Array.isArray(j[k])) return j[k];
  return Object.values(j).find(Array.isArray) || [];
};
const drRows = load('daily-review.json', ['records', 'dailyReview']);
const siteRows = load('sites.json', ['sites', 'records']);
const users = load('users.json', ['users', 'records']);

const norm = (u) => String(u || '').toLowerCase().replace(/^https?:\/\//, '').replace(/\/$/, '');
const sitesByDomain = new Map();
for (const s of siteRows) sitesByDomain.set(norm(s.url || s.domain), s);

// collect every month label that appears anywhere, in first-seen order
const months = [];
for (const s of siteRows) {
  for (const e of (s.monthlyHistory || [])) {
    const m = e.month || e.label || e.name;
    if (m && !months.includes(m)) months.push(m);
  }
}

const normMap = {
  'updated & backup': 'completed', 'completed': 'completed',
  'in progress': 'in_progress', 'to do': 'todo', 'todo': 'todo',
  'pending': 'pending', '': 'todo',
};

console.log(`records: ${drRows.length}   sites: ${siteRows.length}   distinct month labels: ${months.length}`);
console.log(`month labels: ${months.join(', ')}\n`);

const atRisk = [];
const byUser = {};
let considered = 0, mismatch = 0, allowed = 0;

for (const r of drRows) {
  if (r.rowIndex == null) continue;             // nothing to write to
  const u = String(r.userName || r.user || '').trim();
  if (!u) continue;
  const site = sitesByDomain.get(norm(r.siteUrl || r.url));
  if (!site) continue;
  for (const month of months) {
    const entry = findMonthlyHistoryEntry(site.monthlyHistory || [], month);
    if (!entry) continue;                        // untouched
    considered++;
    const rawVal = String(entry.status || '').trim();
    const curRaw = String(r.maintenanceRaw || '').trim();
    if (curRaw.toLowerCase() === rawVal.toLowerCase()) continue;
    mismatch++;
    const decision = shouldWriteReconciledStatus({
      incomingRaw: rawVal,
      incomingStatus: normMap[rawVal.toLowerCase()] || 'todo',   // the fabrication
      currentRaw: curRaw,
    });
    if (!decision.write) continue;
    allowed++;
    if (rawVal === '' && curRaw !== '') {
      atRisk.push({ u, month, row: r.rowIndex, url: norm(r.siteUrl || r.url), lost: curRaw });
      byUser[u] = (byUser[u] || 0) + 1;
    }
  }
}

console.log(`(row, month) pairs reaching the writer : ${considered}`);
console.log(`of those, mismatches                   : ${mismatch}`);
console.log(`of those, guard ALLOWED the write      : ${allowed}`);
console.log(`BLANK-OVER-WORK (real data at risk)    : ${atRisk.length}\n`);

if (atRisk.length) {
  console.log('--- affected rows, by user ---');
  for (const [u, n] of Object.entries(byUser).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${u.padEnd(10)} ${n} row-month pair(s)`);
  }
  console.log('\n--- detail (September 26 first) ---');
  const show = [...atRisk].sort((a, b) => (a.month === 'September 26' ? -1 : b.month === 'September 26' ? 1 : 0) || a.u.localeCompare(b.u));
  for (const a of show.slice(0, 60)) {
    console.log(`  ${a.u}!${String(a.row).padEnd(4)} ${a.month.padEnd(16)} ${a.url.padEnd(38)} would lose "${a.lost}"`);
  }
  if (show.length > 60) console.log(`  ... and ${show.length - 60} more`);
}

const inactive = users.filter((u) => u.active === false).map((u) => u.name);
if (inactive.length) {
  console.log(`\nnote: inactive users (writer skips them at server.js:1140): ${inactive.join(', ')}`);
  const activeRisk = atRisk.filter((a) => !inactive.includes(a.u));
  console.log(`      at-risk pairs on ACTIVE users only: ${activeRisk.length}`);
}

console.log('\nREAD-ONLY. Nothing written.');
