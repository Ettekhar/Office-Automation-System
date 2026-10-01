/**
 * probe-toufiq-clear-candidate.mjs — READ-ONLY. Writes nothing.
 *
 * The dry run wants to CLEAR Toufiq rows 27 and 28 because their marker says
 * "Assigned". But Toufiq has 288 cells of #cfe2f3 row banding, so a fill on
 * those rows may be the sheet's own banding rather than a leftover tint.
 *
 * Clearing a band colour would be destroying the team's formatting on the
 * strength of a guess, so the actual fills are read before anything is decided.
 */
import { getSheetsClient, getTabValues } from '../src/sheets.js';
import { getDailyReviewSheetId } from '../src/userTabWriteBack.js';
import { UNASSIGNED_ROW_FILL_HEX } from '../src/rowHighlight.js';

const { id: sheetId } = getDailyReviewSheetId();
const sheets = await getSheetsClient();

const FIELDS = 'sheets(data(rowData(values(formattedValue,userEnteredFormat.backgroundColor))))';
const r = await sheets.spreadsheets.get({
  spreadsheetId: sheetId, includeGridData: true,
  ranges: [`'Toufiq'!A1:AZ60`], fields: FIELDS,
});
const rowData = r.data.sheets?.[0]?.data?.[0]?.rowData || [];
const val = (rr, cc) => String(rowData[rr]?.values?.[cc]?.formattedValue || '').trim();
const fill = (rr, cc) => {
  const bg = rowData[rr]?.values?.[cc]?.userEnteredFormat?.backgroundColor;
  if (!bg) return null;
  return '#' + [bg.red || 0, bg.green || 0, bg.blue || 0]
    .map((v) => Math.round(v * 255).toString(16).padStart(2, '0')).join('').toUpperCase();
};

console.log(`our tint would be ${UNASSIGNED_ROW_FILL_HEX}\n`);

for (const rn of [26, 27, 28, 29]) {
  const rr = rn - 1;
  const filled = [];
  for (let c = 0; c < 20; c++) {
    const f = fill(rr, c);
    if (f) filled.push(`${String.fromCharCode(65 + c)}=${f}`);
  }
  console.log(`Toufiq row ${rn}`);
  console.log(`   URL     : ${val(rr, 0)}`);
  console.log(`   marker  : "${val(rr, 12)}"  (marker col M)`);
  console.log(`   fills   : ${filled.length ? filled.join('  ') : '(none)'}`);
}

console.log('\n── what the band colour is across the tab ──');
const band = new Map();
rowData.forEach((rd, rr) => (rd.values || []).forEach((c, ci) => {
  const f = fill(rr, ci);
  if (!f) return;
  const k = `${f} in col ${String.fromCharCode(65 + ci)}`;
  band.set(k, (band.get(k) || 0) + 1);
}));
[...band.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)
  .forEach(([k, n]) => console.log(`   ${String(n).padStart(4)}x  ${k}`));

console.log('\nREAD-ONLY. Nothing written.');
