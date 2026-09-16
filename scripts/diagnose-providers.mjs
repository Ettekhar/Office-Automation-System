/**
 * Live provider diagnostics for the Dev Assistant LLM chain.
 *
 * For every provider whose key is configured it performs a REAL
 * "list models" call and then a REAL tiny chat completion, printing the
 * literal HTTP status + body snippet. Use this when a fallback log line
 * says something like "provider groq failed (HTTP 404)" and you want to
 * know whether the key is bad or the model slug is retired.
 *
 * Run:  node scripts/diagnose-providers.mjs
 */
import 'dotenv/config';
import { buildProviderChain, PROVIDER_DEFAULTS, PROVIDER_DEFAULT_MODEL } from '../src/devAssistant.js';

// Retired / known-bad slugs kept here on purpose: seeing them flip from OK to
// FAIL (or FAIL to OK) is how you notice a provider changing its line-up.
const RETIRED = {
  gemini: ['gemini-1.5-flash', 'gemini-2.5-flash'],
  groq: ['llama-3.3-70b-versatile'],
  openrouter: ['thinkingmachines/inkling:free'],
  mistral: [],
};
// ...then every model the chain would actually try, in priority order.
const CANDIDATES = Object.fromEntries(
  Object.entries(PROVIDER_DEFAULTS).map(([k, v]) => [k, [...(RETIRED[k] || []), ...v.models]])
);

const PING_MSG = [{ role: 'user', content: 'Reply with exactly: OK' }];
const TIMEOUT = 15000;
const MAX_TOKENS = 700; // same budget the real Dev Assistant uses

const cut = (s, n = 220) => String(s ?? '').replace(/\s+/g, ' ').slice(0, n);

async function timedFetch(fn) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), TIMEOUT);
  try {
    return await fn(c.signal);
  } finally {
    clearTimeout(t);
  }
}

async function listGeminiModels(apiKey, base) {
  const res = await timedFetch((signal) => fetch(`${base}/models?key=${encodeURIComponent(apiKey)}`, { signal }));
  const j = await res.json().catch(() => ({}));
  const names = (j.models || []).map((m) => m.name.replace('models/', ''));
  return { status: res.status, body: j.error ? cut(JSON.stringify(j.error)) : `${names.length} models`, names };
}

async function listOpenAiModels({ apiKey, base, headers }) {
  const res = await timedFetch((signal) =>
    fetch(`${base}/models`, { headers: { Authorization: `Bearer ${apiKey}`, ...(headers || {}) }, signal })
  );
  const j = await res.json().catch(() => ({}));
  const names = (j.data || []).map((m) => m.id);
  return { status: res.status, body: j.error ? cut(JSON.stringify(j.error)) : `${names.length} models`, names };
}

async function pingGemini(apiKey, base, model) {
  const res = await timedFetch((signal) =>
    fetch(`${base}/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal,
      body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'Reply with exactly: OK' }] }], generationConfig: { maxOutputTokens: MAX_TOKENS } }),
    })
  );
  const j = await res.json().catch(() => ({}));
  const cand = j?.candidates?.[0] || {};
  const parts = (cand.content?.parts || []).map((x) => x.text || '').join('').trim();
  const detail = j.error
    ? cut(JSON.stringify(j.error))
    : `text="${cut(parts, 60)}" finishReason=${cand.finishReason} tokens=${JSON.stringify(j.usageMetadata?.totalTokenCount ?? '?')}`;
  return { ok: res.ok && !!parts, status: res.status, body: detail };
}

async function pingOpenAi({ apiKey, base, headers }, model) {
  const res = await timedFetch((signal) =>
    fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}`, ...(headers || {}) },
      signal,
      body: JSON.stringify({ model, messages: PING_MSG, max_tokens: MAX_TOKENS }),
    })
  );
  const j = await res.json().catch(() => ({}));
  const text = String(j?.choices?.[0]?.message?.content || '').trim();
  // HTTP 200 with an error body happens on OpenRouter (upstream provider down),
  // so a 200 status alone is not proof of a usable model.
  const embeddedError = !text && (j?.error || j?.message);
  const detail = embeddedError
    ? cut(JSON.stringify(j.error || j))
    : j.error
      ? cut(JSON.stringify(j.error))
      : `text="${cut(text, 60)}" finishReason=${j?.choices?.[0]?.finish_reason} completionTokens=${j?.usage?.completion_tokens}`;
  return { ok: res.ok && !!text, status: res.status, body: detail };
}

function mark(ok) {
  return ok ? 'OK   ' : 'FAIL ';
}

(async () => {
  console.log('════════ Dev Assistant provider diagnostics ════════\n');
  const chain = buildProviderChain();
  const byName = Object.fromEntries(chain.map((p) => [p.name, p]));
  console.log(`Provider chain from .env: [${chain.map((p) => p.name).join(' → ') || '(empty — builtin only)'}]\n`);

  for (const name of ['gemini', 'groq', 'openrouter', 'mistral']) {
    console.log(`── ${name.toUpperCase()} (default model in code: ${PROVIDER_DEFAULT_MODEL[name]})`);
    const p = byName[name];
    if (!p) {
      console.log('   key not configured → skipped in the chain\n');
      continue;
    }
    try {
      const l = p.kind === 'gemini' ? await listGeminiModels(p.apiKey, p.base) : await listOpenAiModels(p);
      console.log(`   key/endpoint : HTTP ${l.status} — ${l.body}`);
      const wanted = CANDIDATES[name] || [];
      const present = wanted.filter((m) => l.names.includes(m));
      console.log(`   model slugs  : wanted=[${wanted.join(', ')}]`);
      console.log(`                  present=[${present.join(', ') || 'none'}]${wanted.length && !present.length ? '  <- ALL RETIRED/WRONG' : ''}`);
      const tryThese = present.length ? present : wanted;
      for (const m of tryThese) {
        const r = p.kind === 'gemini' ? await pingGemini(p.apiKey, p.base, m) : await pingOpenAi(p, m);
        console.log(`   ${mark(r.ok)}ping ${m.padEnd(32)} HTTP ${r.status} — ${r.body}`);
      }
    } catch (e) {
      console.log(`   ${mark(false)}network error: ${cut(e && e.message)}`);
    }
    console.log('');
  }
  console.log('════════ done ════════');
})();
