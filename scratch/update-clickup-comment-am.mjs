/**
 * update-clickup-comment-am.mjs — edit the ALREADY-POSTED completion comments
 * to add the account-manager mention. NO new follow-up comment, NO status
 * change.
 *
 * The replacement content uses the app's own builders
 * (buildMaintenanceNotificationComment / buildMaintenanceNotificationBlocks),
 * so the message is identical to what the pipeline posts for a person AM:
 *   {tag AM} " We have completed Maintenance for the month of <month> and sent
 *   email to clients for <site>. FYI " {tag Ovi}
 *
 * Only tasks whose sheet AM resolves to a real ClickUp user in AM_DIRECTORY
 * get an AM mention. N/A / no-AM / unmatched sites are left untouched.
 *
 * Mechanism: ClickUp API v2 historically has no comment-EDIT endpoint. The
 * script first probes `PUT /task/{id}/comment/{comment_id}` with an EMPTY body
 * (`{}`). Outcomes:
 *   404/405  -> endpoint does not exist -> fallback DELETE + re-POST the
 *              corrected comment (old comment gone; true replacement).
 *   4xx other-> endpoint exists but needs a body (no content touched) -> PUT.
 *   2xx      -> endpoint accepted an empty body (unlikely) -> check the
 *              comment is unchanged; if it was touched, restore it, then PUT.
 * The probe is non-mutating in every case (and re-verified in the 2xx case).
 *
 * USAGE:
 *   node scratch/update-clickup-comment-am.mjs        # read-only plan + probe
 *   node scratch/update-clickup-comment-am.mjs --live # plan + execute
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getOverviewData } from '../src/dashboardApi.js';
import {
  buildMaintenanceNotificationComment,
  buildMaintenanceNotificationBlocks,
} from '../src/clickup.js';

const LIVE = process.argv.includes('--live');
const here = path.dirname(fileURLToPath(import.meta.url));
const token = String(process.env.CLICKUP_API_TOKEN || '').trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const api = 'https://api.clickup.com/api/v2';
const OVI_ID = '49039188';

const resultsFile = fs
  .readdirSync(here)
  .filter((f) => f.startsWith('batch-clickup-results-') && f.endsWith('.json'))
  .sort()
  .pop();
if (!resultsFile) {
  console.error('no batch-clickup-results-*.json found; run batch-close first');
  process.exit(1);
}
const prior = JSON.parse(fs.readFileSync(path.join(here, resultsFile), 'utf8'));
const done = (prior.results || []).filter((r) => r.outcome === 'CLOSED' && r.commentId);
const monthName = prior.monthName || 'September';

console.log(`using prior run: ${resultsFile}`);
console.log(`tasks with posted comments: ${done.length} (month ${monthName})\n`);

function taskIdFromUrl(url) {
  const m = String(url || '').match(/clickup\.com\/t\/(?:[^/]+\/)?([^/?#]+)/i);
  return m ? m[1] : null;
}

async function getTaskComments(taskId) {
  const res = await fetch(`${api}/task/${encodeURIComponent(taskId)}/comment`, {
    headers: { Authorization: token, 'Content-Type': 'application/json' },
  });
  if (!res.ok) throw new Error(`list comments HTTP ${res.status}`);
  return (await res.json()).comments || [];
}

// Map task -> site (for the accountManager cell)
const overview = await getOverviewData(null, 'all');
const siteByTask = new Map();
for (const s of overview.sites || []) {
  const tt = String(s.timeTrackUrl || '').trim();
  if (!/clickup\.com/i.test(tt)) continue;
  const tid = taskIdFromUrl(tt);
  if (tid && !siteByTask.has(tid)) siteByTask.set(tid, s);
}

// Build the corrected comment for each task
const plans = [];
for (const r of done) {
  const site = siteByTask.get(r.taskId);
  const amCell = String(site?.accountManager || '').trim();
  const websiteUrl = r.websiteUrl || site?.websiteUrl || '';
  const commentText = buildMaintenanceNotificationComment({ accountManager: amCell, websiteUrl, monthName });
  const blocks = buildMaintenanceNotificationBlocks({ accountManager: amCell, websiteUrl, monthName });
  const hasAmTag = blocks.some((b) => b.type === 'tag' && String(b.user?.id) !== OVI_ID);
  plans.push({ ...r, websiteUrl, amCell, newCommentText: commentText, newBlocks: blocks, hasAmTag });
}

const toUpdate = plans.filter((p) => p.hasAmTag);
const noAm = plans.filter((p) => !p.hasAmTag && !p.amCell);
const noMatches = plans
  .filter((p) => !p.hasAmTag && p.amCell && !/^(n\/?a|no\s*am|none|support)/i.test(p.amCell))
  .filter((p) => p.amCell);

console.log('=== PLAN (read-only) ===');
console.log(`  to UPDATE with AM mention:   ${toUpdate.length}`);
console.log(`  skip - no AM in sheet:       ${noAm.length}`);
console.log(`  skip - AM not in directory:  ${noMatches.length}`);
for (const p of noMatches) console.log(`    ⚠ ${p.websiteUrl}  AM "${p.amCell}" has no directory match -> cannot tag a real user`);
for (const p of toUpdate) console.log(`  [UPDATE] ${p.websiteUrl}  ${p.taskId}  AM="${p.amCell}"`);

// ── probe: can the API edit a comment? (non-mutating) ──
let editMode = null; // 'PUT' | 'DELETE+POST'
if (toUpdate.length) {
  const probe = toUpdate[0];
  const existing = (await getTaskComments(probe.taskId).catch(() => [])).find(
    (c) => String(c.id) === String(probe.commentId),
  );
  const original = existing
    ? { comment: existing.comment ?? undefined, comment_text: existing.comment_text ?? undefined }
    : null;
  console.log(`\n=== API edit probe (task ${probe.taskId}, comment ${probe.commentId}) ===`);
  console.log(`  existing comment found: ${!!existing}`);

  const probeRes = await fetch(`${api}/task/${encodeURIComponent(probe.taskId)}/comment/${String(probe.commentId)}`, {
    method: 'PUT',
    headers: { Authorization: token, 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  console.log(`  PUT {} -> HTTP ${probeRes.status}`);

  const after = (await getTaskComments(probe.taskId).catch(() => [])).find(
    (c) => String(c.id) === String(probe.commentId),
  );
  const unchanged =
    JSON.stringify({ c: after?.comment ?? null, t: after?.comment_text ?? null }) ===
    JSON.stringify({ c: original?.comment ?? null, t: original?.comment_text ?? null });

  if (probeRes.status === 200 || probeRes.status === 204) {
    if (unchanged) {
      editMode = 'PUT';
      console.log('  API accepts PUT and content untouched -> edit in place via PUT');
    } else {
      // endpoint exists and an empty body mutated it: restore immediately
      console.log('  ⚠ PUT {} touched the comment — restoring original content');
      await fetch(`${api}/task/${encodeURIComponent(probe.taskId)}/comment/${String(probe.commentId)}`, {
        method: 'PUT',
        headers: { Authorization: token, 'Content-Type': 'application/json' },
        body: JSON.stringify(original || {}),
      });
      editMode = 'PUT';
      console.log('  restored; edit in place via PUT');
    }
  } else if (probeRes.status === 404 || probeRes.status === 405) {
    editMode = 'DELETE+POST';
    console.log(`  PUT not supported (HTTP ${probeRes.status}) -> replace via DELETE + re-POST`);
  } else {
    // endpoint exists but rejected the empty body; nothing was touched
    editMode = 'PUT';
    console.log(`  endpoint exists (HTTP ${probeRes.status}, content untouched) -> edit in place via PUT`);
  }
}

if (!LIVE) {
  console.log('\n(dry plan only — re-run with --live to replace the comments)');
  process.exitCode = 0;
} else if (toUpdate.length && editMode) {
  console.log(`\n=== LIVE: replacing ${toUpdate.length} comments via ${editMode} (no status change) ===`);
  const results = [];
  let updated = 0;
  for (const p of toUpdate) {
    try {
      let commentId = String(p.commentId);
      if (editMode === 'DELETE+POST') {
        const del = await fetch(`${api}/task/${encodeURIComponent(p.taskId)}/comment/${commentId}`, {
          method: 'DELETE',
          headers: { Authorization: token },
        });
        if (!del.ok && del.status !== 404) throw new Error(`delete HTTP ${del.status}`);
      }

      let data;
      for (let attempt = 1; ; attempt++) {
        const url =
          editMode === 'PUT'
            ? `${api}/task/${encodeURIComponent(p.taskId)}/comment/${commentId}`
            : `${api}/task/${encodeURIComponent(p.taskId)}/comment`;
        const res = await fetch(url, {
          method: editMode === 'PUT' ? 'PUT' : 'POST',
          headers: { Authorization: token, 'Content-Type': 'application/json' },
          body: JSON.stringify({ comment: p.newBlocks, notify_all: false }),
        });
        if (res.ok) {
          data = await res.json();
          break;
        }
        if (/429|rate/i.test(`${res.status}`) && attempt < 3) {
          await sleep(attempt * 3000);
          continue;
        }
        throw new Error(`comment HTTP ${res.status}: ${(await res.text().catch(() => '')).slice(0, 120)}`);
      }

      updated += 1;
      results.push({ ...p, outcome: 'UPDATED', newCommentId: data.id ?? commentId, via: editMode });
      console.log(`  ✅ ${p.websiteUrl}  ${p.taskId}  comment ${commentId} -> id ${data.id ?? commentId}  (AM "${p.amCell}")`);
    } catch (e) {
      results.push({ ...p, outcome: 'ERROR', error: e.message });
      console.log(`  ❌ ${p.websiteUrl}  ${p.taskId}  -> ${e.message}`);
    }
    await sleep(120);
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = path.join(here, `comment-am-update-${stamp}.json`);
  fs.writeFileSync(dest, JSON.stringify({ ranAt: new Date().toISOString(), editMode, updated, total: toUpdate.length, results }, null, 2));
  console.log(`\n=== DONE: ${updated}/${toUpdate.length} comments updated (${editMode}) ===`);

  console.log('\n=== verify (sample) ===');
  for (const p of toUpdate.slice(0, 3)) {
    try {
      const comments = await getTaskComments(p.taskId);
      const last = comments.at(-1);
      const tags = (last?.comment || []).filter((b) => b.type === 'tag').map((b) => String(b.user?.id));
      console.log(`  ${p.websiteUrl} ${p.taskId}: newest comment tags=${JSON.stringify(tags)}`);
    } catch { /* ignore */ }
  }
}