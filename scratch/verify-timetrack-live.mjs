/**
 * E22 — the mailer's Time Track column, proven against the deployed code path.
 *
 * Drives the real `getOverviewData` from src/dashboardApi.js. The only thing
 * swapped is `src/sheets.js`, redirected to a fixture via a resolve hook, so
 * every claim below is a claim about the shipped code — not a reimplementation.
 * The fixture serves the two real master-tab layouts, which put the time-track
 * column at DIFFERENT indexes (CW 7, RM 6).
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import assert from 'assert';
import { register } from 'module';
import { fileURLToPath, pathToFileURL } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-tt-live-'));
process.env.OFFICEOS_DATA_DIR = TMP;
process.env.MM_FAKE_SHEETS = pathToFileURL(path.join(ROOT, 'scratch', 'fixture-sheets-time-track.mjs')).href;

register(pathToFileURL(path.join(ROOT, 'scratch', 'redirect-sheets-module.mjs')));

let pass = 0, fail = 0;
const eq = (label, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; console.log(`  ok     ${label}`); }
  else { fail++; console.log(`  FAIL   ${label}\n           got  ${g}\n           want ${w}`); }
};
const check = (label, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ok     ${label}`); }
  else { fail++; console.log(`  FAIL   ${label}${extra ? `\n           ${extra}` : ''}`); }
};

// The fixture accounts, so the fake sheets.js can tell CW from RM by id.
process.env.CW_SPREADSHEET_ID = 'cw-fake';
process.env.RM_SPREADSHEET_ID = 'rm-fake';

const { getOverviewData } = await import(pathToFileURL(path.join(ROOT, 'src', 'dashboardApi.js')).href);
const fake = await import(process.env.MM_FAKE_SHEETS);

console.log('the deployed overview carries the time-track URL per site');
const data = await getOverviewData('May 22', 'all');
const byUrl = Object.fromEntries(data.sites.map((s) => [s.websiteUrl, s]));

eq('all four fixture sites are present', data.sites.length, 4);
check('every site has a timeTrackUrl key', data.sites.every((s) => 'timeTrackUrl' in s));

eq('CW site, filled cell', byUrl['cw-filled.test'].timeTrackUrl, 'https://app.clickup.com/t/8687wvcgm');
eq('CW site, blank cell', byUrl['cw-blank.test'].timeTrackUrl, '');
eq('RM site, filled cell', byUrl['rm-filled.test'].timeTrackUrl, 'https://app.clickup.com/t/868wvcgm');
eq('RM site, blank cell', byUrl['rm-blank.test'].timeTrackUrl, '');

console.log('the decisive case: a fixed index would read the wrong column on RM');
check('RM blank cell did NOT pick up the neighbouring Task link',
  byUrl['rm-blank.test'].timeTrackUrl !== 'https://app.clickup.com/t/SHOULD-NOT-SHOW',
  `got "${byUrl['rm-blank.test'].timeTrackUrl}"`);
check('CW filled cell is the time-track link, not the task link',
  byUrl['cw-filled.test'].timeTrackUrl === 'https://app.clickup.com/t/8687wvcgm');

console.log('both accounts were read, each at its own index');
check('CW sheet was fetched', fake.CALLS.getTabValues.some((c) => String(c.spreadsheetId) === 'cw-fake'));
check('RM sheet was fetched', fake.CALLS.getTabValues.some((c) => String(c.spreadsheetId) === 'rm-fake'));
eq('the time-track column index differs per account',
  ['CW', 'RM'].map((a) => byUrl[`${a.toLowerCase()}-filled.test`].timeTrackUrl), [
    'https://app.clickup.com/t/8687wvcgm',
    'https://app.clickup.com/t/868wvcgm',
  ]);

console.log('a sheet that predates the column still yields a blank cell');
fake.setLayout({ dropColumn: true });
const noCol = await getOverviewData('May 22', 'CW');
const noColSites = Object.fromEntries(noCol.sites.map((s) => [s.websiteUrl, s]));
eq('the site still appears in the list', noCol.sites.length, 2);
eq('  …with a blank time track, NOT the column that shifted into the gap',
  noColSites['cw-filled.test'].timeTrackUrl, '');
eq('  …every site has the field', noCol.sites.every((s) => 'timeTrackUrl' in s), true);
fake.setLayout({ dropColumn: false });

console.log('a cell typed with surrounding spaces renders a usable link');
fake.setLayout({ padCells: true });
const padded = await getOverviewData('May 22', 'CW');
const paddedSites = Object.fromEntries(padded.sites.map((s) => [s.websiteUrl, s]));
eq('the padded cell is trimmed', paddedSites['cw-filled.test'].timeTrackUrl,
  'https://app.clickup.com/t/8687wvcgm');
eq('  …so the browser URL parser accepts it',
  (() => { try { return new URL(paddedSites['cw-filled.test'].timeTrackUrl).protocol; } catch { return 'unparseable'; } })(),
  'https:');
fake.setLayout({ padCells: false });

console.log('nothing else about the payload changed');
eq('total site count', data.stats.totalSites, 4);
check('every previously-existing field is still present',
  ['id', 'account', 'accountName', 'fromEmail', 'fromName', 'rowIndex', 'websiteUrl',
    'cms', 'company', 'accountManager', 'clientNote', 'statusCell', 'monthCell',
    'isActive', 'isReady', 'contacts', 'matchedTab', 'status', 'extra']
    .every((k) => k in byUrl['cw-filled.test']),
  JSON.stringify(Object.keys(byUrl['cw-filled.test'])));
eq('a per-account single-account call also works',
  (await getOverviewData('May 22', 'RM')).sites.every((s) => 'timeTrackUrl' in s), true);

fs.rmSync(TMP, { recursive: true, force: true });
console.log('\n' + (fail ? 'FAILED' : 'passed') + ` ${pass} passed, ${fail} failed`);
assert.equal(fail, 0, `${fail} failing`);
