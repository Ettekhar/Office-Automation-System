import { config, getAllAccountConfigs, getAccountConfig, DONE_MARKER } from './config.js';
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


const SEND = process.argv.includes('--send');

// Optional explicit month via CLI: --month=August or --month August
let requestedMonth = null;
const monthArgIndex = process.argv.findIndex((arg) => arg.startsWith('--month'));
if (monthArgIndex !== -1) {
  const arg = process.argv[monthArgIndex];
  if (arg.includes('=')) {
    requestedMonth = arg.split('=')[1];
  } else if (process.argv[monthArgIndex + 1] && !process.argv[monthArgIndex + 1].startsWith('--')) {
    requestedMonth = process.argv[monthArgIndex + 1];
  }
}

// Optional explicit account via CLI: --account=CW or --account=RM
let targetAccount = null;
const accountArgIndex = process.argv.findIndex((arg) => arg.startsWith('--account'));
if (accountArgIndex !== -1) {
  const arg = process.argv[accountArgIndex];
  if (arg.includes('=')) {
    targetAccount = arg.split('=')[1];
  } else if (process.argv[accountArgIndex + 1] && !process.argv[accountArgIndex + 1].startsWith('--')) {
    targetAccount = process.argv[accountArgIndex + 1];
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function processAccount(acct) {
  console.log(`\n========================================`);
  console.log(`Processing Workspace: ${acct.name} (${acct.key})`);
  console.log(`Spreadsheet ID: ${acct.spreadsheetId}`);
  console.log(`Sender: "${acct.fromName}" <${acct.fromEmail}>`);
  console.log(`========================================`);

  const [tabTitles, masterRows] = await Promise.all([
    listTabTitles(acct.spreadsheetId),
    getTabValues(acct.masterTabName, 'A1:ZZ2000', acct.spreadsheetId),
  ]);

  if (masterRows.length === 0) {
    console.error(`No rows found on tab "${acct.masterTabName}" for ${acct.name}.`);
    return { sent: 0, errors: 0, skipped: 0 };
  }

  const { headerRow, headerRowIndex } = findHeaderRow(masterRows);
  const cols = detectColumns(headerRow);
  const reportMonth = resolveMonthColumn(headerRow, cols.FIRST_MONTH_COL, requestedMonth);
  if (!reportMonth) {
    console.error(
      requestedMonth
        ? `Could not find column "${requestedMonth}" in ${acct.name}.`
        : `Could not find any month column in ${acct.name}.`
    );
    return { sent: 0, errors: 0, skipped: 0 };
  }

  const monthCol = reportMonth.columnIndex;
  console.log(`Target Month Column: "${reportMonth.monthName}"`);
  console.log(`Email Subject Tag: "(${reportMonth.monthLower}-${reportMonth.year})"\n`);

  const dataRows = masterRows.slice(headerRowIndex + 1);

  let sent = 0;
  let skippedInactive = 0;
  let skippedNotDone = 0;
  let skippedNoContact = 0;
  let skippedNoTab = 0;
  let errors = 0;

  for (const row of dataRows) {
    const status = row[cols.STATUS];
    const websiteUrl = (row[cols.WEBSITE_URL] || '').trim();
    const contactCell = row[cols.CONTACT];
    const monthCell = row[monthCol];

    if (!websiteUrl || !isValidWebsiteUrl(websiteUrl)) continue;

    if (!isActive(status)) {
      skippedInactive++;
      continue;
    }

    if (!isMarkedDone(monthCell, DONE_MARKER)) {
      skippedNotDone++;
      continue;
    }

    const contacts = parseContacts(contactCell);
    if (contacts.length === 0) {
      console.warn(`⚠ Skipping ${websiteUrl} — no valid contact email.`);
      skippedNoContact++;
      continue;
    }

    const matchedTab = findMatchingTab(tabTitles, websiteUrl, acct.masterTabName);
    if (!matchedTab) {
      console.warn(`⚠ Skipping ${websiteUrl} — no matching report tab found.`);
      skippedNoTab++;
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

      if (config.maxEmailsPerRun > 0 && sent >= config.maxEmailsPerRun) {
        console.log(`Reached MAX_EMAILS_PER_RUN (${config.maxEmailsPerRun}) — stopping.`);
        break;
      }

      await sendReportEmail({
        to: contacts,
        subject,
        html,
        dryRun: !SEND,
        accountKey: acct.key,
      });
      console.log(`${SEND ? '✅ Sent' : '📝 Would send'} [${acct.key}]: ${websiteUrl} -> ${contacts.join(', ')} (tab: "${matchedTab}")`);
      sent++;

      await sleep(300);
    } catch (err) {
      console.error(`❌ Error processing ${websiteUrl}:`, err.message);
      errors++;
    }
  }

  console.log(`\n--- ${acct.name} Summary ---`);
  console.log(`${SEND ? 'Sent' : 'Would send'}: ${sent}`);
  console.log(`Skipped: ${skippedInactive + skippedNotDone + skippedNoContact + skippedNoTab}`);
  console.log(`Errors: ${errors}`);

  return { sent, errors };
}

async function main() {
  console.log(`\n========================================`);
  console.log(`Mode: ${SEND ? 'SEND (LIVE EMAILS WILL GO OUT)' : 'DRY RUN (preview mode)'}`);
  console.log(`========================================`);

  const accountsToProcess = targetAccount
    ? [getAccountConfig(targetAccount)]
    : getAllAccountConfigs();

  for (const acct of accountsToProcess) {
    await processAccount(acct);
  }

  if (!SEND) {
    console.log('\nThis was a dry run. Check `dry-run-previews/` folder to preview rendered emails.');
    console.log('Run with `npm run send` (or `node src/index.js --send`) to send live.');
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});

