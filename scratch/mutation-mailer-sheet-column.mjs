/**
 * mutation-mailer-sheet-column.mjs
 *
 * Proves verify-mailer-sheet-column.mjs can actually fail. Each mutation breaks
 * the column in a different way; the suite must print its own "FAILURES:"
 * report (a non-zero exit from a syntax error does not count).
 *
 * Restores every file in a finally block and verifies hashes afterwards.
 */
import fs from 'node:fs';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

const REPO = 'C:/Users/toufi_qicjadj/Downloads/maintenance-mailer';
const HTML = `${REPO}/public/index.html`;
const JS = `${REPO}/public/app.js`;
const SUITE = 'scratch/verify-mailer-sheet-column.mjs';

const hash = (s) => crypto.createHash('sha256').update(s).digest('hex');
const original = { html: fs.readFileSync(HTML, 'utf8'), js: fs.readFileSync(JS, 'utf8') };
const before = { html: hash(original.html), js: hash(original.js) };

const MUTATIONS = [
  { file: 'html', name: 'the header column is removed', from: '<th>Website Sheet</th>', to: '' },
  { file: 'js', name: 'the cell class is renamed', from: '<td class="col-sheet">', to: '<td class="col-sheet-x">' },
  { file: 'js', name: 'the URL skips safeExternalUrl', from: 'const sheetHref = safeExternalUrl(site.reportUrl);', to: 'const sheetHref = site.reportUrl;' },
  { file: 'js', name: 'a placeholder row spans too few columns', from: 'colspan="11"', to: 'colspan="10"' },
];

const results = [];
try {
  for (const m of MUTATIONS) {
    // Start from a clean tree every iteration; a leaked mutation would make a
    // later mutation look caught when it was really the earlier one biting.
    fs.writeFileSync(HTML, original.html);
    fs.writeFileSync(JS, original.js);

    const src = m.file === 'html' ? original.html : original.js;
    if (!src.includes(m.from)) {
      results.push({ name: m.name, verdict: 'ANCHOR-NOT-FOUND' });
      continue;
    }
    const mutated = src.replace(m.from, m.to);
    if (mutated === src) { results.push({ name: m.name, verdict: 'NO-OP' }); continue; }

    if (m.file === 'html') fs.writeFileSync(HTML, mutated);
    else fs.writeFileSync(JS, mutated);

    let out = '';
    let code = 0;
    try {
      out = execFileSync(process.execPath, [SUITE], { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      out = String((e.stdout || '') + (e.stderr || ''));
      code = e.status ?? 1;
    }

    const ranSuite = /\d+\/\d+/.test(out);
    const reported = /FAILURES:/.test(out) && /^\s*x\s/m.test(out);
    results.push({
      name: m.name,
      verdict: code !== 0 && ranSuite && reported ? 'BITE' : 'MISSED',
      sample: (out.match(/^\s*x\s.*$/m) || [''])[0].trim(),
    });
  }
} finally {
  fs.writeFileSync(HTML, original.html);
  fs.writeFileSync(JS, original.js);
}

const after = { html: hash(fs.readFileSync(HTML, 'utf8')), js: hash(fs.readFileSync(JS, 'utf8')) };
console.log('mutation results:');
for (const r of results) console.log(`  ${r.verdict.padEnd(16)} ${r.name}${r.sample ? '   e.g. ' + r.sample : ''}`);
const intact = before.html === after.html && before.js === after.js;
console.log(`\nfiles restored: ${intact ? 'YES' : 'NO — HASH MISMATCH'}`);
const missed = results.filter((r) => r.verdict !== 'BITE');
console.log(`\n${results.length - missed.length}/${results.length} mutations caught`);
if (missed.length || !intact) process.exit(1);
