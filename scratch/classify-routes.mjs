/**
 * classify-routes.mjs
 *
 * Enumerates the dashboard's routes from source and separates
 *
 *   READ  - safe to call against production for a verification sweep
 *   WRITE - a GET (or any route) that can mutate a live Google Sheet
 *   SKIP  - not a route, or needs a body/params we will not invent
 *
 * WHY THIS EXISTS
 * ---------------
 * GET /api/master/daily-review looks read-only but runs a background reconcile
 * that issues batchUpdate against a live client spreadsheet. Calling it as part
 * of a "just checking" sweep would WRITE TO CLIENT DATA. That is exactly the
 * thing the project rules forbid without a dry run first, so the sweep must
 * know which routes are safe before it touches anything.
 *
 * Run:  node scratch/classify-routes.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const raw = fs.readFileSync(path.join(ROOT, 'src', 'server.js'), 'utf8');
const lines = raw.split('\n');

// Anything that can change a spreadsheet or persistent state.
const WRITE_SIGNALS = [
  'batchUpdate', 'updateSheetCell', 'appendSheetRow', 'appendSheetColumn',
  'appendMonthColumn', 'removeEmptyTrailingMonthColumns', 'syncSiteStatusToSheet',
  'batchUpdateDailyReviewTab', 'syncStatusToDailyReviewSheet', 'updateSiteStatusInSheet',
  'appendNewSiteToSheet', 'updateDevTrackerRowInSheet', 'appendDevTrackerRowInSheet',
  'createNewFeedbackRoundInSheet', 'bulkAppendSitemapUrlsInSheet',
  'createNewProjectTabWithSitemapInSheet', 'applyRowBackgrounds',
  'deleteDimension', 'values.update', 'values.append', 'values.batchUpdate',
  'shouldWriteReconciledStatus', 'Background reconcile',
  'dbWrite', 'setSites(', 'setUsers(', 'setTasks(', 'createTask(', 'updateTask(',
  'deleteTask(', 'createUser(', 'updateUser(', 'deleteUser(', 'addSite(',
  'createNotice(', 'updateNotice(', 'deleteNotice(', 'createProperty(',
  'addNewMonth(', 'selectMonth', 'setActiveMonth',
];

// Find each `if (pathname === '/api/x' && method === 'Y') {` and take its block.
const routes = [];
const starts = [];
lines.forEach((l, i) => {
  const m = /pathname\s*===\s*'([^']+)'\s*&&\s*method\s*===\s*'([A-Z]+)'/.exec(l);
  if (m) starts.push({ i, route: m[1], method: m[2] });
});
const prefix = /pathname\.startsWith\('(\/api\/[^']+)'\)/.exec(raw);
if (prefix) starts.push({ i: lines.findIndex((l) => l.includes(`pathname.startsWith('${prefix[1]}')`)), route: `${prefix[1]}*`, method: '*' });

for (let s = 0; s < starts.length; s++) {
  const { i, route, method } = starts[s];
  const end = s + 1 < starts.length ? starts[s + 1].i : lines.length;
  const body = lines.slice(i, end).join('\n');
  const signals = WRITE_SIGNALS.filter((sig) => body.includes(sig));
  routes.push({ route, method, line: i + 1, signals, writes: signals.length > 0 });
}

const reads = routes.filter((r) => !r.writes);
const writes = routes.filter((r) => r.writes);

console.log(`routes found: ${routes.length}  (read ${reads.length}, write-capable ${writes.length})\n`);
console.log('=== WRITE-CAPABLE - do NOT call these in a verification sweep ===');
for (const r of writes) {
  console.log(`  ${(r.method + ' ' + r.route).padEnd(46)} line ${String(r.line).padStart(5)}  ${r.signals.slice(0, 3).join(', ')}`);
}
console.log('\n=== READ-ONLY - safe to call ===');
for (const r of reads) console.log(`  ${(r.method + ' ' + r.route).padEnd(46)} line ${String(r.line).padStart(5)}`);

fs.writeFileSync(
  path.join(ROOT, 'scratch', 'route-classification.json'),
  JSON.stringify({ reads, writes, generatedBy: 'classify-routes.mjs' }, null, 2),
);
console.log('\nwrote scratch/route-classification.json');
