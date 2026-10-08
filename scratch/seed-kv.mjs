/**
 * seed-kv.mjs
 *
 * Uploads data/*.json into the dashboard Worker's KV namespace so the hosted
 * dashboard shows the same state as the laptop.
 *
 * WHY THIS EXISTS
 *
 * The dashboard Worker serves its state from Workers KV. That namespace is
 * empty, so /api/master/stats reports 0 sites, 0 users, 0 tasks even though the
 * Google Sheet has 104 sites. Every sheet-backed read works, because those go
 * to Google. Everything KV-backed renders empty, because there is nothing there.
 * That is the whole reason the hosted dashboard "looks empty" - not a bug in
 * the port.
 *
 * THE CONTRACT
 *
 *   0. EVERY wrangler call passes --remote. Without it wrangler writes to a
 *      local miniflare SQLite store, prints "Resource location: local", exits
 *      0, and reports success while Cloudflare stays empty. That is not
 *      hypothetical: the first two attempts at this seed did exactly that and
 *      failed on all 16 keys. It is the same trap that made the D1 schema
 *      deploy "succeed" against an empty remote database.
 *   1. --dry-run is the DEFAULT and uploads nothing. A real upload requires the
 *      explicit --upload flag, so this script can never write by accident.
 *   2. NEVER_WRITE is respected. rag-index (1.9 MB) and assistant-metrics are
 *      not in STATE_KEYS and are never touched - see kv-shim.js.
 *   3. Nothing is written to the Google Sheet. data/*.json is read-only here.
 *   4. src/ is not touched.
 *   5. Every key is written then READ BACK and compared to what was sent. A
 *      "success" that was not verified is not a success.
 *
 * WHY VERIFY EVERY KEY
 *
 * KV writes are eventually consistent. A PUT returning 200 means it was
 * accepted, not that a subsequent GET will return it. So a seed that reports
 * "uploaded 17 keys" while the dashboard still shows zeroes is the exact
 * failure this project keeps getting burned by - a check that reports success
 * while proving nothing. The read-back compares record counts and a content
 * hash of every value.
 *
 * WHY THE AUDIT LOG AND SHEET CREDENTIALS ARE INCLUDED
 *
 * Both are gitignored, and that was a decision about the git history being
 * public - not about Cloudflare. Their content was checked before including
 * them: sheet-credentials.json holds custom-sheet definitions (id, title,
 * spreadsheetId, tabName, ...) and no secret-bearing fields; assistant-config
 * holds provider NAMES and no key material. audit-log.json is the project's own
 * change trail and the report renders it in its own tab, so seeding it is what
 * makes the hosted report match the laptop.
 *
 * Run:  node scratch/seed-kv.mjs              # dry run, uploads nothing
 *        node scratch/seed-kv.mjs --upload     # actually write
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WRANGLER = path.join(ROOT, 'node_modules', 'wrangler', 'bin', 'wrangler.js');

// Must match STATE_KEYS in cloudflare-worker/dashboard-worker.js. A key here
// that the Worker does not know is a wasted write; a key missing here is an
// empty dashboard. The verifier asserts these two agree.
const STATE_KEYS = [
  'users', 'sites', 'tasks', 'properties', 'dev-projects', 'notices',
  'conditional-notes', 'daily-review', 'domain-expiry-requests', 'meta',
  'custom-sheets', 'sheet-credentials', 'assistant-config', 'sync-conflicts',
  'user-aliases', 'audit-log', 'master-overrides', 'auth-sessions',
];

// Never upload these, whatever else changes. rag-index is 1.9 MB and a build
// artefact; assistant-metrics is a runtime counter. kv-shim.js refuses writes
// to both, so writing them here would fail anyway.
const NEVER_WRITE = new Set(['rag-index', 'assistant-metrics']);

const fileFor = (key) => {
  if (key === 'conditional-notes') return 'email-conditional-notes.json';
  if (key === 'daily-review') return 'daily-review.json';
  if (key === 'dev-projects') return 'dev-projects.json';
  if (key === 'domain-expiry-requests') return 'domain-expiry-requests.json';
  if (key === 'sync-conflicts') return 'sync-conflicts.json';
  if (key === 'user-aliases') return 'user-aliases.json';
  return `${key}.json`;
};

const NS = 'c44955e25a1c4791a89f3f3783213e12';
const UPLOAD = process.argv.includes('--upload');

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 12);

function wrangler(args, { allowFail = false } = {}) {
  try {
    return {
      ok: true,
      out: execFileSync(process.execPath, [WRANGLER, ...args],
        { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 300000 }),
    };
  } catch (e) {
    // The message matters. An earlier version returned only stdout+stderr, and
    // because a ReferenceError prints nothing on either stream, every failure
    // reported as "FAIL <key>: " with an empty reason - 16 identical silent
    // failures that looked like a Cloudflare problem and were actually this
    // function's own bug. Always include e.message.
    const detail = [
      e.message,
      e.stdout ? String(e.stdout) : '',
      e.stderr ? String(e.stderr) : '',
    ].filter(Boolean).join(' | ');
    if (allowFail) return { ok: false, out: detail };
    throw new Error(detail);
  }
}

console.log(`\n=== KV seed ${UPLOAD ? '(REAL UPLOAD)' : '(DRY RUN - uploads nothing)'} ===\n`);
console.log(`  namespace: ${NS}`);

// ------------------------------------------------------------ collect payload
const payload = [];
const missing = [];
for (const key of STATE_KEYS) {
  if (NEVER_WRITE.has(key)) { console.log(`  skip     ${key} (NEVER_WRITE)`); continue; }
  const p = path.join(ROOT, 'data', fileFor(key));
  if (!fs.existsSync(p)) { missing.push(key); continue; }
  const raw = fs.readFileSync(p, 'utf8');
  let records;
  try {
    const parsed = JSON.parse(raw);
    records = Array.isArray(parsed) ? parsed.length : Object.keys(parsed || {}).length;
  } catch (e) {
    console.log(`  ERROR    ${key}: ${fileFor(key)} is not valid JSON - refusing to upload a broken value`);
    process.exit(1);
  }
  payload.push({ key, file: fileFor(key), records, bytes: Buffer.byteLength(raw), raw, hash: sha(raw) });
}

if (missing.length) {
  console.log(`\n  no local file for: ${missing.join(', ')}`);
  console.log('  (left absent in KV; every read path already handles a missing key)');
}

console.log(`\n  key`.padEnd(30) + 'records'.padStart(9) + 'bytes'.padStart(10));
console.log('  ' + '-'.repeat(49));
let tRec = 0; let tBytes = 0;
for (const p of payload) {
  tRec += p.records; tBytes += p.bytes;
  console.log('  ' + p.key.padEnd(28) + String(p.records).padStart(9) + String(p.bytes).padStart(10));
}
console.log('  ' + '-'.repeat(49));
console.log('  ' + 'TOTAL'.padEnd(28) + String(tRec).padStart(9) + String(tBytes).padStart(10));

// ------------------------------------------------------ confirm Worker agrees
console.log('\n--- STATE_KEYS agrees with the Worker? ---');
const workerSrc = fs.readFileSync(path.join(ROOT, 'cloudflare-worker', 'dashboard-worker.js'), 'utf8');
const m = /const STATE_KEYS\s*=\s*\[([\s\S]*?)\]/.exec(workerSrc);
const workerKeys = m ? [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]) : [];
const missingInWorker = STATE_KEYS.filter((k) => !workerKeys.includes(k));
const extraInWorker = workerKeys.filter((k) => !STATE_KEYS.includes(k));
if (missingInWorker.length || extraInWorker.length) {
  console.log(`  ERROR  STATE_KEYS drift. only here: ${missingInWorker.join(', ') || '-'} | only in Worker: ${extraInWorker.join(', ') || '-'}`);
  process.exit(1);
}
console.log(`  ok       all ${STATE_KEYS.length} keys match the Worker`);

// -------------------------------------------------------------- current state
console.log('\n--- KV before ---');
const before = wrangler(['kv', 'key', 'list', '--namespace-id', NS, '--remote'], { allowFail: true });
let beforeKeys = [];
try {
  const s = before.out.indexOf('[');
  beforeKeys = JSON.parse(before.out.slice(s)).map((k) => k.name);
} catch { /* reported below */ }
console.log(`  ${beforeKeys.length} key(s) present${beforeKeys.length ? `: ${beforeKeys.join(', ')}` : ''}`);

if (!UPLOAD) {
  console.log(`
NOTHING WAS UPLOADED.

This was a dry run. To actually write:
    node scratch/seed-kv.mjs --upload

That will copy ${tRec} records (${(tBytes / 1024).toFixed(0)} KB) of client data
into Cloudflare KV: site URLs, team member names, domain expiry dates,
maintenance status, and the audit trail.

This creates a SECOND copy of that data, outside your laptop, in Cloudflare.
It does not touch the Google Sheet, data/*.json on disk, or src/.`);
  fs.writeFileSync(path.join(ROOT, 'scratch', 'kv-seed-manifest.json'),
    JSON.stringify({ namespace: NS, keys: payload.map(({ key, file, records, bytes, hash }) => ({ key, file, records, bytes, hash })), totalRecords: tRec, totalBytes: tBytes, missing }, null, 2));
  console.log('\n  wrote scratch/kv-seed-manifest.json');
  process.exit(0);
}

// ------------------------------------------------------------------- UPLOAD
console.log(`\n--- uploading ${payload.length} key(s) ---`);
const written = [];
for (const p of payload) {
  // --path avoids argv length limits and quoting problems with client data.
  const tmp = path.join(ROOT, 'scratch', '.tmp-kv-value.json');
  fs.writeFileSync(tmp, p.raw, 'utf8');
  // No --content-type flag: this wrangler version rejects it outright
  // ("Unknown arguments: content-type"), which is why the first attempt at this
  // seed failed on all 16 keys. KV stores bytes; the Worker's JSON.parse does
  // not care what content type was declared.
  const r = wrangler(['kv', 'key', 'put', p.key, '--namespace-id', NS,
    '--path', tmp, '--remote'], { allowFail: true });
  fs.rmSync(tmp, { force: true });
  if (r.ok) {
    written.push(p.key);
    console.log(`  put     ${p.key.padEnd(24)} ${p.bytes} bytes`);
  } else {
    console.log(`  FAIL    ${p.key}: ${r.out.slice(0, 200)}`);
  }
}

// ------------------------------------------------------------------ VERIFY
// A PUT returning success is not evidence the value is readable. KV is
// eventually consistent, so every key is fetched back and compared against
// what was sent. This is the part that makes the result mean something.
console.log('\n--- READ BACK and compare (this is the actual proof) ---');
let okCount = 0; let badCount = 0; const mismatches = [];

for (const p of payload) {
  // `kv key get` has NO --out flag in this wrangler version; it returns the
  // value on stdout and --text decodes it as utf8. An earlier version used
  // --out, which wrangler rejected, so every key reported "not readable" even
  // though every key had been written successfully - a verifier that failed for
  // its own reasons while reporting a data problem.
  const r = wrangler(['kv', 'key', 'get', p.key, '--namespace-id', NS, '--text', '--remote'],
    { allowFail: true });
  const got = r.ok ? r.out : null;

  if (got === null || got === undefined) {
    badCount++;
    mismatches.push(`${p.key}: not readable back (${r.out.slice(0, 120)})`);
    console.log(`  MISS    ${p.key.padEnd(24)} not readable: ${r.out.slice(0, 100)}`);
  } else if (got === p.raw) {
    okCount++;
    console.log(`  ok      ${p.key.padEnd(24)} identical (${p.hash})`);
  } else {
    // Compare on parsed content, not bytes: formatting differences are not
    // corruption, but a different record count or hash IS.
    let sameShape = false;
    try {
      sameShape = JSON.stringify(JSON.parse(got)) === JSON.stringify(JSON.parse(p.raw));
    } catch { /* unparseable = not same */ }
    if (sameShape) {
      okCount++;
      console.log(`  ok      ${p.key.padEnd(24)} same content (reformatted)`);
    } else {
      badCount++;
      mismatches.push(`${p.key}: readback differs from what was sent`);
      console.log(`  DIFF    ${p.key.padEnd(24)} readback differs  sent=${p.hash} got=${sha(got)}`);
    }
  }
}

console.log('');
if (badCount) {
  console.log(`${okCount} verified, ${badCount} FAILED:`);
  mismatches.forEach((x) => console.log(`    ${x}`));
  console.log('\nThe dashboard will be incomplete. Do not report this as done.');
  process.exitCode = 1;
} else {
  console.log(`all ${okCount} keys uploaded and read back identical.`);
  console.log('KV is eventually consistent, so give it a few seconds before judging the dashboard.');
  console.log(`\nnext: open ${'https://officeos-dashboard.taion16240.workers.dev'} and hard-refresh.`);
  console.log('if numbers are still zero, the read path needs the Worker restarted, not a reseed.');
}
process.exitCode = badCount ? 1 : 0;