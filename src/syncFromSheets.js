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

import { getTabValues, listTabTitles } from './sheets.js';
import {
  uuid, setUsers, setSites, setDailyReview, setTasks, setProperties, setDevProjects, setMeta,
  getUsers, dbRead, dbWrite,
} from './db.js';

const RANGE = 'A1:ZZ2000';

const SHEET_IDS = {
  MASTER_TRACKER:    '1VnI5ZxVr5QykBOwYDOLp_1bbCpApfc0Jwljf01Q7djU',
  DAILY_REVIEW:      '1C4jSa49P6LHEN8ywh92fOgBPif6OSKuXx8PoRONtWzs',
  PROPERTY_REGISTRY: '1sWz7sNsQmi0xigD2AiMbxbC0lHDbKyQIGOB_jrrNJzY',
  DEV_TRACKER:       '14PXRHUkFG-gf0DwbGVqeyPA7aQ4LyhDMjAeTVatOI78',
  CW_MAINTENANCE:    '19aIBNOb0C4_Fx47bsZ2mUMVAxogX7j_tly8tSg-bldE',
  RM_MAINTENANCE:    '1Fbb-SY2fU0HXFdnJ_OQoHb_AwlFzdk39jWOo3kFMcjY',
};

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

// ─── Step 1: Seed Users ───────────────────────────────────────────────────────
function seedUsers() {
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

  setUsers(merged);
  const userMap = {};
  for (const u of merged) userMap[u.name.toLowerCase()] = u;
  return userMap;
}

// ─── Step 2: Import Sites from CW + RM Website Lists ─────────────────────────
async function importSites() {
  report('Importing CW sites…', 5);
  const sites = [];

  const processSheet = async (sheetId, account, progressStart) => {
    const rows = await getTabValues('Website List', RANGE, sheetId);
    if (!rows || rows.length < 3) return;

    const h = rows[1] || []; // Row 0 = note, Row 1 = headers
    const urlCol    = hi(h, 'website url');
    const cmsCol    = hi(h, 'cms');
    const compCol   = hi(h, 'company');
    const contCol   = hi(h, 'contact');
    const acmCol    = hi(h, 'a/c manager', 'account manager');
    const noteCol   = hi(h, 'note');
    const cuCol     = hi(h, 'maintenance task clickup');
    const reportCol = hi(h, 'maintenance report url');
    const backupCol = hi(h, 'backup url');

    const monthCols = h.reduce((acc, col, i) => {
      if (col && /[a-z]+ \d{2,4}/i.test(col) && i > 9) acc.push({ i, label: col });
      return acc;
    }, []);
    const latestMonth = monthCols[monthCols.length - 1];

    rows.slice(2).forEach(r => {
      const url = (r[urlCol] || '').trim();
      if (!url) return;
      sites.push({
        id: uuid(),
        url,
        account,
        status: (r[0] || 'Active').trim(),
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
        // Will be filled in later steps:
        domainExpiry: '', daysLeft: null,
        assignedUsers: [],
        uptimeStatus: 'unknown', lastUptimeCheck: null,
        createdAt: now(), updatedAt: now(),
      });
    });
    report(`Imported ${account} sites (${sites.filter(s => s.account === account).length})`, progressStart);
  };

  await processSheet(SHEET_IDS.CW_MAINTENANCE, 'CW', 10);
  report('Importing RM sites…', 12);
  await processSheet(SHEET_IDS.RM_MAINTENANCE, 'RM', 15);
  return sites;
}

// ─── Step 3: Merge Domain Expiry into Sites ───────────────────────────────────
async function mergeDomains(sites) {
  report('Merging domain expiry…', 18);
  try {
    const rows = await getTabValues('Domain Expiration Sheet', RANGE, SHEET_IDS.MASTER_TRACKER);
    if (!rows || rows.length < 2) return;
    const h = rows[0];
    const urlCol    = hi(h, 'website url', 'website');
    const expiryCol = hi(h, 'domain expiry', 'domain expire', 'expiry');
    const acmCol    = hi(h, 'a/c manager', 'account manager');
    const compCol   = hi(h, 'company');
    const cmsCol    = hi(h, 'cms');
    const contCol   = hi(h, 'contact');

    rows.slice(1).forEach(r => {
      const domainUrl = (r[urlCol] || '').trim();
      if (!domainUrl) return;
      const expiry = r[expiryCol] || '';
      const days = daysUntil(expiry);

      // Match to existing site by URL similarity
      const site = sites.find(s => urlMatch(s.url, domainUrl));
      if (site) {
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
async function importDailyReview(sites, userMap) {
  report('Importing daily review…', 25);
  const drRows = [];
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
      const urlCol   = hi(h, 'website url', 'website', 'url');
      const coCol    = hi(h, 'company');
      const maintCol = h.findIndex(x => x && x.trim().toLowerCase() === 'maintenance') !== -1
        ? h.findIndex(x => x && x.trim().toLowerCase() === 'maintenance')
        : hi(h, 'maintenance');
      const sentCol  = hi(h, 'maintenance report sent', 'report sent');
      const ga4Col   = hi(h, 'ga4');
      const newsCol  = hi(h, 'newsletter');
      const formCol  = hi(h, 'form submission', 'form name');
      const bookCol  = hi(h, 'booking', 'reservation', 'engine');
      const cfCol    = hi(h, 'cloudflare');
      const cuCol    = hi(h, 'clickup');
      const respCol  = hi(h, 'client response', 'smtp');
      const uptimeCol= hi(h, 'uptimerobot', 'uptime');

      rows.slice(1).forEach((r, rowIdx) => {
        let rawUrl = (urlCol >= 0 ? (r[urlCol] || '') : '').trim();
        if (!rawUrl || !/^https?:\/\/|^www\./i.test(rawUrl)) {
          const found = r.find(c => typeof c === 'string' && /^https?:\/\/|^www\./i.test(c.trim()));
          if (found) rawUrl = found.trim();
        }
        if (!rawUrl || rawUrl.length < 5) return;

        const compVal = (coCol >= 0 && r[coCol])
          ? r[coCol].trim()
          : (r.find(c => typeof c === 'string' && (c.trim() === 'CW' || c.trim() === 'RM')) || '');

        // Find or create the site record
        let site = sites.find(s => urlMatch(s.url, rawUrl));
        if (!site) {
          site = {
            id: uuid(),
            url: rawUrl,
            account: compVal || 'CW',
            status: 'Active',
            cms: '', company: compVal || '', contact: '', accountManager: '',
            note: '', clickupUrl: (cuCol >= 0 ? r[cuCol] : '') || '', reportUrl: '', backupUrl: '',
            latestMonth: '', latestMonthStatus: '', monthlyHistory: [],
            domainExpiry: '', daysLeft: null,
            assignedUsers: [],
            uptimeStatus: 'unknown', lastUptimeCheck: null,
            createdAt: now(), updatedAt: now(),
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

        drRows.push({
          id: uuid(),
          userId: dbUser.id,
          userName: dbUser.name,
          siteId: site.id,
          siteUrl: site.url,
          company: compVal || site.company || site.account || '',
          rowIndex: rowIdx + 2, // 1-indexed + header
          maintenanceStatus: normStatus(maintRaw),
          maintenanceRaw: maintRaw,
          reportSentStatus: normStatus(sentRaw),
          reportSentRaw: sentRaw,
          ga4: (ga4Col >= 0 ? r[ga4Col] : '') || '',
          newsletterMail: (newsCol >= 0 ? r[newsCol] : '') || '',
          formSubmissionMail: (formCol >= 0 ? r[formCol] : '') || '',
          bookingLink: (bookCol >= 0 ? r[bookCol] : '') || '',
          cloudflare: (cfCol >= 0 ? r[cfCol] : '') || '',
          clickupLink: (cuCol >= 0 ? r[cuCol] : '') || site.clickupUrl || '',
          clientResponse: (respCol >= 0 ? r[respCol] : '') || '',
          uptimeRobot: (uptimeCol >= 0 ? r[uptimeCol] : '') || '',
          createdAt: now(), updatedAt: now(),
        });
      });
    } catch (e) {
      console.error(`[sync] daily-review ${user.name} failed:`, e.message);
    }
    report(`Daily review: ${user.name}`, 25 + Math.round((i + 1) / users.length * 25));
  }

  return drRows;
}

// ─── Step 5: Import Tasks from Distribution Sheet ─────────────────────────────
async function importTasks(sites, userMap) {
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

    rows.slice(1).forEach(r => {
      const website = (r[webCol] || '').trim();
      const taskName = (r[taskCol] || '').trim();
      if (!website && !taskName) return;

      const assigneeName = (r[assigneeCol] || '').trim();
      const dbUser = userMap[assigneeName.toLowerCase()];
      const site = sites.find(s => urlMatch(s.url, website));

      tasks.push({
        id: uuid(),
        taskName,
        siteUrl: website,
        siteId: site?.id || null,
        assigneeId: dbUser?.id || null,
        assigneeName,
        taskType: r[typeCol] || '',
        status: r[statusCol] || 'todo',
        priority: r[prioCol] || 'medium',
        clickupLink: r[cuCol] || '',
        accountManager: r[acmCol] || '',
        deadline: '',
        notes: '',
        createdAt: now(), updatedAt: now(),
      });
    });
  } catch (e) { console.error('[sync] tasks failed:', e.message); }
  report('Tasks imported', 60);
  return tasks;
}

// ─── Step 6: Import Properties ────────────────────────────────────────────────
async function importProperties(userMap) {
  report('Importing properties…', 62);
  const props = [];
  try {
    const rows = await getTabValues('Sheet1', RANGE, SHEET_IDS.PROPERTY_REGISTRY);
    if (!rows || rows.length < 2) return props;
    const h = rows[0];
    const nameCol    = hi(h, 'property name');
    const urlCol     = hi(h, 'property url', 'url');
    const typeCol    = hi(h, 'property type', 'type');
    const statusCol  = hi(h, 'stauts', 'status');
    const seoCol     = hi(h, 'seo');
    const hmCol      = hi(h, 'h&m', 'h&amp;m');
    const seoTaskCol = hi(h, 'task assigned to seo');
    const webTaskCol = hi(h, 'task assigned to web');

    rows.slice(1).forEach(r => {
      const name = (r[nameCol] || '').trim();
      const url  = (r[urlCol] || '').trim();
      if (!name && !url) return;

      const seoName = (r[seoTaskCol] || '').trim();
      const webName = (r[webTaskCol] || '').trim();

      props.push({
        id: uuid(),
        name, url,
        type: r[typeCol] || '',
        status: r[statusCol] || 'Active',
        seo: r[seoCol] || '',
        hm: r[hmCol] || '',
        seoAssignee: seoName,
        seoAssigneeId: userMap[seoName.toLowerCase()]?.id || null,
        webAssignee: webName,
        webAssigneeId: userMap[webName.toLowerCase()]?.id || null,
        createdAt: now(), updatedAt: now(),
      });
    });
  } catch (e) { console.error('[sync] properties failed:', e.message); }
  report('Properties imported', 72);
  return props;
}

// ─── Step 7: Import Dev Tracker ───────────────────────────────────────────────
async function importDevProjects() {
  report('Importing dev projects…', 74);
  const projects = [];
  try {
    const tabs = await listTabTitles(SHEET_IDS.DEV_TRACKER);
    for (const tab of tabs) {
      try {
        const rows = await getTabValues(tab, RANGE, SHEET_IDS.DEV_TRACKER);
        if (!rows || rows.length < 2) continue;
        const h = rows[0];
        const urlCol    = hi(h, 'url');
        const statusCol = hi(h, 'status');
        const fbCol     = hi(h, 'feedback', 'feedbacks');
        const dateCol   = hi(h, 'date');
        const noteCol   = hi(h, 'note', 'updates');

        const items = rows.slice(1).map((r, idx) => {
          const url = (r[urlCol] || '').trim();
          if (!url) return null;
          return {
            idx,
            url, status: r[statusCol] || '',
            feedbackUrl: r[fbCol] || '',
            date: r[dateCol] || '',
            notes: r[noteCol] || '',
            updatedAt: now(),
          };
        }).filter(Boolean);

        if (items.length) projects.push({ id: uuid(), project: tab, items, updatedAt: now() });
      } catch {}
    }
  } catch (e) { console.error('[sync] dev-projects failed:', e.message); }
  report('Dev projects imported', 90);
  return projects;
}

// ─── Main sync entry point ────────────────────────────────────────────────────
export async function syncAll() {
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
    userMap = seedUsers();
  } catch (e) { console.error('[sync] STEP 1 (seedUsers) FAILED:', e); report('⚠ Users failed: ' + e.message, 3); }

  // Step 2: Sites (CW + RM)
  try {
    report('Importing sites from CW + RM…', 5);
    sites = await importSites();
    report(`Sites imported: ${sites.length}`, 20);
  } catch (e) { console.error('[sync] STEP 2 (importSites) FAILED:', e); report('⚠ Sites failed: ' + e.message, 20); }

  // Step 3: Merge domain expiry into sites
  try {
    await mergeDomains(sites);
  } catch (e) { console.error('[sync] STEP 3 (mergeDomains) FAILED:', e); report('⚠ Domain merge failed: ' + e.message, 25); }

  // Step 4: Daily review + assign users to sites
  try {
    drRows = await importDailyReview(sites, userMap);
  } catch (e) { console.error('[sync] STEP 4 (importDailyReview) FAILED:', e); report('⚠ Daily review failed: ' + e.message, 50); }

  // Step 5: Tasks
  try {
    tasks = await importTasks(sites, userMap);
  } catch (e) { console.error('[sync] STEP 5 (importTasks) FAILED:', e); report('⚠ Tasks failed: ' + e.message, 60); }

  // Step 6: Properties
  try {
    props = await importProperties(userMap);
  } catch (e) { console.error('[sync] STEP 6 (importProperties) FAILED:', e); report('⚠ Properties failed: ' + e.message, 75); }

  // Step 7: Dev projects
  try {
    devProjects = await importDevProjects();
  } catch (e) { console.error('[sync] STEP 7 (importDevProjects) FAILED:', e); report('⚠ Dev projects failed: ' + e.message, 90); }

  // Persist everything (even partial)
  report('Saving to local database…', 95);
  setSites(sites);
  setDailyReview(drRows);
  setTasks(tasks);
  setProperties(props);
  setDevProjects(devProjects);

  const elapsed = Math.round((Date.now() - start) / 1000);
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
  };
}
