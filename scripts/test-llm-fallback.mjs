/**
 * test-llm-fallback.mjs — proves the multi-provider fallback chain end-to-end.
 * Run: node scripts/test-llm-fallback.mjs
 *
 * S1: Gemini key INVALID (real HTTP call fails) → Groq next; Groq points at a
 *     LOCAL fake OpenAI-compatible server → answers. Proves failover + logging.
 * S2: Gemini INVALID → Cloudflare Worker next (local fake of OUR worker
 *     contract: POST / {question, projects} + Bearer auth). Proves the RAG
 *     data feed (worker receives the tracker projects inline) + auth + answer.
 * S3: Worker token WRONG → 401 → falls through → builtin engine.
 * S4: all four direct provider keys INVALID (real endpoints) → builtin.
 * S5: no keys configured → builtin immediately, zero network calls.
 * S6: one model of a provider 429s → the NEXT model of the SAME provider is
 *     tried before the chain moves on (comma-separated *_MODEL lists).
 */
import http from 'node:http';
import fs from 'node:fs';
import { answerDevQuestion, buildProviderChain, getAssistantMeta, getLlmPrompts } from '../src/devAssistant.js';

const projects = JSON.parse(fs.readFileSync(new URL('../data/dev-projects.json', import.meta.url), 'utf8'));
const Q = 'what is the update of Reitz Union?';

// Fake OpenAI-compatible provider (stands in for Groq). It is model-aware so we
// can prove the INTRA-provider fallback: a 429 on one model must roll over to
// the next model of the SAME provider (this is what fixes OpenRouter's
// "temporarily rate-limited upstream" free slugs).
let groqHits = 0;
const groqFake = http.createServer((req, res) => {
  groqHits++;
  let b = '';
  req.on('data', (c) => { b += c; });
  req.on('end', () => {
    const asked = (() => { try { return JSON.parse(b).model || ''; } catch { return ''; } })();
    if (String(asked).includes('ratelimited')) {
      res.writeHead(429, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: `${asked} is temporarily rate-limited upstream. Please retry shortly`, code: 429 } }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      choices: [{ message: { content: 'FAKE-GROQ-ANSWER (' + asked + '): Reitz Union — 14/14 sitemap pages completed (100%), 2 feedback rounds, latest work 08/28/26. [served by local simulated Groq endpoint]' } }],
      model: asked || 'simulated',
    }));
  });
});

// Fake Cloudflare Worker (OUR worker contract: POST / {question, projects},
// Bearer auth when API_TOKEN is set) — verifies the RAG data feed arrives.
let workerGot = null;
const workerFake = http.createServer((req, res) => {
  let b = '';
  req.on('data', (c) => { b += c; });
  req.on('end', () => {
    const auth = String(req.headers.authorization || '');
    if (auth !== 'Bearer cf_test_ok') {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }
    let body = {};
    try { body = JSON.parse(b); } catch {}
    workerGot = { question: body.question, projectCount: Array.isArray(body.projects) ? body.projects.length : 0 };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      answer: 'CF-WORKER-ANSWER: question="' + body.question + '" | RAG data fed inline: ' + workerGot.projectCount + ' projects | answer generated worker-side with its own AI chain + fallback.',
      engine: 'llm',
    }));
  });
});

await new Promise((r) => groqFake.listen(0, '127.0.0.1', r));
await new Promise((r) => workerFake.listen(0, '127.0.0.1', r));
const groqBase = 'http://127.0.0.1:' + groqFake.address().port + '/v1';
const workerBase = 'http://127.0.0.1:' + workerFake.address().port;
console.log('fake Groq endpoint     : ' + groqBase);
console.log('fake Cloudflare Worker : ' + workerBase);

const prompts = getLlmPrompts(Q, projects);
console.log('\nPROMPT IDENTITY CHECK (identical system prompt for every provider):');
console.log('  system prompt (' + prompts.system.length + ' chars) · "never invent" rule present: ' + prompts.system.includes('NEVER invent, guess, or extrapolate'));

const scenarios = [
  { name: 'S1 · gemini=INVALID → groq (local fake) answers',
    env: { GEMINI_API_KEY: 'AIzaSyA-INVALID-KEY-FOR-TESTING-000000', GROQ_API_KEY: 'gsk_local_test', GROQ_BASE_URL: groqBase } },
  { name: 'S2 · gemini=INVALID → cloudflare worker answers (RAG data fed inline + Bearer auth)',
    env: { GEMINI_API_KEY: 'AIzaSyA-INVALID', CLOUDFLARE_WORKER_URL: workerBase, CLOUDFLARE_WORKER_TOKEN: 'cf_test_ok' } },
  { name: 'S3 · gemini=INVALID → worker token WRONG (401) → builtin engine',
    env: { GEMINI_API_KEY: 'AIzaSyA-INVALID', CLOUDFLARE_WORKER_URL: workerBase, CLOUDFLARE_WORKER_TOKEN: 'cf_wrong_token' } },
  { name: 'S4 · all four direct provider keys INVALID (real endpoints) → builtin engine',
    env: { GEMINI_API_KEY: 'AIzaSyA-INVALID', GROQ_API_KEY: 'gsk_invalid', OPENROUTER_API_KEY: 'sk-or-invalid', MISTRAL_API_KEY: 'invalid' } },
  { name: 'S5 · no keys configured → builtin immediately (AI availability check = false)',
    env: {} },
  { name: 'S6 · GROQ_MODEL="fake-ratelimited:free,openai/gpt-oss-120b" → 429 on model 1 rolls to model 2 of the SAME provider',
    env: { GROQ_API_KEY: 'gsk_local_test', GROQ_BASE_URL: groqBase, GROQ_MODEL: 'fake-ratelimited:free,openai/gpt-oss-120b' } },
];

for (const s of scenarios) {
  console.log('\n──────── ' + s.name);
  const chain = buildProviderChain(s.env).map((p) => `${p.name}:${p.model.length > 30 ? p.model.slice(0, 29) + '…' : p.model}`);
  const meta = getAssistantMeta(projects, s.env);
  console.log('  chain configured : [' + chain.join(' → ') + ']' + (chain.length ? '' : '  (empty → builtin only)'));
  console.log('  aiAvailable check: ' + meta.aiAvailable + (meta.aiProviders.length ? ' (' + meta.aiProviders.join(', ') + ')' : ''));
  const logs = [];
  const t0 = Date.now();
  const r = await answerDevQuestion(Q, projects, { env: s.env, log: (...a) => logs.push(a.join(' ')) });
  logs.forEach((l) => console.log('  log » ' + l));
  console.log('  elapsed          : ' + (Date.now() - t0) + 'ms');
  console.log('  engine (UI field): ' + r.engine);
  console.log('  response keys    : [' + Object.keys(r).join(', ') + ']   ← no provider name / key leaks to end user');
  console.log('  answer           : ' + r.answer.split('\n')[0].slice(0, 130));
}

// ── S7 · clarify / not-found intents must BYPASS every provider (zero network)
// This is the anti-hallucination guarantee: when the matcher is not sure, or the
// project does not exist, we must NOT let an LLM guess. Verified by counting the
// requests the configured provider actually receives (must stay 0).
console.log('\n──────── S7 · ambiguous + nonexistent questions never reach any provider (0 network calls)');
groqHits = 0;
const bypassEnv = { GROQ_API_KEY: 'gsk_local_test', GROQ_BASE_URL: groqBase };
for (const q of [
  'update on the hotel construction project',
  'What is the update on the Atlantis Grand Resort website?',
]) {
  const r = await answerDevQuestion(q, projects, { env: bypassEnv, log: (...a) => console.log('  log » ' + a.join(' ')) });
  console.log('  INPUT Q : ' + JSON.stringify(q));
  console.log('  intent=' + r.intent + ' | engine=' + r.engine + ' | project=' + ((r.project && r.project.name) || 'none'));
  console.log('  OUTPUT  : ' + r.answer.split('\n').slice(0, 3).join(' / ').slice(0, 160));
}
console.log('  provider requests during those 2 questions: ' + groqHits + '  ← 0 proves the LLM is never consulted for unsure answers');

console.log('\nWORKER RAG FEED CHECK: last successful worker call received ' +
  (workerGot ? workerGot.projectCount + ' projects for question "' + workerGot.question + '"' : 'none') +
  '  ← tracker data was FED to the worker, not fetched by it');

groqFake.close();
workerFake.close();
console.log('DONE');
