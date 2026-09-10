/**
 * masterApi.js
 * Server-side data aggregation for the Master Office Automation Dashboard.
 * Pulls from all 6 Google Sheets and normalises into clean JSON structures.
 */

import { getTabValues, listTabTitles } from './sheets.js';

// ─── Sheet IDs ───────────────────────────────────────────────────────────────
const SHEETS = {
  MASTER_TRACKER:    '1VnI5ZxVr5QykBOwYDOLp_1bbCpApfc0Jwljf01Q7djU',
  DAILY_REVIEW:      '1C4jSa49P6LHEN8ywh92fOgBPif6OSKuXx8PoRONtWzs',
  PROPERTY_REGISTRY: '1sWz7sNsQmi0xigD2AiMbxbC0lHDbKyQIGOB_jrrNJzY',
  DEV_TRACKER:       '14PXRHUkFG-gf0DwbGVqeyPA7aQ4LyhDMjAeTVatOI78',
  CW_MAINTENANCE:    '19aIBNOb0C4_Fx47bsZ2mUMVAxogX7j_tly8tSg-bldE',
  RM_MAINTENANCE:    '1Fbb-SY2fU0HXFdnJ_OQoHb_AwlFzdk39jWOo3kFMcjY',
};

// Users that have tabs in the Daily Review sheet
export const DAILY_REVIEW_USERS = [
  'Toufiq', 'Sabbir', 'Taion', 'Medul', 'Saiful', 'Tarikul', 'Roeich', 'Asif'
];

// ─── Helpers ─────────────────────────────────────────────────────────────────
function headerIndex(headers, ...candidates) {
  for (const c of candidates) {
    const i = headers.findIndex(h => h && h.toLowerCase().includes(c.toLowerCase()));
    if (i !== -1) return i;
  }
  return -1;
}

function normaliseStatus(raw) {
  if (!raw) return 'pending';
  const s = raw.toLowerCase().trim();
  if (s.includes('completed') || s.includes('updated & backup') || s.includes('updated and backup')) return 'completed';
  if (s.includes('in progress')) return 'in_progress';
  if (s.includes('to do') || s.includes('todo')) return 'todo';
  if (s.includes('yes') || s.includes('sent')) return 'sent';
  if (s.includes('no')) return 'no';
  return raw.trim();
}

// ─── Daily Review ─────────────────────────────────────────────────────────────
/**
 * Get one user's daily review rows (their tab in the Daily Review sheet).
 */
export async function getDailyReviewForUser(userName) {
  const rows = await getTabValues(SHEETS.DAILY_REVIEW, userName);
  if (!rows || rows.length < 2) return [];

  const headers = rows[0] || [];
  const urlCol  = headerIndex(headers, 'website url', 'website', ' ');
  const coCol   = headerIndex(headers, 'company', 'website');
  const maintCol= headerIndex(headers, 'maintenance');
  const sentCol = headerIndex(headers, 'maintenance report sent', 'report sent');
  const ga4Col  = headerIndex(headers, 'ga4');
  const formCol = headerIndex(headers, 'form submission mail');
  const bookCol = headerIndex(headers, 'booking', 'reservation');
  const cfCol   = headerIndex(headers, 'cloudflare');
  const cuCol   = headerIndex(headers, 'clickup');
  const newsCol = headerIndex(headers, 'newsletter');

  return rows.slice(1).map((r, i) => {
    const url = (r[urlCol] || r[0] || '').trim();
    if (!url || url.startsWith('http') === false && url.length < 5) return null;
    return {
      rowIndex: i + 2,
      url: url.replace(/^\s+/, ''),
      company: r[coCol] || '',
      maintenance: normaliseStatus(r[maintCol]),
      maintenanceRaw: r[maintCol] || '',
      reportSent: normaliseStatus(r[sentCol]),
      reportSentRaw: r[sentCol] || '',
      ga4: r[ga4Col] || '',
      newsletterMail: r[newsCol] || '',
      formSubmissionMail: r[formCol] || '',
      bookingLink: r[bookCol] || '',
      cloudflare: r[cfCol] || '',
      clickupLink: r[cuCol] || '',
    };
  }).filter(Boolean);
}

/**
 * Get all users' daily review data in one call.
 */
export async function getAllDailyReview() {
  const result = {};
  for (const user of DAILY_REVIEW_USERS) {
    try {
      result[user] = await getDailyReviewForUser(user);
    } catch {
      result[user] = [];
    }
  }
  return result;
}

/**
 * Summary stats per user for the admin overview.
 */
export async function getDailyReviewSummary() {
  const all = await getAllDailyReview();
  return Object.entries(all).map(([user, sites]) => ({
    user,
    total: sites.length,
    completed: sites.filter(s => s.maintenance === 'completed').length,
    inProgress: sites.filter(s => s.maintenance === 'in_progress').length,
    pending: sites.filter(s => !['completed', 'in_progress'].includes(s.maintenance)).length,
    reportSent: sites.filter(s => s.reportSent === 'sent' || s.reportSentRaw?.toLowerCase() === 'yes').length,
  }));
}

// ─── Domain Expiration ────────────────────────────────────────────────────────
export async function getDomainExpiry() {
  const rows = await getTabValues(SHEETS.MASTER_TRACKER, 'Domain Expiration Sheet');
  if (!rows || rows.length < 2) return [];

  const headers = rows[0] || [];
  const statusCol  = headerIndex(headers, 'status', ' ');
  const cmsCol     = headerIndex(headers, 'cms');
  const companyCol = headerIndex(headers, 'company');
  const contactCol = headerIndex(headers, 'contact');
  const acmCol     = headerIndex(headers, 'a/c manager', 'account manager', 'manager');
  const urlCol     = headerIndex(headers, 'website url', 'website');
  const expiryCol  = headerIndex(headers, 'domain expiry', 'domain expire', 'expiry');

  return rows.slice(1).map(r => {
    const url = r[urlCol] || '';
    if (!url.trim()) return null;
    const expiry = r[expiryCol] || '';
    const expiryDate = expiry ? new Date(expiry) : null;
    const daysLeft = expiryDate && !isNaN(expiryDate)
      ? Math.ceil((expiryDate - new Date()) / 86400000)
      : null;
    return {
      status: r[statusCol] || '',
      cms: r[cmsCol] || '',
      company: r[companyCol] || '',
      contact: r[contactCol] || '',
      accountManager: r[acmCol] || '',
      url: url.trim(),
      expiryDate: expiry,
      daysLeft,
      urgent: daysLeft !== null && daysLeft <= 30,
      warning: daysLeft !== null && daysLeft > 30 && daysLeft <= 90,
    };
  }).filter(Boolean);
}

// ─── Distribution / Work Sheet ───────────────────────────────────────────────
export async function getDistributionSheet() {
  const rows = await getTabValues(SHEETS.MASTER_TRACKER, 'Distribution and Work Sheet');
  if (!rows || rows.length < 2) return [];

  const headers = rows[0] || [];
  const taskCol    = headerIndex(headers, 'task name');
  const clickupCol = headerIndex(headers, 'clickup');
  const websiteCol = headerIndex(headers, 'website');
  const typeCol    = headerIndex(headers, 'task type');
  const assigneeCol= headerIndex(headers, 'assignee');
  const statusCol  = headerIndex(headers, 'status');
  const priorityCol= headerIndex(headers, 'priority');
  const acmCol     = headerIndex(headers, 'account manager');

  return rows.slice(1).map(r => {
    if (!r[websiteCol]?.trim() && !r[taskCol]?.trim()) return null;
    return {
      taskName: r[taskCol] || '',
      clickupLink: r[clickupCol] || '',
      website: r[websiteCol] || '',
      taskType: r[typeCol] || '',
      assignee: r[assigneeCol] || '',
      status: r[statusCol] || '',
      priority: r[priorityCol] || '',
      accountManager: r[acmCol] || '',
    };
  }).filter(Boolean);
}

// ─── Task Load ────────────────────────────────────────────────────────────────
export async function getTaskLoad() {
  const rows = await getTabValues(SHEETS.MASTER_TRACKER, 'Task Load & Dependancy Solver');
  if (!rows || rows.length < 2) return [];

  return rows.slice(1).map(r => {
    const member = (r[0] || '').trim();
    if (!member) return null;
    return {
      member,
      taskCount: parseInt(r[1] || '0', 10) || 0,
      taskLink: r[3] || '',
      details: r[5] || '',
    };
  }).filter(Boolean);
}

// ─── Property Registry ───────────────────────────────────────────────────────
export async function getPropertyRegistry() {
  const rows = await getTabValues(SHEETS.PROPERTY_REGISTRY, 'Sheet1');
  if (!rows || rows.length < 2) return [];

  const headers = rows[0] || [];
  const nameCol   = headerIndex(headers, 'property name');
  const urlCol    = headerIndex(headers, 'property url', 'url');
  const typeCol   = headerIndex(headers, 'property type', 'type');
  const statusCol = headerIndex(headers, 'stauts', 'status');
  const seoCol    = headerIndex(headers, 'seo');
  const hmCol     = headerIndex(headers, 'h&m', 'h&amp;m', 'hm');
  const seoTaskCol= headerIndex(headers, 'task assigned to seo');
  const webTaskCol= headerIndex(headers, 'task assigned to web');

  return rows.slice(1).map(r => {
    const name = r[nameCol] || '';
    const url  = r[urlCol] || '';
    if (!name.trim() && !url.trim()) return null;
    return {
      name: name.trim(),
      url: url.trim(),
      type: r[typeCol] || '',
      status: r[statusCol] || '',
      seo: r[seoCol] || '',
      hm: r[hmCol] || '',
      seoTask: r[seoTaskCol] || '',
      webTask: r[webTaskCol] || '',
    };
  }).filter(Boolean);
}

// ─── Web Dev Tracker ──────────────────────────────────────────────────────────
export async function getDevTracker() {
  const tabs = await listTabTitles(SHEETS.DEV_TRACKER);
  const result = [];

  for (const tab of tabs) {
    try {
      const rows = await getTabValues(SHEETS.DEV_TRACKER, tab);
      if (!rows || rows.length < 2) continue;

      const headers = rows[0] || [];
      const urlCol    = headerIndex(headers, 'url');
      const statusCol = headerIndex(headers, 'status');
      const fbCol     = headerIndex(headers, 'feedback', 'feedbacks');
      const dateCol   = headerIndex(headers, 'date');
      const noteCol   = headerIndex(headers, 'note', 'updates');

      const items = rows.slice(1).map(r => {
        const url = r[urlCol] || '';
        if (!url.trim()) return null;
        return {
          url: url.trim(),
          status: r[statusCol] || '',
          feedbackUrl: r[fbCol] || '',
          date: r[dateCol] || '',
          notes: r[noteCol] || '',
        };
      }).filter(Boolean);

      if (items.length) {
        result.push({ project: tab, items });
      }
    } catch { /* skip inaccessible tabs */ }
  }
  return result;
}

// ─── Maintenance Overview (CW + RM Website Lists) ────────────────────────────
export async function getMaintenanceOverview() {
  const processSheet = async (sheetId, account) => {
    const rows = await getTabValues(sheetId, 'Website List');
    if (!rows || rows.length < 3) return [];

    // Row 0 = note row, Row 1 = actual headers, Row 2+ = data
    const headers = rows[1] || [];
    const noteCol  = 0;
    const cmsCol   = headerIndex(headers, 'cms');
    const compCol  = headerIndex(headers, 'company');
    const urlCol   = headerIndex(headers, 'website url');
    const cuCol    = headerIndex(headers, 'maintenance task clickup');
    const reportCol= headerIndex(headers, 'maintenance report url');
    const backupCol= headerIndex(headers, 'backup url');

    // Find the most recent month column (after backup col)
    const monthCols = headers.reduce((acc, h, i) => {
      if (h && /[a-z]+ \d{2,4}/i.test(h) && i > 5) acc.push({ i, label: h });
      return acc;
    }, []);
    const latestMonth = monthCols[monthCols.length - 1];

    return rows.slice(2).map(r => {
      const url = r[urlCol] || '';
      if (!url.trim()) return null;
      return {
        account,
        status: r[noteCol] || 'Active',
        cms: r[cmsCol] || '',
        company: r[compCol] || '',
        url: url.trim(),
        clickupUrl: r[cuCol] || '',
        reportUrl: r[reportCol] || '',
        backupUrl: r[backupCol] || '',
        latestMonthStatus: latestMonth ? r[latestMonth.i] || '' : '',
        latestMonth: latestMonth?.label || '',
      };
    }).filter(Boolean);
  };

  const [cw, rm] = await Promise.all([
    processSheet(SHEETS.CW_MAINTENANCE, 'CW'),
    processSheet(SHEETS.RM_MAINTENANCE, 'RM'),
  ]);

  return [...cw, ...rm];
}
