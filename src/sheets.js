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
 */

import { google } from 'googleapis';
import { JWT } from 'google-auth-library';
import fs from 'fs';
import { config } from './config.js';
import {
  cacheGet,
  cacheSet,
  tabTitlesCacheKey,
  tabValuesCacheKey,
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
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
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
