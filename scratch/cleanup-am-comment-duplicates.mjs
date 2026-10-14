/**
 * cleanup-am-comment-duplicates.mjs — corrective pass.
 *
 * The earlier update pass posted a corrected (AM-mention) comment per task but
 * its DELETE used the wrong path (`/task/{id}/comment/{comment_id}` -> 404),
 * so the ORIGINAL no-AM comments were never removed -> 56 tasks now have TWO
 * comments. This deletes the original duplicates via the documented endpoint:
 *
 *   DELETE /api/v2/comment/{comment_id}
 *
 * Then it verifies, per task, that the kept new comment contains BOTH the AM
 * tag and Ovi's tag (49039188). Task status is never touched.
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const LIVE = process.argv.includes('--live') || !process.argv.includes('--plan');
const here = path.dirname(fileURLToPath(import.meta.url));
const token = String(process.env.CLICKUP_API_TOKEN || '').trim();
const api = 'https://api.clickup.com/api/v2';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const OVI_ID = '49039188';

const updateFile = fs
  .readdirSync(here)
  .filter((f) => f.startsWith('comment-am-update-') && f.endsWith('.json'))
  .sort()
  .pop();
if (!updateFile) {
  console.error('no comment-am-update-*.json found');
  process.exit(1);
}
const upd = JSON.parse(fs.readFileSync(path.join(here, updateFile), 'utf8'));
const entries = (upd.results || []).filter((e) => e.outcome === 'UPDATED' && e.commentId && e.newCommentId);
console.log(`using ${updateFile}`);
console.log(`tasks to dedupe: ${entries.length}\n`);

function flattenBlocks(b, out = []) {
  if (!Array.isArray(b)) return out;
  for (const item of b) {
    out.push(item);
    if (Array.isArray(item.content)) flattenBlocks(item.content, out);
  }
  return out;
}

async function getComments(taskId) {
  const res = await fetch(`${api}/task/${encodeURIComponent(taskId)}/comment`, {
    headers: { Authorization: token, 'Content-Type': 'application/json' },
  });
  if (!res.ok) throw new Error(`list HTTP ${res.status}`);
  return (await res.json()).comments || [];
}

async function deleteComment(commentId) {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(`${api}/comment/${String(commentId)}`, {
      method: 'DELETE',
      headers: { Authorization: token, 'Content-Type': 'application/json' },
    });
    if (res.ok) return res.status;
    if (res.status === 404) return 404; // already gone
    if (/429|rate/i.test(`${res.status}`) && attempt < 3) {
      await sleep(attempt * 3000);
      continue;
    }
    throw new Error(`delete HTTP ${res.status}: ${(await res.text().catch(() => '')).slice(0, 120)}`);
  }
}

// ── plan ──
console.log('=== PLAN ===');
const plan = [];
for (const e of entries) {
  let comments;
  try {
    comments = await getComments(e.taskId);
  } catch (err) {
    plan.push({ ...e, listError: err.message });
    console.log(`  [ERROR list] ${e.websiteUrl} ${e.taskId} ${err.message}`);
    continue;
  }
  const oldPresent = comments.some((c) => String(c.id) === String(e.commentId));
  const newPresent = comments.some((c) => String(c.id) === String(e.newCommentId));
  plan.push({ ...e, oldPresent, newPresent, comments });
  console.log(`  [${oldPresent ? 'DELETE-OLD' : 'old-gone'} ${newPresent ? '+new-ok' : '!!NEW-MISSING'}] ${e.websiteUrl} ${e.taskId} old=${e.commentId} new=${e.newCommentId}`);
}

if (!LIVE) {
  console.log('\n(plan only — re-run without --plan to execute)');
  process.exitCode = 0;
} else {
  console.log('\n=== LIVE: deleting old duplicate comments ===');
  const results = [];
  let deleted = 0;
  for (const p of plan) {
    try {
      if (p.oldPresent) {
        const status = await deleteComment(p.commentId);
        if (status === 200 || status === 404) {
          deleted += 1;
          console.log(`  ✅ deleted old ${p.websiteUrl} ${p.taskId} (HTTP ${status})`);
        } else {
          console.log(`  ⚠️  ${p.websiteUrl} ${p.taskId} delete HTTP ${status}`);
        }
      } else {
        console.log(`  ⏭  old already gone ${p.websiteUrl} ${p.taskId}`);
      }
      results.push({ taskId: p.taskId, websiteUrl: p.websiteUrl, oldCommentId: p.commentId, newCommentId: p.newCommentId, deleted: p.oldPresent });
    } catch (e) {
      results.push({ taskId: p.taskId, websiteUrl: p.websiteUrl, error: e.message });
      console.log(`  ❌ ${p.websiteUrl} ${p.taskId} -> ${e.message}`);
    }
    await sleep(120);
  }

  console.log(`\n=== VERIFY (post-cleanup) ===`);
  const verify = [];
  for (const p of plan.slice(0, 10)) {
    try {
      const comments = await getComments(p.taskId);
      const oldStill = comments.some((c) => String(c.id) === String(p.commentId));
      const mine = comments.find((c) => String(c.id) === String(p.newCommentId));
      const blocks = mine ? flattenBlocks(mine.comment || mine.comment_blocks) : [];
      const tags = blocks.filter((b) => b.type === 'tag').map((b) => String(b.user?.id));
      const hasAm = tags.some((t) => t !== OVI_ID);
      const hasOvi = tags.includes(OVI_ID);
      verify.push({ taskId: p.taskId, websiteUrl: p.websiteUrl, oldStill, newPresent: !!mine, tags, hasAm, hasOvi, totalComments: comments.length });
      console.log(`  ${p.websiteUrl} ${p.taskId}: oldGone=${!oldStill} newPresent=${!!mine} tags=${JSON.stringify(tags)} AM=${hasAm} Ovi=${hasOvi} total=${comments.length}`);
    } catch (e) {
      verify.push({ taskId: p.taskId, websiteUrl: p.websiteUrl, error: e.message });
      console.log(`  ❌ verify ${p.websiteUrl} -> ${e.message}`);
    }
    await sleep(120);
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = path.join(here, `am-comment-cleanup-${stamp}.json`);
  fs.writeFileSync(dest, JSON.stringify({ ranAt: new Date().toISOString(), deleted, total: plan.length, results, verify }, null, 2));
  console.log(`\n=== DONE: ${deleted} old comments deleted (${plan.length} tasks) ===`);
  console.log(`(runtime results file: ${dest} — not for commit)`);
}