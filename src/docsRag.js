/**
 * Google Docs retrieval for the OfficeOS assistant.
 *
 * Sources are explicit: individual Docs and folders must be shared with the
 * service account. Content stays in memory only and is cached briefly so chat
 * does not repeatedly spend Google API quota.
 */
import fs from 'fs';
import { google } from 'googleapis';
import { JWT } from 'google-auth-library';
import { config } from './config.js';

const DOC_MIME = 'application/vnd.google-apps.document';
const CACHE_TTL_MS = Math.max(30_000, Number(process.env.RAG_DOC_CACHE_TTL_MS || 300_000));
const MAX_DOCS = Math.max(1, Math.min(200, Number(process.env.RAG_MAX_DOCS || 80)));
const MAX_DOC_CHARS = Math.max(2_000, Math.min(250_000, Number(process.env.RAG_MAX_DOC_CHARS || 80_000)));
let clients = null;
let cached = { expiresAt: 0, key: '', documents: [], errors: [], fetchedAt: '' };

function keyFile() {
  return process.env.GOOGLE_SERVICE_ACCOUNT_KEY_JSON
    ? JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY_JSON)
    : JSON.parse(fs.readFileSync(config.serviceAccountKeyPath, 'utf8'));
}

async function getClients() {
  if (clients) return clients;
  const key = keyFile();
  const auth = new JWT({
    email: key.client_email,
    key: key.private_key,
    scopes: [
      'https://www.googleapis.com/auth/documents.readonly',
      'https://www.googleapis.com/auth/drive.readonly',
    ],
  });
  await auth.authorize();
  clients = { docs: google.docs({ version: 'v1', auth }), drive: google.drive({ version: 'v3', auth }) };
  return clients;
}

export function extractGoogleId(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const match = raw.match(/\/d\/([a-zA-Z0-9_-]+)/) || raw.match(/[?&]id=([a-zA-Z0-9_-]+)/);
  return match ? match[1] : (/^[a-zA-Z0-9_-]{15,}$/.test(raw) ? raw : '');
}

function structuralText(elements) {
  const out = [];
  for (const el of elements || []) {
    if (el.paragraph?.elements) out.push(el.paragraph.elements.map((p) => String(p?.textRun?.content || '')).join(''));
    if (el.table?.tableRows) {
      for (const row of el.table.tableRows) {
        out.push((row.tableCells || []).map((cell) => structuralText(cell.content || []).replace(/\s+/g, ' ').trim()).filter(Boolean).join(' | '));
      }
    }
    if (el.tableOfContents?.content) out.push(structuralText(el.tableOfContents.content));
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

// Google Docs exposes headings as paragraphStyle.namedStyleType. Preserve them
// as sections so SOP chunking never loses the procedure's heading context.
function documentSections(elements, fallbackTitle) {
  const sections = []; let heading = fallbackTitle; let body = [];
  const flush = () => { const text = body.join('\n').replace(/\n{3,}/g, '\n\n').trim(); if (text) sections.push({ heading, text }); body = []; };
  for (const el of elements || []) {
    if (!el.paragraph?.elements) continue;
    const text = el.paragraph.elements.map((p) => String(p?.textRun?.content || '')).join('').trim();
    if (!text) continue;
    const style = String(el.paragraph.paragraphStyle?.namedStyleType || '');
    if (/^HEADING_\d+$|TITLE|SUBTITLE/.test(style)) { flush(); heading = text; }
    else body.push(text);
  }
  flush(); return sections;
}

function envSources() {
  const split = (name) => String(process.env[name] || '').split(',').map((v) => v.trim()).filter(Boolean);
  return { sources: split('RAG_GOOGLE_DOC_IDS'), folderIds: split('RAG_GOOGLE_DRIVE_FOLDER_IDS') };
}

function normalizeSources(documentsConfig = {}) {
  const configured = Array.isArray(documentsConfig.sources) ? documentsConfig.sources : [];
  const fromEnv = envSources();
  const ids = new Map();
  for (const item of [...configured, ...fromEnv.sources]) {
    const raw = typeof item === 'object' ? (item.url || item.id) : item;
    const id = extractGoogleId(raw);
    if (id) ids.set(id, { id, title: typeof item === 'object' ? String(item.title || '').trim() : '' });
  }
  const folderIds = new Set([...(documentsConfig.folderIds || []), ...fromEnv.folderIds].map(extractGoogleId).filter(Boolean));
  return { sources: [...ids.values()], folderIds: [...folderIds] };
}

async function listFolderDocs(drive, folderId) {
  const files = [];
  let pageToken;
  do {
    const result = await drive.files.list({
      q: `'${folderId.replace(/'/g, "\\'")}' in parents and trashed = false and mimeType = '${DOC_MIME}'`,
      fields: 'nextPageToken,files(id,name,modifiedTime,webViewLink)',
      orderBy: 'modifiedTime desc', pageSize: 100, pageToken,
      supportsAllDrives: true, includeItemsFromAllDrives: true,
    });
    files.push(...(result.data.files || []));
    pageToken = result.data.nextPageToken || undefined;
  } while (pageToken && files.length < MAX_DOCS);
  return files.slice(0, MAX_DOCS);
}

/** Fetch configured Google Docs and return source-safe text records. */
export async function fetchGoogleDocuments(documentsConfig = {}, { refresh = false } = {}) {
  const source = normalizeSources(documentsConfig);
  const cacheKey = JSON.stringify(source);
  if (!refresh && cached.key === cacheKey && cached.expiresAt > Date.now()) return cached;
  if (!source.sources.length && !source.folderIds.length) return { documents: [], errors: [], fetchedAt: '', configured: false, sourceCount: 0 };
  const { docs, drive } = await getClients();
  const wanted = new Map(source.sources.map((s) => [s.id, s]));
  const errors = [];
  for (const folderId of source.folderIds) {
    try {
      const files = await listFolderDocs(drive, folderId);
      files.forEach((file) => wanted.set(file.id, { id: file.id, title: file.name || '', modifiedTime: file.modifiedTime || '', url: file.webViewLink || '' }));
    } catch (error) { errors.push({ source: `folder:${folderId}`, error: error.message }); }
  }
  const documents = [];
  for (const item of [...wanted.values()].slice(0, MAX_DOCS)) {
    try {
      const result = await docs.documents.get({ documentId: item.id });
      const text = structuralText(result.data.body?.content || []).slice(0, MAX_DOC_CHARS);
      if (!text) { errors.push({ source: item.id, error: 'Document has no readable text' }); continue; }
      const title = result.data.title || item.title || 'Untitled Google Doc';
      documents.push({ id: item.id, title, url: item.url || `https://docs.google.com/document/d/${item.id}/edit`, text, sections: documentSections(result.data.body?.content || [], title), modifiedTime: item.modifiedTime || '' });
    } catch (error) { errors.push({ source: item.id, error: error.message }); }
  }
  cached = { key: cacheKey, expiresAt: Date.now() + CACHE_TTL_MS, documents, errors, fetchedAt: new Date().toISOString(), configured: true, sourceCount: wanted.size };
  return cached;
}

export function documentSourceSummary(documentsConfig = {}) {
  const source = normalizeSources(documentsConfig);
  return { individualDocs: source.sources.length, folders: source.folderIds.length, totalConfigured: source.sources.length + source.folderIds.length };
}
