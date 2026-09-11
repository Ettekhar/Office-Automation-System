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

  // Ensure company and clickupLink fallback from site, and attach uptimeStatus
  rows.forEach(r => {
    const s = (r.siteId ? sitesById[r.siteId] : null) || (r.siteUrl ? sitesByUrl[(r.siteUrl||'').toLowerCase().trim()] : null);
    if (!r.company && s) r.company = s.company || s.account || '';
    if (!r.clickupLink && s?.clickupUrl) r.clickupLink = s.clickupUrl;
    r.uptimeStatus = s?.uptimeStatus || (r.uptimeRobot && /yes/i.test(r.uptimeRobot) ? 'online' : 'unknown');
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
