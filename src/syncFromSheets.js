/**
 * syncFromSheets.js
 * One-shot import: reads all 6 Google Sheets and writes to local JSON database.
 * Called by POST /api/master/sync — no other code path hits the Sheets API.
 */

import { getTabValues, listTabTitles } from './sheets.js';
import {
  setSites, setDailyReview, setDomains,
  setDistribution, setProperties, setDevTracker,
  setUsers, setMeta,
} from './db.js';

const SHEETS = {
  MASTER_TRACKER:    '1VnI5ZxVr5QykBOwYDOLp_1bbCpApfc0Jwljf01Q7djU',
  DAILY_REVIEW:      '1C4jSa49P6LHEN8ywh92fOgBPif6OSKuXx8PoRONtWzs',
  PROPERTY_REGISTRY: '1sWz7sNsQmi0xigD2AiMbxbC0lHDbKyQIGOB_jrrNJzY',
  DEV_TRACKER:       '14PXRHUkFG-gf0DwbGVqeyPA7aQ4LyhDMjAeTVatOI78',
  CW_MAINTENANCE:    '19aIBNOb0C4_Fx47bsZ2mUMVAxogX7j_tly8tSg-bldE',
  RM_MAINTENANCE:    '1Fbb-SY2fU0HXFdnJ_OQoHb_AwlFzdk39jWOo3kFMcjY',
};

const RANGE = 'A1:ZZ2000';

const USERS = ['Toufiq', 'Sabbir', 'Taion', 'Medul', 'Saiful', 'Tarikul', 'Roeich', 'Asif'];

// Progress callback type: (step: string, pct: number) => void
let _progress = null;
export function onProgress(fn) { _progress = fn; }
function report(step, pct) { if (_progress) _progress(step, pct); console.log(`[sync] ${pct}% — ${step}`); }

// ─── Helpers ─────────────────────────────────────────────────────────────────
function headerIndex(headers, ...candidates) {
  for (const c of candidates) {
    const i = headers.findIndex(h => h && h.toLowerCase().includes(c.toLowerCase()));
    if (i !== -1) return i;
  }
  return -1;
}

function normStatus(raw) {
  if (!raw) return 'pending';
  const s = raw.toLowerCase().trim();
  if (s.includes('completed') || s.includes('updated & backup') || s.includes('updated and backup')) return 'completed';
  if (s.includes('in progress')) return 'in_progress';
  if (s.includes('to do') || s.includes('todo')) return 'todo';
  if (s.includes('yes') || s.includes('sent')) return 'sent';
  if (s.includes('no')) return 'no';
  return raw.trim();
}

function daysUntil(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  if (isNaN(d)) return null;
  return Math.ceil((d - new Date()) / 86400000);
}

// ─── 1. Daily Review (per-user tabs) ─────────────────────────────────────────
async function syncDailyReview() {
  report('Syncing daily review…', 10);
  const result = {};
  for (let i = 0; i < USERS.length; i++) {
    const user = USERS[i];
    try {
      const rows = await getTabValues(user, RANGE, SHEETS.DAILY_REVIEW);
      if (!rows || rows.length < 2) { result[user] = []; continue; }

      const h = rows[0];
      const urlCol   = headerIndex(h, 'website url', 'website', ' ');
      const coCol    = headerIndex(h, 'company');
      const maintCol = headerIndex(h, 'maintenance');
      const sentCol  = headerIndex(h, 'maintenance report sent', 'report sent');
      const ga4Col   = headerIndex(h, 'ga4');
      const newsCol  = headerIndex(h, 'newsletter');
      const formCol  = headerIndex(h, 'form submission');
      const bookCol  = headerIndex(h, 'booking', 'reservation');
      const cfCol    = headerIndex(h, 'cloudflare');
      const cuCol    = headerIndex(h, 'clickup');
      const respCol  = headerIndex(h, 'client response', 'smtp');
      const uptimeCol= headerIndex(h, 'uptime', 'uptimerobot');

      result[user] = rows.slice(1).map((r, idx) => {
        const url = (r[urlCol] || r[0] || '').trim();
        if (!url || url.length < 5 || !/^https?:\/\/|^www\./i.test(url)) return null;
        const maintRaw = r[maintCol] || '';
        const sentRaw  = r[sentCol] || '';
        return {
          rowIndex: idx + 2,
          url,
          company: r[coCol] || '',
          maintenance: normStatus(maintRaw),
          maintenanceRaw: maintRaw,
          reportSent: normStatus(sentRaw),
          reportSentRaw: sentRaw,
          ga4: r[ga4Col] || '',
          newsletterMail: r[newsCol] || '',
          formSubmissionMail: r[formCol] || '',
          bookingLink: r[bookCol] || '',
          cloudflare: r[cfCol] || '',
          clickupLink: r[cuCol] || '',
          clientResponse: r[respCol] || '',
          uptimeRobot: r[uptimeCol] || '',
          user,
        };
      }).filter(Boolean);
    } catch (e) {
      console.error(`[sync] daily-review ${user} failed:`, e.message);
      result[user] = [];
    }
    report(`Daily review: ${user}`, 10 + Math.round((i + 1) / USERS.length * 20));
  }
  setDailyReview(result);
  setUsers(USERS);
  report('Daily review done', 30);
}

// ─── 2. Domain Expiration ─────────────────────────────────────────────────────
async function syncDomains() {
  report('Syncing domain expiry…', 31);
  try {
    const rows = await getTabValues('Domain Expiration Sheet', RANGE, SHEETS.MASTER_TRACKER);
    if (!rows || rows.length < 2) { setDomains([]); return; }
    const h = rows[0];
    const statusCol  = headerIndex(h, 'status', ' ');
    const cmsCol     = headerIndex(h, 'cms');
    const companyCol = headerIndex(h, 'company');
    const contactCol = headerIndex(h, 'contact');
    const acmCol     = headerIndex(h, 'a/c manager', 'account manager');
    const urlCol     = headerIndex(h, 'website url', 'website');
    const expiryCol  = headerIndex(h, 'domain expiry', 'domain expire', 'expiry');

    const domains = rows.slice(1).map(r => {
      const url = (r[urlCol] || '').trim();
      if (!url) return null;
      const expiry = r[expiryCol] || '';
      const days = daysUntil(expiry);
      return {
        status: r[statusCol] || 'Active',
        cms: r[cmsCol] || '',
        company: r[companyCol] || '',
        contact: r[contactCol] || '',
        accountManager: r[acmCol] || '',
        url,
        expiryDate: expiry,
        daysLeft: days,
        urgent: days !== null && days <= 30,
        warning: days !== null && days > 30 && days <= 90,
      };
    }).filter(Boolean);
    setDomains(domains);
  } catch (e) { console.error('[sync] domains failed:', e.message); }
  report('Domains done', 40);
}

// ─── 3. Distribution + Task Load ─────────────────────────────────────────────
async function syncDistribution() {
  report('Syncing task distribution…', 41);
  try {
    const [taskRows, loadRows] = await Promise.all([
      getTabValues('Distribution and Work Sheet', RANGE, SHEETS.MASTER_TRACKER),
      getTabValues('Task Load & Dependancy Solver', RANGE, SHEETS.MASTER_TRACKER),
    ]);

    const h = (taskRows || [])[0] || [];
    const taskCol    = headerIndex(h, 'task name');
    const cuCol      = headerIndex(h, 'clickup');
    const webCol     = headerIndex(h, 'website');
    const typeCol    = headerIndex(h, 'task type');
    const assigneeCol= headerIndex(h, 'assignee');
    const statusCol  = headerIndex(h, 'status');
    const prioCol    = headerIndex(h, 'priority');
    const acmCol     = headerIndex(h, 'account manager');

    const tasks = (taskRows || []).slice(1).map(r => {
      if (!r[webCol]?.trim() && !r[taskCol]?.trim()) return null;
      return {
        taskName: r[taskCol] || '',
        clickupLink: r[cuCol] || '',
        website: r[webCol] || '',
        taskType: r[typeCol] || '',
        assignee: r[assigneeCol] || '',
        status: r[statusCol] || '',
        priority: r[prioCol] || '',
        accountManager: r[acmCol] || '',
      };
    }).filter(Boolean);

    const taskLoad = (loadRows || []).slice(1).map(r => {
      const member = (r[0] || '').trim();
      if (!member) return null;
      return { member, taskCount: parseInt(r[1] || '0', 10) || 0, taskLink: r[3] || '' };
    }).filter(Boolean);

    setDistribution({ tasks, taskLoad });
  } catch (e) { console.error('[sync] distribution failed:', e.message); }
  report('Distribution done', 55);
}

// ─── 4. Property Registry ─────────────────────────────────────────────────────
async function syncProperties() {
  report('Syncing property registry…', 56);
  try {
    const rows = await getTabValues('Sheet1', RANGE, SHEETS.PROPERTY_REGISTRY);
    if (!rows || rows.length < 2) { setProperties([]); return; }
    const h = rows[0];
    const nameCol    = headerIndex(h, 'property name');
    const urlCol     = headerIndex(h, 'property url', 'url');
    const typeCol    = headerIndex(h, 'property type', 'type');
    const statusCol  = headerIndex(h, 'stauts', 'status');
    const seoCol     = headerIndex(h, 'seo');
    const hmCol      = headerIndex(h, 'h&m', 'h&amp;m');
    const seoTaskCol = headerIndex(h, 'task assigned to seo');
    const webTaskCol = headerIndex(h, 'task assigned to web');

    const props = rows.slice(1).map(r => {
      const name = (r[nameCol] || '').trim();
      const url  = (r[urlCol] || '').trim();
      if (!name && !url) return null;
      return {
        name, url,
        type: r[typeCol] || '',
        status: r[statusCol] || '',
        seo: r[seoCol] || '',
        hm: r[hmCol] || '',
        seoAssignee: r[seoTaskCol] || '',
        webAssignee: r[webTaskCol] || '',
      };
    }).filter(Boolean);
    setProperties(props);
  } catch (e) { console.error('[sync] properties failed:', e.message); }
  report('Properties done', 65);
}

// ─── 5. Dev Tracker ───────────────────────────────────────────────────────────
async function syncDevTracker() {
  report('Syncing dev tracker…', 66);
  try {
    const tabs = await listTabTitles(SHEETS.DEV_TRACKER);
    const projects = [];
    for (const tab of tabs) {
      try {
        const rows = await getTabValues(tab, RANGE, SHEETS.DEV_TRACKER);
        if (!rows || rows.length < 2) continue;
        const h = rows[0];
        const urlCol    = headerIndex(h, 'url');
        const statusCol = headerIndex(h, 'status');
        const fbCol     = headerIndex(h, 'feedback', 'feedbacks');
        const dateCol   = headerIndex(h, 'date');
        const noteCol   = headerIndex(h, 'note', 'updates');

        const items = rows.slice(1).map(r => {
          const url = (r[urlCol] || '').trim();
          if (!url) return null;
          return { url, status: r[statusCol] || '', feedbackUrl: r[fbCol] || '', date: r[dateCol] || '', notes: r[noteCol] || '' };
        }).filter(Boolean);

        if (items.length) projects.push({ project: tab, items });
      } catch {}
    }
    setDevTracker(projects);
  } catch (e) { console.error('[sync] dev-tracker failed:', e.message); }
  report('Dev tracker done', 80);
}

// ─── 6. CW + RM Maintenance Website Lists ────────────────────────────────────
async function syncSites() {
  report('Syncing CW + RM site lists…', 81);
  const processSheet = async (sheetId, account) => {
    const rows = await getTabValues('Website List', RANGE, sheetId);
    if (!rows || rows.length < 3) return [];
    // Row[0] is a note row, Row[1] has real headers
    const h = rows[1] || [];
    const urlCol    = headerIndex(h, 'website url');
    const cmsCol    = headerIndex(h, 'cms');
    const compCol   = headerIndex(h, 'company');
    const contCol   = headerIndex(h, 'contact');
    const acmCol    = headerIndex(h, 'a/c manager', 'account manager');
    const noteCol   = headerIndex(h, 'note');
    const cuCol     = headerIndex(h, 'maintenance task clickup');
    const reportCol = headerIndex(h, 'maintenance report url');
    const backupCol = headerIndex(h, 'backup url');

    // Collect all month columns (index > 9, header matches "Month YY/YYYY")
    const monthCols = h.reduce((acc, col, i) => {
      if (col && /[a-z]+ \d{2,4}/i.test(col) && i > 9) acc.push({ i, label: col });
      return acc;
    }, []);
    const latestMonth = monthCols[monthCols.length - 1];

    return rows.slice(2).map(r => {
      const url = (r[urlCol] || '').trim();
      if (!url) return null;
      return {
        account, url,
        status: r[0] || 'Active',
        cms: r[cmsCol] || '',
        company: r[compCol] || account,
        contact: r[contCol] || '',
        accountManager: r[acmCol] || '',
        note: r[noteCol] || '',
        clickupUrl: r[cuCol] || '',
        reportUrl: r[reportCol] || '',
        backupUrl: r[backupCol] || '',
        latestMonth: latestMonth?.label || '',
        latestMonthStatus: latestMonth ? (r[latestMonth.i] || '') : '',
        monthlyHistory: monthCols.map(mc => ({ month: mc.label, status: r[mc.i] || '' })),
      };
    }).filter(Boolean);
  };

  try {
    const [cw, rm] = await Promise.all([
      processSheet(SHEETS.CW_MAINTENANCE, 'CW'),
      processSheet(SHEETS.RM_MAINTENANCE, 'RM'),
    ]);
    setSites([...cw, ...rm]);
  } catch (e) { console.error('[sync] sites failed:', e.message); }
  report('Sites done', 95);
}

// ─── Main sync entry point ────────────────────────────────────────────────────
export async function syncAll() {
  report('Starting full sync…', 1);
  const start = Date.now();

  await syncDailyReview();
  await syncDomains();
  await syncDistribution();
  await syncProperties();
  await syncDevTracker();
  await syncSites();

  const elapsed = Math.round((Date.now() - start) / 1000);
  setMeta({ lastSync: new Date().toISOString(), syncDuration: elapsed });
  report(`Sync complete in ${elapsed}s`, 100);
  return { ok: true, elapsed };
}
