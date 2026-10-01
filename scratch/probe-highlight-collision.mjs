/**
 * probe-highlight-collision.mjs — READ-ONLY. Writes nothing.
 *
 * probe-row-highlight.mjs found 6 rows that would be painted and 3 pre-filled
 * cells inside them that a whole-row paint would destroy. It also showed the
 * tabs already use a wide palette — notably a lot of RED (#f44834 x99 in Sabbir,
 * x60 in Taion) and PURPLE in column B of exactly those rows.
 *
 * So the colour must be chosen against what is already in use, not by taste.
 * Two questions:
 *   1. What does red already mean? If it means "overdue" or "urgent", then
 *      orange/red for "unassigned" would collide with a live signal.
 *   2. What is in column B of the rows to be painted, and what is its purple?
 */
import { getSheetsClient } from '../src/sheets.js';
import { getDailyReviewSheetId, findAssignmentMarkerColumn, ASSIGNMENT_MARKER_ON_UNASSIGN } from '../src/userTabWriteBack.js';

const { id: sheetId } = getDailyReviewSheetId();
const sheets = await getSheetsClient();

const props = await sheets.spreadsheets.get({ spreadsheetId: sheetId, fields: 'sheets(properties(title))' });
const titles = (props.data.sheets || []).map((s) => s.properties.title).filter(Boolean);

const hex = (bg) => bg ? '#' + [bg.red || 0, bg.green || 0, bg.blue || 0]
  .map((v) => Math.round(v * 255).toString(16).padStart(2, '0')).join('') : null;

const TARGETS = { Sabbir: [25], Taion: [30, 31, 32], Saiful: [21, 22] };

console.log('='.repeat(84));
console.log('1. COLUMN-BY-COLUMN FILLS  (what each colour is attached to)');
console.log('='.repeat(84));

for (const title of titles) {
  const r = await sheets.spreadsheets.get({
    spreadsheetId: sheetId, includeGridData: true,
    ranges: [`'${title}'!A1:AZ60`],
    fields: 'sheets(data(rowData(values(formattedValue,userEnteredFormat.backgroundColor))))',
  });
  const rowData = r.data.sheets?.[0]?.data?.[0]?.rowData || [];
  const val = (rr, cc) => String(rowData[rr]?.values?.[cc]?.formattedValue || '').trim();
  const fill = (rr, cc) => hex(rowData[rr]?.values?.[cc]?.userEnteredFormat?.backgroundColor);

  const header = [];
  for (let c = 0; c < 20; c++) { const v = val(0, c); if (v) header.push([c, v]); }

  // Per-column fill census over data rows only.
  const perCol = new Map();
  for (let rr = 1; rr < rowData.length; rr++) {
    for (let c = 0; c < 20; c++) {
      const f = fill(rr, c);
      if (!f) continue;
      const name = (header.find(([i]) => i === c) || [, `col${c}`])[1];
      const k = `${f} in "${name}"`;
      perCol.set(k, (perCol.get(k) || 0) + 1);
    }
  }
  if (!perCol.size) { console.log(`\n  ${title}: no data-row fills`); continue; }
  console.log(`\n  ${title}`);
  for (const [k, n] of [...perCol.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)) {
    console.log(`     ${String(n).padStart(4)}x  ${k}`);
  }
}

console.log(`\n${'='.repeat(84)}`);
console.log('2. THE 6 ROWS THAT WOULD BE PAINTED — cell by cell');
console.log('='.repeat(84));

for (const [title, rows] of Object.entries(TARGETS)) {
  const r = await sheets.spreadsheets.get({
    spreadsheetId: sheetId, includeGridData: true,
    ranges: [`'${title}'!A1:AZ60`],
    fields: 'sheets(data(rowData(values(formattedValue,userEnteredFormat.backgroundColor))))',
  });
  const rowData = r.data.sheets?.[0]?.data?.[0]?.rowData || [];
  const val = (rr, cc) => String(rowData[rr]?.values?.[cc]?.formattedValue || '').trim();
  const fill = (rr, cc) => hex(rowData[rr]?.values?.[cc]?.userEnteredFormat?.backgroundColor);
  const markerCol = findAssignmentMarkerColumn(Array.from({ length: 20 }, (_, c) => val(0, c)));

  let lastCol = 0;
  for (let rr = 0; rr < rowData.length; rr++) {
    for (let c = 0; c < 20; c++) if (val(rr, c)) lastCol = Math.max(lastCol, c);
  }

  for (const rn of rows) {
    console.log(`\n  ${title}!row ${rn}   (marker col ${String.fromCharCode(65 + markerCol)} = "${val(0, markerCol)}" -> "${val(rn - 1, markerCol)}")`);
    for (let c = 0; c <= lastCol; c++) {
      const v = val(rn - 1, c);
      const f = fill(rn - 1, c);
      const hdr = val(0, c) || `col${c}`;
      const mark = c === markerCol ? '  <-- MARKER' : '';
      console.log(`     ${String.fromCharCode(65 + c).padEnd(2)} ${String(hdr).slice(0, 24).padEnd(25)} ` +
        `fill=${String(f || '-').padEnd(8)} val="${String(v).slice(0, 40)}"${mark}`);
    }
  }
}

console.log(`\n${'='.repeat(84)}`);
console.log('3. COLOUR COLLISION SUMMARY');
console.log('='.repeat(84));
console.log(`  RED family already in use   : #f44834, #ea4335   (Sabbir 99, Taion 60 cells)`);
console.log(`  BLUE family already in use  : #3c78d8 (header), #4285f4, #1155cc, #cfe2f3 (banding)`);
console.log(`  GREEN already in use        : #93c47d, #6aa84f, #b6d7a8`);
console.log(`  PURPLE already in use       : #8e7cc3, #b4a7d6  <- and 3 of these sit in the rows to paint`);
console.log(`\n  An orange fill would land in the same warm family as the existing red`);
console.log(`  cells, so it risks reading as the same signal. A mid blue collides with`);
console.log(`  nothing, but must be clearly darker than the #cfe2f3 row banding and`);
console.log(`  clearly lighter than the #3c78d8 header, or the row reads as a header.`);

console.log('\nREAD-ONLY. Nothing written.');
