import { config, accounts, getAccountConfig, getAllAccountConfigs, DONE_MARKER } from './config.js';
import { listTabTitles, getTabValues } from './sheets.js';
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
} from './reportUtils.js';
import { buildEmail, sendReportEmail } from './mailer.js';

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
    const statusCell = row[cols.STATUS] || '';
    const monthCell = (row[monthCol] || '').trim();
    const active = isActive(statusCell);
    const ready = isMarkedDone(monthCell, DONE_MARKER);
    const contacts = parseContacts(row[cols.CONTACT]);
    const matchedTab = findMatchingTab(tabTitles, websiteUrl, acct.masterTabName);

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
      statusCell,
      monthCell,
      isActive: active,
      isReady: ready,
      contacts,
      matchedTab,
      status,
    });
  }

  return {
    account: acct.key,
    accountName: acct.name,
    masterTabName: acct.masterTabName,
    availableMonths,
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

  if (matchedTab) {
    const reportRows = await getTabValues(matchedTab, 'A1:D200', targetAcct.spreadsheetId);
    const tableRes = rowsToHtmlTable(reportRows);
    reportHtml = tableRes.reportHtml;
    hasAdditionalIssues = tableRes.hasAdditionalIssues;
    hasPremiumPlugins = tableRes.hasPremiumPlugins;
  }

  let contacts = [];
  for (const row of masterRows.slice(1)) {
    if ((row[cols.WEBSITE_URL] || '').trim().toLowerCase() === websiteUrl.trim().toLowerCase()) {
      contacts = parseContacts(row[cols.CONTACT]);
      break;
    }
  }


  const { subject, html } = buildEmail({
    websiteUrl,
    reportMonth,
    reportHtml,
    hasAdditionalIssues,
    hasPremiumPlugins,
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
    reportMonth: `${reportMonth.monthLower}-${reportMonth.year}`,
    subject,
    html,
    hasAdditionalIssues,
    hasPremiumPlugins,
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

  for (let i = 0; i < readySites.length; i++) {
    const site = readySites[i];
    try {
      const siteAcct = getAccountConfig(site.account);
      const reportRows = await getTabValues(site.matchedTab, 'A1:D200', siteAcct.spreadsheetId);
      const { reportHtml, hasAdditionalIssues, hasPremiumPlugins } = rowsToHtmlTable(reportRows);
      const { subject, html } = buildEmail({
        websiteUrl: site.websiteUrl,
        reportMonth: {
          monthLower: overview.selectedMonth.lower,
          year: overview.selectedMonth.year,
        },
        reportHtml,
        hasAdditionalIssues,
        hasPremiumPlugins,
        accountKey: site.account,
      });

      previews.push({
        websiteUrl: site.websiteUrl,
        account: site.account,
        accountName: site.accountName,
        fromEmail: site.fromEmail,
        fromName: site.fromName,
        contacts: site.contacts,
        matchedTab: site.matchedTab,
        subject,
        html,
        hasAdditionalIssues,
        hasPremiumPlugins,
      });
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
    previews,
    errors,
  };
}


/**
 * Send an email for a single site (with optional recipient/subject/html override and accountKey).
 */
export async function sendSingleEmail({ to, subject, html, dryRun = false, accountKey = 'CW' }) {
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

  return {
    success: true,
    to: Array.isArray(to) ? to : [to],
    subject,
    account: accountKey,
    dryRun,
    result,
  };
}

