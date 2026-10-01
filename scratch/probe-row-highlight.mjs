/**
 * probe-row-highlight.mjs — READ-ONLY. Writes nothing.
 *
 * The request: instead of only writing "Unassigned" into the marker cell, paint
 * the WHOLE row background orange or blue.
 *
 * Two things must be measured before designing that:
 *
 *  1. WHICH ROWS would be painted. The assignment marker cell is the truth
 *     ("Unassigned" => paint), and the paint must be reversible on re-assign.
 *
 *  2. WHAT IS ALREADY THERE. A whole-row paint overwrites every cell's background
 *     in that row. These tabs are already colour-coded, so painting a row could
 *     silently destroy meaning that is already there. "Never silently overwrite"
 *     means this has to be known first, not discovered afterwards.
 *
 * A NOTE ON THE READ, because it gave a false answer first time.
 * `spreadsheets.get` with includeGridData and no `fields` returns
 * rowData.userEnteredFormat but NO values, so all 8 tabs read as empty and the
 * assignment marker column looked absent — contradicted by the audit log, which
 * names cells like Taion!K32. A `fields` mask AND a `ranges` scope are both
 * required; an unbounded gridData read is rejected outright.
 */
import { getSheetsClient } from '../src/sheets.js';
import {
  getDailyReviewSheetId, findAssignmentMarkerColumn,
  ASSIGNMENT_MARKER_ON_UNASSIGN, ASSIGNMENT_MARKER_ON_ASSIGN, ASSIGNMENT_MARKER_LABEL,
} from '../src/userTabWriteBack.js';

const { id: sheetId } = getDailyReviewSheetId();
const sheets = await getSheetsClient();

const props = await sheets.spreadsheets.get({ spreadsheetId: sheetId, fields: 'sheets(properties(title,gridProperties))' });
const tabs = (props.data.sheets || []).filter((s) => (s.properties || {}).title);

const SCOPE_ROWS = 60;
const SCOPE_COLS = 'AZ';
const read = async (mask) => {
  const out = new Map();
  for (const t of tabs) {
    const title = t.properties.title;
    const r = await sheets.spreadsheets.get({
      spreadsheetId: sheetId,
      includeGridData: true,
      ranges: [`'${title}'!A1:${SCOPE_COLS}${SCOPE_ROWS}`],
      fields: mask,
    });
    out.set(title, (r.data.sheets?.[0]?.data?.[0]?.rowData) || []);
  }
  return out;
};

const valueRows = await read('sheets(data(rowData(values(formattedValue))))');
const fmtRows = await read('sheets(data(rowData(values(userEnteredFormat.backgroundColor))))');

const bgOf = (c) => {
  const bg = c && c.userEnteredFormat && c.userEnteredFormat.backgroundColor;
  if (!bg) return null;
  return '#' + [bg.red || 0, bg.green || 0, bg.blue || 0]
    .map((v) => Math.round(v * 255).toString(16).padStart(2, '0')).join('');
};

console.log(`spreadsheet : ${sheetId}`);
console.log(`marker hdr  : "${ASSIGNMENT_MARKER_LABEL}" / "Assigned" / "Assignment Status"`);
console.log(`on unassign : "${ASSIGNMENT_MARKER_ON_UNASSIGN}"\n`);

const reports = [];
console.log('='.repeat(82));
console.log('1. PER-TAB STATE');
console.log('='.repeat(82));

for (const t of tabs) {
  const title = t.properties.title;
  const cols = (t.properties.gridProperties || {}).columnCount || 0;
  const vRows = valueRows.get(title) || [];
  const fRows = fmtRows.get(title) || [];
  const header = (vRows[0]?.values || []).map((c) => (c && c.formattedValue) || '');
  const markerCol = findAssignmentMarkerColumn(header);

  const unassigned = [], assigned = [], other = [];
  if (markerCol >= 0) {
    for (let r = 1; r < vRows.length; r++) {
      const cell = vRows[r]?.values?.[markerCol];
      const val = String((cell && cell.formattedValue) || '').trim();
      if (val === ASSIGNMENT_MARKER_ON_UNASSIGN) unassigned.push(r + 1);
      else if (val === ASSIGNMENT_MARKER_ON_ASSIGN) assigned.push(r + 1);
      else if (val) other.push(`r${r + 1}="${val}"`);
    }
  }

  // Row extent actually used, so "the whole row" can be a real range.
  let lastCol = 0;
  vRows.forEach((rd) => (rd.values || []).forEach((c, i) => {
    if (String((c && c.formattedValue) || '').trim()) lastCol = Math.max(lastCol, i);
  }));

  const colours = new Map();
  fRows.forEach((rd) => (rd.values || []).forEach((c) => {
    const b = bgOf(c);
    if (b) colours.set(b, (colours.get(b) || 0) + 1);
  }));

  const atRisk = [];
  for (const rn of unassigned) {
    (fRows[rn - 1]?.values || []).forEach((c, ci) => {
      const b = bgOf(c);
      if (b) atRisk.push(`r${rn}c${ci + 1}=${b}`);
    });
  }

  reports.push({ title, cols, lastCol, markerCol, unassigned, assigned, other, colours, atRisk });

  console.log(`\n  ${title}   (${vRows.length} rows read, grid ${cols} cols, data uses A..${String.fromCharCode(64 + lastCol)})`);
  console.log(`     marker column  : ${markerCol >= 0 ? `index ${markerCol} = "${header[markerCol]}"` : 'NONE'}`);
  console.log(`     Unassigned      : ${unassigned.length ? unassigned.join(', ') : '(none)'}`);
  console.log(`     Assigned        : ${assigned.length}`);
  if (other.length) console.log(`     other values    : ${other.slice(0, 5).join(', ')}${other.length > 5 ? ` …+${other.length - 5}` : ''}`);
  if (!colours.size) {
    console.log(`     existing fills  : none`);
  } else {
    const list = [...colours.entries()].sort((a, b) => b[1] - a[1]).slice(0, 7).map(([c, n]) => `${c}×${n}`).join(', ');
    console.log(`     existing fills  : ${list}${colours.size > 7 ? ` (+${colours.size - 7} more)` : ''}`);
  }
  if (atRisk.length) console.log(`     AT RISK         : ${atRisk.length} pre-filled cells inside unassigned rows -> ${atRisk.slice(0, 8).join(' ')}`);
}

console.log(`\n${'='.repeat(82)}`);
console.log('2. WHAT A WHOLE-ROW PAINT WOULD TOUCH');
console.log('='.repeat(82));
const total = reports.reduce((n, r) => n + r.unassigned.length, 0);
const totalRisk = reports.reduce((n, r) => n + r.atRisk.length, 0);
for (const r of reports) {
  if (!r.unassigned.length) continue;
  console.log(`  ${r.title.padEnd(9)} rows ${String(r.unassigned.join(',')).padEnd(14)} paint A..${String.fromCharCode(64 + Math.max(r.lastCol, 1))}   at-risk cells: ${r.atRisk.length}`);
}
console.log(`\n  rows to paint              : ${total}`);
console.log(`  pre-filled cells at risk   : ${totalRisk}`);

console.log(`\n${'='.repeat(82)}`);
console.log('3. CONSTRAINTS THE DESIGN MUST SATISFY');
console.log('='.repeat(82));
const noMarker = reports.filter((r) => r.markerCol < 0);
console.log(`  tabs with a marker column : ${reports.length - noMarker.length} of ${reports.length}`);
if (noMarker.length) console.log(`  tabs WITHOUT one           : ${noMarker.map((r) => r.title).join(', ')}`);
console.log(`  -> without a marker cell there is no record of WHY a row is coloured,`);
console.log(`     so colour alone would be unreadable and un-auditable.`);
console.log(`  -> colour is DERIVED state. The marker cell is the truth, so assign must`);
console.log(`     CLEAR the fill or a re-assigned row stays coloured forever.`);

console.log('\nREAD-ONLY. Nothing written.');
