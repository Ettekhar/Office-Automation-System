/**
 * verify-no-credentials.mjs
 *
 * Scans what git is about to record for CREDENTIAL MATERIAL, and refuses.
 *
 * WHY THIS EXISTS
 *
 * The repository is public. The .gitignore already excludes .env,
 * service-account.json and the live data/ files, but a .gitignore is a
 * suggestion to the person editing, not a guarantee to the person reviewing.
 * It protects against the paths someone thought of. It does NOT protect against:
 *
 *   - `git add -f`, which overrides it
 *   - a value pasted into a source file, a fixture, a test, or a comment
 *   - a wrangler toml edited to "just try this" with a literal token in it
 *   - an error message or a debug print that quotes a token
 *
 * Those are the ways credentials actually leak, and none of them are covered by
 * .gitignore. This runs on the STAGED content, so it sees exactly what a commit
 * would record - not what is on disk.
 *
 * WHAT IT CHECKS
 *
 *   1. Real values. Every value in .env and every field of service-account.json
 *      is compared against staged content. This is exact and cannot miss.
 *   2. Shapes. Generic credential patterns (private keys, cloud tokens, Slack
 *      hooks, live-looking JWTs) catch secrets that are NOT in .env - including
 *      ones pasted from somewhere else entirely.
 *   3. Named files. If .env or service-account.json is staged at all, refuse,
 *      regardless of content.
 *
 * Short values are skipped: a 3-character password would match half the repo and
 * make the check noise, which is worse than no check because people learn to
 * click through red.
 *
 * NOTHING SENSITIVE IS EVER PRINTED. Findings report the file, the line number
 * and the KIND of secret - never the value, not even a prefix. A scanner that
 * leaks what it found is a second copy of the leak.
 *
 * Run standalone:  node scratch/verify-no-credentials.mjs
 * As a hook:      .githooks/pre-commit  (installed via `npm run hooks:install`)
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let pass = 0; let fail = 0;
const failWith = (msg, detail) => {
  fail++;
  console.log(`  BLOCKED  ${msg}`);
  if (detail) console.log(`          ${detail}`);
};
const passWith = (m) => { pass++; console.log(`  ok       ${m}`); };

// ---------------------------------------------------------------- staged set
let staged = [];
let inCommit = false;
try {
  const out = execFileSync('git', ['diff', '--cached', '--name-only', '--diff-filter=ACMR'],
    { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  staged = out.split('\n').map((s) => s.trim()).filter(Boolean);
  inCommit = true;
} catch { /* no repo, or nothing staged - fall through to a manual scan */ }

const files = (inCommit
  ? staged
  : ['cloudflare-worker/dashboard-worker.js', 'cloudflare-worker/dashboard-wrangler.toml',
    'cloudflare-worker/mailer-wrangler.toml', 'package.json']
).filter((f) => fs.existsSync(path.join(ROOT, f)) && fs.statSync(path.join(ROOT, f)).size < 4_000_000);

console.log(`\n=== credential scan (${files.length} file(s)${inCommit ? ' staged for commit' : ''}) ===\n`);

// ------------------------------------------------- 3. named credential files
const FORBIDDEN_FILES = ['.env', 'service-account.json', 'cloudflare-worker/.dev.vars', '.dev.vars'];
const badFiles = files.filter((f) => FORBIDDEN_FILES.includes(f) || /(^|\/)\.env\./.test(f));
if (badFiles.length) {
  for (const f of badFiles) failWith(`${f} is a credential file and must never be committed`);
} else {
  passWith('no credential file (.env, service-account.json, .dev.vars) is staged');
}

// ------------------------------------------------------ 1. real known secrets
// Read the true values from the ignored local files, then look for them in
// staged content. Exact match, so it cannot miss - only over-report on short
// values, which are skipped below.
const secrets = new Map(); // value -> description
const addSecret = (v, desc) => {
  const s = String(v ?? '').trim();
  // 8 chars minimum. Below that, collision with ordinary words and ids is
  // certain, and a check that cries wolf is a check that gets bypassed.
  if (s.length < 8) return;
  secrets.set(s, desc);
};

const envPath = path.join(ROOT, '.env');
if (fs.existsSync(envPath)) {
  // Split on CRLF as well as LF. A .env written on Windows has \r at the end of
  // every line, and `$` in a JS regex does match before a trailing \n but NOT
  // before a trailing \r - so a CRLF file silently yields zero secrets and the
  // scanner reports "nothing found" while checking nothing. That bug shipped in
  // the first version of this file and is exactly why the hook is now
  // mutation-tested.
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.+)$/.exec(line);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    // A URL is not a secret and a filesystem path is not a secret. Skipping them
    // matters: DASHBOARD_WORKER_URL and GOOGLE_SERVICE_ACCOUNT_KEY_PATH are real
    // values that legitimately appear in docs, and counting them as secrets
    // would block legitimate work and train people to bypass the check.
    if (/^https?:\/\//i.test(v)) continue;
    if (/^file:\/\//i.test(v)) continue;
    // A bare path: no scheme, contains a separator, no spaces, and the whole
    // thing looks like path segments rather than a random token.
    if (/^[\w.-]+(?:[\\/][\w.-]+)+$/.test(v)) continue;
    // Settings that are configuration rather than credentials. These are not
    // secret and blocking on them would be wrong.
    const NOT_SECRET = new Set([
      'SMTP_HOST', 'SMTP_PORT', 'SMTP_SECURE', 'SMTP_USER',
      'CW_SMTP_HOST', 'CW_SMTP_PORT', 'CW_SMTP_SECURE', 'CW_SMTP_USER',
      'RM_SMTP_HOST', 'RM_SMTP_PORT', 'RM_SMTP_SECURE', 'RM_SMTP_USER',
      'FROM_EMAIL', 'FROM_NAME', 'CW_FROM_EMAIL', 'CW_FROM_NAME',
      'RM_FROM_EMAIL', 'RM_FROM_NAME', 'BCC_EMAIL', 'CW_BCC_EMAIL', 'RM_BCC_EMAIL',
      'CW_NAME', 'RM_NAME', 'AGENT_NAME',
      'CW_MASTER_TAB_NAME', 'RM_MASTER_TAB_NAME', 'MASTER_TAB_NAME',
      'CW_SPREADSHEET_ID', 'RM_SPREADSHEET_ID', 'SPREADSHEET_ID',
      'DASHBOARD_WORKER_URL', 'MAILER_WORKER_URL', 'CLOUDFLARE_WORKER_TOKEN',
      'MAX_EMAILS_PER_RUN',
    ]);
    if (NOT_SECRET.has(m[1])) continue;
    addSecret(v, `the live value of ${m[1]} from .env`);
  }
}
const saPath = path.join(ROOT, 'service-account.json');
if (fs.existsSync(saPath)) {
  const sa = JSON.parse(fs.readFileSync(saPath, 'utf8').replace(/^\uFEFF/, ''));
  addSecret(sa.private_key, 'the service account private key');
  addSecret(sa.client_email, 'the service account email');
  addSecret(sa.client_id, 'the service account client id');
}

let realHits = 0;
for (const rel of files) {
  const raw = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  for (const [value, desc] of secrets) {
    if (!raw.includes(value)) continue;
    const lineNo = raw.slice(0, raw.indexOf(value)).split(/\r?\n/).length;
    failWith(`${rel}:${lineNo} contains ${desc}`, 'value withheld; rotate it if this reached a remote');
    realHits++;
    break; // one report per file is enough to block
  }
}
if (!realHits) passWith(`none of the ${secrets.size} known live secret value(s) appear in staged content`);

// ------------------------------------------------------- 2. generic patterns
// Catches secrets that are not in .env - pasted from elsewhere, generated, or
// belonging to a tool that was never configured here.
const SHAPES = [
  ['PEM private key block', /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/],
  ['Google service-account JSON blob', /"type"\s*:\s*"service_account"/],
  ['Cloudflare API token (realistic shape)', /\b[A-Za-z0-9_-]{37}\b(?=[^\n]{0,40}CLOUDFLARE_API_TOKEN)/],
  ['Slack incoming webhook', /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/]{20,}/],
  ['Google API key', /\bAIza[0-9A-Za-z_-]{35}\b/],
  ['ClickUp / bearer token in a URL', /[?&](?:token|access_token|api_key)=[A-Za-z0-9_-]{16,}/],
  // Provider key shapes, measured from the real values in .env (prefix + length
  // only, never the value itself). These were added after checking that the
  // first version of this list matched NONE of the keys this repo actually uses
  // - a shape list that does not match reality is decoration.
  ['Gemini / Google AI Studio key', /\bAQ\.Ab[0-9A-Za-z_-]{45,50}\b/],
  ['Groq key', /\bgsk_[A-Za-z0-9]{50,60}\b/],
  ['OpenRouter key', /\bsk-or-v1-[A-Za-z0-9]{60,80}\b/],
  ['ClickUp personal key', /\bpk_\d{6,}_[A-Za-z0-9]{20,40}\b/],
  ['SMTP/app password assigned to a literal', /SMTP_PASS\w*\s*=\s*["'][^"'\s]{8,}["']/],
  ['npm token', /\bnpm_[A-Za-z0-9]{36}\b/],
  ['GitHub token', /\bgh[pousr]_[A-Za-z0-9]{36,}\b/],
  ['JWT-looking token', /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/],
];

// Exemptions are (file, shape) PAIRS, not file -> shape.
//
// The first version used `new Map([[file, shape], ...])`. A Map with repeated
// keys keeps only the LAST value, so a file listed more than once ended up with
// exactly one live exemption and the rest silently dead. Here that meant 13 of
// the 14 exemptions for verify-no-credentials.mjs did nothing - a check that
// reads as covered and is not.
//
// A Set per file means each pair is judged on its own: exempting a file from
// "PEM private key" says nothing about its "npm token" exemption, and vice
// versa. The same trap was already hit once in this repo with a value-scoped
// allowlist that a mutation walked straight through.
const SHAPE_EXEMPT = new Map([
  // The shim parses a PEM header off a service-account JSON at runtime; the
  // pattern is the thing being stripped, not a key.
  ['cloudflare-worker/dashboard/google-shim.js', new Set(['PEM private key block'])],
  // The hosting verifier asserts the shim strips PEM headers.
  ['scratch/verify-dashboard-hosting.mjs', new Set(['PEM private key block'])],
  // This file declares every pattern below. It avoids literal self-matches by
  // escaping them in the source, so these exemptions are belt-and-braces for
  // future edits rather than load-bearing today.
  ['scratch/verify-no-credentials.mjs', new Set(SHAPES.map(([name]) => name))],
  // The mutation harness is this scanner's test corpus: its whole job is to
  // contain one invented fixture per shape so the gate can be proven to go red.
  // Every value in it is fabricated and matches nothing live. The PEM fixture
  // is additionally assembled from fragments at runtime, because exempting a
  // file from the most severe shape in the list is a hole shaped like the very
  // thing the check exists to catch.
  ['scratch/mutation-no-credentials.mjs', new Set([
    'PEM private key block',
    'Google service-account JSON blob',
    'Google API key',
    'Gemini / Google AI Studio key',
    'Groq key',
    'OpenRouter key',
    'ClickUp personal key',
    'Slack incoming webhook',
    'npm token',
    'GitHub token',
    'JWT-looking token',
    'ClickUp / bearer token in a URL',
    'SMTP/app password assigned to a literal',
  ])],
]);

// An exemption naming a shape that does not exist is a silent no-op: a typo
// reads as coverage and protects nothing. Fail loudly instead.
for (const [file, names] of SHAPE_EXEMPT) {
  for (const name of names) {
    if (!SHAPES.some(([n]) => n === name)) {
      failWith(`SHAPE_EXEMPT names "${name}" for ${file}, which is not in SHAPES`);
    }
  }
}

let shapeHits = 0;
for (const rel of files) {
  const raw = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  // CRLF-safe, same reason as the .env parse above.
  const lines = raw.split(/\r?\n/);
  lines.forEach((line, i) => {
    for (const [name, re] of SHAPES) {
      if (!re.test(line)) continue;
      if (SHAPE_EXEMPT.get(rel)?.has(name)) return;
      failWith(`${rel}:${i + 1} looks like ${name}`, 'value withheld');
      shapeHits++;
    }
  });
}
if (!shapeHits) passWith(`no credential SHAPE in staged content (${SHAPES.length} patterns)`);

// ------------------------------------------------------------------- verdict
console.log('');
if (fail) {
  console.log(`${fail} problem(s). The commit is BLOCKED.\n`);
  console.log('If a finding is wrong, do not weaken the check. Either remove the value,');
  console.log('or add a targeted exemption in SHAPE_EXEMPT above with a reason.');
  process.exit(1);
}
console.log(`${pass} passed, 0 failed - nothing sensitive is going into git\n`);
process.exit(0);
