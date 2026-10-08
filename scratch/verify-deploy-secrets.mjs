/**
 * verify-deploy-secrets.mjs
 *
 * Checks that every Cloudflare Worker can actually authenticate, WITHOUT ever
 * printing or transmitting a credential.
 *
 * THE RULE THIS ENFORCES
 *
 *   git      never carries a credential
 *   deploy   takes credentials from Cloudflare's secret store
 *
 * Deploy already works that way - `wrangler deploy` sends only the config, and
 * secrets set with `wrangler secret put` live server-side and are never in the
 * repo. This script exists because that property is invisible: nothing fails if
 * it breaks, the Worker just starts returning 401 to everyone.
 *
 * FOUR THINGS ARE CHECKED
 *
 *   1. No credential is embedded in any wrangler toml. A literal token in a
 *      config is the one way a secret gets into git, and it is easy to do by
 *      accident while debugging.
 *   2. Every required secret is actually SET on the Worker, verified against
 *      Cloudflare by NAME only.
 *   3. The deploy does not depend on a credential being in .env. Wrangler here
 *      authenticates with the OAuth login, so a repo clone needs no token.
 *   4. The gate still fails closed: a Worker with no ADMIN_TOKEN refuses
 *      everything rather than opening.
 *
 * NOTHING SENSITIVE IS READ, PRINTED, OR SENT. Presence is checked by name;
 * liveness is checked by calling the health endpoint.
 *
 * Run:  npm run test:deploy:secrets
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let pass = 0; let fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`  ok       ${m}`); } else { fail++; console.log(`  FAIL     ${m}`); } };

const CONFIGS = [
  {
    toml: 'cloudflare-worker/dashboard-wrangler.toml', name: 'officeos-dashboard',
    required: ['ADMIN_TOKEN', 'GOOGLE_SERVICE_ACCOUNT_JSON'],
    health: 'https://officeos-dashboard.taion16240.workers.dev/__health',
    protected: 'https://officeos-dashboard.taion16240.workers.dev/api/accounts',
  },
  {
    toml: 'cloudflare-worker/mailer-wrangler.toml', name: 'officeos-mailer',
    required: ['ADMIN_TOKEN', 'RELAY_TOKEN', 'GOOGLE_SERVICE_ACCOUNT_JSON'],
    health: 'https://officeos-mailer.taion16240.workers.dev/api/health',
    // A real admin-gated route on the mailer, verified to return 401 without a
    // token. Read from mailer-worker.js rather than guessed - a guessed path
    // returns 404 and makes a healthy gate look broken, which is exactly what
    // happened the first time.
    protected: 'https://officeos-mailer.taion16240.workers.dev/api/runs',
  },
];

// Run wrangler's JS entry point with this same node rather than going through
// npx. Two problems with npx: it is a .cmd on Windows, so spawnSync needs
// shell:true, and shell:true plus an args array is the interpolation hazard
// Node flags as DEP0190. No shell is needed here at all.
const WRANGLER = path.join(ROOT, 'node_modules', 'wrangler', 'bin', 'wrangler.js');

function listSecrets(toml) {
  try {
    if (!fs.existsSync(WRANGLER)) throw new Error('wrangler not installed locally');
    const out = execFileSync(process.execPath, [WRANGLER, 'secret', 'list', '--config', toml],
      { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 180000 });
    // wrangler prints JSON. Parsing it properly matters: a loose /\b[A-Z_]+\b/
    // over the text also picks up "type" and "secret_text", and an over-strict
    // one finds nothing and then reports every secret as unset while the Worker
    // is in fact correctly configured.
    const start = out.indexOf('[');
    if (start < 0) throw new Error('no JSON in wrangler output');
    return new Set(JSON.parse(out.slice(start)).map((s) => s?.name).filter(Boolean));
  } catch (e) {
    return { error: String(e.message).slice(0, 70) };
  }
}

console.log('\n=== deploy credential audit ===\n');
console.log('  (secret VALUES are never read, printed, or transmitted)\n');

// ---------------------------------------------- 1. no credential in a config
console.log('--- wrangler configs must carry no credential ---');
for (const c of CONFIGS) {
  const p = path.join(ROOT, c.toml);
  if (!fs.existsSync(p)) { ok(false, `${c.toml} exists`); continue; }
  const raw = fs.readFileSync(p, 'utf8');
  const problems = [];
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(raw)) problems.push('a PEM private key');
  if (/"type"\s*:\s*"service_account"/.test(raw)) problems.push('a service-account JSON');
  if (/GOOGLE_SERVICE_ACCOUNT_JSON\s*=\s*"/.test(raw)) problems.push('GOOGLE_SERVICE_ACCOUNT_JSON literal');
  if (/(^|\n)\s*(ADMIN_TOKEN|RELAY_TOKEN|DASHBOARD_ADMIN_TOKEN)\s*=\s*"/.test(raw)) problems.push('a token literal');
  ok(problems.length === 0, `${c.toml} carries no credential${problems.length ? ` - found ${problems.join(', ')}` : ''}`);
}

// --------------------------------------------- 2. secrets actually set
console.log('\n--- required secrets are SET on each Worker (names only) ---');
for (const c of CONFIGS) {
  const names = listSecrets(c.toml);
  if (!(names instanceof Set)) {
    // Could not check. Never report this as "the secret is missing" - that
    // turns a broken call into a false alarm about the deploy.
    ok(false, `${c.name}: could not verify secrets (${names.error})`);
    continue;
  }
  for (const req of c.required) ok(names.has(req), `${c.name}: ${req} is set`);
}

// ---------------------------- 3. deploy needs no credential from the repo
console.log('\n--- deploy does not read a credential from .env ---');
const envText = fs.existsSync(path.join(ROOT, '.env'))
  ? fs.readFileSync(path.join(ROOT, '.env'), 'utf8') : '';
const hasCfToken = /^CLOUDFLARE_API_TOKEN=/m.test(envText);
ok(!hasCfToken,
  hasCfToken
    ? 'CLOUDFLARE_API_TOKEN is in .env - deploy uses OAuth, so this token is unnecessary exposure'
    : 'no CLOUDFLARE_API_TOKEN in .env; wrangler authenticates with the OAuth login');
ok(!/^CLOUDFLARE_ACCOUNT_ID=/m.test(envText),
  'no CLOUDFLARE_ACCOUNT_ID in .env (not needed; the account comes from the login)');

// -------------------------------------------------- 4. live + fails closed
console.log('\n--- live behaviour ---');
for (const c of CONFIGS) {
  let healthStatus = 0;
  try { healthStatus = (await fetch(c.health)).status; } catch { healthStatus = 0; }
  ok(healthStatus === 200, `${c.name} health answers 200 (got ${healthStatus})`);

  let status = 0;
  try { status = (await fetch(c.protected)).status; } catch { status = 0; }
  ok(status === 401, `${c.name} refuses an unauthenticated caller (got ${status}, expected 401)`);
}

console.log('');
if (fail) {
  console.log(`${pass} passed, ${fail} FAILED - a deploy would not work correctly\n`);
  process.exit(1);
}
console.log(`${pass} passed - deploys take credentials from the secret store, and git carries none\n`);
// Set exitCode and return rather than calling process.exit(): wrangler children
// can still be closing, and process.exit() tears the process down with their
// handles live, which on Windows crashes AFTER the summary has printed.
// The event loop drains first, and the real exit code survives.
process.exitCode = 0;