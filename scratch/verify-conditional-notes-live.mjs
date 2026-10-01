/**
 * verify-conditional-notes-live.mjs
 *
 * Proves the feature end-to-end against the operator's ACTUAL spreadsheet, rather
 * than the transcribed fixture in verify-conditional-notes.mjs. A hand-typed
 * fixture can drift from reality without anyone noticing; this cannot.
 *
 * Reads: the CW report tab for ocalaflevents.com (the site the operator named).
 * Writes: nothing to Google Sheets. Its DB writes go to a throwaway directory.
 *
 * Needs network access, like verify-assign-dryrun.mjs.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'officeos-cond-live-'));
process.env.OFFICEOS_DATA_DIR = TMP_DATA;

const { getAccountConfig, getAllAccountConfigs } = await import('../src/config.js');
const { getTabValues, listTabTitles } = await import('../src/sheets.js');
const { resolveConditionalNotes, parseReportSections, rowsToHtmlTable } = await import('../src/reportUtils.js');
const { buildEmail } = await import('../src/mailer.js');
const db = await import('../src/db.js');

const SITE = 'ocalaflevents.com';
// The exact message from the operator's brief.
const MESSAGE =
  'We reviewed the latest ADA accessibility audit and implemented custom fixes for the related issues identified. The full audit findings and remediation details are available here...';

let pass = 0;
const failures = [];
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { failures.push(name); console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};
const eq = (name, a, e) => check(name, JSON.stringify(a) === JSON.stringify(e), `got ${JSON.stringify(a)}, want ${JSON.stringify(e)}`);

console.log(`\n── finding ${SITE} in the real master tab ───────────────────────────────`);

const acct = getAccountConfig('CW');
const master = await getTabValues(acct.masterTabName, 'A1:ZZ2000', acct.spreadsheetId);
const siteRow = master.slice(1).find((r) => {
  const u = String(r?.[0] ?? '').trim().toLowerCase();
  return u.includes(SITE) || u.replace(/^https?:\/\//, '').replace(/\/+$/, '') === SITE
    || r.some((c) => String(c ?? '').toLowerCase().includes(SITE));
});
check(`${SITE} exists in the CW master tab`, Boolean(siteRow));

const { findMatchingTab } = await import('../src/reportUtils.js');
const tabs = await listTabTitles(acct.spreadsheetId);
const tab = findMatchingTab(tabs, SITE, acct.masterTabName);
check(`a report tab matches it (${tab})`, Boolean(tab));

const grid = (await getTabValues(tab, 'A1:D200', acct.spreadsheetId)) || [];
check(`the grid is non-empty (${grid.length} rows)`, grid.length > 0);

// The operator's actual cell, read out of the real tab rather than assumed.
//
// The keyword is DISCOVERED, not hardcoded. The operator is free to rename the
// condition to anything at any time — they have already renamed it once while
// this suite was in use. A suite that pinned "a11y" would be asserting a
// coincidence rather than the actual contract, and would fail on a rename that
// the product handles correctly. So: find the cell in the trigger shape, take
// whatever keyword it uses, and prove THAT keyword works.
const TRIGGER = /^\s*([^:\s]+)\s*:\s*(\S+)\s*$/;
const triggerCells = [];
grid.forEach((row, i) => (row || []).forEach((c, ci) => {
  const m = TRIGGER.exec(String(c ?? ''));
  if (m && /^https?:\/\//i.test(m[2])) {
    triggerCells.push({ row: i + 1, col: String.fromCharCode(65 + ci), text: String(c), keyword: m[1], link: m[2] });
  }
}));
check(`exactly one "<keyword>:<link>" cell exists in the tab (found ${triggerCells.length})`, triggerCells.length === 1,
  JSON.stringify(triggerCells.map((t) => `${t.col}${t.row}`)));
const keyword = triggerCells[0]?.keyword ?? '';
const link = triggerCells[0]?.link ?? '';
console.log(`  (the operator's live keyword is ${JSON.stringify(keyword)} — discovered, not assumed)`);
check('its link is the ADA audit Google Doc', link.startsWith('https://docs.google.com/document/d/'), link.slice(0, 60));
check('it points at the heading the operator cited',
  link.includes('heading=h.6fwf6gxl58vz'), link.slice(-40));

console.log(`\n── the problem this feature solves ──────────────────────────────────`);
{
  const secs = parseReportSections(grid);
  const issue = secs.find((s) => s.type === 'additional_issue');
  eq(`parseReportSections drops the cell (orphan after 2 blank rows): ${issue?.rows.length ?? 'n/a'} rows`,
    issue?.rows.length ?? 0, 0);
  const before = rowsToHtmlTable(grid);
  // Guard the needle: `includes('')` is always true, so an undiscovered keyword
  // would turn this into a confusing failure instead of a clear one.
  check('the keyword and link were discovered (so the next check is meaningful)', keyword !== '' && link !== '');
  check('and it is absent from the pre-existing report HTML',
    keyword !== '' && !before.reportHtml.includes(keyword) && !before.reportHtml.includes(link));
  console.log('  (so today the note reaches no recipient at all)');
}

console.log(`\n── detection + rendering on the real tab ───────────────────────────`);
{
  db.createConditionalNote({ account: 'CW', condition: keyword, message: MESSAGE });
  const notes = resolveConditionalNotes(grid, db.getConditionalNotes({ account: 'CW', enabledOnly: true }));
  eq('exactly one note fires', notes.length, 1);
  eq('the link comes from the cell, not from the registry', notes[0]?.url, link);
  eq('the source cell is reported as the real one', notes[0]?.sourceCell, `${triggerCells[0].col}${triggerCells[0].row}`);

  // The keyword the operator chose has no special standing: swap it for any other
  // arbitrary word and detection follows the cell, not a built-in list. Asserted
  // here on the REAL grid, so "any keyword works" is a statement about the
  // product and not only about the offline fixture.
  const swapped = resolveConditionalNotes(grid, [{ condition: 'alsdjflaksf', message: 'm', enabled: true }]);
  eq('a different arbitrary keyword does NOT fire on the real cell', swapped.length, 0);
  eq('the real keyword does fire', notes[0]?.condition, keyword.toLowerCase());
  eq('case does not matter', resolveConditionalNotes(grid,
    [{ condition: keyword.toUpperCase(), message: 'm', enabled: true }])[0]?.condition, keyword.toLowerCase());

  const { html, subject } = buildEmail({
    websiteUrl: SITE,
    reportMonth: { monthLower: 'september', year: 2026 },
    reportHtml: rowsToHtmlTable(grid).reportHtml,
    hasAdditionalIssues: false,
    hasPremiumPlugins: false,
    conditionalNotes: notes,
    accountKey: 'CW',
  });

  check('the operator\'s message is in the email', html.includes(MESSAGE.replace('here...', '').trim().slice(0, 60)));
  check('the real audit link is the href', html.includes(`href="${link}"`));
  check('"here" is the anchor text', html.includes('>here</a>'));
  check('the paragraph is above the sign-off',
    html.indexOf('docs.google.com') < html.indexOf('Best Regards,'));
  check('the paragraph is below "Everything is running smoothly"',
    html.indexOf('Everything is running smoothly') < html.indexOf('docs.google.com'));
  eq('exactly one sign-off', (html.match(/Best Regards,/g) || []).length, 1);
  check('the existing plugin table is still intact', html.includes('DearFlip Lite'));

  // The note paragraph is the first <p> after the closing "Everything is running
  // smoothly" line. Slice from there, not back from "Best Regards," — that finds
  // the sign-off's own <p> and would silently assert against the wrong paragraph.
  const para = html.slice(html.indexOf('<p>', html.indexOf('Everything is running smoothly')));
  const text = para.slice(0, para.indexOf('</p>')).replace(/<[^>]*>/g, '');
  eq('read back, the paragraph is exactly the operator\'s sentence', text, MESSAGE);
  console.log(`\n  subject: ${subject}`);

  // And with the condition switched off, the email must go back to normal.
  const [n] = db.getConditionalNotes({ account: 'CW' });
  db.updateConditionalNote(n.id, { enabled: false });
  eq('disabled → nothing fires', resolveConditionalNotes(grid, db.getConditionalNotes({ account: 'CW', enabledOnly: true })).length, 0);
}

console.log(`\n── the same email for a site with no note (regression) ──────────────`);
{
  const plain = buildEmail({
    websiteUrl: 'example.test', reportMonth: { monthLower: 'september', year: 2026 },
    reportHtml: '<p>x</p>', hasAdditionalIssues: false, hasPremiumPlugins: false,
    conditionalNotes: resolveConditionalNotes([['nothing here']], db.getConditionalNotes({ account: 'CW', enabledOnly: true })),
  }).html;
  check('no note → no audit paragraph', !plain.includes('ADA accessibility audit'));
  check('no note → no stray link', !plain.includes('docs.google.com'));
  eq('no note → still exactly one sign-off', (plain.match(/Best Regards,/g) || []).length, 1);
}

fs.rmSync(TMP_DATA, { recursive: true, force: true });

console.log(`\n${'═'.repeat(66)}`);
console.log(`  ${pass} passed, ${failures.length} failed`);
if (failures.length) for (const f of failures) console.log(`    - ${f}`);
process.exit(failures.length ? 1 : 0);
