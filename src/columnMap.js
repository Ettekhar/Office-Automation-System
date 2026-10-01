/**
 * columnMap.js — the single "any header means the canonical field" layer.
 *
 * WHY: google-sheet headers for the same concept vary everywhere ("Website",
 * "Website URL", "URL", "Domain", "Website Domain"...). Ad-hoc `findIndex` /
 * `includes` checks scattered across the codebase kept missing these and
 * silently picked wrong columns. Everything here resolves a canonical field
 * through the profile-driven alias tables in tabSchema.js (which already
 * understand "Website URL" | "URL" | "Domain" | "Site" ... → `websiteUrl`),
 * and only falls back to a conservative alias list for tabs that don't
 * match any profile.
 *
 * Purely functional, no I/O. Safe to unit-test offline.
 */

import { resolveColumns, headerKey } from './tabSchema.js';

/** Canonical keys a maintenance-family reader understands for "the website URL/domain". */
const URL_KEYS = ['websiteUrl', 'url'];

/** Alias list used when no profile matched (generic fallback), longest first. */
const URL_ALIAS_KEYS = [
  'website url', 'website domain', 'website domain url', 'web url', 'site url', 'site',
  'url', 'urls', 'domain', 'domain name', 'website',
];

/**
 * Find the index of the canonical "website URL/domain" column in a header row.
 * Tries the alias tables first (profile-aware), then the plain alias list.
 * Returns -1 when nothing matches, never guesses.
 *
 * `forcedIndex` is an explicit, source-of-truth override for tabs whose URL
 * column has a non-descriptive header (e.g. the daily-review user tabs where
 * the website column header is just " "). When supplied, it wins outright.
 */
export function findUrlColumn(headers = [], forcedIndex = null) {
  if (Number.isInteger(forcedIndex) && forcedIndex >= 0) return forcedIndex;
  if (!Array.isArray(headers)) return -1;
  const norm = headers.map((h) => headerKey(h));

  // 1. Profile-driven resolution (covers "website"/"url"/"domain"/"site" + typos)
  for (const profile of ['maintenance', 'devTracker', 'generic']) {
    const cols = resolveColumns(headers, { profile, includeExtras: false, detectMonths: false });
    for (const key of URL_KEYS) {
      if (typeof cols[key] === 'number' && cols[key] >= 0) return cols[key];
    }
  }

  // 2. Conservative alias list on the raw header keys (exact match only)
  for (const a of URL_ALIAS_KEYS) {
    const i = norm.findIndex((k) => k === a);
    if (i !== -1) return i;
  }
  // 3. Fuzzy pass: only unambiguous, website-specific substrings. Bare
  //    "link"/"domain" are deliberately excluded — they false-positive on
  //    "Booking / Reservation Link", "Domain Expiry", etc. and would route
  //    website writes into an unrelated column.
  for (const a of ['website url', 'website domain', 'website address', 'web url', 'site url']) {
    const i = norm.findIndex((k) => k.length >= 6 && k.includes(a));
    if (i !== -1) return i;
  }
  return -1;
}

/**
 * True when a cell value looks like a bare host / website address.
 * Deliberately conservative: strips scheme + www, then requires a dotted host
 * with an alphabetic TLD of 2+ chars. "CW", "To Do", "Yes" and prose never match.
 */
export function looksLikeDomain(value) {
  const s = String(value == null ? '' : value).trim();
  if (!s) return false;
  const host = s
    .replace(/^https?:\/\//i, '')
    .replace(/^\/\//, '')
    .replace(/^www\./i, '')
    .split(/[/?#]/)[0]
    .trim()
    .toLowerCase();
  if (!host || /\s/.test(host)) return false;
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host)) return false;
  return /\.[a-z]{2,}$/.test(host);
}

/**
 * resolveUserTabUrlColumn — the ONE canonical way to find the website column in
 * a Daily Review per-user tab.
 *
 * WHY THIS EXISTS (verified against the live sheet, 8/8 tabs)
 * In the Daily Review workbook the header text is actively misleading:
 *   - "Website" / "Website URL" does NOT reliably mean the domain. On Sabbir and
 *     Taion the col-0 header is a blank placeholder (" ") holding every domain,
 *     while the column literally titled "Website" holds account labels ("CW").
 *   - "Booking / Reservstion Link" also classifies as a url (tabSchema treats a
 *     standalone "link" as a url) and would capture every booking engine.
 * Header-name resolution alone therefore picks the wrong column for Sabbir (1)
 * and Taion (7). The legacy per-user hardcodes (sabbir/taion -> 0, medul -> 1)
 * were right, and they agree with a second, independent signal: the unique
 * column holding the most domain-like values.
 *
 * RESOLUTION ORDER (first signal that is unambiguous wins)
 *   1. `override`     — explicit column from the sheet-manager credential
 *                       (source of truth). Wins outright, even over detection.
 *   2. `data`         — the UNIQUE column with the most domain-like values, and
 *                       only when it clears `minDomains` with a clear
 *                       `minMargin` over the runner-up. This is what correctly
 *                       yields 0 for Sabbir/Taion and 1 for Medul.
 *   3. `fallbackIndex`— documented default for tabs whose URL column header is
 *                       a blank placeholder. Needed because once such a tab is
 *                       emptied there is no data to measure, and the header
 *                       would otherwise resolve to the "Website" account-label
 *                       column.
 *   4. `header`       — findUrlColumn(); only reaches here when the tab has too
 *                       little data to measure and no documented default.
 *   5. `unresolved`   — col: null. Callers MUST surface this as a conflict and
 *                       never fall back to a guessed index.
 *
 * Purely functional: no I/O, safe to unit-test offline.
 */
export function resolveUserTabUrlColumn({ headers = [], rows = [], override = null, fallbackIndex = null, minDomains = 3, minMargin = 3 } = {}) {
  // 1) Explicit source-of-truth override.
  if (Number.isInteger(override) && override >= 0) {
    return { col: override, via: 'override', domainCount: null, margin: null };
  }

  const data = Array.isArray(rows) ? rows : [];
  const width = Math.max(
    Array.isArray(headers) ? headers.length : 0,
    ...data.map((r) => (Array.isArray(r) ? r.length : 0)),
    0
  );

  // 2) Data-grounded: unique max domain-density column with a clear margin.
  if (width > 0) {
    const counts = new Array(width).fill(0);
    for (const r of data) {
      if (!Array.isArray(r)) continue;
      for (let c = 0; c < Math.min(width, r.length); c++) {
        if (looksLikeDomain(r[c])) counts[c]++;
      }
    }
    const max = Math.max(...counts, 0);
    if (max >= minDomains) {
      const winners = counts.map((n, c) => ({ n, c })).filter((x) => x.n === max);
      const runnerUp = Math.max(
        ...counts.filter((_, c) => c !== winners[0].c).map((n) => n),
        0
      );
      const margin = max - runnerUp;
      if (winners.length === 1 && margin >= minMargin) {
        return { col: winners[0].c, via: 'data', domainCount: max, margin, runnerUp };
      }
    }
  }

  // 3) Documented default for placeholder-header tabs (still no blind guess).
  if (Number.isInteger(fallbackIndex) && fallbackIndex >= 0) {
    return { col: fallbackIndex, via: 'documented-default', domainCount: null, margin: null };
  }

  // 4) Header-name resolution (only meaningful with too little data to measure).
  const byHeader = findUrlColumn(headers);
  if (byHeader >= 0) return { col: byHeader, via: 'header', domainCount: null, margin: null };

  // 5) Never guess.
  return { col: null, via: 'unresolved', domainCount: null, margin: null };
}

/**
 * Documented URL-column defaults for Daily Review tabs whose real website column
 * has a blank placeholder header (" ") and therefore cannot be found by name.
 *
 * Verified against the live sheet 2026-09-25: in both tabs every domain sits in
 * column 0, while the column literally titled "Website" holds account labels
 * ("CW"/"RM"). Used ONLY when there is no data to measure (an emptied tab) and
 * the sheet-manager credential supplies no override — detection always wins.
 * Keyed by lower-cased tab name. Single definition: the reconcile path and the
 * assignment write-back both read it from here.
 */
export const USER_TAB_DOCUMENTED_URL_COLUMNS = { sabbir: 0, taion: 0 };

/** Documented fallback column for a tab, or null when none is documented. */
export function getUserTabFallbackUrlColumn(tabName) {
  const key = String(tabName || '').trim().toLowerCase();
  const v = USER_TAB_DOCUMENTED_URL_COLUMNS[key];
  return Number.isInteger(v) && v >= 0 ? v : null;
}

/**
 * resolveUserTabAccountColumn — find the "account/company" column ("CW" / "RM")
 * in a Daily Review per-user tab.
 *
 * Same lesson as the URL column: the header is unreliable. On Taion the account
 * column's header is blank, on Medul the column is titled "Website" (not
 * "Company"), and on Asif there is no account column at all. So detection is
 * data-grounded first — the column whose values are overwhelmingly the account
 * labels CW/RM — and only then falls back to header text.
 *
 * @returns {{col: number|null, via: string, labelHits: number|null}}
 */
export function resolveUserTabAccountColumn({ headers = [], rows = [], urlCol = -1, minLabels = 2 } = {}) {
  const data = Array.isArray(rows) ? rows : [];
  const width = Math.max(
    Array.isArray(headers) ? headers.length : 0,
    ...data.map((r) => (Array.isArray(r) ? r.length : 0)),
    0
  );

  const isLabel = (v) => {
    const s = String(v == null ? '' : v).trim().toLowerCase();
    return s === 'cw' || s === 'rm';
  };

  // 1) Data-grounded: the column carrying the account labels.
  if (width > 0) {
    const counts = new Array(width).fill(0);
    for (const r of data) {
      if (!Array.isArray(r)) continue;
      for (let c = 0; c < Math.min(width, r.length); c++) {
        if (isLabel(r[c])) counts[c]++;
      }
    }
    const max = Math.max(...counts, 0);
    if (max >= minLabels) {
      const winners = counts.map((n, c) => ({ n, c })).filter((x) => x.n === max);
      const top = winners[0];
      // An account label must not sit in the website column.
      if (top.c !== urlCol && (winners.length === 1 || top.n > (winners.find((w) => w.c !== top.c) || { n: 0 }).n)) {
        return { col: top.c, via: 'data', labelHits: max };
      }
    }
  }

  // 2) Header fallback: "Company" or "Website" (but never the URL column).
  const byHeader = (Array.isArray(headers) ? headers : []).findIndex(
    (x, i) =>
      i !== urlCol &&
      x &&
      (String(x).toLowerCase().includes('company') || String(x).toLowerCase().includes('website'))
  );
  if (byHeader >= 0) return { col: byHeader, via: 'header', labelHits: null };

  return { col: null, via: 'unresolved', labelHits: null };
}

/**
 * Canonical data fields a Daily Review tab can carry beyond the website and
 * account/marker columns. Header matching is exact after normalization: a
 * broad substring match would confuse "Maintenance" with "Maintenance Report
 * Sent" and could write a report status into the maintenance checklist.
 *
 * This resolver never creates a header and never guesses a position. A field
 * missing from the tab is simply absent from the result, so the writer leaves
 * that cell blank.
 */
const USER_TAB_FIELD_ALIASES = {
  company: ['company', 'company name', 'client', 'client name'],
  contact: ['contact', 'contact email', 'client email', 'email'],
  accountManager: ['account manager', 'a c manager', 'ac manager', 'am'],
  maintenance: ['maintenance', 'maintenance status', 'maintenance state'],
  reportSent: ['maintenance report sent', 'report sent', 'report sent status'],
  clickup: ['clickup link', 'clickup url', 'clickup'],
  ga4: ['ga4 report', 'ga4', 'google analytics'],
  newsletter: ['newsletter mail', 'newsletter'],
  formSubmission: ['form submission mail', 'form submission'],
  clientResponse: ['smtp client response', 'client response', 'smtp'],
  booking: ['booking engine', 'booking link', 'booking reservation link', 'booking reservstion link'],
  uptime: ['uptimerobot monitoring', 'uptime robot monitoring', 'uptimerobot', 'uptime robot'],
  cloudflare: ['cloudflare issues', 'cloudflare'],
  formName: ['form name'],
};

/**
 * Resolve the recognized, writable data columns in a Daily Review tab.
 * `accountCol` is excluded because it is resolved separately and is
 * data-grounded; `Website` is intentionally not treated as company here.
 *
 * @returns {{columns: Object<string, number>, matched: Object<string, object>}}
 */
export function resolveUserTabDataColumns({ headers = [], rows = [], urlCol = -1, accountCol = -1 } = {}) {
  const cells = Array.isArray(headers) ? headers : [];
  const norm = cells.map((h) => headerKey(h));
  const columns = {};
  const matched = {};
  const reserved = new Set([urlCol, accountCol].filter((i) => Number.isInteger(i) && i >= 0));

  for (const [field, aliases] of Object.entries(USER_TAB_FIELD_ALIASES)) {
    const wanted = new Set(aliases.map((a) => headerKey(a)));
    const index = norm.findIndex((key, i) => key && wanted.has(key) && !reserved.has(i));
    if (index === -1) continue;
    columns[field] = index;
    matched[field] = { index, header: String(cells[index] ?? '').trim(), via: 'header' };
  }
  return { columns, matched };
}

/**
 * Resolve a maintenance-family tab's whole layout (status, cms, company,
 * contact, accountManager, note, websiteUrl, clickup*, report/backup urls,
 * domainExpiry, months...).
 *
 * `cols.websiteUrl` is guaranteed to be a number: when the profile resolver
 * can't claim it (weird header), `findUrlColumn` fills the gap so callers can
 * always read `cols.websiteUrl`/`cols.WEBSITE_URL` without an extra guard.
 */
export function resolveMaintenanceColumns(headers = []) {
  const cols = resolveColumns(headers || [], { profile: 'maintenance' });
  if (typeof cols.websiteUrl !== 'number' || cols.websiteUrl < 0) {
    cols.websiteUrl = findUrlColumn(headers);
  }
  cols.WEBSITE_URL = cols.websiteUrl;
  return cols;
}

/**
 * Resolve a generic/unknown sheet's layout, with the url column guaranteed.
 * Used by tabs that aren't the CW/RM master (domain expiry sheet, daily
 * review tabs): their headers are "Website URL" / "URL" / "Domain" / ...
 */
export function resolveGenericColumns(headers = []) {
  const cols = resolveColumns(headers || [], { profile: 'generic' });
  if (typeof cols.url !== 'number' || cols.url < 0) {
    cols.url = findUrlColumn(headers);
  }
  cols.WEBSITE_URL = cols.url;
  return cols;
}

/** True when a header row mentions the website/url/domain concept at all. */
export function hasUrlColumn(headers = []) {
  return findUrlColumn(headers) !== -1;
}