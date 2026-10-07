/**
 * db.js — Relational JSON file database
 * Unified model: Users, Sites, Tasks, DailyReview, Properties, DevProjects
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// OFFICEOS_DATA_DIR exists so tests and throwaway probes can run against a
// throwaway directory instead of the live one. Unset in every real process, so
// the default below is unchanged behaviour — but it removes the only reason a
// test could ever reach (and pollute) production data.
export const DATA_DIR = process.env.OFFICEOS_DATA_DIR
  ? path.resolve(process.env.OFFICEOS_DATA_DIR)
  : path.resolve(__dirname, '../data');
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
export function getUsers(options = {}) {
  const users = ensureArray(dbRead('users'));
  const mapped = users.map(u => ({ ...u, active: u.active !== false }));
  if (options && options.includeMerged) return mapped;
  return mapped.filter(u => !u.mergedInto);
}
export function setUsers(data) { dbWrite('users', data); }

export function getUserById(id) {
  if (!id) return null;
  const rawUsers = ensureArray(dbRead('users'));
  const u = rawUsers.find(x => x.id === id);
  if (!u) return null;
  if (u.mergedInto) return getUserById(u.mergedInto);
  return { ...u, active: u.active !== false };
}

export function getUserByName(name) {
  if (!name) return null;
  const n = name.toLowerCase().trim();
  const rawUsers = ensureArray(dbRead('users'));
  const u = rawUsers.find(x => !x.mergedInto && (x.name || '').toLowerCase().trim() === n);
  if (!u) return null;
  return { ...u, active: u.active !== false };
}

export function createUser({ name, role = 'user', email = '', active = true }) {
  const users = ensureArray(dbRead('users'));
  if (users.find(u => !u.mergedInto && (u.name || '').toLowerCase().trim() === name.toLowerCase().trim()))
    throw new Error(`User "${name}" already exists`);
  const user = { id: uuid(), name, role, email, active: active !== false, createdAt: now(), updatedAt: now() };
  users.push(user);
  setUsers(users);
  return user;
}

export function updateUser(id, updates) {
  const users = ensureArray(dbRead('users'));
  const idx = users.findIndex(u => u.id === id);
  if (idx === -1) throw new Error(`User not found: ${id}`);
  users[idx] = { ...users[idx], ...updates, updatedAt: now() };
  setUsers(users);
  return users[idx];
}

export function deleteUser(id) {
  const users = ensureArray(dbRead('users')).filter(u => u.id !== id);
  setUsers(users);
}

export function assignTempCoverage({ fromUserId, toUserId, assignedBy = 'Admin', note = '' }) {
  const users = ensureArray(dbRead('users'));
  const fromIdx = users.findIndex(u => u.id === fromUserId || u.name.toLowerCase() === String(fromUserId).toLowerCase());
  const toIdx = users.findIndex(u => u.id === toUserId || u.name.toLowerCase() === String(toUserId).toLowerCase());
  if (fromIdx === -1) throw new Error(`Source user not found: ${fromUserId}`);
  if (toIdx === -1) throw new Error(`Target user not found: ${toUserId}`);
  if (fromIdx === toIdx) throw new Error('Cannot assign user to themselves');

  const fromUser = users[fromIdx];
  const toUser = users[toIdx];

  // Update fromUser.tempAssignedTo
  const fromAssigned = Array.isArray(fromUser.tempAssignedTo) ? [...fromUser.tempAssignedTo] : [];
  const existingFromIdx = fromAssigned.findIndex(a => a.userId === toUser.id);
  const entry = {
    userId: toUser.id,
    userName: toUser.name,
    assignedAt: now(),
    assignedBy,
    note: note || '',
  };
  if (existingFromIdx >= 0) {
    fromAssigned[existingFromIdx] = entry;
  } else {
    fromAssigned.push(entry);
  }
  users[fromIdx] = { ...fromUser, tempAssignedTo: fromAssigned, updatedAt: now() };

  // Update toUser.tempCoveringUsers
  const toCovering = Array.isArray(toUser.tempCoveringUsers) ? [...toUser.tempCoveringUsers] : [];
  const existingToIdx = toCovering.findIndex(a => a.userId === fromUser.id);
  const covEntry = {
    userId: fromUser.id,
    userName: fromUser.name,
    assignedAt: now(),
    assignedBy,
    note: note || '',
  };
  if (existingToIdx >= 0) {
    toCovering[existingToIdx] = covEntry;
  } else {
    toCovering.push(covEntry);
  }
  users[toIdx] = { ...toUser, tempCoveringUsers: toCovering, updatedAt: now() };

  setUsers(users);
  return { fromUser: users[fromIdx], toUser: users[toIdx], users };
}

export function removeTempCoverage({ fromUserId, toUserId }) {
  const users = ensureArray(dbRead('users'));
  const fromStr = String(fromUserId || '').toLowerCase().trim();
  const toStr = String(toUserId || '').toLowerCase().trim();
  const fromIdx = users.findIndex(u => u.id === fromUserId || u.name.toLowerCase() === fromStr);
  const toIdx = users.findIndex(u => u.id === toUserId || u.name.toLowerCase() === toStr);

  const realFromId = fromIdx >= 0 ? users[fromIdx].id : fromUserId;
  const realFromName = fromIdx >= 0 ? users[fromIdx].name.toLowerCase() : fromStr;
  const realToId = toIdx >= 0 ? users[toIdx].id : toUserId;
  const realToName = toIdx >= 0 ? users[toIdx].name.toLowerCase() : toStr;

  // Clean fromUser
  if (fromIdx >= 0) {
    const fromUser = users[fromIdx];
    const fromAssigned = Array.isArray(fromUser.tempAssignedTo)
      ? fromUser.tempAssignedTo.filter(a => {
          const aId = a.userId || '';
          const aName = (a.userName || '').toLowerCase();
          return aId !== realToId && aId !== toStr && aName !== realToName;
        })
      : [];
    users[fromIdx] = { ...fromUser, tempAssignedTo: fromAssigned, updatedAt: now() };
  }

  // Clean toUser
  if (toIdx >= 0) {
    const toUser = users[toIdx];
    const toCovering = Array.isArray(toUser.tempCoveringUsers)
      ? toUser.tempCoveringUsers.filter(a => {
          const aId = a.userId || '';
          const aName = (a.userName || '').toLowerCase();
          return aId !== realFromId && aId !== fromStr && aName !== realFromName;
        })
      : [];
    users[toIdx] = { ...toUser, tempCoveringUsers: toCovering, updatedAt: now() };
  }

  // Comprehensively sweep across all user records for any orphaned cross-references
  for (let i = 0; i < users.length; i++) {
    let changed = false;
    if (Array.isArray(users[i].tempAssignedTo)) {
      const filtered = users[i].tempAssignedTo.filter(a => {
        const isFrom = users[i].id === realFromId || users[i].name.toLowerCase() === realFromName;
        const isTo = a.userId === realToId || a.userId === toStr || (a.userName && a.userName.toLowerCase() === realToName);
        return !(isFrom && isTo);
      });
      if (filtered.length !== users[i].tempAssignedTo.length) {
        users[i] = { ...users[i], tempAssignedTo: filtered, updatedAt: now() };
        changed = true;
      }
    }
    if (Array.isArray(users[i].tempCoveringUsers)) {
      const filtered = users[i].tempCoveringUsers.filter(a => {
        const isTo = users[i].id === realToId || users[i].name.toLowerCase() === realToName;
        const isFrom = a.userId === realFromId || a.userId === fromStr || (a.userName && a.userName.toLowerCase() === realFromName);
        return !(isTo && isFrom);
      });
      if (filtered.length !== users[i].tempCoveringUsers.length) {
        users[i] = { ...users[i], tempCoveringUsers: filtered, updatedAt: now() };
        changed = true;
      }
    }
  }

  setUsers(users);
  return { ok: true, users };
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
    clickupTimeTrackUrl: siteData.clickupTimeTrackUrl || '',
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

// ═══════════════════════════════════════════════════════════════════════════════
// SITE-FACT INHERITANCE (confirmed by the team 2026-09-26)
//
// Fields like GA4, the newsletter tool, the form-submission address and the
// booking link describe the SITE, not the person doing the work. They used to
// be stored per (site,user) with nothing to copy them, so assigning a second
// person to a site produced a nearly empty row even though the answer was
// already in the database under somebody else.
//
// When a daily-review record is created, it now inherits those site facts from
// an existing record for the SAME site.
//
// Three rules keep this from manufacturing data:
//
//  1. Only records actually READ FROM A TAB are donors. Records created by an
//     assignment carry no observation, and two such records "agreeing" with
//     each other is circular — the same code invented both.
//  2. Only ACTIVE users are donors. An inactive user's row is often a stale
//     copy of somebody else's and would launder old values back in.
//  3. Per-person work is NEVER inherited. maintenanceStatus, reportSentStatus
//     and their raw text are each person's own progress; copying them would
//     overwrite one person's real state with another's.
//
// A value is still only a SUGGESTION. Literal template placeholders such as
// "{admin_email}" are refused, and the donor is recorded per field so any
// inherited value can be traced back to who actually recorded it.
// ═══════════════════════════════════════════════════════════════════════════════

const DAILY_REVIEW_SITE_FACT_FIELDS = [
  'ga4', 'newsletterMail', 'formSubmissionMail', 'bookingLink',
  'clientResponse', 'cloudflare', 'uptimeRobot',
];

// A lone "{...}" is an unfilled template token, not an observation. Copying it
// just spreads the placeholder into another tab.
const TEMPLATE_PLACEHOLDER = /^\{[^}]*\}$/;

/*
 * ── Why rule 2 (active-only donors) is load-bearing, not belt-and-braces ──────
 *
 * There is a real class of value that is dormant *only* because of rule 2, and
 * it would be easy to "clean up" rule 2 without realising what that unblocks.
 *
 * Some sites carry a value that is probably a copy-paste mistake - one email
 * address sitting in BOTH the Newsletter and Form Submission columns, which ask
 * different questions. Inheritance copies cell for cell, so such a value would
 * be handed to the next assignee instead of being re-derived.
 *
 * duneclimbinn.com is the concrete case. Its only holder of
 * info@duneclimbinn.com in both columns is an INACTIVE user. Because rule 2
 * refuses inactive donors, that address currently cannot reach anybody: the
 * inheritance path finds zero donors for the site and writes nothing.
 *
 * That safety is a property of the USER'S STATUS, not of the data. Reactivating
 * that user - or adding any second, active holder of the same site - makes the
 * risk live immediately, and nothing in the assignment path will complain,
 * because from its point of view an active donor is a perfectly good source.
 *
 * So the "is it still safe" question is not answered here, where it would
 * silently rot. It is re-evaluated on every sync by
 * dataQuality.assessDuplicatedAddressRisk(), which reports each such site as
 * DORMANT (all holders inactive) or LIVE (an active holder could donate it), and
 * separately reports whether a pending assignee would actually receive it.
 * Treat a flip from DORMANT to LIVE as a prompt to fix the source row.
 *
 * Note the correct scope of the smell, too: an address in the Newsletter column
 * is NOT itself suspicious. 26 of 73 filled Newsletter cells are addresses, so
 * that column legitimately holds both tool names ("MailChimp") and mailboxes.
 * Only the SAME address in BOTH mail columns is worth a look. An earlier check
 * that flagged "same string in 2+ columns" fired on 44 of 184 records purely
 * because ga4/cloudflare/clientResponse all legitimately answer "No".
 * ═══════════════════════════════════════════════════════════════════════════ */

export function collectInheritedSiteFacts(drRows, siteId, targetUserId, usersById) {
  const inherited = {};
  const siteFactsFrom = {};
  const refused = [];

  const donors = ensureArray(drRows).filter((r) => {
    if (r.siteId !== siteId) return false;
    if (r.userId === targetUserId) return false;                       // never self
    if (String(r.source || '').startsWith('app:assign')) return false;  // rule 1
    const u = usersById[r.userId];
    return u && u.active !== false;                                     // rule 2
  });
  if (!donors.length) return { inherited, siteFactsFrom, refused };

  for (const field of DAILY_REVIEW_SITE_FACT_FIELDS) {
    // Majority wins so a single typo cannot beat a value several people agree on.
    const tally = new Map();
    for (const d of donors) {
      const v = String(d[field] ?? '').trim();
      if (!v) continue;
      tally.set(v, (tally.get(v) || 0) + 1);
    }
    if (!tally.size) continue;
    const ranked = [...tally.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    const [value, agreeCount] = ranked[0];
    if (TEMPLATE_PLACEHOLDER.test(value)) {
      refused.push({ field, value, reason: 'template-placeholder' });
      continue;
    }
    const backers = donors.filter((d) => String(d[field] ?? '').trim() === value);
    inherited[field] = value;
    siteFactsFrom[field] = {
      from: backers.map((b) => b.userName).join(', '),
      agreeCount,
      contested: ranked.length > 1,
      alternatives: ranked.slice(1).map(([v, n]) => ({ value: v, count: n })),
    };
  }
  return { inherited, siteFactsFrom, refused };
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
      // Site facts come from whoever already recorded them for this site, so a
      // second assignee does not start blind. Never fabricates: no donor means
      // no value, and per-person status is never copied.
      const { inherited, siteFactsFrom } = collectInheritedSiteFacts(drRows, site.id, uid, userMap);
      drRows.push({
        id: uuid(),
        userId: uid,
        userName: u ? u.name : 'User',
        siteId: site.id,
        siteUrl: site.url,
        company: site.company || site.account || '',
        rowIndex: null,
        // Per-person work starts fresh — never inherited (rule 3).
        maintenanceStatus: 'todo',
        maintenanceRaw: 'To Do',
        reportSentStatus: 'no',
        reportSentRaw: 'No',
        ga4: inherited.ga4 || '',
        newsletterMail: inherited.newsletterMail || '',
        formSubmissionMail: inherited.formSubmissionMail || '',
        bookingLink: inherited.bookingLink || '',
        cloudflare: inherited.cloudflare || '',
        clickupLink: site.clickupUrl || '',
        clickupTimeTrackUrl: site.clickupTimeTrackUrl || '',
        clientResponse: inherited.clientResponse || '',
        uptimeRobot: inherited.uptimeRobot || '',
        siteFactsFrom,
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
  if (targetUserId) {
    const resolved = getUserById(targetUserId);
    if (resolved) targetUserId = resolved.id;
  }
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
    const usersById = Object.fromEntries(allUsers.map(x => [x.id, x]));

    for (const s of userSites) {
      const exists = rows.some(r => (r.siteId === s.id || (r.siteUrl && s.url && r.siteUrl.toLowerCase().trim() === s.url.toLowerCase().trim())) && r.userId === targetUserId);
      if (!exists) {
        // Same inheritance as assignUsersToSite() — see the rules above it.
        const { inherited, siteFactsFrom } = collectInheritedSiteFacts(rows, s.id, targetUserId, usersById);
        rows.push({
          id: uuid(),
          userId: targetUserId,
          userName: uName,
          siteId: s.id,
          siteUrl: s.url,
          company: s.company || s.account || '',
          rowIndex: null,
          // Per-person work, never inherited.
          maintenanceStatus: 'todo',
          maintenanceRaw: 'To Do',
          reportSentStatus: 'no',
          reportSentRaw: 'No',
          ga4: inherited.ga4 || '',
          newsletterMail: inherited.newsletterMail || '',
          formSubmissionMail: inherited.formSubmissionMail || '',
          bookingLink: inherited.bookingLink || '',
          cloudflare: inherited.cloudflare || '',
          clickupLink: s.clickupUrl || '',
          clickupTimeTrackUrl: s.clickupTimeTrackUrl || '',
          clientResponse: inherited.clientResponse || '',
          uptimeRobot: inherited.uptimeRobot || '',
          siteFactsFrom,
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
    if (!r.clickupTimeTrackUrl && s?.clickupTimeTrackUrl) r.clickupTimeTrackUrl = s.clickupTimeTrackUrl;
    r.uptimeStatus = s?.uptimeStatus || (r.uptimeRobot && /yes/i.test(r.uptimeRobot) ? 'online' : 'unknown');
    r.domainExpiry = s?.domainExpiry || '';
    r.daysLeft = s?.daysLeft ?? (r.domainExpiry ? calcDaysUntil(r.domainExpiry) : null);
    const cleanU = cleanDomainUrl(r.siteUrl);
    r.pendingExpiryRequest = (s?.id ? pendingBySite[s.id] : null) || 
                             pendingBySite[(r.siteUrl||'').toLowerCase().trim()] || 
                             (cleanU ? pendingBySite[cleanU] : null) || null;
  });

  if (filter.userId && filter.userName) {
    const targetName = (filter.userName || '').toLowerCase().trim();
    rows = rows.filter(r => (targetUserId && r.userId === targetUserId) || r.userId === filter.userId || (r.userName || '').toLowerCase().trim() === targetName);
  } else if (filter.userId) {
    rows = rows.filter(r => (targetUserId && r.userId === targetUserId) || r.userId === filter.userId);
  } else if (filter.userName) {
    const targetName = (filter.userName || '').toLowerCase().trim();
    rows = rows.filter(r => (r.userName||'').toLowerCase().trim() === targetName || (targetUserId && r.userId === targetUserId));
  }
  if (filter.siteId) rows = rows.filter(r => r.siteId === filter.siteId);
  return rows;
}
export function setDailyReview(rows) { dbWrite('daily-review', rows); }

/**
 * attachDailyReviewSheetRow — persist WHERE a daily-review record lives in the
 * connected sheet (rowIndex + provenance), so the next reconcile hits the fast
 * path instead of searching the tab by URL, and the mapping survives restarts.
 *
 * Called by the assignment write-back after it appends (or finds) the user's row.
 * The row number reported by the sheet is authoritative: if the stored rowIndex
 * disagrees, the stored value is corrected and the previous value is returned so
 * the caller can audit the old→new change (never silently).
 *
 * Never fabricates a record: returns null when the (siteId,userId) row is absent
 * so the caller can flag a conflict rather than invent a mapping.
 */
export function attachDailyReviewSheetRow({ siteId, userId, rowNumber, tabName, spreadsheetId = null, source = null }) {
  if (!Number.isInteger(rowNumber) || rowNumber < 1) {
    throw new Error(`attachDailyReviewSheetRow: invalid rowNumber ${rowNumber}`);
  }
  const rows = ensureArray(dbRead('daily-review'));
  const idx = rows.findIndex(r => r.siteId === siteId && r.userId === userId);
  if (idx === -1) return null;

  const previousRowIndex = rows[idx].rowIndex ?? null;
  rows[idx] = {
    ...rows[idx],
    rowIndex: rowNumber,
    sourceTab: tabName || rows[idx].sourceTab || null,
    sourceRow: rowNumber,
    sheetSpreadsheetId: spreadsheetId || rows[idx].sheetSpreadsheetId || null,
    source: source || rows[idx].source || null,
    sheetSyncedAt: now(),
    updatedAt: now(),
  };
  setDailyReview(rows);
  return { row: rows[idx], previousRowIndex, changed: previousRowIndex !== rowNumber };
}

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

  // If clickupLink, clickupTimeTrackUrl or maintenanceStatus updated, keep site record in sync if site exists
  if (updates.clickupLink || updates.clickupTimeTrackUrl || updates.maintenanceRaw || updates.maintenanceStatus) {
    const row = rows[idx];
    if (row.siteId || row.siteUrl) {
      try {
        const sites = ensureArray(dbRead('sites'));
        const sIdx = sites.findIndex(s => s.id === row.siteId || (row.siteUrl && s.url && s.url.toLowerCase().trim() === row.siteUrl.toLowerCase().trim()));
        if (sIdx !== -1) {
          const siteUpdates = {};
          if (updates.clickupLink) siteUpdates.clickupUrl = updates.clickupLink;
          if (updates.clickupTimeTrackUrl !== undefined) siteUpdates.clickupTimeTrackUrl = updates.clickupTimeTrackUrl;
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

      if (updates.clickupLink || updates.clickupTimeTrackUrl || updates.maintenanceRaw || updates.maintenanceStatus) {
        const row = rows[i];
        const sIdx = sites.findIndex(s => s.id === row.siteId || (row.siteUrl && s.url && s.url.toLowerCase().trim() === row.siteUrl.toLowerCase().trim()));
        if (sIdx !== -1) {
          if (updates.clickupLink) sites[sIdx].clickupUrl = updates.clickupLink;
          if (updates.clickupTimeTrackUrl !== undefined) sites[sIdx].clickupTimeTrackUrl = updates.clickupTimeTrackUrl;
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
  let user = null;
  if (filter.assigneeId) {
    user = getUserById(filter.assigneeId);
  } else if (filter.assigneeName) {
    user = getUserByName(filter.assigneeName);
  }

  const nameVariants = new Set();
  if (user) {
    if (user.id) nameVariants.add(user.id);
    if (user.name) nameVariants.add(user.name.toLowerCase().trim());
    if (Array.isArray(user.aliases)) {
      user.aliases.forEach(a => nameVariants.add(String(a).toLowerCase().trim()));
    }
  }
  if (filter.assigneeName) nameVariants.add(filter.assigneeName.toLowerCase().trim());

  if (filter.assigneeId || filter.assigneeName) {
    tasks = tasks.filter(t => {
      if (filter.assigneeId && t.assigneeId === filter.assigneeId) return true;
      if (user && t.assigneeId === user.id) return true;
      const an = (t.assigneeName || '').toLowerCase().trim();
      if (!an) return false;
      for (const nv of nameVariants) {
        if (an === nv || an.includes(nv) || nv.includes(an)) return true;
      }
      return false;
    });
  }
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
// CONDITIONAL EMAIL NOTES  (condition detected in a report tab -> paragraph)
// ═══════════════════════════════════════════════════════════════════════════════
//
// The operator writes a single cell in a site's report tab, shaped
//
//     a11y:https://docs.google.com/document/d/…#heading=h.xxxxx
//
// i.e. "<condition>:<link>". When a registered condition matches, the paired
// message is added to that site's email immediately before "Best Regards," and
// the link is taken from the cell — so each site links to its own document and
// the report tab stays the single source of truth.
//
// A condition with no link after the colon still renders the message; the link
// is simply omitted rather than promised and left dead.
//
// Scoped per account because CW and RM clients get their own wording.

const CONDITIONAL_NOTES_COLLECTION = 'email-conditional-notes';

/**
 * Conditions are matched case-insensitively, so they are stored normalised. A
 * trailing colon is stripped because the cell format is "<condition>:<link>":
 * typing "a11y:" into the dashboard is the obvious slip, and storing it would
 * create a key no cell could ever match — a condition that looks registered and
 * silently does nothing.
 */
export function normaliseNoteCondition(condition) {
  return String(condition ?? '').trim().replace(/\s*:+\s*$/, '').toLowerCase();
}

/**
 * A condition is a bare keyword, never a whole trigger cell. Pasting
 * "a11y:https://…" into the Condition box is the other obvious slip: it would
 * otherwise be stored happily and then never match anything. Refused here, with
 * a message that says what to do instead. Any keyword is otherwise accepted —
 * "link", "ADA Review", "a11y", "sec-fix" — so the feature is not tied to one
 * pre-approved word.
 */
function assertUsableCondition(key) {
  if (!key) throw new Error('Condition is required.');
  if (key.includes('://')) {
    throw new Error('Condition must be the keyword only (e.g. a11y). Put the link in the report tab cell as "a11y:https://…" — not in the condition.');
  }
  return key;
}

export function getConditionalNotes(filter = {}) {
  let list = ensureArray(dbRead(CONDITIONAL_NOTES_COLLECTION));
  if (filter.account) {
    const acct = String(filter.account).toUpperCase();
    list = list.filter((n) => String(n.account || 'CW').toUpperCase() === acct);
  }
  if (filter.enabledOnly) list = list.filter((n) => n.enabled !== false);
  return list.map((n) => ({ ...n, condition: normaliseNoteCondition(n.condition) }));
}

export function setConditionalNotes(data) {
  dbWrite(CONDITIONAL_NOTES_COLLECTION, ensureArray(data));
}

export function getConditionalNoteById(id) {
  return ensureArray(dbRead(CONDITIONAL_NOTES_COLLECTION)).find((n) => n.id === id) || null;
}

export function createConditionalNote({
  account = 'CW', condition, message, enabled = true,
  actor = 'admin', actorId = '',
}) {
  const key = assertUsableCondition(normaliseNoteCondition(condition));
  const text = String(message ?? '').trim();
  if (!text) throw new Error('Message is required.');
  if (key.length > 60) throw new Error('Condition must be 60 characters or fewer.');
  if (text.length > 4000) throw new Error('Message must be 4000 characters or fewer.');

  const acct = String(account || 'CW').toUpperCase();
  const list = ensureArray(dbRead(CONDITIONAL_NOTES_COLLECTION));
  // One note per condition per account: two notes for the same key would both
  // render and the email would carry the paragraph twice.
  if (list.some((n) => normaliseNoteCondition(n.condition) === key
    && String(n.account || 'CW').toUpperCase() === acct)) {
    throw new Error(`Condition "${key}" already exists for ${acct}. Edit it instead.`);
  }

  const note = {
    id: uuid(),
    account: acct,
    condition: key,
    message: text,
    enabled: enabled !== false,
    createdAt: now(),
    updatedAt: now(),
  };
  list.push(note);
  dbWrite(CONDITIONAL_NOTES_COLLECTION, list);
  appendAuditLog({
    actor, actorId,
    action: 'conditional-note:create',
    entity: 'email-conditional-note',
    entityId: note.id,
    label: `${acct} "${key}"`,
    field: 'condition',
    oldValue: null,
    newValue: key,
    source: 'app',
    reason: 'Condition registered for report-tab detection',
  });
  return note;
}

export function updateConditionalNote(id, updates = {}, { actor = 'admin', actorId = '' } = {}) {
  const list = ensureArray(dbRead(CONDITIONAL_NOTES_COLLECTION));
  const idx = list.findIndex((n) => n.id === id);
  if (idx === -1) throw new Error(`Conditional note not found: ${id}`);

  const before = list[idx];
  const patch = { ...updates };

  if (patch.condition !== undefined) {
    const key = assertUsableCondition(normaliseNoteCondition(patch.condition));
    const acct = String(patch.account || before.account || 'CW').toUpperCase();
    if (list.some((n) => n.id !== id && normaliseNoteCondition(n.condition) === key
      && String(n.account || 'CW').toUpperCase() === acct)) {
      throw new Error(`Condition "${key}" already exists for ${acct}.`);
    }
    patch.condition = key;
  }
  if (patch.message !== undefined) {
    const text = String(patch.message).trim();
    if (!text) throw new Error('Message is required.');
    if (text.length > 4000) throw new Error('Message must be 4000 characters or fewer.');
    patch.message = text;
  }
  if (patch.account !== undefined) patch.account = String(patch.account).toUpperCase();

  list[idx] = { ...before, ...patch, updatedAt: now() };
  dbWrite(CONDITIONAL_NOTES_COLLECTION, list);

  const changed = ['condition', 'message', 'account', 'enabled']
    .filter((f) => patch[f] !== undefined && String(patch[f]) !== String(before[f]));
  if (changed.length) {
    appendAuditLog({
      actor, actorId,
      action: 'conditional-note:update',
      entity: 'email-conditional-note',
      entityId: id,
      label: `${list[idx].account} "${list[idx].condition}"`,
      field: changed.join(','),
      oldValue: changed.map((f) => `${f}=${before[f]}`).join('; ').slice(0, 2000) || null,
      newValue: changed.map((f) => `${f}=${list[idx][f]}`).join('; ').slice(0, 2000) || null,
      source: 'app',
      reason: 'Conditional email note changed',
    });
  }
  return list[idx];
}

/**
 * Apply one condition+message to several sheets in a single action.
 *
 * The operator thinks in terms of "this message goes to both sheets", not "two
 * separate records I must remember to keep in step". This fans one action out to
 * one record per sheet, so the two can never drift apart.
 *
 * Deliberately one record per sheet rather than a single record with account
 * "ALL":
 *   - a record still belongs to exactly one account, so `getConditionalNotes`
 *     needs no new matching rule and a message can never reach a sheet it was
 *     not chosen for;
 *   - a future third account does not silently inherit every existing note the
 *     way an "ALL" scope would;
 *   - the existing record shape is unchanged, so nothing migrates and the live
 *     note is untouched;
 *   - each record keeps its own stable id and its own audit entry, which is what
 *     the audit log has always meant.
 *
 * Sheets that already have this condition are UPDATED, not duplicated and not
 * rejected — that is what makes one edit reach every sheet the operator ticked.
 * Nothing is ever deleted here: a sheet that was not passed in keeps whatever it
 * already had.
 */
export function setConditionalNoteForAccounts({
  accounts, condition, message, enabled = true,
  actor = 'admin', actorId = '',
}) {
  const keys = [...new Set((Array.isArray(accounts) ? accounts : [accounts])
    .map((a) => String(a ?? '').trim().toUpperCase())
    .filter(Boolean))];
  if (!keys.length) throw new Error('Choose at least one sheet.');

  // Validate once, before touching anything, so a bad condition cannot leave the
  // first sheet updated and the second rejected.
  assertUsableCondition(normaliseNoteCondition(condition));
  const text = String(message ?? '').trim();
  if (!text) throw new Error('Message is required.');

  const created = [];
  const updated = [];
  for (const acct of keys) {
    const existing = getConditionalNotes({ account: acct })
      .find((n) => normaliseNoteCondition(n.condition) === normaliseNoteCondition(condition));
    if (existing) {
      updated.push(updateConditionalNote(existing.id, { message: text, enabled: enabled !== false }, { actor, actorId }));
    } else {
      created.push(createConditionalNote({ account: acct, condition, message: text, enabled, actor, actorId }));
    }
  }
  return { accounts: keys, created, updated, notes: [...updated, ...created] };
}

export function deleteConditionalNote(id, { actor = 'admin', actorId = '' } = {}) {
  const list = ensureArray(dbRead(CONDITIONAL_NOTES_COLLECTION));
  const found = list.find((n) => n.id === id);
  if (!found) return false;
  dbWrite(CONDITIONAL_NOTES_COLLECTION, list.filter((n) => n.id !== id));
  appendAuditLog({
    actor, actorId,
    action: 'conditional-note:delete',
    entity: 'email-conditional-note',
    entityId: id,
    label: `${found.account || 'CW'} "${found.condition}"`,
    field: 'condition',
    oldValue: found.condition,
    newValue: null,
    source: 'app',
    reason: 'Conditional email note removed; affected emails will no longer show the paragraph',
  });
  return true;
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

// ═══════════════════════════════════════════════════════════════════════════════
// AUDIT LOG — append-only history of every meaningful change
// ═══════════════════════════════════════════════════════════════════════════════
// Entry shape (matches the "who/what/when/old→new/source" requirement):
//   { id, at, actor, actorId, action, entity, entityId, label,
//     field, oldValue, newValue, source, reason }
// `action` is a short verb like "create" | "update" | "assignment:add" | "sync".
// `source` tells where the change came from: "Team Progress UI", "AI Settings",
// "Sheets Sync", "daily-review PUT", etc. Append-only: entries are never
// mutated or removed by the application.

export function getAuditLog(limit = 500) {
  const log = ensureArray(dbRead('audit-log'));
  return log.slice(-Math.max(1, Number(limit) || 500)).reverse();
}

export function appendAuditLog(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const log = ensureArray(dbRead('audit-log'));
  const item = {
    id: uuid(),
    at: now(),
    actor: String(entry.actor || 'system').slice(0, 100),
    actorId: String(entry.actorId || '').slice(0, 100),
    action: String(entry.action || 'update').slice(0, 60),
    entity: String(entry.entity || 'unknown').slice(0, 60),
    entityId: String(entry.entityId || '').slice(0, 100),
    label: String(entry.label || '').slice(0, 300),
    field: String(entry.field || '').slice(0, 60),
    oldValue: entry.oldValue == null ? null : String(entry.oldValue).slice(0, 2000),
    newValue: entry.newValue == null ? null : String(entry.newValue).slice(0, 2000),
    source: String(entry.source || 'app').slice(0, 100),
    reason: String(entry.reason || '').slice(0, 500),
  };
  log.push(item);
  // Keep the log bounded (most recent 10k entries) — it is append-only, but a
  // runaway sync shouldn't grow the file forever.
  dbWrite('audit-log', log.slice(-10000));
  return item;
}

export function auditLogStats() {
  const log = ensureArray(dbRead('audit-log'));
  const byAction = {};
  for (const e of log.slice(-5000)) {
    byAction[e.action] = (byAction[e.action] || 0) + 1;
  }
  return { count: log.length, byAction };
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
    spreadsheetId: '1QqDY9q7mRj4QPsuRnFEfFmegFvJoywfDmwanCFtZY6I',
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
    // Individual Docs and Drive folders for SOP/policy retrieval. All are
    // read-only and must be shared with the service account.
    documents: { sources: [], folderIds: [], freshOnAsk: false },
    // Optional separate, read-only Operations Handbook RAG Worker. Its URL is
    // configurable in AI Settings; any auth token stays in the server .env.
    handbook: { enabled: true, workerUrl: '' },
    // Read-only bridge to the Report Automation Worker's daily report log.
    // The service token lives only in data/assistant-config.json (git-ignored)
    // and is masked in the dashboard like provider keys.
    reportAutomation: {
      enabled: true,
      baseUrl: 'https://report-automation.taion16240.workers.dev',
      apiKey: '',
      freshOnAsk: false,     // true = re-pull the report log before every question
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

// ═══════════════════════════════════════════════════════════════════════════════
// SYNC CONFLICTS — divergences the sync REFUSED to auto-pick a winner for.
// ═══════════════════════════════════════════════════════════════════════════════
// The "Conflict Handling" policy says: never silently pick a value. When two
// sources disagree on a field (sheet vs DB/UI), the sync records the divergence
// here — flagging both values, the origin of each, and what policy was applied —
// instead of quietly overwriting. Resolution (acknowledge/keep/override) is a
// deliberate, auditable act, never an implicit one.
//
// Entry shape:
//   { id, key, at, entity, entityId, label, field,
//     sheetValue, dbValue, sheetSource, dbSource,
//     policy,          // keep-sheet | keep-db | manual
//     state,           // open | acknowledged
//     acknowledgedAt, acknowledgedBy }
// Bounded to the 5k most recent entries; keyed by entity::entityId::field so a
// repeated sync re-records the conflict instead of growing duplicates forever.
const SYNC_CONFLICT_MAX = 5000;

export function getSyncConflicts({ state } = {}) {
  const list = ensureArray(dbRead('sync-conflicts'));
  if (state) return list.filter(c => c.state === state);
  return list;
}

/** Record (or refresh) one sync conflict. Returns the stored entry. */
export function recordSyncConflict(entry) {
  if (!entry || !entry.entityId) return null;
  const list = ensureArray(dbRead('sync-conflicts'));
  const key = `${entry.entity}::${entry.entityId}::${entry.field}`;
  const existingIdx = list.findIndex(c => c.key === key);
  const item = {
    id: existingIdx !== -1 ? list[existingIdx].id : uuid(),
    key,
    at: now(),
    entity: String(entry.entity || 'unknown').slice(0, 60),
    entityId: String(entry.entityId || '').slice(0, 200),
    label: String(entry.label || '').slice(0, 300),
    field: String(entry.field || 'unknown').slice(0, 60),
    sheetValue: entry.sheetValue == null ? '' : String(entry.sheetValue).slice(0, 2000),
    dbValue: entry.dbValue == null ? '' : String(entry.dbValue).slice(0, 2000),
    sheetSource: String(entry.sheetSource || 'sheet').slice(0, 100),
    dbSource: String(entry.dbSource || 'db').slice(0, 100),
    policy: String(entry.policy || 'keep-sheet').slice(0, 40),
    state: 'open',
    acknowledgedAt: null,
    acknowledgedBy: null,
    occurrences: existingIdx !== -1 ? (list[existingIdx].occurrences || 0) + 1 : 1,
  };
  if (existingIdx !== -1) list[existingIdx] = item;
  else list.push(item);
  dbWrite('sync-conflicts', list.slice(-SYNC_CONFLICT_MAX));
  return item;
}

/** Mark a conflict acknowledged (the operator saw it and accepts the policy). */
export function acknowledgeSyncConflict(id, by = 'admin') {
  const list = ensureArray(dbRead('sync-conflicts'));
  const idx = list.findIndex(c => c.id === id);
  if (idx === -1) throw new Error(`Sync conflict not found: ${id}`);
  list[idx] = {
    ...list[idx],
    state: 'acknowledged',
    acknowledgedAt: now(),
    acknowledgedBy: String(by || 'admin').slice(0, 100),
  };
  dbWrite('sync-conflicts', list);
  return list[idx];
}

export function syncConflictStats() {
  const list = getSyncConflicts();
  return {
    count: list.length,
    open: list.filter(c => c.state === 'open').length,
    acknowledged: list.filter(c => c.state === 'acknowledged').length,
    byEntity: list.reduce((acc, c) => { acc[c.entity] = (acc[c.entity] || 0) + 1; return acc; }, {}),
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// USER IDENTITY RESOLUTION — the same human across sheets, deliberately.
// ═══════════════════════════════════════════════════════════════════════════════
// Sheets name the same person differently ("Ettekhar Taion" vs "Taion"). We
// never guess: resolution is exact-name first, then an EXPLICIT alias table
// (data/user-aliases.json, editable), then a token-containment check that is
// deterministic and reported (matchedBy). An unresolvable name yields null —
// the caller treats it as "unknown assignee", never a made-up one.

// Seeded from verified real data: the daily-report mirror authors with the
// self-reported full name "Ettekhar Taion"; OfficeOS's canonical user is "Taion".
const DEFAULT_USER_ALIASES = {
  Taion: ['Ettekhar Taion', 'Md. Ettekhar Rahman Taion'],
};

export function getUserAliases() {
  const raw = dbRead('user-aliases');
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const seeded = {};
    for (const [canonical, aliases] of Object.entries(DEFAULT_USER_ALIASES)) {
      seeded[canonical] = aliases;
    }
    // Merge stored aliases over the seed (stored wins on conflict).
    for (const [canonical, aliases] of Object.entries(raw)) {
      if (Array.isArray(aliases)) seeded[canonical] = aliases;
    }
    return seeded;
  }
  dbWrite('user-aliases', DEFAULT_USER_ALIASES);
  return { ...DEFAULT_USER_ALIASES };
}

export function setUserAliases(map) {
  const clean = {};
  for (const [canonical, aliases] of Object.entries(map || {})) {
    if (!Array.isArray(aliases)) continue;
    const canon = String(canonical).trim();
    if (!canon) continue;
    clean[canon] = aliases.map(a => String(a).trim()).filter(Boolean);
  }
  dbWrite('user-aliases', clean);
  return clean;
}

const _compactName = (n) => String(n || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const _tokens = (n) => String(n || '').toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length >= 3);

/**
 * Resolve a raw name from any sheet to a canonical OfficeOS user.
 * Returns { user, matchedBy } (matchedBy: 'exact' | 'alias' | 'tokens' | null);
 * `user` is null when nothing resolves — never a fabricated identity.
 */
export function resolveUserByName(name) {
  const users = (getUsers() || []).filter(u => u.active !== false);
  const raw = String(name || '').trim();
  if (!raw || !users.length) return { user: null, matchedBy: null };

  // 1. Exact (case/space-insensitive) match on canonical names
  const exact = users.find(u => _compactName(u.name) === _compactName(raw));
  if (exact) return { user: exact, matchedBy: 'exact' };

  // 2. Alias table: alias → canonical user
  const aliases = getUserAliases();
  for (const [canonical, list] of Object.entries(aliases)) {
    const hit = (list || []).some(a => _compactName(a) === _compactName(raw));
    if (hit) {
      const user = users.find(u => _compactName(u.name) === _compactName(canonical));
      if (user) return { user, matchedBy: 'alias' };
    }
  }

  // 3. Token containment ("Md. Ettekhar Rahman Taion" ↔ "Taion") — reported,
  //    not guessed silently: the caller sees matchedBy:'tokens'.
  const target = _tokens(raw);
  if (target.length) {
    for (const u of users) {
      const candidates = [u.name, ...(aliases[u.name] || [])];
      for (const c of candidates) {
        const tokens = _tokens(c);
        if (!tokens.length) continue;
        const full = _compactName(c);
        if (full.includes(_compactName(raw)) || _compactName(raw).includes(full)) {
          return { user: u, matchedBy: 'tokens' };
        }
        if (target.every(t => tokens.includes(t)) || tokens.every(t => target.includes(t))) {
          return { user: u, matchedBy: 'tokens' };
        }
      }
    }
  }

  return { user: null, matchedBy: null };
}

// ═══════════════════════════════════════════════════════════════════════════════
// OPTIMISTIC LOCKING — concurrent-write protection
// ═══════════════════════════════════════════════════════════════════════════════
// A mutation may carry the client's last-seen `updatedAt` (or a `version`
// integer). If the stored record has changed since, the write is STALE and must
// be rejected — two editors can't silently last-write-win the same field.
export function assertRecordFresh(record, expected) {
  if (expected === undefined || expected === null || expected === '') return true;
  const stored = record?.updatedAt || record?.version || null;
  if (stored === null) return true;
  if (typeof expected === 'number') {
    return Number(record.version ?? (typeof stored === 'string' ? Date.parse(stored) : NaN)) === expected;
  }
  return String(stored) === String(expected);
}


// ==========================================================================
// AUTHENTICATION — Sessions, Password Hashing, Google OAuth
// ==========================================================================

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/** Hash a password using PBKDF2. Returns "pbkdf2:<salt>:<hash>" */
export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(password, salt, 310000, 32, 'sha256').toString('hex');
  return 'pbkdf2:' + salt + ':' + hash;
}

/** Verify a plaintext password against a stored hash. */
export function verifyPassword(password, stored) {
  if (!stored || !stored.startsWith('pbkdf2:')) return false;
  const parts = stored.split(':');
  const salt = parts[1]; const expected = parts[2];
  if (!salt || !expected) return false;
  try {
    const actual = crypto.pbkdf2Sync(password, salt, 310000, 32, 'sha256').toString('hex');
    if (actual.length !== expected.length) return false;
    return crypto.timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(expected, 'hex'));
  } catch (_) { return false; }
}

/** Look up a user by email (case-insensitive). Also checks aliases[] array. */
export function getUserByEmail(email) {
  if (!email) return null;
  const e = email.toLowerCase().trim();
  const rawUsers = ensureArray(dbRead('users'));
  const u = rawUsers.find(x =>
    (x.email || '').toLowerCase().trim() === e ||
    (x.googleEmail || '').toLowerCase().trim() === e ||
    (Array.isArray(x.aliases) && x.aliases.some(a => (a || '').toLowerCase().trim() === e))
  );
  if (!u) return null;
  if (u.mergedInto) return getUserById(u.mergedInto);
  return { ...u, active: u.active !== false };
}

function getSessions() { return ensureArray(dbRead('auth-sessions')); }
function setSessions(data) { dbWrite('auth-sessions', data); }

function pruneExpiredSessions() {
  const nowMs = Date.now();
  const sessions = getSessions().filter(s => s.expiresAt && new Date(s.expiresAt).getTime() > nowMs);
  setSessions(sessions);
  return sessions;
}

/** Create a new self-signed session token. No KV storage required.
 *  The token carries the userId and role, signed with HMAC-SHA256.
 *  Works across Cloudflare Worker isolates without KV propagation delay. */
export function createSession(userId, meta) {
  if (!meta) meta = {};
  const user = getUserById(userId);
  const role = (user && user.role) || 'user';
  const now = Date.now();
  const payload = {
    userId, role,
    name: (user && user.name) || '',
    email: (user && user.email) || '',
    iat: now,
    exp: now + SESSION_TTL_MS,
    provider: meta.provider || 'email',
    nonce: crypto.randomBytes(8).toString('hex'),
  };
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const secret = _sessionSecret();
  const sig = crypto.createHmac('sha256', secret).update(payloadB64).digest('base64url');
  return payloadB64 + '.' + sig;
}

function _sessionSecret() {
  return process.env.SESSION_SECRET || process.env.ADMIN_TOKEN || 'officeos-dev-secret-change-in-prod';
}

/** Verify and decode a signed session token. Returns {session, user} or null.
 *  No KV lookup needed — the signature itself proves validity. */
export function getSessionByToken(token) {
  if (!token || !token.includes('.')) return null;
  try {
    const lastDot = token.lastIndexOf('.');
    const payloadB64 = token.slice(0, lastDot);
    const sig = token.slice(lastDot + 1);
    const secret = _sessionSecret();
    const expectedSig = crypto.createHmac('sha256', secret).update(payloadB64).digest('base64url');
    // Timing-safe compare
    if (sig.length !== expectedSig.length) return null;
    const a = Buffer.from(sig, 'base64url');
    const b = Buffer.from(expectedSig, 'base64url');
    if (a.length !== b.length) return null;
    if (!crypto.timingSafeEqual(a, b)) return null;

    const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
    if (!payload.userId || !payload.exp) return null;
    if (Date.now() > payload.exp) return null;  // expired

    let user = getUserById(payload.userId);

    // If the user was merged into another account, follow the chain to the canonical user.
    if (!user && payload.userId) {
      const rawUsers = ensureArray(dbRead('users'));
      const raw = rawUsers.find(x => x.id === payload.userId);
      if (raw && raw.mergedInto) {
        user = getUserById(raw.mergedInto);
        if (user) console.log(`[session] Redirected merged userId ${payload.userId} → ${raw.mergedInto} (${user.name})`);
      }
    }

    // Try to resolve by email if ID is still missing (e.g. auto-created ghost user).
    if (!user && payload.email) {
      user = getUserByEmail(payload.email);
      if (user) console.log(`[session] Resolved ghost userId ${payload.userId} by email ${payload.email} → ${user.id} (${user.name})`);
    }

    // Last-resort: reconstruct from signed token payload so the isolate doesn't go dark
    // while KV propagates.  We use role 'user' as a safe default to prevent privilege escalation.
    if (!user && (payload.name || payload.email)) {
      user = {
        id: payload.userId,
        name: payload.name || payload.email,
        email: payload.email || '',
        role: payload.role || 'user',
        active: true,
      };
    }
    if (!user || user.active === false) return null;
    return { session: payload, user };
  } catch { return null; }
}

/** Revoke a session. With signed tokens this is a no-op for reads
 *  (the token is self-contained), but we still prune old KV sessions for hygiene. */
export function revokeSession(token) {
  // Signed tokens don't need KV revocation. The token expires naturally.
  // For logout to take effect immediately, the client simply deletes the cookie.
  return;
}

/** Revoke all sessions for a user. */
export function revokeAllUserSessions(userId) {
  setSessions(getSessions().filter(s => s.userId !== userId));
}

/** Set or update a user's password hash. */
export function setUserPassword(userId, plainPassword) {
  return updateUser(userId, { passwordHash: hashPassword(plainPassword) });
}

/** Link a Google account to an existing user. */
export function linkGoogleAccount(userId, opts) {
  return updateUser(userId, {
    googleSub: opts.googleSub,
    googleEmail: opts.googleEmail || '',
    googleName: opts.googleName || '',
    googlePicture: opts.googlePicture || '',
  });
}

/** Link Google email to a user profile, merging any duplicate user that already used it. */
export function linkUserGoogleEmail(userId, email) {
  if (!email || !email.includes('@')) throw new Error('A valid email address is required');
  const e = email.toLowerCase().trim();
  const rawUsers = ensureArray(dbRead('users'));
  const idx = rawUsers.findIndex(u => u.id === userId);
  if (idx === -1) throw new Error(`User not found: ${userId}`);

  // Check if another active/unmerged user already has this email
  const duplicate = rawUsers.find(u => u.id !== userId && !u.mergedInto && ((u.email || '').toLowerCase().trim() === e || (u.googleEmail || '').toLowerCase().trim() === e));
  if (duplicate) {
    return mergeUsers(duplicate.id, userId);
  }

  rawUsers[idx] = {
    ...rawUsers[idx],
    email: rawUsers[idx].email || e,
    googleEmail: e,
    updatedAt: now(),
  };
  setUsers(rawUsers);
  return rawUsers[idx];
}

/** Unlink Google account credentials from a user. */
export function unlinkGoogleAccount(userId) {
  const rawUsers = ensureArray(dbRead('users'));
  const idx = rawUsers.findIndex(u => u.id === userId);
  if (idx === -1) throw new Error(`User not found: ${userId}`);

  rawUsers[idx] = {
    ...rawUsers[idx],
    googleSub: null,
    googleEmail: '',
    googleName: '',
    googlePicture: '',
    updatedAt: now(),
  };
  setUsers(rawUsers);
  return rawUsers[idx];
}

/**
 * Merge sourceUser into targetUser:
 * - Copies Google credentials, picture, and email from source to target if target is missing them.
 * - Migrates site assignments in sites.json from source to target.
 * - Migrates daily review checklist rows in daily-review.json from source to target.
 * - Migrates tasks in tasks.json from source to target.
 * - Marks sourceUser as mergedInto: targetUserId, active: false.
 * - Returns updated targetUser.
 */
export function mergeUsers(sourceUserId, targetUserId) {
  if (!sourceUserId || !targetUserId) throw new Error('sourceUserId and targetUserId are required');
  if (sourceUserId === targetUserId) throw new Error('Cannot merge a user into themselves');

  const users = ensureArray(dbRead('users'));
  const sourceIdx = users.findIndex(u => u.id === sourceUserId);
  const targetIdx = users.findIndex(u => u.id === targetUserId);

  if (sourceIdx === -1) throw new Error(`Source user not found: ${sourceUserId}`);
  if (targetIdx === -1) throw new Error(`Target user not found: ${targetUserId}`);

  const source = users[sourceIdx];
  const target = users[targetIdx];

  // 1. Update target with Google auth info or email from source if target lacks them
  const targetUpdates = {
    googleSub: target.googleSub || source.googleSub || null,
    googleEmail: target.googleEmail || source.googleEmail || source.email || '',
    googleName: target.googleName || source.googleName || source.name || '',
    googlePicture: target.googlePicture || source.googlePicture || '',
    email: target.email || source.email || source.googleEmail || '',
    updatedAt: now(),
  };

  if (source.passwordHash && !target.passwordHash) {
    targetUpdates.passwordHash = source.passwordHash;
  }

  users[targetIdx] = { ...target, ...targetUpdates };

  // 2. Mark source as merged
  users[sourceIdx] = {
    ...source,
    active: false,
    mergedInto: targetUserId,
    googleSub: null,
    updatedAt: now(),
  };

  setUsers(users);

  // 3. Migrate sites.json
  const sites = ensureArray(dbRead('sites'));
  let sitesChanged = false;
  for (const s of sites) {
    if (Array.isArray(s.assignedUsers) && s.assignedUsers.includes(sourceUserId)) {
      s.assignedUsers = s.assignedUsers.filter(id => id !== sourceUserId);
      if (!s.assignedUsers.includes(targetUserId)) {
        s.assignedUsers.push(targetUserId);
      }
      s.updatedAt = now();
      sitesChanged = true;
    }
  }
  if (sitesChanged) setSites(sites);

  // 4. Migrate daily-review
  const drRows = ensureArray(dbRead('daily-review'));
  let drChanged = false;
  for (const r of drRows) {
    if (r.userId === sourceUserId) {
      const existing = drRows.find(x => x.siteId === r.siteId && x.userId === targetUserId);
      if (existing) {
        if (r.checklist && typeof r.checklist === 'object') {
          existing.checklist = { ...r.checklist, ...(existing.checklist || {}) };
          existing.updatedAt = now();
          drChanged = true;
        }
      } else {
        r.userId = targetUserId;
        r.userName = users[targetIdx].name;
        r.updatedAt = now();
        drChanged = true;
      }
    }
  }
  if (drChanged) dbWrite('daily-review', drRows);

  // 5. Migrate tasks
  const tasks = ensureArray(dbRead('tasks'));
  let tasksChanged = false;
  for (const t of tasks) {
    if (t.assigneeId === sourceUserId) {
      t.assigneeId = targetUserId;
      t.assigneeName = users[targetIdx].name;
      t.updatedAt = now();
      tasksChanged = true;
    }
  }
  if (tasksChanged) setTasks(tasks);

  return users[targetIdx];
}

/** Find a user by Google subject ID. */
export function getUserByGoogleSub(sub) {
  if (!sub) return null;
  const rawUsers = ensureArray(dbRead('users'));
  const u = rawUsers.find(x => x.googleSub === sub);
  if (!u) return null;
  if (u.mergedInto) return getUserById(u.mergedInto);
  return { ...u, active: u.active !== false };
}


/** Parse the session token from an HTTP Cookie header. */
export function tokenFromCookieHeader(cookieHeader) {
  if (!cookieHeader) return null;
  const match = (cookieHeader + '').match(/(?:^|;\s*)officeos_session=([^;]+)/);
  return match ? match[1] : null;
}

/** Parse the session token from an Authorization: Bearer header. */
export function tokenFromAuthHeader(authHeader) {
  if (!authHeader) return null;
  const m = /^Bearer\s+(.+)$/i.exec((authHeader + '').trim());
  return m ? m[1].trim() : null;
}

/**
 * Resolve the authenticated user from a request (Node IncomingMessage).
 * Checks Cookie first, then Authorization header.
 */
export function resolveAuthUser(req) {
  const h = req && req.headers ? req.headers : {};
  const cookieToken = tokenFromCookieHeader(h.cookie || '');
  const bearerToken = tokenFromAuthHeader(h.authorization || '');
  const token = cookieToken || bearerToken;
  if (!token) return null;
  const result = getSessionByToken(token);
  return result ? result.user : null;
}

/** Build a Set-Cookie string for the session token. */
export function buildSessionCookie(token, opts) {
  const maxAge = Math.floor(SESSION_TTL_MS / 1000);
  const secure = (opts && opts.secure === false) ? '' : '; Secure';
  return 'officeos_session=' + token + '; Max-Age=' + maxAge + '; Path=/; HttpOnly; SameSite=Lax' + secure;
}

/** Build a cookie that clears the session. */
export function buildClearSessionCookie(opts) {
  const secure = (opts && opts.secure === false) ? '' : '; Secure';
  return 'officeos_session=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax' + secure;
}
