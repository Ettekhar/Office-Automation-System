/**
 * mutation-no-credentials.mjs
 *
 * Proves the credential gate can actually go RED.
 *
 * A secret scanner that cannot fail is worse than none, because it is reported
 * as safety. This plants each class of leak in a staged file and asserts the
 * scanner BLOCKS it, then unstages and deletes the probe.
 *
 * Every planted value is invented. They match credential SHAPES so the
 * shape-based rules are genuinely exercised, but they are not any real key and
 * correspond to nothing in .env.
 *
 * IMPORTANT: the probes are staged with `git add -f` and removed with
 * `git reset` + `rm`. Nothing is ever committed - the harness never runs
 * `git commit`. That is deliberate: the first version of install-hooks.mjs did
 * run a real commit as its self-test, and it created a commit on the live
 * branch that then had to be reset out again.
 *
 * Run:  node scratch/mutation-no-credentials.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCANNER = path.join(ROOT, 'scratch', 'verify-no-credentials.mjs');
const PROBE_DIR = path.join(ROOT, '.tmp-credprobe');

const sha = (p) => fs.readFileSync(p, 'utf8');

// ---------------------------------------------------------------- fixtures
// Invented values, each shaped like a real credential of that class.
const PROBES = [
  // The PEM fixture is assembled at runtime from fragments. Written literally it
  // would (correctly) trip this repo's own scanner - the gate blocked a real
  // commit over exactly this line - and exempting it would put a hole in the
  // check shaped like the thing the check exists for. Assembling it keeps the
  // fixture a genuine PEM block while the committed source stays clean.
  ['PEM private key block', 'probe.txt',
    `${'-'.repeat(5)}BEGIN PRIVATE KEY${'-'.repeat(5)}\nMIIEvQIBADANBg\n${'-'.repeat(5)}END PRIVATE KEY${'-'.repeat(5)}\n`],
  ['Google service-account JSON', 'probe.json',
    '{"type":"service_account","project_id":"x"}\n'],
  // Lengths matter and are easy to get wrong: a fixture that does not actually
  // match the pattern proves nothing, and the first version of this file had
  // three such fixtures that "passed" only because the scanner correctly
  // ignored them. These are built from the real key lengths in .env.
  // Gemini  = 'AQ.Ab' + 48, Groq = 'gsk_' + 52, npm = 'npm_' + 36.
  ['Google AI Studio key', 'probe.js', `const k = 'AQ.Ab${'A'.repeat(48)}';\n`],
  ['Groq key', 'probe.js', `const k = 'gsk_${'A'.repeat(52)}';\n`],
  ['OpenRouter key', 'probe.js', `const k = 'sk-or-v1-${'A'.repeat(64)}';\n`],
  ['ClickUp personal key', 'probe.js', "const k = 'pk_8742631_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij';\n"],
  ['Slack webhook', 'probe.js', "const u = '" + 'https://hooks.slack.com/' + 'services/T00000000/B00000000/XXXXXXXXXXXXXXXXXXXXXXXX' + "';\n"],
  ['npm token', 'probe.js', `const t = 'npm_${'A'.repeat(36)}';\n`],
  ['GitHub token', 'probe.js', "const t = 'ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';\n"],
  ['JWT', 'probe.js', "const t = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';\n"],
  ['token in a URL', 'probe.js', "const u = '/api/x?token=abcdefghijklmnopqrstuvwxyz012345';\n"],
  ['SMTP password literal', 'probe.env.js', "const SMTP_PASS = 'hunter2notarealpassword';\n"],
];

// The forbidden FILES, staged with -f to prove the name check works even when
// .gitignore is overridden.
const FILE_PROBES = [
  ['.env staged by force', '.env', 'ADMIN_TOKEN=notrealjustafixturevalue123\n'],
  ['service-account.json staged by force', 'service-account.json', '{"type":"service_account"}\n'],
];

// THIS FILE IS EXEMPT FROM EVERY SHAPE, and that must not exempt it from
// anything else.
//
// This harness is the scanner's test corpus, so verify-no-credentials.mjs
// lists it in SHAPE_EXEMPT. An exemption that only covers the shape rules is
// correct; one that also waved through the real-value rules would turn the
// file most likely to collect pasted secrets into the one blind spot in the
// scan. So: plant an actual live .env value HERE and require the commit to be
// blocked.
//
// The value is read from .env, staged, then reset and deleted. It is never
// printed and never leaves the working tree. If .env is absent the probe is
// skipped rather than faked - a skipped probe is honest, a fabricated one is
// a green check that proves nothing.
function liveEnvValue() {
  const p = path.join(ROOT, '.env');
  if (!fs.existsSync(p)) return null;
  // Only consider keys that are credentials BY NAME. The first version of this
  // probe took the first sufficiently long value in the file and hit
  // CW_SMTP_HOST - a hostname the scanner deliberately does not track. The
  // probe then reported "the PEM exemption swallowed every other shape", which
  // was a completely wrong diagnosis of a fixture problem. Selecting by
  // credential-shaped key name is what makes this probe test the scanner rather
  // than the probe's own guesswork.
  const CREDENTIAL_KEY = /(PASS|PASSWORD|SECRET|TOKEN|API_?KEY|PRIVATE_?KEY|CREDENTIAL)/;
  for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.+)$/.exec(line);
    if (!m || !CREDENTIAL_KEY.test(m[1])) continue;
    const v = m[2].trim().replace(/^["']|["']$/g, '');
    // The scanner skips values under 8 chars, URLs and bare paths, so a probe
    // using one of those would test nothing and report a phantom failure.
    if (v.length >= 16 && !/^(https?:|file:)/i.test(v) && !/^[\w.-]+[\\/][\w.-]+$/.test(v)) return v;
  }
  return null;
}

function clean() {
  try { execFileSync('git', ['reset', '-q'], { cwd: ROOT, stdio: 'ignore' }); } catch { /* nothing staged */ }
  fs.rmSync(PROBE_DIR, { recursive: true, force: true });
}

// Runs the real scanner and reports whether it BLOCKED.
//
// A non-zero exit is NOT sufficient evidence of detection. A stack trace also
// exits non-zero, so treating every throw as "blocked" means a scanner that
// cannot even start reports every probe as caught and this whole harness passes
// while proving nothing. That is not hypothetical: an earlier version of the
// exemption-scope probe did exactly this and printed 16/16 green against a
// scanner that had crashed on every invocation.
//
// So: a block requires the scanner's own banner AND a BLOCKED line. Anything
// else that exits non-zero is surfaced as a harness failure.
function runScanner() {
  try {
    const out = execFileSync(process.execPath, [SCANNER], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { blocked: false, crashed: false, out };
  } catch (e) {
    const out = `${e.stdout || ''}${e.stderr || ''}`;
    const blocked = /credential scan/.test(out) && /BLOCKED/.test(out);
    return { blocked, crashed: !blocked, out };
  }
}

let pass = 0; let fail = 0; const failures = [];
console.log('\n=== mutation: the credential gate must go RED ===\n');

for (const [name, file, body] of PROBES) {
  clean();
  const p = path.join(PROBE_DIR, file);
  fs.mkdirSync(PROBE_DIR, { recursive: true });
  fs.writeFileSync(p, body);
  execFileSync('git', ['add', '-f', path.relative(ROOT, p).replace(/\\/g, '/')], { cwd: ROOT, stdio: 'ignore' });

  const r = runScanner();
  if (r.crashed) {
    fail++;
    failures.push(`${name} (probe crashed)`);
    console.log(`  FAIL     ${name} - the scanner crashed instead of detecting`);
  } else if (r.blocked) {
    pass++;
    console.log(`  ok       blocked: ${name}`);
  } else {
    fail++;
    failures.push(name);
    console.log(`  MISSED   ${name}  <-- the gate did not notice this`);
  }
}

for (const [name, file, body] of FILE_PROBES) {
  clean();
  const p = path.join(ROOT, file);
  const existed = fs.existsSync(p);
  const backup = existed ? sha(p) : null;
  if (existed && (file === '.env')) {
    // Never risk the real .env. Stage the name without the real content by
    // using a temporary index entry is not possible, so skip and report.
    console.log(`  skip     ${name} (would require touching the real .env - not doing that)`);
    continue;
  }
  if (!existed) {
    fs.writeFileSync(p, body);
    execFileSync('git', ['add', '-f', file], { cwd: ROOT, stdio: 'ignore' });
    const r = runScanner();
    if (r.crashed) { fail++; failures.push(`${name} (probe crashed)`); console.log(`  FAIL     ${name} - the scanner crashed instead of detecting`); }
    else if (r.blocked) { pass++; console.log(`  ok       blocked: ${name}`); }
    else { fail++; failures.push(name); console.log(`  MISSED   ${name}`); }
    try { execFileSync('git', ['reset', '-q'], { cwd: ROOT, stdio: 'ignore' }); } catch { /* */ }
    fs.rmSync(p, { force: true });
  } else if (backup !== null) {
    fs.writeFileSync(p, backup); // restore, never modified in practice
  }
}

// THE EXEMPTION-NARROWNESS PROBE
//
// Plant a live .env value inside THIS file - the one file the scanner exempts
// from every shape - and require the commit to still be blocked. If the
// exemption were ever widened to cover the real-value rules, this goes red.
{
  const live = liveEnvValue();
  if (live === null) {
    console.log('  skip     exemption narrowness (no usable .env value found)');
  } else {
    clean();
    const self = path.relative(ROOT, path.join(ROOT, 'scratch', 'mutation-no-credentials.mjs')).replace(/\\/g, '/');
    const original = fs.readFileSync(path.join(ROOT, self), 'utf8');
    try {
      fs.writeFileSync(path.join(ROOT, self), `${original}\n// probe: ${live}\n`, 'utf8');
      execFileSync('git', ['add', '-f', self], { cwd: ROOT, stdio: 'ignore' });
      const r = runScanner();
      if (r.crashed) {
        fail++;
        failures.push('exemption narrowness probe crashed');
        console.log('  FAIL     exemption narrowness probe crashed - harness bug, not a verdict');
      } else if (r.blocked) {
        pass++;
        console.log('  ok       blocked: a live .env value inside the shape-exempt file (exemption stays narrow)');
      } else {
        fail++;
        failures.push('exemption widened to cover real values');
        console.log('  MISSED   live .env value inside the exempt file - the exemption is too broad');
      }
    } finally {
      fs.writeFileSync(path.join(ROOT, self), original, 'utf8');
      try { execFileSync('git', ['reset', '-q', '--', self], { cwd: ROOT, stdio: 'ignore' }); } catch { /* */ }
      clean();
    }
  }
}

// THE EXEMPTION-SCOPE PROBE
//
// Each exemption is a (file, shape) PAIR. So being exempt from one shape must
// not exempt a file from any other. google-shim.js is legitimately exempt from
// "PEM private key block" - it strips PEM headers at runtime - and must NOT be
// exempt from, say, a Groq key or a real .env value. If the pairing ever
// collapsed to "this file skips shape checks", both of these would pass and
// this probe goes red.
//
// Written to a throwaway file that copies the exemption entry, rather than
// editing google-shim.js: this harness must not mutate working source, even
// briefly, because a crash mid-probe would leave a damaged shim behind.
{
  const SHIM_COPY = path.join(PROBE_DIR, 'google-shim.js');
  for (const [label, body] of [
    ['a Groq key in the PEM-exempt file', `const k = 'gsk_${'A'.repeat(52)}';\n`],
    ['a live .env value in the PEM-exempt file', null], // filled below
  ]) {
    clean();
    fs.mkdirSync(PROBE_DIR, { recursive: true });
    let content = body;
    if (content === null) {
      const live = liveEnvValue();
      if (live === null) { console.log(`  skip     ${label} (no usable .env value)`); continue; }
      content = `const k = '${live}';\n`;
    }
    fs.writeFileSync(SHIM_COPY, content, 'utf8');

    // The probe lives under .tmp-credprobe/, but SHAPE_EXEMPT is keyed by repo
    // relative path, so the exemption under test must be expressed for the
    // path actually staged. Copying the entry keeps the test honest about what
    // is being asserted: a per-shape exemption is narrow, not per-file.
    const scannerSrc = fs.readFileSync(SCANNER, 'utf8');
    const relProbe = path.relative(ROOT, SHIM_COPY).replace(/\\/g, '/');
    const patched = scannerSrc.replace(
      'const SHAPE_EXEMPT = new Map([',
      `const SHAPE_EXEMPT = new Map([['${relProbe}', new Set(['PEM private key block'])], [`,
    );
    if (patched === scannerSrc) {
      fail++;
      failures.push(`${label} (patch anchor not found)`);
      console.log(`  FAIL     could not patch the scanner - the SHAPE_EXEMPT anchor moved`);
      clean();
      continue;
    }

    // The copy MUST sit in scratch/, the same depth below ROOT as the real
    // scanner, because the scanner derives ROOT from its own file location
    // (../ from its directory). An earlier version of this probe wrote the copy
    // into .tmp-credprobe/, so ROOT resolved to the repo's PARENT, the scanner
    // found no .env and no staged files, and it exited non-zero purely by
    // crashing. That crash was being counted as a successful detection, so both
    // probes reported "ok" unconditionally - a check that cannot fail.
    const patchedPath = path.join(ROOT, 'scratch', '.tmp-scanner-under-test.mjs');
    fs.writeFileSync(patchedPath, patched, 'utf8');
    execFileSync('git', ['add', '-f', relProbe], { cwd: ROOT, stdio: 'ignore' });

    // Distinguish "correctly blocked" from "crashed". A non-zero exit alone is
    // not evidence of detection: a stack trace also exits non-zero. Require the
    // scanner's own banner plus a BLOCKED line, and treat anything else as a
    // harness failure so a broken probe can never read as a passing one.
    let blocked = false; let crashed = false; let out = '';
    try {
      out = execFileSync(process.execPath, [patchedPath],
        { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      out = `${e.stdout || ''}${e.stderr || ''}`;
      blocked = /credential scan/.test(out) && /BLOCKED/.test(out);
      crashed = !blocked;
    }
    try { fs.rmSync(patchedPath, { force: true }); } catch { /* best effort */ }

    if (crashed) {
      fail++;
      failures.push(`${label} (probe crashed)`);
      console.log(`  FAIL     ${label} - the probe crashed instead of detecting`);
      console.log('           the scanner under test did not run; this is a harness bug, not a verdict');
      clean();
      continue;
    }
    if (blocked) { pass++; console.log(`  ok       blocked: ${label} (exemption is per-shape, not per-file)`); }
    else {
      // Do NOT guess a cause here. An earlier version of this probe printed
      // "the PEM exemption swallowed every other shape" and was wrong - the
      // fixture it had chosen was a hostname the scanner never tracks. Report
      // the observation and let a human diagnose it.
      fail++;
      failures.push(label);
      console.log(`  MISSED   ${label}`);
      console.log('           cause unknown - do not assume the exemption is at fault without proving it');
    }
    clean();
  }
}

// A control: ordinary source with no secret must NOT be blocked. A gate that
// blocks everything gets bypassed, and then it protects nothing.
clean();
fs.mkdirSync(PROBE_DIR, { recursive: true });
fs.writeFileSync(path.join(PROBE_DIR, 'clean.js'),
  "export const month = 'September';\nexport const rows = 104;\n", 'utf8');
execFileSync('git', ['add', '-f', '.tmp-credprobe/clean.js'], { cwd: ROOT, stdio: 'ignore' });
const ctrl = runScanner();
if (!ctrl.blocked) { pass++; console.log('  ok       control: ordinary source is NOT blocked (no false positive)'); }
else { fail++; failures.push('control false positive'); console.log('  FAIL     control blocked ordinary source - the gate cries wolf'); }

clean();

console.log('');
if (fail) {
  console.log(`${pass} caught, ${fail} MISSED: ${failures.join(', ')}`);
  process.exit(1);
}
console.log(`${pass}/${pass} - every planted leak was blocked, and clean source passed`);
console.log('nothing was committed; probes were staged then removed\n');
process.exit(0);
const INVENTED = 'not a secret';
// real: [REDACTED by the credential gate] shape = 'gsk_' + 52 chars. Never commit a live key.

