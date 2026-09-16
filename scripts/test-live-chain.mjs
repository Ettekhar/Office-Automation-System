/**
 * test-live-chain.mjs — end-to-end proof with the REAL .env keys.
 *
 * Asks real tracker questions through the real provider chain and prints which
 * provider/model answered (server-side log line), the latency, and the answer.
 * If every provider fails you will see the fallback lines and engine=builtin.
 *
 * Run:  node scripts/test-live-chain.mjs
 */
import 'dotenv/config';
import fs from 'node:fs';
import { answerDevQuestion, buildProviderChain, getAssistantMeta } from '../src/devAssistant.js';

const projects = JSON.parse(fs.readFileSync(new URL('../data/dev-projects.json', import.meta.url), 'utf8'));
const QUESTIONS = [
  'what is the update of Reitz Union?',
  'how many feedback rounds does Nines Hotel have?',
  'overall progress',
];

const meta = getAssistantMeta(projects, process.env);
console.log('AI CHECK: aiAvailable=' + meta.aiAvailable + ' | providers=[' + meta.aiProviders.join(', ') + ']');
console.log('chain    : ' + (buildProviderChain(process.env).map((p) => p.name + ':' + p.model).join('\n           → ') || '(none)'));
console.log('');

for (const q of QUESTIONS) {
  const logs = [];
  const t0 = Date.now();
  const r = await answerDevQuestion(q, projects, { env: process.env, log: (...a) => logs.push(a.join(' ')) });
  console.log('INPUT Q : ' + q);
  logs.forEach((l) => console.log('  log » ' + l));
  console.log('  elapsed: ' + (Date.now() - t0) + 'ms | engine=' + r.engine + ' | intent=' + r.intent);
  console.log('  ANSWER : ' + r.answer.replace(/\n/g, '\n           '));
  console.log('');
}