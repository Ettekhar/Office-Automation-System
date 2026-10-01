/**
 * OfficeOS Enterprise RAG
 *
 * A local-first, re-runnable RAG index. It avoids a paid vector database by
 * storing vectors + metadata in data/rag-index.json. Replace the adapter with
 * Qdrant/pgvector later without changing ingestion or retrieval contracts.
 *
 * Embeddings use Gemini text-embedding-004 when GEMINI_API_KEY is available.
 * A deterministic hashed embedding is retained as an offline fallback so the
 * evaluator and retrieval path still work without network access.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { fetchAllSheetsSummary } from './sheets.js';
import { fetchGoogleDocuments } from './docsRag.js';
import { isReportQuestion } from './reportAutomation.js';

const DATA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../data');
// Override RAG_INDEX_PATH for a worker, a read-only deployment, or isolated
// evaluation. Production defaults to the app's persistent data directory.
const INDEX_PATH = path.resolve(process.env.RAG_INDEX_PATH || path.join(DATA_DIR, 'rag-index.json'));
const EMBEDDING_DIM = 256;
let embeddingUnavailable = false;
const STOP = new Set(['the','and','for','with','from','that','this','what','when','where','which','how','are','was','were','have','has','had','your','our','into','about','please','show','tell','give','does','did','can','could','should','would','all','any','get','use']);

const clean = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();
const tokens = (text) => clean(text).toLowerCase().match(/[a-z0-9][a-z0-9._/-]*/g)?.filter((w) => w.length > 1 && !STOP.has(w)) || [];
const hash = (s) => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; };
const dot = (a, b) => a.reduce((n, v, i) => n + v * (b[i] || 0), 0);
const norm = (a) => Math.sqrt(dot(a, a)) || 1;

function hashEmbedding(text) {
  const v = Array(EMBEDDING_DIM).fill(0);
  for (const term of tokens(text)) { const i = hash(term) % EMBEDDING_DIM; v[i] += hash(`sign:${term}`) & 1 ? 1 : -1; }
  const len = norm(v); return v.map((x) => x / len);
}

async function embed(text) {
  const key = String(process.env.GEMINI_API_KEY || '').trim();
  if (!key || embeddingUnavailable) return { vector: hashEmbedding(text), model: 'hash-256-offline' };
  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/text-embedding-004:embedContent?key=${encodeURIComponent(key)}`;
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'models/text-embedding-004', content: { parts: [{ text }] } }) });
    if (!res.ok) throw new Error(`embedding HTTP ${res.status}`);
    const body = await res.json();
    const vector = body.embedding?.values;
    if (!Array.isArray(vector) || !vector.length) throw new Error('empty embedding');
    return { vector, model: 'gemini-text-embedding-004' };
  } catch (error) {
    console.warn('[rag] embedding fallback:', error.message);
    embeddingUnavailable = true;
    return { vector: hashEmbedding(text), model: 'hash-256-offline' };
  }
}

function splitDocSection(heading, text, maxWords = 420, overlapWords = 45) {
  const words = clean(text).split(' ').filter(Boolean);
  if (!words.length) return [];
  const out = [];
  for (let start = 0; start < words.length; start += Math.max(1, maxWords - overlapWords)) {
    const body = words.slice(start, start + maxWords).join(' ');
    if (!body) break;
    out.push(`${heading ? `${heading}\n\n` : ''}${body}`);
    if (start + maxWords >= words.length) break;
  }
  return out;
}

function docChunks(doc) {
  const sections = Array.isArray(doc.sections) && doc.sections.length ? doc.sections : [{ heading: '', text: doc.text }];
  return sections.flatMap((section, i) => splitDocSection(section.heading || doc.title, section.text).map((text, j) => ({
    text, metadata: { source_type: 'doc', file_name: doc.title, source_url: doc.url, document_id: doc.id, section_heading: section.heading || doc.title, chunk_index: `${i}.${j}`, last_modified: doc.modifiedTime || '' },
  })));
}

function sheetChunks(sheets) {
  const chunks = [];
  for (const sheet of sheets || []) {
    for (const row of sheet.rows || []) {
      const fields = (sheet.columns || []).map((col) => [col.label, clean(row[col.key])]).filter(([, value]) => value);
      if (!fields.length) continue;
      const sentence = `${sheet.title}${sheet.tabName ? ` — ${sheet.tabName}` : ''} — ${fields.map(([label, value]) => `${label}: ${value}`).join(' — ')}`;
      chunks.push({ text: sentence, metadata: { source_type: 'sheet', file_name: sheet.title, sheet_tab: sheet.tabName, row_number: row._rowNumber, section_heading: sheet.tabName, source_url: `https://docs.google.com/spreadsheets/d/${sheet.spreadsheetId}/edit#gid=0`, last_modified: sheet.lastFetched || '', spreadsheet_id: sheet.spreadsheetId } });
    }
  }
  return chunks;
}

function writeIndex(index) { fs.writeFileSync(INDEX_PATH, JSON.stringify(index, null, 2), 'utf8'); }
export function loadRagIndex() { try { return JSON.parse(fs.readFileSync(INDEX_PATH, 'utf8')); } catch { return { version: 1, updatedAt: null, embeddingModel: '', chunks: [] }; } }

/** A tiny offline fixture used by the evaluation harness before real sources
 * are connected. It is only written when no index exists. */
export async function seedDemoRagIndex() {
  const existing = loadRagIndex();
  if (existing.chunks?.length) return existing;
  const raw = [
    { text: 'Project X — Status: In Progress — Owner: Rahim — Last updated: 12 Sep 2026 — Pending task: client approval.', metadata: { source_type: 'sheet', file_name: 'Demo Project Tracker', sheet_tab: 'Projects', row_number: 2, section_heading: 'Projects', source_url: 'https://example.invalid/demo-sheet', last_modified: '2026-09-12' } },
    { text: 'CW Maintenance — Status: Completed — Website: examplehotel.com — Maintenance report: sent — Last updated: 12 Sep 2026.', metadata: { source_type: 'sheet', file_name: 'Demo Maintenance Sheet', sheet_tab: 'Website List', row_number: 8, section_heading: 'Website List', source_url: 'https://example.invalid/demo-sheet', last_modified: '2026-09-12' } },
    { text: 'Website Launch SOP\n\n1. Confirm written staging approval. 2. Take a full backup. 3. Clear all caches. 4. Run responsive QA. 5. Notify the account manager.', metadata: { source_type: 'doc', file_name: 'Website Launch SOP', document_id: 'demo-launch', section_heading: 'Launch procedure', source_url: 'https://example.invalid/demo-launch', last_modified: '2026-09-12' } },
    { text: 'Domain Renewal SOP\n\n1. Verify the expiry date. 2. Request approval. 3. Renew through the registrar. 4. Record the receipt in the tracker.', metadata: { source_type: 'doc', file_name: 'Domain Renewal SOP', document_id: 'demo-domain', section_heading: 'Renewal procedure', source_url: 'https://example.invalid/demo-domain', last_modified: '2026-09-12' } },
  ];
  const chunks = []; let embeddingModel = '';
  for (let i = 0; i < raw.length; i++) { const out = await embed(raw[i].text); embeddingModel ||= out.model; chunks.push({ id: `demo:${i}`, text: raw[i].text, vector: out.vector, metadata: raw[i].metadata }); }
  const index = { version: 1, updatedAt: new Date().toISOString(), embeddingModel, chunkCount: chunks.length, chunks, sources: { sheets: 2, docs: 2 }, errors: [], demo: true };
  writeIndex(index); return index;
}

/** Rebuild the entire index from configured Docs, connected Sheets, and the
 * Report Automation daily report log (when configured). */
export async function syncRagIndex({ refresh = true, sources = {} } = {}) {
  const errors = [];
  let sheets = [];
  let docs = { documents: [] };
  let reports = [];
  try { sheets = await fetchAllSheetsSummary(); } catch (error) { errors.push({ source: 'sheets', error: error.message }); }
  try { docs = await fetchGoogleDocuments(sources.documents || {}, { refresh }); } catch (error) { errors.push({ source: 'docs', error: error.message }); }
  errors.push(...(docs.errors || []));
  // Daily report log bridge — read-only; only active when a baseUrl + key exist.
  const ra = sources.reportAutomation || null;
  if (ra?.enabled !== false && ra?.baseUrl && ra?.apiKey) {
    try {
      const { fetchReportLog, reportChunks } = await import('./reportAutomation.js');
      const { items } = await fetchReportLog(ra);
      reports = reportChunks(items || [], ra.baseUrl);
    } catch (error) { errors.push({ source: 'daily-reports', error: error.message }); }
  }
  const raw = [...sheetChunks(sheets), ...(docs.documents || []).flatMap(docChunks), ...reports];
  const chunks = [];
  let embeddingModel = '';
  for (let i = 0; i < raw.length; i++) {
    const item = raw[i];
    const out = await embed(item.text);
    embeddingModel = embeddingModel || out.model;
    chunks.push({ id: `${item.metadata.source_type}:${hash(`${item.metadata.file_name}:${item.metadata.sheet_tab || item.metadata.section_heading}:${item.metadata.row_number || i}:${item.text}`)}`, text: item.text, vector: out.vector, metadata: item.metadata });
  }
  const index = { version: 1, updatedAt: new Date().toISOString(), embeddingModel, chunkCount: chunks.length, chunks, sources: { sheets: sheets.length, docs: docs.documents?.length || 0, dailyReports: reports.length }, errors };
  writeIndex(index);
  return index;
}

function bm25(queryTerms, chunks) {
  const avg = chunks.reduce((n, c) => n + tokens(c.text).length, 0) / Math.max(1, chunks.length);
  const df = new Map();
  chunks.forEach((chunk) => new Set(tokens(chunk.text)).forEach((term) => df.set(term, (df.get(term) || 0) + 1)));
  return chunks.map((chunk) => {
    const words = tokens(chunk.text); const tf = new Map(); words.forEach((w) => tf.set(w, (tf.get(w) || 0) + 1));
    const score = queryTerms.reduce((sum, term) => { const n = df.get(term) || 0; const idf = Math.log(1 + (chunks.length - n + .5) / (n + .5)); const f = tf.get(term) || 0; return sum + idf * (f * 2.2) / (f + 1.2 * (1 - .75 + .75 * words.length / Math.max(1, avg))); }, 0);
    return score;
  });
}

/** Hybrid retrieval: vector similarity + BM25, then deterministic rerank. */
export async function retrieveRag(query, { sourceType = '', candidateLimit = 20, limit = 5 } = {}) {
  const index = loadRagIndex();
  const candidates = index.chunks.filter((chunk) => !sourceType || chunk.metadata.source_type === sourceType);
  if (!candidates.length) return { chunks: [], indexUpdatedAt: index.updatedAt, reason: 'No indexed chunks for this source type.' };
  const q = await embed(query); const terms = tokens(query); const lexical = bm25(terms, candidates); const maxLexical = Math.max(...lexical, 1);
  const hybrid = candidates.map((chunk, i) => ({ chunk, vectorScore: dot(q.vector, chunk.vector) / (norm(q.vector) * norm(chunk.vector)), keywordScore: lexical[i] / maxLexical }))
    .map((item) => ({ ...item, hybridScore: (.58 * Math.max(0, item.vectorScore)) + (.42 * item.keywordScore) }))
    .sort((a, b) => b.hybridScore - a.hybridScore).slice(0, candidateLimit);
  // Rerank exact project/SOP terms and title/heading matches over the hybrid top 20.
  const reranked = hybrid.map((item) => {
    const heading = clean(`${item.chunk.metadata.file_name} ${item.chunk.metadata.section_heading}`).toLowerCase();
    const body = clean(item.chunk.text).toLowerCase();
    const overlap = terms.filter((term) => heading.includes(term)).length / Math.max(1, terms.length);
    // Exact identifiers (domains, project names, SOP IDs, people) matter more
    // than generic words like “status” or “maintenance”. Boost any exact term
    // found in the full row/section, not only its heading.
    const exact = terms.filter((term) => body.includes(term)).length / Math.max(1, terms.length);
    return { ...item, rerankScore: item.hybridScore + overlap * .25 + exact * .65 };
  }).sort((a, b) => b.rerankScore - a.rerankScore).slice(0, limit);
  return { chunks: reranked.map((item) => ({ ...item.chunk, scores: { vector: Number(item.vectorScore.toFixed(4)), keyword: Number(item.keywordScore.toFixed(4)), rerank: Number(item.rerankScore.toFixed(4)) } })), indexUpdatedAt: index.updatedAt, embeddingModel: index.embeddingModel };
}

// Resolve a ClickUp link from the full index when the user explicitly asks to
// inspect task comments. This intentionally favors a structured Maintenance
// field over generic website-update tasks, and tolerates small spelling slips
// such as "Barnet" for "Barnett".
const compactToken = (value) => String(value || '').toLowerCase().replace(/(.)\1+/g, '$1').replace(/[^a-z0-9]/g, '');
const clickUpUrlIn = (text) => String(text || '').match(/https?:\/\/[^\s)]+clickup\.com\/t\/[^\s)]+/i)?.[0] || '';
export function findClickUpEvidenceList(question, history = [], { limit = 4 } = {}) {
  const index = loadRagIndex();
  const queryTerms = tokens([question, ...(history || []).map((turn) => turn?.question || '')].join(' '));
  const wantsMaintenance = /\bmaintenance\b/i.test(question);
  const rows = (index.chunks || []).map((chunk) => {
    const text = clean(chunk.text);
    const lower = text.toLowerCase();
    if (!clickUpUrlIn(text)) return null;
    let score = 0;
    for (const term of queryTerms) {
      if (lower.includes(term)) score += 1;
      else if (term.length >= 5 && compactToken(lower).includes(compactToken(term))) score += .7;
    }
    if (wantsMaintenance && /\bmaintenance\s*:/i.test(text)) score += 6;
    if (wantsMaintenance && /maintenance/i.test(text)) score += 1;
    if (/daily review/i.test(text)) score += wantsMaintenance ? 1 : 0;
    return { chunk, score, url: clickUpUrlIn(text) };
  }).filter(Boolean).sort((a, b) => b.score - a.score);
  // Keep close matches only. A site can legitimately have a maintenance task
  // plus a daily-review/report task; returning both lets the answer explain
  // conflicting evidence instead of silently choosing one.
  // A query like “Barnett maintenance sent?” has one identity term and a few
  // generic status terms. Filter to rows that contain that identity first so
  // every Daily Review row marked “Maintenance: Completed” cannot compete.
  const genericTaskTerms = new Set(['maintenance', 'report', 'mail', 'sent', 'send', 'done', 'complete', 'completed', 'clickup', 'comment', 'comments', 'status', 'task', 'website', 'site', 'hotel', 'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december']);
  const identityTerms = queryTerms.filter((term) => term.length >= 4 && !genericTaskTerms.has(term));
  const identityRows = identityTerms.length ? rows.filter((row) => {
    const body = row.chunk.text.toLowerCase();
    const compactBody = compactToken(body);
    return identityTerms.some((term) => body.includes(term) || compactBody.includes(compactToken(term)));
  }) : [];
  const maintenanceIdentityRows = wantsMaintenance
    ? identityRows.filter((row) => /maintenance\s*(?:task|:|report)|monthly hosting/i.test(row.chunk.text))
    : [];
  // Never fall back from a named site/project to arbitrary ClickUp rows. A
  // generic word like "house" can otherwise select Morrison House or a task
  // from an entirely different client. If the index has no identity match,
  // the honest answer is that no verified linked task was found.
  if (identityTerms.length && !identityRows.length) return [];
  const ranked = maintenanceIdentityRows.length ? maintenanceIdentityRows : (identityRows.length ? identityRows : rows);
  const best = ranked[0]?.score || 0;
  const seen = new Set();
  const eligible = wantsMaintenance && maintenanceIdentityRows.length
    ? ranked
    : ranked.filter((row) => row.score >= Math.max(1, best * .65));
  return eligible
    .filter((row) => (seen.has(row.url) ? false : (seen.add(row.url), true)))
    .slice(0, limit);
}

export function findClickUpEvidence(question, history = []) {
  return findClickUpEvidenceList(question, history, { limit: 1 })[0] || null;
}

export function sourceTypeForQuestion(question) {
  // Daily report log questions are distinct from the maintenance/status sheets
  // so "who submitted / what did X report" retrieve report chunks, not tracker
  // rows. The report feed is a separate source_type in the RAG index. The same
  // detector drives the deterministic answers in devAssistant.js, keeping the
  // daily-report routing bit-for-bit consistent between RAG and chat.
  if (isReportQuestion(question)) return 'daily_report';
  return /\b(how do i|how to|sop|procedure|process|steps?|policy|instruction|employee|onboarding|publish)\b/i.test(question) ? 'doc' : /\b(status|update|progress|maintenance|report|owner|project|task|pending|completed)\b/i.test(question) ? 'sheet' : ''; }

export function strictRagPrompt(question, retrieved) {
  const citations = (retrieved.chunks || []).map((chunk, i) => `[${i + 1}] ${chunk.text}\nSOURCE: ${chunk.metadata.file_name}${chunk.metadata.sheet_tab ? ` / ${chunk.metadata.sheet_tab}, row ${chunk.metadata.row_number}` : ` / ${chunk.metadata.section_heading}`} — ${chunk.metadata.source_url}`).join('\n\n');
  return { system: 'Only answer using the supplied context. If the answer is absent, say exactly that the connected sources do not contain it; do not guess or infer. For SOP questions, preserve the original order of steps: do not summarize, merge, or reorder them. Cite every answer with [source name / sheet row or document section].', user: `Question: ${question}\n\nRetrieved context:\n${citations || '(none)'}` };
}

// Used when an answer model is unavailable. It quotes retrieved content and
// cites its source rather than inventing a summary.
export function generateGroundedFallback(question, retrieved) {
  if (!retrieved?.chunks?.length) return 'The connected sources do not contain an answer to that question.';
  return retrieved.chunks.slice(0, 2).map((chunk) => `${chunk.text}\n[Source: ${chunk.metadata.file_name}${chunk.metadata.sheet_tab ? ` / ${chunk.metadata.sheet_tab}, row ${chunk.metadata.row_number}` : ` / ${chunk.metadata.section_heading}`}]`).join('\n\n');
}
