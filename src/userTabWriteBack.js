/**
 * userTabWriteBack.js — DB→Sheets write-back for per-user Daily Review tabs.
 *
 * PROBLEM THIS SOLVES
 * Assigning a website to a user writes to the DB (source of truth) but never
 * appends a row to that person's tab in the Daily Review sheet. The reconcile
 * pass then can't find the site and logs:
 *     [batch-sync] "<site>" not found in <User> tab — skipping
 * so the site is invisible in the tab and its Maintenance status can never
 * sync back.
 *
 * WHAT THIS DOES
 * On assignment, ensure the site has a row in the assignee's tab:
 *   - Resolve the assignee through the canonical user resolver (never fabricate).
 *   - Resolve the tab's URL column through columnMap.resolveUserTabUrlColumn —
 *     the ONE canonical resolver, shared with the reconcile path. Header text in
 *     this workbook is misleading (see columnMap.js for the verified evidence),
 *     so a name-only match would write websites into the wrong column.
 *   - Idempotent: if the normalized URL already has a row, do nothing.
 *   - Otherwise append one row: URL in the resolved column, checklist columns
 *     left blank/ready.
 *   - Return the appended row number so the caller persists rowIndex + provenance
 *     and the next reconcile hits the fast path.
 *
 * SAFETY (matches the DB-first architecture)
 *   - DB is the source of truth; the sheet is a connected interface.
 *   - Append-only: never rewrites or deletes an existing row.
 *   - Unassign = SOFT-remove: marks the row when a marker column exists; never
 *     deletes. With no marker column it reports so the caller flags a conflict
 *     rather than deleting or silently doing nothing.
 *   - dryRun performs every read/decision but ZERO writes and reports exactly
 *     what would change.
 *   - Never throws into the assign path: returns a result object so the caller
 *     can audit/flag while the DB assignment still stands.
 */

import * as db from './db.js';
import {
  getTabValues, appendSheetRow, updateSheetCell, listTabMeta, colIndexToA1,
  dailyReviewMaintenanceCellValue, dailyReviewReportSentCellValue,
  getTabSheetId, applyRowBackgrounds, getRangeBackgroundColors,
} from './sheets.js';
import { resolveUserTabUrlColumn, resolveUserTabAccountColumn, resolveUserTabDataColumns, getUserTabFallbackUrlColumn } from './columnMap.js';
import {
  planRowHighlightRequests, planBatchRowHighlight, highlightModeForMarker,
  buildRowSegments, UNASSIGNED_ROW_FILL, UNASSIGNED_ROW_FILL_HEX,
} from './rowHighlight.js';

// ── URL normalization ───────────────────────────────────────────────────────
// Mirrors the normalization used by sheets.js reconcile so "already present"
// detection compares like with like.
export const normalizeSiteUrl = (u) => (u == null ? '' : String(u))
  .toLowerCase()
  .replace(/^https?:\/\//, '')
  .replace(/^www\./, '')
  .replace(/\/+$/, '')
  .trim();

// Tab titles rarely change; cache briefly so a bulk assign doesn't re-list tabs
// once per user. Keyed by spreadsheet id.
const TAB_TITLE_TTL_MS = 5 * 60 * 1000;
const tabTitleCache = new Map();

/** Canonical daily-review sheet id from the sheet-manager credential. No hardcoded fallback. */
export function getDailyReviewSheetId() {
  const creds = db.getSheetCredentials() || [];
  const item = creds.find((c) => c.key === 'DAILY_REVIEW' || c.id === 'daily-review');
  if (!item || !item.spreadsheetId) {
    throw new Error('DAILY_REVIEW sheet credential is not configured in the sheet manager');
  }
  return { id: item.spreadsheetId, headerRow: Number(item.headerRow || 1) };
}

/** Per-tab URL column from the sheet-manager credential, if one was configured. */
function getCredentialUrlColumnOverride(tabName) {
  try {
    const creds = db.getSheetCredentials() || [];
    const item = creds.find((c) => c.key === 'DAILY_REVIEW' || c.id === 'daily-review');
    const map = item?.tabColumnOverrides;
    if (!map || typeof map !== 'object') return null;
    const hit = map[tabName] ?? map[String(tabName).toLowerCase()];
    if (hit == null) return null;
    const idx = typeof hit === 'object' ? hit.urlColumn ?? hit.websiteUrl : hit;
    return Number.isInteger(idx) && idx >= 0 ? idx : null;
  } catch {
    return null;
  }
}

/**
 * Resolve which tab a raw name refers to, WITHOUT fabricating.
 * Uses db.resolveUserByName (alias → token → null) and matches the canonical
 * user name against the actual tab titles (case-insensitive).
 *
 * Distinguishes "no such person" from "person exists but is deactivated": both
 * skip the write, but they are different operational problems and the audit
 * trail / conflict must say which one happened. (In the live DB, Toufiq,
 * Tarikul and Asif are active:false, so their tabs are skipped by design —
 * matching the existing reconcile behavior.)
 *
 * Returns { user, tabName, matchedBy } or { user: null, reason }.
 */
export async function resolveUserTab(rawName) {
  const resolved = db.resolveUserByName(rawName);
  if (!resolved || !resolved.user) {
    // Did they resolve to nobody because the person is deactivated?
    let deactivated = null;
    try {
      const compact = String(rawName || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
      deactivated = (db.getUsers() || []).find(
        (u) => u.active === false && String(u.name || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '') === compact
      ) || null;
    } catch { /* identity check is best-effort; never fabricate */ }
    return { user: null, reason: deactivated ? 'inactive-user' : 'unresolved-user', userName: deactivated?.name || null };
  }
  const user = resolved.user;
  if (user.active === false) return { user, reason: 'inactive-user' };

  const { id } = getDailyReviewSheetId();
  const cached = tabTitleCache.get(id);
  let titles;
  if (cached && Date.now() - cached.at < TAB_TITLE_TTL_MS) {
    titles = cached.titles;
  } else {
    try {
      const meta = await listTabMeta(id);
      titles = (Array.isArray(meta) ? meta : [])
        .map((t) => t?.properties?.title || t?.title)
        .filter(Boolean);
      tabTitleCache.set(id, { titles, at: Date.now() });
    } catch (e) {
      return { user, reason: 'tab-list-failed', error: e.message };
    }
  }

  const lower = (user.name || '').toLowerCase();
  const tabName = titles.find((t) => t.toLowerCase() === lower);
  if (!tabName) return { user, reason: 'tab-not-found' };
  return { user, tabName, matchedBy: resolved.matchedBy };
}

/**
 * Read a user tab once and resolve its URL column canonically.
 * `rows` excludes the header row.
 * Returns { ok, header, rows, col, via, width } or { ok: false, reason, error }.
 */
export async function readAndResolveTab(tabName, sheetId, headerRow) {
  let values;
  try {
    values = (await getTabValues(tabName, `A${headerRow}:ZZ2000`, sheetId)) || [];
  } catch (e) {
    return { ok: false, reason: 'tab-read-failed', error: e.message };
  }
  const header = (values[0] || []).map((h) => (h == null ? '' : h));
  const rows = values.slice(1);

  const resolution = resolveUserTabUrlColumn({
    headers: header,
    rows,
    override: getCredentialUrlColumnOverride(tabName),
    fallbackIndex: getUserTabFallbackUrlColumn(tabName),
  });
  if (resolution.col == null) {
    return { ok: false, reason: 'url-column-unresolved', via: resolution.via, header };
  }

  const width = Math.max(
    header.length,
    ...rows.map((r) => (Array.isArray(r) ? r.length : 0)),
    resolution.col + 1
  );
  return {
    ok: true,
    header,
    rows,
    width,
    col: resolution.col,
    via: resolution.via,
    domainCount: resolution.domainCount,
    margin: resolution.margin,
  };
}

// ── Assignment marker column ─────────────────────────────────────────────────
// Unassign is a SOFT remove: the row and its URL/provenance stay, and the
// marker column records that the assignment ended. The marker vocabulary is
// deliberately narrow — bare "status" is NOT accepted, because a generic status
// column in these tabs holds unrelated values and writing "Unassigned" into it
// would corrupt someone else's data.
export const ASSIGNMENT_MARKER_HEADERS = ['assignment', 'assigned', 'assignment status'];
export const ASSIGNMENT_MARKER_LABEL = 'Assignment';
export const ASSIGNMENT_MARKER_ON_ASSIGN = 'Assigned';
export const ASSIGNMENT_MARKER_ON_UNASSIGN = 'Unassigned';

/**
 * Locate the assignment marker column in a tab's header row.
 * Exact (case-insensitive, trimmed) match only — never a fuzzy/substring match.
 * @returns {number} 0-based column index, or -1 when the tab has no marker.
 */
export function findAssignmentMarkerColumn(header = []) {
  const norm = (header || []).map((h) => String(h ?? '').trim().toLowerCase());
  for (const name of ASSIGNMENT_MARKER_HEADERS) {
    const i = norm.indexOf(name);
    if (i !== -1) return i;
  }
  return -1;
}

// ── Row background highlight ─────────────────────────────────────────────────
// The unassigned row is tinted so it is visible at a glance, instead of looking
// identical to an active row apart from one word in one cell. The marker cell
// stays the truth; the colour only renders it. See rowHighlight.js for the
// colour choice and the reasoning.

/**
 * Work out which columns a row highlight may touch in this tab.
 *
 * The account/company column is preserved, because its fill is a company colour
 * that identifies which account the site sits under (measured 2026-09-26:
 * #8e7cc3 / #b4a7d6 / #93c47d on the "CW" cell). Painting over it destroys
 * information that is not ours to destroy. The canonical resolver is reused
 * rather than a private header list, so the preserved column is the same column
 * the writer stamps the account into.
 */
function rowHighlightColumns({ tab, markerCol, mode }) {
  const firstCol = 0;
  const lastCol = Math.max(0, (tab?.width ?? 1) - 1);
  const accountRes = resolveUserTabAccountColumn({
    headers: tab?.header || [], rows: tab?.rows || [], urlCol: tab?.col ?? -1,
  });
  const accountCol = Number.isInteger(accountRes?.col) ? accountRes.col : -1;
  const preserveCols = accountCol >= 0 ? [accountCol] : [];
  return {
    firstCol,
    lastCol,
    preserveCols,
    accountCol,
    accountColVia: accountRes?.via || 'unresolved',
    markerCol,
    mode,
  };
}

/**
 * Apply (or clear) the background for specific rows of a tab.
 *
 * Returns a result object and never throws, matching the rest of this module's
 * contract: a colour that fails to apply must be reported to the caller so it
 * can be audited, not swallowed — and it must never take down the assignment
 * that triggered it.
 */
async function applyRowHighlights({ sheetId, tabName, tab, rowNumbers, mode, dryRun }) {
  const cols = rowHighlightColumns({ tab, mode });
  const result = { mode, dryRun: !!dryRun, fillHex: mode === 'fill' ? UNASSIGNED_ROW_FILL_HEX : null, ...cols };

  if (mode !== 'fill' && mode !== 'clear') return { ...result, action: 'skip', reason: 'unknown-mode' };
  if (!rowNumbers || !rowNumbers.length) return { ...result, action: 'skip', reason: 'no-rows' };
  if (dryRun) {
    const preview = planBatchRowHighlight({
      sheetId: 0, tabName, rows: rowNumbers,
      firstCol: cols.firstCol, lastCol: cols.lastCol,
      preserveCols: cols.preserveCols, mode,
    });
    return {
      ...result,
      action: mode === 'fill' ? 'would-highlight' : 'would-clear-highlight',
      rowCount: rowNumbers.length,
      ranges: preview.ranges,
      // A preview needs a shape, not a real request, so sheetId 0 is used above
      // and the request count is reported instead of the requests themselves.
      requestCount: preview.requests.length,
    };
  }

  let numericSheetId;
  try {
    numericSheetId = await getTabSheetId(sheetId, tabName);
  } catch (e) {
    return { ...result, action: 'error', reason: 'tab-sheet-id-failed', error: e.message };
  }
  if (!Number.isInteger(numericSheetId)) {
    return { ...result, action: 'error', reason: 'tab-not-found' };
  }

  const planned = planBatchRowHighlight({
    sheetId: numericSheetId, tabName, rows: rowNumbers,
    firstCol: cols.firstCol, lastCol: cols.lastCol,
    preserveCols: cols.preserveCols, mode,
  });
  if (!planned.requests.length) {
    return { ...result, action: 'skip', reason: 'nothing-to-paint', ranges: planned.ranges };
  }

  try {
    const applied = await applyRowBackgrounds(sheetId, planned.requests);
    return {
      ...result,
      action: mode === 'fill' ? 'highlighted' : 'highlight-cleared',
      numericSheetId,
      ranges: planned.ranges,
      requestCount: planned.requests.length,
      applied: applied.applied,
    };
  } catch (e) {
    return { ...result, action: 'error', reason: 'background-write-failed', error: e.message };
  }
}

/** Last 0-based column index holding ANY value in ANY row of `values`. */
function lastUsedColumnIndex(values) {
  let last = -1;
  for (const r of values || []) {
    if (!Array.isArray(r)) continue;
    for (let c = r.length - 1; c > last; c--) {
      const v = r[c];
      if (v !== undefined && v !== null && String(v).trim() !== '') { last = c; break; }
    }
  }
  return last;
}

/**
 * ensureAssignmentMarkerColumn — add the "Assignment" header to a tab if absent.
 *
 * WHY THIS EXISTS INSTEAD OF sheets.appendSheetColumn():
 * appendSheetColumn() writes at index `headers.length`, but the Sheets API
 * trims trailing empty header cells. On a tab whose data extends past its last
 * header, `headers.length` lands on a column that ALREADY HOLDS DATA and the
 * header write silently destroys it. Verified live (2026-09-25):
 *   Taion — col 9 holds "Plugings update option not found", "Ga4 Access needed"
 *   Asif  — col 3 holds 18 real booking/reservation URLs, no header
 * So the first safe column is the first column empty across the header AND
 * every data row, which is what this computes.
 *
 * @param {object} opts
 * @param {string} opts.tabName
 * @param {string} opts.sheetId
 * @param {number} [opts.headerRow]
 * @param {boolean} [opts.dryRun] report the planned cell; write nothing
 * @returns {Promise<object>} never throws; `{ ok, action, col, cell, ... }`
 */
export async function ensureAssignmentMarkerColumn({ tabName, sheetId, headerRow = 1, dryRun = false }) {
  const out = { ok: false, action: 'noop', tabName, headerRow, dryRun: !!dryRun };
  let values;
  try {
    values = (await getTabValues(tabName, `A${headerRow}:ZZ2000`, sheetId)) || [];
  } catch (e) {
    return { ...out, action: 'error', reason: 'tab-read-failed', error: e.message };
  }
  const header = (values[0] || []).map((h) => (h == null ? '' : h));

  const existing = findAssignmentMarkerColumn(header);
  if (existing !== -1) {
    return { ...out, ok: true, action: 'already-present', col: existing, headerName: String(header[existing]) };
  }

  const lastUsed = lastUsedColumnIndex(values);
  const target = lastUsed + 1;
  const cell = `${colIndexToA1(target)}${headerRow}`;
  const info = { col: target, cell, headerName: ASSIGNMENT_MARKER_LABEL, lastUsedCol: lastUsed };
  if (dryRun) return { ...out, ok: true, action: 'would-add', ...info };

  try {
    await updateSheetCell(sheetId, tabName, cell, ASSIGNMENT_MARKER_LABEL);
    return { ...out, ok: true, action: 'added', ...info };
  } catch (e) {
    return { ...out, action: 'error', reason: 'marker-header-write-failed', error: e.message, ...info };
  }
}

/**
 * Build the canonical field→value map for a Daily Review row from the DB.
 *
 * The DB is the source of truth, so every value here is something the database
 * already holds for this (site, user) pair — the site record plus the daily
 * review record created at assignment time. A field with no data is left as an
 * empty string so the writer never invents a placeholder ("N/A", a guess) into
 * the sheet. Raw sheet text (maintenanceRaw/reportSentRaw) is preferred over
 * the normalized status, matching how the pre-existing rows read.
 */
function buildFieldValues({ site = {}, dr = {} } = {}) {
  const pick = (...vals) => {
    for (const v of vals) {
      const s = String(v ?? '').trim();
      if (s) return s;
    }
    return '';
  };
  return {
    company: pick(dr.company, site.company),
    contact: pick(dr.contact, site.contact),
    accountManager: pick(dr.accountManager, site.accountManager),
    // Status columns go through the SAME mappers the batch Daily Review writer
    // uses, so a new row and a synced row speak one vocabulary. Without this the
    // DB enum would land verbatim ("todo", "pending") among human text
    // ("To Do", "No") and quietly corrupt the column.
    maintenance: pick(dailyReviewMaintenanceCellValue(dr)),
    reportSent: pick(dailyReviewReportSentCellValue(dr)),
    clickup: pick(dr.clickupLink, site.clickupUrl),
    ga4: pick(dr.ga4),
    newsletter: pick(dr.newsletterMail),
    formSubmission: pick(dr.formSubmissionMail),
    clientResponse: pick(dr.clientResponse),
    booking: pick(dr.bookingLink),
    uptime: pick(dr.uptimeRobot),
    cloudflare: pick(dr.cloudflare),
    formName: pick(dr.formName), // usually empty; only written if the tab has the column
  };
}

/**
 * proposeFieldFills — the fill decision on its own, with no row assembly and
 * no I/O. Exported so a dry-run preview computes EXACTLY what a real write
 * would put in each column, instead of re-implementing the mapping and drifting
 * from it. Pure: same inputs, same list of { field, col, header, value }.
 */
export function proposeFieldFills({
  header = [], rows = [], urlCol = -1, accountCol = -1, markerCol = -1,
  site = null, dr = null,
} = {}) {
  const dataRes = resolveUserTabDataColumns({ headers: header, rows, urlCol, accountCol });
  const fieldValues = buildFieldValues({ site: site || {}, dr: dr || {} });
  const filled = [];
  for (const [field, idx] of Object.entries(dataRes.columns)) {
    if (!Number.isInteger(idx) || idx < 0) continue;
    // Never touch the URL, account or marker columns, and never write a column
    // whose header we didn't recognize — a missing field simply stays blank.
    if (idx === urlCol || idx === markerCol || idx === accountCol) continue;
    const val = String(fieldValues[field] ?? '').trim();
    if (!val) continue;
    filled.push({ field, col: idx, header: String(header?.[idx] ?? '').trim(), value: val });
  }
  return { filled, dataColumns: dataRes.columns };
}

/**
 * Build the row to append: URL in the resolved column, the "Assigned" marker
 * when the tab has one, the account label the DB already knows, and EVERY
 * recognized data column that has a real value from the DB. A row we append is
 * a row we KNOW is assigned, so the marker is a fact; the checklist cells are
 * filled only from actual DB data and left blank when the DB has nothing — the
 * sheet never gets an invented placeholder. Pre-existing rows are never touched.
 */
function buildAppendRow({
  width, header = [], rows = [], col, siteUrl, markerCol = -1, accountCol = -1,
  account = '', site = null, dr = null,
}) {
  const { filled, dataColumns } = proposeFieldFills({
    header, rows, urlCol: col, accountCol, markerCol, site, dr,
  });
  const dataMax = Object.values(dataColumns).reduce(
    (m, c) => (Number.isInteger(c) && c + 1 > m ? c + 1 : m), 0
  );
  const row = new Array(Math.max(width, col + 1, markerCol + 1, accountCol + 1, dataMax)).fill('');
  row[col] = siteUrl;
  if (markerCol !== -1) row[markerCol] = ASSIGNMENT_MARKER_ON_ASSIGN;
  // The account label ("CW"/"RM") is a fact the DB already holds, so an appended
  // row carries it like every pre-existing row instead of a suspicious blank.
  if (accountCol !== -1 && account) row[accountCol] = String(account).trim();
  for (const f of filled) row[f.col] = f.value;
  return { row, filled };
}

/** Parse the 1-based row number out of a Sheets append response range. */
function parseAppendedRowNumber(updatedRange) {
  const m = String(updatedRange || '').match(/!\$?A\$?(\d+)/i);
  return m ? Number(m[1]) : null;
}

/**
 * ensureSiteRowInUserTab — idempotently ensure the site has a row in the tab.
 *
 * @param {object}  opts
 * @param {string}  opts.siteUrl
 * @param {string}  opts.userName       raw assignee name (alias-tolerant)
 * @param {string}  [opts.account]      account label the DB already knows ("CW"/"RM")
 * @param {object}  [opts.site]         the site record, used to fill known columns
 * @param {object}  [opts.dr]           the daily-review record for (site,user)
 * @param {boolean} [opts.dryRun]       true → no writes; reports planned action
 * @returns {Promise<object>}           never throws; failures carry `reason`/`error`
 */
export async function ensureSiteRowInUserTab({ siteUrl, userName, account = '', site = null, dr = null, dryRun = false }) {
  const result = { action: 'noop', dryRun: !!dryRun, siteUrl, userName };
  const clean = normalizeSiteUrl(siteUrl);
  if (!clean) return { ...result, action: 'skip', reason: 'empty-url' };

  // 1) Person → tab (never fabricate)
  let rt;
  try {
    rt = await resolveUserTab(userName);
  } catch (e) {
    return { ...result, action: 'error', reason: 'sheet-not-configured', error: e.message };
  }
  if (!rt.user || rt.reason) {
    return { ...result, action: rt.user ? 'skip' : 'skip', reason: rt.reason, error: rt.error };
  }
  const { id: sheetId, headerRow } = getDailyReviewSheetId();
  const tabName = rt.tabName;
  Object.assign(result, { tabName, matchedBy: rt.matchedBy, headerRow });

  // 2) Read the tab + resolve the URL column canonically
  const tab = await readAndResolveTab(tabName, sheetId, headerRow);
  if (!tab.ok) return { ...result, action: 'error', reason: tab.reason, via: tab.via, error: tab.error };
  Object.assign(result, { urlCol: tab.col, urlColVia: tab.via, domainCount: tab.domainCount, margin: tab.margin });

  // 3) Plan the row. A freshly appended row is known-assigned, so stamp the
  //    marker column when the tab has one (self-describing, no inference), and
  //    stamp the account label the DB already knows.
  //    This is computed BEFORE the idempotency check so a dry run can report the
  //    fill it WOULD perform even when the row already exists.
  const markerCol = findAssignmentMarkerColumn(tab.header);
  // resolveUserTabAccountColumn returns { col, via, labelHits } — col is null when
  // the tab has no account column (verified: Asif has none), so normalise to -1.
  const accountRes = resolveUserTabAccountColumn({ headers: tab.header, rows: tab.rows, urlCol: tab.col });
  const accountCol = Number.isInteger(accountRes?.col) ? accountRes.col : -1;
  if (accountCol === tab.col) {
    // Would overwrite the website — refuse rather than corrupt the row.
    return { ...result, action: 'error', reason: 'account-column-is-url-column' };
  }

  // Smart fill: resolve every OTHER recognized column in this tab by its header
  // and fill the ones the DB has real data for. Nothing is invented; unknown or
  // data-less columns are simply absent from `dataColumns` and stay blank.
  const { row: plannedRow, filled, dataColumns } = buildAppendRow({
    width: tab.width, header: tab.header, rows: tab.rows, col: tab.col, siteUrl,
    markerCol, accountCol, account, site, dr,
  });
  result.plannedRow = plannedRow;
  result.markerColumn = markerCol;
  result.accountColumn = accountCol;
  result.filledFields = filled;
  result.dataColumns = dataColumns;

  // 4) Idempotency: already present in the resolved column? Never write, and
  //    never touch the cells of a row somebody else owns — EXCEPT the assignment
  //    marker, when it still says "Unassigned".
  //
  //    A soft-remove keeps the row, so re-assigning the same site lands here.
  //    Before this, the marker was only ever written when a row was APPENDED, so
  //    a re-assigned site stayed marked "Unassigned" in the sheet forever while
  //    the DB listed it as actively assigned — the sheet contradicting the source
  //    of truth. That was a stale word in a cell; with the row tint added it
  //    would also have become a permanently orange row for a live assignment, so
  //    it is corrected here. Only that one cell is touched.
  for (let i = 0; i < tab.rows.length; i++) {
    const cell = (tab.rows[i] || [])[tab.col];
    if (normalizeSiteUrl(cell) !== clean) continue;
    const rowNumber = headerRow + 1 + i;
    const base = { ...result, action: 'exists', reason: 'already-present', rowNumber };

    if (markerCol === -1) return base;
    const currentMarker = String((tab.rows[i] || [])[markerCol] ?? '').trim();
    if (highlightModeForMarker(currentMarker) !== 'fill') return base;

    if (dryRun) {
      return {
        ...base,
        action: 'would-restore-marker',
        markerCell: `${colIndexToA1(markerCol)}${rowNumber}`,
        markerFrom: currentMarker,
        markerTo: ASSIGNMENT_MARKER_ON_ASSIGN,
        highlight: await applyRowHighlights({
          sheetId, tabName, tab, rowNumbers: [rowNumber], mode: 'clear', dryRun,
        }),
      };
    }

    try {
      await updateSheetCell(sheetId, tabName, `${colIndexToA1(markerCol)}${rowNumber}`, ASSIGNMENT_MARKER_ON_ASSIGN);
    } catch (e) {
      return { ...base, action: 'error', reason: 'marker-restore-failed', error: e.message };
    }
    const cleared = await applyRowHighlights({
      sheetId, tabName, tab, rowNumbers: [rowNumber], mode: 'clear', dryRun,
    });
    return {
      ...base,
      action: 'exists',
      reason: 'already-present-marker-restored',
      markerFrom: currentMarker,
      markerTo: ASSIGNMENT_MARKER_ON_ASSIGN,
      highlight: cleared,
    };
  }

  if (dryRun) return { ...result, action: 'would-append', reason: 'not-present' };

  // 5) Append (INSERT_ROWS never overwrites) and read back the real row number.
  try {
    const res = await appendSheetRow(sheetId, tabName, plannedRow);
    const range = res?.updates?.updatedRange || '';
    let rowNumber = parseAppendedRowNumber(range);
    if (rowNumber == null) {
      // Do NOT depend on the Sheets API response shape to learn where the row
      // landed. Measured live 2026-09-25: the append succeeded but the range
      // yielded no row number, so a FRESH assignment recorded no rowIndex and
      // reconcile could not take its fast path. Re-read the tab and locate the
      // row we just wrote — authoritative regardless of response shape.
      const verify = await readAndResolveTab(tabName, sheetId, headerRow);
      if (verify.ok) {
        for (let i = verify.rows.length - 1; i >= 0; i--) {
          if (normalizeSiteUrl((verify.rows[i] || [])[verify.col]) === clean) {
            rowNumber = headerRow + 1 + i;
            break;
          }
        }
      }
    }
    return { ...result, action: 'appended', rowNumber, updatedRange: range, rowNumberFrom: rowNumber != null && parseAppendedRowNumber(range) != null ? 'append-response' : 'tab-rescan' };
  } catch (e) {
    return { ...result, action: 'error', reason: 'append-failed', error: e.message };
  }
}

/**
 * softRemoveSiteRowFromUserTab — mark a row unassigned (SOFT remove).
 * Per the confirmed decision: do NOT delete the row, the URL, or any provenance.
 * If the tab exposes a marker column (Assignment/Assigned/Status) it is set to
 * "Unassigned"; otherwise the row is left untouched and the caller is told, so
 * it can flag a conflict instead of deleting data.
 *
 * @returns {Promise<object>} never throws
 */
export async function softRemoveSiteRowFromUserTab({ siteUrl, userName, dryRun = false }) {
  const result = { action: 'noop', dryRun: !!dryRun, siteUrl, userName };
  const clean = normalizeSiteUrl(siteUrl);
  if (!clean) return { ...result, action: 'skip', reason: 'empty-url' };

  let rt;
  try {
    rt = await resolveUserTab(userName);
  } catch (e) {
    return { ...result, action: 'error', reason: 'sheet-not-configured', error: e.message };
  }
  if (!rt.user || rt.reason) return { ...result, action: 'skip', reason: rt.reason, error: rt.error };

  const { id: sheetId, headerRow } = getDailyReviewSheetId();
  const tabName = rt.tabName;
  Object.assign(result, { tabName, matchedBy: rt.matchedBy });

  const tab = await readAndResolveTab(tabName, sheetId, headerRow);
  if (!tab.ok) return { ...result, action: 'error', reason: tab.reason, via: tab.via, error: tab.error };
  Object.assign(result, { urlCol: tab.col, urlColVia: tab.via });

  let target = null;
  for (let i = 0; i < tab.rows.length; i++) {
    if (normalizeSiteUrl((tab.rows[i] || [])[tab.col]) === clean) {
      target = { rowNumber: headerRow + 1 + i };
      break;
    }
  }
  if (!target) return { ...result, action: 'skip', reason: 'not-present' };
  result.rowNumber = target.rowNumber;

  const markerCol = findAssignmentMarkerColumn(tab.header);
  if (markerCol === -1) {
    return {
      ...result,
      action: 'skip',
      reason: 'no-marker-column',
      note: 'Row kept (soft-remove). Tab has no Assignment column to mark; add one with ensureAssignmentMarkerColumn() so unassign is visible in the sheet.',
    };
  }
  if (markerCol === tab.col) {
    return { ...result, action: 'error', reason: 'marker-column-is-url-column' };
  }

  const cell = `${colIndexToA1(markerCol)}${target.rowNumber}`;
  result.cell = cell;
  result.markerColumn = markerCol;
  if (dryRun) return { ...result, action: 'would-soft-remove' };

  try {
    await updateSheetCell(sheetId, tabName, cell, ASSIGNMENT_MARKER_ON_UNASSIGN);
  } catch (e) {
    return { ...result, action: 'error', reason: 'marker-write-failed', error: e.message };
  }

  // Tint the row so the soft-remove is visible without reading the marker cell.
  // The marker write above already succeeded and is the actual record; this is
  // presentation derived from it. If the colour fails the unassign still stands
  // and the failure is reported rather than rolled back, because a missing
  // colour must never cost someone their unassign.
  const highlight = await applyRowHighlights({
    sheetId, tabName, tab, rowNumbers: [target.rowNumber], mode: 'fill', dryRun,
  });
  result.highlight = highlight;
  return {
    ...result,
    action: 'soft-removed',
    highlightAction: highlight.action,
    highlightRanges: highlight.ranges || [],
  };
}

/**
 * syncTabRowHighlights — make a tab's row tints agree with its marker cells.
 *
 * THE REPAIR PASS, and why it exists rather than trusting the write path.
 * The tint is derived state, so it can drift from the marker that drives it:
 * a row marked by hand, a row appended by a human, a batch edit in the sheet, or
 * a write that failed halfway. Re-deriving on demand is what keeps the promise
 * that "orange means unassigned" stays true, and it is the same standing-check
 * idea as the sync data-quality lint.
 *
 * IDEMPOTENT BY CONSTRUCTION. It reads the current fills first and only plans
 * rows that actually disagree, so running it twice writes nothing the second
 * time. That matters because this is a write path over a live shared sheet.
 *
 * Only rows whose marker is a RECOGNISED value are touched. An unrecognised
 * marker yields mode 'none' and is reported, never guessed at.
 */
export async function syncTabRowHighlights({ tabName, sheetId, headerRow = 1, dryRun = true }) {
  const out = {
    tabName, dryRun: !!dryRun, fillHex: UNASSIGNED_ROW_FILL_HEX,
    fillRows: [], clearRows: [], unknownMarkerRows: [], alreadyCorrect: 0,
    // Rows deliberately left alone because they carry a colour we did not put
    // there. Reported rather than resolved — see the comments in the loop below.
    conflictRows: [], distinctFillRows: [],
  };
  const id = sheetId || getDailyReviewSheetId().id;

  const tab = await readAndResolveTab(tabName, id, headerRow);
  if (!tab.ok) return { ...out, action: 'error', reason: tab.reason, error: tab.error };
  out.width = tab.width;

  const markerCol = findAssignmentMarkerColumn(tab.header);
  if (markerCol === -1) {
    return { ...out, action: 'skip', reason: 'no-marker-column' };
  }
  out.markerColumn = markerCol;

  const accountRes = resolveUserTabAccountColumn({
    headers: tab.header, rows: tab.rows, urlCol: tab.col,
  });
  const accountCol = Number.isInteger(accountRes?.col) ? accountRes.col : -1;
  const preserveCols = accountCol >= 0 ? [accountCol] : [];
  out.preserveCols = preserveCols;
  out.accountColVia = accountRes?.via || 'unresolved';

  const lastRow = headerRow + tab.rows.length;
  let fills = {};
  try {
    fills = await getRangeBackgroundColors(id, tabName, `A${headerRow}:${colIndexToA1(Math.max(0, tab.width - 1))}${Math.max(lastRow, headerRow)}`);
  } catch (e) {
    return { ...out, action: 'error', reason: 'background-read-failed', error: e.message };
  }

  const wantFill = UNASSIGNED_ROW_FILL_HEX.toUpperCase();
  const cols = rowHighlightColumns({ tab, markerCol, mode: 'fill' });
  const segments = require_segments(cols.firstCol, cols.lastCol, cols.preserveCols);
  const paintableCols = segments.flatMap((s) => {
    const r = [];
    for (let c = s.startCol; c <= s.endCol; c++) r.push(c);
    return r;
  });

  for (let i = 0; i < tab.rows.length; i++) {
    const rowNumber = headerRow + 1 + i;
    const marker = String((tab.rows[i] || [])[markerCol] ?? '').trim();
    const mode = highlightModeForMarker(marker);
    if (mode === 'none') {
      if (marker) out.unknownMarkerRows.push({ rowNumber, marker });
      continue;
    }
    const rowFills = fills[rowNumber] || {};

    // Colours already on the row that are NOT ours, split by whether they are in
    // a cell we are allowed to paint.
    const foreign = (only) => Object.entries(rowFills)
      .map(([c, hex]) => [Number(c), String(hex).toUpperCase()])
      .filter(([, hex]) => hex !== wantFill)
      .filter(([c]) => (only === 'paintable' ? paintableCols.includes(c) : !paintableCols.includes(c)))
      .map(([c, hex]) => `${colIndexToA1(c)}=${hex}`);

    const foreignPaintable = foreign('paintable');

    if (mode === 'clear') {
      // ONLY our own tint may be removed. Any other colour on an "Assigned" row
      // belongs to someone else — measured 2026-09-26, Toufiq rows 27 and 28
      // are marked "Assigned" and carry #CFE2F3, which is this workbook's ROW
      // BANDING, not a leftover tint. Clearing on "the marker says Assigned"
      // alone would have stripped the team's banding off two live rows. A fill we
      // did not put there is not ours to remove.
      if (!foreign().length) { out.alreadyCorrect++; continue; }
      if (foreignPaintable.length) {
        out.distinctFillRows.push({ rowNumber, marker, cells: foreignPaintable });
        continue;
      }
      out.clearRows.push(rowNumber);
      continue;
    }

    // mode === 'fill'
    if (foreignPaintable.length) {
      // Painting would destroy a colour whose meaning we cannot know, and if the
      // tint were later cleared the original would be gone for good. Report it
      // and leave the row alone rather than guessing.
      out.conflictRows.push({ rowNumber, marker, cells: foreignPaintable });
      continue;
    }
    const allMatch = segments.length > 0 && paintableCols.every((c) => rowFills[c] === wantFill);
    if (allMatch) { out.alreadyCorrect++; continue; }
    out.fillRows.push(rowNumber);
  }

  out.planned = {
    fill: planBatchRowHighlight({
      sheetId: 0, tabName, rows: out.fillRows, firstCol: 0,
      lastCol: Math.max(0, tab.width - 1), preserveCols, mode: 'fill',
    }).requests.length,
    clear: planBatchRowHighlight({
      sheetId: 0, tabName, rows: out.clearRows, firstCol: 0,
      lastCol: Math.max(0, tab.width - 1), preserveCols, mode: 'clear',
    }).requests.length,
  };

  if (dryRun) {
    return {
      ...out,
      action: out.fillRows.length || out.clearRows.length ? 'would-sync' : 'already-in-sync',
    };
  }
  if (!out.fillRows.length && !out.clearRows.length) {
    return { ...out, action: 'already-in-sync' };
  }

  const applied = [];
  if (out.fillRows.length) {
    const r = await applyRowHighlights({ sheetId: id, tabName, tab, rowNumbers: out.fillRows, mode: 'fill', dryRun });
    applied.push(r);
  }
  if (out.clearRows.length) {
    const r = await applyRowHighlights({ sheetId: id, tabName, tab, rowNumbers: out.clearRows, mode: 'clear', dryRun });
    applied.push(r);
  }
  const failed = applied.filter((a) => a.action === 'error');
  return {
    ...out,
    action: failed.length ? 'partial' : 'synced',
    applied: applied.map((a) => ({ mode: a.mode, action: a.action, count: a.ranges?.length ?? 0, error: a.error })),
  };
}

// Uses the exact segment logic the writer uses, so "which columns are
// paintable" cannot drift between the check and the write.
function require_segments(firstCol, lastCol, preserveCols) {
  return buildRowSegments({ firstCol, lastCol, preserveCols });
}

/** Drop cached tab titles (used by tests and after sheet-manager changes). */
export function clearTabTitleCache() {
  tabTitleCache.clear();
}
