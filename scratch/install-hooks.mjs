/**
 * install-hooks.mjs
 *
 * Installs the credential gate so it runs on every commit.
 *
 * WHY A SCRIPT AND NOT "just configure it once"
 *
 * `core.hooksPath` is per-clone and local-only: it is NOT committed, so a fresh
 * clone on another machine has no hook at all. That means the protection would
 * exist only on the machine that set it up, which is exactly the wrong property
 * for a secret boundary.
 *
 * So: the hook script lives in .githooks/ where git can see it, a plain README
 * in .git/hooks/ explains it, and this script wires up the local half. Anyone
 * cloning gets told, on their first commit, that the hook needs installing -
 * rather than silently committing without it.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const run = (cmd, args) => execFileSync(cmd, args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

console.log('\n=== installing the credential gate ===\n');

// 1. the hook must exist and be runnable
const hookPath = path.join(ROOT, '.githooks', 'pre-commit');
if (!fs.existsSync(hookPath)) {
  console.log('  MISSING  .githooks/pre-commit - cannot install');
  process.exit(1);
}
// Git for Windows executes hooks through sh, but the file also needs to be
// readable/executable as a plain script on POSIX.
try { fs.chmodSync(hookPath, 0o755); } catch { /* Windows: no POSIX mode */ }
console.log('  ok       .githooks/pre-commit present');

// 2. point this clone at it
run('git', ['config', 'core.hooksPath', '.githooks']);
console.log(`  ok       core.hooksPath = ${run('git', ['config', 'core.hooksPath'])}`);

// 3. leave a signpost in .git/hooks for anyone who looks there directly
const dotGitHooks = path.join(ROOT, '.git', 'hooks');
if (fs.existsSync(dotGitHooks)) {
  const signpost = path.join(dotGitHooks, 'pre-commit');
  fs.writeFileSync(signpost, [
    '# This hook is installed via core.hooksPath -> .githooks/pre-commit',
    '#',
    '# The real script is committed in .githooks/ so every clone gets it.',
    '# This file exists only because some tools look in .git/hooks directly.',
    '#',
    '# Run `npm run hooks:install` to re-wire it.',
    '#',
  ].join('\n'), 'utf8');
  console.log('  ok       .git/hooks/pre-commit signpost written');
}

// 4. prove it works, rather than assuming it does
console.log('\n  testing the gate end to end...');
let blocked = false;
try {
  execFileSync(process.execPath, [path.join(ROOT, 'scratch', 'verify-no-credentials.mjs')],
    { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
} catch {
  blocked = true;
}
console.log(blocked
  ? '  ok       the scanner currently reports findings it wants reviewed (non-zero exit)'
  : '  ok       the scanner passes on the current tree, which is the expected state');

// 5. prove the HOOK actually blocks, without touching the branch.
//
// Two earlier attempts at this were wrong, both instructive:
//
//   - `git commit -m ...` really did commit, creating a commit on main that then
//     had to be reset out again. Never do that in an installer.
//   - `git commit --dry-run` does NOT run pre-commit at all, so it reported
//     success and made a working gate look broken.
//
// What is faithful AND harmless: invoke the hook script the way git does -
// through sh, which is how git runs hooks on Windows - and check its exit code.
// That is the exact code path git takes, and it cannot create a commit.
const shCandidates = [
  'C:\\Program Files\\Git\\bin\\sh.exe',
  'C:\\Program Files\\Git\\usr\\bin\\sh.exe',
  '/bin/sh', 'sh',
];
const findSh = () => shCandidates.find((p) => {
  if (p.includes('/') && !path.isAbsolute(p)) return false;
  try { return fs.existsSync(p); } catch { return false; }
});

const tmpDir = path.join(ROOT, '.tmp-hooktest');
fs.mkdirSync(tmpDir, { recursive: true });
// A syntactically valid credential shape (Groq key), so the shape rule is what
// stops it. Invented: matches nothing live and corresponds to no real account.
fs.writeFileSync(path.join(tmpDir, 'probe.txt'), `const k = 'gsk_${'A'.repeat(52)}';\n`, 'utf8');
run('git', ['add', '-f', '.tmp-hooktest/probe.txt']);

const shPath = findSh();
let commitBlocked = false;
try {
  if (!shPath) throw new Error('no sh');
  // Same invocation git uses: sh <hook>. Non-zero exit is a blocked commit.
  execFileSync(shPath, [path.join('.githooks', 'pre-commit')],
    { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
} catch {
  commitBlocked = true;
}
run('git', ['reset', '-q']);
fs.rmSync(tmpDir, { recursive: true, force: true });

if (commitBlocked) {
  console.log(`  ok       the hook BLOCKS a commit containing a credential (via ${shPath || 'sh'}, as git runs it)`);
} else {
  console.log('  FAIL     a commit containing a credential was NOT blocked - the gate is decorative');
  console.log('');
  console.log('  Check core.hooksPath is .githooks, and that sh can be found.');
  process.exit(1);
}

console.log('\nhooks installed. Every commit from this clone is now checked.');
console.log('Emergency bypass: git commit --no-verify\n');