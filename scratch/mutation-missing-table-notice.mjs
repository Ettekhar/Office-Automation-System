/**
 * mutation-missing-table-notice.mjs
 *
 * Proves verify-missing-table-notice.mjs can actually fail. Each mutation breaks
 * the operator notice in a different way (backend, CLI, or console); the suite
 * must report its own "FAILURES:" line for each one. A non-zero exit alone does
 * NOT count (a syntax error also exits non-zero).
 *
 * Files are mutated one at a time and restored afterwards; every file's hash is
 * checked at the end. Line endings are normalised to LF for matching only.
 */
import fs from 'node:fs';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

const REPO = 'C:/Users/toufi_qicjadj/Downloads/maintenance-mailer';
const SUITE = 'scratch/verify-missing-table-notice.mjs';

const FILES = [
  'src/reportUtils.js',
  'src/index.js',
  'src/dashboardApi.js',
  'public/index.html',
  'public/app.js',
].map((p) => `${REPO}/${p}`);

const original = new Map(FILES.map((f) => [f, fs.readFileSync(f, 'utf8')]));
const toLF = (s) => s.replace(/\r\n/g, '\n');
const lf = new Map(FILES.map((f) => [f, toLF(original.get(f))]));
const hash = (s) => crypto.createHash('sha256').update(s).digest('hex');
const before = new Map(FILES.map((f) => [f, hash(original.get(f))]));

const MUTATIONS = [
  {
    file: 'src/reportUtils.js',
    name: 'reducer shape broken (count renamed)',
    from: '  return { count: unsectionedRows.length, first: describeRow(unsectionedRows[0]) };',
    to: '  return { total: unsectionedRows.length, first: describeRow(unsectionedRows[0]) };',
  },
  {
    file: 'src/reportUtils.js',
    name: 'reducer always returns null (notice never fires)',
    from: '  if (!Array.isArray(unsectionedRows) || unsectionedRows.length === 0) return null;',
    to: '  if (true) return null;',
  },
  {
    file: 'src/reportUtils.js',
    name: 'operator notice leaks into the email html',
    from: '  return { reportHtml, hasAdditionalIssues, hasPremiumPlugins, unsectionedRows };',
    to: "  return { reportHtml: reportHtml + 'Missing Table', hasAdditionalIssues, hasPremiumPlugins, unsectionedRows };",
  },
  {
    file: 'src/index.js',
    name: 'end-of-run banner guard disabled',
    from: '  if (allMissingTables.length > 0) {',
    to: '  if (false) {',
  },
  {
    file: 'src/index.js',
    name: 'end-of-run summary not handed back',
    from: '  return { sent, errors, missingTables };',
    to: '  return { sent, errors };',
  },
  {
    file: 'src/dashboardApi.js',
    name: 'getSitePreview stops returning the notice',
    from: '    hasPremiumPlugins,\n    // Operator-only: non-null when the tab has no section band and rows were\n    // dropped from the email. Shown as a console notice, never sent.\n    missingSectionRows,\n',
    to: '    hasPremiumPlugins,\n',
  },
  {
    file: 'src/dashboardApi.js',
    name: 'generate-all aggregate count hardcoded to 0',
    from: '    missingSectionCount: missingSectionSites.length,',
    to: '    missingSectionCount: 0,',
  },
  {
    file: 'public/index.html',
    name: 'modal tag element removed',
    from: 'id="modalNoTableTag"',
    to: 'id="modalNoTableX"',
  },
  {
    file: 'public/app.js',
    name: 'row badge computed but never inserted',
    from: '              ${noTableBadge}\n',
    to: '',
  },
  {
    file: 'public/app.js',
    name: 'badge title no longer escapes sheet text',
    from: 'title="No section band on this tab — ${escapeHtml(String(noTableInfo.count))} row(s) will not appear in the email. First: &quot;${escapeHtml(noTableInfo.first || \'\')}&quot;"',
    to: 'title="No section band on this tab"',
  },
];

const results = [];
try {
  for (const m of MUTATIONS) {
    const file = `${REPO}/${m.file}`;
    const src = lf.get(file);
    if (!src.includes(m.from)) {
      results.push({ name: m.name, verdict: 'ANCHOR-NOT-FOUND' });
      continue;
    }
    const mutated = src.replace(m.from, m.to);
    if (mutated === src) {
      results.push({ name: m.name, verdict: 'NO-OP' });
      continue;
    }
    fs.writeFileSync(file, mutated);

    let out = '';
    let code = 0;
    try {
      out = execFileSync(process.execPath, [SUITE], { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      out = String((e.stdout || '') + (e.stderr || ''));
      code = e.status ?? 1;
    }

    fs.writeFileSync(file, original.get(file)); // restore immediately

    const ranSuite = /\d+\/\d+/.test(out);
    const reportedFailure = /FAILURES:/.test(out) && /^\s*x\s/m.test(out);
    const verdict = code !== 0 && ranSuite && reportedFailure ? 'BITE' : 'MISSED';
    results.push({ name: m.name, verdict, code, sample: (out.match(/^\s*x\s.*$/m) || [''])[0].trim() });
  }
} finally {
  for (const f of FILES) fs.writeFileSync(f, original.get(f));
}

let restored = true;
for (const f of FILES) if (hash(fs.readFileSync(f, 'utf8')) !== before.get(f)) restored = false;

console.log('mutation results:');
for (const r of results) {
  console.log(`  ${r.verdict.padEnd(16)} ${r.name}${r.sample ? '   e.g. ' + r.sample : ''}`);
}
console.log(`\nfiles restored: ${restored ? 'YES' : 'NO — HASH MISMATCH'}`);

const missed = results.filter((r) => r.verdict !== 'BITE');
console.log(`\n${results.length - missed.length}/${results.length} mutations caught`);
if (missed.length || !restored) process.exit(1);
