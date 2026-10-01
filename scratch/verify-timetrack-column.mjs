/** The mailer's new Time Track column: the resolved header, not a fixed index. */
import assert from 'assert';
import { detectColumns, findHeaderRow } from '../src/reportUtils.js';

let pass = 0, fail = 0;
const eq = (label, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; console.log(`  ok     ${label}`); }
  else { fail++; console.log(`  FAIL   ${label}\n           got  ${g}\n           want ${w}`); }
};

// The real header rows, read from each live sheet. Their column ORDER differs —
// which is the entire reason a fixed index would be wrong.
const CW = ['si', 'CMS', 'Company', 'Contact', 'A/C Manager', 'Note', 'Website URL',
  'Maintenance time tracking ClickUp URL', 'Maintenance Task ClickUp URL',
  'Maintenance Report URL', 'Backup URL', 'March 22', 'April 22'];
const RM = ['', 'CMS', 'Company', 'Contact', 'A/C Manager', 'Website URL',
  'Maintenance time tracking ClickUp URL', 'Maintenance Task ClickUp Link',
  'March 22', 'April 22', 'May 22'];

const cw = detectColumns(CW);
const rm = detectColumns(RM);

console.log('resolved by header name, not position');
eq('CW finds the time-track column at index 7', cw.TIME_TRACK_URL, 7);
eq('RM finds it at index 6 — a different column', rm.TIME_TRACK_URL, 6);
eq('  …so the two sheets genuinely disagree, as read live',
  cw.TIME_TRACK_URL === rm.TIME_TRACK_URL, false);

console.log('a sheet with no such column resolves to -1');
const NONE = ['si', 'CMS', 'Company', 'Contact', 'A/C Manager', 'Note', 'Website URL', 'March 22'];
eq('missing column resolves to -1', detectColumns(NONE).TIME_TRACK_URL, -1);
eq('  …and the neighbouring columns still resolve', detectColumns(NONE).WEBSITE_URL, 6);

console.log('the index points at the time-track CELL, not a neighbour');
// These read the fixture row through the RESOLVED index, so a wrong index
// returns a different cell's value and fails. The read expression itself
// (String(...).trim()) is duplicated from dashboardApi.js, so anything about
// that expression is only genuinely covered by verify-timetrack-live.mjs, which
// drives the real function. This suite owns the INDEX question alone.
const cwRow = ['Active', 'WordPress', 'Acme', 'a@b.com', 'Jo', 'note', 'acme.test',
  'https://app.clickup.com/t/8687wvcgm', 'https://app.clickup.com/t/868j7v43c',
  'https://docs.google.com/…', 'https://backup/…', 'DONE', ''];
eq('CW index 7 is the time-track cell', cwRow[cw.TIME_TRACK_URL], 'https://app.clickup.com/t/8687wvcgm');
eq('  …and NOT the task link at 8', cwRow[cw.TIME_TRACK_URL + 1], 'https://app.clickup.com/t/868j7v43c');
eq('  …a hardcoded 7 would have been right for CW by luck',
  cwRow[7], cwRow[cw.TIME_TRACK_URL]);

// The decisive case. On the RM layout a hardcoded 7 lands on
// "Maintenance Task ClickUp Link" — a different thing entirely, and a plausible
// looking link that would be confidently wrong.
const rmRow = ['', 'WordPress', 'Acme', 'a@b.com', 'Jo', 'rm-site.test', '',
  'https://app.clickup.com/t/SHOULD-NOT-SHOW', 'DONE'];
eq('RM index 6 is the time-track cell', rmRow[rm.TIME_TRACK_URL], '');
eq('  …and a hardcoded 7 returns the Task link there',
  rmRow[7], 'https://app.clickup.com/t/SHOULD-NOT-SHOW');
eq('  …so the two sheets must not share an index', rm.TIME_TRACK_URL === 7, false);
const rmRow2 = [...rmRow];
rmRow2[6] = 'https://app.clickup.com/t/8687wvcgm';
eq('RM reads its own value when the cell is filled', rmRow2[rm.TIME_TRACK_URL], 'https://app.clickup.com/t/8687wvcgm');

console.log('the first month column is not shifted by the new read');
eq('CW first month col', cw.FIRST_MONTH_COL, 11);
eq('RM first month col', rm.FIRST_MONTH_COL, 8);

console.log('header detection still finds the header row with the column present');
const rows = [['junk'], CW, ['Active', 'WordPress', 'Acme']];
eq('header row index', findHeaderRow(rows).headerRowIndex, 1);

console.log('\n' + (fail ? 'FAILED' : 'passed') + ` ${pass} passed, ${fail} failed`);
assert.equal(fail, 0, `${fail} failing`);
