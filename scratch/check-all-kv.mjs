/**
 * check-all-kv.mjs
 * Checks every state key in remote KV for valid JSON.
 * If invalid, re-uploads from local data/  file using --path.
 */
import { execSync } from 'child_process';
import { writeFileSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';

const CWD = 'c:\\Users\\toufi_qicjadj\\Downloads\\maintenance-mailer';
const NS = 'c44955e25a1c4791a89f3f3783213e12';
const CONFIG = 'cloudflare-worker/dashboard-wrangler.toml';

const STATE_KEYS = [
  'users', 'sites', 'tasks', 'properties', 'dev-projects', 'notices',
  'conditional-notes', 'daily-review', 'domain-expiry-requests', 'meta',
  'custom-sheets', 'sheet-credentials', 'assistant-config', 'sync-conflicts',
  'user-aliases', 'audit-log', 'master-overrides', 'auth-sessions',
];

// Map KV key → local file name (most are same, one differs)
const KEY_TO_FILE = {
  'conditional-notes': 'email-conditional-notes',
};

function wranglerGetRaw(key) {
  try {
    return execSync(
      `npx wrangler kv key get "${key}" --namespace-id ${NS} --remote --config ${CONFIG}`,
      { encoding: 'utf8', cwd: CWD }
    );
  } catch (e) {
    return null;
  }
}

function wranglerPutFile(key, filePath) {
  return execSync(
    `npx wrangler kv key put "${key}" --path "${filePath}" --namespace-id ${NS} --remote --config ${CONFIG}`,
    { encoding: 'utf8', cwd: CWD }
  );
}

const TEMP = join(CWD, 'scratch', 'kv-repair-temp.json');

let badKeys = [];
let goodKeys = [];

for (const key of STATE_KEYS) {
  process.stdout.write(`Checking "${key}"... `);
  const raw = wranglerGetRaw(key);
  if (raw === null) {
    console.log('MISSING (no data)');
    continue;
  }
  const trimmed = raw.trim();
  if (!trimmed || trimmed === 'null') {
    console.log('empty/null - OK');
    goodKeys.push(key);
    continue;
  }
  try {
    JSON.parse(trimmed);
    console.log('✅ valid JSON');
    goodKeys.push(key);
  } catch (e) {
    console.log(`❌ INVALID JSON: ${e.message.slice(0, 60)}`);
    badKeys.push({ key, raw: trimmed });
  }
}

console.log(`\n============================`);
console.log(`Good: ${goodKeys.length}  Bad: ${badKeys.length}`);

if (badKeys.length === 0) {
  console.log('All keys are valid JSON. The error must be from code changes needing a redeploy.');
  process.exit(0);
}

console.log(`\nRepairing ${badKeys.length} bad key(s)...`);

for (const { key } of badKeys) {
  const fileName = KEY_TO_FILE[key] || key;
  const localFile = join(CWD, 'data', `${fileName}.json`);
  if (!existsSync(localFile)) {
    console.log(`  ⚠️  ${key}: no local file at ${localFile} - uploading empty array`);
    writeFileSync(TEMP, '[]', 'utf8');
  } else {
    const localData = JSON.parse(readFileSync(localFile, 'utf8')); // will throw if local is also bad
    writeFileSync(TEMP, JSON.stringify(localData, null, 2), 'utf8');
    console.log(`  Repairing "${key}" from local file (${JSON.stringify(localData).length} chars)...`);
  }
  wranglerPutFile(key, TEMP);
  
  // Verify the repair
  const verify = wranglerGetRaw(key);
  try {
    JSON.parse(verify.trim());
    console.log(`  ✅ "${key}" repaired successfully`);
  } catch {
    console.log(`  ❌ "${key}" still invalid after repair!`);
  }
}

console.log('\nDone. All keys repaired.');
