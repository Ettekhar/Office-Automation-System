/**
 * One tab-list lookup per Google spreadsheet, shared by every request.
 *
 * Why this module exists. Two hot routes need a maintenance spreadsheet's tab
 * titles and gids to build deep links:
 *
 *   - GET /api/master/daily-review  (the "My Sites" checklist, server.js)
 *   - the Sites overview            (dashboardApi.js)
 *
 * Both used to call sheets.listTabMeta() straight from a per-row loop behind a
 * per-row timeout, with the result cached only inside that one request. A
 * timeout left the cache empty, so the NEXT row started another full lookup:
 * N rows meant N sequential waits, and on Cloudflare - where the Sheets API is
 * slow from the worker - a handful of unlinked sites turned the My Sites view
 * into a 24-second request that looked like it would never load. The overview
 * loop was worse: no timeout at all, just an await per row.
 *
 * Here the lookup happens once per spreadsheet, concurrent callers share the
 * same in-flight promise, and failures are remembered briefly - so a broken
 * Sheets connection costs ONE bounded wait instead of one per row. Callers get
 * `null` on failure and fall back to a plain link; nothing here is fatal.
 */
import { listTabMeta } from './sheets.js';

export const TAB_META_TTL_MS = 10 * 60 * 1000;   // success: reuse for 10 minutes
export const TAB_META_FAIL_TTL_MS = 60 * 1000;  // failure: don't retry for a minute
export const TAB_META_LOOKUP_TIMEOUT_MS = 3000; // a hung Sheets API can't stall a page

const store = new Map();    // spreadsheetId -> { at, ok, titles, gidByTitle }
const inflight = new Map(); // spreadsheetId -> Promise (shared by concurrent callers)

let lookups = 0; // test/diagnostic counter: real listTabMeta attempts made

/**
 * @param {string} spreadsheetId
 * @returns {Promise<{ titles: string[], gidByTitle: Map<string, number> }|null>}
 *   `null` means "no tab list available right now" - never throws.
 */
export function getTabMetaCached(spreadsheetId) {
  const id = String(spreadsheetId || '');
  if (!id) return Promise.resolve(null);

  const hit = store.get(id);
  if (hit && Date.now() - hit.at < (hit.ok ? TAB_META_TTL_MS : TAB_META_FAIL_TTL_MS)) {
    return Promise.resolve(hit.ok ? hit : null);
  }

  const running = inflight.get(id);
  if (running) return running;

  const task = (async () => {
    try {
      lookups++;
      const tabs = await Promise.race([
        listTabMeta(id),
        new Promise((_, reject) => setTimeout(
          () => reject(new Error(`tab list timeout after ${TAB_META_LOOKUP_TIMEOUT_MS}ms`)),
          TAB_META_LOOKUP_TIMEOUT_MS,
        )),
      ]);
      const entry = {
        at: Date.now(),
        ok: true,
        titles: (tabs || []).map((t) => t.title),
        gidByTitle: new Map((tabs || []).map((t) => [t.title, t.gid])),
      };
      store.set(id, entry);
      return entry;
    } catch (e) {
      // Remember the failure: the retry is worth it (the next attempt may
      // succeed) but paying it per row is what broke the page.
      console.warn(`[tab-meta] lookup failed for ${id.slice(0, 10)}...: ${e && e.message}`);
      store.set(id, { at: Date.now(), ok: false });
      return null;
    } finally {
      inflight.delete(id);
    }
  })();

  inflight.set(id, task);
  return task;
}

/** Test hook: forget everything cached. */
export function _resetTabMetaCache() {
  store.clear();
  inflight.clear();
  lookups = 0;
}

/** Test hook: how many real lookups have been attempted. */
export function _stats() {
  return { lookups, cached: store.size, inflight: inflight.size };
}
