/**
 * monthImport.js — lightweight, non-destructive month-column import.
 *
 * WHY THIS EXISTS
 * ---------------
 * The full sync (syncFromSheets.syncAll) imports six spreadsheets and is
 * deliberately local-only: a Cloudflare Worker invocation is capped at roughly
 * 50 subrequests, so the full import dies partway through. The live dashboard
 * therefore had no way to notice a month column that was added by hand to the
 * CW/RM "Website List" tabs. The column existed in Google Sheets, but every
 * site's monthlyHistory still ended at the previous month, and the dashboard
 * showed the previous month's statuses under the new month's label.
 *
 * This module does the smallest useful part of that import:
 *   - read only CW + RM "Website List" (two reads),
 *   - merge every detected month column into the existing site records,
 *   - activate the newest month only when it is genuinely new,
 *   - write the site registry once.
 *
 * It NEVER writes to Google Sheets, never creates/deletes sites, never touches
 * daily-review rows (so per-user `hidden` flags and assignments are safe), and
 * is idempotent. A blank month column becomes a blank monthlyHistory entry,
 * which is exactly what makes the dashboard show that month as pending rather
 * than leaking the previous month's completed statuses.
 */

import { getTabValues } from './sheets.js';
import { findHeaderRow, detectColumns } from './reportUtils.js';
import { findExactMonthlyHistoryEntry, parseMonthLabel } from './maintenanceStatus.js';
import { monthHeaderInfo } from './tabSchema.js';
import { getAccountConfig } from './config.js';
import {
  cleanDomainUrl,
  getActiveMonth,
  getMeta,
  getSites,
  getSheetCredentials,
  setMeta,
  setSites,
} from './db.js';

const ACCOUNT_KEYS = { CW: 'CW_MAINTENANCE', RM: 'RM_MAINTENANCE' };
const RANGE = 'A1:ZZ2000';

let inFlight = null;

function resolveSheet(account) {
  const key = ACCOUNT_KEYS[account];
  let credential = null;
  try {
    credential = (getSheetCredentials() || []).find(c => c.key === key || c.id === key) || null;
  } catch {}

  if (credential && credential.active === false) return null;

  const spreadsheetId =
    credential?.spreadsheetId ||
    process.env[`${account}_SPREADSHEET_ID`] ||
    '';
  if (!spreadsheetId) return null;

  const tabName =
    credential?.tabName ||
    getAccountConfig(account).masterTabName ||
    'Website List';

  return { spreadsheetId, tabName };
}

function monthKey(label) {
  const raw = String(label ?? '').trim();
  if (!raw) return '';
  const info = monthHeaderInfo(raw);
  if (info) return `${info.year ?? ''}:${info.monthIndex}`;
  const parsed = parseMonthLabel(raw);
  if (parsed) {
    const names = ['january', 'february', 'march', 'april', 'may', 'june',
      'july', 'august', 'september', 'october', 'november', 'december'];
    return `${parsed.year ?? ''}:${names.indexOf(parsed.name)}`;
  }
  return `raw:${raw.toLowerCase()}`;
}

function monthRank(label) {
  const info = monthHeaderInfo(label);
  if (info) return (info.year ?? 0) * 12 + info.monthIndex;
  const parsed = parseMonthLabel(label);
  if (parsed) {
    const names = ['january', 'february', 'march', 'april', 'may', 'june',
      'july', 'august', 'september', 'october', 'november', 'december'];
    return (Number(parsed.year) || 0) * 12 + names.indexOf(parsed.name);
  }
  return -1;
}

function sameMonth(a, b) {
  const ka = monthKey(a);
  const kb = monthKey(b);
  return !!ka && ka === kb;
}

/**
 * Import month columns from the live CW/RM masters into the site registry.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.dryRun]   compute changes without writing DB/KV.
 * @param {boolean} [opts.force]    bypass the Sheets read cache for this pass.
 * @param {boolean} [opts.activate] activate the newest month when it is new
 *                                  (default true).
 */
export function importMonthColumns(opts = {}) {
  if (inFlight) return inFlight;
  inFlight = runImport(opts).finally(() => { inFlight = null; });
  return inFlight;
}

async function runImport(opts = {}) {
  const dryRun = opts.dryRun === true;
  const force = opts.force === true;
  const activate = opts.activate !== false;

  const accounts = [];

  for (const account of ['CW', 'RM']) {
    const sheet = resolveSheet(account);
    if (!sheet) continue;

    let rows = [];
    try {
      rows = await getTabValues(sheet.tabName, RANGE, sheet.spreadsheetId, { force }) || [];
    } catch (e) {
      console.warn(`[month-import] ${account} read failed:`, e?.message || e);
      continue;
    }
    if (!rows || rows.length < 2) continue;

    const { headerRow, headerRowIndex } = findHeaderRow(rows);
    const cols = detectColumns(headerRow);
    const months = (cols.MONTHS || [])
      .map(m => ({ index: m.index, label: String(m.label ?? '').trim() }))
      .filter(m => m.label);
    if (!months.length) continue;

    const urlCol = cols.WEBSITE_URL;
    if (typeof urlCol !== 'number' || urlCol < 0) continue;

    const latest = months[months.length - 1];
    const byUrl = new Map();

    for (const row of rows.slice(headerRowIndex + 1)) {
      const urlKey = cleanDomainUrl(row[urlCol]);
      if (!urlKey) continue;
      byUrl.set(urlKey, {
        months: months.map(m => ({
          month: m.label,
          status: String(row[m.index] ?? '').trim(),
        })),
        latestLabel: latest.label,
        latestStatus: String(row[latest.index] ?? '').trim(),
      });
    }

    accounts.push({
      account,
      sheetId: sheet.spreadsheetId,
      tabName: sheet.tabName,
      months,
      latest,
      byUrl,
    });
  }

  if (!accounts.length) {
    return { ok: false, reason: 'no readable maintenance sheets', changedSites: 0, totalSites: 0 };
  }

  // The newest column is the rightmost one in the sheet. Both masters append
  // months left-to-right; use the month label itself to break ties when one
  // sheet is ahead of the other.
  const newest = accounts
    .map(a => a.latest)
    .filter(Boolean)
    .sort((a, b) => monthRank(b.label) - monthRank(a.label))[0] || null;

  const sites = getSites();

  // A month is "new" when the site registry has not yet absorbed it. Do NOT
  // use meta.months as the signal: meta can list a month that was selected in
  // the UI (or added by an older code path) while every site still lacks the
  // monthlyHistory entry. Coverage is the thing that actually matters.
  const covered = newest
    ? sites.filter(s => (s.monthlyHistory || []).some(h => sameMonth(h.month, newest.label))).length
    : 0;
  const isNewMonth = !!newest && sites.length > 0 &&
    covered < Math.max(1, Math.floor(sites.length * 0.5));

  let changedSites = 0;
  const readableAccounts = new Set(accounts.map(a => a.account));

  const updated = sites.map(site => {
    const urlKey = cleanDomainUrl(site.url);
    if (!urlKey) return site;

    const preferred = accounts.find(a => a.account === (site.account || 'CW'));
    const account = (preferred && preferred.byUrl.has(urlKey))
      ? preferred
      : accounts.find(a => a.byUrl.has(urlKey));
    const row = account?.byUrl.get(urlKey);

    if (!row) {
      // A newly detected month is a fresh period for every site, including a
      // site that is no longer present in its master tab. addNewMonth() has
      // always seeded a blank entry for all sites; do the same here, but only
      // for accounts whose sheet was actually read. Otherwise a failed RM read
      // would silently blank RM sites that still have real October data.
      if (!isNewMonth || !newest) return site;
      if (!readableAccounts.has(site.account || 'CW')) return site;
      const history = (Array.isArray(site.monthlyHistory) ? site.monthlyHistory : [])
        .map(h => ({ ...h }));
      if (findExactMonthlyHistoryEntry(history, newest.label)) return site;
      history.push({ month: newest.label, status: '' });
      changedSites++;
      return {
        ...site,
        monthlyHistory: history,
        latestMonth: newest.label,
        latestMonthStatus: '',
        updatedAt: new Date().toISOString(),
      };
    }

    const history = (Array.isArray(site.monthlyHistory) ? site.monthlyHistory : [])
      .map(h => ({ ...h }));
    let changed = false;

    for (const m of row.months) {
      const existing = findExactMonthlyHistoryEntry(history, m.month);
      if (existing) {
        if (String(existing.status ?? '').trim() !== m.status) {
          existing.status = m.status;
          changed = true;
        }
      } else {
        history.push({ month: m.month, status: m.status });
        changed = true;
      }
    }

    const latestLabel = row.latestLabel || site.latestMonth || '';
    const latestStatus = row.latestStatus;
    if (
      String(site.latestMonth ?? '') !== String(latestLabel) ||
      String(site.latestMonthStatus ?? '') !== String(latestStatus)
    ) {
      changed = true;
    }

    if (!changed) return site;
    changedSites++;
    return {
      ...site,
      monthlyHistory: history,
      latestMonth: latestLabel,
      latestMonthStatus: latestStatus,
      updatedAt: new Date().toISOString(),
    };
  });

  if (!dryRun && changedSites > 0) setSites(updated);

  const shouldActivate = !dryRun && activate && isNewMonth;
  if (shouldActivate) {
    const meta = getMeta();
    const months = Array.isArray(meta.months) ? [...meta.months] : [];
    if (!months.some(m => sameMonth(m, newest.label))) months.push(newest.label);
    setMeta({
      ...meta,
      activeMonth: newest.label,
      months,
      // Display hint for GET /daily-review: the stored per-user value belongs
      // to an earlier month, so a blank column in this newly imported month
      // must render as pending instead of restoring the old value on the
      // response. Nothing is written to the sheet or the daily-review store.
      activeMonthFresh: newest.label,
      lastMonthAdded: newest.label,
      lastMonthAddedAt: new Date().toISOString(),
    });
  }

  return {
    ok: true,
    dryRun,
    changedSites,
    totalSites: sites.length,
    newestMonth: newest?.label || null,
    newMonth: isNewMonth,
    activated: shouldActivate,
    activeMonth: shouldActivate ? newest.label : getActiveMonth(),
    monthLabels: Array.from(new Set(accounts.flatMap(a => a.months.map(m => m.label)))),
    accounts: accounts.map(a => ({
      account: a.account,
      months: a.months.length,
      rows: a.byUrl.size,
      latest: a.latest?.label || null,
    })),
  };
}
