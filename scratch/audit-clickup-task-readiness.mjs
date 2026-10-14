/**
 * audit-clickup-task-readiness.mjs  (READ-ONLY AUDIT)
 *
 * For EVERY site in the overview, checks its time-track link:
 *   - is it a ClickUp task URL?
 *   - can our code open that task (GET only)?
 *   - what status is it in? (in progress / closed / …)
 *
 * Nothing is posted, nothing is closed, nothing is written. It only calls
 * getOverviewData() (sheet read) and getClickUpTaskPreview() (ClickUp GET
 * with a 5s timeout + in-memory cache) - the exact read path the console
 * uses to open a task. No POST/PUT/DELETE anywhere.
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getOverviewData } from '../src/dashboardApi.js';
import { getClickUpTaskPreview } from '../src/clickup.js';

const here = path.dirname(fileURLToPath(import.meta.url));

const overview = await getOverviewData(null, 'all');
const sites = Array.isArray(overview?.sites) ? overview.sites : [];
console.log(`sites in overview: ${sites.length}`);

const withCu = sites
  .map((s) => ({
    websiteUrl: String(s.websiteUrl || '').trim(),
    account: String(s.account || s.accountKey || ''),
    timeTrackUrl: String(s.timeTrackUrl || '').trim(),
  }))
  .filter((t) => /clickup\.com/i.test(t.timeTrackUrl));

console.log(`sites with a ClickUp time-track URL: ${withCu.length}`);

const results = new Array(withCu.length);
let cursor = 0;

async function worker() {
  while (cursor < withCu.length) {
    const i = cursor++;
    const t = withCu[i];
    let attempt = 0;
    let preview;
    for (;;) {
      attempt += 1;
      preview = await getClickUpTaskPreview({
        timeTrackUrl: t.timeTrackUrl,
        websiteUrl: t.websiteUrl,
        accountManager: '', // read-only - no account manager involved
        monthName: null,
      });
      const err = String(preview.taskError || '');
      if (!/429/.test(err) || attempt >= 3) break;
      await new Promise((r) => setTimeout(r, 1500)); // back off a rate limit, still read-only
    }
    results[i] = { ...t, ...preview };
  }
}

await Promise.all(Array.from({ length: 4 }, worker));

const rows = results.map((r) => {
  const readable = Boolean(r.liveTask);
  const status = r.currentStatus || 'unknown';
  const closed = status.toLowerCase() === 'closed';
  const error = r.taskError || '';
  const ready = readable && !closed && !error;
  return { ...r, readable, ready, error, status };
});

const byAccount = (a) => rows.filter((r) => r.account === a);
const summarise = (list) => ({
  total: list.length,
  readable: list.filter((r) => r.readable).length,
  unreadable: list.filter((r) => !r.readable).length,
  ready: list.filter((r) => r.ready).length,
  alreadyClosed: list.filter((r) => r.readable && r.status.toLowerCase() === 'closed').length,
});

const all = summarise(rows);
const cw = summarise(byAccount('CW'));
const rm = summarise(byAccount('RM'));

function statusBreakdown(list) {
  const m = {};
  for (const r of list) {
    if (!r.readable) continue;
    const k = r.status.toLowerCase();
    m[k] = (m[k] || 0) + 1;
  }
  return m;
}

console.log('\n=== SUMMARY ===');
console.log(`  all   : ${all.total} with CU link | readable ${all.readable} | unreadable ${all.unreadable} | ready-to-send ${all.ready} | already closed ${all.alreadyClosed}`);
console.log(`  CW    : ${cw.total} | readable ${cw.readable} | unreadable ${cw.unreadable} | ready ${cw.ready} | closed ${cw.alreadyClosed}`);
console.log(`  RM    : ${rm.total} | readable ${rm.readable} | unreadable ${rm.unreadable} | ready ${rm.ready} | closed ${rm.alreadyClosed}`);
console.log(`  readable statuses: ${JSON.stringify(statusBreakdown(rows))}`);

console.log('\n=== UNREADABLE (can we open? NO) ===');
const unread = rows.filter((r) => !r.readable);
if (unread.length === 0) console.log('  (none - every ClickUp task opened successfully)');
else for (const r of unread) {
  console.log(`  [${r.account}] ${r.websiteUrl}  task=${r.taskId || r.timeTrackUrl}  -> ${r.error || r.statusMessage}`);
}

console.log('\n=== ALL READABLE TASKS (status) ===');
for (const r of rows.filter((r) => r.readable)) {
  const flag = r.ready ? 'READY' : r.status.toLowerCase() === 'closed' ? 'closed' : 'check';
  console.log(`  [${r.account}] ${(r.websiteUrl || '').padEnd(34)} ${String(r.taskId).padEnd(10)} ${r.status.padEnd(14)} ${flag}`);
}

// runtime copy for quick re-reading (NOT for commit)
fs.writeFileSync(
  path.join(here, 'clickup-task-audit.json'),
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      summary: { all, cw, rm, statuses: statusBreakdown(rows) },
      rows: rows.map((r) => ({
        account: r.account,
        websiteUrl: r.websiteUrl,
        taskId: r.taskId,
        timeTrackUrl: r.timeTrackUrl,
        status: r.status,
        readable: r.readable,
        ready: r.ready,
        error: r.error,
      })),
    },
    null,
    2,
  ),
);
console.log('\n(wrote scratch/clickup-task-audit.json - runtime artifact, not for commit)');