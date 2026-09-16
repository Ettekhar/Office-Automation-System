/**
 * Which OpenRouter :free models actually answer right now?
 * Free slugs get "temporarily rate-limited upstream" (429) independently,
 * so this finds live ones to put in OPENROUTER_MODEL as a fallback list.
 *
 * Run:  node scripts/probe-openrouter-free.mjs
 */
import 'dotenv/config';

const MODELS = [
  'google/gemma-4-31b-it:free',
  'google/gemma-4-26b-a4b-it:free',
  'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free',
  'nvidia/nemotron-3-super-120b-a12b:free',
  'nvidia/nemotron-3.5-lightning:free',
  'inclusionai/ling-3.0-flash-vl:free',
  'cohere/north-mini-code:free',
  'thinkingmachines/inkling:free',
  'thinkingmachines/inkling-small:free',
  'poolside/laguna-s-2.1:free',
  'poolside/laguna-xs-2.1:free',
  'liquid/lfm-2.5-2.6b:free',
  'nex-agi/nex-n2.5-pro:free',
  'nex-agi/nex-n2.5-mini:free',
  'dots-studio/dots-3-note-preview:free',
];

const KEY = process.env.OPENROUTER_API_KEY;
const cut = (s, n = 150) => String(s ?? '').replace(/\s+/g, ' ').slice(0, n);

(async () => {
  if (!KEY) return console.log('OPENROUTER_API_KEY not set');
  console.log(`probe start — ${MODELS.length} free models, 15s timeout each\n`);
  for (const model of MODELS) {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), 15000);
    const started = Date.now();
    try {
      const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${KEY}`,
          'HTTP-Referer': process.env.OPENROUTER_SITE_URL || 'https://officeos.local',
          'X-Title': 'OfficeOS Dev Assistant',
        },
        signal: c.signal,
        body: JSON.stringify({ model, messages: [{ role: 'user', content: 'Reply with exactly: OK' }], max_tokens: 200 }),
      });
      const j = await res.json().catch(() => ({}));
      const ms = Date.now() - started;
      const txt = String(j?.choices?.[0]?.message?.content || '').trim();
      const verdict = res.status === 200 && txt ? 'WORKS' : res.status === 429 ? '429' : 'FAIL';
      console.log(`${verdict.padEnd(6)} ${model.padEnd(56)} HTTP ${res.status} ${ms}ms ${cut(j.error ? JSON.stringify(j.error) : txt, 110)}`);
    } catch (e) {
      console.log(`ERR    ${model.padEnd(56)} ${cut(e.name === 'AbortError' ? 'timeout 15s' : e.message, 110)}`);
    } finally {
      clearTimeout(t);
    }
  }
  console.log('\nprobe done');
})();