import { config, getAllAccountConfigs, getAccountConfig, DONE_MARKER } from '../src/config.js';
import { listTabTitles, getTabValues } from '../src/sheets.js';
import {
  findHeaderRow,
  detectColumns,
  findMatchingTab,
  resolveMonthColumn,
  isActive,
  isMarkedDone,
  parseContacts,
  rowsToHtmlTable,
} from '../src/reportUtils.js';
import { buildEmail, sendReportEmail } from '../src/mailer.js';

export default async function handler(req, res) {
  // Simple shared-secret protection — set CRON_SECRET in Vercel env vars.
  const providedSecret = req.query.secret || req.headers['x-cron-secret'];
  if (process.env.CRON_SECRET && providedSecret !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const SEND = req.query.send === '1' || req.query.send === 'true';
  const targetMonth = req.query.month || null;
  const targetAccount = req.query.account || null;

  try {
    const accountsToProcess = targetAccount
      ? [getAccountConfig(targetAccount)]
      : getAllAccountConfigs();

    const results = {
      mode: SEND ? 'send' : 'dry-run',
      accounts: [],
      sent: [],
      skipped: [],
      errors: [],
    };

    for (const acct of accountsToProcess) {
      results.accounts.push(acct.key);
      const [tabTitles, masterRows] = await Promise.all([
        listTabTitles(acct.spreadsheetId),
        getTabValues(acct.masterTabName, 'A1:ZZ2000', acct.spreadsheetId),
      ]);

      if (!masterRows || masterRows.length === 0) continue;

      const { headerRow, headerRowIndex } = findHeaderRow(masterRows);
      const cols = detectColumns(headerRow);
      const reportMonth = resolveMonthColumn(headerRow, cols.FIRST_MONTH_COL, targetMonth);
      if (!reportMonth) continue;

      const monthCol = reportMonth.columnIndex;

      for (const row of masterRows.slice(headerRowIndex + 1)) {
        const websiteUrl = (row[cols.WEBSITE_URL] || '').trim();
        if (!websiteUrl) continue;

        if (!isActive(row[cols.STATUS])) continue;
        if (!isMarkedDone(row[monthCol], DONE_MARKER)) continue;

        const contacts = parseContacts(row[cols.CONTACT]);

        const matchedTab = findMatchingTab(tabTitles, websiteUrl, acct.masterTabName);

        if (contacts.length === 0 || !matchedTab) {
          results.skipped.push({
            account: acct.key,
            websiteUrl,
            reason: contacts.length === 0 ? 'no contact' : 'no matching tab',
          });
          continue;
        }

        try {
          const reportRows = await getTabValues(matchedTab, 'A1:D200', acct.spreadsheetId);
          const { reportHtml, hasAdditionalIssues, hasPremiumPlugins } = rowsToHtmlTable(reportRows);
          const { subject, html } = buildEmail({
            websiteUrl,
            reportMonth,
            reportHtml,
            hasAdditionalIssues,
            hasPremiumPlugins,
            accountKey: acct.key,
          });

          await sendReportEmail({
            to: contacts,
            subject,
            html,
            dryRun: !SEND,
            accountKey: acct.key,
          });
          results.sent.push({
            account: acct.key,
            websiteUrl,
            contacts,
            tab: matchedTab,
          });
        } catch (err) {
          results.errors.push({
            account: acct.key,
            websiteUrl,
            error: err.message,
          });
        }
      }
    }

    return res.status(200).json(results);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

