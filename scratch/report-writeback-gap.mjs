/**
 * READ-ONLY. For every site the DB says is assigned to a user, check whether that
 * site actually has a row in the assignee's Daily Review tab. This is the gap
 * assignment write-back exists to close ("<site> not found in <User> tab —
 * skipping"), measured against the live sheet.
 */
import * as db from '../src/db.js';
import { getTabValues } from '../src/sheets.js';
import { getDailyReviewSheetId, readAndResolveTab, resolveUserTab, normalizeSiteUrl } from '../src/userTabWriteBack.js';

const { id: SHEET_ID, headerRow } = getDailyReviewSheetId();
const users = db.getUsers();
const sites = db.getSites();

const tabCache = new Map();
async function tabOf(userName) {
  if (tabCache.has(userName)) return tabCache.get(userName);
  const rt = await resolveUserTab(userName);
  let entry;
  if (!rt.user || rt.reason) entry = { skipped: rt.reason };
  else {
    const t = await readAndResolveTab(rt.tabName, SHEET_ID, headerRow);
    if (!t.ok) entry = { skipped: t.reason, tabName: rt.tabName };
    else {
      const present = new Set();
      for (const r of t.rows) {
        const v = normalizeSiteUrl((r || [])[t.col]);
        if (v) present.add(v);
      }
      entry = { tabName: rt.tabName, col: t.col, via: t.via, present };
    }
  }
  tabCache.set(userName, entry);
  return entry;
}

const byUser = new Map();
for (const s of sites) {
  for (const uid of s.assignedUsers || []) {
    const u = users.find((x) => x.id === uid);
    if (!u) continue;
    if (!byUser.has(u.name)) byUser.set(u.name, []);
    byUser.get(u.name).push(s);
  }
}

let totalAssigned = 0, missingTotal = 0;
console.log(`  ${'user'.padEnd(9)} ${'tab'.padEnd(9)} ${'col'.padStart(3)}  assigned  present  missing`);
for (const [name, list] of [...byUser.entries()].sort()) {
  const e = await tabOf(name);
  if (e.skipped) {
    console.log(`  ${name.padEnd(9)} ${'—'.padEnd(9)} ${'—'.padStart(3)}  ${String(list.length).padStart(8)}  ${'—'.padStart(7)}  SKIPPED: ${e.skipped}`);
    totalAssigned += list.length;
    continue;
  }
  const missing = list.filter((s) => !e.present.has(normalizeSiteUrl(s.url)));
  totalAssigned += list.length;
  missingTotal += missing.length;
  console.log(`  ${name.padEnd(9)} ${e.tabName.padEnd(9)} ${String(e.col).padStart(3)}  ${String(list.length).padStart(8)}  ${String(list.length - missing.length).padStart(7)}  ${String(missing.length).padStart(7)}`);
  for (const s of missing) console.log(`      missing: ${s.url}`);
}
console.log(`\n  assigned (site,user) pairs: ${totalAssigned}`);
console.log(`  pairs with NO row in the assignee's tab: ${missingTotal}`);
