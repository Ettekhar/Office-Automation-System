/**
 * batch-close-clickup.mjs — close + comment ClickUp time-track tasks.
 *
 * RULES (as instructed):
 *   - ONLY tasks currently "in progress" are touched.
 *   - "closed" / "to do" / unknown / errored tasks are SKIPPED (never written).
 *   - ONE comment per unique task (deduped by taskId), message has NO account
 *     manager: "We have completed Maintenance for the month of <month> and
 *     sent email to clients for <site>. FYI @49039188".
 *   - Uses the app's own pipeline (completeClickUpMaintenanceTask). Nothing
 *     else is touched — no emails, no sheets, no config.
 *
 * USAGE:
 *   node scratch/batch-close-clickup.mjs        # read-only plan only
 *   node scratch/batch-close-clickup.mjs --live # plan + execute
 *
 * With --live, CLICKUP_AUTO_CLOSE_ENABLED is enabled for THIS process only;
 * .env / config are not modified.
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getOverviewData } from '../src/dashboardApi.js';
import { getClickUpTaskPreview, completeClickUpMaintenanceTask } from '../src/clickup.js';

const LIVE = process.argv.includes('--live');
const here = path.dirname(fileURLToPath(import.meta.url));
const token = String(process.env.CLICKUP_API_TOKEN || '').trim();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Phase A: plan (read-only) ──────────────────────────────────────────────
const overview = await getOverviewData(null, 'all');
const sites = Array.isArray(overview?.sites) ? overview.sites : [];
const monthName = overview.selectedMonth?.name || overview.selectedMonth?.monthName || 'September';

console.log(`month resolved for message: "${monthName}"`);
console.log(`sites in overview: ${sites.length}\n`);

const rows = [];
for (const s of sites) {
  const tt = String(s.timeTrackUrl || '').trim();
  if (!/clickup\.com/i.test(tt)) continue;
  let preview;
  try {
    preview = await getClickUpTaskPreview({
      timeTrackUrl: tt,
      websiteUrl: String(s.websiteUrl || '').trim(),
      accountManager: '',
      monthName,
    });
  } catch (e) {
    rows.push({ websiteUrl: String(s.websiteUrl || ''), account: s.account, taskId: null, status: 'error', error: e.message, timeTrackUrl: tt });
    continue;
  }
  rows.push({
    websiteUrl: String(s.websiteUrl || '').trim(),
    account: String(s.account || ''),
    taskId: preview.taskId || null,
    status: preview.currentStatus || 'unknown',
    error: preview.taskError || '',
    timeTrackUrl: tt,
  });
}

// Dedupe by taskId (first row wins)
const uniq = new Map();
for (const r of rows) {
  if (r.taskId && !uniq.has(r.taskId)) uniq.set(r.taskId, r);
}
const tasks = [...uniq.values()];

const eligible = tasks.filter((t) => t.taskId && String(t.status).toLowerCase() === 'in progress');
const skippedClosed = tasks.filter((t) => t.taskId && String(t.status).toLowerCase() === 'closed');
const skippedOther = tasks.filter((t) => t.taskId && !['in progress', 'closed'].includes(String(t.status).toLowerCase()));
const skippedError = tasks.filter((t) => !t.taskId || t.error);

console.log('=== PLAN (read-only) ===');
console.log(`unique tasks with CU link: ${tasks.length}`);
console.log(`  ✅ TO CLOSE+COMMENT (in progress): ${eligible.length}`);
console.log(`  ⏭  skip - already closed:          ${skippedClosed.length}`);
console.log(`  ⏭  skip - not in progress:         ${skippedOther.length}`);
console.log(`  ⏭  skip - unreadable/error:        ${skippedError.length}`);

for (const t of eligible) {
  console.log(`  [CLOSE] ${t.websiteUrl}  ${t.taskId}  ${t.status} -> Closed`);
}
for (const t of skippedClosed) console.log(`  [SKIP closed]      ${t.websiteUrl}  ${t.taskId}`);
for (const t of skippedOther) console.log(`  [SKIP ${t.status}] ${t.websiteUrl}  ${t.taskId}  ${t.error}`);
for (const t of skippedError) console.log(`  [SKIP error]       ${t.websiteUrl}  ${t.taskId || t.timeTrackUrl}  ${t.error}`);

if (!eligible.length) {
  console.log('\n(nothing in progress to do)');
  process.exitCode = 0;
} else if (!LIVE) {
  console.log('\n(dry plan only — re-run with --live to execute)');
  process.exitCode = 0;
} else {
  console.log(`\nexample message: We have completed Maintenance for the month of ${monthName} and sent email to clients for ${eligible[0].websiteUrl}. FYI @49039188`);
}

if (LIVE && eligible.length) {
  console.log('\n=== LIVE: closing + commenting (in-progress only) ===');
  process.env.CLICKUP_AUTO_CLOSE_ENABLED = 'true'; // process-local opt-in only

  async function freshStatus(taskId) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    try {
      const res = await fetch(`https://api.clickup.com/api/v2/task/${encodeURIComponent(taskId)}`, {
        headers: { Authorization: token, 'Content-Type': 'application/json' },
        signal: ctrl.signal,
      });
      if (!res.ok) return { http: res.status };
      const d = await res.json();
      return { status: d.status?.status || '' };
    } catch (e) {
      return { error: e.name === 'AbortError' ? 'timeout' : e.message };
    } finally {
      clearTimeout(t);
    }
  }

  const results = [];
  let closed = 0;

  for (const t of eligible) {
    try {
      // Fresh re-check immediately before writing (bypasses the 5-min cache).
      const fresh = await freshStatus(t.taskId);
      if (!fresh.status || String(fresh.status).toLowerCase() !== 'in progress') {
        results.push({ ...t, outcome: 'SKIP (status changed before write)', freshStatus: fresh.status || fresh.http || fresh.error });
        console.log(`  SKIP ${t.websiteUrl} ${t.taskId} (now "${fresh.status || fresh.http || fresh.error}")`);
        continue;
      }

      let res;
      for (let attempt = 1; ; attempt++) {
        try {
          res = await completeClickUpMaintenanceTask({
            timeTrackUrl: t.timeTrackUrl,
            websiteUrl: t.websiteUrl,
            accountManager: '',
            monthName,
            dryRun: false,
          });
          break;
        } catch (e) {
          const rate = /429|rate/i.test(e.message);
          if (rate && attempt < 3) {
            await sleep(attempt * 3000);
            continue;
          }
          throw e;
        }
      }

      if (res && res.success) {
        closed += 1;
        results.push({ ...t, outcome: 'CLOSED', commentId: res.commentId, statusAfter: res.status, comment: res.commentText });
        console.log(`  ✅ ${t.websiteUrl}  ${t.taskId}  → ${res.status}  commentId=${res.commentId}  "${res.commentText}"`);
      } else {
        results.push({ ...t, outcome: 'not-written', detail: res });
        console.log(`  ⚠️  ${t.websiteUrl}  ${t.taskId}  → not written (${res?.reason || 'unknown'})`);
      }
    } catch (e) {
      results.push({ ...t, outcome: 'ERROR', error: e.message });
      console.log(`  ❌ ${t.websiteUrl}  ${t.taskId}  → ${e.message}`);
    }
    await sleep(120); // gentle pacing for ClickUp rate limits
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = path.join(here, `batch-clickup-results-${stamp}.json`);
  fs.writeFileSync(dest, JSON.stringify({ ranAt: new Date().toISOString(), monthName, closed, total: eligible.length, results }, null, 2));
  console.log(`\n=== DONE: ${closed}/${eligible.length} closed+commented ===`);
  console.log(`(runtime results file: ${dest} — not for commit)`);
}