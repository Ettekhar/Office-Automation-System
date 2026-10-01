/**
 * sweep-dashboard-live.mjs
 *
 * Calls every READ-ONLY dashboard route on the DEPLOYED Worker and reports what
 * came back. This is the "is it actually working in the cloud" check.
 *
 * SAFETY
 * ------
 * Only GET routes are called, and only ones classify-routes.mjs marked
 * read-only. Anything that can mutate a live spreadsheet is excluded by name as
 * well, belt and braces:
 *
 *   GET /api/master/daily-review        runs a background batchUpdate reconcile
 *   GET /api/master/sheets/cache-status classified write-capable
 *   anything containing "sync"          sync writes statuses back to the sheet
 *
 * No POST/PUT/DELETE is ever sent. No dry run either - the point is to prove
 * the read path works end to end against the real sheets.
 *
 * Usage:  node scratch/sweep-dashboard-live.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Token from .env - never printed, never committed.
const envRaw = fs.readFileSync(path.join(ROOT, '.env'), 'utf8');
const token = (/^DASHBOARD_ADMIN_TOKEN=(.*)$/m.exec(envRaw) || [])[1]?.trim();
const base = (/^DASHBOARD_WORKER_URL=(.*)$/m.exec(envRaw) || [])[1]?.trim()
  || 'https://officeos-dashboard.taion16240.workers.dev';
if (!token) { console.error('no DASHBOARD_ADMIN_TOKEN in .env'); process.exit(1); }

const classification = JSON.parse(fs.readFileSync(path.join(ROOT, 'scratch', 'route-classification.json'), 'utf8'));
const EXCLUDE = /daily-review|cache-status|sync/i;

const targets = classification.reads
  .filter((r) => r.method === 'GET')
  .filter((r) => !EXCLUDE.test(r.route))
  .map((r) => r.route);
const deduped = [...new Set(targets)];

console.log(`sweeping ${deduped.length} read-only routes on ${base}\n`);

const results = [];
for (const route of deduped) {
  const t0 = Date.now();
  let status = 0; let body = ''; let note = '';
  try {
    const res = await fetch(base + route, { headers: { authorization: `Bearer ${token}` } });
    status = res.status;
    body = await res.text();
  } catch (e) {
    note = e.message;
  }
  const ms = Date.now() - t0;
  results.push({ route, status, ms, note, bytes: body.length, sample: body.slice(0, 160) });
  const tag = status === 200 ? 'ok  ' : status === 404 ? '404 ' : 'FAIL';
  console.log(`  ${tag} ${String(status).padEnd(4)} ${String(ms).padStart(5)}ms  ${route}`);
  if (status !== 200 && status !== 404) {
    console.log(`        ${body.replace(/\s+/g, ' ').slice(0, 200)}`);
  }
}

const ok = results.filter((r) => r.status === 200);
const notFound = results.filter((r) => r.status === 404);
const failed = results.filter((r) => r.status !== 200 && r.status !== 404);

console.log(`\n${'='.repeat(60)}`);
console.log(`  200 OK      ${ok.length}`);
console.log(`  404         ${notFound.length}   (route not implemented / different path shape)`);
console.log(`  FAILED      ${failed.length}`);

if (notFound.length) {
  console.log('\n  404s:');
  for (const r of notFound) console.log(`    ${r.route}`);
}
if (failed.length) {
  console.log('\n  FAILURES:');
  for (const r of failed) {
    console.log(`    ${r.route}  -> ${r.status}`);
    console.log(`      ${r.sample.replace(/\s+/g, ' ').slice(0, 300)}`);
  }
}

fs.writeFileSync(path.join(ROOT, 'scratch', 'live-sweep.json'), JSON.stringify(results, null, 2));
console.log('\nwrote scratch/live-sweep.json');
process.exit(failed.length ? 1 : 0);
