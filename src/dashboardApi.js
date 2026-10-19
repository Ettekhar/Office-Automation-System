import { config, accounts, getAccountConfig, getAllAccountConfigs, DONE_MARKER } from './config.js';
import { listTabTitles, getTabValues } from './sheets.js';
import { getTabMetaCached } from './tabMetaCache.js';
import {
  findHeaderRow,
  detectColumns,
  findMatchingTab,
  resolveMonthColumn,
  isActive,
  isMarkedDone,
  isValidWebsiteUrl,
  parseContacts,
  rowsToHtmlTable,
  resolveConditionalNotes,
  missingSectionInfo,
} from './reportUtils.js';
import { buildEmail, sendReportEmail } from './mailer.js';
import { getConditionalNotes, getSites } from './db.js';
import { completeClickUpMaintenanceTask } from './clickup.js';

/**
 * Distinct Account Manager strings currently present in the master tab's AM
 * column of every account (CW + RM). Read fresh on every call so the operator
 * directory follows the sheet - new names appear, removed names disappear.
 *
 * Read-only and never fatal: an account whose master tab cannot be read is
 * skipped with a warning instead of failing the directory.
 */
export async function getAllSheetAccountManagers() {
  const rawCells = [];
  for (const acct of getAllAccountConfigs()) {
    try {
      const masterRows = await getTabValues(acct.masterTabName, 'A1:ZZ2000', acct.spreadsheetId);
      const { headerRow, headerRowIndex } = findHeaderRow(masterRows || []);
      if (!headerRow) continue;
      const cols = detectColumns(headerRow);
      const dataRows = (masterRows || []).slice((headerRowIndex ?? -1) + 1);
      for (const row of dataRows) {
        const raw = String(row[cols.AM] ?? '').trim();
        if (raw) rawCells.push(raw);
      }
    } catch (err) {
      console.warn(`[clickup] could not read the AM column for ${acct.name}: ${err.message}`);
    }
  }
  return rawCells;
}

/**
 * Fetch overview data for a single account.
 */
async function getAccountOverviewData(acct, requestedMonth = null) {
  const [tabTitles, masterRows] = await Promise.all([
    listTabTitles(acct.spreadsheetId),
    getTabValues(acct.masterTabName, 'A1:ZZ2000', acct.spreadsheetId),
  ]);

  if (!masterRows || masterRows.length === 0) {
    throw new Error(`No data found on master tab "${acct.masterTabName}" for account ${acct.name}.`);
  }

  const { headerRow, headerRowIndex } = findHeaderRow(masterRows);
  const cols = detectColumns(headerRow);

  const availableMonths = [];
  for (let i = cols.FIRST_MONTH_COL; i < headerRow.length; i++) {
    const val = (headerRow[i] || '').trim();
    if (val && !availableMonths.includes(val)) {
      availableMonths.push(val);
    }
  }

  const reportMonth = resolveMonthColumn(headerRow, cols.FIRST_MONTH_COL, requestedMonth);
  if (!reportMonth) {
    throw new Error(
      requestedMonth
        ? `Could not find month column "${requestedMonth}" in ${acct.name}.`
        : `Could not find any month column in header row for ${acct.name}.`
    );
  }

  const monthCol = reportMonth.columnIndex;
  const dataRows = masterRows.slice(headerRowIndex + 1);

  // Per-site sheet link, so the mailer console can show exactly which tab a
  // report is built from. Sourced in order of directness:
  //   1. the master sheet's own URL cell (CW's "Maintenance Report URL"),
  //   2. the site registry (RM's "Website List" has no URL column, so its links
  //      were resolved during a previous sync),
  //   3. a deep link built from the report tab's gid.
  // Advisory only and never fatal: a site with no link shows a dash, and a
  // Sheets hiccup must not stop the overview loading.
  const registry = (() => { try { return getSites({}) || []; } catch { return []; } })();
  const normUrl = (u) => String(u || '').toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/+$/, '');
  const registryByUrl = new Map(registry.map((s) => [normUrl(s.url), s]));

  async function sheetUrlFor(masterCell, matchedTab, websiteUrl) {
    const direct = String(masterCell ?? '').trim();
    if (/^https?:\/\//i.test(direct)) return direct;

    const stored = String(registryByUrl.get(normUrl(websiteUrl))?.reportUrl ?? '').trim();
    if (/^https?:\/\//i.test(stored)) return stored;

    if (!matchedTab) return '';
    // One bounded, module-wide lookup per spreadsheet (tabMetaCache.js). This
    // used to call listTabMeta() straight from the row loop with no timeout and
    // no shared cache, so on the worker (slow Sheets API) the whole overview
    // waited on it once per account, per request.
    const meta = await getTabMetaCached(acct.spreadsheetId);
    const gid = meta ? meta.gidByTitle.get(matchedTab) : undefined;
    return gid !== undefined && gid !== null && gid !== ''
      ? `https://docs.google.com/spreadsheets/d/${acct.spreadsheetId}/edit#gid=${gid}`
      : '';
  }

  const sites = [];
  let totalActive = 0;
  let totalReady = 0;
  let totalInProgress = 0;
  let totalInactive = 0;
  let totalNoContact = 0;
  let totalNoTab = 0;

  for (let index = 0; index < dataRows.length; index++) {
    const row = dataRows[index];
    const websiteUrl = (row[cols.WEBSITE_URL] || '').trim();
    // Skip blank or note-prefixed junk rows
    if (!websiteUrl || !isValidWebsiteUrl(websiteUrl)) continue;

    const cms = (row[cols.CMS] || '').trim();
    const company = (row[cols.COMPANY] || '').trim();
    const accountManager = (row[cols.AM] || '').trim();
    const clientNote = (row[cols.NOTE] || '').trim();
    // "Maintenance time tracking ClickUp URL". The header name is resolved, not
    // the position: CW carries it at column H and RM at column G, so a fixed
    // index would show RM the wrong cell.
    // A sheet with no such column resolves to -1, and row[-1] is already
    // undefined, so the cell reads blank without a special case.
    const timeTrackUrl = String(row[cols.TIME_TRACK_URL] ?? '').trim();
    const statusCell = row[cols.STATUS] || '';
    const monthCell = (row[monthCol] || '').trim();
    const active = isActive(statusCell);
    const ready = isMarkedDone(monthCell, DONE_MARKER);
    const contacts = parseContacts(row[cols.CONTACT]);
    const matchedTab = findMatchingTab(tabTitles, websiteUrl, acct.masterTabName);

    // Anything the shared resolver did not map (a column someone added by hand)
    // is surfaced as data instead of being dropped.
    const extra = {};
    (cols.EXTRAS || []).forEach(({ key, index }) => {
      extra[key] = String(row[index] ?? '').trim();
    });

    if (active) totalActive++;
    else totalInactive++;

    let status = 'inactive';
    if (active) {
      if (ready) {
        if (contacts.length === 0) {
          status = 'no_contact';
          totalNoContact++;
        } else if (!matchedTab) {
          status = 'no_tab';
          totalNoTab++;
        } else {
          status = 'ready';
          totalReady++;
        }
      } else {
        status = monthCell ? 'in_progress' : 'pending';
        totalInProgress++;
      }
    }

    const reportUrl = await sheetUrlFor(row[cols.REPORT_URL], matchedTab, websiteUrl);
    sites.push({
      id: `${acct.key.toLowerCase()}-site-${index + 1}`,
      account: acct.key,
      accountName: acct.name,
      fromEmail: acct.fromEmail,
      fromName: acct.fromName,
      rowIndex: headerRowIndex + 1 + index + 1,
      websiteUrl,
      cms,
      company,
      accountManager,
      clientNote,
      timeTrackUrl,
      statusCell,
      monthCell,
      isActive: active,
      isReady: ready,
      contacts,
      matchedTab,
      reportUrl,
      status,
      extra,
    });
  }

  return {
    account: acct.key,
    accountName: acct.name,
    masterTabName: acct.masterTabName,
    availableMonths,
    // The detected layout of this master tab: field indexes, hand-added columns
    // (`extraColumns`) and month columns. Any new column is visible here.
    columns: {
      profile: cols.PROFILE,
      headerRowNumber: headerRowIndex + 1,
      fields: {
        status: cols.STATUS,
        cms: cols.CMS,
        company: cols.COMPANY,
        contact: cols.CONTACT,
        accountManager: cols.AM,
        note: cols.NOTE,
        websiteUrl: cols.WEBSITE_URL,
        clickupUrl: cols.CLICKUP_URL,
        reportUrl: cols.REPORT_URL,
        backupUrl: cols.BACKUP_URL,
        domainExpiry: cols.DOMAIN_EXPIRY,
        backupDate: cols.BACKUP_DATE,
      },
      extraColumns: (cols.EXTRAS || []).map(({ key, label, index, kind }) => ({ key, label, index, kind })),
      monthColumns: (cols.MONTHS || []).map((m) => ({ label: m.label, index: m.index })),
    },
    selectedMonth: {
      name: reportMonth.monthName,
      lower: reportMonth.monthLower,
      year: reportMonth.year,
      columnIndex: monthCol,
    },
    stats: {
      totalSites: sites.length,
      totalActive,
      totalInactive,
      totalReady,
      totalInProgress,
      totalNoContact,
      totalNoTab,
    },
    sites,
  };
}

/**
 * Get full overview data: can be for all accounts ('all') or a single account ('CW', 'RM').
 */
export async function getOverviewData(requestedMonth = null, accountKey = 'all') {
  const allConfigs = getAllAccountConfigs();
  const accountsMeta = allConfigs.map((a) => ({
    key: a.key,
    name: a.name,
    spreadsheetId: a.spreadsheetId,
    fromEmail: a.fromEmail,
    fromName: a.fromName,
  }));

  if (accountKey && accountKey !== 'all') {
    const acct = getAccountConfig(accountKey);
    const data = await getAccountOverviewData(acct, requestedMonth);
    return {
      ...data,
      currentAccount: acct.key,
      accounts: accountsMeta,
    };
  }

  // Aggregate across all accounts
  const accountResults = await Promise.all(
    allConfigs.map((acct) =>
      getAccountOverviewData(acct, requestedMonth).catch((err) => {
        console.error(`Error loading account ${acct.name}:`, err.message);
        return null;
      })
    )
  );

  const validResults = accountResults.filter(Boolean);
  if (validResults.length === 0) {
    throw new Error('Failed to load data for any workspace account.');
  }

  // Combine available months (ordered union)
  const availableMonths = [];
  for (const res of validResults) {
    for (const m of res.availableMonths) {
      if (!availableMonths.includes(m)) {
        availableMonths.push(m);
      }
    }
  }

  const selectedMonth = validResults[0].selectedMonth;
  const sites = [];
  const stats = {
    totalSites: 0,
    totalActive: 0,
    totalInactive: 0,
    totalReady: 0,
    totalInProgress: 0,
    totalNoContact: 0,
    totalNoTab: 0,
  };

  const accountBreakdowns = {};

  for (const res of validResults) {
    sites.push(...res.sites);
    stats.totalSites += res.stats.totalSites;
    stats.totalActive += res.stats.totalActive;
    stats.totalInactive += res.stats.totalInactive;
    stats.totalReady += res.stats.totalReady;
    stats.totalInProgress += res.stats.totalInProgress;
    stats.totalNoContact += res.stats.totalNoContact;
    stats.totalNoTab += res.stats.totalNoTab;
    accountBreakdowns[res.account] = res.stats;
  }

  return {
    currentAccount: 'all',
    accounts: accountsMeta,
    accountBreakdowns,
    availableMonths,
    selectedMonth,
    stats,
    sites,
  };
}

/**
 * Generate preview email for a specific website within an account.
 */
export async function getSitePreview(websiteUrl, requestedMonth = null, accountKey = null) {
  let targetAcct = null;
  if (accountKey && accounts[accountKey.toUpperCase()]) {
    targetAcct = getAccountConfig(accountKey);
  } else {
    // Search across accounts for the websiteUrl
    const allConfigs = getAllAccountConfigs();
    for (const acct of allConfigs) {
      try {
        const rows = await getTabValues(acct.masterTabName, 'A1:ZZ2000', acct.spreadsheetId);
        const { headerRow } = findHeaderRow(rows);
        const cols = detectColumns(headerRow);
        if (
          rows.some(
            (r) => (r[cols.WEBSITE_URL] || '').trim().toLowerCase() === websiteUrl.trim().toLowerCase()
          )
        ) {
          targetAcct = acct;
          break;
        }
      } catch (_) {}
    }
    if (!targetAcct) {
      targetAcct = getAccountConfig('CW');
    }
  }

  const [tabTitles, masterRows] = await Promise.all([
    listTabTitles(targetAcct.spreadsheetId),
    getTabValues(targetAcct.masterTabName, 'A1:ZZ2000', targetAcct.spreadsheetId),
  ]);

  const { headerRow } = findHeaderRow(masterRows);
  const cols = detectColumns(headerRow);
  const reportMonth = resolveMonthColumn(headerRow, cols.FIRST_MONTH_COL, requestedMonth);
  if (!reportMonth) {
    throw new Error('Month column not found.');
  }

  const matchedTab = findMatchingTab(tabTitles, websiteUrl, targetAcct.masterTabName);
  let reportHtml = '<p><em>(No matching report tab found in spreadsheet for this site.)</em></p>';
  let hasAdditionalIssues = false;
  let hasPremiumPlugins = false;
  let conditionalNotes = [];
  let missingSectionRows = null;

  if (matchedTab) {
    const reportRows = await getTabValues(matchedTab, 'A1:Z300', targetAcct.spreadsheetId);
    const tableRes = rowsToHtmlTable(reportRows);
    reportHtml = tableRes.reportHtml;
    hasAdditionalIssues = tableRes.hasAdditionalIssues;
    hasPremiumPlugins = tableRes.hasPremiumPlugins;
    missingSectionRows = missingSectionInfo(tableRes.unsectionedRows);
    conditionalNotes = resolveConditionalNotes(
      reportRows,
      getConditionalNotes({ account: targetAcct.key, enabledOnly: true }),
    );
  }

  let contacts = [];
  let accountManager = '';
  let timeTrackUrl = '';
  for (const row of masterRows.slice(1)) {
    if ((row[cols.WEBSITE_URL] || '').trim().toLowerCase() === websiteUrl.trim().toLowerCase()) {
      contacts = parseContacts(row[cols.CONTACT]);
      accountManager = String(row[cols.AM] || '').trim();
      timeTrackUrl = String(row[cols.TIME_TRACK_URL] || '').trim();
      break;
    }
  }

  const { subject, html } = buildEmail({
    websiteUrl,
    reportMonth,
    reportHtml,
    hasAdditionalIssues,
    hasPremiumPlugins,
    conditionalNotes,
    accountKey: targetAcct.key,
  });

  return {
    websiteUrl,
    account: targetAcct.key,
    accountName: targetAcct.name,
    fromEmail: targetAcct.fromEmail,
    fromName: targetAcct.fromName,
    matchedTab: matchedTab || null,
    contacts,
    accountManager,
    timeTrackUrl,
    reportMonth: `${reportMonth.monthName} ${reportMonth.year}`,
    subject,
    html,
    hasAdditionalIssues,
    hasPremiumPlugins,
    // Operator-only: non-null when the tab has no section band and rows were
    // dropped from the email. Shown as a console notice, never sent.
    missingSectionRows,
    // Which conditions fired, and which cell each link came from. Surfaced so
    // the dashboard can show the operator why a paragraph appeared.
    conditionalNotes: conditionalNotes.map((n) => ({
      condition: n.condition,
      url: n.url,
      sourceCell: n.sourceCell,
    })),
  };
}

/**
 * Generate previews for all ready sites in one call.
 *
 * On the first run (cold cache) each site's report tab is fetched from
 * Google Sheets sequentially with a small pacing delay so we never burst
 * more than ~3 requests/second (well under the 60 req/min quota).
 * On subsequent runs within the cache TTL every read is served from
 * memory — no API calls are made and generation is near-instant.
 */
export async function generateAllPreviews(requestedMonth = null, accountKey = 'all') {
  const overview = await getOverviewData(requestedMonth, accountKey);
  const readySites = overview.sites.filter((s) => s.status === 'ready');
  const previews = [];
  const errors = [];
  const missingSectionSites = [];

  for (let i = 0; i < readySites.length; i++) {
    const site = readySites[i];
    try {
      const siteAcct = getAccountConfig(site.account);
      const reportRows = await getTabValues(site.matchedTab, 'A1:Z300', siteAcct.spreadsheetId);
      const { reportHtml, hasAdditionalIssues, hasPremiumPlugins, unsectionedRows } = rowsToHtmlTable(reportRows);
      const missingSectionRows = missingSectionInfo(unsectionedRows);
      const conditionalNotes = resolveConditionalNotes(
        reportRows,
        getConditionalNotes({ account: site.account, enabledOnly: true }),
      );
      const { subject, html } = buildEmail({
        websiteUrl: site.websiteUrl,
        reportMonth: {
          monthName: overview.selectedMonth.name,
          monthLower: overview.selectedMonth.lower,
          year: overview.selectedMonth.year,
        },
        reportHtml,
        hasAdditionalIssues,
        hasPremiumPlugins,
        conditionalNotes,
        accountKey: site.account,
      });

      previews.push({
        websiteUrl: site.websiteUrl,
        account: site.account,
        accountName: site.accountName,
        fromEmail: site.fromEmail,
        fromName: site.fromName,
        contacts: site.contacts,
        accountManager: site.accountManager || '',
        timeTrackUrl: site.timeTrackUrl || '',
        matchedTab: site.matchedTab,
        subject,
        html,
        hasAdditionalIssues,
        hasPremiumPlugins,
        missingSectionRows,
        conditionalNotes: conditionalNotes.map((n) => ({
          condition: n.condition,
          url: n.url,
          sourceCell: n.sourceCell,
        })),
      });

      if (missingSectionRows) {
        missingSectionSites.push({
          websiteUrl: site.websiteUrl,
          account: site.account,
          ...missingSectionRows,
        });
      }
    } catch (err) {
      errors.push({
        websiteUrl: site.websiteUrl,
        account: site.account,
        error: err.message,
      });
    }
  }

  return {
    selectedMonth: overview.selectedMonth,
    totalReady: readySites.length,
    generatedCount: previews.length,
    errorCount: errors.length,
    missingSectionCount: missingSectionSites.length,
    missingSectionSites,
    previews,
    errors,
  };
}


/**
 * Send an email for a single site (with optional recipient/subject/html override and accountKey).
 */
export async function sendSingleEmail({
  to,
  subject,
  html,
  dryRun = false,
  accountKey = 'CW',
  websiteUrl = null,
  timeTrackUrl = null,
  accountManager = null,
  monthName = null,
  syncClickUp = true,
}) {
  if (!to || to.length === 0) {
    throw new Error('Recipient email is required.');
  }
  if (!subject) {
    throw new Error('Email subject is required.');
  }
  if (!html) {
    throw new Error('Email HTML body is required.');
  }

  const result = await sendReportEmail({
    to: Array.isArray(to) ? to : [to],
    subject,
    html,
    dryRun,
    accountKey,
  });

  // Optional ClickUp task completion and AM mention notification
  let clickupResult = null;
  if (syncClickUp) {
    try {
      let targetSiteUrl = websiteUrl;
      let targetTimeTrack = timeTrackUrl;
      let targetAm = accountManager;

      if (!targetSiteUrl && subject) {
        const match = subject.match(/Website Maintenance Report for ([^\s(]+)/i);
        if (match) targetSiteUrl = match[1];
      }

      if (targetSiteUrl && (!targetTimeTrack || !targetAm)) {
        const cleanTarget = targetSiteUrl.toLowerCase().replace(/^https?:\/\//, '').replace(/\/$/, '');
        const site = (getSites ? getSites({}) : []).find((s) => {
          const sUrl = (s.url || '').toLowerCase().replace(/^https?:\/\//, '').replace(/\/$/, '');
          return sUrl === cleanTarget || sUrl.includes(cleanTarget) || cleanTarget.includes(sUrl);
        });
        if (site) {
          targetTimeTrack = targetTimeTrack || site.clickupTimeTrackUrl || site.timeTrackUrl;
          targetAm = targetAm || site.accountManager;
        }
      }

      if (targetTimeTrack) {
        let detectedMonth = monthName;
        if (!detectedMonth && subject) {
          const mMatch = subject.match(/\(([^)]+)\)$/);
          if (mMatch) detectedMonth = mMatch[1];
        }
        clickupResult = await completeClickUpMaintenanceTask({
          timeTrackUrl: targetTimeTrack,
          websiteUrl: targetSiteUrl || 'website',
          accountManager: targetAm,
          monthName: detectedMonth,
          dryRun,
        });
      }
    } catch (cuErr) {
      console.warn('[ClickUp] Auto-close task notice:', cuErr.message);
      clickupResult = { error: cuErr.message };
    }
  }

  return {
    success: true,
    to: Array.isArray(to) ? to : [to],
    subject,
    account: accountKey,
    dryRun,
    result,
    clickup: clickupResult,
  };
}


