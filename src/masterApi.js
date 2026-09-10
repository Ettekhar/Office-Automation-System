/**
 * masterApi.js — reads from local JSON db (data/*.json), zero Sheets API calls.
 */

import {
  getSites, getDailyReview, getDomains,
  getDistribution, getProperties, getDevTracker,
  getDbStats,
} from './db.js';

export const DAILY_REVIEW_USERS = [
  'Toufiq', 'Sabbir', 'Taion', 'Medul', 'Saiful', 'Tarikul', 'Roeich', 'Asif'
];

export function getDailyReviewForUser(user) { return getDailyReview(user); }
export function getAllDailyReview() { return getDailyReview(); }

export function getDailyReviewSummary() {
  const all = getDailyReview();
  return Object.entries(all).map(([user, sites]) => ({
    user,
    total: sites.length,
    completed: sites.filter(s => s.maintenance === 'completed').length,
    inProgress: sites.filter(s => s.maintenance === 'in_progress').length,
    pending: sites.filter(s => !['completed','in_progress'].includes(s.maintenance)).length,
    reportSent: sites.filter(s => s.reportSentRaw?.toLowerCase() === 'yes').length,
  }));
}

export function getDomainExpiry() { return getDomains(); }
export function getDistributionSheet() { return getDistribution(); }
export function getPropertyRegistry() { return getProperties(); }
export function getDevTrackerData() { return getDevTracker(); }
export function getMaintenanceOverview() { return getSites(); }

export function getDashboardStats() {
  const stats = getDbStats();
  const domains = getDomains();
  const allSites = Object.values(getDailyReview()).flat();
  const completed = allSites.filter(s => s.maintenance === 'completed').length;
  return {
    ...stats,
    completedSites: completed,
    inProgressSites: allSites.filter(s => s.maintenance === 'in_progress').length,
    urgentDomains: domains.filter(d => d.urgent).length,
    warningDomains: domains.filter(d => d.warning).length,
    completionPct: allSites.length ? Math.round(completed / allSites.length * 100) : 0,
  };
}
