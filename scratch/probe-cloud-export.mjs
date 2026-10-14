/**
 * probe-cloud-export.mjs — READ-ONLY: fetch the deployed dashboard worker's
 * cloud-sync export (KV-backed) and diff it against the local .env + local
 * data/mailer-credentials.json — by KEY NAME ONLY. No values are printed.
 * The cloud bundle (which may hold the OLD credentials) is saved to a PRIVATE
 * file under AppData\Local\Temp\opencode\ (never in the repo, never committed).
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

const root = process.cwd();
const URL = (
  process.env.DASHBOARD_WORKER_URL ||
  process.env.CLOUDFLARE_WORKER_URL ||
  'https://officeos-dashboard.taion16240.workers.dev'
).replace(/\/+$/, '');
const endpoint = `${URL}/api/cloud-sync/export`;

const tokenCandidates = [
  { name: 'DASHBOARD_ADMIN_TOKEN', value: process.env.DASHBOARD_ADMIN_TOKEN || '' },
  { name: 'CLOUDFLARE_WORKER_TOKEN', value: process.env.CLOUDFLARE_WORKER_TOKEN || '' },
  { name: 'ADMIN_TOKEN', value: process.env.ADMIN_TOKEN || '' },
];
try {
  const creds = JSON.parse(fs.readFileSync(path.join(root, 'data', 'mailer-credentials.json'), 'utf8'));
  const vars = creds.vars || {};
  tokenCandidates.push({
    name: 'dbToken(data/mailer-credentials)',
    value: vars.DASHBOARD_ADMIN_TOKEN || vars.ADMIN_TOKEN || '',
  });
} catch {}

console.log(`endpoint: ${endpoint}`);

let payload = null;
let authed = '';
for (const t of tokenCandidates) {
  if (!t.value) continue;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(endpoint, {
      headers: { Accept: 'application/json', Authorization: `Bearer ${t.value}` },
      signal: controller.signal,
    });
    if (res.ok) {
      payload = await res.json();
      authed = t.name;
      console.log(`  auth OK via ${t.name}`);
      break;
    }
    console.log(`  ${t.name}: HTTP ${res.status}`);
  } catch (e) {
    console.log(`  ${t.name}: ${e.name === 'AbortError' ? 'timeout' : e.message}`);
  } finally {
    clearTimeout(timer);
  }
}

if (!payload || !payload.ok || !payload.data) {
  console.log('\nno cloud bundle available (not authenticated or no data)');
  process.exitCode = 0;
} else {
  const cloud = payload.data;
  console.log(`\ncloud bundle OK: exportedAt=${payload.exportedAt} keys=${JSON.stringify(payload.keys)}`);

  // local current vars: .env (primary) + data/mailer-credentials.json
  const envVars = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined || v === null || v === '') continue;
    if (/^[A-Z][A-Z0-9_]{2,}$/.test(k)) envVars[k] = v;
  }
  let dataVars = {};
  try {
    dataVars = JSON.parse(fs.readFileSync(path.join(root, 'data', 'mailer-credentials.json'), 'utf8')).vars || {};
  } catch {}

  const cloudVars = cloud['mailer-credentials']?.vars || {};

  function diff(cVars, lVars, label) {
    const keys = new Set([...Object.keys(cVars || {}), ...Object.keys(lVars || {})]);
    const same = [], differ = [], cloudOnly = [], localOnly = [];
    for (const k of [...keys].sort()) {
      const c = cVars?.[k];
      const l = lVars?.[k];
      const cHas = c !== undefined && c !== null && c !== '';
      const lHas = l !== undefined && l !== null && l !== '';
      if (!cHas && !lHas) continue;
      if (cHas && !lHas) cloudOnly.push(k);
      else if (!cHas && lHas) localOnly.push(k);
      else if (String(c) === String(l)) same.push(k);
      else differ.push(k);
    }
    console.log(`\n--- ${label} ---`);
    console.log(`  SAME (${same.length}):  ${same.join(', ') || '—'}`);
    console.log(`  DIFFER (${differ.length}): ${differ.join(', ') || '—'}`);
    console.log(`  cloud-only (${cloudOnly.length}): ${cloudOnly.join(', ') || '—'}`);
    console.log(`  local-only (${localOnly.length}): ${localOnly.join(', ') || '—'}`);
  }

  diff(cloudVars, envVars, 'cloud vars vs local .env');
  diff(cloudVars, dataVars, 'cloud vars vs local data/mailer-credentials.json');

  // Service account: compare identity only (client_email + private_key sha256 prefix)
  const cloudSA = cloud['mailer-credentials']?.serviceAccount;
  let localSA = null;
  try { localSA = JSON.parse(fs.readFileSync(path.join(root, 'service-account.json'), 'utf8')); } catch {}
  console.log('\n--- service account (identity only) ---');
  const emailOf = (sa) => (sa && typeof sa === 'object' ? sa.client_email : undefined);
  const keyHash = (sa) => {
    const pk = sa && typeof sa === 'object' ? sa.private_key : sa && typeof sa === 'string' ? sa : undefined;
    if (!pk) return '(none)';
    return 'sha256:' + crypto.createHash('sha256').update(String(pk)).digest('hex').slice(0, 16);
  };
  console.log(`  cloud:   email=${emailOf(cloudSA) || '—'} keyHash=${keyHash(cloudSA)}`);
  console.log(`  local:   email=${emailOf(localSA) || '—'} keyHash=${keyHash(localSA)}`);
  console.log(`  matched: ${keyHash(cloudSA) === keyHash(localSA) && keyHash(cloudSA) !== '(none)'}`);

  // Save the full cloud bundle privately for the user's own recovery use
  const outDir = path.join(os.homedir(), 'AppData', 'Local', 'Temp', 'opencode');
  fs.mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = path.join(outDir, `cloud-bundle-export-${stamp}.json`);
  fs.writeFileSync(dest, JSON.stringify(payload, null, 2));
  console.log(`\nsaved full cloud bundle (private, not in repo): ${dest}`);
  console.log(`(bundle file size: ${fs.statSync(dest).size} bytes)`);
}