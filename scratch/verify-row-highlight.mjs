/**
 * verify-row-highlight.mjs — OFFLINE. No network, no writes.
 *
 * Tests the pure planner that decides which cells a row tint touches. This is
 * the part that can quietly destroy data: if the segment maths is wrong, a
 * "whole row" paint lands on the company colour cell, or on the header, or
 * misses the row entirely and the unassign looks like it did nothing.
 *
 * The live half (does the account column actually resolve, does the fill
 * actually appear) is covered by the dry run, which reads the real sheet.
 */
import {
  buildRowSegments, segmentRange, planRowHighlightRequests, planBatchRowHighlight,
  highlightModeForMarker, UNASSIGNED_ROW_FILL, UNASSIGNED_ROW_FILL_HEX, BACKGROUND_FIELD,
} from '../src/rowHighlight.js';

let pass = 0, fail = 0;
const t = (name, cond, got) => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${got !== undefined ? `  got ${JSON.stringify(got)}` : ''}`); }
};
const S = (o) => JSON.stringify(o);

console.log('\n=== 1. buildRowSegments: which columns get painted ===');
t('no preserved column -> one run', S(buildRowSegments({ firstCol: 0, lastCol: 10 })) === S([{ startCol: 0, endCol: 10 }]));
t('preserved middle -> two runs', S(buildRowSegments({ firstCol: 0, lastCol: 4, preserveCols: [2] })) === S([{ startCol: 0, endCol: 1 }, { startCol: 3, endCol: 4 }]));
t('preserved FIRST -> one run, starts after it', S(buildRowSegments({ firstCol: 0, lastCol: 3, preserveCols: [0] })) === S([{ startCol: 1, endCol: 3 }]));
t('preserved LAST -> one run, ends before it', S(buildRowSegments({ firstCol: 0, lastCol: 3, preserveCols: [3] })) === S([{ startCol: 0, endCol: 2 }]));
t('preserved FIRST AND LAST -> middle only', S(buildRowSegments({ firstCol: 0, lastCol: 4, preserveCols: [0, 4] })) === S([{ startCol: 1, endCol: 3 }]));
t('everything preserved -> nothing to paint', S(buildRowSegments({ firstCol: 0, lastCol: 2, preserveCols: [0, 1, 2] })) === S([]));
t('a preserved column outside the span is ignored', S(buildRowSegments({ firstCol: 2, lastCol: 4, preserveCols: [0, 9] })) === S([{ startCol: 2, endCol: 4 }]));
t('duplicate preserved columns do not duplicate runs', S(buildRowSegments({ firstCol: 0, lastCol: 3, preserveCols: [1, 1, 1] })) === S([{ startCol: 0, endCol: 0 }, { startCol: 2, endCol: 3 }]));
t('a single-column row is one run', S(buildRowSegments({ firstCol: 0, lastCol: 0 })) === S([{ startCol: 0, endCol: 0 }]));
t('lastCol < firstCol -> empty', S(buildRowSegments({ firstCol: 5, lastCol: 2 })) === S([]));
t('negative / missing columns -> empty', S(buildRowSegments({})) === S([]) && S(buildRowSegments({ firstCol: -1, lastCol: 3 })) === S([]));
t('non-integer columns -> empty, never a guess', S(buildRowSegments({ firstCol: 1.5, lastCol: 4 })) === S([]));
t('garbage preserveCols -> still paints the whole row', S(buildRowSegments({ firstCol: 0, lastCol: 2, preserveCols: 'nope' })) === S([{ startCol: 0, endCol: 2 }]));

console.log('\n=== 2. segmentRange: readable A1, for the dry run ===');
t('one cell', segmentRange(30, 0, 0) === 'A30', segmentRange(30, 0, 0));
t('a span', segmentRange(30, 2, 10) === 'C30:K30', segmentRange(30, 2, 10));
t('crosses Z correctly', segmentRange(5, 25, 26) === 'Z5:AA5', segmentRange(5, 25, 26));

console.log('\n=== 3. planRowHighlightRequests: the shape sent to the API ===');
const base = { sheetId: 12345, rowNumber: 30, firstCol: 0, lastCol: 10, preserveCols: [1] };
const filled = planRowHighlightRequests({ ...base, mode: 'fill' });
t('produces two requests (one either side of the company column)', filled.requests.length === 2, filled.requests.length);
t('reports the two ranges (short form for a lone cell)', S(filled.ranges) === S(['A30', 'C30:K30']), filled.ranges);
t('reports the preserved column', S(filled.preservedCols) === S([1]), filled.preservedCols);
const r0 = filled.requests[0].repeatCell.range;
t('row index is 0-based half-open', r0.startRowIndex === 29 && r0.endRowIndex === 30, [r0.startRowIndex, r0.endRowIndex]);
t('column index is 0-based half-open', r0.startColumnIndex === 0 && r0.endColumnIndex === 1, [r0.startColumnIndex, r0.endColumnIndex]);
t('uses the numeric sheetId', r0.sheetId === 12345, r0.sheetId);
t('touches ONLY the background field', filled.requests[0].repeatCell.fields === BACKGROUND_FIELD, filled.requests[0].repeatCell.fields);
t('sets the agreed colour', S(filled.requests[0].repeatCell.cell.userEnteredFormat.backgroundColor) === S(UNASSIGNED_ROW_FILL));
t('#FCE5CD round-trips to the float triple', (() => {
  const b = filled.requests[0].repeatCell.cell.userEnteredFormat.backgroundColor;
  const hex = [b.red, b.green, b.blue].map((v) => Math.round(v * 255).toString(16).padStart(2, '0')).join('');
  return `#${hex}`.toUpperCase() === UNASSIGNED_ROW_FILL_HEX;
})(), UNASSIGNED_ROW_FILL_HEX);
// Stronger than "B30 is not in the list": no emitted request may COVER column 1.
t('no request covers the company column', filled.requests.every((r) => {
  const g = r.repeatCell.range;
  return !(g.startColumnIndex <= 1 && g.endColumnIndex > 1);
}), filled.requests.map((r) => [r.repeatCell.range.startColumnIndex, r.repeatCell.range.endColumnIndex]));

const cleared = planRowHighlightRequests({ ...base, mode: 'clear' });
t('clear produces the same two ranges', S(cleared.ranges) === S(filled.ranges), cleared.ranges);
t('clear sets backgroundColor to null (documented unset)', cleared.requests[0].repeatCell.cell.userEnteredFormat.backgroundColor === null, cleared.requests[0].repeatCell.cell.userEnteredFormat);
t('clear still only touches the background field', cleared.requests[0].repeatCell.fields === BACKGROUND_FIELD);

console.log('\n=== 4. planRowHighlightRequests refuses bad input rather than guessing ===');
t('a non-numeric sheetId is refused', planRowHighlightRequests({ ...base, sheetId: 'abc' }).requests.length === 0);
t('a negative sheetId is refused', planRowHighlightRequests({ ...base, sheetId: -1 }).requests.length === 0);
t('row 0 is refused (rows are 1-based)', planRowHighlightRequests({ ...base, rowNumber: 0 }).requests.length === 0);
t('a fractional row is refused', planRowHighlightRequests({ ...base, rowNumber: 2.5 }).requests.length === 0);
t('an unknown mode is refused', planRowHighlightRequests({ ...base, mode: 'delete' }).requests.length === 0);
t('nothing to paint -> no requests', planRowHighlightRequests({ ...base, preserveCols: [0,1,2,3,4,5,6,7,8,9,10] }).requests.length === 0);
t('no arguments at all -> no requests, no throw', planRowHighlightRequests().requests.length === 0);

console.log('\n=== 5. planBatchRowHighlight: one flat list, no duplicate work ===');
const batch = planBatchRowHighlight({ sheetId: 7, tabName: 'Taion', rows: [30, 31, 32], firstCol: 0, lastCol: 10, preserveCols: [1], mode: 'fill' });
t('three rows -> six requests', batch.requests.length === 6, batch.requests.length);
t('ranges are labelled with the tab', batch.ranges.every((x) => x.startsWith('Taion!')), batch.ranges.slice(0, 2));
t('rowCount counts the rows', batch.rowCount === 3, batch.rowCount);
// No preserved column means the whole row is ONE request, however wide it is.
t('duplicate rows are planned once', planBatchRowHighlight({ sheetId: 7, tabName: 'T', rows: [5, 5, 5], firstCol: 0, lastCol: 3 }).requests.length === 1, planBatchRowHighlight({ sheetId: 7, tabName: 'T', rows: [5, 5, 5], firstCol: 0, lastCol: 3 }).requests.length);
t('a wide row with nothing preserved is still one request', planBatchRowHighlight({ sheetId: 7, tabName: 'T', rows: [5], firstCol: 0, lastCol: 40 }).requests.length === 1);
t('unsorted rows still work', planBatchRowHighlight({ sheetId: 7, tabName: 'T', rows: [9, 2], firstCol: 0, lastCol: 1 }).rowCount === 2);
t('invalid rows are skipped, valid ones kept', planBatchRowHighlight({ sheetId: 7, tabName: 'T', rows: [0, -1, 3, 1.5, 4], firstCol: 0, lastCol: 1 }).rowCount === 2);
t('no rows -> no requests', planBatchRowHighlight({ sheetId: 7, tabName: 'T', rows: [], firstCol: 0, lastCol: 3 }).requests.length === 0);
t('preserved column reported once', S(batch.preservedCols) === S([1]), batch.preservedCols);

console.log('\n=== 6. highlightModeForMarker: the marker is the only truth ===');
t('"Unassigned" -> fill', highlightModeForMarker('Unassigned') === 'fill');
t('"Assigned" -> clear', highlightModeForMarker('Assigned') === 'clear');
t('casing and padding are tolerated', highlightModeForMarker('  unassigned  ') === 'fill' && highlightModeForMarker('ASSIGNED') === 'clear');
t('an unrecognised value is left alone, not guessed', highlightModeForMarker('maybe') === 'none');
t('blank is left alone', highlightModeForMarker('') === 'none' && highlightModeForMarker(null) === 'none' && highlightModeForMarker(undefined) === 'none');
t('a near-miss is NOT treated as unassigned', highlightModeForMarker('Unassigned ') === 'fill' && highlightModeForMarker('Unassign') === 'none');

console.log(`\n${pass} passed, ${fail} failed`);
console.log('OFFLINE. Nothing written, no network calls.');
process.exit(fail ? 1 : 0);
