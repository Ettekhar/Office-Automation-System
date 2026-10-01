/**
 * preview-fill-existing-rows.mjs — DRY RUN, ZERO WRITES.
 *
 * Reports what a backfill of EXISTING Daily Review rows would change, without
 * changing anything. Every candidate is classified so the risky ones are never
 * hidden inside the safe ones:
 *
 *   FILL      target cell is BLANK   -> filling it loses no information
 *   DIFFERS   target cell has text   -> the DB disagrees with a human edit.
 *                                       These are NOT safe to write and are
 *                                       listed separately for a human call.
 *   SAME      target already equals  -> nothing to do
 *
 * It reuses proposeFieldFills(), the exact function the write path uses, so this
 * preview cannot drift from what a real write would produce.
 *
 * Deliberately does NOT propose touching:
 *   - the website URL column (identity of the row)
 *   - the account column
 *   - the Assignment marker column
 *   - any column whose header could not be resolved
 */
import * as db from '../src/db.js';
import { getTabValues } from '../src/sheets.js';
import {
  getDailyReviewSheetId, resolveUserTab, normalizeSiteUrl, proposeFieldFills,
} from '../src/userTabWriteBack.js';
import { resolveUserTabAccountColumn } from '../src/columnMap.js';
import { findAssignmentMarkerColumn } from '../src/userTabWriteBack.js';

const { id: sheetId, headerRow } = getDailyReviewSheetId();
const sites = db.getSites();
const users = db.getUsers() || [];
const activeUsers = users.filter((u) => u.active !== false);

console.log(`Existing-row backfill DRY RUN — nothing will be written`);
console.log(`spreadsheet: ${sheetId}\n`);

const perTab = new Map();      // tabName -> { fills, differs, same, rows, unrecognized }
const unassignedPairs = [];   // assigned in DB but no row in the tab
const getT = (t) => {
  if (!perTab.has(t)) perTab.set(t, { tab: t, fills: [], differs: [], same: 0, rows: 0, pairs: 0, noRow: [] });
  return perTab.get(t);
};

for (const u of activeUsers) {
  const rt = await resolveUserTab(u.name);
  if (!rt.user || rt.reason) { console.log(`  ${u.name}: skipped (${rt.reason})`); continue; }
  const tab = rt.tabName;
  const T = getT(tab);

  let values;
  try {
    values = (await getTabValues(tab, `A${headerRow}:ZZ2000`, sheetId)) || [];
  } catch (e) {
    console.log(`  ${u.name} [${tab}]: READ FAILED — ${e.message}`);
    continue;
  }
  const header = (values[0] || []).map((h) => (h == null ? '' : h));
  const rows = values.slice(1);
  T.rows = rows.length;

  // Resolve the URL column the same way the writer does, then reuse the tab read.
  const { readAndResolveTab } = await import('../src/userTabWriteBack.js');
  const resolved = await readAndResolveTab(tab, sheetId, headerRow);
  if (!resolved.ok) { console.log(`  ${u.name} [${tab}]: url column unresolved (${resolved.reason})`); continue; }
  const urlCol = resolved.col;

  const accountRes = resolveUserTabAccountColumn({ headers: header, rows, urlCol });
  const accountCol = Number.isInteger(accountRes?.col) ? accountRes.col : -1;
  const markerCol = findAssignmentMarkerColumn(header);

  const assigned = sites.filter((s) => (s.assignedUsers || []).includes(u.id));
  for (const s of assigned) {
    T.pairs++;
    const clean = normalizeSiteUrl(s.url);
    let hit = -1;
    for (let i = 0; i < rows.length; i++) {
      if (normalizeSiteUrl((rows[i] || [])[urlCol]) === clean) { hit = i; break; }
    }
    if (hit === -1) { unassignedPairs.push({ user: u.name, tab, url: s.url }); T.noRow.push(s.url); continue; }

    const dr = (db.getDailyReview({ siteId: s.id, userId: u.id }) || [])[0] || null;
    const { filled } = proposeFieldFills({
      header, rows, urlCol, accountCol, markerCol, site: s, dr,
    });
    const currentRow = rows[hit] || [];
    const rowNumber = headerRow + 1 + hit;

    for (const f of filled) {
      const cur = String((currentRow || [])[f.col] ?? '').trim();
      if (cur === f.value) { T.same++; continue; }
      const rec = {
        row: rowNumber, url: s.url, col: f.col, header: f.header || f.field,
        current: cur, proposed: f.value,
      };
      if (cur === '') T.fills.push(rec); else T.differs.push(rec);
    }
  }
}

// ── Report ──
let totalFill = 0, totalDiff = 0, totalSame = 0;
const fillByColumn = new Map();
const riskyFills = [];
for (const T of perTab.values()) {
  for (const f of T.fills) {
    const k = `${T.tab} | ${f.header || f.field}`;
    fillByColumn.set(k, (fillByColumn.get(k) || 0) + 1);
    // The Daily Review tabs use "Completed"; "Updated & Backup" is the ACCOUNT
    // month-column wording. A blank cell filled with the wrong vocabulary is
    // still corruption, so flag it rather than counting it as a safe fill.
    if (f.header === 'Maintenance' && /updated\s*&\s*backup/i.test(f.value)) {
      riskyFills.push({ ...f, tab: T.tab });
    }
  }
}
for (const T of perTab.values()) {
  totalFill += T.fills.length; totalDiff += T.differs.length; totalSame += T.same;
  console.log(`── ${T.tab}  (${T.rows} rows, ${T.pairs} assigned pairs)`);
  console.log(`   blank cells that would be FILLED : ${T.fills.length}`);
  console.log(`   cells that DIFFER from the DB    : ${T.differs.length}   <-- human edits, not safe to auto-write`);
  console.log(`   cells already identical          : ${T.same}`);
  if (T.noRow.length) console.log(`   pairs with NO row in this tab    : ${T.noRow.length}`);
  for (const f of T.differs) {
    console.log(`     DIFFERS row ${f.row} [${f.header}] current="${f.current}" db="${f.proposed}"  (${f.url})`);
  }
  console.log('');
}

console.log('════ WHAT THE 99 FILLS ACTUALLY ARE ════');
for (const [k, n] of [...fillByColumn.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(n).padStart(3)}  ${k}`);
}
console.log('');
console.log('════ SUMMARY ════');
console.log(`  blank cells a backfill would fill : ${totalFill}`);
console.log(`  cells that DIFFER (need review)   : ${totalDiff}`);
console.log(`  already identical (no-op)         : ${totalSame}`);
console.log(`  assigned pairs with no sheet row  : ${unassignedPairs.length}`);
console.log(`  of the fills, WRONG-VOCABULARY    : ${riskyFills.length}   (Maintenance="Updated & Backup" in a tab that writes "Completed")`);
if (riskyFills.length) {
  for (const r of riskyFills) console.log(`     row ${r.row} [${r.tab}!${r.header}] would write "${r.proposed}"  (${r.url})`);
}
console.log('');
console.log('NO WRITES WERE MADE.');
