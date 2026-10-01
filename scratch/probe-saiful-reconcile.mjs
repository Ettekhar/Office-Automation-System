/**
 * probe-saiful-reconcile.mjs — READ-ONLY. Writes nothing.
 *
 * The user saw:
 *   [reconcile] Saiful: 1 mismatched row(s) for "September 26" — 1 batch call
 *   [batch-sync] ✅ Saiful tab: wrote 1 cell(s) in 1 API call
 * and asked whether something got reverted and why an old problem returned.
 *
 * Context that matters: Saiful!21 and !22 were tinted #FCE5CD hours ago because
 * their marker said "Unassigned". Then a Quick assign put a site back on Saiful
 * and the app reported the site "already present in Saiful tab ... row 21".
 *
 * So the question is concrete and answerable:
 *   1. Is Saiful!21 still marked Unassigned?  If yes, the marker restore did NOT
 *      fire and that is a real defect in the code added on 2026-09-26.
 *   2. Is it still tinted? If yes, a live assignment is being shown as unassigned.
 *   3. What cell did the reconcile write, and was it a downgrade? The rank guard
 *      at server.js:1053 is supposed to make that impossible.
 */
import { getSheetsClient, getTabValues } from '../src/sheets.js';
import { getDailyReviewSheetId } from '../src/userTabWriteBack.js';
import { UNASSIGNED_ROW_FILL_HEX, highlightModeForMarker } from '../src/rowHighlight.js';
import { readFileSync } from 'fs';

const { id: sheetId, headerRow } = getDailyReviewSheetId();
const sheets = await getSheetsClient();

const values = (await getTabValues('Saiful', `A${headerRow}:ZZ2000`, sheetId)) || [];
const header = (values[0] || []).map((h) => (h == null ? '' : String(h)));
const col = (r, i) => String((values[r] || [])[i] ?? '').trim();
const letter = (i) => String.fromCharCode(65 + i);

const r = await sheets.spreadsheets.get({
  spreadsheetId: sheetId, includeGridData: true,
  ranges: [`'Saiful'!A1:AZ40`],
  fields: 'sheets(data(rowData(values(formattedValue,userEnteredFormat.backgroundColor))))',
});
const rowData = r.data.sheets?.[0]?.data?.[0]?.rowData || [];
const fill = (rr, cc) => {
  const bg = rowData[rr]?.values?.[cc]?.userEnteredFormat?.backgroundColor;
  if (!bg) return null;
  return '#' + [bg.red || 0, bg.green || 0, bg.blue || 0]
    .map((v) => Math.round(v * 255).toString(16).padStart(2, '0')).join('').toUpperCase();
};

const markerCol = header.findIndex((h) => /^(assignment|assigned|assignment status)$/i.test(h));
console.log(`Saiful marker column : ${markerCol} (${letter(markerCol)} = "${header[markerCol]}")`);
console.log(`our tint            : ${UNASSIGNED_ROW_FILL_HEX}`);
console.log(`rows in tab         : ${values.length}\n`);

console.log('=== rows 20-23, every populated cell ===');
for (let rn = 20; rn <= Math.min(23, values.length); rn++) {
  const rr = rn - 1;
  const marker = markerCol >= 0 ? col(rr, markerCol) : '(no marker col)';
  const mode = highlightModeForMarker(marker);
  const url = col(rr, 0);
  console.log(`\n  Saiful!${rn}  ${url || '(empty)'}`);
  console.log(`     marker "${marker}" -> highlight should be: ${mode}`);
  const cells = [];
  for (let c = 0; c < header.length; c++) {
    const v = col(rr, c);
    const f = fill(rr, c);
    if (!v && !f) continue;
    cells.push(`${letter(c)}${rn}[${header[c] || `col${c}`}]="${v}"${f ? ` fill=${f}` : ''}`);
  }
  cells.forEach((x) => console.log(`       ${x}`));
  const rowTinted = Array.from({ length: header.length }, (_, c) => fill(rr, c))
    .filter((f) => f === UNASSIGNED_ROW_FILL_HEX.toUpperCase()).length;
  console.log(`     cells carrying our tint: ${rowTinted}`);
  if (rowTinted > 0 && mode === 'clear') {
    console.log(`     *** INCONSISTENT: tinted but the marker says assigned ***`);
  }
  if (rowTinted === 0 && mode === 'fill') {
    console.log(`     *** INCONSISTENT: marker says unassigned but no tint ***`);
  }
}

console.log('\n=== what the DB says is assigned to Saiful right now ===');
const sites = JSON.parse(readFileSync(new URL('../data/sites.json', import.meta.url), 'utf8'));
const rows = Array.isArray(sites) ? sites : (sites.sites || []);
for (const s of rows) {
  const au = s.assignedUsers || s.assignees || [];
  const names = (Array.isArray(au) ? au : String(au).split(',')).map((x) => (typeof x === 'string' ? x : x.name));
  if (names.some((n) => String(n).toLowerCase() === 'saiful')) {
    const present = values.some((row, i) => i > 0 && col(i, 0).replace(/^https?:\/\//, '').replace(/\/$/, '') === String(s.url || s.domain || '').replace(/^https?:\/\//, '').replace(/\/$/, ''));
    console.log(`  ${(s.url || s.domain).padEnd(38)} id=${String(s.id).slice(0, 8)}  in Saiful tab: ${present ? 'yes' : 'NO'}`);
  }
}

console.log('\nREAD-ONLY. Nothing written.');
