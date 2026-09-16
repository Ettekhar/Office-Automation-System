/**
 * sheets.js
 *
 * All Google Sheets API calls are funnelled through two protective layers:
 *
 *  1. Cache  — serves results from memory; zero API calls on a cache hit.
 *              (5-minute TTL by default, configurable via SHEETS_CACHE_TTL_MS)
 *
 *  2. Queue  — on a cache miss, the actual HTTP request is placed in a FIFO
 *              serial queue.  The queue processes one request at a time with a
 *              minimum 1 400 ms gap between calls, capping real throughput at
 *              ~43 requests / minute (well under Google's 60 req/min limit).
 *
 *              Because the queue is SERIAL, even if the browser fires 100
 *              concurrent preview requests they will not burst the API — each
 *              one waits its turn.  Requests that arrive for the same cache key
 *              while a fetch is already in-flight are DEDUPLICATED (only one
 *              HTTP call is made; all waiters receive the same result).
 *
 *  3. Retry  — if a 429 still slips through (e.g. other processes using the
 *              same service account), the call is retried with exponential
 *              back-off: 3 s → 6 s → 12 s → 24 s → 48 s (max 5 retries).
 *
 * ─── CHANGELOG (month-column fixes) ─────────────────────────────────────────
 *  - Older revisions of this file tried string/word-only month matching,
 *    which broke on multi-year sheets (see the timeline-based approach
 *    below for the real fix — it supersedes everything in this note).
 *
 * ─── CHANGELOG (year-aware timeline — the real fix) ─────────────────────────
 *  - The sheet spans MULTIPLE YEARS ("October 2022", "October 2024", bare
 *    "October" all coexist). Matching by month-word only (ignoring year)
 *    caused every October ever to be flagged as a "duplicate" of each other.
 *  - buildMonthTimeline() now walks the header row left→right and resolves
 *    every column to a real (monthIndex, year): explicit years anchor it,
 *    and a BARE month name inherits its year from the column immediately
 *    before it (inferYearFromSequence) — NEVER from the system clock. A
 *    bare "September" right after "August 25" resolves to September 2025,
 *    not "whatever year it is today," which is what was causing new columns
 *    to jump straight to the current real-world year and leave a trail of
 *    blank filler columns behind.
 *  - appendMonthColumn and syncSiteStatusToSheet both match against this
 *    year-resolved timeline, so same-name-different-year columns are never
 *    confused, and genuine same-month-same-year duplicates are still
 *    auto-merged (keeping whichever copy has data).
 *  - Added removeEmptyTrailingMonthColumns(): a one-off cleanup utility to
 *    strip trailing columns that have a header but no data in any row, or
 *    no header at all.
 *  - Removed dead code (an unused re-read of headers in appendMonthColumn).
 *
 * ─── CHANGELOG (Dev Tracker: TWO column layouts — header-driven resolution) ──
 *  - Supersedes the "Dev Tracker 7-column fix" note below: assuming the 7-column
 *    A:G layout for EVERY tab was still wrong, because only some tabs were
 *    migrated. Verified live on 2026-09-15:
 *      OLD 5-col → AnsAngel coalition, Nines Hotel, Sara Paris Booth,
 *                  Bunting& Murray Construction
 *                  A=URL B=Status C=Feedbacks URL D=Date E=Note/Updates
 *      NEW 7-col → The House, Reitz Union
 *                  A=URL B=Status C=Development-Date D=Development-Updates
 *                  E=Feedbacks URL F=Feedback-Date G=Feedback-Note/Updates
 *    Fixed-position reads therefore put an OLD tab's Feedback URL into
 *    devDate, its Date into devNotes, and never read its real Note/Updates
 *    column; fixed-position writes (always A:G) shifted an OLD tab's C/D/E
 *    values two columns to the right on every dashboard edit.
 *  - Added resolveDevTrackerColumns() / resolveDevTrackerLayout() /
 *    devTrackerRowWidth(): every dev-tracker read AND write now maps fields
 *    through the tab's OWN header row, sized to that tab's width. Falls back
 *    to the 7-column default only when a header row can't be understood.
 *  - fetchDevTrackerSheetData() now reads A1:Z500 (instead of A1:G500) and
 *    reports the resolved `columns` per project for debugging.
 *  - New tabs created via createNewProjectTabWithSitemapInSheet() still get the
 *    7-column NEW layout (unchanged).
 *
 * ─── CHANGELOG (Dev Tracker 7-column fix) ───────────────────────────────────
 *  - The Dev Tracker sheet grew two new columns (Development-Date,
 *    Development-Updates) inserted at C/D, which pushed the original
 *    Feedback URL/Date/Notes from C/D/E to E/F/G. All Dev Tracker read AND
 *    write functions were still hardcoded to a 5-column A:E layout, so:
 *      - fetchDevTrackerSheetData was reading Development-Date into
 *        feedbackUrl, Development-Updates into date, Feedback URL into
 *        notes — and never even fetching the real Feedback-Date /
 *        Feedback-Notes columns (F/G) at all.
 *      - Every write function (updateDevTrackerRowInSheet,
 *        appendDevTrackerRowInSheet, createNewFeedbackRoundInSheet,
 *        bulkAppendSitemapUrlsInSheet, createNewProjectTabWithSitemapInSheet)
 *        wrote A:E in the old order, so anything the app wrote back would
 *        also land in the wrong columns and clobber the new C/D fields.
 *  - Fixed: all Dev Tracker functions now read/write the full A:G range with
 *    the real 7-column layout: A=URL, B=Status, C=Development-Date,
 *    D=Development-Updates, E=Feedback URL, F=Feedback-Date, G=Feedback-Notes.
 *  - fetchDevTrackerSheetData now surfaces devDate/devNotes alongside the
 *    existing feedbackUrl/date/notes fields per item, so a single row can
 *    contribute two distinct dated work entries (a dev entry and a feedback
 *    entry) instead of one blended/garbled one.
 */

import { google } from 'googleapis';
import { JWT } from 'google-auth-library';
import fs from 'fs';
import { config } from './config.js';
import {
  resolveColumns,
  rowWidth,
  writeFields,
  inferColumnKind,
  headerKey,
} from './tabSchema.js';
import {
  cacheGet,
  cacheSet,
  tabTitlesCacheKey,
  tabValuesCacheKey,
  invalidateCache,
  invalidateCacheForSpreadsheet,
} from './sheetsCache.js';

// ─── Minimum ms between consecutive real API calls ──────────────────────────
// 60 000 ms / 43 = ~1 395 ms  → keeps us at ≤43 req/min (quota is 60).
const QUEUE_INTERVAL_MS = Number(process.env.SHEETS_QUEUE_INTERVAL_MS || 1400);

// ─── Shared API client ───────────────────────────────────────────────────────
let sheetsClient = null;

export async function getSheetsClient() {
  if (sheetsClient) return sheetsClient;

  const keyFile = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_JSON
    ? JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY_JSON)
    : JSON.parse(fs.readFileSync(config.serviceAccountKeyPath, 'utf8'));

  const auth = new JWT({
    email: keyFile.client_email,
    key: keyFile.private_key,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  await auth.authorize();

  sheetsClient = google.sheets({ version: 'v4', auth });
  return sheetsClient;
}

// ─── Serial Request Queue ────────────────────────────────────────────────────
/**
 * A simple FIFO async queue.
 * - One task executes at a time.
 * - A mandatory pause of QUEUE_INTERVAL_MS follows each completion.
 * - In-flight deduplication: multiple callers waiting for the same cacheKey
 *   share a single pending Promise (only one HTTP request is issued).
 */
const queue = [];
let queueRunning = false;
const inFlight = new Map(); // cacheKey → Promise<value>

async function processQueue() {
  if (queueRunning) return;
  queueRunning = true;

  while (queue.length > 0) {
    const { fn, resolve, reject } = queue.shift();
    try {
      resolve(await fn());
    } catch (err) {
      reject(err);
    }
    // Mandatory cool-down between real API calls
    if (queue.length > 0) {
      await new Promise((r) => setTimeout(r, QUEUE_INTERVAL_MS));
    }
  }

  queueRunning = false;
}

/**
 * Enqueue an API call.  Returns the same Promise for duplicate in-flight keys.
 */
function enqueue(cacheKey, fn) {
  // Deduplicate: if the same key is already being fetched, join that Promise
  if (inFlight.has(cacheKey)) {
    return inFlight.get(cacheKey);
  }

  const promise = new Promise((resolve, reject) => {
    queue.push({ fn, resolve, reject });
    processQueue();
  }).finally(() => inFlight.delete(cacheKey));

  inFlight.set(cacheKey, promise);
  return promise;
}

// ─── Retry with exponential back-off ─────────────────────────────────────────
async function withRetry(fn, maxRetries = 5, baseDelayMs = 3000) {
  let lastError;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const is429 =
        err?.status === 429 ||
        err?.code === 429 ||
        (err?.errors && err.errors.some((e) => e.reason === 'rateLimitExceeded')) ||
        String(err?.message || '').toLowerCase().includes('quota');

      if (!is429 || attempt === maxRetries) throw err;

      const delay = baseDelayMs * Math.pow(2, attempt);
      console.warn(
        `[sheets] 429 hit — retry ${attempt + 1}/${maxRetries} in ${delay / 1000}s`
      );
      await new Promise((r) => setTimeout(r, delay));
      lastError = err;
    }
  }
  throw lastError;
}

// ─── Public API ──────────────────────────────────────────────────────────────

/** Returns an array of every tab title in the spreadsheet. */
export async function listTabTitles(spreadsheetId = null) {
  const targetId = spreadsheetId || config.spreadsheetId;
  const cacheKey = tabTitlesCacheKey(targetId);

  // 1. Cache hit → instant return, no queue
  const cached = cacheGet(cacheKey);
  if (cached !== undefined) return cached;

  // 2. Queue the real API call (deduplicated + rate-limited)
  return enqueue(cacheKey, async () => {
    // Double-check cache (another request may have filled it while we waited)
    const fresh = cacheGet(cacheKey);
    if (fresh !== undefined) return fresh;

    const sheets = await getSheetsClient();
    const meta = await withRetry(() =>
      sheets.spreadsheets.get({ spreadsheetId: targetId })
    );
    const titles = meta.data.sheets.map((s) => s.properties.title);
    cacheSet(cacheKey, titles);
    console.log(`[sheets] fetched tab titles for ${targetId} (${titles.length} tabs)`);
    return titles;
  });
}

/** Returns the full 2D array of values for a given tab. */
export async function getTabValues(tabName, range = 'A1:ZZ2000', spreadsheetId = null) {
  const targetId = spreadsheetId || config.spreadsheetId;
  const cacheKey = tabValuesCacheKey(targetId, tabName, range);

  // 1. Cache hit → instant return, no queue
  const cached = cacheGet(cacheKey);
  if (cached !== undefined) return cached;

  // 2. Queue the real API call (deduplicated + rate-limited)
  return enqueue(cacheKey, async () => {
    // Double-check cache
    const fresh = cacheGet(cacheKey);
    if (fresh !== undefined) return fresh;

    const sheets = await getSheetsClient();
    const res = await withRetry(() =>
      sheets.spreadsheets.values.get({
        spreadsheetId: targetId,
        range: `'${tabName}'!${range}`,
        valueRenderOption: 'FORMATTED_VALUE',
      })
    );
    const values = res.data.values || [];
    cacheSet(cacheKey, values);
    console.log(`[sheets] fetched "${tabName}" (${values.length} rows)`);
    return values;
  });
}

/** Converts a 0-indexed column number to spreadsheet column letter (0->A, 25->Z, 26->AA, 63->BL) */
export function colIndexToA1(colIndex) {
  let temp = colIndex;
  let letter = '';
  while (temp >= 0) {
    letter = String.fromCharCode((temp % 26) + 65) + letter;
    temp = Math.floor(temp / 26) - 1;
  }
  return letter;
}

/** Updates a single cell or range in a given sheet tab */
export async function updateSheetCell(spreadsheetId, tabName, a1Notation, value) {
  const targetId = spreadsheetId || config.spreadsheetId;
  const sheets = await getSheetsClient();
  invalidateCacheForSpreadsheet(targetId);
  return withRetry(() =>
    sheets.spreadsheets.values.update({
      spreadsheetId: targetId,
      range: `'${tabName}'!${a1Notation}`,
      valueInputOption: 'USER_ENTERED',
      requestBody: {
        values: [[value]],
      },
    })
  );
}

/** Appends a row of values to the end of a sheet tab */
export async function appendSheetRow(spreadsheetId, tabName, rowValues) {
  const targetId = spreadsheetId || config.spreadsheetId;
  const sheets = await getSheetsClient();
  invalidateCacheForSpreadsheet(targetId);
  return withRetry(() =>
    sheets.spreadsheets.values.append({
      spreadsheetId: targetId,
      range: `'${tabName}'!A:ZZ`,
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
      requestBody: {
        values: [rowValues],
      },
    })
  );
}

/** Appends a new column header to a sheet tab */
export async function appendSheetColumn(spreadsheetId, tabName, headerName, headerRowNum = 1) {
  const targetId = spreadsheetId || config.spreadsheetId;
  const sheets = await getSheetsClient();
  const headerRes = await withRetry(() =>
    sheets.spreadsheets.values.get({
      spreadsheetId: targetId,
      range: `'${tabName}'!A${headerRowNum}:ZZ${headerRowNum}`,
      valueRenderOption: 'FORMATTED_VALUE',
    })
  );
  const headers = (headerRes.data.values || [[]])[0] || [];
  const nextColIdx = headers.length;
  const colLetter = colIndexToA1(nextColIdx);
  const cellA1 = `${colLetter}${headerRowNum}`;

  invalidateCacheForSpreadsheet(targetId);
  await withRetry(() =>
    sheets.spreadsheets.values.update({
      spreadsheetId: targetId,
      range: `'${tabName}'!${cellA1}`,
      valueInputOption: 'USER_ENTERED',
      requestBody: {
        values: [[headerName]],
      },
    })
  );
  return { colIndex: nextColIdx, colLetter, cellA1, headerName };
}


/**
 * Deletes all columns after `keepUpToIndex` (0-indexed, inclusive).
 * Used to remove rogue/phantom columns that were created by a previous insertDimension.
 * Returns the number of columns deleted.
 */
async function deleteColumnsAfter(sheets, spreadsheetId, sheetId, keepUpToIndex, totalHeaderCols) {
  const deleteFrom = keepUpToIndex + 1;
  if (deleteFrom >= totalHeaderCols) return 0;

  const count = totalHeaderCols - deleteFrom;
  console.log(`[sheets] Removing ${count} rogue column(s) after index ${keepUpToIndex} (cols ${deleteFrom}–${totalHeaderCols - 1})`);

  await withRetry(() =>
    sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [
          {
            deleteDimension: {
              range: {
                sheetId,
                dimension: 'COLUMNS',
                startIndex: deleteFrom,
                endIndex: totalHeaderCols,
              },
            },
          },
        ],
      },
    })
  );

  return count;
}

// ─── Month parsing / canonicalization ────────────────────────────────────────

const MONTH_NAMES = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
];
const MONTH_ABBR = MONTH_NAMES.map((m) => m.slice(0, 3));

function capitalize(word) {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

/**
 * Parses a header/month string into { monthIndex (0-11), year (4-digit) | null }.
 * Accepts: "September", "September 26", "September 2026", "Sep 26", "sept26".
 * Returns null if the string doesn't look like a month at all (so unrelated
 * headers — e.g. "Website URL" — are safely ignored).
 */
function parseMonthHeader(str) {
  const s = (str || '').trim().toLowerCase();
  if (!s) return null;

  const m = s.match(/^([a-z]+)\.?\s*'?(\d{2,4})?$/);
  if (!m) return null;

  const word = m[1];
  const yearRaw = m[2];

  let monthIndex = MONTH_NAMES.indexOf(word);
  if (monthIndex === -1) monthIndex = MONTH_ABBR.indexOf(word.slice(0, 3));
  if (monthIndex === -1 || (word.length < 3)) return null;

  let year = null;
  if (yearRaw) {
    year = yearRaw.length === 2 ? 2000 + parseInt(yearRaw, 10) : parseInt(yearRaw, 10);
  }

  return { monthIndex, year };
}

/**
 * Produces the canonical "MonthName YY" form for a {monthIndex, year} pair.
 */
function formatCanonical(monthIndex, year) {
  return `${capitalize(MONTH_NAMES[monthIndex])} ${String(year).slice(-2)}`;
}

/**
 * Given the last KNOWN (monthIndex, year) in the sheet's timeline, infers the
 * year for the next header of `monthIndex` when no explicit year was given.
 *  - Same month as last known           → same year (re-append/duplicate case)
 *  - Next month after last known        → same year, or +1 if wrapping Dec→Jan
 *  - Anything else (a gap/backward jump) → best-effort based on ordering
 * This NEVER looks at the system clock — it only reasons from the sheet's
 * own chronological sequence, which is what actually matters: a sheet that's
 * only filled in through August 2025 should get "September 25" next, not
 * "September 26" just because today happens to be in 2026.
 */
function inferYearFromSequence(lastKnown, monthIndex) {
  if (monthIndex === lastKnown.monthIndex) return lastKnown.year;
  if (monthIndex === (lastKnown.monthIndex + 1) % 12) {
    return lastKnown.monthIndex === 11 ? lastKnown.year + 1 : lastKnown.year;
  }
  return monthIndex > lastKnown.monthIndex ? lastKnown.year : lastKnown.year + 1;
}

/**
 * Walks the ENTIRE header row left→right and assigns every parseable month
 * header an "effective year" — either its own explicit year, or one inferred
 * from the column immediately before it via inferYearFromSequence(). This is
 * what lets two columns both named "October" (one from 2022, one from 2025)
 * be correctly told apart, instead of being treated as "the same month" the
 * way plain string/month-word matching would.
 *
 * Returns:
 *  - timeline: [{ index, monthIndex, year }] for every column that could be
 *    resolved to a real (monthIndex, year) — non-month headers are skipped.
 *  - lastKnown: the (monthIndex, year) of the rightmost resolvable column,
 *    used as the anchor for inferring a brand-new target month's year.
 */
function buildMonthTimeline(headers) {
  const timeline = [];
  let lastKnown = null;

  for (let i = 0; i < headers.length; i++) {
    const parsed = parseMonthHeader(headers[i]);
    if (!parsed) continue;

    let year;
    if (parsed.year != null) {
      year = parsed.year;
    } else if (lastKnown) {
      year = inferYearFromSequence(lastKnown, parsed.monthIndex);
    } else {
      // First-ever header has no year and there's no prior context to infer
      // from — leave it unresolved rather than guess. It simply won't
      // participate in duplicate-matching, which is the safe behavior.
      continue;
    }

    lastKnown = { monthIndex: parsed.monthIndex, year };
    timeline.push({ index: i, monthIndex: parsed.monthIndex, year });
  }

  return { timeline, lastKnown };
}

/** Deletes a single column by index. Small helper used by the auto-merge path. */
async function deleteSingleColumn(sheets, spreadsheetId, sheetId, colIndex) {
  await withRetry(() =>
    sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [
          {
            deleteDimension: {
              range: {
                sheetId,
                dimension: 'COLUMNS',
                startIndex: colIndex,
                endIndex: colIndex + 1,
              },
            },
          },
        ],
      },
    })
  );
}

/** True if any data row (row 3 onward) has a non-empty value in this column. */
function columnHasData(rows, colIndex) {
  return rows.slice(2).some((row) => (row[colIndex] || '').toString().trim() !== '');
}

/**
 * Appends a new month column to the rightmost edge of the Website List tab —
 * or, if a column for that exact (month, year) already exists, reuses it
 * instead of creating a duplicate.
 *
 * Strategy:
 *  1. Read all headers and build the sheet's own month timeline (see
 *     buildMonthTimeline) — this assigns every column a real (monthIndex,
 *     year), inferring missing years from sequence position, NEVER from the
 *     system clock.
 *  2. Resolve `monthName` to a target (monthIndex, year): use its explicit
 *     year if given, otherwise infer it the same way, anchored to the
 *     sheet's own last known column.
 *  3. Find every existing column whose resolved (monthIndex, year) exactly
 *     matches the target. Because years are now resolved (not ignored),
 *     October 2022 and October 2025 are correctly treated as different
 *     months — only genuine same-month-same-year duplicates match.
 *       - 0 matches  → append a brand-new column, header = canonical form.
 *       - 1 match    → reuse it, standardizing its header text if needed.
 *       - 2+ matches → phantom-duplicate case. Keep whichever column
 *                       actually has data, rename its header to canonical,
 *                       delete the empty duplicate(s). If more than one
 *                       duplicate has data (a real conflict), REFUSE and
 *                       report it instead of guessing and risking data loss.
 */
export async function appendMonthColumn(spreadsheetId, tabName = 'Website List', monthName) {
  const targetId = spreadsheetId || config.spreadsheetId;
  const sheets = await getSheetsClient();

  const meta = await withRetry(() => sheets.spreadsheets.get({ spreadsheetId: targetId }));
  const sheetObj = meta.data.sheets.find((s) => s.properties.title === tabName);
  if (!sheetObj) throw new Error(`Tab "${tabName}" not found in spreadsheet`);
  const sheetId = sheetObj.properties.sheetId;

  const headerRes = await withRetry(() =>
    sheets.spreadsheets.values.get({ spreadsheetId: targetId, range: `'${tabName}'!A2:ZZ2` })
  );
  const headers = headerRes.data.values?.[0] || [];

  const parsedTarget = parseMonthHeader(monthName);
  if (!parsedTarget) {
    throw new Error(`"${monthName}" doesn't parse as a month name — check the input.`);
  }

  const { timeline, lastKnown } = buildMonthTimeline(headers);

  let targetYear = parsedTarget.year;
  if (targetYear == null) {
    // No explicit year — infer from the sheet's own sequence, anchored to
    // its last known column. Only if the sheet has ZERO resolvable history
    // do we fall back to the system clock (nothing else to anchor to).
    targetYear = lastKnown
      ? inferYearFromSequence(lastKnown, parsedTarget.monthIndex)
      : new Date().getFullYear();
  }
  const canonical = formatCanonical(parsedTarget.monthIndex, targetYear);

  const matches = timeline.filter(
    (t) => t.monthIndex === parsedTarget.monthIndex && t.year === targetYear
  );

  // ── Case A: no existing column for this (month, year) → append fresh ─────
  if (matches.length === 0) {
    await withRetry(() =>
      sheets.spreadsheets.batchUpdate({
        spreadsheetId: targetId,
        requestBody: {
          requests: [{ appendDimension: { sheetId, dimension: 'COLUMNS', length: 1 } }],
        },
      })
    );
    const newColIndex = headers.length;
    const newColLetter = colIndexToA1(newColIndex);
    await updateSheetCell(targetId, tabName, `${newColLetter}2`, canonical);
    invalidateCache();
    return {
      created: true,
      column: newColLetter,
      colIndex: newColIndex,
      monthName: canonical,
      deletedTrailingCols: 0,
    };
  }

  // ── Case B: exactly one existing column → reuse it ────────────────────────
  if (matches.length === 1) {
    const { index } = matches[0];
    const header = headers[index];
    const deletedCount = await deleteColumnsAfter(sheets, targetId, sheetId, index, headers.length);
    if (header !== canonical) {
      await updateSheetCell(targetId, tabName, `${colIndexToA1(index)}2`, canonical);
    }
    invalidateCache();
    return {
      created: false,
      column: colIndexToA1(index),
      colIndex: index,
      deletedTrailingCols: deletedCount,
      standardized: header !== canonical,
      message:
        `Column for "${canonical}" already exists at ${colIndexToA1(index)}` +
        (header !== canonical ? ` — standardized header from "${header}" to "${canonical}"` : '') +
        (deletedCount > 0 ? ` — removed ${deletedCount} rogue column(s) after it` : ''),
    };
  }

  // ── Case C: 2+ columns resolve to the same (month, year) → auto-merge ────
  const rowsRes = await withRetry(() =>
    sheets.spreadsheets.values.get({ spreadsheetId: targetId, range: `'${tabName}'!A1:ZZ2000` })
  );
  const rows = rowsRes.data.values || [];

  const withData = matches.filter((m) => columnHasData(rows, m.index));

  if (withData.length !== 1) {
    const desc = matches
      .map((m) => `${colIndexToA1(m.index)}="${headers[m.index]}" (${columnHasData(rows, m.index) ? 'has data' : 'empty'})`)
      .join(', ');
    const msg =
      `[sheets] Refusing to auto-merge duplicate columns for "${canonical}" — ` +
      `found ${matches.length} matching columns and ${withData.length} of them have data: ${desc}. ` +
      `Can't safely pick a canonical column without risking data loss — resolve manually.`;
    console.warn(msg);
    return { created: false, error: 'AMBIGUOUS_DUPLICATE_MERGE', matches, message: msg };
  }

  const canonicalMatch = withData[0];
  const emptyDuplicates = matches
    .filter((m) => m.index !== canonicalMatch.index)
    .sort((a, b) => b.index - a.index); // right-to-left so earlier indices stay valid

  for (const dup of emptyDuplicates) {
    await deleteSingleColumn(sheets, targetId, sheetId, dup.index);
  }

  const finalIndex = canonicalMatch.index;
  if (headers[finalIndex] !== canonical) {
    await updateSheetCell(targetId, tabName, `${colIndexToA1(finalIndex)}2`, canonical);
  }

  invalidateCache();
  return {
    created: false,
    merged: true,
    column: colIndexToA1(finalIndex),
    colIndex: finalIndex,
    removedDuplicates: emptyDuplicates.map((d) => ({ column: colIndexToA1(d.index), header: headers[d.index] })),
    message: `Merged ${emptyDuplicates.length} empty duplicate column(s) for "${canonical}" into ${colIndexToA1(finalIndex)}`,
  };
}

/**
 * One-off cleanup: removes trailing columns (from the right edge inward) that
 * are effectively empty — i.e. have no header text AND no data in any data
 * row — or that have a header but zero data rows filled in. Stops at the
 * first column (scanning right-to-left) that has either a non-empty header
 * with at least one data value, or is not at the trailing edge.
 *
 * This is meant to clean up the phantom columns already created by the
 * format-mismatch bug (e.g. an empty "September 26" or "October 26" column
 * that has a header but zero status values written into it yet).
 *
 * Pass `requireEmptyData: false` if you only want to remove columns that have
 * NO header at all (safer, more conservative).
 */
export async function removeEmptyTrailingMonthColumns(
  spreadsheetId,
  tabName = 'Website List',
  { requireEmptyData = true } = {}
) {
  const targetId = spreadsheetId || config.spreadsheetId;
  const sheets = await getSheetsClient();

  const meta = await withRetry(() => sheets.spreadsheets.get({ spreadsheetId: targetId }));
  const sheetObj = meta.data.sheets.find((s) => s.properties.title === tabName);
  if (!sheetObj) throw new Error(`Tab "${tabName}" not found in spreadsheet`);
  const sheetId = sheetObj.properties.sheetId;

  const rowsRes = await withRetry(() =>
    sheets.spreadsheets.values.get({
      spreadsheetId: targetId,
      range: `'${tabName}'!A1:ZZ2000`,
    })
  );
  const rows = rowsRes.data.values || [];
  if (rows.length < 2) return { removed: 0, message: 'Not enough rows to inspect' };

  const headers = rows[1] || [];
  let lastCol = headers.length - 1;
  let removedCount = 0;

  // Scan from the right edge inward.
  while (lastCol >= 0) {
    const headerText = (headers[lastCol] || '').trim();
    const hasData = rows.slice(2).some((row) => (row[lastCol] || '').toString().trim() !== '');

    const isEmptyHeader = headerText === '';
    const isEmptyDataCol = requireEmptyData && headerText !== '' && !hasData;

    if (isEmptyHeader || isEmptyDataCol) {
      lastCol--; // mark for deletion, keep scanning left
      removedCount++;
    } else {
      break; // hit a real, populated column — stop
    }
  }

  const deleteFrom = lastCol + 1;
  if (removedCount === 0) {
    return { removed: 0, message: 'No empty trailing columns found' };
  }

  console.log(
    `[sheets] Cleanup: removing ${removedCount} empty trailing column(s) starting at ${colIndexToA1(deleteFrom)}`
  );

  await withRetry(() =>
    sheets.spreadsheets.batchUpdate({
      spreadsheetId: targetId,
      requestBody: {
        requests: [
          {
            deleteDimension: {
              range: {
                sheetId,
                dimension: 'COLUMNS',
                startIndex: deleteFrom,
                endIndex: headers.length,
              },
            },
          },
        ],
      },
    })
  );

  invalidateCache();

  return {
    removed: removedCount,
    fromColumn: colIndexToA1(deleteFrom),
    message: `Removed ${removedCount} empty trailing column(s) from ${colIndexToA1(deleteFrom)} onward`,
  };
}

/**
 * Synchronizes a site's maintenance status into the appropriate Google Sheet cell.
 * Maps status: "Completed" / "completed" -> "Updated & Backup", "in_progress" -> "In Progress", etc.
 */
export async function syncSiteStatusToSheet({ account, siteUrl, month, status }) {
  const acct = (account || 'CW').toUpperCase();
  const targetSpreadsheetId =
    acct === 'RM'
      ? process.env.RM_SPREADSHEET_ID || '1Fbb-SY2fU0HXFdnJ_OQoHb_AwlFzdk39jWOo3kFMcjY'
      : process.env.CW_SPREADSHEET_ID || '19aIBNOb0C4_Fx47bsZ2mUMVAxogX7j_tly8tSg-bldE';

  const tabName = 'Website List';
  const sheets = await getSheetsClient();

  // Fetch all rows from Website List
  const rowsRes = await withRetry(() =>
    sheets.spreadsheets.values.get({
      spreadsheetId: targetSpreadsheetId,
      range: `'${tabName}'!A1:ZZ2000`,
    })
  );
  const rows = rowsRes.data.values || [];
  if (rows.length < 2) throw new Error(`Not enough rows in ${acct} Website List tab`);

  const headers = rows[1] || []; // Row 2 has headers (index 1)

  // Find Website URL column
  const urlColIdx = headers.findIndex(
    (h) => typeof h === 'string' && /website\s*url/i.test(h.trim())
  );
  if (urlColIdx === -1) throw new Error(`Website URL column not found in ${acct} sheet`);

  // Determine target month column.
  let monthColIdx;

  if (month) {
    // An explicit month was requested. We resolve it against the sheet's own
    // month timeline (year-aware — see buildMonthTimeline), so "September"
    // right after "August 25" resolves to September 2025, not to whatever
    // the system clock's current year happens to be, and "October 2024" vs
    // "October 26" are correctly treated as different columns rather than
    // colliding. We no longer silently fall back to "rightmost column" on a
    // miss — that fallback was the root cause of statuses landing in the
    // wrong month's cell — so a genuine miss throws instead of guessing.
    const parsedTarget = parseMonthHeader(month);
    if (!parsedTarget) {
      throw new Error(`Month "${month}" doesn't parse as a month name — check the input.`);
    }
    const { timeline, lastKnown } = buildMonthTimeline(headers);
    const targetYear =
      parsedTarget.year != null
        ? parsedTarget.year
        : lastKnown
          ? inferYearFromSequence(lastKnown, parsedTarget.monthIndex)
          : null;

    const monthMatches = timeline.filter(
      (t) => t.monthIndex === parsedTarget.monthIndex && (targetYear == null || t.year === targetYear)
    );

    if (monthMatches.length === 0) {
      throw new Error(
        `Month "${month}" (resolved as ${formatCanonical(parsedTarget.monthIndex, targetYear)}) ` +
        `not found in ${acct} sheet headers — check the month string being passed in.`
      );
    }
    if (monthMatches.length > 1) {
      const desc = monthMatches.map((m) => `${colIndexToA1(m.index)}="${headers[m.index]}"`).join(', ');
      throw new Error(
        `Month "${month}" matches multiple columns in ${acct} sheet: ${desc}. ` +
        `Run the duplicate-column cleanup before syncing statuses, so this is unambiguous.`
      );
    }
    monthColIdx = monthMatches[0].index;
  } else {
    // No month specified — use the rightmost NON-EMPTY header column.
    monthColIdx = headers.length - 1;
    while (monthColIdx > 0 && !(headers[monthColIdx] || '').trim()) {
      monthColIdx--;
    }
  }

  // Normalize search URL
  const normSearchUrl = (siteUrl || '')
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\/+$/, '')
    .trim();

  // Find the site's row (rows are 0-indexed in array, so spreadsheet row is i + 1)
  let siteRowNumber = -1;
  for (let i = 2; i < rows.length; i++) {
    const rawUrl = (rows[i][urlColIdx] || '')
      .toLowerCase()
      .replace(/^https?:\/\//, '')
      .replace(/^www\./, '')
      .replace(/\/+$/, '')
      .trim();

    if (
      rawUrl &&
      (rawUrl === normSearchUrl || rawUrl.includes(normSearchUrl) || normSearchUrl.includes(rawUrl))
    ) {
      siteRowNumber = i + 1; // 1-indexed for spreadsheet
      break;
    }
  }

  if (siteRowNumber === -1) {
    console.warn(`[sheets] Site "${siteUrl}" not found in ${acct} sheet Website List`);
    return { success: false, error: `Site "${siteUrl}" not found in ${acct} sheet` };
  }

  // Status mapping
  let sheetStatusValue = status;
  const sLow = (status || '').toLowerCase().trim();
  if (
    sLow === 'completed' ||
    sLow === 'updated & backup' ||
    sLow === 'updated and backup' ||
    sLow === 'done'
  ) {
    sheetStatusValue = 'Updated & Backup';
  } else if (sLow === 'in_progress' || sLow === 'in progress') {
    sheetStatusValue = 'In Progress';
  } else if (sLow === 'todo' || sLow === 'pending' || sLow === 'to do') {
    sheetStatusValue = '';
  }

  const colLetter = colIndexToA1(monthColIdx);
  const a1Notation = `${colLetter}${siteRowNumber}`;

  await updateSheetCell(targetSpreadsheetId, tabName, a1Notation, sheetStatusValue);
  console.log(
    `[sheets] ✅ Synced ${acct} sheet: "${siteUrl}" [${headers[monthColIdx]}] cell ${a1Notation} = "${sheetStatusValue}"`
  );

  return {
    success: true,
    account: acct,
    cell: a1Notation,
    month: headers[monthColIdx],
    status: sheetStatusValue,
  };
}

export const DEV_TRACKER_SPREADSHEET_ID = '14PXRHUkFG-gf0DwbGVqeyPA7aQ4LyhDMjAeTVatOI78';

// ─── Dev Tracker column layout (A:G) ─────────────────────────────────────────
// The sheet grew from 5 to 7 columns: Development-Date and Development-Updates
// were inserted at C/D, pushing the original Feedback URL/Date/Notes to E/F/G.
//   A = URL
//   B = Status
//   C = Development-Date   (devDate)
//   D = Development-Updates (devNotes)
//   E = Feedback URL       (feedbackUrl)
//   F = Feedback-Date      (date)
//   G = Feedback-Notes     (notes)
const DEV_TRACKER_RANGE = 'A:G';

/** Builds a 7-column row array in the fixed A:G order, defaulting missing fields to ''. */
function buildDevTrackerRow({ url, status, devDate, devNotes, feedbackUrl, date, notes }) {
  return [
    url ?? '',
    status ?? '',
    devDate ?? '',
    devNotes ?? '',
    feedbackUrl ?? '',
    date ?? '',
    notes ?? '',
  ];
}

// ─── Per-tab column resolution (the two layouts that coexist) ────────────────
// NOT every tab in this spreadsheet uses the same columns. Verified live:
//
//   OLD 5-column tabs (AnsAngel coalition, Nines Hotel, Sara Paris Booth,
//   Bunting& Murray Construction):
//     A=URL  B=Status  C=Feedbacks URL  D=Date  E=Note/Updates
//
//   NEW 7-column tabs (The House, Reitz Union — the ones the Development
//   columns were added to):
//     A=URL  B=Status  C=Development-Date  D=Development-Updates
//     E=Feedbacks URL  F=Feedback-Date  G=Feedback-Note/Updates
//
// Reading/writing FIXED positions silently corrupted the old tabs: their
// Feedback URL was parsed as devDate, their Date as devNotes, and their real
// Notes column was never read at all (and every dashboard write shifted the
// row's values two columns to the right). Everything below therefore resolves
// the columns from the tab's own HEADER ROW, and only falls back to the 7-column
// default when the header row is unreadable/unrecognised.
export const DEV_TRACKER_DEFAULT_HEADERS = [
  'URL', 'Status', 'Development-Date', 'Development-Updates', 'Feedback URL', 'Feedback-Date', 'Feedback-Notes',
];

const DEV_TRACKER_DEFAULT_COLS = Object.freeze({
  // `profile` + `extras` are part of a resolved layout: they tell the shared
  // row mapper (tabSchema.writeFields) which field keys exist and that this
  // fallback has no hand-added columns.
  profile: 'devTracker',
  url: 0, status: 1, devDate: 2, devNotes: 3, feedbackUrl: 4, date: 5, notes: 6,
  extras: [],
});

/**
 * Resolves { url, status, devDate, devNotes, feedbackUrl, date, notes } →
 * 0-based column indexes from a header row. Returns null when the header row
 * can't be understood (caller then uses DEV_TRACKER_DEFAULT_COLS).
 *
 * Delegates to the shared header-driven resolver in tabSchema.js (profile
 * 'devTracker'), which is the single place every sheet type is understood:
 *   - 'development date' / 'dev date'                          → devDate
 *   - 'development updates|notes' / 'dev updates|notes'        → devNotes
 *   - 'feedback url|link' (also 'feedbacks url')               → feedbackUrl
 *   - 'feedback date' (fallback: a header that is just "Date") → date
 *   - 'feedback note|update' (fallback: "Note/Updates")        → notes
 * The look-alike fields are matched BEFORE their generic fallbacks, so
 * "development date" can never be mistaken for the feedback "Date" column.
 *
 * Every other header is kept in `cols.extras` (key + label + kind + index), so
 * a column someone adds by hand tomorrow — "QA Check", "SEO Notes" — is read,
 * written, displayed and answerable without touching any code.
 */
export function resolveDevTrackerColumns(headerRow = []) {
  const cols = resolveColumns(headerRow, { profile: 'devTracker' });
  // Give up if the header row doesn't look like a dev-tracker tab at all.
  if (cols.url === -1 && cols.status === -1) return null;
  return cols;
}

/** Widest resolved column + 1 — i.e. how many cells a full row must span. */
export function devTrackerRowWidth(cols) {
  return rowWidth(cols);
}

/**
 * Builds a row array sized to the tab's own layout, dropping unmapped fields.
 *
 * `fields.extra` (an object keyed by the extra column keys) is written back to
 * its own columns, so an interleaved hand-added column keeps its value instead
 * of being blanked when another field is edited.
 */
export function buildDevTrackerRowForLayout(cols, fields = {}) {
  const { extra, ...known } = fields || {};
  return writeFields(cols, {
    fields: known,
    extra: extra && typeof extra === 'object' ? extra : {},
  });
}

/** Extracts { key: value } for every extra column of a parsed row. */
export function extractExtraFields(cols, row = []) {
  const out = {};
  ((cols && cols.extras) || []).forEach((col) => {
    const v = Array.isArray(row) ? row[col.index] : '';
    out[col.key] = v === undefined || v === null ? '' : String(v).trim();
  });
  return out;
}

/**
 * Reads a tab's header row and returns its column layout (cached with the tab,
 * so this costs no extra API call on repeated writes in the same TTL window).
 */
export async function resolveDevTrackerLayout(tabName) {
  const cleanTab = String(tabName || '').trim();
  try {
    const rows = await getTabValues(cleanTab, 'A1:Z1', DEV_TRACKER_SPREADSHEET_ID);
    const headers = (rows && rows[0]) || [];
    const cols = resolveDevTrackerColumns(headers);
    if (cols) return { tabName: cleanTab, cols, headers, source: 'header' };
  } catch (e) {
    console.warn(`[sheets] Could not read header row of "${cleanTab}" (${e.message}) — using default A:G layout`);
  }
  return { tabName: cleanTab, cols: { ...DEV_TRACKER_DEFAULT_COLS }, headers: DEV_TRACKER_DEFAULT_HEADERS, source: 'default' };
}

/**
 * Updates a specific row in the Dev Tracker Google Sheet.
 *
 * The row is written into the tab's OWN resolved columns (see
 * resolveDevTrackerColumns) and only spans as far right as that layout goes —
 * so editing an OLD 5-column tab (A=URL…E=Note/Updates) no longer shifts its
 * Feedback URL/Date/Notes two columns to the right, and the Development
 * columns of a NEW 7-column tab are written to the correct cells.
 */
export async function updateDevTrackerRowInSheet({ tabName, rowNum, url, status, devDate, devNotes, feedbackUrl, date, notes, extra }) {
  if (!tabName || !rowNum) throw new Error('tabName and rowNum are required');
  const sheets = await getSheetsClient();
  const cleanTab = tabName.trim();
  const layout = await resolveDevTrackerLayout(cleanTab);
  const endCol = colIndexToA1(devTrackerRowWidth(layout.cols) - 1);
  const range = `'${cleanTab}'!A${rowNum}:${endCol}${rowNum}`;
  const values = [buildDevTrackerRowForLayout(layout.cols, { url, status, devDate, devNotes, feedbackUrl, date, notes, extra })];

  const res = await withRetry(() =>
    sheets.spreadsheets.values.update({
      spreadsheetId: DEV_TRACKER_SPREADSHEET_ID,
      range,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values },
    })
  );
  invalidateCache();
  return { success: true, updatedRange: range, updatedCells: res.data.updatedCells, layout: layout.source, columns: layout.cols };
}

/**
 * Appends a new row to a tab in the Dev Tracker Google Sheet.
 */
export async function appendDevTrackerRowInSheet({ tabName, url, status, devDate, devNotes, feedbackUrl, date, notes, extra }) {
  if (!tabName) throw new Error('tabName is required');
  const sheets = await getSheetsClient();
  const cleanTab = tabName.trim();
  const layout = await resolveDevTrackerLayout(cleanTab);
  const endCol = colIndexToA1(devTrackerRowWidth(layout.cols) - 1);
  const range = `'${cleanTab}'!A:${endCol}`;
  const values = [buildDevTrackerRowForLayout(layout.cols, { url, status, devDate, devNotes, feedbackUrl, date, notes, extra })];

  const res = await withRetry(() =>
    sheets.spreadsheets.values.append({
      spreadsheetId: DEV_TRACKER_SPREADSHEET_ID,
      range,
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values },
    })
  );
  invalidateCache();
  return { success: true, tableRange: res.data.updates?.updatedRange, layout: layout.source };
}

/**
 * Creates a new feedback round section in the Google Sheet:
 * Inserts the section header (e.g. "Feedback-4 URL" in the tab's Feedback URL
 * column) and the first comment/work row with the doc link, date, status, notes
 * — plus the Development-Date / Development-Updates values when the tab has
 * those columns (7-column layout).
 */
export async function createNewFeedbackRoundInSheet({ tabName, feedbackGroup, feedbackUrl, date, notes, status, url, devDate, devNotes, extra }) {
  if (!tabName) throw new Error('tabName is required');
  const sheets = await getSheetsClient();
  const cleanTab = tabName.trim();
  const layout = await resolveDevTrackerLayout(cleanTab);
  const marker = `${(feedbackGroup || 'Feedback').replace(/\s+/g, '-')} URL`;

  const values = [
    buildDevTrackerRowForLayout(layout.cols, { url: '', status: '', devDate: '', devNotes: '', feedbackUrl: marker, date: '', notes: '' }),
    buildDevTrackerRowForLayout(layout.cols, {
      url: url || '',
      status: status || 'In Progress',
      devDate: devDate || '',
      devNotes: devNotes || '',
      feedbackUrl: feedbackUrl || '',
      date: date || '',
      notes: notes || '',
      extra: extra && typeof extra === 'object' ? extra : {},
    }),
  ];

  const res = await withRetry(() =>
    sheets.spreadsheets.values.append({
      spreadsheetId: DEV_TRACKER_SPREADSHEET_ID,
      range: `'${cleanTab}'!A:${colIndexToA1(devTrackerRowWidth(layout.cols) - 1)}`,
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values },
    })
  );
  invalidateCache();
  return { success: true, tableRange: res.data.updates?.updatedRange, layout: layout.source };
}

/**
 * Bulk appends sitemap URLs to an existing project tab in Google Sheets.
 */
export async function bulkAppendSitemapUrlsInSheet({ tabName, urls, status }) {
  if (!tabName) throw new Error('tabName is required');
  if (!Array.isArray(urls) || urls.length === 0) return { count: 0 };
  const sheets = await getSheetsClient();
  const cleanTab = tabName.trim();
  const layout = await resolveDevTrackerLayout(cleanTab);
  const range = `'${cleanTab}'!A:${colIndexToA1(devTrackerRowWidth(layout.cols) - 1)}`;

  const values = urls.map((u) =>
    buildDevTrackerRowForLayout(layout.cols, { url: u.trim(), status: status || 'todo', devDate: '', devNotes: '', feedbackUrl: '', date: '', notes: '' })
  );

  const res = await withRetry(() =>
    sheets.spreadsheets.values.append({
      spreadsheetId: DEV_TRACKER_SPREADSHEET_ID,
      range,
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values },
    })
  );
  invalidateCache();
  return { success: true, count: urls.length, tableRange: res.data.updates?.updatedRange };
}

/**
 * Creates a brand new project tab in the Google Sheet with its sitemap URLs and initial feedback milestone.
 */
export async function createNewProjectTabWithSitemapInSheet({ projectName, urls = [], feedbackUrl = '', date = '', notes = '', status = 'todo' }) {
  if (!projectName) throw new Error('projectName is required');
  const sheets = await getSheetsClient();
  const cleanTab = projectName.trim();

  // Check if tab already exists
  const existingTabs = await listTabTitles(DEV_TRACKER_SPREADSHEET_ID);
  if (!existingTabs.includes(cleanTab)) {
    await withRetry(() =>
      sheets.spreadsheets.batchUpdate({
        spreadsheetId: DEV_TRACKER_SPREADSHEET_ID,
        requestBody: {
          requests: [
            {
              addSheet: {
                properties: {
                  title: cleanTab,
                },
              },
            },
          ],
        },
      })
    );
  }

  // Header row (A:G)
  const rows = [
    ['URL', 'Status', 'Development-Date', 'Development-Updates', 'Feedback URL', 'Feedback-Date', 'Feedback-Notes'],
  ];

  // Add sitemap URLs
  urls.forEach((u) => {
    if (u && u.trim()) {
      rows.push(buildDevTrackerRow({ url: u.trim(), status: status || 'todo', devDate: '', devNotes: '', feedbackUrl: '', date: '', notes: '' }));
    }
  });

  // Add initial Feedback 1 marker and work row
  rows.push(buildDevTrackerRow({ url: '', status: '', devDate: '', devNotes: '', feedbackUrl: 'Feedback-1 URL', date: '', notes: '' }));
  if (feedbackUrl || notes || date) {
    rows.push(
      buildDevTrackerRow({
        url: '',
        status: status || 'in_progress',
        devDate: '',
        devNotes: '',
        feedbackUrl: feedbackUrl || '',
        date: date || new Date().toISOString().slice(0, 10),
        notes: notes || 'Initial setup and tasks',
      })
    );
  }

  // Write all rows to the tab
  await withRetry(() =>
    sheets.spreadsheets.values.update({
      spreadsheetId: DEV_TRACKER_SPREADSHEET_ID,
      range: `'${cleanTab}'!A1:G${rows.length}`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: rows },
    })
  );

  invalidateCache();
  return { success: true, tab: cleanTab, totalRows: rows.length };
}

/**
 * Fetches and parses all dev project tabs and feedback items from Dev Tracker sheet.
 *
 * Column positions are resolved PER TAB from that tab's header row, because the
 * spreadsheet currently holds two layouts side by side:
 *
 *   OLD 5-col (AnsAngel coalition, Nines Hotel, Sara Paris Booth,
 *              Bunting& Murray Construction)
 *     A=URL  B=Status  C=Feedbacks URL  D=Date  E=Note/Updates
 *
 *   NEW 7-col (The House, Reitz Union — the tabs the Development-Date /
 *              Development-Updates columns were added to)
 *     A=URL  B=Status  C=Development-Date  D=Development-Updates
 *     E=Feedbacks URL  F=Feedback-Date  G=Feedback-Note/Updates
 *
 * Reading fixed C/D/E/F/G positions used to mis-read every OLD tab: its
 * Feedback URL landed in devDate, its Date in devNotes, and its real
 * Note/Updates column was never fetched at all — which is exactly why the
 * Development columns "weren't showing" while other tabs looked broken too.
 * When a tab's header row can't be understood we fall back to the 7-col default.
 */
export async function fetchDevTrackerSheetData() {
  const tabs = await listTabTitles(DEV_TRACKER_SPREADSHEET_ID);
  const projects = [];

  for (const tab of tabs) {
    try {
      const rows = await getTabValues(tab, 'A1:Z500', DEV_TRACKER_SPREADSHEET_ID);
      if (!rows || rows.length < 2) continue;

      const headerRow = rows[0] || [];
      const cols = resolveDevTrackerColumns(headerRow) || { ...DEV_TRACKER_DEFAULT_COLS };
      // Hand-added columns of THIS tab (anything the profile did not map), so a
      // column someone types in tomorrow is parsed, stored and shown as data.
      const extras = cols.extras || [];

      // Reads a cell at the column resolved for `field` ('' when the tab has no
      // such column at all, e.g. devDate on a 5-column tab).
      const cell = (row, field) => {
        const idx = cols[field];
        return idx >= 0 ? String(row[idx] || '').trim() : '';
      };

      let currentFeedbackGroup = 'Feedback 1';
      const items = [];
      let itemSeq = 0;

      rows.slice(1).forEach((r, idx) => {
        const rowNum = idx + 2; // 1-indexed sheet row number
        const url = cell(r, 'url');
        const status = cell(r, 'status');
        const devDate = cell(r, 'devDate');
        const devNotes = cell(r, 'devNotes');
        const feedbackUrl = cell(r, 'feedbackUrl');
        const date = cell(r, 'date');
        const notes = cell(r, 'notes');
        const extra = extractExtraFields(cols, r);
        const hasExtraValue = Object.values(extra).some((v) => String(v ?? '').trim() !== '');

        // Check if entire row is blank (a hand-added column counts as data)
        if (!url && !status && !devDate && !devNotes && !feedbackUrl && !date && !notes && !hasExtraValue) return;

        // Detect feedback group marker e.g. "Feedback-1 URL", "Feedback-2 URL"
        const isHeaderMarker = !url && feedbackUrl && /feedback[- ]*(\d+)/i.test(feedbackUrl);
        if (isHeaderMarker || /feedback[- ]*(\d+)/i.test(feedbackUrl)) {
          const m = feedbackUrl.match(/feedback[- ]*(\d+)/i);
          if (m) currentFeedbackGroup = `Feedback ${m[1]}`;
        }

        items.push({
          idx: itemSeq++,
          rowNum,
          feedbackGroup: currentFeedbackGroup,
          url,
          status: status || (isHeaderMarker ? 'Header' : 'Pending'),
          devDate,
          devNotes,
          feedbackUrl,
          date,
          notes,
          extra,
          isHeader: isHeaderMarker,
          updatedAt: new Date().toISOString(),
        });
      });

      if (items.length) {
        projects.push({
          id: Buffer.from(tab).toString('base64').replace(/=/g, ''),
          project: tab,
          items,
          columns: cols,
          profile: cols.profile || 'devTracker',
          extraColumns: extras,
          updatedAt: new Date().toISOString(),
        });
      }
    } catch (e) {
      console.warn(`[sheets] Error parsing dev project tab "${tab}":`, e.message);
    }
  }

  return projects;
}

/**
 * Updates Column A (Status / Note column) of a site in CW or RM Website List.
 * status: 'Active' or 'Deactive'
 */
export async function updateSiteStatusInSheet({ account, siteUrl, status }) {
  const acct = (account || 'CW').toUpperCase();
  const targetSpreadsheetId =
    acct === 'RM'
      ? process.env.RM_SPREADSHEET_ID || '1Fbb-SY2fU0HXFdnJ_OQoHb_AwlFzdk39jWOo3kFMcjY'
      : process.env.CW_SPREADSHEET_ID || '19aIBNOb0C4_Fx47bsZ2mUMVAxogX7j_tly8tSg-bldE';

  const tabName = 'Website List';
  const sheets = await getSheetsClient();

  const rowsRes = await withRetry(() =>
    sheets.spreadsheets.values.get({
      spreadsheetId: targetSpreadsheetId,
      range: `'${tabName}'!A1:ZZ2000`,
    })
  );
  const rows = rowsRes.data.values || [];
  if (rows.length < 2) throw new Error(`Not enough rows in ${acct} Website List tab`);

  const headers = rows[1] || [];
  const urlColIdx = headers.findIndex(
    (h) => typeof h === 'string' && /website\s*url/i.test(h.trim())
  );
  if (urlColIdx === -1) throw new Error(`Website URL column not found in ${acct} sheet`);

  const normSearchUrl = (siteUrl || '')
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\/+$/, '')
    .trim();

  let siteRowNumber = -1;
  for (let i = 2; i < rows.length; i++) {
    const rawUrl = (rows[i][urlColIdx] || '')
      .toLowerCase()
      .replace(/^https?:\/\//, '')
      .replace(/^www\./, '')
      .replace(/\/+$/, '')
      .trim();

    if (rawUrl && (rawUrl === normSearchUrl || rawUrl.includes(normSearchUrl) || normSearchUrl.includes(rawUrl))) {
      siteRowNumber = i + 1; // 1-indexed
      break;
    }
  }

  if (siteRowNumber === -1) {
    console.warn(`[sheets] Site "${siteUrl}" not found in ${acct} sheet to update status`);
    return { success: false, error: `Site "${siteUrl}" not found in ${acct} sheet` };
  }

  // Column A is index 0 -> Cell A{siteRowNumber}
  const cellA1 = `'${tabName}'!A${siteRowNumber}`;
  const statusVal = (status || '').toLowerCase().includes('deactiv') ? 'Deactive' : 'Active';

  await withRetry(() =>
    sheets.spreadsheets.values.update({
      spreadsheetId: targetSpreadsheetId,
      range: cellA1,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [[statusVal]] },
    })
  );

  console.log(`[sheets] Updated ${acct} site "${siteUrl}" status to "${statusVal}" at ${cellA1}`);
  return { success: true, cell: cellA1, status: statusVal };
}

/**
 * Appends a brand-new website row to CW or RM "Website List" tab.
 */
export async function appendNewSiteToSheet({ account, siteUrl, company = '', cms = '', accountManager = '', status = 'Active', note = '' }) {
  const acct = (account || 'CW').toUpperCase();
  const targetSpreadsheetId =
    acct === 'RM'
      ? process.env.RM_SPREADSHEET_ID || '1Fbb-SY2fU0HXFdnJ_OQoHb_AwlFzdk39jWOo3kFMcjY'
      : process.env.CW_SPREADSHEET_ID || '19aIBNOb0C4_Fx47bsZ2mUMVAxogX7j_tly8tSg-bldE';

  const tabName = 'Website List';
  const sheets = await getSheetsClient();

  const headerRes = await withRetry(() =>
    sheets.spreadsheets.values.get({
      spreadsheetId: targetSpreadsheetId,
      range: `'${tabName}'!A2:ZZ2`,
    })
  );
  const headers = (headerRes.data.values && headerRes.data.values[0]) || [];
  if (!headers.length) throw new Error(`Could not read headers in ${acct} Website List`);

  const urlColIdx = headers.findIndex(h => typeof h === 'string' && /website\s*url/i.test(h.trim()));
  const cmsColIdx = headers.findIndex(h => typeof h === 'string' && /^cms$/i.test(h.trim()));
  const compColIdx = headers.findIndex(h => typeof h === 'string' && /^company$/i.test(h.trim()));
  const acmColIdx = headers.findIndex(h => typeof h === 'string' && /a\/c\s*manager|account\s*manager/i.test(h.trim()));
  const noteColIdx = headers.findIndex(h => typeof h === 'string' && /^note$/i.test(h.trim()));

  const statusVal = (status || '').toLowerCase().includes('deactiv') ? 'Deactive' : 'Active';
  const row = new Array(headers.length).fill('');
  row[0] = statusVal; // Column A: status
  if (urlColIdx !== -1) row[urlColIdx] = siteUrl;
  if (cmsColIdx !== -1) row[cmsColIdx] = cms;
  if (compColIdx !== -1) row[compColIdx] = company || acct;
  if (acmColIdx !== -1) row[acmColIdx] = accountManager;
  if (noteColIdx !== -1) row[noteColIdx] = note || (statusVal === 'Deactive' ? 'Deactive' : '');

  await withRetry(() =>
    sheets.spreadsheets.values.append({
      spreadsheetId: targetSpreadsheetId,
      range: `'${tabName}'!A3:Z`,
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: [row] },
    })
  );

  console.log(`[sheets] Appended new site "${siteUrl}" to ${acct} Website List`);
  return { success: true, row };
}
// ── Broad RAG: fetch summary from ALL connected sheets ───────────────────────
// Reads a compact summary from every sheet the app is configured to read
// (all entries in getSheetCredentials()), so the chatbot can reason across
// CW Maintenance, RM Maintenance, Dev Tracker, Daily Review, etc. in one turn.
export async function fetchAllSheetsSummary() {
  const { getSheetCredentials } = await import('./db.js');
  const creds = getSheetCredentials();
  const results = [];

  for (const cred of creds) {
    if (cred.active === false) continue;
    try {
      const rows = await getTabValues(cred.tabName || 'Sheet1', 'A1:ZZ2000', cred.spreadsheetId);
      if (!rows || rows.length < (cred.headerRow || 1)) continue;

      const headerRow = rows[cred.headerRow - 1] || [];
      const columns = [];
      const usedKeys = new Set();

      // Known column name → key mappings for maintenance sheets (CW, RM, etc.)
      // so the LLM sees meaningful keys like "status", "reportUrl", "backupUrl"
      // instead of col_0, col_1, … — making SECTION 6 readable and queriable.
      const maintenanceFieldMap = {
        'status': 'status', 'state': 'status', 'active': 'status',
        'website url': 'websiteUrl', 'site url': 'websiteUrl', 'url': 'websiteUrl',
        'maintenance task clickup': 'taskClickUpUrl', 'maintenance task clickup url': 'taskClickUpUrl',
        'task clickup': 'taskClickUpUrl', 'clickup': 'taskClickUpUrl',
        'maintenance report url': 'reportUrl', 'maintenance report': 'reportUrl',
        'report url': 'reportUrl',
        'backup url': 'backupUrl', 'backup': 'backupUrl',
        'cms': 'cms', 'company': 'company', 'contact': 'contact',
        'a/c manager': 'accountManager', 'account manager': 'accountManager',
        'note': 'note', 'notes': 'note',
        'march 22': 'march22', 'april 22': 'april22',
      };

      for (let i = 0; i < headerRow.length; i++) {
        const h = String(headerRow[i] || '').trim();
        if (!h) continue;
        const hk = headerKey(h);
        let key = `col_${i}`;

        // Dev Tracker: use known field names
        if (cred.id === 'dev-tracker' || cred.category === 'Development Tracker') {
          const m = matchDevTrackerField(h);
          if (m) key = m;
        } else {
          // Maintenance / generic sheets: match known field patterns
          for (const [pattern, field] of Object.entries(maintenanceFieldMap)) {
            if (hk === pattern || hk.endsWith(pattern)) { key = field; break; }
          }
        }

        let fk = key;
        while (usedKeys.has(fk)) fk = `${key}_${i}`;
        usedKeys.add(fk);
        columns.push({ key: fk, label: h, index: i, kind: inferColumnKind(h) });
      }

      const dataRows = rows.slice(cred.headerRow || 1);
      const sheetRows = [];
      const statusCount = {};

      // Post-process: detect the real status column from data values.
      // Some sheets (CW Maintenance) have a wrong/blank header for the status
      // column — the data says "Active"/"Deactive" but the header says "Note:".
      // We fix the column key by looking at which column has status-like values.
      const STATUS_VALS = new Set([
        'active', 'deactive', 'completed', 'done', 'pending', 'todo',
        'in progress', 'progress', 'review', 'approved', 'rejected',
        'open', 'closed', 'hold', 'draft', 'new', 'testing', 'live',
        'yes', 'no', 'updated & backup', 'updated and backup',
      ]);
      let statusColIdx = -1;
      const valCounts = {};
      for (const r of dataRows.slice(0, 200)) {
        for (let ci = 0; ci < (r?.length || 0); ci++) {
          const v = String(r[ci] || '').trim().toLowerCase();
          if (!v) continue;
          valCounts[ci] = valCounts[ci] || 0;
          if (STATUS_VALS.has(v) || /^(active|deactive|completed|pending|todo|in progress|review|approved|rejected|open|closed| Hold|Hold|hold)$/i.test(v)) {
            valCounts[ci]++;
            if (valCounts[ci] > (valCounts[statusColIdx] || 0)) statusColIdx = ci;
          }
        }
      }
      // Also check: column 0 is very often the status column in these sheets
      if (statusColIdx < 0 && dataRows.length > 0) {
        const col0Vals = dataRows.slice(0, 50).map(r => String(r[0] || '').trim().toLowerCase()).filter(Boolean);
        const statusLike = col0Vals.filter(v => STATUS_VALS.has(v) || /^(active|deactive|completed|pending|todo)$/i.test(v));
        if (statusLike.length > col0Vals.length * 0.3) statusColIdx = 0;
      }

      for (let ri = 0; ri < dataRows.length; ri++) {
        const r = dataRows[ri];
        if (!r || !r.some(v => v !== '' && v !== null && v !== undefined)) continue;
        const obj = { _rowNumber: (cred.headerRow || 1) + ri + 1 };
        columns.forEach(col => { obj[col.key] = r[col.index] ?? ''; });
        // Use detected status column if auto-detected
        let sv = obj.status || obj.State || obj.Phase || obj.Progress || '';
        if (!sv && statusColIdx >= 0) {
          sv = String(r[statusColIdx] || '').trim();
          // Attach to obj with a proper key if not already set
          if (!obj.status && statusColIdx >= 0) {
            const sc = columns.find(c => c.index === statusColIdx);
            if (sc) { obj.status = sv; }
          }
        }
        if (sv) {
          const k = String(sv).trim();
          if (k) statusCount[k] = (statusCount[k] || 0) + 1;
        }
        sheetRows.push(obj);
      }

      results.push({
        id: cred.id, title: cred.title || cred.key || cred.id,
        spreadsheetId: cred.spreadsheetId, tabName: cred.tabName || 'Sheet1',
        category: cred.category || '', headerRow: cred.headerRow || 1,
        columns, rows: sheetRows, totalRows: sheetRows.length,
        statusCount, lastFetched: new Date().toISOString(),
      });
    } catch (e) {
      console.warn(`[sheets] Could not read sheet "${cred.title || cred.id}": ${e.message}`);
    }
  }
  return results;
}

function matchDevTrackerField(h) {
  const map = {
    'url':'url','website url':'url','site url':'url',
    'status':'status','state':'status',
    'development-date':'devDate','development date':'devDate','dev-date':'devDate',
    'development-updates':'devNotes','development updates':'devNotes','dev-updates':'devNotes',
    'feedbacks url':'feedbackUrl','feedback url':'feedbackUrl',
    'feedback-date':'date','feedback date':'date',
    'feedback-note':'notes','feedback notes':'notes','note':'notes',
  };
  return map[h] || null;
}
