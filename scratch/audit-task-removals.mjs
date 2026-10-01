/**
 * READ-ONLY. Identify the 15 tasks a real sync would DELETE, and check each
 * against the Distribution sheet with progressively looser matching.
 *
 * Why this matters: importTasks() preserves IDs by natural key
 * (taskName|siteUrl|assigneeName). A task whose key vanished is reported as
 * "removed" and setTasks() would drop it. If the row is merely RENAMED or has a
 * slightly different URL/assignee spelling, deleting it is silent data loss —
 * exactly what the DB-first architecture forbids. So each candidate is checked
 * against the sheet by clickupLink and by task name before we trust the removal.
 *
 * Writes nothing. Touches no DB file.
 */
import { getTabValues } from '../src/sheets.js';
import { getSheetId } from '../src/syncFromSheets.js';
import fs from 'node:fs';

const loose = (v) => String(v ?? '').toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/[^a-z0-9]+/g, '');
const readJson = (f) => JSON.parse(fs.readFileSync(new URL(`../data/${f}`, import.meta.url), 'utf8'));

const dbTasks = readJson('tasks.json');
const sheetId = getSheetId('MASTER_TRACKER');
const rows = await getTabValues('Distribution and Work Sheet', 'A1:ZZ3000', sheetId);
console.log(`  sheet ${sheetId}: ${rows.length} rows returned\n`);

const h = rows[0] || [];
const idx = (...names) => {
  const n = h.map((x) => String(x ?? '').toLowerCase().trim());
  for (const want of names) { const i = n.indexOf(want); if (i !== -1) return i; }
  return -1;
};
const cTask = idx('task name'), cCu = idx('clickup'), cWeb = idx('website'), cAsg = idx('assignee');

const sheetRows = rows.slice(1)
  .map((r, i) => ({
    sheetRow: i + 2,
    taskName: String(r[cTask] ?? '').trim(),
    clickup: String(r[cCu] ?? '').trim(),
    website: String(r[cWeb] ?? '').trim(),
    assignee: String(r[cAsg] ?? '').trim(),
  }))
  .filter((r) => r.taskName || r.website);

const keyOf = (taskName, website, assignee) =>
  [String(taskName || '').toLowerCase(), loose(website), String(assignee || '').toLowerCase()].join('|');

const sheetKeys = new Set(sheetRows.map((r) => keyOf(r.taskName, r.website, r.assignee)));
const byCu = new Map();
const byName = new Map();
for (const r of sheetRows) {
  const cu = String(r.clickup).trim();
  if (cu) byCu.set(cu, r);
  const n = loose(r.taskName);
  if (n && !byName.has(n)) byName.set(n, r);
}

const removed = dbTasks.filter((t) => !sheetKeys.has(keyOf(t.taskName, t.siteUrl, t.assigneeName)));
console.log(`  tasks a real sync would DELETE: ${removed.length}\n`);

let orphan = 0, rename = 0, trulyGone = 0;
for (const t of removed) {
  const cuHit = String(t.clickupLink || '').trim() ? byCu.get(String(t.clickupLink).trim()) : null;
  const nameHit = byName.get(loose(t.taskName)) || null;
  const exists = cuHit || nameHit;
  if (exists) {
    rename++;
    const hit = cuHit || nameHit;
    console.log(`  ⚠ STILL IN SHEET (row ${hit.sheetRow}) — deleting would lose it`);
    console.log(`      db    : "${t.taskName}" | site="${t.siteUrl}" | assignee="${t.assigneeName}" | clickup="${t.clickupLink}"`);
    console.log(`      sheet : "${hit.taskName}" | site="${hit.website}" | assignee="${hit.assignee}" | clickup="${hit.clickup}"`);
    console.log(`      match : ${cuHit ? 'clickupLink' : 'taskName'}\n`);
  } else {
    trulyGone++;
    console.log(`  ✓ absent from sheet — removal is legitimate`);
    console.log(`      "${t.taskName}" | site="${t.siteUrl}" | assignee="${t.assigneeName}" | status="${t.status}"`);
    console.log(`      no clickupLink match, no taskName match\n`);
  }
}
console.log(`  ────────────────────────────────────────────`);
console.log(`  would LOSE data : ${rename}`);
console.log(`  genuinely gone  : ${trulyGone}`);
console.log(`  total candidates: ${removed.length}${orphan ? ` (${orphan} unclassified)` : ''}`);
process.exit(rename > 0 ? 2 : 0);
