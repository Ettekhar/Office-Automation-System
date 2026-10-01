/**
 * syncFromSheets.js — imports all 6 sheets, merges into relational DB
 *
 * Merge logic:
 *  1. Seed users from DAILY_REVIEW_USERS list (preserve roles if users already exist)
 *  2. Import sites from CW+RM "Website List" tabs → base site records
 *  3. Import Domain Expiry Sheet → merge into sites by URL similarity
 *  4. Import each user's Daily Review tab → create DailyReview rows, assign users to sites
 *  5. Import Distribution sheet → create Task records linked to sites + users
 *  6. Import Property Registry → create Property records linked to users
 *  7. Import Dev Tracker tabs → create DevProject records
 */

import { getTabValues, listTabTitles, listTabMeta, fetchDevTrackerSheetData } from './sheets.js';
import { findHeaderRow, detectColumns, findMatchingTab } from './reportUtils.js';
import { resolveMaintenanceColumns, resolveGenericColumns, findUrlColumn, resolveUserTabUrlColumn, resolveUserTabAccountColumn, getUserTabFallbackUrlColumn } from './columnMap.js';
import { getAccountConfig } from './config.js';
import { runDataQualityChecks, formatDataQualityReport } from './dataQuality.js';
import {
  uuid, setUsers, setSites, setDailyReview, setTasks, setProperties, setDevProjects, setMeta,
  getUsers, getSites, cleanDomainUrl, dbRead, dbWrite, getSheetCredentials,
  recordSyncConflict, appendAuditLog, resolveUserByName,
} from './db.js';

const RANGE = 'A1:ZZ2000';

const SHEET_IDS_FALLBACK = {
  MASTER_TRACKER:    '1VnI5ZxVr5QykBOwYDOLp_1bbCpApfc0Jwljf01Q7djU',
  // NOTE: no stale hardcoded DAILY_REVIEW id here on purpose. The sheet-manager
  // credential (data/sheet-credentials.json) is the single source of truth; a
  // wrong literal would silently sync against the wrong spreadsheet if the
  // credential were ever missing. An empty value makes that failure loud.
  DAILY_REVIEW:      '',
  PROPERTY_REGISTRY: '1sWz7sNsQmi0xigD2AiMbxbC0lHDbKyQIGOB_jrrNJzY',
  DEV_TRACKER:       '14PXRHUkFG-gf0DwbGVqeyPA7aQ4LyhDMjAeTVatOI78',
  CW_MAINTENANCE:    '19aIBNOb0C4_Fx47bsZ2mUMVAxogX7j_tly8tSg-bldE',
  RM_MAINTENANCE:    '1Fbb-SY2fU0HXFdnJ_OQoHb_AwlFzdk39jWOo3kFMcjY',
};

export function getSheetId(key) {
  try {
    const creds = getSheetCredentials();
    const item = creds.find(c => c.key === key || c.id === key);
    if (item && item.spreadsheetId) return item.spreadsheetId;
  } catch {}
  return SHEET_IDS_FALLBACK[key] || '';
}

export function isSheetActive(key) {
  try {
    const creds = getSheetCredentials();
    const item = creds.find(c => c.key === key || c.id === key);
    if (item) return item.active !== false;
  } catch {}
  return true;
}

export const SHEET_IDS = new Proxy(SHEET_IDS_FALLBACK, {
  get(target, prop) {
    return getSheetId(prop) || target[prop];
  }
});


export const DEFAULT_USERS = [
  { name: 'Toufiq',  role: 'superadmin', email: '' },
  { name: 'Sabbir',  role: 'user', email: '' },
  { name: 'Taion',   role: 'user', email: '' },
  { name: 'Medul',   role: 'user', email: '' },
  { name: 'Saiful',  role: 'user', email: '' },
  { name: 'Tarikul', role: 'user', email: '' },
  { name: 'Roeich',  role: 'user', email: '' },
  { name: 'Asif',    role: 'user', email: '' },
];

let _progress = null;
export function onProgress(fn) { _progress = fn; }
function report(step, pct) {
  if (_progress) _progress(step, pct);
  console.log(`[sync] ${pct}% — ${step}`);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────
function hi(headers, ...candidates) {
  for (const c of candidates) {
    const i = headers.findIndex(h => h && h.toLowerCase().includes(c.toLowerCase()));
    if (i !== -1) return i;
  }
  return -1;
}

function normUrl(raw) {
  if (!raw) return '';
  return raw.trim().toLowerCase().replace(/\/+$/, '');
}

function urlMatch(a, b) {
  const clean = u => (u || '').toLowerCase()
    .replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/+$/, '').trim();
  return clean(a) === clean(b);
}

function normStatus(raw) {
  if (!raw) return 'pending';
  const s = raw.toLowerCase().trim();
  if (s.includes('completed') || s.includes('updated & backup') || s.includes('updated and backup')) return 'completed';
  if (s.includes('in progress')) return 'in_progress';
  if (s.includes('to do') || s.includes('todo')) return 'todo';
  return s;
}

function daysUntil(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  if (isNaN(d)) return null;
  return Math.ceil((d - new Date()) / 86400000);
}

function now() { return new Date().toISOString(); }

// ─── Sync context: dry-run + conflict collection ─────────────────────────────
// One ctx per syncAll() call. `dryRun` means: compute everything, persist
// nothing (not even conflicts/audit). Conflicts found during a dry-run are
// collected in ctx.conflicts and returned in the report instead of written.
function makeCtx({ dryRun = false } = {}) {
  return { dryRun: !!dryRun, conflicts: [], auditWritten: 0, dataQuality: null };
}

/**
 * Flag a divergence between the sheet and the DB instead of silently picking.
 * Real sync → persists into data/sync-conflicts.json (+ one audit entry the
 * first time a given conflict is seen). Dry-run → collected in memory only.
 */
function flagConflict(ctx, { entity, entityId, label, field, sheetValue, dbValue, sheetSource, dbSource, policy = 'keep-sheet' }) {
  const entry = {
    entity, entityId, label, field,
    sheetValue: sheetValue == null ? '' : sheetValue,
    dbValue: dbValue == null ? '' : dbValue,
    sheetSource, dbSource, policy,
  };
  if (ctx.dryRun) {
    ctx.conflicts.push(entry);
    return entry;
  }
  // A real sync ALSO reports what it flagged. Previously only the dry-run branch
  // pushed onto ctx.conflicts, so a real run persisted every conflict to
  // data/sync-conflicts.json and audited it, yet still answered
  // `conflictsCount: 0` — the response understated what had just changed.
  ctx.conflicts.push(entry);
  const existing = (dbRead('sync-conflicts') || []).find(c =>
    c.entity === entity && c.entityId === entityId && c.field === field
  );
  const stored = recordSyncConflict(entry);
  if (!existing) {
    ctx.auditWritten++;
    try {
      appendAuditLog({
        actor: 'sync', action: 'conflict', entity, entityId, label,
        field, oldValue: String(dbValue), newValue: String(sheetValue),
        source: 'Sheets Sync', reason: `Sheet and DB disagree on ${field} — flagged, ${policy} applied`,
      });
    } catch {}
  }
  return stored;
}

// Provenance metadata every imported record carries (source sheet + row).
function provenance(sheetKey, tabName, rowNumber) {
  return {
    source: `sheet:${sheetKey}`,
    sourceTab: tabName,
    sourceRow: rowNumber, // 1-based spreadsheet row (header-aware)
    lastSeenAt: now(),
  };
}

// True when both values are non-empty AND meaningfully different — the only
// shape worth flagging as a conflict (blank-vs-value is "preserve", not conflict).
function realConflict(sheetVal, dbVal) {
  const sv = String(sheetVal ?? '').trim();
  const dv = String(dbVal ?? '').trim();
  if (!sv || !dv) return false;
  return sv.toLowerCase() !== dv.toLowerCase();
}

// ─── Step 1: Seed Users ───────────────────────────────────────────────────────
function seedUsers(ctx = makeCtx()) {
  report('Seeding users…', 2);

  // Load existing users safely — filter out any malformed entries
  const existing = (getUsers() || []).filter(u => u != null && typeof u.name === 'string' && u.name.length > 0);
  const existingMap = {};
  for (const u of existing) {
    existingMap[u.name.toLowerCase()] = u;
  }

  const merged = DEFAULT_USERS.map(du => {
    const key = du.name.toLowerCase();
    const ex = existingMap[key];
    if (ex) return { ...ex, email: ex.email || du.email };
    return { id: uuid(), name: du.name, role: du.role, email: du.email, createdAt: now(), updatedAt: now() };
  });

  // Dry-run never writes to the DB (the point is "report only, no writes").
  if (!ctx.dryRun) setUsers(merged);
  const userMap = {};
  for (const u of merged) userMap[u.name.toLowerCase()] = u;
  return userMap;
}

// ─── Step 2: Import Sites from CW + RM Website Lists ─────────────────────────
async function importSites(ctx = makeCtx()) {
  report('Importing CW sites…', 5);
  const sites = [];

  // Reuse the existing site registry as the identity anchor: a full sync must
  // NOT regenerate brand-new IDs for URLs that already exist (that is what
  // silently dropped UI assignments). Existing records are looked up by
  // normalized URL, their stable `id` and DB-owned fields (assignedUsers,
  // manual notes, etc.) are preserved, and sheet-owned columns are refreshed.
  const existingSites = getSites();
  const existingById = new Map(existingSites.map(s => [s.id, s]));
  const existingByUrl = new Map();
  for (const s of existingSites) {
    const key = cleanDomainUrl(s.url);
    if (key && !existingByUrl.has(key)) existingByUrl.set(key, s);
  }
  // Ids that were seen again in the CW/RM sheets this run. Anything else in the
  // registry is kept (soft-delete policy) but NOT re-added as a duplicate.
  const matchedIds = new Set();

  const processSheet = async (sheetId, account, progressStart) => {
    const sheetKey = account === 'CW' ? 'CW_MAINTENANCE' : 'RM_MAINTENANCE';
    const rows = await getTabValues('Website List', RANGE, sheetId);
    if (!rows || rows.length < 3) return;

    // Header row is FOUND, not assumed: these sheets have a note/banner in row 1
    // and the real header in row 2 (db.js stores headerRow: 2 for them).
    const { headerRow, headerRowIndex } = findHeaderRow(rows);
    const cols = detectColumns(headerRow);

    const urlCol = cols.WEBSITE_URL;
    const cmsCol = cols.CMS;
    const compCol = cols.COMPANY;
    const contCol = cols.CONTACT;
    const acmCol = cols.AM;
    const noteCol = cols.NOTE;
    const cuCol = cols.CLICKUP_URL;
    const timeTrackCol = cols.TIME_TRACK_URL;
    const reportCol = cols.REPORT_URL;
    const backupCol = cols.BACKUP_URL;

    // Month columns come from the shared resolver (year-aware, typo-tolerant:
    // "Augus 23", "February24", "octobor" are all understood).
    const monthCols = (cols.MONTHS || []).map((m) => ({ i: m.index, label: m.label }));
    const latestMonth = monthCols[monthCols.length - 1];

    rows.slice(headerRowIndex + 1).forEach((r, rowIdx) => {
      const url = (r[urlCol] || '').trim();
      if (!url) return;
      // Row's actual spreadsheet row number (1-based, header-aware).
      const sheetRow = headerRowIndex + rowIdx + 2;
      // Any column the profile didn't map (someone added it by hand) is kept
      // as-is, so a new column shows up on the site record with no code change.
      const extra = {};
      (cols.EXTRAS || []).forEach(({ key, index }) => {
        extra[key] = String(r[index] ?? '').trim();
      });

      const urlKey = cleanDomainUrl(url);
      const existing = existingByUrl.get(urlKey);
      const id = existing ? existing.id : uuid();

      const sheetOwned = {
        url,
        account,
        status: (r[cols.STATUS] || 'Active').trim(),
        cms: r[cmsCol] || '',
        company: r[compCol] || account,
        contact: r[contCol] || '',
        accountManager: r[acmCol] || '',
        note: r[noteCol] || '',
        clickupUrl: r[cuCol] || '',
        clickupTimeTrackUrl: r[timeTrackCol] || '',
        reportUrl: r[reportCol] || '',
        backupUrl: r[backupCol] || '',
        extra,
        latestMonth: latestMonth?.label || '',
        latestMonthStatus: latestMonth ? (r[latestMonth.i] || '') : '',
        monthlyHistory: monthCols.map(mc => ({ month: mc.label, status: r[mc.i] || '' })),
        ...provenance(sheetKey, 'Website List', sheetRow),
      };

      if (existing) {
        matchedIds.add(existing.id);
        // Refreshed sheet columns on top of the stable record. DB-owned fields
        // (id, assignedUsers, domainExpiry, uptime state, createdAt) survive.
        // CONFLICT POLICY: fields the UI can edit (clickupUrl, clickupTimeTrackUrl)
        // are flagged when the sheet disagrees with a previously stored
        // non-empty value — never silently overwritten without a record.
        if (realConflict(sheetOwned.clickupUrl, existing.clickupUrl)) {
          flagConflict(ctx, {
            entity: 'site', entityId: existing.id, label: url, field: 'clickupUrl',
            sheetValue: sheetOwned.clickupUrl, dbValue: existing.clickupUrl,
            sheetSource: `sheet:${sheetKey}`, dbSource: existing.source || 'db',
          });
        }
        if (realConflict(sheetOwned.clickupTimeTrackUrl, existing.clickupTimeTrackUrl)) {
          flagConflict(ctx, {
            entity: 'site', entityId: existing.id, label: url, field: 'clickupTimeTrackUrl',
            sheetValue: sheetOwned.clickupTimeTrackUrl, dbValue: existing.clickupTimeTrackUrl,
            sheetSource: `sheet:${sheetKey}`, dbSource: existing.source || 'db',
          });
        }
        const merged = {
          ...existing,
          ...sheetOwned,
          updatedAt: now(),
          domainExpiry: existing.domainExpiry || '',
          daysLeft: existing.daysLeft ?? null,
          assignedUsers: Array.isArray(existing.assignedUsers) ? existing.assignedUsers : [],
          uptimeStatus: existing.uptimeStatus || 'unknown',
          lastUptimeCheck: existing.lastUptimeCheck || null,
        };
        sites.push(merged);
        return;
      }

      sites.push({
        id,
        ...sheetOwned,
        // Will be filled in later steps:
        domainExpiry: '', daysLeft: null,
        assignedUsers: [],
        uptimeStatus: 'unknown', lastUptimeCheck: null,
        createdAt: now(), updatedAt: now(),
      });
    });

    // Per-site sheet link backfill: when the account's "Website List" has no
    // REPORT_URL column (RM has none), or a site's cell is empty, resolve the
    // site's own tab in that account's spreadsheet (tabs are named after the
    // website URL) and store a deep link: ...edit#gid={tabGid}.
    if (reportCol < 0) {
      try {
        const tabs = await listTabMeta(sheetId);
        const titles = tabs.map(t => t.title);
        const gidByTitle = new Map(tabs.map(t => [t.title, t.gid]));
        const masterTabName = getAccountConfig(account).masterTabName;
        sites.filter(s => s.account === account && !s.reportUrl).forEach(s => {
          const matched = findMatchingTab(titles, s.url, masterTabName);
          const gid = matched ? gidByTitle.get(matched) : undefined;
          if (matched && gid !== undefined) {
            s.reportUrl = `https://docs.google.com/spreadsheets/d/${sheetId}/edit#gid=${gid}`;
          }
        });
      } catch (e) {
        console.warn(`[sync] per-site sheet link backfill failed for ${account}: ${e.message}`);
      }
    }
    report(`Imported ${account} sites (${sites.filter(s => s.account === account).length})`, progressStart);
  };

  if (isSheetActive('CW_MAINTENANCE')) {
    await processSheet(SHEET_IDS.CW_MAINTENANCE, 'CW', 10);
  } else {
    report('CW Maintenance sheet is inactive (skipped)', 10);
  }

  if (isSheetActive('RM_MAINTENANCE')) {
    report('Importing RM sites…', 12);
    await processSheet(SHEET_IDS.RM_MAINTENANCE, 'RM', 15);
  } else {
    report('RM Maintenance sheet is inactive (skipped)', 15);
  }

  // Soft-delete policy, applied ONCE after both sheets are read: records that
  // existed in the registry but were NOT seen in either CW or RM sheet this run
  // are kept as-is (they may live in another sheet, or matching failed). They
  // are never silently dropped, and — because matchedIds tracks what WAS seen —
  // they are never duplicated either.
  for (const s of existingById.values()) {
    if (!matchedIds.has(s.id) && !sites.some(x => x.id === s.id)) {
      sites.push(s);
    }
  }

  // Dedupe by stable id — a legacy DB record re-added for one account must not
  // appear twice even if the same URL shows up in the other account's sheet.
  const seenIds = new Set();
  return sites.filter(s => {
    if (seenIds.has(s.id)) return false;
    seenIds.add(s.id);
    return true;
  });
}

// ─── Step 3: Merge Domain Expiry into Sites ───────────────────────────────────
async function mergeDomains(sites, ctx = makeCtx()) {
  report('Merging domain expiry…', 18);
  try {
    const rows = await getTabValues('Domain Expiration Sheet', RANGE, SHEET_IDS.MASTER_TRACKER);
    if (!rows || rows.length < 2) return;
    // Column mapping goes through the canonical alias layer ("Website",
    // "Website URL", "URL", "Domain" all resolve to the same field) instead of
    // ad-hoc `findIndex` guesses — see columnMap.js. The domain sheet carries
    // maintenance-style headers, so the maintenance profile resolves them; the
    // url column additionally accepts "Domain"/"URL" via findUrlColumn.
    const maintCols = resolveMaintenanceColumns(rows[0]);
    const urlCol    = maintCols.websiteUrl !== -1 ? maintCols.websiteUrl : findUrlColumn(rows[0]);
    const expiryCol = maintCols.domainExpiry >= 0
      ? maintCols.domainExpiry
      : hi(rows[0], 'domain expiry', 'domain expire', 'expiry');
    const acmCol    = maintCols.accountManager >= 0 ? maintCols.accountManager : hi(rows[0], 'a/c manager', 'account manager');
    const compCol   = maintCols.company >= 0 ? maintCols.company : hi(rows[0], 'company');
    const cmsCol    = maintCols.cms >= 0 ? maintCols.cms : hi(rows[0], 'cms');
    const contCol   = maintCols.contact >= 0 ? maintCols.contact : hi(rows[0], 'contact');
    if (urlCol === -1) return;

    rows.slice(1).forEach((r, rowIdx) => {
      const domainUrl = (r[urlCol] || '').trim();
      if (!domainUrl) return;
      const expiry = r[expiryCol] || '';
      const days = daysUntil(expiry);

      // Match to existing site by URL similarity
      const site = sites.find(s => urlMatch(s.url, domainUrl));
      if (site) {
        // Conflict policy: only flagged when the sheet's expiry is non-empty
        // and differs from a previously stored non-empty value. The sheet is
        // authoritative for domain expiry (D1), so the sheet wins — but the
        // divergence is recorded, never silent.
        if (realConflict(expiry, site.domainExpiry)) {
          flagConflict(ctx, {
            entity: 'site', entityId: site.id, label: site.url, field: 'domainExpiry',
            sheetValue: expiry, dbValue: site.domainExpiry,
            sheetSource: 'sheet:MASTER_TRACKER', dbSource: site.source || 'db',
            policy: 'keep-sheet',
          });
        }
        site.domainExpiry = expiry;
        site.daysLeft = days;
        if (!site.accountManager) site.accountManager = r[acmCol] || '';
        if (!site.contact) site.contact = r[contCol] || '';
        if (!site.cms) site.cms = r[cmsCol] || '';
        if (!site.company) site.company = r[compCol] || '';
      }
      // Domain entry may not have a matching site (new site not yet in maint list) — skip
    });
  } catch (e) { console.error('[sync] domain merge failed:', e.message); }
  report('Domain expiry merged', 22);
}

// ─── Step 4: Import Daily Review + Assign Users to Sites ─────────────────────
async function importDailyReview(sites, userMap, ctx = makeCtx()) {
  report('Importing daily review…', 25);
  const drRows = [];
  // Current rows from the DB, matched by (siteId,userId) below so a full sync
  // keeps stable row IDs and preserves UI-entered values where cells are blank.
  const existingDrRows = dbRead('daily-review') || [];
  // Normalize legacy object-format data (old daily-review.json could be keyed by
  // user name instead of an array).
  const existingDrList = Array.isArray(existingDrRows) ? existingDrRows : Object.values(existingDrRows).flat();
  // Lookup by (siteId,userId) for O(1) merge below.
  const existingDrByKey = new Map();
  for (const r of existingDrList) {
    if (r.siteId && r.userId && !existingDrByKey.has(`${r.siteId}::${r.userId}`)) {
      existingDrByKey.set(`${r.siteId}::${r.userId}`, r);
    }
  }

  // URL→id lookup against the existing registry, so a URL that was created via
  // the UI (not yet in the CW/RM Website List) keeps its stable id here too.
  const existingSiteByUrl = new Map();
  for (const s of getSites()) {
    const key = cleanDomainUrl(s.url);
    if (key && !existingSiteByUrl.has(key)) existingSiteByUrl.set(key, s);
  }
  const users = DEFAULT_USERS.map(du => ({
    ...du, ...(Object.values(userMap).find(u => u?.name?.toLowerCase() === du.name.toLowerCase()) || {}),
  }));

  for (let i = 0; i < users.length; i++) {
    const user = users[i];
    const dbUser = userMap[user.name.toLowerCase()];
    if (!dbUser) continue;

    try {
      const rows = await getTabValues(user.name, RANGE, SHEET_IDS.DAILY_REVIEW);
      if (!rows || rows.length < 2) continue;

      const h = rows[0];

      // Canonical website-column resolution — the SAME resolver the reconcile
      // and assignment write-back paths use. Replaces the per-user hardcodes
      // (medul -> 1, sabbir/taion -> 0), which existed only because the
      // header-name resolver mis-picked the column: on Sabbir the column titled
      // "Website" holds account labels ("CW") and on Taion "Booking /
      // Reservstion Link" classifies as a url. Verified 2026-09-25: identical
      // results on all 8 live tabs, with both traps closed.
      const urlResolution = resolveUserTabUrlColumn({
        headers: h,
        rows: rows.slice(1),
        fallbackIndex: getUserTabFallbackUrlColumn(user.name),
      });
      const urlCol = urlResolution.col == null ? -1 : urlResolution.col;
      if (urlCol === -1) {
        console.warn(
          `[sync] "${user.name}" website column unresolved (${urlResolution.via}) — rows in this tab will be skipped, not guessed`
        );
      }
      // Account/company column: the column carrying the "CW"/"RM" labels. Header
      // text is unreliable (Taion's is blank, Medul's says "Website", Asif has no
      // such column), so it is detected from the data with a header fallback.
      // Excluding urlCol matters on Medul, where "Website URL" (col 1) and
      // "Website" (col 2) sit next to each other.
      const accountResolution = resolveUserTabAccountColumn({ headers: h, rows: rows.slice(1), urlCol });
      const coCol = accountResolution.col == null ? -1 : accountResolution.col;

      const maintCol = h.findIndex(x => x && x.trim().toLowerCase() === 'maintenance') !== -1
        ? h.findIndex(x => x && x.trim().toLowerCase() === 'maintenance')
        : hi(h, 'maintenance');
      const sentCol  = hi(h, 'maintenance report sent', 'report sent');
      const ga4Col   = hi(h, 'ga4');
      const newsCol  = hi(h, 'newsletter');
      const formCol  = hi(h, 'form submission', 'form name');
      const bookCol  = h.findIndex(x => x && (x.toLowerCase().includes('booking') || x.toLowerCase().includes('reservation') || x.toLowerCase().includes('engine')));
      const cfCol    = hi(h, 'cloudflare');
      const cuCol    = hi(h, 'clickup');
      const respCol  = hi(h, 'client response', 'smtp');
      const uptimeCol= hi(h, 'uptimerobot', 'uptime');

      rows.slice(1).forEach((r, rowIdx) => {
        let rawUrl = (urlCol >= 0 ? (r[urlCol] || '') : '').trim();
        // Fallback to col 0 only if empty and col 0 is a domain and not a row number
        if (!rawUrl && r[0] && r[0].includes('.') && isNaN(r[0])) {
          rawUrl = r[0].trim();
        }
        if (!rawUrl || rawUrl === '-' || rawUrl.length < 4 || !rawUrl.includes('.')) return;

        // Ensure proper protocol
        if (!/^https?:\/\//i.test(rawUrl)) {
          rawUrl = 'https://' + rawUrl;
        }

        const compVal = (coCol >= 0 && r[coCol])
          ? r[coCol].trim()
          : (r.find(c => typeof c === 'string' && (c.trim() === 'CW' || c.trim() === 'RM')) || '');

        // Find or create the site record
        let site = sites.find(s => urlMatch(s.url, rawUrl));
        if (!site) {
          // If the URL lives in the DB registry (e.g. added via the UI but not
          // yet appearing in the CW/RM "Website List"), reuse its stable id and
          // manual fields instead of minting a new id every sync.
          const urlKey = cleanDomainUrl(rawUrl);
          const known = existingSiteByUrl.get(urlKey) || null;
          site = {
            id: known ? known.id : uuid(),
            url: rawUrl,
            account: known?.account || compVal || 'CW',
            status: known?.status || 'Active',
            cms: known?.cms || '', company: known?.company || compVal || '', contact: known?.contact || '',
            accountManager: known?.accountManager || '',
            note: known?.note || '', clickupUrl: (cuCol >= 0 ? r[cuCol] : '') || known?.clickupUrl || '', reportUrl: known?.reportUrl || '', backupUrl: known?.backupUrl || '',
            latestMonth: known?.latestMonth || '', latestMonthStatus: known?.latestMonthStatus || '', monthlyHistory: known?.monthlyHistory || [],
            domainExpiry: known?.domainExpiry || '', daysLeft: known?.daysLeft ?? null,
            assignedUsers: Array.isArray(known?.assignedUsers) ? [...known.assignedUsers] : [],
            uptimeStatus: known?.uptimeStatus || 'unknown', lastUptimeCheck: known?.lastUptimeCheck || null,
            createdAt: known?.createdAt || now(), updatedAt: now(),
          };
          sites.push(site);
        } else {
          if (!site.company && compVal) site.company = compVal;
          if (!site.clickupUrl && cuCol >= 0 && r[cuCol]) site.clickupUrl = r[cuCol];
        }

        // Assign user to this site
        if (!site.assignedUsers.includes(dbUser.id)) {
          site.assignedUsers.push(dbUser.id);
        }

        const maintRaw = (maintCol >= 0 ? r[maintCol] : '') || '';
        const sentRaw  = (sentCol >= 0 ? r[sentCol] : '') || '';

        // Merge with any existing daily-review row for this (site, user) so a
        // full sheet sync never regenerates brand-new row IDs or wipes
        // UI-entered values when the sheet cell is blank. The stable id keeps
        // reconcile/audit references pointing at the same record.
        const existingDr = existingDrByKey.get(`${site.id}::${dbUser.id}`);
        const drId = existingDr ? existingDr.id : uuid();

        // Raw sheet values for every UI-augmentable field (used both for the
        // conflict check below and for the merged row).
        const maintenanceRaw = maintRaw;
        const reportSentRaw  = sentRaw;
        const ga4Raw         = (ga4Col >= 0 ? r[ga4Col] : '') || '';
        const newsletterRaw  = (newsCol >= 0 ? r[newsCol] : '') || '';
        const formRaw        = (formCol >= 0 ? r[formCol] : '') || '';
        const bookingRaw     = (bookCol >= 0 ? r[bookCol] : '') || '';
        const cloudflareRaw  = (cfCol >= 0 ? r[cfCol] : '') || '';
        const clientResponseRaw = (respCol >= 0 ? r[respCol] : '') || '';
        const uptimeRobotRaw = (uptimeCol >= 0 ? r[uptimeCol] : '') || '';

        // CONFLICT POLICY (daily review): completion fields are UI-augmentable
        // (D1) — when the sheet carries a non-empty value that differs from a
        // previously stored non-empty value, the divergence is FLAGGED instead
        // of being silently overwritten. Sheet keeps its value during sync
        // (blank-preserve stays); the conflict is recorded for review.
        const uaFields = [
          ['maintenance', maintenanceRaw, 'maintenanceRaw'],
          ['reportSent', reportSentRaw, 'reportSentRaw'],
          ['ga4', ga4Raw, 'ga4'],
          ['newsletter', newsletterRaw, 'newsletterMail'],
          ['formSubmission', formRaw, 'formSubmissionMail'],
          ['bookingLink', bookingRaw, 'bookingLink'],
          ['cloudflare', cloudflareRaw, 'cloudflare'],
          ['clientResponse', clientResponseRaw, 'clientResponse'],
          ['uptimeRobot', uptimeRobotRaw, 'uptimeRobot'],
        ];
        for (const [f, sheetV, dbKey] of uaFields) {
          if (existingDr && realConflict(sheetV, existingDr[dbKey])) {
            flagConflict(ctx, {
              entity: 'daily-review', entityId: existingDr.id, label: `${site.url} (${dbUser.name})`, field: f,
              sheetValue: sheetV, dbValue: existingDr[dbKey],
              sheetSource: 'sheet:DAILY_REVIEW', dbSource: existingDr.source || 'db',
            });
          }
        }

        drRows.push({
          id: drId,
          userId: dbUser.id,
          userName: dbUser.name,
          siteId: site.id,
          siteUrl: site.url,
          company: compVal || site.company || site.account || '',
          rowIndex: rowIdx + 2, // 1-indexed + header
          ...provenance('DAILY_REVIEW', dbUser.name, rowIdx + 2),
          maintenanceStatus: existingDr && !maintRaw ? existingDr.maintenanceStatus : normStatus(maintRaw),
          maintenanceRaw: existingDr && !maintRaw ? existingDr.maintenanceRaw : maintRaw,
          reportSentStatus: existingDr && !sentRaw ? existingDr.reportSentStatus : normStatus(sentRaw),
          reportSentRaw: existingDr && !sentRaw ? existingDr.reportSentRaw : sentRaw,
          ga4: existingDr && !(ga4Col >= 0 && r[ga4Col]) ? existingDr.ga4 : ga4Raw,
          newsletterMail: existingDr && !(newsCol >= 0 && r[newsCol]) ? existingDr.newsletterMail : newsletterRaw,
          formSubmissionMail: existingDr && !(formCol >= 0 && r[formCol]) ? existingDr.formSubmissionMail : formRaw,
          bookingLink: existingDr && !(bookCol >= 0 && r[bookCol]) ? existingDr.bookingLink : bookingRaw,
          cloudflare: existingDr && !(cfCol >= 0 && r[cfCol]) ? existingDr.cloudflare : cloudflareRaw,
          clickupLink: existingDr && !(cuCol >= 0 && r[cuCol]) ? existingDr.clickupLink : ((cuCol >= 0 ? r[cuCol] : '') || site.clickupUrl || ''),
          clickupTimeTrackUrl: site.clickupTimeTrackUrl || existingDr?.clickupTimeTrackUrl || '',
          clientResponse: existingDr && !(respCol >= 0 && r[respCol]) ? existingDr.clientResponse : clientResponseRaw,
          uptimeRobot: existingDr && !(uptimeCol >= 0 && r[uptimeCol]) ? existingDr.uptimeRobot : uptimeRobotRaw,
          createdAt: existingDr?.createdAt || now(), updatedAt: now(),
        });
      });
    } catch (e) {
      console.error(`[sync] daily-review ${user.name} failed:`, e.message);
    }
    report(`Daily review: ${user.name}`, 25 + Math.round((i + 1) / users.length * 25));
  }

  // Soft-delete policy for a PARTIAL sync: if a user tab failed or was skipped
  // (network hiccup, 429, changed structure), their existing rows must survive
  // rather than being silently dropped when the whole collection is saved.
  // Rows seen this run are handled above; anything else in the current DB that
  // still belongs to a site present in the registry is carried forward as-is.
  const seenKeys = new Set(drRows.map(r => `${r.siteId}::${r.userId}`));
  const siteIds = new Set(sites.map(s => s.id));
  for (const row of existingDrList) {
    const key = `${row.siteId}::${row.userId}`;
    if (!seenKeys.has(key) && row.siteId && siteIds.has(row.siteId) && !drRows.some(r => r.id === row.id)) {
      drRows.push(row);
    }
  }

  return drRows;
}

// ─── Step 5: Import Tasks from Distribution Sheet ─────────────────────────────
async function importTasks(sites, userMap, ctx = makeCtx()) {
  report('Importing tasks…', 52);
  const tasks = [];
  try {
    const rows = await getTabValues('Distribution and Work Sheet', RANGE, SHEET_IDS.MASTER_TRACKER);
    if (!rows || rows.length < 2) return tasks;

    const h = rows[0];
    const taskCol    = hi(h, 'task name');
    const cuCol      = hi(h, 'clickup');
    const webCol     = hi(h, 'website');
    const typeCol    = hi(h, 'task type');
    const assigneeCol= hi(h, 'assignee');
    const statusCol  = hi(h, 'status');
    const prioCol    = hi(h, 'priority');
    const acmCol     = hi(h, 'account manager');

    // Existing tasks by natural key (taskName + siteUrl + assignee), stored as a
    // QUEUE so each duplicate sheet row consumes a DIFFERENT existing record.
    // A first-wins Map handed the same id to every duplicate row: measured live
    // 2026-09-25, the Distribution sheet has 10 keys covering 187 rows but only
    // 172 unique keys (e.g. six identical "Wilson Arkansas / Tarikul Islam" rows),
    // so the import emitted 187 records carrying 172 distinct ids — 15 tasks
    // became unaddressable by id, and the diff misreported them as "removed".
    const existingTasks = (dbRead('tasks') || []).filter(t => t != null && t.id);
    const existingByKey = new Map();
    for (const t of existingTasks) {
      const key = [String(t.taskName || '').toLowerCase(), cleanDomainUrl(t.siteUrl), String(t.assigneeName || '').toLowerCase()].join('|');
      if (!existingByKey.has(key)) existingByKey.set(key, []);
      existingByKey.get(key).push(t);
    }
    const cursorByKey = new Map();

    rows.slice(1).forEach((r, rowIdx) => {
      const website = (r[webCol] || '').trim();
      const taskName = (r[taskCol] || '').trim();
      if (!website && !taskName) return;

      const assigneeName = (r[assigneeCol] || '').trim();
      // Identity resolution across sheets: exact name → alias table → token
      // containment ("Ettekhar Taion" → "Taion"). Unresolvable → null, never guessed.
      const resolved = assigneeName ? resolveUserByName(assigneeName) : null;
      const dbUser = resolved?.user ||
        (assigneeName ? userMap[assigneeName.toLowerCase()] || null : null);
      const site = sites.find(s => urlMatch(s.url, website));

      const key = [taskName.toLowerCase(), cleanDomainUrl(website), assigneeName.toLowerCase()].join('|');
      const bucket = existingByKey.get(key);
      const cursor = cursorByKey.get(key) || 0;
      const existing = bucket && cursor < bucket.length ? bucket[cursor] : null;
      if (bucket) cursorByKey.set(key, cursor + 1);
      tasks.push({
        id: existing ? existing.id : uuid(),
        taskName,
        siteUrl: website,
        siteId: site?.id || existing?.siteId || null,
        assigneeId: dbUser?.id || existing?.assigneeId || null,
        assigneeName,
        taskType: r[typeCol] || '',
        status: r[statusCol] || 'todo',
        priority: r[prioCol] || 'medium',
        clickupLink: r[cuCol] || '',
        accountManager: r[acmCol] || '',
        deadline: '',
        notes: '',
        ...provenance('MASTER_TRACKER', 'Distribution and Work Sheet', rowIdx + 2),
        createdAt: existing?.createdAt || now(), updatedAt: now(),
      });
    });

    // A DB task the sheet no longer contains is NOT deleted. The DB is the source
    // of truth and Sheets is a connected interface, so a row removed upstream
    // must not silently destroy a local record: keep it, carry it through, and
    // flag it so a human decides. (Measured live 2026-09-25: 0 orphans — the
    // sheet and DB key multisets match exactly — so this is a guard rail, not a
    // behaviour change for today's data.)
    for (const [key, bucket] of existingByKey.entries()) {
      const used = cursorByKey.get(key) || 0;
      for (let i = used; i < bucket.length; i++) {
        const orphan = bucket[i];
        const label = `${orphan.taskName || '(blank task name)'} — ${orphan.siteUrl || '(no site)'} — ${orphan.assigneeName || '(no assignee)'}`;
        flagConflict(ctx, {
          entity: 'task',
          entityId: orphan.id,
          label,
          field: 'recordPresence',
          sheetValue: '(row absent from sheet)',
          dbValue: 'present',
          sheetSource: 'sheet:MASTER_TRACKER',
          dbSource: 'db',
          policy: 'keep-db',
        });
        tasks.push({ ...orphan, updatedAt: orphan.updatedAt || now() });
      }
    }
  } catch (e) { console.error('[sync] tasks failed:', e.message); }
  report('Tasks imported', 60);
  return tasks;
}

// ─── Step 6: Import Properties ────────────────────────────────────────────────
// Natural key for a property. Primary is name+url; url-only and name-only are
// fallbacks so a renamed-or-retyped column still matches an existing record.
const propKey = (name, url) => `${String(name || '').trim().toLowerCase()}|${cleanDomainUrl(url)}`;
const propUrlKey = (url) => cleanDomainUrl(url);
const propNameKey = (name) => String(name || '').trim().toLowerCase();

async function importProperties(userMap, ctx = makeCtx()) {
  report('Importing properties…', 62);
  const props = [];
  try {
    const rows = await getTabValues('Sheet1', RANGE, SHEET_IDS.PROPERTY_REGISTRY);
    if (!rows || rows.length < 2) return props;
    const h = rows[0];
    const nameCol    = hi(h, 'property name');
    const urlCol     = findUrlColumn(h) !== -1 ? findUrlColumn(h) : hi(h, 'property url', 'url');
    const typeCol    = hi(h, 'property type', 'type');
    const statusCol  = hi(h, 'stauts', 'status');
    const seoCol     = hi(h, 'seo');
    const hmCol      = hi(h, 'h&m', 'h&amp;m');
    const seoTaskCol = hi(h, 'task assigned to seo');
    const webTaskCol = hi(h, 'task assigned to web');

    // Existing properties indexed by natural key. Each index is a QUEUE so
    // duplicate sheet rows consume different existing records, and every index
    // shares ONE `used` set so a record reachable through more than one index
    // (name+url, url-only, name-only) is still handed out at most once —
    // otherwise the fallback would re-emit an already-taken id.
    //
    // This matching did not exist at all: importProperties minted `id: uuid()`
    // for every row on every run while diffCollection matches on id, so NO
    // property could ever match. Measured live 2026-09-25: every sync reported
    // 92 added / 92 removed / 0 kept and would have replaced the whole table
    // with new ids and reset every createdAt, on every single run.
    const byKey = new Map(), byUrl = new Map(), byName = new Map();
    const push = (map, k, rec) => { if (!k) return; if (!map.has(k)) map.set(k, []); map.get(k).push(rec); };
    for (const p of (dbRead('properties') || [])) {
      if (!p || !p.id) continue;
      push(byKey, propKey(p.name, p.url), p);
      push(byUrl, propUrlKey(p.url), p);
      push(byName, propNameKey(p.name), p);
    }
    const cursors = new Map();
    const used = new Set();
    const take = (map, mapName, k) => {
      const bucket = map.get(k);
      if (!bucket) return null;
      const ck = `${mapName} ${k}`;
      let i = cursors.get(ck) || 0;
      while (i < bucket.length && used.has(bucket[i].id)) i++;   // never re-emit a taken id
      if (i >= bucket.length) return null;
      cursors.set(ck, i + 1);
      used.add(bucket[i].id);
      return bucket[i];
    };
    const findExisting = (name, url) =>
      take(byKey, 'k', propKey(name, url))
      || take(byUrl, 'u', propUrlKey(url))
      || take(byName, 'n', propNameKey(name))
      || null;

    rows.slice(1).forEach((r, rowIdx) => {
      const name = (r[nameCol] || '').trim();
      const url  = (r[urlCol] || '').trim();
      if (!name && !url) return;

      const seoName = (r[seoTaskCol] || '').trim();
      const webName = (r[webTaskCol] || '').trim();
      const seoUser = seoName ? resolveUserByName(seoName).user : null;
      const webUser = webName ? resolveUserByName(webName).user : null;

      const existing = findExisting(name, url);

      props.push({
        id: existing ? existing.id : uuid(),
        name, url,
        type: r[typeCol] || existing?.type || '',
        status: r[statusCol] || existing?.status || 'Active',
        seo: r[seoCol] || existing?.seo || '',
        hm: r[hmCol] || existing?.hm || '',
        seoAssignee: seoName,
        seoAssigneeId: seoUser?.id || userMap[seoName.toLowerCase()]?.id || null,
        webAssignee: webName,
        webAssigneeId: webUser?.id || userMap[webName.toLowerCase()]?.id || null,
        ...provenance('PROPERTY_REGISTRY', 'Sheet1', rowIdx + 2),
        createdAt: existing?.createdAt || now(), updatedAt: now(),
      });
    });

    // Properties present in the DB but gone from the sheet are kept and flagged,
    // never dropped — same DB-first rule as tasks.
    const consumed = new Set(props.map((p) => p.id));
    for (const p of (dbRead('properties') || [])) {
      if (!p || !p.id || consumed.has(p.id)) continue;
      flagConflict(ctx, {
        entity: 'property',
        entityId: p.id,
        label: `${p.name || '(no name)'} — ${p.url || '(no url)'}`,
        field: 'recordPresence',
        sheetValue: '(row absent from sheet)',
        dbValue: 'present',
        sheetSource: 'sheet:PROPERTY_REGISTRY',
        dbSource: 'db',
        policy: 'keep-db',
      });
      props.push({ ...p, lastSeenAt: p.lastSeenAt || p.updatedAt || now() });
    }
  } catch (e) { console.error('[sync] properties failed:', e.message); }
  report('Properties imported', 72);
  return props;
}

// ─── Step 7: Import Dev Tracker ───────────────────────────────────────────────
async function importDevProjects() {
  report('Importing dev projects…', 74);
  let projects = [];
  try {
    const fetched = await fetchDevTrackerSheetData();
    // Attach provenance (source sheet + per-item sheet row) — informational,
    // never blocks, never fabricated (items already carry their sheet rowNum).
    projects = (fetched || []).map(p => ({
      ...p,
      source: 'sheet:DEV_TRACKER',
      sourceTab: p.project,
      sourceRow: null,
      lastSeenAt: now(),
      items: (p.items || []).map(it => ({
        ...it,
        source: 'sheet:DEV_TRACKER',
        sourceTab: p.project,
        sourceRow: it.rowNum || null,
        lastSeenAt: now(),
      })),
    }));
  } catch (e) { console.error('[sync] dev-projects failed:', e.message); }
  report('Dev projects imported', 90);
  return projects;
}

// ─── Main sync entry point ────────────────────────────────────────────────────
// opts: { dryRun?: boolean } — dry-run computes every import and its diff,
// persists NOTHING (DB, conflicts, audit, meta), and returns the full report
// so an operator can see exactly what a real sync would change. It is the
// rollback/staging safety net for destructive imports (see docs/database-architecture.md G/H).
export async function syncAll(opts = {}) {
  const ctx = makeCtx({ dryRun: opts.dryRun === true });
  if (ctx.dryRun) report('DRY-RUN — computing report only, no writes', 1);
  report('Starting full sync…', 1);
  const start = Date.now();

  let userMap = {};
  let sites = [];
  let drRows = [];
  let tasks = [];
  let props = [];
  let devProjects = [];

  // Step 1: Users
  try {
    userMap = seedUsers(ctx);
  } catch (e) { console.error('[sync] STEP 1 (seedUsers) FAILED:', e); report('⚠ Users failed: ' + e.message, 3); }

  // Step 2: Sites (CW + RM)
  try {
    report('Importing sites from CW + RM…', 5);
    sites = await importSites(ctx);
    report(`Sites imported: ${sites.length}`, 20);
  } catch (e) { console.error('[sync] STEP 2 (importSites) FAILED:', e); report('⚠ Sites failed: ' + e.message, 20); }

  // Step 3: Merge domain expiry into sites
  try {
    await mergeDomains(sites, ctx);
  } catch (e) { console.error('[sync] STEP 3 (mergeDomains) FAILED:', e); report('⚠ Domain merge failed: ' + e.message, 25); }

  // Step 4: Daily review + assign users to sites
  try {
    drRows = await importDailyReview(sites, userMap, ctx);
  } catch (e) { console.error('[sync] STEP 4 (importDailyReview) FAILED:', e); report('⚠ Daily review failed: ' + e.message, 50); }

  // Step 4b: data-quality lint over the rows this sync is about to persist.
  //
  // ADVISORY ONLY. This cannot block the sync and cannot write anything. A
  // value that merely looks wrong is a question for a human, not grounds to
  // refuse to import - refusing here would mean losing real data over a
  // formatting suspicion. It is wrapped in its own try/catch, and the checker
  // itself returns {ok:false} rather than throwing, so a bug in the check
  // degrades to a missing warning rather than a failed sync.
  //
  // It runs on the INCOMING rows (what this sync would write) so a value newly
  // introduced by an import is caught on the run that introduces it, instead
  // of whenever somebody next remembers to look.
  //
  // It also re-answers the standing question documented in db.js: for each
  // site whose duplicated mail address is currently DORMANT only because every
  // holder is inactive, is that still true? Reactivating such a user flips the
  // risk to LIVE, and nothing else in the assignment path would notice.
  try {
    const dqUsers = Object.fromEntries((getUsers() || []).map(u => [u.id, u]));
    const dqSites = sites.length ? sites : (getSites() || []);
    ctx.dataQuality = runDataQualityChecks(drRows, dqSites, dqUsers);
    console.log(formatDataQualityReport(ctx.dataQuality));
  } catch (e) {
    // Swallowed deliberately - see above.
    console.log(`[sync] data-quality check skipped: ${e && e.message}`);
  }

  // Step 5: Tasks
  try {
    tasks = await importTasks(sites, userMap, ctx);
  } catch (e) { console.error('[sync] STEP 5 (importTasks) FAILED:', e); report('⚠ Tasks failed: ' + e.message, 60); }

  // Step 6: Properties
  try {
    props = await importProperties(userMap, ctx);
  } catch (e) { console.error('[sync] STEP 6 (importProperties) FAILED:', e); report('⚠ Properties failed: ' + e.message, 75); }

  // Step 7: Dev projects
  try {
    devProjects = await importDevProjects();
  } catch (e) { console.error('[sync] STEP 7 (importDevProjects) FAILED:', e); report('⚠ Dev projects failed: ' + e.message, 90); }

  const elapsed = Math.round((Date.now() - start) / 1000);

  // ── DRY-RUN: report what WOULD change, write nothing ──────────────────────
  if (ctx.dryRun) {
    const diff = [
      diffCollection('sites', dbRead('sites') || [], sites),
      diffCollection('daily-review', dbRead('daily-review') || [], drRows),
      diffCollection('tasks', dbRead('tasks') || [], tasks),
      diffCollection('properties', dbRead('properties') || [], props),
      diffCollection('dev-projects', dbRead('dev-projects') || [], devProjects),
    ];
    report('DRY-RUN complete — nothing was written', 100);
    return {
      ok: true, dryRun: true, elapsed,
      counts: {
        users: Object.keys(userMap).length,
        sites: sites.length,
        dailyReviewRows: drRows.length,
        tasks: tasks.length,
        properties: props.length,
        devProjects: devProjects.length,
      },
      diff,
      conflicts: ctx.conflicts,
      dataQuality: ctx.dataQuality,
      conflictsCount: ctx.conflicts.length,
      note: 'Dry-run: no files were written. diff[].added/updated/removed shows what a real sync would change.',
    };
  }

  // Persist what actually imported — a failed step must NEVER wipe the local
  // DB. Each collection is only written when the import produced records; an
  // empty result (e.g. Sheets API down, missing credentials, 429) leaves the
  // existing data untouched instead of silently destroying it.
  report('Saving to local database…', 95);
  if (sites.length > 0) setSites(sites);
  else console.warn('[sync] ⚠ Sites import was empty — keeping existing sites (not overwriting).');
  if (drRows.length > 0) setDailyReview(drRows);
  else console.warn('[sync] ⚠ Daily review import was empty — keeping existing rows (not overwriting).');
  if (tasks.length > 0) setTasks(tasks);
  else console.warn('[sync] ⚠ Tasks import was empty — keeping existing tasks (not overwriting).');
  if (props.length > 0) setProperties(props);
  else console.warn('[sync] ⚠ Properties import was empty — keeping existing properties (not overwriting).');
  if (devProjects.length > 0) setDevProjects(devProjects);
  else console.warn('[sync] ⚠ Dev tracker import was empty — keeping existing projects (not overwriting).');

  setMeta({ lastSync: new Date().toISOString(), syncDuration: elapsed });

  report(`Sync complete in ${elapsed}s`, 100);
  return {
    ok: true, elapsed,
    counts: {
      users: Object.keys(userMap).length,
      sites: sites.length,
      dailyReviewRows: drRows.length,
      tasks: tasks.length,
      properties: props.length,
      devProjects: devProjects.length,
    },
    conflictsCount: ctx.conflicts.length,
    dataQuality: ctx.dataQuality,
    conflicts: ctx.conflicts.slice(0, 5), // summary sample; full list in data/sync-conflicts.json
  };
}

// ─── Diff helper (dry-run report) ─────────────────────────────────────────────
// Compares the current stored collection against what a real sync would write.
// Counts: added (new ids), removed (ids that would disappear), updated (ids
// present on both sides whose content actually changed), kept (unchanged).
// Only meaningful fields are compared — volatile bookkeeping (updatedAt,
// lastSeenAt, provenance counters) never counts as an "update".
function stripForDiff(rec) {
  if (rec == null || typeof rec !== 'object') return rec;
  const out = {};
  for (const [k, v] of Object.entries(rec)) {
    if (['id', 'updatedAt', 'createdAt', 'lastSeenAt', 'source', 'sourceTab', 'sourceRow'].includes(k)) continue;
    if (v && typeof v === 'object') out[k] = stripForDiff(v);
    else out[k] = v;
  }
  return out;
}

function diffCollection(name, oldArr, newArr) {
  const oldList = Array.isArray(oldArr) ? oldArr : (oldArr && typeof oldArr === 'object' ? Object.values(oldArr).flat() : []);
  const newList = Array.isArray(newArr) ? newArr : [];
  const oldIds = new Set(oldList.map(x => x && x.id).filter(Boolean));
  const newIds = new Set(newList.map(x => x && x.id).filter(Boolean));
  const added = [...newIds].filter(id => !oldIds.has(id));
  const removed = [...oldIds].filter(id => !newIds.has(id));
  const oldMap = new Map(oldList.map(x => [x.id, x]));
  const newMap = new Map(newList.map(x => [x.id, x]));
  let updated = 0;
  const sample = [];
  for (const id of oldIds) {
    if (!newIds.has(id)) continue;
    const o = oldMap.get(id), n = newMap.get(id);
    if (JSON.stringify(stripForDiff(o)) !== JSON.stringify(stripForDiff(n))) {
      updated++;
      if (sample.length < 3) sample.push({ id, url: n.url || n.project || n.siteUrl || n.taskName || n.name || '' });
    }
  }
  return {
    collection: name,
    current: oldList.length,
    wouldBe: newList.length,
    added: added.length,
    removed: removed.length,
    updated,
    kept: [...oldIds].filter(id => newIds.has(id)).length - updated,
    sample,
  };
}
