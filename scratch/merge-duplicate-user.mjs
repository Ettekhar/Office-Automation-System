/**
 * Patch: Merge the duplicate Google-login user (da9d7e32 - "Md. Ettekhar Rahman Taion")
 * into the real team-member record (97071bf7 - "Taion") in the remote Cloudflare KV.
 *
 * The OAuth auto-create created a separate user instead of linking to the existing
 * team member. After this merge, logging in with any linked Google account will resolve
 * to the Taion team member who owns 27 daily-review rows.
 */

const NAMESPACE_ID = 'c44955e25a1c4791a89f3f3783213e12';
const ACCOUNT_ID_CMD = 'wrangler kv key';

// IDs
const DUPLICATE_ID = 'da9d7e32-8af3-4295-9201-8c333bd1ce5c';  // "Md. Ettekhar Rahman Taion" - the bad auto-created one
const TARGET_ID = '97071bf7-e6f9-4645-8a1e-6b7829d91ecf';     // "Taion" - the real team member

import { execFileSync } from 'child_process';

function wranglerGet(key) {
  const raw = execFileSync('npx.cmd', [
    'wrangler', 'kv', 'key', 'get', key,
    '--namespace-id', NAMESPACE_ID,
    '--remote',
    '--config', 'cloudflare-worker/dashboard-wrangler.toml'
  ], { encoding: 'utf8', cwd: 'c:/Users/toufi_qicjadj/Downloads/maintenance-mailer', shell: true });
  return JSON.parse(raw);
}

function wranglerPut(key, value) {
  const raw = execFileSync('npx.cmd', [
    'wrangler', 'kv', 'key', 'put', key, JSON.stringify(value),
    '--namespace-id', NAMESPACE_ID,
    '--remote',
    '--config', 'cloudflare-worker/dashboard-wrangler.toml'
  ], { encoding: 'utf8', cwd: 'c:/Users/toufi_qicjadj/Downloads/maintenance-mailer', shell: true });
  return raw.trim();
}

console.log('=== Merging duplicate user in remote KV ===\n');

// 1. Load remote users
const users = wranglerGet('users');
console.log('Total remote users before:', users.length);

const duplicate = users.find(u => u.id === DUPLICATE_ID);
const target = users.find(u => u.id === TARGET_ID);

if (!duplicate) { console.log('Duplicate user not found - already merged?'); process.exit(0); }
if (!target) { console.log('ERROR: Target user not found!'); process.exit(1); }

console.log('\nDuplicate user:', { id: duplicate.id, name: duplicate.name, email: duplicate.email, googleEmail: duplicate.googleEmail, googleSub: duplicate.googleSub });
console.log('Target user:', { id: target.id, name: target.name, email: target.email, googleEmail: target.googleEmail });

// 2. Transfer Google credentials from duplicate to target
const googleSub = duplicate.googleSub || target.googleSub;
const googleEmail = duplicate.googleEmail || target.googleEmail;
const googleName = duplicate.googleName || target.googleName;
const googlePicture = duplicate.googlePicture || target.googlePicture;

// Also capture the razibmarketing email
const razibEmail = (duplicate.email && duplicate.email.includes('razibmarketing')) ? duplicate.email : null;

const updatedUsers = users.map(u => {
  if (u.id === TARGET_ID) {
    return {
      ...u,
      googleSub: googleSub || u.googleSub,
      googleEmail: googleEmail || u.googleEmail,
      googleName: googleName || u.googleName,
      googlePicture: googlePicture || u.googlePicture,
      // Keep both emails if different
      email: u.email || googleEmail,
      // Mark alternate emails for alias lookup
      aliases: [...(u.aliases || []), ...(razibEmail ? [razibEmail] : []), ...(duplicate.email ? [duplicate.email] : [])].filter((v, i, a) => v && a.indexOf(v) === i),
      updatedAt: new Date().toISOString(),
    };
  }
  if (u.id === DUPLICATE_ID) {
    return { ...u, mergedInto: TARGET_ID, active: false };
  }
  return u;
});

const updatedTarget = updatedUsers.find(u => u.id === TARGET_ID);
console.log('\nUpdated target user:', { id: updatedTarget.id, name: updatedTarget.name, email: updatedTarget.email, googleEmail: updatedTarget.googleEmail, googleSub: updatedTarget.googleSub, aliases: updatedTarget.aliases });

// 3. Write updated users to remote KV
console.log('\nWriting updated users to remote KV...');
const putResult = wranglerPut('users', updatedUsers);
console.log('Write result:', putResult);

// 4. Also update daily-review: reassign any rows with duplicate's userId to target
const dailyReview = wranglerGet('daily-review');
console.log('\nTotal daily-review rows before:', dailyReview.length);

const updatedDR = dailyReview.map(r => {
  if (r.userId === DUPLICATE_ID) {
    return { ...r, userId: TARGET_ID, userName: 'Taion', updatedAt: new Date().toISOString() };
  }
  return r;
});

const reassigned = updatedDR.filter((r, i) => dailyReview[i].userId !== r.userId).length;
console.log('Daily-review rows reassigned:', reassigned);

if (reassigned > 0) {
  console.log('Writing updated daily-review to remote KV...');
  const drResult = wranglerPut('daily-review', updatedDR);
  console.log('Write result:', drResult);
}

// 5. Verify
const verifyUsers = wranglerGet('users');
const verifyTarget = verifyUsers.find(u => u.id === TARGET_ID);
console.log('\n=== VERIFICATION ===');
console.log('Target user after merge:', { id: verifyTarget?.id, name: verifyTarget?.name, googleEmail: verifyTarget?.googleEmail, googleSub: verifyTarget?.googleSub });
console.log('Duplicate user (should have mergedInto):', verifyUsers.find(u => u.id === DUPLICATE_ID)?.mergedInto);

const verifyDR = wranglerGet('daily-review');
const taionRows = verifyDR.filter(r => r.userId === TARGET_ID || r.userName === 'Taion');
console.log('Daily-review rows for Taion:', taionRows.length);

console.log('\n✅ Done. Log in again with taion16240@gmail.com to verify.');
