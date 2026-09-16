/**
 * test-typo-smooth.mjs — proves the "smooth answer" behaviour for misspelled
 * project names: the assistant answers with the data immediately instead of
 * asking "are you looking for X?" and making the user re-prompt.
 *
 * Run: node scripts/test-typo-smooth.mjs
 */
import fs from 'node:fs';
import { answerDevQuestion, rankProjects } from '../src/devAssistant.js';

const projects = JSON.parse(fs.readFileSync(new URL('../data/dev-projects.json', import.meta.url), 'utf8'));
const env = { LLM_DISABLE: '1' }; // deterministic builtin → shows matching logic exactly

const cases = [
  ['misspelled first word (reiz)', 'what is the update of reiz union?', 'project answer'],
  ['short typo (riz)', 'update on riz union', 'project answer'],
  ['truncated (reit)', 'reit union status', 'project answer'],
  ['transposed letters (unoin)', 'reitz unoin update', 'project answer'],
  ['all lowercase', 'the house update', 'project answer'],
  ['genuinely ambiguous', 'update on the hotel construction project', 'clarify'],
  ['unknown + known word', 'update on Mars Hotel', 'assumed answer'],
  ['unknown project', 'What is the update on the Atlantis Grand Resort website?', 'not-found'],
];

let pass = 0;
for (const [label, q, expect] of cases) {
  const ranked = rankProjects(q, projects).filter((r) => r.score > 0);
  const top = ranked[0];
  const r = await answerDevQuestion(q, projects, { env });
  const got = ['clarify', 'not-found'].includes(r.intent) ? r.intent : (top?.assumed ? 'assumed answer' : 'project answer');
  const ok = got === expect;
  if (ok) pass++;
  console.log((ok ? 'PASS ' : 'FAIL ') + String(label).padEnd(30, '.') + ' expected=' + expect.padEnd(15) + ' got=' + got + '  (intent=' + r.intent + ')');
  console.log('   Q: ' + q);
  if (top) console.log('   matcher: ' + top.name + ' score=' + top.score.toFixed(2) + ' margin=' + (top.margin ?? 0).toFixed(2) + ' kinds=[' + top.kinds.join(',') + '] assumed=' + !!top.assumed);
  console.log('   A:');
  console.log(String(r.answer).split('\n').map((l) => '      ' + l).join('\n'));
  console.log('');
}
console.log(pass + '/' + cases.length + ' cases behaved as expected');
