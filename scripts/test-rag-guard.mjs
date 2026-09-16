/**
 * test-rag-guard.mjs — unit proof of the numeric grounding guard.
 *
 * The guard must (a) catch fabricated figures, and (b) NOT reject legitimate
 * answers that merely mention identifiers like "gpt-oss-120b" or version slugs
 * like "gemini-3.6-flash".
 *
 * Usage: node scripts/test-rag-guard.mjs
 */
import fs from 'node:fs';
import { buildRagContext, verifyGrounded } from '../src/devAssistant.js';

const projects = JSON.parse(fs.readFileSync(new URL('../data/dev-projects.json', import.meta.url), 'utf8'));
const q = 'how many pages does Reitz Union have and how many feedback rounds?';
const ctx = buildRagContext(q, projects, { rag: {} }).context;
console.log('context chars: ' + ctx.length + '\n');

const cases = [
  ['legit + identifier (gpt-oss-120b)', 'Reitz Union has 14 pages and 2 feedback rounds. [model gpt-oss-120b]', true],
  ['legit + version slug (gemini-3.6-flash)', 'Reitz Union: 14/14 pages completed, 2 rounds. Answered by gemini-3.6-flash.', true],
  ['legit plain', 'Reitz Union: 14 pages, 14 completed, 100% ready, 2 feedback rounds.', true],
  ['FABRICATED page count', 'Reitz Union has 99 pages, all completed.', false],
  ['FABRICATED rounds', 'Reitz Union has 7 feedback rounds.', false],
  ['FABRICATED total', 'Reitz Union completed 250 pages in 12 rounds.', false],
  ['FABRICATED readiness', 'Reitz Union is only 45% ready.', false],
];

let pass = 0;
for (const [name, answer, expectOk] of cases) {
  const v = verifyGrounded(answer, ctx);
  const good = v.ok === expectOk;
  if (good) pass++;
  console.log((good ? 'PASS ' : 'FAIL ') + String(name).padEnd(42, '.') +
    ' ok=' + v.ok + ' (expected ' + expectOk + ') checked=' + v.checked +
    ' ungrounded=' + JSON.stringify(v.ungrounded));
  console.log('      answer: ' + answer);
}
console.log('\n' + pass + '/' + cases.length + ' guard cases behaved as expected');