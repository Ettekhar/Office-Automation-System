/**
 * fix-users-kv.mjs
 * 
 * Re-uploads the users array to remote KV as proper JSON (quoted keys/values).
 * Uses --path to avoid PowerShell quote-stripping issues.
 * 
 * Applies the same merge as the previous script:
 *   - da9d7e32 (Md. Ettekhar Rahman Taion) → mergedInto 97071bf7 (Taion), active: false
 *   - 97071bf7 (Taion) gets googleSub + googleEmail from Razibmarketing account
 */

import { execFileSync } from 'child_process';
import { writeFileSync, readFileSync } from 'fs';
import { join } from 'path';

const NAMESPACE_ID = 'c44955e25a1c4791a89f3f3783213e12';
const CWD = 'c:\\Users\\toufi_qicjadj\\Downloads\\maintenance-mailer';

// Read local users data (source of truth for non-Google fields)
const localUsers = JSON.parse(readFileSync(join(CWD, 'data', 'users.json'), 'utf8'));
console.log('Local users count:', localUsers.length);
localUsers.forEach(u => console.log(' ', u.id, u.name, u.role));

// Apply the merge on top of local data
const DUPLICATE_ID  = 'da9d7e32-8af3-4295-9201-8c333bd1ce5c';
const TARGET_ID     = '97071bf7-e6f9-4645-8a1e-6b7829d91ecf';

// Google credentials from the Razibmarketing account that logged in
const GOOGLE_SUB    = '102733219218167812033';
const GOOGLE_EMAIL  = 'Taion@razibmarketing.net';
const GOOGLE_NAME   = 'Md. Ettekhar Rahman Taion';
const GOOGLE_PIC    = 'https://lh3.googleusercontent.com/a/ACg8ocJjFs-Mql3OI3m9OF4YgdQi4eEcQNmkLVJXfZincv6BHa1K8dNR=s96-c';

// Check if duplicate already exists in local
const hasDuplicate = localUsers.find(u => u.id === DUPLICATE_ID);
const hasTarget    = localUsers.find(u => u.id === TARGET_ID);

let finalUsers;

if (!hasDuplicate && hasTarget) {
  // Local data is clean - just add Google credentials to Taion and upload
  console.log('\nLocal data is clean - applying Google credentials to Taion only');
  finalUsers = localUsers.map(u => {
    if (u.id === TARGET_ID) {
      return {
        ...u,
        googleSub: GOOGLE_SUB,
        googleEmail: GOOGLE_EMAIL,
        googleName: GOOGLE_NAME,
        googlePicture: GOOGLE_PIC,
        aliases: [GOOGLE_EMAIL],
        updatedAt: new Date().toISOString(),
      };
    }
    return u;
  });
} else if (hasDuplicate) {
  // Local has both - apply full merge
  console.log('\nApplying merge in local data');
  finalUsers = localUsers.map(u => {
    if (u.id === TARGET_ID) {
      return {
        ...u,
        googleSub: GOOGLE_SUB,
        googleEmail: GOOGLE_EMAIL,
        googleName: GOOGLE_NAME,
        googlePicture: GOOGLE_PIC,
        aliases: [GOOGLE_EMAIL],
        updatedAt: new Date().toISOString(),
      };
    }
    if (u.id === DUPLICATE_ID) {
      return { ...u, mergedInto: TARGET_ID, active: false };
    }
    return u;
  });
} else {
  // Target not found - just add the duplicate record as merged
  console.log('\nAdding merged duplicate record');
  finalUsers = [
    ...localUsers.map(u => {
      if (u.id === TARGET_ID) {
        return { ...u, googleSub: GOOGLE_SUB, googleEmail: GOOGLE_EMAIL, googleName: GOOGLE_NAME, googlePicture: GOOGLE_PIC, aliases: [GOOGLE_EMAIL], updatedAt: new Date().toISOString() };
      }
      return u;
    }),
    {
      id: DUPLICATE_ID,
      name: GOOGLE_NAME,
      email: GOOGLE_EMAIL,
      googleEmail: GOOGLE_EMAIL,
      googleSub: GOOGLE_SUB,
      googleName: GOOGLE_NAME,
      role: 'user',
      active: false,
      mergedInto: TARGET_ID,
      createdAt: '2026-10-03T20:14:45.320Z',
      updatedAt: new Date().toISOString(),
    }
  ];
}

// Verify Taion user
const taion = finalUsers.find(u => u.id === TARGET_ID);
console.log('\nTaion record after merge:', JSON.stringify(taion, null, 2));
console.log('\nTotal users to upload:', finalUsers.length);

// Write to a temp file to avoid PowerShell quote-stripping
const tempFile = join(CWD, 'scratch', 'users-upload.json');
const jsonStr = JSON.stringify(finalUsers, null, 2);
writeFileSync(tempFile, jsonStr, 'utf8');
console.log('\nWrote', Buffer.byteLength(jsonStr), 'bytes to', tempFile);

// Verify it parses back correctly
const verify = JSON.parse(readFileSync(tempFile, 'utf8'));
console.log('Verified JSON parse: OK,', verify.length, 'users');

// Upload via --path (no shell escaping issues)
console.log('\nUploading to remote KV via --path...');
const result = execFileSync('npx.cmd', [
  'wrangler', 'kv', 'key', 'put', 'users',
  '--path', tempFile,
  '--namespace-id', NAMESPACE_ID,
  '--remote',
  '--config', 'cloudflare-worker/dashboard-wrangler.toml',
], { encoding: 'utf8', cwd: CWD, shell: true });

console.log('Upload result:', result);

// Also clear and re-upload auth-sessions as clean []
const sessionsFile = join(CWD, 'scratch', 'sessions-empty.json');
writeFileSync(sessionsFile, '[]', 'utf8');
const sessResult = execFileSync('npx.cmd', [
  'wrangler', 'kv', 'key', 'put', 'auth-sessions',
  '--path', sessionsFile,
  '--namespace-id', NAMESPACE_ID,
  '--remote',
  '--config', 'cloudflare-worker/dashboard-wrangler.toml',
], { encoding: 'utf8', cwd: CWD, shell: true });
console.log('Sessions cleared:', sessResult.includes('Writing') ? 'OK' : sessResult);

console.log('\n✅ Done! Users KV now contains valid JSON.');
console.log('Please clear browser cookies for officeos-dashboard.taion16240.workers.dev and log in again.');
