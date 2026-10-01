/**
 * probe-marker-column.mjs — READ-ONLY. Writes nothing.
 *
 * probe-row-highlight.mjs reported that NO tab has an assignment marker column,
 * yet data/audit-log.json contains `user-tab:soft-removed` entries claiming a
 * marker was set to "Unassigned (row kept)".
 *
 * One of those two things is wrong, and which one decides whether unassigning
 * currently does anything at all in the sheet. So: dump the real header rows,
 * and search every tab for the literal string "Unassigned".
 */
import { getSheetsClient } from '../src/sheets.js';
import { getDailyReviewSheetId, findAssignmentMarkerColumn, ASSIGNMENT_MARKER_HEADERS, ASSIGNMENT_MARKER_ON_UNASSIGN } from '../src/userTabWriteBack.js';

const { id: sheetId } = getDailyReviewSheetId();
const sheets = await getSheetsClient();
// The field mask must be explicit. With includeGridData and no `fields`, the API
// returned rowData.userEnteredFormat but NO values, which made every tab look
// empty and the marker column look absent. That produced a false "no tab has a
// marker column" reading, contradicted by the audit log naming Taion!K32.
const FIELDS = 'sheets(properties(title,gridProperties),data(rowData(values(formattedValue),userEnteredFormat(backgroundColor,backgroundColorStyle))))';
const meta = await sheets.spreadsheets.get({ spreadsheetId: sheetId, includeGridData: true, fields: FIELDS });
const tabs = (meta.data.sheets || []).filter((s) => (s.properties || {}).title);

console.log(`\nmarker headers searched for: ${JSON.stringify(ASSIGNMENT_MARKER_HEADERS)}\n`);

for (const sh of tabs) {
  const title = sh.properties.title;
  const grid = (sh.data || [])[0] || {};
  const values = (grid.values || []).map((r) => (r || []).map((c) => (c && c.formattedValue) || ''));
  const header = values[0] || [];

  console.log(`── ${title}  (${values.length} rows returned)`);
  console.log(`   header: ${header.map((h, i) => `${i}:${h || '-'}`).join('  ')}`);
  console.log(`   findAssignmentMarkerColumn -> ${findAssignmentMarkerColumn(header)}`);

  // Any cell anywhere containing "unassign" (case-insensitive)?
  const hits = [];
  values.forEach((row, r) => row.forEach((v, c) => {
    if (/unassign/i.test(String(v || ''))) hits.push(`r${r + 1}c${c + 1}="${v}"`);
  }));
  console.log(`   cells containing "unassign": ${hits.length ? hits.join(', ') : 'NONE'}`);
  console.log('');
}

console.log('='.repeat(78));
console.log('WHAT THE AUDIT LOG CLAIMS');
console.log('='.repeat(78));
const { readFileSync } = await import('fs');
const { fileURLToPath } = await import('url');
const path = await import('path');
const here = path.dirname(fileURLToPath(import.meta.url));
const log = JSON.parse(readFileSync(path.join(here, '..', 'data', 'audit-log.json'), 'utf8'));
const soft = log.filter((e) => String(e.action || '').includes('soft-remove'));
console.log(`soft-remove audit entries: ${soft.length}`);
for (const e of soft.slice(-8)) {
  console.log(`  action=${e.action} entity=${e.entity} field=${e.field}`);
  console.log(`     '${e.oldValue}' -> '${e.newValue}'`);
  console.log(`     reason: ${String(e.reason || '').slice(0, 150)}`);
}

const markerAdds = log.filter((e) => String(e.source || '').includes('ensureAssignmentMarkerColumn'));
console.log(`\nensureAssignmentMarkerColumn audit entries: ${markerAdds.length}`);
for (const e of markerAdds.slice(0, 8)) {
  console.log(`  ${e.entity} ${e.field}: '${e.oldValue}' -> '${e.newValue}'  [${e.source}]`);
}
console.log(`\n  marker header the code looks for : ${JSON.stringify(ASSIGNMENT_MARKER_HEADERS)}`);
console.log(`  marker value on unassign         : ${JSON.stringify(ASSIGNMENT_MARKER_ON_UNASSIGN)}`);

console.log('\nREAD-ONLY. Nothing written.');
