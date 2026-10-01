/**
 * dry-run-row-highlight.mjs — READ-ONLY. dryRun is true for every call.
 *
 * Shows exactly what the row tint would change across all 8 Daily Review tabs:
 * which rows would be painted, which would be un-painted, which are already
 * correct, and — the part that matters most — which columns are being protected
 * and why.
 *
 * Writes nothing. Run with APPLY=1 to perform it, which is deliberately a
 * separate, explicit step rather than a flag flip in the same breath as the
 * preview.
 */
import { listTabMeta } from '../src/sheets.js';
import { getDailyReviewSheetId, syncTabRowHighlights } from '../src/userTabWriteBack.js';
import { UNASSIGNED_ROW_FILL_HEX } from '../src/rowHighlight.js';

const APPLY = process.env.APPLY === '1';
const { id: sheetId, headerRow } = getDailyReviewSheetId();

console.log(`spreadsheet : ${sheetId}`);
console.log(`header row  : ${headerRow}`);
console.log(`fill        : ${UNASSIGNED_ROW_FILL_HEX}`);
console.log(`mode        : ${APPLY ? 'APPLY (writes!)' : 'DRY RUN (writes nothing)'}`);

// listTabMeta returns objects ({ title, ... }), not bare names.
const tabs = (await listTabMeta(sheetId) || []).map((t) => (typeof t === 'string' ? t : t.title));
console.log(`\ntabs found : ${tabs.length}  (${tabs.join(', ')})\n`);

const totals = { fill: 0, clear: 0, already: 0, unknown: 0, requests: 0, errors: 0, conflicts: 0, foreign: 0 };

for (const tabName of tabs) {
  const r = await syncTabRowHighlights({ tabName, sheetId, headerRow, dryRun: !APPLY });
  const tag = r.action === 'error' ? 'ERROR' : r.action;

  console.log('='.repeat(80));
  console.log(`${tabName}   -> ${tag}`);
  console.log('='.repeat(80));

  if (r.reason) console.log(`  reason: ${r.reason}${r.error ? ` (${r.error})` : ''}`);
  if (r.markerColumn != null) console.log(`  marker column : ${r.markerColumn}`);
  if (r.preserveCols?.length) {
    console.log(`  PROTECTED cols: ${r.preserveCols.join(', ')}  (via ${r.accountColVia}) — company/account colour left intact`);
  } else {
    console.log(`  PROTECTED cols: none — this tab has no account column`);
  }
  if (r.width != null) console.log(`  tab width     : ${r.width} columns`);

  const list = (a) => (a.length ? a.join(', ') : '(none)');
  console.log(`  would PAINT   : rows ${list(r.fillRows || [])}`);
  console.log(`  would CLEAR   : rows ${list(r.clearRows || [])}`);
  console.log(`  already ok    : ${r.alreadyCorrect ?? 0} row(s)`);
  if (r.conflictRows?.length) {
    console.log(`  CONFLICT      : rows ${r.conflictRows.map((x) => `${x.rowNumber} (${x.cells.join(' ')})`).join(', ')}`);
    console.log(`                  unassigned, but a paintable cell already has a colour we did not put`);
    console.log(`                  there. Left alone — painting would destroy it for good.`);
  }
  if (r.distinctFillRows?.length) {
    console.log(`  NOT OURS      : rows ${r.distinctFillRows.map((x) => `${x.rowNumber} (${x.cells.join(' ')})`).join(', ')}`);
    console.log(`                  marked Assigned but carrying a foreign fill (e.g. row banding). Not cleared.`);
  }
  if (r.unknownMarkerRows?.length) {
    console.log(`  UNKNOWN marker: ${r.unknownMarkerRows.map((x) => `row ${x.rowNumber}="${x.marker}"`).join(', ')}  <- left alone, not guessed`);
    totals.unknown += r.unknownMarkerRows.length;
  }
  if (r.planned) console.log(`  API requests  : ${r.planned.fill} fill + ${r.planned.clear} clear = ${r.planned.fill + r.planned.clear}`);

  if (r.applied) {
    for (const a of r.applied) console.log(`  APPLIED ${a.mode}: ${a.action}${a.error ? ` — ${a.error}` : ''}`);
  }

  if (r.action === 'error') totals.errors++;
  totals.fill += r.fillRows?.length || 0;
  totals.clear += r.clearRows?.length || 0;
  totals.already += r.alreadyCorrect || 0;
  totals.requests += r.planned ? r.planned.fill + r.planned.clear : 0;
  totals.conflicts += r.conflictRows?.length || 0;
  totals.foreign += r.distinctFillRows?.length || 0;
  console.log('');
}

console.log('='.repeat(80));
console.log('SUMMARY');
console.log('='.repeat(80));
console.log(`  rows to PAINT : ${totals.fill}`);
console.log(`  rows to CLEAR : ${totals.clear}`);
console.log(`  already ok    : ${totals.already}`);
console.log(`  unknown marker: ${totals.unknown}`);
console.log(`  conflicts     : ${totals.conflicts}  (unassigned, foreign fill present, left alone)`);
console.log(`  foreign fills : ${totals.foreign}  (assigned, foreign fill present, not cleared)`);
console.log(`  API requests  : ${totals.requests}  (one batchUpdate per tab, not per cell)`);
console.log(`  tab errors    : ${totals.errors}`);

if (!APPLY) {
  console.log(`\nDRY RUN ONLY — nothing was written. Re-run with APPLY=1 to perform it.`);
} else {
  console.log(`\nAPPLIED. Re-read the tabs to confirm the fills landed and the company`);
  console.log(`cells kept their colour (a request being accepted is not the same claim).`);
}
