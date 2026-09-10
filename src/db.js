/**
 * db.js — Local JSON file database
 * Stores all imported sheet data as JSON files in data/
 * All dashboard reads/writes go through this module (zero Sheets API calls).
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, '../data');

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const COLLECTIONS = ['sites', 'daily-review', 'domains', 'distribution', 'properties', 'dev-tracker', 'meta', 'users'];

// ─── Low-level read/write ─────────────────────────────────────────────────────
function filePath(name) {
  return path.join(DATA_DIR, `${name}.json`);
}

export function dbRead(name) {
  const fp = filePath(name);
  if (!fs.existsSync(fp)) return null;
  try { return JSON.parse(fs.readFileSync(fp, 'utf8')); }
  catch { return null; }
}

export function dbWrite(name, data) {
  fs.writeFileSync(filePath(name), JSON.stringify(data, null, 2), 'utf8');
}

// ─── Meta ─────────────────────────────────────────────────────────────────────
export function getMeta() {
  return dbRead('meta') || { lastSync: null, version: 0 };
}

export function setMeta(updates) {
  dbWrite('meta', { ...getMeta(), ...updates });
}

// ─── Sites (CW + RM maintenance website list) ─────────────────────────────────
export function getSites(account = null) {
  const all = dbRead('sites') || [];
  return account ? all.filter(s => s.account === account) : all;
}

export function setSites(data) { dbWrite('sites', data); }

export function updateSite(url, updates) {
  const sites = getSites();
  const idx = sites.findIndex(s => s.url === url);
  if (idx === -1) throw new Error(`Site not found: ${url}`);
  sites[idx] = { ...sites[idx], ...updates, updatedAt: new Date().toISOString() };
  setSites(sites);
  return sites[idx];
}

// ─── Daily Review (per user) ──────────────────────────────────────────────────
export function getDailyReview(user = null) {
  const all = dbRead('daily-review') || {};
  return user ? (all[user] || []) : all;
}

export function setDailyReview(data) { dbWrite('daily-review', data); }

export function updateDailyReviewRow(user, rowUrl, updates) {
  const all = getDailyReview();
  if (!all[user]) throw new Error(`User not found: ${user}`);
  const idx = all[user].findIndex(s => s.url === rowUrl);
  if (idx === -1) throw new Error(`Site not found for user ${user}: ${rowUrl}`);
  all[user][idx] = { ...all[user][idx], ...updates, updatedAt: new Date().toISOString() };
  setDailyReview(all);
  return all[user][idx];
}

// ─── Domains ──────────────────────────────────────────────────────────────────
export function getDomains() { return dbRead('domains') || []; }
export function setDomains(data) { dbWrite('domains', data); }

// ─── Distribution ─────────────────────────────────────────────────────────────
export function getDistribution() { return dbRead('distribution') || { tasks: [], taskLoad: [] }; }
export function setDistribution(data) { dbWrite('distribution', data); }

// ─── Properties ───────────────────────────────────────────────────────────────
export function getProperties() { return dbRead('properties') || []; }
export function setProperties(data) { dbWrite('properties', data); }

export function updateProperty(url, updates) {
  const props = getProperties();
  const idx = props.findIndex(p => p.url === url);
  if (idx === -1) throw new Error(`Property not found: ${url}`);
  props[idx] = { ...props[idx], ...updates, updatedAt: new Date().toISOString() };
  setProperties(props);
  return props[idx];
}

// ─── Dev Tracker ──────────────────────────────────────────────────────────────
export function getDevTracker() { return dbRead('dev-tracker') || []; }
export function setDevTracker(data) { dbWrite('dev-tracker', data); }

// ─── Users ────────────────────────────────────────────────────────────────────
export function getUsers() { return dbRead('users') || []; }
export function setUsers(data) { dbWrite('users', data); }

// ─── Status check ─────────────────────────────────────────────────────────────
export function isInitialised() {
  return COLLECTIONS.filter(c => c !== 'meta').every(c => fs.existsSync(filePath(c)));
}

export function getDbStats() {
  const meta = getMeta();
  const sites = getSites();
  const dr = getDailyReview();
  const domains = getDomains();
  return {
    lastSync: meta.lastSync,
    totalSites: sites.length,
    totalDomains: domains.length,
    users: Object.keys(dr),
    totalUserSites: Object.values(dr).reduce((a, v) => a + v.length, 0),
    initialised: isInitialised(),
  };
}
