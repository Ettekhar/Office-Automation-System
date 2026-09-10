import 'dotenv/config';

function getEnv(name, fallback = '') {
  return process.env[name] ?? fallback;
}

const serviceAccountKeyPath = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_JSON
  ? null
  : (process.env.GOOGLE_SERVICE_ACCOUNT_KEY_PATH || './service-account.json');

export const accounts = {
  CW: {
    key: 'CW',
    name: getEnv('CW_NAME', 'CW Maintenance'),
    spreadsheetId: getEnv('CW_SPREADSHEET_ID', getEnv('SPREADSHEET_ID', '1fQuRDY9-I_w101Dd_J7HDy6W_Q_qaU_payKQ53YX4Ug')),
    masterTabName: getEnv('CW_MASTER_TAB_NAME', getEnv('MASTER_TAB_NAME', 'Website List')),
    serviceAccountKeyPath,
    smtp: {
      host: getEnv('CW_SMTP_HOST', getEnv('SMTP_HOST', 'smtp.titan.email')),
      port: Number(getEnv('CW_SMTP_PORT', getEnv('SMTP_PORT', '587'))),
      secure: (getEnv('CW_SMTP_SECURE', getEnv('SMTP_SECURE', 'false'))).toLowerCase() === 'true',
      user: getEnv('CW_SMTP_USER', getEnv('SMTP_USER', '')),
      pass: getEnv('CW_SMTP_PASS', getEnv('SMTP_PASS', '')),
    },
    fromEmail: getEnv('CW_FROM_EMAIL', getEnv('FROM_EMAIL', getEnv('CW_SMTP_USER', getEnv('SMTP_USER', '')))),
    fromName: getEnv('CW_FROM_NAME', getEnv('FROM_NAME', 'CW Maintenance Team')),
    bccEmail: getEnv('CW_BCC_EMAIL', getEnv('BCC_EMAIL', null)) || null,
  },
  RM: {
    key: 'RM',
    name: getEnv('RM_NAME', 'RM Maintenance'),
    spreadsheetId: getEnv('RM_SPREADSHEET_ID', '1risqtbCx2w8uNaSqsXDHmrJKcofrBb8eugyOfeFMEks'),
    masterTabName: getEnv('RM_MASTER_TAB_NAME', getEnv('MASTER_TAB_NAME', 'Website List')),
    serviceAccountKeyPath,
    smtp: {
      host: getEnv('RM_SMTP_HOST', getEnv('SMTP_HOST', 'smtp.titan.email')),
      port: Number(getEnv('RM_SMTP_PORT', getEnv('SMTP_PORT', '587'))),
      secure: (getEnv('RM_SMTP_SECURE', getEnv('SMTP_SECURE', 'false'))).toLowerCase() === 'true',
      user: getEnv('RM_SMTP_USER', getEnv('SMTP_USER', 'taion@razibmarketing.net')),
      pass: getEnv('RM_SMTP_PASS', getEnv('SMTP_PASS', '')),
    },
    fromEmail: getEnv('RM_FROM_EMAIL', getEnv('FROM_EMAIL', getEnv('RM_SMTP_USER', 'taion@razibmarketing.net'))),
    fromName: getEnv('RM_FROM_NAME', 'RM Maintenance Team'),
    bccEmail: getEnv('RM_BCC_EMAIL', getEnv('BCC_EMAIL', null)) || null,
  },
};

export function getAccountConfig(accountKey = 'CW') {
  const key = String(accountKey || 'CW').toUpperCase();
  if (accounts[key]) {
    return accounts[key];
  }
  // Fallback to CW if not recognized
  return accounts.CW;
}

export function getAllAccountConfigs() {
  return Object.values(accounts);
}

// Backwards-compatible default config pointing to CW
export const config = {
  get spreadsheetId() { return accounts.CW.spreadsheetId; },
  get masterTabName() { return accounts.CW.masterTabName; },
  serviceAccountKeyPath,
  get smtp() { return accounts.CW.smtp; },
  get fromEmail() { return accounts.CW.fromEmail; },
  get fromName() { return accounts.CW.fromName; },
  get bccEmail() { return accounts.CW.bccEmail; },
  maxEmailsPerRun: Number(process.env.MAX_EMAILS_PER_RUN || 0),
};

/**
 * Zero-based column indices in the MASTER tab header row.
 */
export const COLS = {
  STATUS: 0, // "Active" / "Deactive"
  CMS: 1,
  COMPANY: 2,
  CONTACT: 3, // comma or semicolon separated emails
  AM: 4, // Account Manager
  NOTE: 5,
  WEBSITE_URL: 6,
  CLICKUP_URL: 7,
  REPORT_URL: 8, // not fully reliable per-site (often shared) — we match by tab name instead
  BACKUP_URL: 9,
  FIRST_MONTH_COL: 10, // month columns start here and continue rightward
};

// The exact text a month cell needs to contain (case-insensitive) to count as "done" this month.
export const DONE_MARKER = 'updated & backup';

