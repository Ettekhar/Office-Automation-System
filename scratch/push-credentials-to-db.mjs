import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const envPath = path.resolve(rootDir, '.env');
const saPath = path.resolve(rootDir, 'service-account.json');
const targetDbFile = path.resolve(rootDir, 'data/mailer-credentials.json');

const NS = 'c44955e25a1c4791a89f3f3783213e12';
const CONFIG = 'cloudflare-worker/dashboard-wrangler.toml';

console.log('Reading .env and service-account.json...');
if (!fs.existsSync(envPath)) {
  console.error('.env not found!');
  process.exit(1);
}

const envText = fs.readFileSync(envPath, 'utf8');
const vars = {};
for (const line of envText.split(/\r?\n/)) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) continue;
  const eq = line.indexOf('=');
  if (eq > 0) {
    const k = line.slice(0, eq).trim();
    const v = line.slice(eq + 1).trim();
    vars[k] = v;
  }
}

let serviceAccount = null;
if (fs.existsSync(saPath)) {
  try {
    serviceAccount = JSON.parse(fs.readFileSync(saPath, 'utf8'));
    console.log(`Service Account loaded: ${serviceAccount.client_email}`);
  } catch (err) {
    console.warn('Warning: Could not parse service-account.json:', err.message);
  }
}

const payload = {
  updatedAt: new Date().toISOString(),
  description: 'OfficeOS Mailer & Integration Credentials Database',
  vars,
  serviceAccount,
};

fs.writeFileSync(targetDbFile, JSON.stringify(payload, null, 2), 'utf8');
console.log(`Written to local database: ${targetDbFile} (${Object.keys(vars).length} vars)`);

console.log('Uploading to Cloudflare KV remote namespace ' + NS + '...');
try {
  const out = execSync(
    `npx wrangler kv key put "mailer-credentials" --path "${targetDbFile}" --namespace-id ${NS} --remote --config ${CONFIG}`,
    { cwd: rootDir, encoding: 'utf8' }
  );
  console.log('Wrangler output:', out.trim());
  console.log('Verifying key in Cloudflare KV...');
  const verify = execSync(
    `npx wrangler kv key get "mailer-credentials" --namespace-id ${NS} --remote --config ${CONFIG}`,
    { cwd: rootDir, encoding: 'utf8' }
  );
  const parsedVerify = JSON.parse(verify);
  console.log('Verified from Cloudflare KV! Stored vars count:', Object.keys(parsedVerify.vars || {}).length);
  if (parsedVerify.serviceAccount?.client_email) {
    console.log('Verified Service Account email:', parsedVerify.serviceAccount.client_email);
  }
  console.log('SUCCESS: All credentials pushed to database (local + Cloudflare KV)!');
} catch (e) {
  console.error('Failed to push to Cloudflare KV:', e.message);
  if (e.stdout) console.log('Stdout:', e.stdout);
  if (e.stderr) console.error('Stderr:', e.stderr);
  process.exit(1);
}
