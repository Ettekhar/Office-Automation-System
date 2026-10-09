/**
 * mutation-missing-section-warning.mjs
 *
 * Proves verify-missing-section-warning.mjs can actually fail. Each mutation
 * breaks the feature in a different way; the suite must report a FAILURE for
 * each one. A non-zero exit alone does NOT count (a syntax error also exits
 * non-zero), so we require the suite's own "FAILURES:" report.
 *
 * Restores the file in a finally block and verifies the hash afterwards.
 */
import fs from 'node:fs';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

const FILE = 'C:/Users/toufi_qicjadj/Downloads/maintenance-mailer/src/reportUtils.js';
const SUITE = 'scratch/verify-missing-section-warning.mjs';
const REPO = 'C:/Users/toufi_qicjadj/Downloads/maintenance-mailer';

const original = fs.readFileSync(FILE, 'utf8');
const hash = (s) => crypto.createHash('sha256').update(s).digest('hex');
const before = hash(original);

const MUTATIONS = [
  {
    name: 'detection disabled (findUnsectionedRows returns [])',
    from: '    const out = [];',
    to: '    return [];\r\n    const out = [];',
  },
  {
    name: 'does not stop at the first band (break removed)',
    from: '      if (getSectionHeaderType(body)) break; // first band: every later row has a home',
    to: '      if (getSectionHeaderType(body)) { /* mutation: no break */ }',
  },
  {
    name: 'helper does not narrow to the table columns',
    from: '      const body = row.slice(0, REPORT_BODY_COLS);',
    to: '      const body = row;',
  },
  {
    name: 'rowsToHtmlTable stops returning unsectionedRows',
    from: '  return { reportHtml, hasAdditionalIssues, hasPremiumPlugins, unsectionedRows };',
    to: '  return { reportHtml, hasAdditionalIssues, hasPremiumPlugins };',
  },
  {
    name: 'the warning never fires',
    from: '  if (unsectionedRows.length > 0) {',
    to: '  if (false) { // mutation',
  },
];

const results = [];
try {
  for (const m of MUTATIONS) {
    if (!original.includes(m.from)) {
      results.push({ name: m.name, verdict: 'ANCHOR-NOT-FOUND' });
      continue;
    }
    const mutated = original.replace(m.from, m.to);
    if (mutated === original) {
      results.push({ name: m.name, verdict: 'NO-OP' });
      continue;
    }
    fs.writeFileSync(FILE, mutated);

    let out = '';
    let code = 0;
    try {
      out = execFileSync(process.execPath, [SUITE], { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      out = String((e.stdout || '') + (e.stderr || ''));
      code = e.status ?? 1;
    }

    // A real bite: the suite ran, reported a failure, and exited non-zero.
    const ranSuite = /\d+\/\d+/.test(out);
    const reportedFailure = /FAILURES:/.test(out) && /^\s*x\s/m.test(out);
    const verdict = code !== 0 && ranSuite && reportedFailure ? 'BITE' : 'MISSED';
    results.push({ name: m.name, verdict, code, sample: (out.match(/^\s*x\s.*$/m) || [''])[0].trim() });
  }
} finally {
  fs.writeFileSync(FILE, original);
}

const after = hash(fs.readFileSync(FILE, 'utf8'));
console.log('mutation results:');
for (const r of results) {
  console.log(`  ${r.verdict.padEnd(16)} ${r.name}${r.sample ? '   e.g. ' + r.sample : ''}`);
}
console.log(`\nfile restored: ${before === after ? 'YES' : 'NO — HASH MISMATCH'}`);

const missed = results.filter((r) => r.verdict !== 'BITE');
console.log(`\n${results.length - missed.length}/${results.length} mutations caught`);
if (missed.length || before !== after) process.exit(1);
