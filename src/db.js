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
    if (pr.siteUrl) pendingBySite[(pr.siteUrl||'').toLowerCase().trim()] = pr;
  }

  rows.forEach(r => {
    const s = (r.siteId ? sitesById[r.siteId] : null) || (r.siteUrl ? sitesByUrl[(r.siteUrl||'').toLowerCase().trim()] : null);
    if (!r.company && s) r.company = s.company || s.account || '';
    if (!r.clickupLink && s?.clickupUrl) r.clickupLink = s.clickupUrl;
    r.uptimeStatus = s?.uptimeStatus || (r.uptimeRobot && /yes/i.test(r.uptimeRobot) ? 'online' : 'unknown');
    r.domainExpiry = s?.domainExpiry || '';
    r.daysLeft = s?.daysLeft ?? (r.domainExpiry ? calcDaysUntil(r.domainExpiry) : null);
    const siteKey = s?.id || (r.siteUrl||'').toLowerCase().trim();
    r.pendingExpiryRequest = pendingBySite[siteKey] || null;
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
  const pIdx = projs.findIndex(p => p.id === projectId);
  if (pIdx === -1) throw new Error(`Project not found: ${projectId}`);
  if (!projs[pIdx].items[itemIdx]) throw new Error(`Item not found: ${itemIdx}`);
  projs[pIdx].items[itemIdx] = { ...projs[pIdx].items[itemIdx], ...updates, updatedAt: now() };
  setDevProjects(projs);
  return projs[pIdx];
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
  const existingIdx = list.findIndex(r => r.status === 'pending' && ((siteId && r.siteId === siteId) || (normUrl && r.siteUrl && r.siteUrl.toLowerCase().trim() === normUrl)));
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
  const sIdx = sites.findIndex(s => s.id === siteIdOrUrl || (s.url && s.url.toLowerCase().trim() === normKey));
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
    if (r.status === 'pending' && (r.siteId === sites[sIdx].id || (r.siteUrl && r.siteUrl.toLowerCase().trim() === (sites[sIdx].url || '').toLowerCase().trim()))) {
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
