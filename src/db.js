/**
 * db.js — Relational JSON file database
 * Unified model: Users, Sites, Tasks, DailyReview, Properties, DevProjects
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = path.resolve(__dirname, '../data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

export const uuid = () => crypto.randomUUID();

// ─── Low-level I/O ───────────────────────────────────────────────────────────
function fp(name) { return path.join(DATA_DIR, `${name}.json`); }

export function dbRead(name) {
  try { return fs.existsSync(fp(name)) ? JSON.parse(fs.readFileSync(fp(name), 'utf8')) : null; }
  catch { return null; }
}

export function dbWrite(name, data) {
  fs.writeFileSync(fp(name), JSON.stringify(data, null, 2), 'utf8');
}

// ─── Timestamp ───────────────────────────────────────────────────────────────
const now = () => new Date().toISOString();

// ─── Normalize helper ────────────────────────────────────────────────────────
// Old data format may be object (keyed by user name) instead of array.
function ensureArray(data) {
  if (Array.isArray(data)) return data;
  if (data && typeof data === 'object') {
    const flat = Object.values(data).flat();
    return Array.isArray(flat) ? flat : [];
  }
  return [];
}

export function cleanDomainUrl(u) {
  return (u || '').toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/+$/, '').trim();
}

// ═══════════════════════════════════════════════════════════════════════════════
// USERS
// ═══════════════════════════════════════════════════════════════════════════════
export function getUsers() {
  const users = ensureArray(dbRead('users'));
  return users.map(u => ({ ...u, active: u.active !== false }));
}
export function setUsers(data) { dbWrite('users', data); }

export function getUserById(id) { return getUsers().find(u => u.id === id) || null; }
export function getUserByName(name) {
  const n = name?.toLowerCase().trim();
  return getUsers().find(u => u.name.toLowerCase() === n) || null;
}

export function createUser({ name, role = 'user', email = '', active = true }) {
  const users = getUsers();
  if (users.find(u => u.name.toLowerCase() === name.toLowerCase()))
    throw new Error(`User "${name}" already exists`);
  const user = { id: uuid(), name, role, email, active: active !== false, createdAt: now(), updatedAt: now() };
  users.push(user);
  setUsers(users);
  return user;
}

export function updateUser(id, updates) {
  const users = getUsers();
  const idx = users.findIndex(u => u.id === id);
  if (idx === -1) throw new Error(`User not found: ${id}`);
  users[idx] = { ...users[idx], ...updates, updatedAt: now() };
  setUsers(users);
  return users[idx];
}

export function deleteUser(id) {
  const users = getUsers().filter(u => u.id !== id);
  setUsers(users);
}

// ═══════════════════════════════════════════════════════════════════════════════
// SITES (merged from CW/RM + Domain Expiry + Daily Review assignments)
// ═══════════════════════════════════════════════════════════════════════════════
export function getSites(filter = {}) {
  let sites = ensureArray(dbRead('sites'));
  if (filter.account) sites = sites.filter(s => s.account === filter.account);
  if (filter.userId) sites = sites.filter(s => s.assignedUsers?.includes(filter.userId));
  return sites;
}
export function setSites(data) { dbWrite('sites', data); }

export function getSiteByUrl(url) {
  const u = url?.toLowerCase().trim();
  return (dbRead('sites') || []).find(s => s.url?.toLowerCase() === u) || null;
}

export function getSiteById(id) {
  return (dbRead('sites') || []).find(s => s.id === id) || null;
}

export function updateSite(id, updates) {
  const sites = dbRead('sites') || [];
  const idx = sites.findIndex(s => s.id === id);
  if (idx === -1) throw new Error(`Site not found: ${id}`);
  sites[idx] = { ...sites[idx], ...updates, updatedAt: now() };
  setSites(sites);
  return sites[idx];
}

export function addSite(siteData) {
  const sites = ensureArray(dbRead('sites'));
  const rawUrl = (siteData.url || '').trim();
  if (!rawUrl) throw new Error('Website URL is required');

  const normUrl = rawUrl.toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/+$/, '');
  const existing = sites.find(s => (s.url || '').toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/+$/, '') === normUrl);
  if (existing) throw new Error(`Site "${rawUrl}" already exists`);

  const statusVal = (siteData.status || '').toLowerCase().includes('deactiv') ? 'Deactive' : 'Active';
  const newSite = {
    id: uuid(),
    url: rawUrl,
    account: (siteData.account || 'CW').toUpperCase(),
    status: statusVal,
    cms: siteData.cms || '',
    company: siteData.company || siteData.account || 'CW',
    contact: siteData.contact || '',
    accountManager: siteData.accountManager || '',
    note: siteData.note || '',
    clickupUrl: siteData.clickupUrl || '',
    reportUrl: siteData.reportUrl || '',
    backupUrl: siteData.backupUrl || '',
    latestMonth: siteData.latestMonth || getActiveMonth() || '',
    latestMonthStatus: siteData.latestMonthStatus || '',
    monthlyHistory: [],
    domainExpiry: siteData.domainExpiry || '',
    daysLeft: siteData.daysLeft || null,
    assignedUsers: Array.isArray(siteData.assignedUsers) ? siteData.assignedUsers : [],
    uptimeStatus: 'unknown',
    lastUptimeCheck: null,
    createdAt: now(),
    updatedAt: now(),
  };

  sites.unshift(newSite);
  setSites(sites);

  if (newSite.assignedUsers.length) {
    try { assignUsersToSite(newSite.id, newSite.assignedUsers); } catch {}
  }

  return newSite;
}

export function toggleSiteStatus(id, newStatus) {
  const sites = ensureArray(dbRead('sites'));
  const idx = sites.findIndex(s => s.id === id);
  if (idx === -1) throw new Error(`Site not found: ${id}`);

  const current = sites[idx].status || 'Active';
  const target = newStatus || (current.toLowerCase().includes('deactiv') ? 'Active' : 'Deactive');
  const statusVal = target.toLowerCase().includes('deactiv') ? 'Deactive' : 'Active';

  sites[idx] = {
    ...sites[idx],
    status: statusVal,
    note: statusVal === 'Deactive' ? 'Deactive' : (sites[idx].note === 'Deactive' ? '' : sites[idx].note),
    updatedAt: now()
  };
  setSites(sites);
  return sites[idx];
}

export function assignUsersToSite(siteId, userIds) {
  const sites = ensureArray(dbRead('sites'));
  const idx = sites.findIndex(s => s.id === siteId);
  if (idx === -1) throw new Error(`Site not found: ${siteId}`);

  sites[idx] = { ...sites[idx], assignedUsers: userIds, updatedAt: now() };
  setSites(sites);
  const site = sites[idx];

  // Synchronize daily-review records
  let drRows = ensureArray(dbRead('daily-review'));
  const allUsers = getUsers();
  const userMap = Object.fromEntries(allUsers.map(u => [u.id, u]));

  // 1. Remove rows for users unassigned from this site
  drRows = drRows.filter(r => {
    if (r.siteId === siteId) {
      return userIds.includes(r.userId);
    }
    return true;
  });

  // 2. Add rows for newly assigned users if missing
  for (const uid of userIds) {
    const existing = drRows.find(r => r.siteId === siteId && r.userId === uid);
    if (!existing) {
      const u = userMap[uid];
      drRows.push({
        id: uuid(),
        userId: uid,
        userName: u ? u.name : 'User',
        siteId: site.id,
        siteUrl: site.url,
        company: site.company || site.account || '',
        rowIndex: null,
        maintenanceStatus: 'todo',
        maintenanceRaw: 'To Do',
        reportSentStatus: 'no',
        reportSentRaw: 'No',
        ga4: '',
        newsletterMail: '',
        formSubmissionMail: '',
        bookingLink: '',
        cloudflare: 'No',
        clickupLink: site.clickupUrl || '',
        clientResponse: '',
        uptimeRobot: 'Yes',
        createdAt: now(),
        updatedAt: now(),
      });
    }
  }

  setDailyReview(drRows);
  return site;
}

// ═══════════════════════════════════════════════════════════════════════════════
// DAILY REVIEW ROWS (per-user, per-site records)
// ═══════════════════════════════════════════════════════════════════════════════

export function getDailyReview(filter = {}) {
  let rows = ensureArray(dbRead('daily-review'));
  const sites = ensureArray(dbRead('sites'));
  const sitesById = Object.fromEntries(sites.map(s => [s.id, s]));
  const sitesByUrl = Object.fromEntries(sites.map(s => [(s.url || '').toLowerCase().trim(), s]));

  let targetUserId = filter.userId || null;
  if (!targetUserId && filter.userName) {
    const u = getUserByName(filter.userName);
    if (u) targetUserId = u.id;
  }

  // Ensure any site that has assignedUsers includes targetUserId has a daily-review row
  if (targetUserId) {
    let changed = false;
    const userSites = sites.filter(s => s.assignedUsers?.includes(targetUserId));
    const allUsers = getUsers();
    const u = allUsers.find(x => x.id === targetUserId);
    const uName = u ? u.name : (filter.userName || 'User');

    for (const s of userSites) {
      const exists = rows.some(r => (r.siteId === s.id || (r.siteUrl && s.url && r.siteUrl.toLowerCase().trim() === s.url.toLowerCase().trim())) && r.userId === targetUserId);
      if (!exists) {
        rows.push({
          id: uuid(),
          userId: targetUserId,
          userName: uName,
          siteId: s.id,
          siteUrl: s.url,
          company: s.company || s.account || '',
          rowIndex: null,
          maintenanceStatus: 'todo',
          maintenanceRaw: 'To Do',
          reportSentStatus: 'no',
          reportSentRaw: 'No',
          ga4: '',
          newsletterMail: '',
          formSubmissionMail: '',
          bookingLink: '',
          cloudflare: 'No',
          clickupLink: s.clickupUrl || '',
          clientResponse: '',
          uptimeRobot: 'Yes',
          createdAt: now(),
          updatedAt: now(),
        });
        changed = true;
      }
    }
    if (changed) setDailyReview(rows);
  }

  // Enrich rows with fallback info from site, uptimeStatus, domainExpiry, and pending requests
  const pendingRequests = ensureArray(dbRead('domain-expiry-requests')).filter(pr => pr.status === 'pending');
  const pendingBySite = {};
  for (const pr of pendingRequests) {
    if (pr.siteId) pendingBySite[pr.siteId] = pr;
    if (pr.siteUrl) {
      pendingBySite[(pr.siteUrl||'').toLowerCase().trim()] = pr;
      pendingBySite[cleanDomainUrl(pr.siteUrl)] = pr;
    }
  }

  rows.forEach(r => {
    const s = (r.siteId ? sitesById[r.siteId] : null) || (r.siteUrl ? sitesByUrl[(r.siteUrl||'').toLowerCase().trim()] : null);
    if (!r.company && s) r.company = s.company || s.account || '';
    if (!r.clickupLink && s?.clickupUrl) r.clickupLink = s.clickupUrl;
    r.uptimeStatus = s?.uptimeStatus || (r.uptimeRobot && /yes/i.test(r.uptimeRobot) ? 'online' : 'unknown');
    r.domainExpiry = s?.domainExpiry || '';
    r.daysLeft = s?.daysLeft ?? (r.domainExpiry ? calcDaysUntil(r.domainExpiry) : null);
    const cleanU = cleanDomainUrl(r.siteUrl);
    r.pendingExpiryRequest = (s?.id ? pendingBySite[s.id] : null) || 
                             pendingBySite[(r.siteUrl||'').toLowerCase().trim()] || 
                             (cleanU ? pendingBySite[cleanU] : null) || null;
  });

  if (filter.userId) rows = rows.filter(r => r.userId === filter.userId);
  if (filter.siteId) rows = rows.filter(r => r.siteId === filter.siteId);
  if (filter.userName) {
    rows = rows.filter(r => (r.userName||'').toLowerCase() === filter.userName.toLowerCase() || (targetUserId && r.userId === targetUserId));
  }
  return rows;
}
export function setDailyReview(rows) { dbWrite('daily-review', rows); }

export function getDailyReviewByUser(userName) {
  const user = getUserByName(userName);
  if (!user) return [];
  return getDailyReview({ userId: user.id });
}

export function updateDailyReviewRow(rowId, updates) {
  const rows = ensureArray(dbRead('daily-review'));
  const idx = rows.findIndex(r => r.id === rowId);
  if (idx === -1) throw new Error(`Daily review row not found: ${rowId}`);

  rows[idx] = { ...rows[idx], ...updates, updatedAt: now() };
  setDailyReview(rows);

  // If clickupLink or maintenanceStatus is updated, keep site record in sync if site exists
  if (updates.clickupLink || updates.maintenanceRaw || updates.maintenanceStatus) {
    const row = rows[idx];
    if (row.siteId || row.siteUrl) {
      try {
        const sites = ensureArray(dbRead('sites'));
        const sIdx = sites.findIndex(s => s.id === row.siteId || (row.siteUrl && s.url && s.url.toLowerCase().trim() === row.siteUrl.toLowerCase().trim()));
        if (sIdx !== -1) {
          const siteUpdates = {};
          if (updates.clickupLink) siteUpdates.clickupUrl = updates.clickupLink;
          if (updates.maintenanceRaw) siteUpdates.latestMonthStatus = updates.maintenanceRaw;
          sites[sIdx] = { ...sites[sIdx], ...siteUpdates, updatedAt: now() };
          setSites(sites);
        }
      } catch {}
    }
  }

  return rows[idx];
}

export function updateDailyReviewBatch(ids, updates) {
  if (!Array.isArray(ids) || !ids.length) return [];
  const rows = ensureArray(dbRead('daily-review'));
  const sites = ensureArray(dbRead('sites'));
  const idSet = new Set(ids);
  const updatedRows = [];
  let sitesChanged = false;

  for (let i = 0; i < rows.length; i++) {
    if (idSet.has(rows[i].id)) {
      rows[i] = { ...rows[i], ...updates, updatedAt: now() };
      updatedRows.push(rows[i]);

      if (updates.clickupLink || updates.maintenanceRaw || updates.maintenanceStatus) {
        const row = rows[i];
        const sIdx = sites.findIndex(s => s.id === row.siteId || (row.siteUrl && s.url && s.url.toLowerCase().trim() === row.siteUrl.toLowerCase().trim()));
        if (sIdx !== -1) {
          if (updates.clickupLink) sites[sIdx].clickupUrl = updates.clickupLink;
          if (updates.maintenanceRaw) sites[sIdx].latestMonthStatus = updates.maintenanceRaw;
          sites[sIdx].updatedAt = now();
          sitesChanged = true;
        }
      }
    }
  }

  setDailyReview(rows);
  if (sitesChanged) setSites(sites);
  return updatedRows;
}

// ═══════════════════════════════════════════════════════════════════════════════
// TASKS
// ═══════════════════════════════════════════════════════════════════════════════
export function getTasks(filter = {}) {
  let tasks = ensureArray(dbRead('tasks'));
  if (filter.assigneeId) tasks = tasks.filter(t => t.assigneeId === filter.assigneeId);
  if (filter.siteId) tasks = tasks.filter(t => t.siteId === filter.siteId);
  if (filter.status) tasks = tasks.filter(t => t.status === filter.status);
  return tasks;
}
export function setTasks(data) { dbWrite('tasks', data); }

export function getTaskById(id) { return (dbRead('tasks') || []).find(t => t.id === id) || null; }

export function createTask({ taskName, siteUrl, siteId, assigneeId, assigneeName,
  taskType = '', status = 'todo', priority = 'medium', clickupLink = '',
  accountManager = '', deadline = '', notes = '' }) {
  const tasks = dbRead('tasks') || [];
  const task = {
    id: uuid(), taskName, siteUrl, siteId, assigneeId, assigneeName,
    taskType, status, priority, clickupLink, accountManager, deadline, notes,
    createdAt: now(), updatedAt: now(),
  };
  tasks.push(task);
  setTasks(tasks);
  return task;
}

export function updateTask(id, updates) {
  const tasks = dbRead('tasks') || [];
  const idx = tasks.findIndex(t => t.id === id);
  if (idx === -1) throw new Error(`Task not found: ${id}`);
  tasks[idx] = { ...tasks[idx], ...updates, updatedAt: now() };
  setTasks(tasks);
  return tasks[idx];
}

export function deleteTask(id) {
  setTasks((dbRead('tasks') || []).filter(t => t.id !== id));
}

// ═══════════════════════════════════════════════════════════════════════════════
// PROPERTIES
// ═══════════════════════════════════════════════════════════════════════════════
export function getProperties() { return ensureArray(dbRead('properties')); }
export function setProperties(data) { dbWrite('properties', data); }

export function updateProperty(id, updates) {
  const props = dbRead('properties') || [];
  const idx = props.findIndex(p => p.id === id);
  if (idx === -1) throw new Error(`Property not found: ${id}`);
  props[idx] = { ...props[idx], ...updates, updatedAt: now() };
  setProperties(props);
  return props[idx];
}

export function deleteProperty(id) {
  setProperties((dbRead('properties') || []).filter(p => p.id !== id));
}

// ═══════════════════════════════════════════════════════════════════════════════
// DEV PROJECTS
// ═══════════════════════════════════════════════════════════════════════════════
export function getDevProjects() { return ensureArray(dbRead('dev-projects')); }
export function setDevProjects(data) { dbWrite('dev-projects', data); }

export function updateDevProjectItem(projectId, itemIdx, updates) {
  const projs = dbRead('dev-projects') || [];
  const pIdx = projs.findIndex(p => p.id === projectId || p.project === projectId);
  if (pIdx === -1) throw new Error(`Project not found: ${projectId}`);
  if (!projs[pIdx].items[itemIdx]) throw new Error(`Item not found: ${itemIdx}`);
  projs[pIdx].items[itemIdx] = { ...projs[pIdx].items[itemIdx], ...updates, updatedAt: now() };
  setDevProjects(projs);
  return { project: projs[pIdx], item: projs[pIdx].items[itemIdx] };
}

export function addDevProjectItem(projectId, newItem) {
  const projs = dbRead('dev-projects') || [];
  const pIdx = projs.findIndex(p => p.id === projectId || p.project === projectId);
  if (pIdx === -1) throw new Error(`Project not found: ${projectId}`);
  const items = projs[pIdx].items || [];
  const item = {
    idx: items.length,
    rowNum: items.length ? Math.max(...items.map(i => i.rowNum || 0)) + 1 : 2,
    feedbackGroup: newItem.feedbackGroup || 'Feedback 1',
    url: newItem.url || '',
    status: newItem.status || 'Pending',
    devDate: newItem.devDate || '',
    devNotes: newItem.devNotes || '',
    feedbackUrl: newItem.feedbackUrl || '',
    date: newItem.date || new Date().toISOString().slice(0, 10),
    notes: newItem.notes || '',
    // Hand-added sheet columns (auto-discovered keys) — kept on the item so a
    // new column is stored and editable like any built-in field.
    extra: newItem.extra && typeof newItem.extra === 'object' ? newItem.extra : {},
    isHeader: false,
    updatedAt: now(),
  };
  items.push(item);
  projs[pIdx].items = items;
  projs[pIdx].updatedAt = now();
  setDevProjects(projs);
  return { project: projs[pIdx], item };
}

export function addDevProjectFeedbackRound(projectId, { feedbackGroup, feedbackUrl, date, notes, status, url, devDate, devNotes, extra }) {
  const projs = dbRead('dev-projects') || [];
  const pIdx = projs.findIndex(p => p.id === projectId || p.project === projectId);
  if (pIdx === -1) throw new Error(`Project not found: ${projectId}`);
  const items = projs[pIdx].items || [];
  const maxRow = items.length ? Math.max(...items.map(i => i.rowNum || 0)) : 1;

  // Header row item
  const headerItem = {
    idx: items.length,
    rowNum: maxRow + 1,
    feedbackGroup,
    url: '',
    status: 'Header',
    devDate: '',
    devNotes: '',
    feedbackUrl: `${(feedbackGroup || 'Feedback').replace(/\s+/g, '-')} URL`,
    date: '',
    notes: '',
    isHeader: true,
    updatedAt: now(),
  };
  items.push(headerItem);

  // First comment/work item
  const workItem = {
    idx: items.length,
    rowNum: maxRow + 2,
    feedbackGroup,
    url: url || '',
    status: status || 'In Progress',
    devDate: devDate || '',
    devNotes: devNotes || '',
    feedbackUrl: feedbackUrl || '',
    date: date || new Date().toISOString().slice(0, 10),
    notes: notes || '',
    extra: extra && typeof extra === 'object' ? extra : {},
    isHeader: false,
    updatedAt: now(),
  };
  items.push(workItem);

  projs[pIdx].items = items;
  projs[pIdx].updatedAt = now();
  setDevProjects(projs);
  return { project: projs[pIdx], headerItem, workItem };
}

export function bulkAddDevProjectUrls(projectId, urls, status = 'todo') {
  const projs = dbRead('dev-projects') || [];
  const pIdx = projs.findIndex(p => p.id === projectId || p.project === projectId);
  if (pIdx === -1) throw new Error(`Project not found: ${projectId}`);
  const items = projs[pIdx].items || [];
  let maxRow = items.length ? Math.max(...items.map(i => i.rowNum || 0)) : 1;
  const added = [];

  urls.forEach(u => {
    const clean = (u || '').trim();
    if (!clean) return;
    maxRow++;
    const item = {
      idx: items.length,
      rowNum: maxRow,
      feedbackGroup: 'General',
      url: clean,
      status: status || 'todo',
      devDate: '',
      devNotes: '',
      feedbackUrl: '',
      date: new Date().toISOString().slice(0, 10),
      notes: '',
      isHeader: false,
      updatedAt: now(),
    };
    items.push(item);
    added.push(item);
  });

  projs[pIdx].items = items;
  projs[pIdx].updatedAt = now();
  setDevProjects(projs);
  return { project: projs[pIdx], addedCount: added.length };
}

export function createDevProject({ projectName, urls = [], feedbackUrl = '', date = '', notes = '', status = 'todo' }) {
  const projs = dbRead('dev-projects') || [];
  const cleanName = (projectName || '').trim();
  if (!cleanName) throw new Error('Project name is required');
  
  const existing = projs.find(p => p.project.toLowerCase() === cleanName.toLowerCase());
  if (existing) throw new Error(`Project "${cleanName}" already exists`);

  const id = Buffer.from(cleanName).toString('base64').replace(/=/g, '');
  const items = [];
  let rowNum = 2;

  // Add sitemap URLs
  urls.forEach(u => {
    const clean = (u || '').trim();
    if (!clean) return;
    items.push({
      idx: items.length,
      rowNum: rowNum++,
      feedbackGroup: 'Feedback 1',
      url: clean,
      status: status || 'todo',
      devDate: '',
      devNotes: '',
      feedbackUrl: '',
      date: '',
      notes: '',
      isHeader: false,
      updatedAt: now(),
    });
  });

  // Add Feedback-1 header
  items.push({
    idx: items.length,
    rowNum: rowNum++,
    feedbackGroup: 'Feedback 1',
    url: '',
    status: 'Header',
    devDate: '',
    devNotes: '',
    feedbackUrl: 'Feedback-1 URL',
    date: '',
    notes: '',
    isHeader: true,
    updatedAt: now(),
  });

  // Add initial work/feedback row
  items.push({
    idx: items.length,
    rowNum: rowNum++,
    feedbackGroup: 'Feedback 1',
    url: '',
    status: status || 'in_progress',
    devDate: '',
    devNotes: '',
    feedbackUrl: feedbackUrl || '',
    date: date || new Date().toISOString().slice(0, 10),
    notes: notes || 'Initial setup and tasks',
    isHeader: false,
    updatedAt: now(),
  });

  const newProj = {
    id,
    project: cleanName,
    items,
    updatedAt: now(),
  };

  projs.push(newProj);
  setDevProjects(projs);
  return { project: newProj };
}

// ═══════════════════════════════════════════════════════════════════════════════
// NOTICES (Notice Board / Pinned Announcements)
// ═══════════════════════════════════════════════════════════════════════════════
export function getNotices() {
  const notices = ensureArray(dbRead('notices'));
  return notices.sort((a, b) => {
    if (a.pinned !== b.pinned) return (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0);
    return new Date(b.createdAt || 0) - new Date(a.createdAt || 0);
  });
}
export function setNotices(data) { dbWrite('notices', data); }

export function getNoticeById(id) {
  return (dbRead('notices') || []).find(n => n.id === id) || null;
}

export function createNotice({ title, content, link = '', linkLabel = '', pinned = false, authorName = 'Admin', authorRole = 'admin' }) {
  const notices = ensureArray(dbRead('notices'));
  const notice = {
    id: uuid(),
    title,
    content,
    link,
    linkLabel: linkLabel || (link ? 'Open Link ↗' : ''),
    pinned: pinned === true,
    authorName,
    authorRole,
    createdAt: now(),
    updatedAt: now(),
  };
  notices.unshift(notice);
  setNotices(notices);
  return notice;
}

export function updateNotice(id, updates) {
  const notices = ensureArray(dbRead('notices'));
  const idx = notices.findIndex(n => n.id === id);
  if (idx === -1) throw new Error(`Notice not found: ${id}`);
  notices[idx] = { ...notices[idx], ...updates, updatedAt: now() };
  setNotices(notices);
  return notices[idx];
}

export function deleteNotice(id) {
  const notices = ensureArray(dbRead('notices')).filter(n => n.id !== id);
  setNotices(notices);
}

// ═══════════════════════════════════════════════════════════════════════════════
// DOMAIN EXPIRY & APPROVAL WORKFLOW
// ═══════════════════════════════════════════════════════════════════════════════
export function calcDaysUntil(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return null;
  return Math.ceil((d.getTime() - Date.now()) / 86400000);
}

export function getDomainExpiryRequests(filter = {}) {
  let list = ensureArray(dbRead('domain-expiry-requests'));
  if (filter.status) list = list.filter(r => r.status === filter.status);
  if (filter.siteId) list = list.filter(r => r.siteId === filter.siteId);
  return list;
}
export function setDomainExpiryRequests(data) { dbWrite('domain-expiry-requests', data); }

export function createDomainExpiryRequest({ siteId, siteUrl, requestedDate, requestedBy = '', requestedByName = '' }) {
  if (!requestedDate) throw new Error('requestedDate is required');
  const list = ensureArray(dbRead('domain-expiry-requests'));
  const normUrl = (siteUrl || '').toLowerCase().trim();
  const cleanU = cleanDomainUrl(siteUrl);
  const existingIdx = list.findIndex(r => r.status === 'pending' && ((siteId && r.siteId === siteId) || (cleanU && cleanDomainUrl(r.siteUrl) === cleanU)));
  const reqItem = {
    id: existingIdx !== -1 ? list[existingIdx].id : uuid(),
    siteId: siteId || '',
    siteUrl: siteUrl || '',
    requestedDate: requestedDate.trim(),
    requestedBy,
    requestedByName,
    status: 'pending',
    createdAt: existingIdx !== -1 ? list[existingIdx].createdAt : now(),
    updatedAt: now(),
    resolvedAt: null,
    resolvedBy: null,
  };
  if (existingIdx !== -1) {
    list[existingIdx] = reqItem;
  } else {
    list.unshift(reqItem);
  }
  setDomainExpiryRequests(list);
  return reqItem;
}

export function updateSiteDomainExpiryDirect(siteIdOrUrl, newDate) {
  const sites = ensureArray(dbRead('sites'));
  const normKey = (siteIdOrUrl || '').toLowerCase().trim();
  const cleanKey = cleanDomainUrl(siteIdOrUrl);
  const sIdx = sites.findIndex(s => s.id === siteIdOrUrl || (s.url && cleanDomainUrl(s.url) === cleanKey));
  if (sIdx === -1) throw new Error(`Site not found: ${siteIdOrUrl}`);

  const days = calcDaysUntil(newDate);
  sites[sIdx] = {
    ...sites[sIdx],
    domainExpiry: newDate,
    daysLeft: days,
    updatedAt: now(),
  };
  setSites(sites);

  // Auto-resolve any pending request for this site
  const list = ensureArray(dbRead('domain-expiry-requests'));
  let reqsChanged = false;
  list.forEach(r => {
    if (r.status === 'pending' && (r.siteId === sites[sIdx].id || (cleanDomainUrl(r.siteUrl) === cleanDomainUrl(sites[sIdx].url)))) {
      r.status = 'approved';
      r.resolvedAt = now();
      r.resolvedBy = 'admin-direct';
      reqsChanged = true;
    }
  });
  if (reqsChanged) setDomainExpiryRequests(list);

  return sites[sIdx];
}

export function resolveDomainExpiryRequest(id, action, resolvedBy = 'admin') {
  if (!['approved', 'rejected'].includes(action)) throw new Error('action must be approved or rejected');
  const list = ensureArray(dbRead('domain-expiry-requests'));
  const idx = list.findIndex(r => r.id === id);
  if (idx === -1) throw new Error(`Request not found: ${id}`);

  const reqItem = list[idx];
  reqItem.status = action;
  reqItem.resolvedAt = now();
  reqItem.resolvedBy = resolvedBy;
  list[idx] = reqItem;
  setDomainExpiryRequests(list);

  let updatedSite = null;
  if (action === 'approved') {
    updatedSite = updateSiteDomainExpiryDirect(reqItem.siteId || reqItem.siteUrl, reqItem.requestedDate);
  }
  return { request: reqItem, site: updatedSite };
}

// ═══════════════════════════════════════════════════════════════════════════════
// META & STATS
// ═══════════════════════════════════════════════════════════════════════════════
export function getMeta() { return dbRead('meta') || { lastSync: null, version: 0 }; }
export function setMeta(updates) { dbWrite('meta', { ...getMeta(), ...updates }); }

export function isInitialised() {
  return ['users', 'sites', 'daily-review', 'tasks', 'properties', 'dev-projects']
    .every(c => fs.existsSync(fp(c)));
}

export function getDbStats() {
  const meta = getMeta();
  const users = getUsers();
  const sites = ensureArray(dbRead('sites'));
  const tasks = ensureArray(dbRead('tasks'));
  const dr    = ensureArray(dbRead('daily-review'));
  const props = ensureArray(dbRead('properties'));

  const drCompleted = dr.filter(r => r.maintenanceStatus === 'completed').length;
  const drTotal     = dr.filter(r => r.maintenanceStatus).length;

  return {
    lastSync:      meta.lastSync,
    syncDuration:  meta.syncDuration,
    totalUsers:    users.filter(u => u.active !== false).length,
    totalSites:    sites.length,
    totalTasks:    tasks.length,
    totalDailyRows:dr.length,
    totalDomains:  sites.filter(s => s.domainExpiry).length,
    totalProperties: props.length,
    urgentDomains: sites.filter(s => s.daysLeft !== null && s.daysLeft <= 30).length,
    onlineSites:   sites.filter(s => s.uptimeStatus === 'online').length,
    offlineSites:  sites.filter(s => s.uptimeStatus === 'offline').length,
    completionPct: drTotal > 0 ? Math.round(drCompleted / drTotal * 100) : 0,
    initialised:   isInitialised(),
  };
}

export function getActiveMonth() {
  const meta = getMeta();
  if (meta.activeMonth) return meta.activeMonth;
  const sites = ensureArray(dbRead('sites'));
  const firstWithMonth = sites.find(s => s.latestMonth);
  return firstWithMonth?.latestMonth || 'August';
}

export function getAllMonths() {
  const meta = getMeta();
  const set = new Set();
  if (Array.isArray(meta.months)) meta.months.forEach(m => set.add(m));
  const sites = ensureArray(dbRead('sites'));
  sites.forEach(s => {
    if (s.latestMonth) set.add(s.latestMonth);
    (s.monthlyHistory || []).forEach(m => { if (m.month) set.add(m.month); });
  });
  if (meta.activeMonth) set.add(meta.activeMonth);
  return Array.from(set);
}

export function addNewMonth(monthName) {
  const cleanMonth = (monthName || '').trim();
  if (!cleanMonth) throw new Error('Month name is required');

  const meta = getMeta();
  const months = new Set(Array.isArray(meta.months) ? meta.months : []);
  months.add(cleanMonth);

  setMeta({
    activeMonth: cleanMonth,
    months: Array.from(months),
    lastMonthAdded: cleanMonth,
    lastMonthAddedAt: now(),
  });

  // Update sites
  const sites = ensureArray(dbRead('sites'));
  sites.forEach(site => {
    if (!site.monthlyHistory) site.monthlyHistory = [];
    const exists = site.monthlyHistory.some(m => (m.month || '').toLowerCase() === cleanMonth.toLowerCase());
    if (!exists) {
      site.monthlyHistory.push({ month: cleanMonth, status: '' });
    }
    site.latestMonth = cleanMonth;
    site.latestMonthStatus = '';
    site.updatedAt = now();
  });
  setSites(sites);

  // Reset daily review rows for the new month
  const dr = ensureArray(dbRead('daily-review'));
  dr.forEach(r => {
    r.maintenanceStatus = 'todo';
    r.maintenanceRaw = 'To Do';
    r.reportSentStatus = 'no';
    r.reportSentRaw = 'No';
    r.updatedAt = now();
  });
  setDailyReview(dr);

  return { monthName: cleanMonth, activeMonth: cleanMonth, totalSites: sites.length };
}

// ═══════════════════════════════════════════════════════════════════════════════
// CUSTOM SHEETS (Superadmin-registered external Google Sheets)
// ═══════════════════════════════════════════════════════════════════════════════
export function getCustomSheets() {
  return ensureArray(dbRead('custom-sheets'));
}
export function setCustomSheets(data) { dbWrite('custom-sheets', data); }

export function getCustomSheetById(id) {
  return (dbRead('custom-sheets') || []).find(s => s.id === id) || null;
}

export function createCustomSheet({
  label, spreadsheetId, tabName, headerRow = 1,
  visibleTo = ['superadmin'], color = '#6366f1',
  icon = 'table', pinToTop = false, statColumns = [],
  createdBy = 'superadmin',
}) {
  if (!label || !spreadsheetId || !tabName) throw new Error('label, spreadsheetId and tabName are required');
  const sheets = ensureArray(dbRead('custom-sheets'));
  const dup = sheets.find(s => s.spreadsheetId === spreadsheetId && s.tabName === tabName);
  if (dup) throw new Error(`Sheet "${tabName}" in spreadsheet "${spreadsheetId}" already registered`);
  const sheet = {
    id: uuid(),
    label: label.trim(),
    spreadsheetId: spreadsheetId.trim(),
    tabName: tabName.trim(),
    headerRow: Number(headerRow) || 1,
    visibleTo: Array.isArray(visibleTo) ? visibleTo : ['superadmin'],
    color: color || '#6366f1',
    icon: icon || 'table',
    pinToTop: !!pinToTop,
    statColumns: Array.isArray(statColumns) ? statColumns : [],
    connectionStatus: 'untested',
    lastProbed: null,
    columns: [],
    createdBy,
    createdAt: now(),
    updatedAt: now(),
  };
  sheets.unshift(sheet);
  setCustomSheets(sheets);
  return sheet;
}

export function updateCustomSheet(id, updates) {
  const sheets = ensureArray(dbRead('custom-sheets'));
  const idx = sheets.findIndex(s => s.id === id);
  if (idx === -1) throw new Error(`Custom sheet not found: ${id}`);
  sheets[idx] = { ...sheets[idx], ...updates, id, updatedAt: now() };
  setCustomSheets(sheets);
  return sheets[idx];
}

export function deleteCustomSheet(id) {
  const sheets = ensureArray(dbRead('custom-sheets')).filter(s => s.id !== id);
  setCustomSheets(sheets);
}

// ═══════════════════════════════════════════════════════════════════════════════
// SHEET CREDENTIALS (System & Custom Connected Sheets)
// ═══════════════════════════════════════════════════════════════════════════════
export const DEFAULT_SHEET_CREDENTIALS = [
  {
    id: 'cw-maintenance',
    key: 'CW_MAINTENANCE',
    title: 'CW Maintenance Sheet',
    category: 'Core Maintenance',
    spreadsheetId: process.env.CW_SPREADSHEET_ID || '19aIBNOb0C4_Fx47bsZ2mUMVAxogX7j_tly8tSg-bldE',
    tabName: 'Website List',
    headerRow: 2,
    active: true,
    visibleTo: ['superadmin', 'admin', 'user'],
    editableBy: ['superadmin', 'admin'],
    connectionStatus: 'ok',
    lastChecked: null,
    isSystem: true,
    description: 'Cogwheel Marketing website directory, contacts, and monthly maintenance reports.',
  },
  {
    id: 'rm-maintenance',
    key: 'RM_MAINTENANCE',
    title: 'RM Maintenance Sheet',
    category: 'Core Maintenance',
    spreadsheetId: process.env.RM_SPREADSHEET_ID || '1Fbb-SY2fU0HXFdnJ_OQoHb_AwlFzdk39jWOo3kFMcjY',
    tabName: 'Website List',
    headerRow: 2,
    active: true,
    visibleTo: ['superadmin', 'admin', 'user'],
    editableBy: ['superadmin', 'admin'],
    connectionStatus: 'ok',
    lastChecked: null,
    isSystem: true,
    description: 'Razib Marketing website directory, contacts, and monthly maintenance reports.',
  },
  {
    id: 'master-tracker',
    key: 'MASTER_TRACKER',
    title: 'Master Tracker & Distribution',
    category: 'Tasks & Distribution',
    spreadsheetId: '1VnI5ZxVr5QykBOwYDOLp_1bbCpApfc0Jwljf01Q7djU',
    tabName: 'Distribution and Work Sheet',
    headerRow: 1,
    active: true,
    visibleTo: ['superadmin', 'admin'],
    editableBy: ['superadmin', 'admin'],
    connectionStatus: 'ok',
    lastChecked: null,
    isSystem: true,
    showInNav: true,
    navSection: 'Connected Sheets',
    description: 'Central task distribution across team members and domain expiry tracker.',
  },
  {
    id: 'daily-review',
    key: 'DAILY_REVIEW',
    title: 'Daily Review Sheet',
    category: 'Daily Activity',
    spreadsheetId: '1C4jSa49P6LHEN8ywh92fOgBPif6OSKuXx8PoRONtWzs',
    tabName: 'Toufiq',
    headerRow: 1,
    active: true,
    visibleTo: ['superadmin', 'admin', 'user'],
    editableBy: ['superadmin', 'admin', 'user'],
    connectionStatus: 'ok',
    lastChecked: null,
    isSystem: true,
    description: 'Daily team review logs, per-user tracking tabs, and status updates.',
  },
  {
    id: 'property-registry',
    key: 'PROPERTY_REGISTRY',
    title: 'Property Registry Sheet',
    category: 'Properties & Assets',
    spreadsheetId: '1sWz7sNsQmi0xigD2AiMbxbC0lHDbKyQIGOB_jrrNJzY',
    tabName: 'Sheet1',
    headerRow: 1,
    active: true,
    visibleTo: ['superadmin', 'admin'],
    editableBy: ['superadmin'],
    connectionStatus: 'ok',
    lastChecked: null,
    isSystem: true,
    description: 'Property catalog, asset URLs, and assigned site managers.',
  },
  {
    id: 'dev-tracker',
    key: 'DEV_TRACKER',
    title: 'Dev Tracker Sheet',
    category: 'Development Tracker',
    spreadsheetId: '14PXRHUkFG-gf0DwbGVqeyPA7aQ4LyhDMjAeTVatOI78',
    tabName: 'AnsAngel coalition',
    headerRow: 1,
    active: true,
    visibleTo: ['superadmin', 'admin', 'user'],
    editableBy: ['superadmin', 'admin'],
    connectionStatus: 'ok',
    lastChecked: null,
    isSystem: true,
    description: 'Development sprints, bug backlog, and ongoing dev projects.',
  },
];

export function getSheetCredentials() {
  let list = dbRead('sheet-credentials');
  if (!Array.isArray(list) || list.length === 0) {
    list = DEFAULT_SHEET_CREDENTIALS.map(item => ({ ...item, createdAt: now(), updatedAt: now() }));
    dbWrite('sheet-credentials', list);
    return list;
  }

  // Migrate legacy default tab names if outdated
  let migrated = false;
  list.forEach(c => {
    if (c.id === 'master-tracker' && c.tabName === 'Distribution') {
      c.tabName = 'Distribution and Work Sheet';
      migrated = true;
    }
    if (c.id === 'daily-review' && c.tabName === 'Daily Review') {
      c.tabName = 'Toufiq';
      migrated = true;
    }
    if (c.id === 'property-registry' && c.tabName === 'Registry') {
      c.tabName = 'Sheet1';
      migrated = true;
    }
    if (c.id === 'dev-tracker' && c.tabName === 'Projects') {
      c.tabName = 'AnsAngel coalition';
      migrated = true;
    }
  });
  if (migrated) {
    dbWrite('sheet-credentials', list);
  }
  // Ensure default system sheets and role permissions exist on all records
  let modified = false;
  for (const def of DEFAULT_SHEET_CREDENTIALS) {
    const existing = list.find(s => s.id === def.id || s.key === def.key);
    if (!existing) {
      list.push({ ...def, createdAt: now(), updatedAt: now() });
      modified = true;
    }
  }
  list.forEach(item => {
    if (!item.visibleTo) {
      item.visibleTo = ['superadmin', 'admin', 'user'];
      modified = true;
    }
    if (!item.editableBy) {
      item.editableBy = ['superadmin', 'admin'];
      modified = true;
    }
    if (!item.navSection) {
      item.navSection = 'Connected Sheets';
      modified = true;
    }
    if (item.showInNav === undefined || item.showInNav === false) {
      item.showInNav = true;
      modified = true;
    }
    if (!Array.isArray(item.assignedUsers)) {
      item.assignedUsers = [];
      modified = true;
    }
    if (!item.headerRow) {
      item.headerRow = (item.id === 'cw-maintenance' || item.id === 'rm-maintenance') ? 2 : 1;
      modified = true;
    }
  });
  if (modified) {
    dbWrite('sheet-credentials', list);
  }
  return list;
}

export function setSheetCredentials(data) {
  dbWrite('sheet-credentials', data);
}

export function getSheetCredentialById(id) {
  return (getSheetCredentials() || []).find(s => s.id === id || s.key === id) || null;
}

export function updateSheetCredential(id, updates) {
  const list = getSheetCredentials();
  const idx = list.findIndex(s => s.id === id || s.key === id);
  if (idx === -1) throw new Error(`Sheet credential not found: ${id}`);
  list[idx] = { ...list[idx], ...updates, updatedAt: now() };
  setSheetCredentials(list);
  return list[idx];
}

export function createSheetCredential({
  title, spreadsheetId, tabName = 'Sheet1', category = 'Operations',
  navSection = 'Operations', visibleTo = ['superadmin', 'admin', 'user'],
  editableBy = ['superadmin', 'admin'], assignedUsers = [],
  description = '', active = true, icon = 'table', showInNav = true,
}) {
  if (!title || !spreadsheetId) throw new Error('Title and Spreadsheet ID are required');
  const list = getSheetCredentials();
  const item = {
    id: 'custom-' + uuid(),
    key: 'CUSTOM_' + Date.now(),
    title: title.trim(),
    category: (category || 'Operations').trim(),
    navSection: (navSection || 'Operations').trim(),
    spreadsheetId: spreadsheetId.trim(),
    tabName: (tabName || 'Sheet1').trim(),
    description: (description || '').trim(),
    icon: (icon || 'table').trim(),
    visibleTo: Array.isArray(visibleTo) && visibleTo.length ? visibleTo : ['superadmin', 'admin', 'user'],
    editableBy: Array.isArray(editableBy) && editableBy.length ? editableBy : ['superadmin', 'admin'],
    assignedUsers: Array.isArray(assignedUsers) ? assignedUsers : [],
    showInNav: showInNav !== false,
    active: active !== false,
    connectionStatus: 'untested',
    lastChecked: null,
    isSystem: false,
    createdAt: now(),
    updatedAt: now(),
  };
  list.push(item);
  setSheetCredentials(list);
  return item;
}

// =============================================================================
// AI CONFIG STORAGE NOTE
// =============================================================================
// Dev Assistant provider keys + RAG source live in data/assistant-config.json and
// are accessed only through getAssistantConfig/setAssistantConfig (defined above).
// Raw provider keys never leave the server - the superadmin UI receives masked
// previews only (see db.maskSecret and the /api/master/assistant-config route).

export function deleteSheetCredential(id) {
  const list = getSheetCredentials();
  const target = list.find(s => s.id === id || s.key === id);
  if (target?.isSystem) {
    throw new Error('System sheets cannot be deleted. You can deactivate them instead.');
  }
  const filtered = list.filter(s => s.id !== id && s.key !== id);
  setSheetCredentials(filtered);
}


// ═══════════════════════════════════════════════════════════════════════════════
// DEV ASSISTANT CONFIG (provider keys, RAG data source, retrieval settings)
//
// Stored in data/assistant-config.json (git-ignored — it holds API tokens).
// Keys stored HERE take precedence over .env, so a superadmin can add/rotate a
// token from the dashboard without editing files or restarting the server.
// ═══════════════════════════════════════════════════════════════════════════════

// Priority order of the fallback chain. Only providers that are BOTH enabled and
// holding a key (or a worker URL) are part of the live chain.
export const ASSISTANT_PROVIDER_ORDER = ['gemini', 'groq', 'openrouter', 'mistral', 'cloudflare'];

const ASSISTANT_PROVIDER_DEFAULTS = {
  gemini: { label: 'Google Gemini (AI Studio)', kind: 'gemini', keyEnv: 'GEMINI_API_KEY', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', models: '' },
  groq: { label: 'Groq', kind: 'openai', keyEnv: 'GROQ_API_KEY', baseUrl: 'https://api.groq.com/openai/v1', models: '' },
  openrouter: { label: 'OpenRouter', kind: 'openai', keyEnv: 'OPENROUTER_API_KEY', baseUrl: 'https://openrouter.ai/api/v1', models: '' },
  mistral: { label: 'Mistral', kind: 'openai', keyEnv: 'MISTRAL_API_KEY', baseUrl: 'https://api.mistral.ai/v1', models: '' },
  cloudflare: { label: 'Cloudflare Worker (self-hosted RAG gateway)', kind: 'worker', keyEnv: 'CLOUDFLARE_WORKER_TOKEN', urlEnv: 'CLOUDFLARE_WORKER_URL', baseUrl: '', models: '' },
};

function defaultProviderConfig() {
  const out = {};
  for (const name of ASSISTANT_PROVIDER_ORDER) {
    const d = ASSISTANT_PROVIDER_DEFAULTS[name];
    out[name] = { enabled: true, apiKey: '', baseUrl: '', models: '', label: d.label, kind: d.kind };
  }
  return out;
}

export function defaultAssistantConfig() {
  return {
    // Provider credentials entered in the dashboard (empty = fall back to .env).
    providers: defaultProviderConfig(),
    order: [...ASSISTANT_PROVIDER_ORDER],
    // Which Google Sheet the assistant reads (superadmin-selectable).
    source: {
      credentialId: 'dev-tracker',
      spreadsheetId: '14PXRHUkFG-gf0DwbGVqeyPA7aQ4LyhDMjAeTVatOI78',
      tabs: [],              // [] = all tabs of the spreadsheet
      freshOnAsk: false,     // true = re-pull from Google Sheets before answering
    },
    // Retrieval / accuracy tuning.
    rag: {
      strictGrounding: true, // reject an LLM answer containing numbers absent from ground truth
      verifyNumbers: true,   // run the numeric verification guard at all
      evidenceLimit: 18,     // max retrieved evidence rows fed to the LLM
      contextChars: 20000,   // hard cap on the RAG context string
      includePageUrls: true, // include sitemap page URLs of the matched project
    },
    updatedAt: null,
  };
}

function deepMergeAssistant(base, patch) {
  const out = { ...base };
  for (const [k, v] of Object.entries(patch || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object' && !Array.isArray(base[k])) {
      out[k] = deepMergeAssistant(base[k], v);
    } else if (v !== undefined) {
      out[k] = v;
    }
  }
  return out;
}

export function getAssistantConfig() {
  const raw = dbRead('assistant-config');
  const defaults = defaultAssistantConfig();
  if (!raw || typeof raw !== 'object') return defaults;
  const merged = deepMergeAssistant(defaults, raw);
  // Guarantee every known provider exists even if the stored file predates it.
  merged.providers = { ...defaultProviderConfig(), ...(merged.providers || {}) };
  for (const name of ASSISTANT_PROVIDER_ORDER) {
    merged.providers[name] = { ...defaultProviderConfig()[name], ...(merged.providers[name] || {}) };
  }
  // Guarantee every provider appears in the order list exactly once.
  const order = Array.isArray(merged.order) ? merged.order.filter(n => ASSISTANT_PROVIDER_ORDER.includes(n)) : [];
  merged.order = [...order, ...ASSISTANT_PROVIDER_ORDER.filter(n => !order.includes(n))];
  return merged;
}

export function setAssistantConfig(patch) {
  const next = deepMergeAssistant(getAssistantConfig(), patch || {});
  next.updatedAt = now();
  dbWrite('assistant-config', next);
  return next;
}

/**
 * Mask a secret for display: keeps the first 6 and last 4 characters.
 * Never send a raw key to the browser.
 */
export function maskSecret(value) {
  const v = String(value || '');
  if (!v) return '';
  if (v.length <= 12) return '•'.repeat(v.length);
  return `${v.slice(0, 6)}…${v.slice(-4)}`;
}

