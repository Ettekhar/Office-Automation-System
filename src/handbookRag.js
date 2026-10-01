/**
 * Read-only bridge to the separately deployed Razib Operations Handbook RAG
 * Worker.  This server never calls its ingest/admin endpoints and never sends
 * OfficeOS Sheets data to it: it only asks the Worker a user's SOP question.
 */
const CACHE_TTL_MS = 2 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 12_000;
const cache = new Map();

const SOP_INTENT = /\b(sop|standard operating procedure|operations handbook|handbook|procedure|process|workflow|how (?:do|to|should)|instruction|policy|onboard(?:ing)?|handover|audit|deliverable|checklist)\b/i;
const FACTUAL_TRACKER_INTENT = /\b(?:was|did|has|have|show|latest|how many)\b[\s\S]{0,80}\b(?:maintenance|report|feedback|development|project|sitemap|page|status|update|completed|pending|in progress)\b|\bwhat(?:'s| is)\b[\s\S]{0,80}\b(?:status|update|completed|pending|in progress)\b/i;

function cleanWorkerUrl(value) {
  const raw = String(value || '').trim().replace(/\/+$/, '');
  if (!raw) return '';
  let parsed;
  try { parsed = new URL(raw); } catch { return ''; }
  if (!['https:', 'http:'].includes(parsed.protocol)) return '';
  // The worker exposes only /chat and /health to OfficeOS. Reject an admin URL
  // even if one is pasted into the dashboard accidentally.
  if (/\/(?:admin|ingest)(?:\/|$)/i.test(parsed.pathname)) return '';
  return parsed.toString().replace(/\/$/, '');
}

export function handbookWorkerConfig(config = {}, env = process.env) {
  const handbook = config?.handbook || {};
  const url = cleanWorkerUrl(handbook.workerUrl || env.HANDBOOK_RAG_WORKER_URL);
  return {
    enabled: handbook.enabled !== false,
    workerUrl: url,
    configured: Boolean(url) && handbook.enabled !== false,
    // Kept server-side only. This is deliberately NOT the Worker INGEST_KEY.
    token: String(env.HANDBOOK_RAG_WORKER_TOKEN || '').trim(),
  };
}

export function shouldUseHandbook(question, { liveProject = false } = {}) {
  const q = String(question || '').trim();
  // A live project and tracker/maintenance questions have an authoritative
  // Sheet route. Do not replace those answers with generic handbook prose.
  return Boolean(q) && !liveProject && SOP_INTENT.test(q) && !FACTUAL_TRACKER_INTENT.test(q);
}

function compactSource(source) {
  if (!source || typeof source !== 'object') return null;
  const url = cleanWorkerUrl(source.url);
  return {
    url,
    title: String(source.title || '').trim().slice(0, 300),
    section: String(source.section || '').trim().slice(0, 300),
    excerpt: String(source.excerpt || '').trim().slice(0, 900),
    score: Number.isFinite(Number(source.score)) ? Number(source.score) : null,
  };
}

export async function askHandbook(question, config = {}, { env = process.env, fetchImpl = fetch } = {}) {
  const worker = handbookWorkerConfig(config, env);
  if (!worker.configured) return { ...worker, ok: false, reason: 'not-configured' };
  const normalized = String(question || '').trim().replace(/\s+/g, ' ').slice(0, 3000);
  if (!normalized) return { ...worker, ok: false, reason: 'empty-question' };
  const cacheKey = `${worker.workerUrl}|${normalized.toLowerCase()}`;
  const hit = cache.get(cacheKey);
  if (hit?.expiresAt > Date.now()) return { ...hit.value, cached: true };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const headers = { 'content-type': 'application/json', accept: 'application/json' };
    if (worker.token) headers.authorization = `Bearer ${worker.token}`;
    const response = await fetchImpl(`${worker.workerUrl}/chat`, {
      method: 'POST', headers, body: JSON.stringify({ question: normalized }), signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Handbook Worker returned HTTP ${response.status}`);
    const raw = await response.json();
    const answer = String(raw?.answer || '').trim().slice(0, 7000);
    if (!answer) throw new Error('Handbook Worker returned no answer');
    const value = {
      ...worker, ok: true, answer,
      sources: (Array.isArray(raw.sources) ? raw.sources : []).map(compactSource).filter(Boolean).slice(0, 5),
      nextActions: (Array.isArray(raw.next_actions) ? raw.next_actions : []).map((x) => String(x || '').trim().slice(0, 500)).filter(Boolean).slice(0, 5),
    };
    cache.set(cacheKey, { expiresAt: Date.now() + CACHE_TTL_MS, value });
    return value;
  } catch (error) {
    return { ...worker, ok: false, reason: error.name === 'AbortError' ? 'timeout' : 'unreachable', error: error.message };
  } finally { clearTimeout(timer); }
}

export async function testHandbook(config = {}, options = {}) {
  const worker = handbookWorkerConfig(config, options.env || process.env);
  if (!worker.configured) return { ...worker, ok: false, message: 'Add the deployed Handbook Worker URL first.' };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await (options.fetchImpl || fetch)(`${worker.workerUrl}/health`, { signal: controller.signal, headers: { accept: 'application/json' } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return { ...worker, ok: true, message: 'Handbook Worker is reachable (read-only health check).' };
  } catch (error) { return { ...worker, ok: false, message: error.name === 'AbortError' ? 'Health check timed out.' : `Health check failed: ${error.message}` }; }
  finally { clearTimeout(timer); }
}

export function formatHandbookAnswer(result) {
  const lines = ['📚 **Operations Handbook**', '', result.answer];
  if (result.sources?.length) {
    lines.push('', '**Sources checked**');
    for (const s of result.sources) lines.push(`• ${s.url ? `[${s.title || s.section || 'Handbook source'}](${s.url})` : `**${s.title || s.section || 'Handbook source'}**`}${s.section ? ` — ${s.section}` : ''}${s.excerpt ? `: “${s.excerpt}”` : ''}`);
  }
  if (result.nextActions?.length) lines.push('', '**Suggested next steps**', ...result.nextActions.map((x) => `• ${x}`));
  lines.push('', `_Source: Razib Operations Handbook RAG Worker${result.cached ? ' (cached for 2 minutes)' : ''}. This did not alter Sheets or handbook data._`);
  return lines.join('\n');
}
