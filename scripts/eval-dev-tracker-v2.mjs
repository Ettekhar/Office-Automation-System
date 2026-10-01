/**
 * Live, sheet-only acceptance test for Dev Tracker Agent Eval Set v2.
 * ClickUp is intentionally excluded until a token with workspace access exists.
 */
import { fetchDevTrackerSheetData } from '../src/sheets.js';
import { answerDevQuestionBuiltin } from '../src/devAssistant.js';

const projects = await fetchDevTrackerSheetData({ forceRefresh: true });
const ask = (question) => answerDevQuestionBuiltin(question, projects).answer;
const results = [];
const expect = (id, question, predicate) => {
  const answer = ask(question);
  const pass = predicate(answer);
  results.push({ id, question, pass, answer });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${id}. ${question}`);
  if (!pass) console.log(`  ${answer.replace(/\n/g, ' ')}`);
};

expect(1, 'What is the status of the events-happenings page on The House?', (a) => /In Progress/.test(a) && /only non-completed sitemap row/i.test(a));
expect(2, 'How many open items are there across all 6 projects right now?', (a) => /1 item across 1 project/.test(a) && /The House/.test(a));
expect(3, 'Which projects currently have open or pending items?', (a) => /The House/.test(a) && !/Nines Hotel.*open/i.test(a));
expect(4, 'Is Nines Hotel fully completed?', (a) => /Nines Hotel is fully completed/.test(a) && /32/.test(a));
expect(5, 'What was the latest Development update on The House?', (a) => /Gallery and policy pages/i.test(a) && /09\/17\/26/.test(a));
expect(6, 'What was the latest Development update on Reitz Union?', (a) => /All the pages are completed/.test(a) && /09\/15\/26/.test(a));
expect(7, 'What is the feedback date format difference between The House and Reitz Union?', (a) => /DD\/MM\/YY/.test(a) && /03\/09\/26/.test(a) && /YYYY-MM-DD/.test(a) && /2026-08-28/.test(a));
expect(8, 'Does Bunting& Murray Construction have a Date and Note/Updates for its first row?', (a) => /both fields are blank/i.test(a));
expect(9, 'Are there any feedback links that cannot be fetched automatically, and why?', (a) => /AnsAngel coalition/.test(a) && /Gmail inbox thread/.test(a) && /interactive Google login/.test(a));
expect(10, 'List all real non-label Feedback URLs found for Nines Hotel', (a) => (a.match(/https:\/\/docs\.google\.com\/document\/d\//g) || []).length === 2 && !/Feedback-1 URL`/.test(a));
expect(11, 'Does Sara Paris Booth still match the correct tab?', (a) => /Sara Paris  Booth/.test(a));
expect(12, 'What feedback round labels exist for Sara Paris Booth and do they use consistent spacing?', (a) => /Feedback-1 URL/.test(a) && /Feedback-2URL/.test(a) && /inconsistent spacing/i.test(a));

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} Eval Set v2 checks passed`);
if (failed.length) process.exitCode = 1;
