/**
 * cloudflare-worker/dev-assistant-worker.js
 * ─────────────────────────────────────────
 * Cloudflare Workers API endpoint for the OfficeOS Dev Assistant.
 * Reuses the EXACT same engine (matching + intent logic + multi-provider
 * LLM chain + builtin fallback) as the Node dashboard: src/devAssistant.js.
 *
 * Deploy:
 *   cd cloudflare-worker
 *   npx wrangler secret put GEMINI_API_KEY      (repeat for GROQ_API_KEY,
 *     OPENROUTER_API_KEY, MISTRAL_API_KEY — only the ones you set are used)
 *   npx wrangler deploy
 *
 * Environment (vars/secrets):
 *   TRACKER_API_URL    — base URL of your OfficeOS deployment, e.g.
 *                        https://your-app.vercel.app  (must expose
 *                        /api/master/dev-projects). Falls back to empty data.
 *   GEMINI_API_KEY / GROQ_API_KEY / OPENROUTER_API_KEY / MISTRAL_API_KEY
 *   Optional: GEMINI_MODEL, GROQ_MODEL, OPENROUTER_MODEL, MISTRAL_MODEL,
 *             LLM_DISABLE=1 (force builtin engine)
 *
 * Routes:
 *   GET  /health    → { ok, engine, providers }
 *   GET  /overview  → tracker overview + suggested questions
 *   POST /          → { question } → { answer, intent, project, engine, ... }
 */
import { answerDevQuestion, getAssistantMeta, buildProviderChain } from '../src/devAssistant.js';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS_HEADERS },
  });
}

// Optional auth: if the API_TOKEN secret is set, requests must present it via
// "Authorization: Bearer <token>" or "X-Api-Token: <token>". The dashboard
// sends its CLOUDFLARE_WORKER_TOKEN here when calling this worker.
function authorized(request, env) {
  if (!env.API_TOKEN) return true;
  const header = request.headers.get('Authorization') || '';
  const token = header.replace(/^Bearer\s+/i, '').trim() || (request.headers.get('X-Api-Token') || '').trim();
  return token.length > 0 && token === env.API_TOKEN;
}

async function loadProjects(env) {
  if (!env.TRACKER_API_URL) return [];
  const res = await fetch(String(env.TRACKER_API_URL).replace(/\/+$/, '') + '/api/master/dev-projects');
  if (!res.ok) throw new Error('upstream /api/master/dev-projects returned HTTP ' + res.status);
  const data = await res.json();
  return Array.isArray(data.projects) ? data.projects : [];
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });
    const url = new URL(request.url);
    try {
      if (url.pathname === '/health' && request.method === 'GET') {
        return json({ ok: true, engine: getAssistantMeta([], env).engine, providers: buildProviderChain(env).map((p) => p.name) });
      }
      if (url.pathname === '/overview' && request.method === 'GET') {
        if (!authorized(request, env)) return json({ error: 'unauthorized' }, 401);
        return json(getAssistantMeta(await loadProjects(env), env));
      }
      if ((url.pathname === '/' || url.pathname === '/ask') && request.method === 'POST') {
        if (!authorized(request, env)) return json({ error: 'unauthorized' }, 401);
        const body = await request.json().catch(() => ({}));
        const question = String(body.question || '').trim();
        if (!question) return json({ error: 'question required' }, 400);
        // RAG data feed: callers (dashboard, agents, cron jobs) may push the
        // tracker data INLINE — in that case no upstream fetch is needed and
        // the answer is generated purely from the fed context. Otherwise the
        // worker pulls fresh data from TRACKER_API_URL itself.
        const projects = Array.isArray(body.projects) && body.projects.length
          ? body.projects
          : await loadProjects(env);
        return json(await answerDevQuestion(question, projects, { env }));
      }
      return json({ error: 'not found' }, 404);
    } catch (e) {
      return json({ error: e.message || 'upstream error' }, 502);
    }
  },
};
