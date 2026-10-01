/**
 * dryrun-seed-kv.mjs
 *
 * The hosted dashboard reads its state from Workers KV. That namespace is
 * empty, so /api/master/stats reports 0 sites, 0 users and 0 tasks even though
 * the Google Sheet has 104. On the laptop that state lives in data/*.json.
 *
 * This script is a DRY RUN. It connects to nothing and writes nothing. It only
 * reports what a seed WOULD upload, so the decision can be made with the real
 * numbers in front of it.
 *
 * The reason this needs asking at all: it is the step that moves client data
 * (site URLs, team names, domain dates) off the operator's machine and into
 * Cloudflare. The Google Sheet is already at Google, but a second copy in KV is
 * a new copy in a new place, and that is the operator's call, not mine.
 *
 * Run:  node scratch/dryrun-seed-kv.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Must match STATE_KEYS in cloudflare-worker/dashboard-worker.js.
const STATE_KEYS = [
  'users', 'sites', 'tasks', 'properties', 'dev-projects', 'notices',
  'conditional-notes', 'daily-review', 'domain-expiry-requests', 'meta',
  'custom-sheets', 'sheet-credentials', 'assistant-config', 'sync-conflicts',
  'user-aliases', 'audit-log', 'master-overrides',
];

const fileFor = (key) => {
  if (key === 'conditional-notes') return 'email-conditional-notes.json';
  if (key === 'daily-review') return 'daily-review.json';
  if (key === 'dev-projects') return 'dev-projects.json';
  if (key === 'domain-expiry-requests') return 'domain-expiry-requests.json';
  if (key === 'sync-conflicts') return 'sync-conflicts.json';
  if (key === 'user-aliases') return 'user-aliases.json';
  return `${key}.json`;
};

console.log('DRY RUN - nothing is uploaded, nothing is changed\n');
console.log('key'.padEnd(26) + 'local file'.padEnd(34) + 'records'.padStart(9) + 'bytes'.padStart(10));
console.log('-'.repeat(79));

let totalRecords = 0; let totalBytes = 0; const missing = [];
const rows = [];

for (const key of STATE_KEYS) {
  const file = fileFor(key);
  const p = path.join(ROOT, 'data', file);
  if (!fs.existsSync(p)) { missing.push(key); rows.push({ key, file, records: 0, bytes: 0, present: false }); continue; }
  const raw = fs.readFileSync(p, 'utf8');
  let count = 0;
  try {
    const parsed = JSON.parse(raw);
    count = Array.isArray(parsed) ? parsed.length : Object.keys(parsed || {}).length;
  } catch { count = -1; }
  totalRecords += Math.max(count, 0);
  totalBytes += Buffer.byteLength(raw);
  rows.push({ key, file, records: count, bytes: Buffer.byteLength(raw), present: true });
  console.log(key.padEnd(26) + file.padEnd(34) + String(count).padStart(9) + String(Buffer.byteLength(raw)).padStart(10));
}

console.log('-'.repeat(79));
console.log('TOTAL'.padEnd(60) + String(totalRecords).padStart(9) + String(totalBytes).padStart(10));

if (missing.length) {
  console.log(`\nno local file for: ${missing.join(', ')}`);
  console.log('(these would simply be absent in KV; every read path already handles that)');
}

console.log(`
This is client data: site URLs, team member names, domain expiry dates,
maintenance status. A seed would copy all of it into Cloudflare KV.

WHAT IT WOULD CHANGE
  + the hosted dashboard would show the same numbers as the laptop
  + a SECOND copy of client data would exist, in Cloudflare, outside your laptop
  - KV writes are immediate but reads are eventually consistent per isolate

WHAT IT WOULD NOT CHANGE
  * the Google Sheet - nothing is written to it
  * data/*.json on disk - read only
  * src/ - untouched

BEFORE SEEDING, ONE THING IS WORTH DECIDING
  src/db.js is the source of truth per the project rules, and the sheet is the
  ultimate source. A second writable copy in KV is a new thing that can drift.
  The alternatives are (a) seed and accept the drift risk, or (b) put the
  dashboard behind Cloudflare Access and keep it on the laptop, where the data
  already is.

Nothing was uploaded. This script only reads files in data/.`);

fs.writeFileSync(path.join(ROOT, 'scratch', 'kv-seed-dryrun.json'), JSON.stringify({ rows, totalRecords, totalBytes, missing }, null, 2));
console.log('\nwrote scratch/kv-seed-dryrun.json');
