/**
 * sheetsCache.js
 *
 * Cache for Google Sheets API reads, with STALE-WHILE-REVALIDATE semantics and
 * optional disk persistence.
 *
 * WHY: the Sheets API allows 60 reads/minute, and this dashboard's reads are one
 *      `values.get` per (spreadsheet, tab, range) — never a batchGet — spaced by
 *      a 1.4 s serial queue. So a cold read is not just slow, it is slow in
 *      sequence: N tabs cost N x 1.4 s + Google latency. The old cache was a
 *      plain 5-minute TTL held in memory: every 5 minutes the next visitor paid
 *      the full price again, every process restart emptied it, and every
 *      Cloudflare isolate started cold.
 *
 * HOW (two windows, not one):
 *   - FRESH window (default 5 min): `cacheGet` returns the value, no API call.
 *   - STALE window (default 6 h): `peekStale` RETURNS the last known value while
 *     the caller refreshes it in the background. A request never waits on Google
 *     for data it has ever seen before; it gets instant, slightly-old data and
 *     the cache heals behind it.
 *
 * The fresh window keeps normal reads honest; the stale window is the escape
 * hatch that makes navigation instant. Anything older than the stale window is
 * treated as absent and fetched synchronously, so nothing ancient is ever served.
 *
 * INVALIDATION IS STILL A HARD DELETE — that is the one place staleness is
 * unacceptable: after a write we must never serve the pre-write value, so
 * invalidateCache()/invalidateCacheForSpreadsheet() remove entries outright.
 *
 * PERSISTENCE (local only): the store is saved to data/sheets-cache.json
 * (debounced, size-capped) so a restart begins warm instead of cold. It is
 * disabled inside the Cloudflare Worker on purpose: every KV write costs against
 * the free tier's daily budget, and a Worker can build its cache from a handful
 * of reads far more cheaply than it can persist it.
 *
 * Every knob is read-only with a safe default; nothing here needs configuring:
 *   SHEETS_CACHE_TTL_MS        fresh window       (default 5 min)
 *   SHEETS_SWR_MAX_STALE_MS    stale window       (default 6 h)
 *   SHEETS_SWR=false           disable stale serving entirely
 *   SHEETS_CACHE_PERSIST=false disable the on-disk copy
 */

import fs from 'fs';
import path from 'path';
import { DATA_DIR } from './db.js';

/** Fresh window: within this age a value is served without any refresh. */
const CACHE_TTL_MS = Number(process.env.SHEETS_CACHE_TTL_MS || 5 * 60 * 1000);

/** Stale window: within this age a value is served INSTANTLY while refreshing. */
const MAX_STALE_MS = Number(process.env.SHEETS_SWR_MAX_STALE_MS || 6 * 60 * 60 * 1000);

/** Escape hatch: set SHEETS_SWR=false to restore the old fetch-on-expiry behaviour. */
const SWR_ENABLED = String(process.env.SHEETS_SWR ?? 'true').toLowerCase() !== 'false';

const isWorker = typeof globalThis !== 'undefined' && globalThis.__OFFICEOS_WORKER__ === true;

/** Disk persistence: local only (see the header comment). */
const PERSIST_ENABLED = String(process.env.SHEETS_CACHE_PERSIST ?? 'true').toLowerCase() !== 'false' && !isWorker;
const PERSIST_FILE = path.join(DATA_DIR, 'sheets-cache.json');
const PERSIST_MAX_BYTES = 4 * 1024 * 1024;
const PERSIST_DEBOUNCE_MS = 1500;

/**
 * Internal store.
 *   { [key]: { value, fetchedAt } }   fetchedAt is a Date.now() timestamp
 */
const store = {};

const stats = {
  hits: 0,
  misses: 0,
  staleServes: 0,
  refreshes: 0,
  evictions: 0,
  loadedFromDisk: 0,
  lastStaleServeAt: null,
  lastRefreshAt: null,
  persistedAt: null,
};

let loaded = false;
let saveTimer = null;
let dirty = false;

export const swrEnabled = SWR_ENABLED;
export const maxStaleMs = MAX_STALE_MS;
export const freshTtlMs = CACHE_TTL_MS;

// ─── Disk persistence ────────────────────────────────────────────────────────

/** Load the persisted store once, lazily, dropping anything past the stale window. */
function ensureLoaded() {
  if (loaded) return;
  loaded = true;
  if (!PERSIST_ENABLED) return;
  try {
    if (!fs.existsSync(PERSIST_FILE)) return;
    const raw = JSON.parse(fs.readFileSync(PERSIST_FILE, 'utf8'));
    const entries = (raw && raw.entries) || {};
    const now = Date.now();
    let kept = 0;
    for (const [key, entry] of Object.entries(entries)) {
      if (!entry || typeof entry.fetchedAt !== 'number') continue;
      if (now - entry.fetchedAt > MAX_STALE_MS) continue;
      store[key] = entry;
      kept++;
    }
    stats.loadedFromDisk = kept;
    if (kept) console.log(`[sheetsCache] warm start: ${kept} entr${kept === 1 ? 'y' : 'ies'} restored from disk`);
  } catch (e) {
    console.warn('[sheetsCache] could not read the persisted cache:', e?.message || e);
  }
}

/**
 * Persist the freshest entries that fit in the size budget. Writes atomically
 * (tmp + rename) so a crash mid-write cannot leave a truncated JSON file that
 * would make the next boot look empty.
 */
function persistNow() {
  if (!PERSIST_ENABLED || !dirty) return;
  dirty = false;
  try {
    const byAge = Object.entries(store)
      .filter(([, e]) => e && typeof e.fetchedAt === 'number')
      .sort((a, b) => b[1].fetchedAt - a[1].fetchedAt);
    const kept = {};
    let bytes = 0;
    for (const [key, entry] of byAge) {
      const chunk = JSON.stringify({ [key]: entry });
      if (bytes + chunk.length > PERSIST_MAX_BYTES) { stats.evictions++; continue; }
      kept[key] = entry;
      bytes += chunk.length;
    }
    const payload = JSON.stringify({ savedAt: Date.now(), ttlMs: CACHE_TTL_MS, maxStaleMs: MAX_STALE_MS, entries: kept });
    const tmp = `${PERSIST_FILE}.tmp`;
    fs.writeFileSync(tmp, payload, 'utf8');
    // renameSync does not exist in the Worker's fs shim; persistence is off
    // there anyway, but guard so this can never throw if it is switched on.
    if (typeof fs.renameSync === 'function') fs.renameSync(tmp, PERSIST_FILE);
    stats.persistedAt = new Date().toISOString();
  } catch (e) {
    console.warn('[sheetsCache] could not persist the cache:', e?.message || e);
  }
}

function schedulePersist() {
  if (!PERSIST_ENABLED) return;
  dirty = true;
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    persistNow();
  }, PERSIST_DEBOUNCE_MS);
  // Never hold the process open just to flush a cache file.
  if (saveTimer.unref) saveTimer.unref();
}

/** Flush immediately (used by tests and shutdown paths). */
export function flushCache() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  persistNow();
}

// ─── Cache keys ──────────────────────────────────────────────────────────────

/** Build the cache key for spreadsheet metadata (tab titles). */
export function tabTitlesCacheKey(spreadsheetId) {
  return `titles::${spreadsheetId}`;
}

/** Build the cache key for spreadsheet metadata (tab titles + gids). */
export function tabMetaCacheKey(spreadsheetId) {
  return `meta::${spreadsheetId}`;
}

/** Build the cache key for a single tab's values. */
export function tabValuesCacheKey(spreadsheetId, tabName, range) {
  return `values::${spreadsheetId}::${tabName}::${range}`;
}

// ─── Read paths ──────────────────────────────────────────────────────────────

/**
 * Retrieve a cached value if it is still FRESH.
 * Returns `undefined` on a miss or on an expired entry.
 *
 * Unlike the first version of this file, an expired entry is KEPT rather than
 * deleted — peekStale() needs it, and throwing it away is what forced the next
 * request to pay for a full API round-trip.
 */
export function cacheGet(key) {
  ensureLoaded();
  const entry = store[key];
  if (!entry) { stats.misses++; return undefined; }
  if (Date.now() - entry.fetchedAt > CACHE_TTL_MS) { stats.misses++; return undefined; }
  stats.hits++;
  return entry.value;
}

/**
 * Last known value for a key even if it has passed the fresh window, as long as
 * it is inside `maxAgeMs`. Returns null when there is nothing usable.
 *
 * This is what lets a request answer instantly with slightly-old data instead of
 * blocking on Google: see readThrough() in sheets.js.
 */
export function peekStale(key, { maxAgeMs = MAX_STALE_MS } = {}) {
  ensureLoaded();
  const entry = store[key];
  if (!entry) return null;
  const ageMs = Date.now() - entry.fetchedAt;
  if (ageMs > maxAgeMs) return null;
  return { value: entry.value, ageMs, fetchedAt: entry.fetchedAt };
}

/** Store a value in the cache (and queue a debounced save). */
export function cacheSet(key, value) {
  ensureLoaded();
  store[key] = { value, fetchedAt: Date.now() };
  schedulePersist();
}

/** Force-refresh support for a single read while preserving the shared queue. */
export function cacheDelete(key) {
  delete store[key];
  schedulePersist();
}

/** Record that a stale value was served, for the cache-status report. */
export function observeStaleServe(key, ageMs) {
  stats.staleServes++;
  stats.lastStaleServeAt = new Date().toISOString();
  stats.lastStaleKey = key;
  stats.lastStaleAgeMs = ageMs;
}

/** Record that a background/queued refresh finished, for the cache-status report. */
export function observeRefresh(key) {
  stats.refreshes++;
  stats.lastRefreshAt = new Date().toISOString();
  stats.lastRefreshKey = key;
}

/**
 * Invalidate the entire cache.
 * The next request will re-fetch everything from the Sheets API.
 */
export function invalidateCache() {
  const count = Object.keys(store).length;
  for (const key of Object.keys(store)) delete store[key];
  schedulePersist();
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
  schedulePersist();
  console.log(`[sheetsCache] Invalidated ${count} entries for spreadsheet ${spreadsheetId}.`);
}

/**
 * Returns a summary of what is currently cached (useful for debug/UI display).
 * Back-compatible with the original shape; the extra fields describe the
 * fresh/stale split and how often stale data has actually saved a request.
 */
export function getCacheStatus() {
  ensureLoaded();
  const now = Date.now();
  const entries = Object.entries(store).map(([key, entry]) => {
    const ageMs = now - entry.fetchedAt;
    const expiresInMs = Math.max(0, CACHE_TTL_MS - ageMs);
    return {
      key,
      ageMs,
      expiresInMs,
      expiresIn: `${Math.round(expiresInMs / 1000)}s`,
      stale: ageMs > CACHE_TTL_MS,
      servableStale: ageMs <= MAX_STALE_MS,
    };
  });
  const staleCount = entries.filter((e) => e.stale).length;
  return {
    ttlMs: CACHE_TTL_MS,
    entryCount: entries.length,
    swrEnabled: SWR_ENABLED,
    maxStaleMs: MAX_STALE_MS,
    freshCount: entries.length - staleCount,
    staleCount,
    persisted: PERSIST_ENABLED,
    stats: { ...stats },
    entries,
  };
}

/** Live counters only — cheaper than getCacheStatus() for logging. */
export function getCacheStats() {
  return {
    entryCount: Object.keys(store).length,
    ttlMs: CACHE_TTL_MS,
    maxStaleMs: MAX_STALE_MS,
    swrEnabled: SWR_ENABLED,
    persisted: PERSIST_ENABLED,
    ...stats,
  };
}