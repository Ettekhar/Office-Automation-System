/**
 * rowHighlight.js — plan a row background fill. PURE, no side effects.
 *
 * WHAT THIS IS FOR
 * ----------------
 * Unassigning a person used to write the word "Unassigned" into one cell and
 * stop there. The row then looks identical to an active row apart from a single
 * word, which is easy to miss when scrolling a 30-row tab. The request is to
 * colour the whole row so an unassigned row is visible at a glance.
 *
 * WHY THIS IS A SEPARATE MODULE
 * -----------------------------
 * Every function here is pure: it turns a row number and a column span into
 * Sheets `repeatCell` requests. Nothing reads, writes or calls out. That is what
 * lets the dry run and the real write share ONE implementation, so a preview
 * cannot drift from what actually happens — the same rule that governs
 * `proposeFieldFills` and `normalizeMaintenanceStatusText`.
 *
 * THE COLOUR IS DERIVED STATE, NOT TRUTH
 * --------------------------------------
 * The assignment marker cell ("Assigned" / "Unassigned") is the truth. This
 * module only renders that truth, which implies three rules the code below
 * exists to enforce:
 *
 *   1. A row is coloured because its marker says "Unassigned" — never the other
 *      way round. Colour alone would be unreadable and un-auditable.
 *   2. Re-assigning must CLEAR the fill. Otherwise a site that comes back to
 *      the team stays orange forever while being actively worked.
 *   3. Painting a row must not destroy meaning that is already in that row.
 *      Measured 2026-09-26: the account/company cell carries a company colour
 *      (#8e7cc3, #b4a7d6, #93c47d) that identifies which account the site is
 *      under. A literal whole-row fill erases it. So the company column is
 *      preserved and the paint is emitted as two ranges either side of it.
 *
 * COLOUR CHOICE (asked, not assumed)
 * ----------------------------------
 * #FCE5CD, a light orange. The tabs already use blue structurally — #3c78d8 is
 * the header fill and #cfe2f3 is row banding (288 cells in Toufiq, 1593 in
 * Asif) — so a blue row would read as part of the sheet's chrome rather than as
 * a flag. The existing reds (#f44834, #ea4335) are vivid and appear on other
 * columns; a soft orange tint is distinguishable from them and is light enough
 * to keep the row's black text readable.
 */

import { colIndexToA1 } from './sheets.js';

/** #FCE5CD as the 0..1 floats the Sheets API wants. */
export const UNASSIGNED_ROW_FILL = Object.freeze({
  red: 252 / 255,
  green: 229 / 255,
  blue: 205 / 255,
});

/** Human-readable form of UNASSIGNED_ROW_FILL, for dry-run output. */
export const UNASSIGNED_ROW_FILL_HEX = '#FCE5CD';

/** The only field this module ever touches. Deliberately narrow. */
export const BACKGROUND_FIELD = 'userEnteredFormat.backgroundColor';

const toCol = (c) => (Number.isInteger(c) && c >= 0 ? c : null);

/**
 * Split one row's column span into the runs that should actually be painted,
 * skipping the preserved columns.
 *
 * Pure. Returns [] when the span is empty or every column is preserved, which
 * is the honest answer: there is nothing to paint.
 *
 * @param {object}  o
 * @param {number}  o.firstCol       inclusive, 0-based
 * @param {number}  o.lastCol        inclusive, 0-based
 * @param {number[]} [o.preserveCols] 0-based columns to leave alone
 * @returns {{startCol:number,endCol:number}[]}
 */
export function buildRowSegments({ firstCol, lastCol, preserveCols = [] } = {}) {
  const first = toCol(firstCol);
  const last = toCol(lastCol);
  if (first === null || last === null || last < first) return [];

  // Clamp into the span and drop anything out of range, so a stale column index
  // from another tab cannot silently protect the wrong cell.
  const skip = new Set(
    (Array.isArray(preserveCols) ? preserveCols : [])
      .map(toCol)
      .filter((c) => c !== null && c >= first && c <= last),
  );

  const segments = [];
  let runStart = null;
  for (let c = first; c <= last + 1; c++) {
    const inRun = c <= last && !skip.has(c);
    if (inRun && runStart === null) runStart = c;
    else if (!inRun && runStart !== null) {
      segments.push({ startCol: runStart, endCol: c - 1 });
      runStart = null;
    }
  }
  return segments;
}

/**
 * A1 range for one horizontal run on one row, e.g. "C30:K30".
 * Exported for the dry run so its output can be read by a human.
 */
export function segmentRange(rowNumber, startCol, endCol) {
  if (startCol === endCol) return `${colIndexToA1(startCol)}${rowNumber}`;
  return `${colIndexToA1(startCol)}${rowNumber}:${colIndexToA1(endCol)}${rowNumber}`;
}

/**
 * Build the `repeatCell` requests to fill (or clear) one row's background.
 *
 * `sheetId` must be the NUMERIC tab id from spreadsheets.get
 * (sheets[].properties.sheetId) — not the spreadsheet id and not the tab name.
 * Passing the wrong one is the classic way this silently no-ops.
 *
 * Clearing passes `backgroundColor: null`, which is the documented way to unset
 * a single format field while leaving the rest of the cell format alone. The
 * verify script re-reads the cells afterwards, because "the request was
 * accepted" is not the same claim as "the fill is gone".
 *
 * @returns {{requests: object[], ranges: string[], preservedCols: number[]}}
 */
export function planRowHighlightRequests({
  sheetId,
  rowNumber,
  firstCol,
  lastCol,
  preserveCols = [],
  mode = 'fill',
  fill = UNASSIGNED_ROW_FILL,
} = {}) {
  const empty = { requests: [], ranges: [], preservedCols: [] };
  if (!Number.isInteger(sheetId) || sheetId < 0) return empty;
  if (!Number.isInteger(rowNumber) || rowNumber < 1) return empty;
  if (mode !== 'fill' && mode !== 'clear') return empty;

  const segments = buildRowSegments({ firstCol, lastCol, preserveCols });
  if (!segments.length) return empty;

  const inSpan = new Set(
    (Array.isArray(preserveCols) ? preserveCols : []).map(toCol)
      .filter((c) => c !== null),
  );
  const preservedCols = [...inSpan].sort((a, b) => a - b);

  const cell = mode === 'clear'
    ? { userEnteredFormat: { backgroundColor: null } }
    : { userEnteredFormat: { backgroundColor: { ...fill } } };

  const requests = [];
  const ranges = [];
  for (const seg of segments) {
    requests.push({
      repeatCell: {
        range: {
          sheetId,
          startRowIndex: rowNumber - 1,
          endRowIndex: rowNumber,
          startColumnIndex: seg.startCol,
          endColumnIndex: seg.endCol + 1,
        },
        cell,
        fields: BACKGROUND_FIELD,
      },
    });
    ranges.push(segmentRange(rowNumber, seg.startCol, seg.endCol));
  }
  return { requests, ranges, preservedCols };
}

/**
 * Plan several rows in the same tab, producing ONE flat request list so the
 * whole thing ships in a single batchUpdate call.
 *
 * Rows are de-duplicated and sorted; a row listed twice is planned once, which
 * matters because a repair pass discovers rows by scanning and a site can appear
 * under two assignees.
 */
export function planBatchRowHighlight({
  sheetId,
  tabName = '',
  rows = [],
  firstCol = 0,
  lastCol,
  preserveCols = [],
  mode = 'fill',
  fill = UNASSIGNED_ROW_FILL,
} = {}) {
  const seen = new Set();
  const planned = [];
  const allRanges = [];
  const preserved = new Set();

  for (const rowNumber of rows) {
    if (!Number.isInteger(rowNumber) || rowNumber < 1) continue;
    if (seen.has(rowNumber)) continue;
    seen.add(rowNumber);
    const p = planRowHighlightRequests({
      sheetId, rowNumber, firstCol, lastCol, preserveCols, mode, fill,
    });
    if (!p.requests.length) continue;
    planned.push(...p.requests);
    p.ranges.forEach((r) => allRanges.push(`${tabName}!${r}`));
    p.preservedCols.forEach((c) => preserved.add(c));
  }

  return {
    requests: planned,
    ranges: allRanges,
    preservedCols: [...preserved].sort((a, b) => a - b),
    rowCount: seen.size,
  };
}

/**
 * Decide what a row's background should be, from the marker cell alone.
 *
 * The single place the marker vocabulary meets the colour, so the two cannot
 * disagree. Unknown marker values are treated as "do not touch" rather than
 * guessed — an unrecognised value is a question for a human, not a licence to
 * paint or un-paint a row.
 *
 * @returns {'fill'|'clear'|'none'}
 */
export function highlightModeForMarker(markerValue) {
  const v = String(markerValue ?? '').trim().toLowerCase();
  if (v === 'unassigned') return 'fill';
  if (v === 'assigned') return 'clear';
  return 'none';
}
