/**
 * mutation-am-directory.mjs
 *
 * Applies semantic mutations to a copy of src/clickup.js and re-runs
 * scratch/verify-am-directory.mjs against the copy. A mutation "bites" when the
 * suite reports FAILURES: > 0 (the suite's own line - never just exit codes).
 * Baseline (unmodified) must report FAILURES: 0.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..');
const srcPath = path.join(repo, 'src', 'clickup.js');
const original = fs.readFileSync(srcPath, 'utf8');
const copyPath = path.join(here, 'mut-am-copy.mjs');

const MUTATIONS = [
  {
    id: 'M1 non-person filter disabled',
    from: 'const NO_PERSON_RE = /^(n\\/?a|no\\s*am|none)/i;',
    to: 'const NO_PERSON_RE = /^(zzz-never-matches)$/i;',
  },
  {
    id: 'M2 multi-name split loses commas',
    from: '.split(/[,&/]+/)',
    to: '.split(/[&/]+/)',
  },
  {
    id: 'M3 status sort rank inverted',
    from: 'const rank = { linked: 0, suggested: 1, not_linked: 2 };',
    to: 'const rank = { linked: 1, suggested: 0, not_linked: 2 };',
  },
  {
    id: 'M4 hardcoded fallback disabled',
    from: 'if (entries.length === 0) {',
    to: 'if (false && entries.length === 0) {',
  },
  {
    id: 'M5 exact-match branch removed',
    from: 'if (exact) return { ...exact, confidence: \'exact\' };',
    to: '// if (exact) return { ...exact, confidence: \'exact\' };',
  },
  {
    id: 'M6 full-name threshold too loose',
    from: 'if (tokenWords.length >= 2) {',
    to: 'if (tokenWords.length >= 1) {',
  },
  {
    id: 'M7 first-word fallback lookup removed',
    from: 'if (!am) am = AM_DIRECTORY[key.split(/\\s+/)[0]];',
    to: 'if (false) am = AM_DIRECTORY[key.split(/\\s+/)[0]];',
  },
  {
    id: 'M8 email branch inverted',
    from: 'if (token.includes(\'@\')) {',
    to: 'if (!token.includes(\'@\')) {',
  },
];

function runSuite() {
  const res = spawnSync(process.execPath, ['scratch/verify-am-directory.mjs'], {
    cwd: repo,
    env: { ...process.env, CLICKUP_MOD_PATH: './mut-am-copy.mjs' },
    encoding: 'utf8',
  });
  const out = (res.stdout || '') + (res.stderr || '');
  const m = out.match(/FAILURES:\s*(\d+)/);
  const failures = m ? Number(m[1]) : NaN;
  return { failures, out };
}

// baseline
fs.writeFileSync(copyPath, original);
let base = runSuite();
if (base.failures !== 0) {
  console.log(`BASELINE FAILURES: ${base.failures} (expected 0) - aborting.`);
  console.log(base.out.slice(-1200));
  process.exit(2);
}
console.log('baseline (clean copy): FAILURES: 0  ok');

let bit = 0;
for (const mut of MUTATIONS) {
  if (!original.includes(mut.from)) {
    console.log(`  SKIP ${mut.id} (target text not found)`);
    continue;
  }
  const mutated = original.split(mut.from).join(mut.to);
  if (mutated === original) {
    console.log(`  SKIP ${mut.id} (mutation produced identical text)`);
    continue;
  }
  fs.writeFileSync(copyPath, mutated);
  const { failures } = runSuite();
  const bites = failures > 0;
  if (bites) bit += 1;
  console.log(`  ${bites ? 'BITE' : 'SURVIVED'} ${mut.id} (failures=${failures})`);
}

fs.rmSync(copyPath, { force: true });
console.log(`\nBITE ${bit}/${MUTATIONS.length}`);
if (bit !== MUTATIONS.length) process.exitCode = 1;