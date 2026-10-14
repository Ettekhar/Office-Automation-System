/**
 * Monthly ClickUp close-out batch.
 *
 * Walks every site on the sheet overview, dedupes by ClickUp task id, and —
 * for each task CURRENTLY "in progress" — posts the standard completion
 * comment (account manager from the sheet, always tagging Ovi) and moves the
 * task to Closed. Tasks that are already Closed, "to do", or otherwise not
 * in progress are skipped untouched. Nothing else is touched: no emails, no
 * sheet writes.
 *
 * Safety:
 *  - The plan pass (dryRun: true) is strictly read-only and works even when
 *    CLICKUP_AUTO_CLOSE_ENABLED is off.
 *  - A live pass refuses to run while CLICKUP_AUTO_CLOSE_ENABLED is not
 *    "true" (same guard the single-task path uses), and every task is
 *    re-gated inside completeClickUpMaintenanceTask immediately before any
 *    write, so a status change between planning and writing can never cause
 *    a comment/status write on a non-in-progress task.
 */
import { getOverviewData } from './dashboardApi.js';
import {
  taskIdFromUrl,
  getClickUpFreshStatus,
  completeClickUpMaintenanceTask,
  buildMaintenanceNotificationComment,
  resolveAccountManager,
  getAmMentionContext,
} from './clickup.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const IN_PROGRESS = 'in progress';

function autoCloseEnabled() {
  return String(process.env.CLICKUP_AUTO_CLOSE_ENABLED || 'false').toLowerCase() === 'true';
}

/**
 * @param {{ dryRun?: boolean }} options
 *   dryRun (default true): build the plan only — never writes.
 * @returns {Promise<object>} plan/report object (see callers)
 */
export async function runClickUpCloseout({ dryRun = true } = {}) {
  const overview = await getOverviewData(null, 'all');
  const sites = Array.isArray(overview?.sites) ? overview.sites : [];
  const monthName = overview.selectedMonth?.name || overview.selectedMonth?.monthName || '';
  const enabled = autoCloseEnabled();
  // Roster-first AM resolution context (cached ClickUp roster + operator-
  // promoted pairs), fetched once so every preview matches what a live run
  // would actually post for that account manager.
  const amCtx = await getAmMentionContext();

  // 1. Collect unique tasks (first site row wins for dedupe).
  const byTask = new Map();
  for (const s of sites) {
    const timeTrackUrl = String(s.timeTrackUrl || '').trim();
    if (!/clickup\.com/i.test(timeTrackUrl)) continue;
    const taskId = taskIdFromUrl(timeTrackUrl);
    if (!taskId) continue;
    if (!byTask.has(taskId)) {
      byTask.set(taskId, {
        taskId,
        timeTrackUrl,
        websiteUrl: String(s.websiteUrl || '').trim(),
        accountManager: String(s.accountManager || '').trim(),
        account: String(s.account || ''),
      });
    }
  }
  const tasks = [...byTask.values()];

  // 2. Plan pass — fresh read-only status + preview for every unique task.
  const rows = [];
  for (const t of tasks) {
    let currentStatus = '';
    let error = '';
    try {
      const fresh = await getClickUpFreshStatus(t.taskId);
      currentStatus = fresh.status || '';
    } catch (e) {
      error = e.message || String(e);
    }
    rows.push({
      ...t,
      currentStatus,
      error,
      commentPreview: error
        ? ''
        : buildMaintenanceNotificationComment({
            accountManager: t.accountManager,
            websiteUrl: t.websiteUrl,
            monthName,
            amResolution: resolveAccountManager(t.accountManager, amCtx),
          }),
      action:
        error ? 'skip-error'
        : String(currentStatus).toLowerCase() === IN_PROGRESS ? 'close'
        : String(currentStatus).toLowerCase() === 'closed' ? 'skip-closed'
        : 'skip-not-in-progress',
    });
    await sleep(60); // gentle pacing for the ClickUp API
  }

  const counts = {
    inProgress: rows.filter((r) => r.action === 'close').length,
    skippedClosed: rows.filter((r) => r.action === 'skip-closed').length,
    skippedOther: rows.filter((r) => r.action === 'skip-not-in-progress').length,
    errors: rows.filter((r) => r.action === 'skip-error').length,
  };

  const plan = {
    dryRun: true,
    monthName,
    autoCloseEnabled: enabled,
    counts,
    rows: rows.map((r) => ({
      taskId: r.taskId,
      websiteUrl: r.websiteUrl,
      account: r.account,
      accountManager: r.accountManager,
      currentStatus: r.currentStatus || '',
      action: r.action,
      error: r.error || '',
      commentPreview: r.commentPreview,
    })),
  };

  if (dryRun) return plan;

  // 3. Live pass — refuse unless the explicit opt-in is on.
  if (!enabled) {
    throw new Error(
      'CLICKUP_AUTO_CLOSE_ENABLED is not enabled in settings — live close-out refused (dry-run preview still works)',
    );
  }

  const liveRows = [];
  for (const r of rows) {
    if (r.error) {
      liveRows.push({ ...r, outcome: 'skip-error' });
      continue;
    }
    if (String(r.currentStatus).toLowerCase() !== IN_PROGRESS) {
      liveRows.push({
        ...r,
        outcome: String(r.currentStatus).toLowerCase() === 'closed' ? 'skip-closed' : 'skip-not-in-progress',
      });
      continue;
    }

    try {
      let result;
      for (let attempt = 1; ; attempt++) {
        try {
          result = await completeClickUpMaintenanceTask({
            timeTrackUrl: r.timeTrackUrl,
            websiteUrl: r.websiteUrl,
            accountManager: r.accountManager,
            monthName,
            dryRun: false,
          });
          break;
        } catch (e) {
          const rateLimited = /429|rate/i.test(e.message);
          if (rateLimited && attempt < 3) {
            await sleep(attempt * 3000);
            continue;
          }
          throw e;
        }
      }
      liveRows.push({
        ...r,
        outcome: result.success ? 'closed' : result.skipped ? 'skip-race' : 'not-written',
        commentId: result.commentId || null,
        alreadyCommented: Boolean(result.alreadyCommented),
        statusAfter: result.status || '',
        reason: result.reason || '',
      });
    } catch (e) {
      liveRows.push({ ...r, outcome: 'error', error: e.message });
    }
    await sleep(120);
  }

  const summary = {
    closed: liveRows.filter((r) => r.outcome === 'closed').length,
    skipped: liveRows.filter((r) => r.outcome.startsWith('skip')).length,
    errors: liveRows.filter((r) => r.outcome === 'error').length,
    // Re-run safety: comment already existed for the month, run only closed it.
    reusedComments: liveRows.filter((r) => r.alreadyCommented).length,
  };

  return {
    dryRun: false,
    monthName,
    autoCloseEnabled: true,
    counts,
    summary,
    results: liveRows.map((r) => ({
      taskId: r.taskId,
      websiteUrl: r.websiteUrl,
      account: r.account,
      accountManager: r.accountManager,
      currentStatus: r.currentStatus || '',
      outcome: r.outcome,
      commentId: r.commentId || null,
      alreadyCommented: Boolean(r.alreadyCommented),
      statusAfter: r.statusAfter || '',
      reason: r.reason || '',
      error: r.error || '',
      commentPreview: r.commentPreview,
    })),
  };
}