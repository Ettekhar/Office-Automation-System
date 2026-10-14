/**
 * probe-close-clickup-task.mjs — closes the TEST task via our own code path
 * (completeClickUpMaintenanceTask) and posts the exact notification comment.
 *
 * USAGE:
 *   node scratch/probe-close-clickup-task.mjs          # read-only check + dry run
 *   node scratch/probe-close-clickup-task.mjs --live     # ALSO performs the live write
 *
 * With --live the CLICKUP_AUTO_CLOSE_ENABLED opt-in is set for THIS process only;
 * the .env file and any config are never touched.
 *
 * Task: https://app.clickup.com/t/10554421/868mfb3bu
 * Message (NO account manager): We have completed Maintenance for the month of
 * September and sent email to clients for qualityinnparkersburg.com. FYI @49039188
 */
import 'dotenv/config';
import {
  completeClickUpMaintenanceTask,
  getClickUpTaskPreview,
} from '../src/clickup.js';

const LIVE = process.argv.includes('--live');
const TASK_URL = 'https://app.clickup.com/t/10554421/868mfb3bu';
const WEBSITE = 'qualityinnparkersburg.com';
const MONTH = 'September';
// Empty account manager -> resolveAccountManager treats it as non-person, so
// the comment carries NO account manager mention - only the FYI @49039188 tag.
const AM = '';

console.log('=== PHASE 0: read-only task check ===');
const preview = await getClickUpTaskPreview({
  timeTrackUrl: TASK_URL,
  websiteUrl: WEBSITE,
  accountManager: AM,
  monthName: MONTH,
});
console.log(`  taskId:        ${preview.taskId}`);
console.log(`  currentStatus: ${preview.currentStatus}`);
console.log(`  statusBadge:   ${preview.statusBadge}`);
console.log(`  statusMessage: ${preview.statusMessage}`);
console.log(`  autoClose:     ${preview.autoCloseEnabled ? 'enabled' : 'disabled (dry-run guard active)'}`);
console.log(`  hasToken:      ${preview.hasToken}`);
console.log(`  commentText:   ${preview.commentText}`);

console.log('\n=== PHASE 1: dry run (no writes) ===');
const dry = await completeClickUpMaintenanceTask({
  timeTrackUrl: TASK_URL,
  websiteUrl: WEBSITE,
  accountManager: AM,
  monthName: MONTH,
  dryRun: true,
});
console.log(`  dryRun: ${dry.dryRun} (${dry.reason})`);
console.log(`  would post: ${dry.comment}`);

if (!LIVE) {
  console.log('\n(dry run only — re-run with --live to actually close + comment)');
  process.exitCode = 0;
} else {

console.log('\n=== PHASE 2: LIVE write (process-local opt-in only) ===');
process.env.CLICKUP_AUTO_CLOSE_ENABLED = 'true'; // confined to this process
const result = await completeClickUpMaintenanceTask({
  timeTrackUrl: TASK_URL,
  websiteUrl: WEBSITE,
  accountManager: AM,
  monthName: MONTH,
  dryRun: false,
});
console.log(`  success:    ${result.success}`);
console.log(`  taskId:     ${result.taskId}`);
console.log(`  status:     ${result.status}`);
console.log(`  commentId:  ${result.commentId}`);
console.log(`  comment:    ${result.commentText}`);

console.log('\n=== PHASE 3: verify live state ===');
const verify = await getClickUpTaskPreview({
  timeTrackUrl: TASK_URL,
  websiteUrl: WEBSITE,
  accountManager: AM,
  monthName: MONTH,
});
console.log(`  status now: ${verify.currentStatus} (badge=${verify.statusBadge})`);
const token = String(process.env.CLICKUP_API_TOKEN || '').trim();
const commentsRes = await fetch(
  `https://api.clickup.com/api/v2/task/${encodeURIComponent(verify.taskId)}/comment`,
  { headers: { Authorization: token, 'Content-Type': 'application/json' } },
);
if (commentsRes.ok) {
  const data = await commentsRes.json();
  const comments = data.comments || [];
  const last = comments[comments.length - 1];
  console.log(`  comment count: ${comments.length}`);
  if (last) {
    console.log(`  newest comment id ${last.id}: ${(last.comment_text || '').slice(0, 160)}`);
    const found = comments.some((c) => (c.comment_text || '').includes('qualityinnparkersburg.com'));
    console.log(`  our message present in history: ${found}`);
  }
} else {
  console.log(`  comment fetch HTTP ${commentsRes.status}`);
}
}