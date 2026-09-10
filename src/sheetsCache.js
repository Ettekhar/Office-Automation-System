/**
 * sheetsCache.js
 *
 * In-memory cache for Google Sheets API responses.
 *
 * WHY: The Sheets API has a rate limit of 60 read requests per minute per user.
 *      Every page load / preview click used to fire 2-3 API calls (listTabTitles +
 *      getTabValues for master tab + getTabValues for the report tab).  When many
 *      previews are opened quickly the quota is exhausted and the server throws 429s.
 *
 * HOW: We cache the raw API responses keyed by spreadsheetId (for tab lists) or
 *      `spreadsheetId::tabName` (for tab values).  Each entry stores the value and
 *      the time it was fetched.  Subsequent calls within the TTL window return the
 *      cached value without hitting the API.
 *
 * INVALIDATION:
 *   - Automatic: entries expire after CACHE_TTL_MS (default 5 minutes).
 *   - Manual:    call invalidateCache() or invalidateCacheForSpreadsheet(id) to
 *                force a fresh fetch on the next request (e.g. after the user edits
 *                the sheet and wants to see updated data).
 */

/** Time-to-live in milliseconds.  5 minutes keeps us well under quota. */
const CACHE_TTL_MS = Number(process.env.SHEETS_CACHE_TTL_MS || 5 * 60 * 1000);

/**
 * Internal store.
 *
 * Shape:
 *   {
 *     [cacheKey: string]: {
 *       value: any,
 *       fetchedAt: number   // Date.now() timestamp
 *     }
 *   }
 */
const store = {};

/** Build the cache key for spreadsheet metadata (tab titles). */
export function tabTitlesCacheKey(spreadsheetId) {
  return `titles::${spreadsheetId}`;
}

/** Build the cache key for a single tab's values. */
export function tabValuesCacheKey(spreadsheetId, tabName, range) {
  return `values::${spreadsheetId}::${tabName}::${range}`;
}

/**
 * Retrieve a cached value if it exists and has not expired.
 * Returns `undefined` on a cache miss.
 */
export function cacheGet(key) {
  const entry = store[key];
  if (!entry) return undefined;
  if (Date.now() - entry.fetchedAt > CACHE_TTL_MS) {
    delete store[key];
    return undefined;
  }
  return entry.value;
}

/** Store a value in the cache. */
export function cacheSet(key, value) {
  store[key] = { value, fetchedAt: Date.now() };
}

/**
 * Invalidate the entire cache.
 * The next request will re-fetch everything from the Sheets API.
 */
export function invalidateCache() {
  const count = Object.keys(store).length;
  for (const key of Object.keys(store)) {
    delete store[key];
  }
  console.log(`[sheetsCache] Full cache invalidated. Cleared ${count} entries.`);
}

/**
 * Invalidate all cache entries for a specific spreadsheet.
 */
export function invalidateCacheForSpreadsheet(spreadsheetId) {
  let count = 0;
  for (const key of Object.keys(store)) {
    if (key.includes(spreadsheetId)) {
      delete store[key];
      count++;
    }
  }
  console.log(`[sheetsCache] Invalidated ${count} entries for spreadsheet ${spreadsheetId}.`);
}

/**
 * Returns a summary of what is currently cached (useful for debug/UI display).
 */
export function getCacheStatus() {
  const now = Date.now();
  const entries = Object.entries(store).map(([key, entry]) => {
    const ageMs = now - entry.fetchedAt;
    const expiresInMs = Math.max(0, CACHE_TTL_MS - ageMs);
    return {
      key,
      ageMs,
      expiresInMs,
      expiresIn: `${Math.round(expiresInMs / 1000)}s`,
    };
  });
  return {
    ttlMs: CACHE_TTL_MS,
    entryCount: entries.length,
    entries,
  };
}
