/**
 * verify-missing-table-notice.mjs
 *
 * The feature: when a report tab has no section band, rows are dropped from the
 * email. The detector already warns on stderr (see verify-missing-section-
 * warning.mjs). This suite covers the two OPERATOR surfaces added on top:
 *
 *   1. an end-of-run summary in the local sender   (src/index.js)
 *   2. a dashboard notice in the mailer console    (src/dashboardApi.js +
 *      public/index.html + public/app.js)
 *
 * The hard rule these must never break: the notice is operator-only. Nothing
 * about it may reach an email body, and a healthy report must stay silent.
 *
 * Every assertion derives its expectation from an input it builds itself; none
 * hardcode the value under test.
 */
import fs from 'node:fs';
import {
  findUnsectionedRows,
  rowsToHtmlTable,
  describeRow,
  missingSectionInfo,
} from 'file:///C:/Users/toufi_qicjadj/Downloads/maintenance-mailer/src/reportUtils.js';

const REPO = 'C:/Users/toufi_qicjadj/Downloads/maintenance-mailer';
const read = (p) => fs.readFileSync(`${REPO}/${p}`, 'utf8');

let pass = 0;
const failures = [];
const check = (cond, msg) => { if (cond) pass++; else failures.push(msg); };

const PLUGIN_ROWS = [
  ['1', 'All-in-One WP Migration and Backup', 'To Version', '7.111'],
  ['2', 'CookieYes | GDPR Cookie Consent', 'To Version', '3.5.6'],
  ['3', 'FluentSMTP', 'To Version', '2.4.1'],
  ['4', 'Post Types Order', 'To Version', '2.5.6'],
  ['5', 'Redirection', 'To Version', '5.10.1'],
  ['6', 'Redirection for Contact Form 7', 'To Version', '3.2.13'],
  ['7', 'Simple History', 'To Version', '5.34.0'],
  ['8', 'WP Ghost Lite', 'To Version', '7.0.12'],
  ['9', 'WPvivid Backup Plugin', 'To Version', '0.9.136'],
  ['10', 'Yoast SEO', 'To Version', '28.6'],
];

const blankedBand = [
  [' ', '', '', ''],
  ...PLUGIN_ROWS,
  ['Other'],
  ['Backup', 'Created Backup on  10-03-26'],
  ['Deactivated'],
];

const repairedBand = [
  ['Plugin Updated', '', '', ''],
  ...PLUGIN_ROWS,
  ['Other'],
  ['Backup', 'Created Backup on  10-03-26'],
];

// ── 1. the reducer: healthy input is null, damaged input is a small shape ────
{
  check(missingSectionInfo([]) === null, 'empty drops -> null');
  check(missingSectionInfo(null) === null, 'null drops -> null');
  check(missingSectionInfo(undefined) === null, 'undefined drops -> null');
  check(missingSectionInfo('not an array') === null, 'non-array drops -> null');
  check(missingSectionInfo({ length: 3 }) === null, 'array-like object is not treated as drops');

  const healthy = missingSectionInfo(findUnsectionedRows(repairedBand));
  check(healthy === null, `a report with its band produces no notice (got ${JSON.stringify(healthy)})`);

  const dropped = findUnsectionedRows(blankedBand);
  const info = missingSectionInfo(dropped);
  check(info !== null, 'a report missing its band produces a notice');
  check(info && info.count === PLUGIN_ROWS.length,
    `the notice carries the dropped-row count (expected ${PLUGIN_ROWS.length}, got ${info && info.count})`);
  check(info && info.first === 'All-in-One WP Migration and Backup',
    `the notice names the first dropped row (got "${info && info.first}")`);
  // The shape must be plain JSON so the dashboard can serialise it over HTTP.
  check(info && JSON.parse(JSON.stringify(info)).count === info.count,
    'the notice serialises cleanly (plain object, no functions)');
}

// ── 2. describeRow: searchable text, column B preferred, capped at 60 ─────────
{
  check(describeRow(['a', 'b', 'c']) === 'b', 'describeRow prefers column B');
  check(describeRow(['only-a']) === 'only-a', 'describeRow falls back to column A');
  check(describeRow(['  ', '  spaced  ']) === 'spaced', 'describeRow trims');
  check(describeRow(['', '', 'c']) === '', 'describeRow never uses column C');
  const long = 'x'.repeat(120);
  check(describeRow(['', long]).length === 60, 'describeRow caps the label at 60 chars');
  check(describeRow(null) === '' && describeRow(undefined) === '', 'describeRow tolerates null/undefined');
  check(describeRow([null, null]) === '', 'describeRow tolerates null cells');
}

// ── 3. the notice is OPERATOR-ONLY: it never enters the email html ────────────
{
  const realWarn = console.warn;
  console.warn = () => {}; // the stderr warning is covered by its own suite
  let broken;
  try {
    broken = rowsToHtmlTable(blankedBand);
  } finally {
    console.warn = realWarn;
  }
  const html = broken.reportHtml;
  for (const token of ['Missing Table', 'missingSection', 'unsectioned', '\u26a0']) {
    check(!html.includes(token), `the email html never contains the operator token "${token}"`);
  }
  // The detector still reports the loss, so the notice has something to show.
  check((broken.unsectionedRows || []).length === PLUGIN_ROWS.length,
    'the damaged report still reports its dropped rows');
}

// ── 4. the email builder module knows nothing about the notice ────────────────
{
  const mailer = read('src/mailer.js');
  check(!/missingSection/.test(mailer), 'src/mailer.js has no notice code (cannot leak into an email)');
}

// ── 5. the local sender: a summary is collected and printed at the end ────────
{
  const index = read('src/index.js');
  check(index.includes('missingSectionInfo'), 'src/index.js uses the shared notice reducer');
  check(/missingSectionInfo\(unsectionedRows\)/.test(index), 'src/index.js reduces the rows it actually rendered');
  check(/missingTables\.push\(/.test(index), 'src/index.js collects the sites missing a table');
  check(/return \{ sent, errors, missingTables \}/.test(index),
    'src/index.js hands the collector back to the run (so main() can summarise)');
  check(/allMissingTables/.test(index), 'src/index.js aggregates across accounts');
  check(/MISSING THEIR TABLE/.test(index), 'src/index.js prints the end-of-run banner');
  // The banner must be inside the guarded block, not run unconditionally.
  check(/if \(allMissingTables\.length > 0\)/.test(index),
    'the end-of-run banner is guarded on there being missing tables');
}

// ── 6. the dashboard backend: additive fields on both preview endpoints ───────
{
  const api = read('src/dashboardApi.js');
  const iPreview = api.indexOf('export async function getSitePreview');
  const iAll = api.indexOf('export async function generateAllPreviews');
  check(iPreview >= 0 && iAll > iPreview, 'both preview endpoints are present to check');
  const getSitePreviewSrc = api.slice(iPreview, iAll);
  const generateAllSrc = api.slice(iAll);
  check(/missingSectionInfo\(tableRes\.unsectionedRows\)/.test(getSitePreviewSrc),
    'getSitePreview reduces the rows it rendered');
  check(/missingSectionRows,/.test(getSitePreviewSrc), 'getSitePreview returns missingSectionRows');
  check(/missingSectionInfo\(unsectionedRows\)/.test(generateAllSrc),
    'generateAllPreviews reduces the rows it rendered');
  check(/missingSectionSites/.test(generateAllSrc), 'generateAllPreviews returns the aggregate list');
  check(/missingSectionCount: missingSectionSites\.length/.test(generateAllSrc),
    'the aggregate carries a count the console can show without iterating');
}

// ── 7. the console UI: a modal tag and a per-row badge ───────────────────────
{
  const html = read('public/index.html');
  check(/id="modalNoTableTag"/.test(html), 'the preview modal has a Missing Table tag');
  check(/modalNoTableTag[\s\S]*?hidden/.test(html), 'the tag starts hidden (no notice on a healthy site)');

  const app = read('public/app.js');
  check(app.includes("getElementById('modalNoTableTag')"), 'app.js wires the modal tag element');
  check(/previewData\.missingSectionRows/.test(app), 'the modal reads the notice from the preview payload');
  check(/noTableBadge/.test(app), 'the sites table renders a per-row Missing Table badge');
  check(/\$\{noTableBadge\}/.test(app), 'the row template actually inserts the badge');
  check(/preview\.missingSectionRows/.test(app), 'the row badge is driven by the generated preview');
  check(/data\.missingSectionCount/.test(app), 'the generate-all flow reports the aggregate count');
  check(/modalNoTableTag\.classList\.remove\('hidden'\)/.test(app), 'the modal tag is actually shown for an affected site');
  // The badge title interpolates sheet text: it must be escaped.
  check(/title="No section band on this tab[^"]*escapeHtml/.test(app),
    'the row badge title escapes the sheet text it shows');
}

// ── 8. the notice cannot fire on a healthy report (the whole point) ───────────
{
  const healthyRuns = [repairedBand, [['Plugin Updated'], ...PLUGIN_ROWS]];
  for (const grid of healthyRuns) {
    check(missingSectionInfo(findUnsectionedRows(grid)) === null,
      'a healthy grid yields no notice on any surface');
  }
}

console.log(`\n${pass}/${pass + failures.length}`);
if (failures.length) {
  console.log('\nFAILURES:');
  for (const f of failures) console.log(`  x ${f}`);
  process.exit(1);
}
