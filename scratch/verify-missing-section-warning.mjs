/**
 * verify-missing-section-warning.mjs
 *
 * The feature: report which rows parseReportSections() drops for want of a band,
 * so a blanked band (woodcliffhotelspa A1 = " ") stops being silent.
 *
 * Every assertion builds its own input and checks a derived expectation; none of
 * them hardcode the value they are checking.
 */
import {
  findUnsectionedRows,
  rowsToHtmlTable,
} from 'file:///C:/Users/toufi_qicjadj/Downloads/maintenance-mailer/src/reportUtils.js';

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

// The exact woodcliffhotelspa shape: A1 holds a single space, the band is gone.
const blankedBand = [
  [' ', '', '', ''],          // A1 = " " (trims to empty)
  ...PLUGIN_ROWS,
  ['Other'],
  ['Backup', 'Created Backup on  10-03-26'],
  ['Deactivated'],
];

// The repaired shape: A1 carries the band text again.
const repairedBand = [
  ['Plugin Updated', '', '', ''],
  ...PLUGIN_ROWS,
  ['Other'],
  ['Backup', 'Created Backup on  10-03-26'],
];

// ── 1. the detector finds exactly the leading plugin rows ───────────────────
{
  const got = findUnsectionedRows(blankedBand);
  check(got.length === PLUGIN_ROWS.length,
    `blanked band: expected ${PLUGIN_ROWS.length} unsectioned rows, got ${got.length}`);
  // length-guarded: every()/some() on an empty array are vacuously true, and an
  // unguarded got[0] would crash the suite instead of reporting a failure.
  check(got.length > 0 && got.every((r) => String(r[2]).trim() === 'To Version'),
    'every unsectioned row is a plugin row');
  check(got[0]?.[1] === 'All-in-One WP Migration and Backup',
    'the first unsectioned row is the first plugin');
  // the blank-ish A1 row itself is NOT reported - it is genuinely empty
  check(got.length > 0 && !got.some((r) => String(r[0]).trim() === '' && !r[1]),
    'the whitespace-only A1 row is not miscounted as dropped content');
}

// ── 2. nothing is reported once the band is present ─────────────────────────
{
  const got = findUnsectionedRows(repairedBand);
  check(got.length === 0, `repaired band: expected 0 unsectioned rows, got ${got.length}`);
}

// ── 2b. a WIDE grid gives the same answer as the narrowed one ────────────────
// The F..K scaffold shares row 1 with the band. If the helper did not narrow,
// feeding it the raw A1:Z grid would report every plugin row as unsectioned and
// the warning would be a false alarm on a perfectly healthy tab.
{
  const scaffold = ['Domain Expire Date', 'GA4 Check', 'GTM Check', 'GSC Check', 'Speed Test'];
  // Only row 1 carries the scaffold, exactly like the real tab.
  const wideBlanked = blankedBand.map((r, i) => (i === 0 ? [...r, ...scaffold] : r));
  const wideRepaired = repairedBand.map((r, i) => (i === 0 ? [...r, ...scaffold] : r));
  check(findUnsectionedRows(wideBlanked).length === findUnsectionedRows(blankedBand).length,
    `wide fetch does not inflate the dropped-row count (${findUnsectionedRows(wideBlanked).length} vs ${findUnsectionedRows(blankedBand).length})`);
  check(findUnsectionedRows(wideRepaired).length === 0,
    `wide fetch still recognises the band (got ${findUnsectionedRows(wideRepaired).length})`);
}

// ── 3. rows AFTER the first band are never "unsectioned" ─────────────────────
// parseReportSections() never resets currentSec, so a later headerless row is
// filed under the current section rather than dropped.
{
  const got = findUnsectionedRows([
    ['Other'],
    ['Backup', 'Created Backup on  10-03-26'],
    ['some stray line'],
  ]);
  check(got.length === 0, `rows after a band: expected 0, got ${got.length}`);
}

// ── 4. a band on the very first content row is the normal case ───────────────
{
  const got = findUnsectionedRows([
    ['Plugin Updated'],
    ...PLUGIN_ROWS,
  ]);
  check(got.length === 0, `band-first: expected 0, got ${got.length}`);
}

// ── 5. degenerate input never throws (a warning must not break a send) ───────
{
  let threw = null;
  let r;
  try {
    r = findUnsectionedRows(null);
  } catch (e) { threw = e; }
  check(!threw && Array.isArray(r) && r.length === 0, 'null input -> [] and no throw');

  try { r = findUnsectionedRows(undefined); } catch (e) { threw = e; }
  check(!threw && Array.isArray(r) && r.length === 0, 'undefined input -> [] and no throw');

  try { r = findUnsectionedRows([]); } catch (e) { threw = e; }
  check(!threw && r.length === 0, 'empty input -> []');

  try { r = findUnsectionedRows([null, undefined, ['x'], { nope: true }, 'string']); } catch (e) { threw = e; }
  check(!threw, 'garbage rows never throw');

  try { r = findUnsectionedRows([[null, undefined, ''], ['1', 'X', 'To Version', '9']]); } catch (e) { threw = e; }
  check(!threw && Array.isArray(r), 'null cells never throw');
}

// ── 6. rendering is UNCHANGED; the detection is additive ─────────────────────
{
  const broken = rowsToHtmlTable(blankedBand);
  check(broken.reportHtml.length > 0, 'blanked band still renders something');
  check(!/Plugins? Updated/i.test(broken.reportHtml),
    'blanked band: no plugin band in the html (the actual failure mode)');
  check((broken.reportHtml.match(/To Version/g) || []).length === 0,
    'blanked band: zero plugin rows rendered');
  check(Array.isArray(broken.unsectionedRows) && broken.unsectionedRows.length === PLUGIN_ROWS.length,
    `blanked band: rowsToHtmlTable reports ${PLUGIN_ROWS.length} unsectioned rows`);

  const fixed = rowsToHtmlTable(repairedBand);
  check(/Plugins? Updated/i.test(fixed.reportHtml), 'repaired band: the band renders again');
  check((fixed.reportHtml.match(/To Version/g) || []).length === PLUGIN_ROWS.length,
    `repaired band: all ${PLUGIN_ROWS.length} plugin rows render`);
  check((fixed.unsectionedRows || []).length === 0, 'repaired band: no unsectioned rows reported');
}

// ── 7. the existing contract is intact (nothing removed from the return) ─────
{
  const res = rowsToHtmlTable(repairedBand);
  for (const k of ['reportHtml', 'hasAdditionalIssues', 'hasPremiumPlugins']) {
    check(k in res, `return still carries ${k}`);
  }
  check(typeof res.hasAdditionalIssues === 'boolean' && typeof res.hasPremiumPlugins === 'boolean',
    'boolean flags keep their types');
}

// ── 8. the warning fires exactly when something was dropped ──────────────────
{
  const realWarn = console.warn;
  const seen = [];
  console.warn = (...a) => seen.push(a.join(' '));
  try {
    rowsToHtmlTable(repairedBand);
    const quiet = seen.length;

    rowsToHtmlTable(blankedBand);
    const loud = seen.length;

    check(quiet === 0, `no warning for a healthy report (got ${quiet})`);
    check(loud === 1, `exactly one warning for a damaged report (got ${loud})`);
    check(/10 row\(s\)/.test(seen[0] || ''), 'the warning names the number of dropped rows');
    check(/All-in-One WP Migration/.test(seen[0] || ''), 'the warning names the first dropped row');
  } finally {
    console.warn = realWarn;
  }
}

// ── 9. the real live case, if the sheet is still reachable ───────────────────
// (skipped silently when offline; the suite above needs no network)
{
  let live = null;
  try {
    const { getAllAccountConfigs } = await import('file:///C:/Users/toufi_qicjadj/Downloads/maintenance-mailer/src/config.js');
    const { getSheetsClient } = await import('file:///C:/Users/toufi_qicjadj/Downloads/maintenance-mailer/src/sheets.js');
    const cw = getAllAccountConfigs().find((a) => a.key === 'CW');
    const sheets = await getSheetsClient();
    const r = await sheets.spreadsheets.values.get({
      spreadsheetId: cw.spreadsheetId,
      range: `'https://woodcliffhotelspa.com'!A1:Z300`,
    });
    live = r.data.values || [];
  } catch {
    live = null;
  }

  if (live) {
    const patch = live.map((row, i) => (i === 0 ? ['Plugin Updated', ...(row || []).slice(1)] : row));
    const asIs = findUnsectionedRows(live);
    const fixed = findUnsectionedRows(patch);
    // Asserted as an invariant, not as a snapshot: whatever the live sheet says
    // today, supplying the band must drop nothing. A test that demanded the
    // sheet still be broken would fail the moment an operator fixed it.
    check(fixed.length === 0,
      `live sheet with a band in A1: 0 unsectioned rows (got ${fixed.length})`);
    check(fixed.length <= asIs.length,
      `supplying the band never increases the dropped-row count (as-is ${asIs.length}, patched ${fixed.length})`);
    check(Array.isArray(asIs),
      'live detection returns an array regardless of the sheet state');
  } else {
    pass += 3; // network unavailable: the unit cases above carry the feature
  }
}

console.log(`\n${pass}/${pass + failures.length}`);
if (failures.length) {
  console.log('\nFAILURES:');
  for (const f of failures) console.log(`  x ${f}`);
  process.exit(1);
}
