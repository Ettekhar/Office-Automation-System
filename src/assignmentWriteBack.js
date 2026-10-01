/**
 * assignmentWriteBack.js — orchestrates the DB→Sheets write-back that follows a
 * site assignment change.
 *
 * Split out of server.js so it is unit-testable offline (importing server.js
 * binds the live HTTP port) and so the assign routes stay declarative.
 *
 * WHY: assignment was DB-only. A newly assigned site had no row in the
 * assignee's Daily Review tab, so the reconcile pass logged
 *   [batch-sync] "<site>" not found in <User> tab — skipping
 * forever and the site's Maintenance status could never sync back. The DB
 * remains the source of truth; this makes the connected sheet catch up and
 * records WHERE each row lives (rowIndex + provenance) so the next reconcile
 * takes the fast path and survives restarts.
 *
 * CONTRACT
 *   - added user   → ensureSiteRowInUserTab (idempotent append, never a duplicate)
 *   - removed user → softRemoveSiteRowFromUserTab (marks; NEVER deletes a row)
 *   - dryRun       → reads and decides, writes NOTHING (no DB, audit or conflict)
 *   - never throws → a sheet problem must never roll back or mask a committed DB
 *                    assignment; it is audited and raised as a sync conflict so
 *                    it is visible rather than silent.
 */

import * as db from './db.js';
import { ensureSiteRowInUserTab, softRemoveSiteRowFromUserTab, getDailyReviewSheetId } from './userTabWriteBack.js';

/**
 * @param {object}  opts
 * @param {object}  opts.site            the (already committed) site record
 * @param {string[]}opts.beforeUserIds   assignees before the change
 * @param {string[]}opts.afterUserIds    assignees after the change
 * @param {object} [opts.actor]          { name, id } for audit attribution
 * @param {string} [opts.source]         human label for the originating UI
 * @param {boolean}[opts.dryRun]         plan only; write nothing
 * @returns {Promise<{appended,existing,wouldAppend,softRemoved,skipped,failed}>}
 */
export async function syncAssignmentToUserTabs({ site, beforeUserIds = [], afterUserIds = [], actor, source, dryRun = false }) {
  const report = { appended: [], existing: [], wouldAppend: [], softRemoved: [], skipped: [], failed: [] };
  const nameOf = (uid) => db.getUserById(uid)?.name || uid;
  const before = new Set((beforeUserIds || []).map(String));
  const after = new Set((afterUserIds || []).map(String));
  const added = [...after].filter((u) => !before.has(u));
  const removed = [...before].filter((u) => !after.has(u));

  if (!added.length && !removed.length) return report;

  let sheetId = null;
  try { sheetId = getDailyReviewSheetId().id; } catch { sheetId = null; }

  // A write-back that didn't happen is a divergence between DB and Sheets.
  // It gets an audit entry AND a conflict record, keyed per (site,user) so
  // several failed assignees don't collapse into one entry.
  const flag = (bucket, uid, res) => {
    report[bucket].push({ userId: uid, userName: nameOf(uid), reason: res.reason || res.action, error: res.error || null });
    if (dryRun) return; // dry-run writes no audit and no conflict records
    try {
      db.appendAuditLog({
        actor: actor?.name || 'admin', actorId: actor?.id || '', source: source || 'Assignment UI',
        action: `user-tab:${res.action}`, entity: 'site', entityId: site.id, label: site.url,
        field: 'dailyReviewRow', oldValue: '(no row written)', newValue: res.reason || res.action || '',
        reason: `Daily Review tab write-back ${res.action}: ${res.reason || ''}`.trim(),
      });
      db.recordSyncConflict({
        entity: 'userTabRow', entityId: `${site.id}:${uid}`, field: 'dailyReviewRow',
        label: `${site.url} → ${nameOf(uid)}: ${res.reason || res.action}${res.error ? ' (' + res.error + ')' : ''}`,
        sheetValue: res.reason || res.action || '',
        dbValue: 'assigned in DB (no matching row written to the user tab)',
        sheetSource: 'Daily Review sheet', dbSource: source || 'Assignment UI',
        policy: 'manual',
      });
    } catch (e) {
      console.warn('[user-tab-writeback] could not record conflict:', e.message);
    }
  };

  // ── newly assigned: ensure a row exists in the assignee's tab ──
  // The account label is a fact the DB already holds, so the appended row
  // carries it like every pre-existing row instead of a suspicious blank.
  const account = String(site.account || site.company || '').trim();
  for (const uid of added) {
    const userName = nameOf(uid);
    // The DB already holds a daily-review record for this (site,user) pair —
    // assignUsersToSite() created it before this write-back ran. Passing it (and
    // the site record) lets the writer fill every recognized column the DB has
    // real data for, instead of leaving the row URL-only.
    let dr = null;
    try { dr = (db.getDailyReview({ siteId: site.id, userId: uid }) || [])[0] || null; } catch { /* best effort */ }
    let res;
    try {
      res = await ensureSiteRowInUserTab({ siteUrl: site.url, userName, account, site, dr, dryRun });
    } catch (e) {
      res = { action: 'error', reason: 'writeback-threw', error: e.message };
    }

    if (res.action === 'error') { flag('failed', uid, res); continue; }
    if (res.action === 'skip') { flag('skipped', uid, res); continue; }
    if (res.action === 'would-append') {
      report.wouldAppend.push({
        userId: uid, userName, tabName: res.tabName, urlCol: res.urlCol, via: res.urlColVia,
        filledFields: (res.filledFields || []).map(f => `${f.header || f.field}=${f.value}`),
      });
      continue;
    }

    // 'appended' | 'exists' — persist the row location so reconcile finds it fast.
    if (res.rowNumber == null) { flag('failed', uid, { action: res.action, reason: 'row-number-unavailable' }); continue; }
    if (dryRun) {
      report.wouldAppend.push({ userId: uid, userName, tabName: res.tabName, rowNumber: res.rowNumber, action: res.action, urlCol: res.urlCol });
      continue;
    }

    try {
      const attached = db.attachDailyReviewSheetRow({
        siteId: site.id, userId: uid, rowNumber: res.rowNumber,
        tabName: res.tabName, spreadsheetId: sheetId,
        source: `app:assign (${source || 'Assignment UI'})`,
      });
      if (!attached) { flag('failed', uid, { action: res.action, reason: 'daily-review-record-missing' }); continue; }
      db.appendAuditLog({
        actor: actor?.name || 'admin', actorId: actor?.id || '', source: source || 'Assignment UI',
        action: `user-tab:${res.action}`, entity: 'daily-review', entityId: attached.row.id,
        label: `${site.url} → ${res.tabName}!${res.rowNumber}`,
        field: 'rowIndex',
        oldValue: attached.previousRowIndex == null ? '(none)' : String(attached.previousRowIndex),
        newValue: String(res.rowNumber),
        reason: `Assigned site ${res.action === 'appended' ? 'appended' : 'already present'} in ${res.tabName} tab ` +
          `(website column ${res.urlCol}, resolved via ${res.urlColVia}); row location persisted for reconcile.`,
      });
      (res.action === 'appended' ? report.appended : report.existing).push({
        userId: uid, userName, tabName: res.tabName, rowNumber: res.rowNumber, urlCol: res.urlCol, via: res.urlColVia,
        // Where the row number came from. 'tab-rescan' means the append response
        // did not carry a usable range and the tab was re-read to find the row —
        // worth surfacing because it is an extra API call on every fresh assign.
        rowNumberFrom: res.rowNumberFrom || null,
        markerColumn: res.markerColumn ?? null,
        accountColumn: res.accountColumn ?? null,
        filledFields: (res.filledFields || []).map(f => `${f.header || f.field}=${f.value}`),
      });
    } catch (e) {
      flag('failed', uid, { action: res.action, reason: 'provenance-persist-failed', error: e.message });
    }
  }

  // ── unassigned: soft-remove only (row, URL and provenance are retained) ──
  for (const uid of removed) {
    const userName = nameOf(uid);
    let res;
    try {
      res = await softRemoveSiteRowFromUserTab({ siteUrl: site.url, userName, dryRun });
    } catch (e) {
      res = { action: 'error', reason: 'writeback-threw', error: e.message };
    }

    if (res.action === 'error') { flag('failed', uid, res); continue; }
    if (res.action === 'would-soft-remove') {
      report.wouldAppend.push({ userId: uid, userName, tabName: res.tabName, action: 'would-soft-remove' });
      continue;
    }
    if (res.action === 'soft-removed') {
      report.softRemoved.push({ userId: uid, userName, tabName: res.tabName, rowNumber: res.rowNumber });
      if (!dryRun) {
        try {
          db.appendAuditLog({
            actor: actor?.name || 'admin', actorId: actor?.id || '', source: source || 'Assignment UI',
            action: 'user-tab:soft-removed', entity: 'site', entityId: site.id, label: site.url,
            field: 'assignment', oldValue: `assigned to ${userName}`, newValue: 'Unassigned (row kept)',
            reason: `Marked ${res.tabName}!${res.cell} as Unassigned. The row, URL and provenance are retained — nothing was deleted.`,
          });
        } catch (e) { console.warn('[user-tab-writeback] audit failed:', e.message); }
      }
      continue;
    }
    // Row kept (no marker column, or already absent). Not an error, but the
    // sheet no longer reflects the assignment, so surface it instead of going quiet.
    flag('skipped', uid, res);
  }

  return report;
}
