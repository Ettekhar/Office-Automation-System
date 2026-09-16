/**
 * test-development-columns.mjs — regression test for the Development-Date /
 * Development-Updates columns (Dev Tracker sheet columns C/D).
 *
 * What this locks down (all were broken or absent before):
 *   1. fetchDevTrackerSheetData's parser keeps devDate/devNotes per row (the
 *      shape every consumer depends on) — checked against the stored
 *      data/dev-projects.json snapshot so it needs no network.
 *   2. summarizeProject() exposes devLog (Development entries) separately.
 *   3. The chat "development" intent answers a per-project AND a global
 *      development question from those columns.
 *   4. A project overview always shows the Development block.
 *   5. Older intents still win where they should ("feedback", "latest",
 *      "pending") — the development regex must not hijack them.
 *
 * Run: node scripts/test-development-columns.mjs
 */

import fs from 'node:fs';
import { answerDevQuestionBuiltin, summarizeProject, buildDevOverview } from '../src/devAssistant.js';
import {
  resolveDevTrackerColumns,
  devTrackerRowWidth,
  buildDevTrackerRowForLayout,
} from '../src/sheets.js';

const projects = JSON.parse(fs.readFileSync(new URL('../data/dev-projects.json', import.meta.url), 'utf8'));

let failures = 0;
const check = (label, cond, extra = '') => {
  console.log(`${cond ? '  PASS' : '  FAIL'}  ${label}${extra ? ` — ${extra}` : ''}`);
  if (!cond) failures++;
};

const ask = (q) => answerDevQuestionBuiltin(q, projects);

// ── 0. per-tab layout resolution (pure functions, no network) ────────────────
// The spreadsheet holds BOTH layouts; a fixed-position parser corrupted the old
// tabs (Feedback URL read as devDate, Date as devNotes, Notes never read, and
// auto-suggested range in the wrong place).
console.log('\n=== 0. Header-driven column resolution (both layouts) ===');

const OLD_HEADERS = ['URL', 'Status', 'Feedbacks URL', 'Date', 'Note/Updates'];
const NEW_HEADERS = ['URL', 'Status', 'Development--Date', 'Development--Updates', 'Feedbacks URL', 'Feedback--Date', 'Feedbacks -- Note/Updates'];

const oldCols = resolveDevTrackerColumns(OLD_HEADERS);
const newCols = resolveDevTrackerColumns(NEW_HEADERS);

check('OLD layout → feedbackUrl=2, date=3, notes=4',
  oldCols.feedbackUrl === 2 && oldCols.date === 3 && oldCols.notes === 4,
  JSON.stringify(oldCols));
check('OLD layout → no development columns (devDate/devNotes = -1)',
  oldCols.devDate === -1 && oldCols.devNotes === -1,
  `devDate=${oldCols.devDate} devNotes=${oldCols.devNotes}`);
check('NEW layout → devDate=2, devNotes=3, feedbackUrl=4, date=5, notes=6',
  newCols.devDate === 2 && newCols.devNotes === 3 && newCols.feedbackUrl === 4 && newCols.date === 5 && newCols.notes === 6,
  JSON.stringify(newCols));
check('NEW layout "development date" never mistaken for feedback "Date"', newCols.date !== newCols.devDate);
check('row width follows the tab layout', devTrackerRowWidth(oldCols) === 5 && devTrackerRowWidth(newCols) === 7,
  `${devTrackerRowWidth(oldCols)} / ${devTrackerRowWidth(newCols)}`);
check('unreadable header row → null (caller falls back to 7-col default)',
  resolveDevTrackerColumns([]) === null && resolveDevTrackerColumns(['', '']) === null);

// Writes must land in the tab's own columns — an OLD tab must NOT be shifted.
const oldRow = buildDevTrackerRowForLayout(oldCols, {
  url: 'u', status: 'Completed', devDate: 'DEV-DATE', devNotes: 'DEV-NOTES', feedbackUrl: 'fb', date: '2026-01-02', notes: 'n',
});
check('OLD row has 5 cells and no development values written', oldRow.length === 5 && !oldRow.includes('DEV-DATE') && !oldRow.includes('DEV-NOTES'),
  JSON.stringify(oldRow));
check('OLD row keeps feedback values in C/D/E (no 2-column shift)',
  oldRow[2] === 'fb' && oldRow[3] === '2026-01-02' && oldRow[4] === 'n', JSON.stringify(oldRow));

const newRow = buildDevTrackerRowForLayout(newCols, {
  url: 'u', status: 'Completed', devDate: '2026-09-15', devNotes: 'All done', feedbackUrl: 'fb', date: '2026-01-02', notes: 'n',
});
check('NEW row has 7 cells with development values at C/D',
  newRow.length === 7 && newRow[2] === '2026-09-15' && newRow[3] === 'All done', JSON.stringify(newRow));
check('NEW row keeps feedback values at E/F/G',
  newRow[4] === 'fb' && newRow[5] === '2026-01-02' && newRow[6] === 'n', JSON.stringify(newRow));

// ── 1. parser shape ──────────────────────────────────────────────────────────
console.log('\n=== 1. Parsed devDate/devNotes present on items ===');
const reitz = projects.find((p) => /reitz/i.test(p.project));
const house = projects.find((p) => /house/i.test(p.project));
check('Reitz Union project found', !!reitz);
const reitzRow2 = reitz?.items?.find((it) => it.rowNum === 2);
check('Reitz row 2 has devDate (sheet col C)', !!reitzRow2?.devDate, reitzRow2?.devDate);
check('Reitz row 2 has devNotes (sheet col D)', !!reitzRow2?.devNotes, reitzRow2?.devNotes);
check('every item carries the devDate/devNotes keys',
  projects.every((p) => (p.items || []).every((it) => 'devDate' in it && 'devNotes' in it)));
check('The House project found', !!house);
const houseDev = (house?.items || []).filter((it) => String(it.devNotes || '').trim());
console.log(`  INFO  The House rows with Development-Updates filled in the sheet: ${houseDev.length}`
  + (houseDev.length ? '' : '  (sheet columns C/D are empty for this tab — type them in the sheet, then Refresh Sheet)'));

// ── 2. devLog ───────────────────────────────────────────────────────────────
console.log('\n=== 2. summarizeProject().devLog ===');
const reitzSum = summarizeProject(reitz);
check('devLog exists and only holds Development-group entries',
  Array.isArray(reitzSum.devLog) && reitzSum.devLog.every((w) => w.group === 'Development'));
check('devLog is non-empty for Reitz Union', reitzSum.devLog.length > 0, `${reitzSum.devLog.length} entries`);
check('devLog entries carry the dev note text',
  reitzSum.devLog.some((w) => String(w.notes || '').length > 0));

// ── 3. chat intent ───────────────────────────────────────────────────────────
console.log('\n=== 3. Chat answers "development" questions ===');
for (const q of [
  'development updates for Reitz Union',
  'development notes for Reitz Union',
  'what did we develop on Reitz Union',
  'dev updates for reitz union',
]) {
  const r = ask(q);
  const ok = r.intent === 'development' && /Development updates/i.test(r.answer);
  check(`intent=development for "${q}"`, ok, `got intent=${r.intent}`);
  if (ok && r.answer.includes('All the pages are completed')) {
    console.log('       ↳ quoted the real sheet value: "All the pages are completed"');
  }
}

// A bare single-word project guess ("Reitz") is below the matcher's
// confidence bar and intentionally lands in the existing clarify path — assert
// it degrades gracefully instead of crashing or answering from the wrong data.
const bare = ask('development notes Reitz');
check('bare single-word project name degrades gracefully (answer or clarify)',
  !!bare.answer && ['development', 'clarify'].includes(bare.intent), `got intent=${bare.intent}`);

const glob = ask('development updates');
check('global development question → development intent', glob.intent === 'development', `got ${glob.intent}`);

// ── 4. overview visibility ───────────────────────────────────────────────────
console.log('\n=== 4. Project overview shows the Development block ===');
const ov = ask('what is the update of Reitz Union?');
check('project overview intent unchanged', ov.intent === 'project-overview', `got ${ov.intent}`);
check('overview contains the 🛠 Development updates block', ov.answer.includes('Development updates'));

// ── 5. no intent hijacking ───────────────────────────────────────────────────
console.log('\n=== 5. Existing intents still win ===');
const cases = [
  ['what is the feedback for Reitz Union', 'feedback'],
  ['latest updates', 'latest'],
  ['what is still pending on Reitz Union', 'pending'],
  ['how many pages does Reitz Union have', 'counts'],
  ['overall progress', 'overview'],
];
for (const [q, want] of cases) {
  const r = ask(q);
  check(`"${q}" → ${want}`, r.intent === want, `got ${r.intent}`);
}

// ── 6. overview totals sane ──────────────────────────────────────────────────
console.log('\n=== 6. Overview totals untouched by the change ===');
const b = buildDevOverview(projects);
check('projects counted', b.totals.projects === projects.length, `${b.totals.projects}`);
check('devLog does not inflate page counts',
  b.totals.pages === projects.reduce((n, p) => n + summarizeProject(p).pages, 0));

console.log(`\n${failures ? `❌ ${failures} FAILURE(S)` : '✅ ALL CHECKS PASSED'}`);
process.exit(failures ? 1 : 0);