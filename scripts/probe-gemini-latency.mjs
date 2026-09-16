/**
 * Reliability/latency probe for the Gemini model slugs — decides which model
 * should sit FIRST in the chain. A flaky primary costs the user the full
 * 15s timeout before the next model answers.
 *
 * Run:  node scripts/probe-gemini-latency.mjs
 */
import 'dotenv/config';

const KEY = process.env.GEMINI_API_KEY;
const BASE = process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta';
const MODELS = ['gemini-flash-latest', 'gemini-3.6-flash', 'gemini-3-flash-preview'];
const ROUNDS = 3;
const cut = (s, n = 90) => String(s ?? '').replace(/\s+/g, ' ').slice(0, n);

(async () => {
  if (!KEY) return console.log('GEMINI_API_KEY not set');
  console.log(`probe: ${MODELS.length} models × ${ROUNDS} rounds, 15s timeout\n`);
  const stats = {};
  for (const model of MODELS) {
    stats[model] = { ok: 0, times: [] };
    for (let i = 1; i <= ROUNDS; i++) {
      const c = new AbortController();
      const t = setTimeout(() => c.abort(), 15000);
      const t0 = Date.now();
      try {
        const res = await fetch(`${BASE}/models/${model}:generateContent?key=${encodeURIComponent(KEY)}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: c.signal,
          body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'Reply with exactly: OK' }] }], generationConfig: { maxOutputTokens: 1600 } }),
        });
        const j = await res.json().catch(() => ({}));
        const ms = Date.now() - t0;
        const txt = (j?.candidates?.[0]?.content?.parts || []).map((x) => x.text || '').join('').trim();
        if (res.status === 200 && txt) stats[model].ok++;
        if (res.status === 200 && txt) stats[model].times.push(ms);
        console.log(`  #${i} ${model.padEnd(24)} HTTP ${res.status} ${String(ms).padStart(6)}ms ${cut(j.error ? JSON.stringify(j.error) : txt)}`);
      } catch (e) {
        console.log(`  #${i} ${model.padEnd(24)} ERR   ${String(Date.now() - t0).padStart(6)}ms ${cut(e.name === 'AbortError' ? 'timeout 15s' : e.message)}`);
      } finally {
        clearTimeout(t);
      }
    }
  }
  console.log('\n── summary (success rate / avg latency on success)');
  for (const m of MODELS) {
    const s = stats[m];
    const avg = s.times.length ? Math.round(s.times.reduce((a, b) => a + b, 0) / s.times.length) : 0;
    console.log(`  ${m.padEnd(24)} ${s.ok}/${ROUNDS} ok  avg ${avg}ms`);
  }
})();