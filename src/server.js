import 'dotenv/config'; // ensure .env (AI provider keys, worker URL/token) is loaded for ALL routes
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  getOverviewData,
  getSitePreview,
  generateAllPreviews,
  sendSingleEmail,
} from './dashboardApi.js';
import {
  getAccountManagersList,
  getClickUpTaskPreview,
  completeClickUpMaintenanceTask,
} from './clickup.js';
import { invalidateCache, getCacheStatus } from './sheetsCache.js';
import { syncAssignmentToUserTabs } from './assignmentWriteBack.js';
import { findMonthlyHistoryEntry, shouldWriteReconciledStatus, maintenanceStatusRank } from './maintenanceStatus.js';
import * as db from './db.js';

// Hydrate process.env from database (data/mailer-credentials.json or KV)
try {
  const dbCreds = db.dbRead('mailer-credentials');
  if (dbCreds && dbCreds.vars) {
    for (const [k, v] of Object.entries(dbCreds.vars)) {
      if (v && !process.env[k]) process.env[k] = v;
    }
  }
} catch {}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PUBLIC_DIR = path.resolve(__dirname, '../public');
const DEFAULT_PORT = Number(process.env.PORT || 3000);

function overlayMonthStatus(rows, month, sites = null) {
  if (!month) return rows;
  const mLower = month.trim().toLowerCase();
  const siteList = sites || (db.getSites ? db.getSites({}) : []);
  const normMap = {
    'updated & backup': 'completed', 'completed': 'completed',
    'in progress': 'in_progress', 'to do': 'todo', 'todo': 'todo',
    'pending': 'pending', '': 'todo',
  };
  return rows.map(row => {
    const site = siteList.find(s => {
      const sUrl = (s.url || '').toLowerCase().replace(/^https?:\/\//, '').replace(/\/$/, '');
      const rUrl = (row.siteUrl || '').toLowerCase().replace(/^https?:\/\//, '').replace(/\/$/, '');
      return sUrl === rUrl || sUrl.includes(rUrl) || rUrl.includes(sUrl);
    });
    if (!site) return row;
    const history = site.monthlyHistory || [];
    // Strict month matching. The old inline lookup used substring tests, under
    // which asking for "sep" matched the 2022 entry "September 22" - whose empty
    // status was then read as "not done". Returns null when nothing matches,
    // and null means "leave this row alone", which is always the safe outcome.
    const entry = findMonthlyHistoryEntry(history, month);
    if (!entry) return row;
    const rawVal = (entry.status || '').trim();
    const normVal = normMap[(rawVal || '').toLowerCase()] || 'todo';
    return {
      ...row,
      maintenanceStatus: normVal,
      maintenanceRaw: rawVal || '',
      _origMaintenanceRaw: row.maintenanceRaw || '',
      _hadMonthEntry: true,
    };
  });
}

// Reconcile debounce: limit CW/RM->Daily-Review sync to once per user+month per 5 min
const _reconcileLastRun = new Map();
const RECONCILE_COOLDOWN_MS = 30 * 1000;
function shouldReconcile(userName, month) {
  const key = String(userName).toLowerCase() + '|' + String(month).toLowerCase();
  const last = _reconcileLastRun.get(key) || 0;
  if (Date.now() - last < RECONCILE_COOLDOWN_MS) return false;
  _reconcileLastRun.set(key, Date.now());
  return true;
}

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
};

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (err) {
        reject(new Error('Invalid JSON payload'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, Accept, X-OfficeOS-Role, X-OfficeOS-User, X-OfficeOS-User-Id',
  });
  res.end(JSON.stringify(data));
}

/**
 * Resolve the acting user for audit logging. Trust order:
 * explicit body actorName/actorId → forwarder headers set by the UI →
 * query params → fallback "admin". The UI sends X-OfficeOS-* headers on
 * every request, so manual changes are attributed to the real operator.
 */
function actorFrom(req, b, reqUrl) {
  const h = (n) => (req.headers[n] || '').toString().trim();
  const q = (n) => (reqUrl?.searchParams?.get(n) || '').trim();
  return {
    name: String(b?.actorName || h('x-officeos-user') || q('user') || 'admin').slice(0, 100),
    id: String(b?.actorId || h('x-officeos-user-id') || q('userId') || '').slice(0, 100),
    role: String(h('x-officeos-role') || q('role') || '').slice(0, 40),
  };
}

/**
 * Optimistic-lock guard for mutation routes.
 *
 * A client that already loaded a record sends its last-seen `updatedAt` (the UI
 * attaches `expectedUpdatedAt`). When the stored record has since changed, the
 * write would silently overwrite someone else's edit — so we reject with 409
 * and hand back the current record so the UI can re-render instead of clobber.
 * When the client sends no expectation, behavior is unchanged (last-write-wins).
 */
function assertFresh(before, b, res, entity) {
  const expected = b && b.expectedUpdatedAt;
  if (expected === undefined || expected === null || expected === '') return true;
  if (before && db.assertRecordFresh(before, expected)) return true;
  sendJson(res, 409, {
    error: 'STALE_VERSION',
    message: 'This record was changed by someone else since you loaded it. Refresh to see the latest — your edit was NOT applied and no data was lost.',
    entity,
    id: before ? before.id : undefined,
    current: before || null,
  });
  return false;
}

/**
 * Assignment targets must be real, active users. The UI hides inactive users
 * from the assignee picker, but the API is also protected so a stale tab or a
 * hand-written request cannot create a new assignment for a deactivated account.
 * `remove` is intentionally allowed to name an inactive user: unassigning an old
 * inactive assignment is cleanup, not a new assignment.
 */
function assertActiveAssignees(res, userIds) {
  const ids = Array.isArray(userIds) ? userIds : [];
  if (!ids.length) return true;
  const byId = new Map((db.getUsers() || []).map((u) => [u.id, u]));
  const invalid = ids.filter((id) => {
    const user = byId.get(id);
    return !user || user.active === false;
  });
  if (!invalid.length) return true;
  const names = invalid.map((id) => byId.get(id)?.name || id);
  sendJson(res, 400, {
    error: 'INACTIVE_ASSIGNEE',
    message: `Cannot assign to unknown or inactive user(s): ${names.join(', ')}. Choose an active user.`,
    users: names,
  });
  return false;
}

function serveStatic(res, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';

  fs.readFile(filePath, (err, content) => {
    if (err) {
      if (err.code === 'ENOENT') {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('404 Not Found');
      } else {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('500 Internal Server Error');
      }
      return;
    }
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(content);
  });
}

/**
 * Discovered-schema text for the Dev Assistant's data source.
 *
 * The assistant answers from the sheet(s) selected in AI Settings. New columns
 * and whole new tabs appear in those spreadsheets by hand, so before answering
 * we hand the model the auto-discovered layout of that source (tabSchema.js +
 * sheetSchema.js) as SECTION 5 of the RAG context. Discovery is cached (memory +
 * data/sheet-schema.json), so this is normally free.
 *
 * Never throws: any failure simply means "no SECTION 5" and the answer proceeds
 * with the same context as before.
 */
async function assistantSchemaText(config) {
  try {
    const { readRegistry, describeSchemaForAssistant } = await import('./sheetSchema.js');
    const reg = readRegistry();
    const stored = Object.values(reg?.spreadsheets || {});
    if (stored.length) {
      return describeSchemaForAssistant(stored, { maxTabs: 14, maxSheets: 8 });
    }
    // Start with the configured source if not in registry
    const src = config?.source || {};
    let sheets = [];
    if (src.spreadsheetId) {
      const { getOrDiscoverSheetSchema } = await import('./sheetSchema.js');
      const schema = await Promise.race([
        getOrDiscoverSheetSchema(src.spreadsheetId, {
          tabs: Array.isArray(src.tabs) && src.tabs.length ? src.tabs : undefined,
          maxTabs: 14,
        }),
        new Promise((r) => setTimeout(() => r(null), 1500)),
      ]);
      if (schema) sheets.push(schema);
    }
    if (sheets.length) {
      return describeSchemaForAssistant(sheets, { maxTabs: 14, maxSheets: 8 });
    }
    return '';
  } catch (e) {
    console.warn('[sheet-schema] Could not build schema text for the assistant:', e.message);
    return '';
  }
}

async function startCloudflareTunnel(port = DEFAULT_PORT) {
  if (global._tunnelUrl) return global._tunnelUrl;
  const isWorkerEnv = typeof fs.createWriteStream !== 'function' || typeof process?.versions?.node === 'undefined';
  if (isWorkerEnv) {
    let stored = null;
    try { stored = db.dbRead('active-tunnel'); } catch {}
    if (stored && stored.active && stored.url) return stored.url;
    throw new Error('Tunnels connect from your local PC to this cloud dashboard.');
  }

  const { spawn } = await import('child_process');
  const https = await import('https');
  const cfDir = path.resolve(__dirname, '../data');
  if (!fs.existsSync(cfDir)) fs.mkdirSync(cfDir, { recursive: true });
  const cfBin = path.join(cfDir, 'cloudflared.exe');

  if (!fs.existsSync(cfBin)) {
    const CF_URL = 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe';
    console.log('[tunnel] Downloading cloudflared...');
    await new Promise((resolve, reject) => {
      const file = fs.createWriteStream(cfBin);
      const download = (url, redirects = 5) => {
        if (redirects <= 0) { reject(new Error('Too many redirects')); return; }
        const req = https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 MaintenanceMailer' } }, (response) => {
          if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
            download(response.headers.location, redirects - 1);
            return;
          }
          response.pipe(file);
          file.on('finish', () => file.close(resolve));
        });
        req.on('error', reject);
      };
      download(CF_URL);
    });
    console.log('[tunnel] cloudflared downloaded');
  }

  const proc = spawn(cfBin, ['tunnel', '--url', `http://localhost:${port}`, '--no-autoupdate'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  global._tunnelProc = proc;
  global._tunnelUrl = null;

  const urlFound = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Tunnel URL not found within 30s')), 30000);
    const onData = (data) => {
      const text = data.toString();
      const match = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
      if (match) {
        clearTimeout(timer);
        proc.stdout.off('data', onData);
        proc.stderr.off('data', onData);
        // CRITICAL: Continuously drain stdout and stderr so cloudflared never blocks on full pipe buffer
        proc.stdout.resume();
        proc.stderr.resume();
        resolve(match[0]);
      }
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
    proc.on('error', (e) => { clearTimeout(timer); reject(e); });
    proc.on('exit', (code) => { clearTimeout(timer); reject(new Error(`cloudflared exited with code ${code}`)); });
  });

  // Wait for Cloudflare edge DNS to propagate so users never hit NXDOMAIN
  for (let i = 0; i < 15; i++) {
    try {
      const ping = await fetch(urlFound, { method: 'HEAD', signal: AbortSignal.timeout(2000) });
      if (ping.status < 500) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 1000));
  }

  global._tunnelUrl = urlFound;
  console.log(`[tunnel] Live at ${urlFound}`);

  try {
    db.dbWrite('active-tunnel', { url: urlFound, updatedAt: new Date().toISOString(), active: true });
  } catch {}

  const cfUrl = process.env.DASHBOARD_WORKER_URL || process.env.CLOUDFLARE_WORKER_URL || 'https://officeos-dashboard.taion16240.workers.dev';
  const cfToken = process.env.DASHBOARD_ADMIN_TOKEN || process.env.CLOUDFLARE_WORKER_TOKEN;
  if (cfUrl && cfUrl.startsWith('http')) {
    try {
      fetch(`${cfUrl.replace(/\/+$/, '')}/api/tunnel/register`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(cfToken ? { Authorization: `Bearer ${cfToken}` } : {}),
        },
        body: JSON.stringify({ url: urlFound }),
      }).catch(() => {});
    } catch {}
  }

  proc.on('exit', () => {
    global._tunnelUrl = null;
    global._tunnelProc = null;
    console.log('[tunnel] Tunnel closed');
    try {
      db.dbWrite('active-tunnel', { url: null, updatedAt: new Date().toISOString(), active: false });
    } catch {}
    if (cfUrl && cfUrl.startsWith('http')) {
      try {
        fetch(`${cfUrl.replace(/\/+$/, '')}/api/tunnel/stop`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(cfToken ? { Authorization: `Bearer ${cfToken}` } : {}),
          },
        }).catch(() => {});
      } catch {}
    }
  });

  return urlFound;
}

const server = http.createServer(async (req, res) => {
  const reqUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = reqUrl.pathname;
  const method = req.method;

  // Handle CORS preflight
  if (method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, Accept',
    });
    res.end();
    return;
  }

  try {
    // ── First-Run Setup Detection ──────────────────────────────────────────
    // If no SMTP is configured yet, redirect browsers to /setup so the
    // operator can enter credentials through a guided wizard. API calls and
    // static assets are never redirected so the setup page itself can load.
    const SETUP_FLAG = path.resolve(__dirname, '../data/.setup-complete');
    const setupComplete = fs.existsSync(SETUP_FLAG);
    const smtpConfigured = !!(process.env.CW_SMTP_PASS || process.env.SMTP_PASS);

    if (!setupComplete && !smtpConfigured) {
      // Allow setup page and its API to load without redirect
      const isSetupRoute = pathname === '/setup' ||
        pathname === '/setup.html' ||
        pathname.startsWith('/api/setup/') ||
        /\.(css|js|png|jpg|svg|ico|woff2?)$/.test(pathname);

      if (!isSetupRoute && !pathname.startsWith('/api/')) {
        res.writeHead(302, { Location: '/setup', 'Cache-Control': 'no-store' });
        res.end();
        return;
      }
    }

    // ── Setup Wizard API Routes (public — no auth needed) ──────────────────
    if (pathname.startsWith('/api/setup/')) {
      // POST /api/setup/service-account — write service-account.json
      if (pathname === '/api/setup/service-account' && method === 'POST') {
        const body = await parseBody(req);
        if (!body.json) { sendJson(res, 400, { error: 'json field required' }); return; }
        let parsed;
        try { parsed = JSON.parse(body.json); } catch { sendJson(res, 400, { error: 'Invalid JSON' }); return; }
        if (!parsed.client_email || !parsed.private_key) {
          sendJson(res, 400, { error: 'JSON missing client_email or private_key' });
          return;
        }
        const saPath = path.resolve(__dirname, '../service-account.json');
        fs.writeFileSync(saPath, JSON.stringify(parsed, null, 2), 'utf8');
        sendJson(res, 200, { ok: true });
        return;
      }

      // POST /api/setup/env — write/merge variables into .env
      if (pathname === '/api/setup/env' && method === 'POST') {
        const body = await parseBody(req);
        const vars = body.vars || {};
        const envPath = path.resolve(__dirname, '../.env');
        let existing = '';
        if (fs.existsSync(envPath)) existing = fs.readFileSync(envPath, 'utf8');

        // Parse existing .env into a map
        const lines = existing.split(/\r?\n/);
        const envMap = new Map();
        const comments = [];
        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed.startsWith('#') || trimmed === '') {
            comments.push(line);
          } else {
            const eq = line.indexOf('=');
            if (eq > 0) {
              const k = line.slice(0, eq).trim();
              const v = line.slice(eq + 1);
              envMap.set(k, v);
            }
          }
        }
        // Merge new vars
        for (const [k, v] of Object.entries(vars)) {
          envMap.set(k, v);
        }
        // Rebuild .env — existing comments first, then all key=value pairs
        const newLines = [...comments];
        for (const [k, v] of envMap) {
          newLines.push(`${k}=${v}`);
        }
        fs.writeFileSync(envPath, newLines.join('\n') + '\n', 'utf8');
        // Reload env vars in-process so server uses them without restart
        for (const [k, v] of Object.entries(vars)) {
          process.env[k] = v;
        }
        sendJson(res, 200, { ok: true });
        return;
      }

      // POST /api/setup/complete — mark setup as done, write flag file
      if (pathname === '/api/setup/complete' && method === 'POST') {
        const dataDir = path.resolve(__dirname, '../data');
        if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
        fs.writeFileSync(SETUP_FLAG, new Date().toISOString(), 'utf8');
        sendJson(res, 200, { ok: true });
        return;
      }

      // GET /api/setup/generate-install-cmd — builds a one-liner PowerShell
      // install command with all credentials baked in as a base64 blob so
      // another machine can run it and be fully configured automatically.
      if (pathname === '/api/setup/generate-install-cmd' && method === 'GET') {
        try {
          const CRED_KEYS = [
            'CW_NAME','CW_SPREADSHEET_ID','CW_MASTER_TAB_NAME',
            'CW_SMTP_HOST','CW_SMTP_PORT','CW_SMTP_SECURE',
            'CW_SMTP_USER','CW_SMTP_PASS','CW_FROM_EMAIL','CW_FROM_NAME','CW_BCC_EMAIL',
            'RM_NAME','RM_SPREADSHEET_ID','RM_MASTER_TAB_NAME',
            'RM_SMTP_HOST','RM_SMTP_PORT','RM_SMTP_SECURE',
            'RM_SMTP_USER','RM_SMTP_PASS','RM_FROM_EMAIL','RM_FROM_NAME','RM_BCC_EMAIL',
            'MAX_EMAILS_PER_RUN',
          ];
          const credObj = {};

          // 1. Read from database first (works in both Node and Cloudflare Worker KV)
          let dbCreds = null;
          try { dbCreds = db.dbRead('mailer-credentials'); } catch {}
          if (dbCreds && dbCreds.vars) {
            for (const k of CRED_KEYS) {
              if (dbCreds.vars[k]) credObj[k] = dbCreds.vars[k];
            }
            if (dbCreds.serviceAccount) {
              credObj['_SA_JSON'] = typeof dbCreds.serviceAccount === 'string'
                ? dbCreds.serviceAccount
                : JSON.stringify(dbCreds.serviceAccount);
            }
          }

          // 2. Overlay / fall back to local .env and service-account.json
          const envPath = path.resolve(__dirname, '../.env');
          const saPath  = path.resolve(__dirname, '../service-account.json');
          const envText = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
          const saText  = fs.existsSync(saPath)  ? fs.readFileSync(saPath,  'utf8') : '';

          if (envText) {
            for (const line of envText.split(/\r?\n/)) {
              const eq = line.indexOf('=');
              if (eq < 1) continue;
              const k = line.slice(0, eq).trim();
              if (CRED_KEYS.includes(k) && !credObj[k]) credObj[k] = line.slice(eq + 1).trim();
            }
          }
          for (const k of CRED_KEYS) {
            if (!credObj[k] && process.env[k]) credObj[k] = process.env[k];
          }
          if (!credObj['_SA_JSON'] && saText) credObj['_SA_JSON'] = saText;
          if (!credObj['_SA_JSON'] && process.env.GOOGLE_SERVICE_ACCOUNT_KEY_JSON) {
            credObj['_SA_JSON'] = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_JSON;
          }

          const blob = Buffer.from(JSON.stringify(credObj)).toString('base64');
          const rawUrl = 'https://raw.githubusercontent.com/Ettekhar/Office-Automation-System/main/install.ps1';
          const cmd = `$env:MAILER_CREDS='${blob}'; irm ${rawUrl} | iex`;
          sendJson(res, 200, { cmd, credCount: Object.keys(credObj).length, fromDatabase: !!(dbCreds && dbCreds.vars) });
        } catch (e) {
          sendJson(res, 500, { error: e.message });
        }
        return;
      }

      sendJson(res, 404, { error: 'Setup route not found' });
      return;
    }

    // ── Mailer Credentials Settings API (Database & Cloudflare KV backed) ──
    // GET  /api/settings/credentials           — read credentials from database & .env (passwords masked)
    // POST /api/settings/credentials           — save credentials to database + .env + in-process
    // POST /api/settings/credentials/sync-cloud— sync local database credentials to Cloudflare KV remote
    if (pathname.startsWith('/api/settings/')) {
      const CRED_KEYS = [
        'CW_NAME','CW_SPREADSHEET_ID','CW_MASTER_TAB_NAME',
        'CW_SMTP_HOST','CW_SMTP_PORT','CW_SMTP_SECURE',
        'CW_SMTP_USER','CW_SMTP_PASS','CW_FROM_EMAIL','CW_FROM_NAME','CW_BCC_EMAIL',
        'RM_NAME','RM_SPREADSHEET_ID','RM_MASTER_TAB_NAME',
        'RM_SMTP_HOST','RM_SMTP_PORT','RM_SMTP_SECURE',
        'RM_SMTP_USER','RM_SMTP_PASS','RM_FROM_EMAIL','RM_FROM_NAME','RM_BCC_EMAIL',
        'MAX_EMAILS_PER_RUN',
        'GEMINI_API_KEY','GROQ_API_KEY','OPENROUTER_API_KEY','MISTRAL_API_KEY',
        'CLICKUP_API_TOKEN','CLICKUP_AUTO_CLOSE_ENABLED',
        'CLOUDFLARE_WORKER_URL','CLOUDFLARE_WORKER_TOKEN',
      ];
      const PASS_KEYS = new Set(['CW_SMTP_PASS','RM_SMTP_PASS','GEMINI_API_KEY','GROQ_API_KEY','OPENROUTER_API_KEY','MISTRAL_API_KEY','CLICKUP_API_TOKEN','CLOUDFLARE_WORKER_TOKEN']);

      if (pathname === '/api/settings/credentials' && method === 'GET') {
        try {
          let dbCreds = null;
          try { dbCreds = db.dbRead('mailer-credentials'); } catch {}

          const envPath = path.resolve(__dirname, '../.env');
          const saPath  = path.resolve(__dirname, '../service-account.json');
          const envText = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';

          const envMap = {};
          // Start with database values
          if (dbCreds && dbCreds.vars) {
            for (const [k, v] of Object.entries(dbCreds.vars)) {
              if (CRED_KEYS.includes(k)) envMap[k] = v;
            }
          }
          // Overlay or supplement with .env file
          if (envText) {
            for (const line of envText.split(/\r?\n/)) {
              const eq = line.indexOf('=');
              if (eq < 1) continue;
              const k = line.slice(0, eq).trim();
              if (k.startsWith('#')) continue;
              if (CRED_KEYS.includes(k) && !envMap[k]) {
                envMap[k] = line.slice(eq + 1).trim();
              }
            }
          }
          // Supplement with process.env
          for (const k of CRED_KEYS) {
            if (!envMap[k] && process.env[k]) envMap[k] = process.env[k];
          }

          // Service account status
          let saStatus = 'missing';
          let saEmail = '';
          if (dbCreds && dbCreds.serviceAccount) {
            const sa = typeof dbCreds.serviceAccount === 'string'
              ? JSON.parse(dbCreds.serviceAccount)
              : dbCreds.serviceAccount;
            saEmail = sa.client_email || '';
            saStatus = saEmail ? 'ok' : 'invalid';
          } else if (fs.existsSync(saPath)) {
            try {
              const sa = JSON.parse(fs.readFileSync(saPath, 'utf8'));
              saEmail = sa.client_email || '';
              saStatus = saEmail ? 'ok' : 'invalid';
            } catch { saStatus = 'invalid'; }
          } else if (process.env.GOOGLE_SERVICE_ACCOUNT_KEY_JSON) {
            try {
              const sa = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY_JSON);
              saEmail = sa.client_email || '';
              saStatus = saEmail ? 'ok' : 'invalid';
            } catch { saStatus = 'invalid'; }
          }

          sendJson(res, 200, {
            credentials: envMap,
            passKeys: [...PASS_KEYS],
            saStatus,
            saEmail,
            inDatabase: !!(dbCreds && dbCreds.vars),
            lastUpdated: dbCreds?.updatedAt || null,
          });
        } catch (e) {
          sendJson(res, 500, { error: e.message });
        }
        return;
      }

      if (pathname === '/api/settings/credentials' && method === 'POST') {
        try {
          const body = await parseBody(req);
          const vars = body.vars || {};       // key→value pairs to update
          const saJson = body.saJson || null; // optional new service-account JSON string

          // 1. Load or initialize database record
          let dbCreds = null;
          try { dbCreds = db.dbRead('mailer-credentials'); } catch {}
          if (!dbCreds || typeof dbCreds !== 'object') {
            dbCreds = {
              updatedAt: '',
              description: 'OfficeOS Mailer & Integration Credentials Database',
              vars: {},
              serviceAccount: null,
            };
          }
          if (!dbCreds.vars) dbCreds.vars = {};

          // 2. Service account update
          let parsedSa = null;
          if (saJson) {
            try { parsedSa = JSON.parse(saJson); }
            catch { sendJson(res, 400, { error: 'Invalid service-account JSON' }); return; }
            if (!parsedSa.client_email || !parsedSa.private_key) {
              sendJson(res, 400, { error: 'service-account JSON missing client_email or private_key' });
              return;
            }
            dbCreds.serviceAccount = parsedSa;
            try {
              const saPath = path.resolve(__dirname, '../service-account.json');
              fs.writeFileSync(saPath, JSON.stringify(parsedSa, null, 2), 'utf8');
            } catch {}
          }

          // 3. Merge vars into database record & process.env
          for (const [k, v] of Object.entries(vars)) {
            dbCreds.vars[k] = v;
            process.env[k] = v;
          }
          dbCreds.updatedAt = new Date().toISOString();

          // 4. Save to database (writes to KV on Cloudflare, data/*.json locally)
          db.dbWrite('mailer-credentials', dbCreds);

          // 5. Merge vars into local .env if on Node.js
          try {
            const envPath = path.resolve(__dirname, '../.env');
            if (fs.existsSync(envPath)) {
              const existing = fs.readFileSync(envPath, 'utf8');
              const lines = existing.split(/\r?\n/);
              const envMap = new Map();
              const headerLines = [];
              let inHeader = true;
              for (const line of lines) {
                const trimmed = line.trim();
                if (trimmed.startsWith('#') || trimmed === '') {
                  if (inHeader) headerLines.push(line);
                } else {
                  inHeader = false;
                  const eq = line.indexOf('=');
                  if (eq > 0) envMap.set(line.slice(0, eq).trim(), line.slice(eq + 1));
                }
              }
              for (const [k, v] of Object.entries(vars)) {
                if (v !== '' || envMap.has(k)) envMap.set(k, v);
              }
              const newLines = [...headerLines];
              for (const [k, v] of envMap) newLines.push(`${k}=${v}`);
              fs.writeFileSync(envPath, newLines.join('\n') + '\n', 'utf8');
            }
          } catch {}

          sendJson(res, 200, {
            ok: true,
            inDatabase: true,
            updated: Object.keys(vars).length,
            saUpdated: !!saJson,
            updatedAt: dbCreds.updatedAt,
          });
        } catch (e) {
          sendJson(res, 500, { error: e.message });
        }
        return;
      }

      // POST /api/settings/credentials/sync-cloud — push current database credentials to Cloudflare KV remote
      if (pathname === '/api/settings/credentials/sync-cloud' && method === 'POST') {
        try {
          const { execSync } = await import('child_process');
          const dbFile = path.resolve(__dirname, '../data/mailer-credentials.json');
          const configPath = 'cloudflare-worker/dashboard-wrangler.toml';
          const nsId = 'c44955e25a1c4791a89f3f3783213e12';

          if (!fs.existsSync(dbFile)) {
            sendJson(res, 400, { error: 'data/mailer-credentials.json does not exist' });
            return;
          }

          const out = execSync(
            `npx wrangler kv key put "mailer-credentials" --path "${dbFile}" --namespace-id ${nsId} --remote --config ${configPath}`,
            { cwd: path.resolve(__dirname, '..'), encoding: 'utf8', timeout: 30000 }
          );

          sendJson(res, 200, { ok: true, output: out.trim(), syncedAt: new Date().toISOString() });
        } catch (e) {
          sendJson(res, 500, { error: e.message, stderr: e.stderr?.toString() });
        }
        return;
      }

      sendJson(res, 404, { error: 'Settings route not found' });
      return;
    }

    // ── Cloud Sync API (Seamless Local ↔ Cloud Settings Sync) ──────────────
    // GET  /api/cloud-sync/export — export settings bundle (sheet-credentials, mailer-credentials, etc.)
    // POST /api/cloud-sync/push   — apply settings bundle to current environment (KV or local)
    // POST /api/cloud-sync/pull   — pull and apply settings from the cloud dashboard
    // GET  /api/cloud-sync/status — check cloud sync status and configured endpoint
    if (pathname.startsWith('/api/cloud-sync/')) {
      const {
        getExportBundle,
        applySettingsBundle,
        pullSettingsFromCloud,
        getCloudConfig,
      } = await import('./cloudSync.js');

      if (pathname === '/api/cloud-sync/export' && method === 'GET') {
        const bundle = getExportBundle();
        sendJson(res, 200, bundle);
        return;
      }

      if (pathname === '/api/cloud-sync/push' && method === 'POST') {
        try {
          const body = await parseBody(req);
          const stats = applySettingsBundle(body);
          sendJson(res, 200, { ok: true, stats, appliedAt: new Date().toISOString() });
        } catch (e) {
          sendJson(res, 400, { ok: false, error: e.message });
        }
        return;
      }

      if (pathname === '/api/cloud-sync/pull' && method === 'POST') {
        try {
          const result = await pullSettingsFromCloud();
          sendJson(res, result.ok ? 200 : 502, result);
        } catch (e) {
          sendJson(res, 500, { ok: false, error: e.message });
        }
        return;
      }

      if (pathname === '/api/cloud-sync/status' && method === 'GET') {
        const config = getCloudConfig();
        sendJson(res, 200, {
          ok: true,
          cloudUrl: config.url,
          hasToken: !!config.token,
          lastExport: new Date().toISOString(),
        });
        return;
      }

      sendJson(res, 404, { error: 'Cloud sync route not found' });
      return;
    }

    // ── Cloudflare Quick Tunnel API ────────────────────────────────────────
    // /api/tunnel/start    POST — start local tunnel or return registered cloud tunnel
    // /api/tunnel/register POST — register live tunnel URL from local PC to cloud
    // /api/tunnel/status   GET  — current tunnel status & live URL
    // /api/tunnel/stop     POST — stop the tunnel process & clear registration
    if (pathname.startsWith('/api/tunnel/')) {
      if (pathname === '/api/tunnel/start' && method === 'POST') {
        if (global._tunnelUrl) {
          sendJson(res, 200, { ok: true, url: global._tunnelUrl, alreadyRunning: true });
          return;
        }

        const isWorkerEnv = typeof fs.createWriteStream !== 'function' || typeof process?.versions?.node === 'undefined';
        if (isWorkerEnv) {
          let stored = null;
          try { stored = db.dbRead('active-tunnel'); } catch {}
          if (stored && stored.active && stored.url) {
            sendJson(res, 200, { ok: true, url: stored.url, registeredFromLocal: true });
            return;
          }
          sendJson(res, 400, {
            error: 'Tunnels connect from your local PC to this cloud dashboard. Run the installer or local server on your PC to connect.',
            isWorker: true,
          });
          return;
        }

        try {
          const urlFound = await startCloudflareTunnel(DEFAULT_PORT);
          sendJson(res, 200, { ok: true, url: urlFound });
        } catch (e) {
          console.error('[tunnel] Failed to start:', e.message);
          sendJson(res, 500, { error: e.message });
        }
        return;
      }

      // POST /api/tunnel/register — register live tunnel from local operator PC
      if (pathname === '/api/tunnel/register' && method === 'POST') {
        try {
          const body = await parseBody(req);
          const tunnelUrl = (body.url || '').trim();
          if (!tunnelUrl || !tunnelUrl.startsWith('https://')) {
            sendJson(res, 400, { error: 'Invalid tunnel URL' });
            return;
          }
          global._tunnelUrl = tunnelUrl;
          try {
            db.dbWrite('active-tunnel', { url: tunnelUrl, updatedAt: new Date().toISOString(), active: true });
          } catch {}
          console.log(`[tunnel] Registered active tunnel: ${tunnelUrl}`);
          sendJson(res, 200, { ok: true, url: tunnelUrl });
        } catch (e) {
          sendJson(res, 500, { error: e.message });
        }
        return;
      }

      if (pathname === '/api/tunnel/status' && method === 'GET') {
        let activeUrl = global._tunnelUrl || null;
        let lastUpdated = null;
        if (!activeUrl) {
          try {
            const stored = db.dbRead('active-tunnel');
            if (stored && stored.active && stored.url) {
              const ageMs = Date.now() - new Date(stored.updatedAt).getTime();
              // Valid if updated within last 1 hour
              if (ageMs < 60 * 60 * 1000) {
                activeUrl = stored.url;
                lastUpdated = stored.updatedAt;
              }
            }
          } catch {}
        }
        sendJson(res, 200, { running: !!activeUrl, url: activeUrl, lastUpdated });
        return;
      }

      if (pathname === '/api/tunnel/stop' && method === 'POST') {
        if (global._tunnelProc) {
          try { global._tunnelProc.kill(); } catch {}
          global._tunnelProc = null;
        }
        global._tunnelUrl = null;
        try {
          db.dbWrite('active-tunnel', { url: null, updatedAt: new Date().toISOString(), active: false });
        } catch {}
        sendJson(res, 200, { ok: true });
        return;
      }

      sendJson(res, 404, { error: 'Tunnel route not found' });
      return;
    }

    // ── Server Control API ─────────────────────────────────────────────────
    // POST /api/server/open-terminal  — open a new terminal window running
    // START-HERE.bat so the operator can start the mailer server from the UI.
    // GET  /api/server/status         — simple liveness ping (always 200 if server is up).
    if (pathname.startsWith('/api/server/')) {
      if (pathname === '/api/server/status' && method === 'GET') {
        sendJson(res, 200, { ok: true, uptime: Math.round(process.uptime()), port: DEFAULT_PORT });
        return;
      }
      if (pathname === '/api/server/open-terminal' && method === 'POST') {
        try {
          const { spawn } = await import('child_process');
          const projectRoot = path.resolve(__dirname, '..');
          const batFile = path.join(projectRoot, 'START-HERE.bat');
          if (!fs.existsSync(batFile)) {
            sendJson(res, 404, { error: 'START-HERE.bat not found in project root' });
            return;
          }
          // Open a new visible cmd.exe window running the batch file
          spawn('cmd.exe', ['/c', 'start', 'cmd.exe', '/k', `"${batFile}"`], {
            cwd: projectRoot,
            detached: true,
            stdio: 'ignore',
            shell: false,
          }).unref();
          sendJson(res, 200, { ok: true, launched: batFile });
        } catch (e) {
          sendJson(res, 500, { error: e.message });
        }
        return;
      }
      sendJson(res, 404, { error: 'Server control route not found' });
      return;
    }

    // ── Authentication Routes  (public — no session required) ─────────────
    // All /api/auth/* routes are handled before any auth check so that the
    // login page can reach them with no existing session cookie.
    if (pathname.startsWith('/api/auth/')) {
      const {
        handleLogin, handleLogout, handleMe,
        handleGoogleStart, handleGoogleCallback, handleSetPassword,
      } = await import('./auth.js');

      // POST /api/auth/login
      if (pathname === '/api/auth/login' && method === 'POST') {
        const body = await parseBody(req).catch(() => ({}));
        return handleLogin(req, res, body);
      }
      // POST /api/auth/logout
      if (pathname === '/api/auth/logout' && (method === 'POST' || method === 'GET')) {
        return handleLogout(req, res);
      }
      // GET /api/auth/me
      if (pathname === '/api/auth/me' && method === 'GET') {
        return handleMe(req, res);
      }
      // GET /api/auth/google  — start OAuth
      if (pathname === '/api/auth/google' && method === 'GET') {
        return handleGoogleStart(req, res, reqUrl);
      }
      // GET /api/auth/google/callback  — OAuth code exchange
      if (pathname === '/api/auth/google/callback' && method === 'GET') {
        return handleGoogleCallback(req, res, reqUrl);
      }
      // POST /api/auth/set-password  — superadmin sets a user's password
      if (pathname === '/api/auth/set-password' && method === 'POST') {
        const body = await parseBody(req).catch(() => ({}));
        const authUser = db.resolveAuthUser(req);
        return handleSetPassword(req, res, body, authUser);
      }

      sendJson(res, 404, { error: 'Auth route not found.' });
      return;
    }

    // ── Static pages that must be publicly accessible (no session) ─────────
    // /login.html is served by the static handler below; skip auth for it.
    const PUBLIC_PATHS = ['/login.html', '/master.css', '/dashboard.css'];
    const isPublicPath = PUBLIC_PATHS.some(p => pathname === p || pathname.startsWith('/assets/'));
    const isPublicAsset = /\.(css|js|png|jpg|jpeg|webp|svg|ico|woff2?)$/.test(pathname);

    // ── Session-based auth guard for the master dashboard ──────────────────
    // The master.html and master-app.js require a valid session. If there is
    // no session cookie, redirect to /login.html so the user can sign in.
    // API routes are NOT redirected — they return 401 JSON so the client
    // can handle it programmatically.
    if (pathname === '/master.html' || pathname === '/') {
      const authUser = db.resolveAuthUser(req);
      if (!authUser) {
        res.writeHead(302, { Location: '/login.html', 'Cache-Control': 'no-store' });
        res.end();
        return;
      }
    }

    // API Route: Accounts Config (sender info for UI)
    if (pathname === '/api/accounts' && method === 'GET') {
      const { getAllAccountConfigs } = await import('./config.js');
      const allConfigs = getAllAccountConfigs();
      const safeAccounts = allConfigs.map((a) => ({
        key: a.key,
        name: a.name,
        fromEmail: a.fromEmail,
        fromName: a.fromName,
        smtpHost: a.smtp.host,
        smtpPort: a.smtp.port,
      }));
      sendJson(res, 200, { accounts: safeAccounts });
      return;
    }

    // API Route: Overview Data
    if (pathname === '/api/overview' && method === 'GET') {
      const month = reqUrl.searchParams.get('month') || null;
      const account = reqUrl.searchParams.get('account') || 'all';
      const data = await getOverviewData(month, account);
      sendJson(res, 200, data);
      return;
    }

    // API Route: Preview single site
    if (pathname === '/api/preview' && method === 'GET') {
      const websiteUrl = reqUrl.searchParams.get('websiteUrl');
      const month = reqUrl.searchParams.get('month') || null;
      const account = reqUrl.searchParams.get('account') || null;
      if (!websiteUrl) {
        sendJson(res, 400, { error: 'websiteUrl query param is required' });
        return;
      }
      const data = await getSitePreview(websiteUrl, month, account);
      sendJson(res, 200, data);
      return;
    }

    // API Route: Generate all previews
    if (pathname === '/api/generate-all' && method === 'POST') {
      const body = await parseBody(req).catch(() => ({}));
      const month = body.month || reqUrl.searchParams.get('month') || null;
      const account = body.account || reqUrl.searchParams.get('account') || 'all';
      const data = await generateAllPreviews(month, account);
      sendJson(res, 200, data);
      return;
    }

    // API Route: Get all Account Managers directory (names, IDs, fresh email addresses)
    if (pathname === '/api/clickup/account-managers' && method === 'GET') {
      const data = getAccountManagersList();
      sendJson(res, 200, { success: true, ...data });
      return;
    }

    // API Route: Preview ClickUp task readiness, AM resolution & comment preview
    if (pathname === '/api/clickup/preview-task' && method === 'GET') {
      const timeTrackUrl = reqUrl.searchParams.get('timeTrackUrl') || '';
      const websiteUrl = reqUrl.searchParams.get('websiteUrl') || '';
      const accountManager = reqUrl.searchParams.get('accountManager') || '';
      const month = reqUrl.searchParams.get('month') || '';
      const data = await getClickUpTaskPreview({
        timeTrackUrl,
        websiteUrl,
        accountManager,
        monthName: month,
      });
      sendJson(res, 200, { success: true, ...data });
      return;
    }

    // API Route: Sync / Close ClickUp task alone (without sending email)
    if (pathname === '/api/clickup/sync-task' && method === 'POST') {
      const body = await parseBody(req);
      const {
        timeTrackUrl,
        websiteUrl,
        accountManager,
        monthName,
        month,
        dryRun = false,
      } = body;

      const result = await completeClickUpMaintenanceTask({
        timeTrackUrl: timeTrackUrl || body.clickupTimeTrackUrl,
        websiteUrl: websiteUrl || 'website',
        accountManager: accountManager || body.am,
        monthName: monthName || month,
        dryRun: Boolean(dryRun),
      });

      sendJson(res, 200, { success: true, result });
      return;
    }

    // API Route: Send single email
    if (pathname === '/api/send-single' && method === 'POST') {
      const body = await parseBody(req);
      const result = await sendSingleEmail({
        to: body.to,
        subject: body.subject,
        html: body.html,
        dryRun: Boolean(body.dryRun),
        accountKey: body.account || body.accountKey || 'CW',
        websiteUrl: body.websiteUrl,
        timeTrackUrl: body.timeTrackUrl || body.clickupTimeTrackUrl,
        accountManager: body.accountManager || body.am,
        monthName: body.month || body.monthName,
        syncClickUp: body.syncClickUp !== false,
      });
      sendJson(res, 200, result);
      return;
    }

    // API Route: Send batch emails
    if (pathname === '/api/send-batch' && method === 'POST') {
      const body = await parseBody(req);
      const { emails, dryRun = false } = body;
      if (!Array.isArray(emails) || emails.length === 0) {
        sendJson(res, 400, { error: 'emails array is required' });
        return;
      }

      const results = [];
      for (const item of emails) {
        try {
          const sent = await sendSingleEmail({
            to: item.to,
            subject: item.subject,
            html: item.html,
            dryRun,
            accountKey: item.account || item.accountKey || 'CW',
            websiteUrl: item.websiteUrl,
            timeTrackUrl: item.timeTrackUrl || item.clickupTimeTrackUrl,
            accountManager: item.accountManager || item.am,
            monthName: item.month || item.monthName,
          });
          results.push({
            websiteUrl: item.websiteUrl,
            account: item.account || 'CW',
            success: true,
            to: item.to,
            clickup: sent.clickup,
          });
        } catch (err) {
          results.push({
            websiteUrl: item.websiteUrl,
            account: item.account || 'CW',
            success: false,
            error: err.message,
          });
        }
        // Small pacing delay
        await new Promise((r) => setTimeout(r, 200));
      }

      sendJson(res, 200, { success: true, results });
      return;
    }

    // ── Conditional email notes ────────────────────────────────────────────
    // A condition registered here is detected in a site's report tab as a cell
    // shaped "<condition>:<link>", and adds its message above "Best Regards,".
    //
    // No role gate, deliberately: every route in this server is unauthenticated,
    // so gating only these four would imply a protection the rest of the app does
    // not have. Attribution instead comes from actorFrom(), and every mutation is
    // written to the audit log.
    if (pathname === '/api/conditional-notes' && method === 'GET') {
      const account = reqUrl.searchParams.get('account') || null;
      sendJson(res, 200, { notes: db.getConditionalNotes(account ? { account } : {}) });
      return;
    }

    if (pathname === '/api/conditional-notes' && method === 'POST') {
      const body = await parseBody(req);
      const actor = actorFrom(req, body, reqUrl);
      try {
        // "accounts" (one or many) is the panel's shape: one action, every sheet
        // the operator ticked. "account" (single) still works, so the CLI and any
        // existing caller are unaffected.
        const many = Array.isArray(body.accounts)
          ? body.accounts
          : (body.accounts ? [body.accounts] : null);
        if (many) {
          const result = db.setConditionalNoteForAccounts({
            accounts: many,
            condition: body.condition,
            message: body.message,
            enabled: body.enabled !== false,
            actor: actor.name,
            actorId: actor.id,
          });
          sendJson(res, 200, { success: true, ...result });
        } else {
          const note = db.createConditionalNote({
            account: body.account || 'CW',
            condition: body.condition,
            message: body.message,
            enabled: body.enabled !== false,
            actor: actor.name,
            actorId: actor.id,
          });
          sendJson(res, 200, { success: true, note });
        }
      } catch (err) {
        sendJson(res, 400, { error: err.message });
      }
      return;
    }

    if (pathname === '/api/conditional-notes/update' && method === 'POST') {
      const body = await parseBody(req);
      if (!body.id) {
        sendJson(res, 400, { error: 'id is required' });
        return;
      }
      const actor = actorFrom(req, body, reqUrl);
      try {
        // Only forward the fields the caller actually sent, so an unrelated
        // update cannot blank out a field it never mentioned.
        const patch = {};
        for (const f of ['account', 'condition', 'message', 'enabled']) {
          if (body[f] !== undefined) patch[f] = body[f];
        }
        const note = db.updateConditionalNote(body.id, patch, {
          actor: actor.name,
          actorId: actor.id,
        });
        sendJson(res, 200, { success: true, note });
      } catch (err) {
        sendJson(res, err.message.startsWith('Conditional note not found') ? 404 : 400, {
          error: err.message,
        });
      }
      return;
    }

    if (pathname === '/api/conditional-notes/delete' && method === 'POST') {
      const body = await parseBody(req);
      if (!body.id) {
        sendJson(res, 400, { error: 'id is required' });
        return;
      }
      const actor = actorFrom(req, body, reqUrl);
      const removed = db.deleteConditionalNote(body.id, {
        actor: actor.name,
        actorId: actor.id,
      });
      sendJson(res, removed ? 200 : 404, removed
        ? { success: true }
        : { error: `Conditional note not found: ${body.id}` });
      return;
    }

    // API Route: Cache status
    if (pathname === '/api/cache/status' && method === 'GET') {
      sendJson(res, 200, getCacheStatus());
      return;
    }

    // API Route: Invalidate cache (force fresh fetch from Sheets on next request)
    if (pathname === '/api/cache/invalidate' && method === 'POST') {
      invalidateCache();
      sendJson(res, 200, { success: true, message: 'Cache cleared. Next request will fetch fresh data from Google Sheets.' });
      return;
    }

    // ═══════════════════════════════════════════════════════════
    // Master Dashboard API  — full CRUD, relational model
    // ═══════════════════════════════════════════════════════════
    if (pathname.startsWith('/api/master/')) {
      const db = await import('./db.js');

      // Helper: parse body, send JSON
      const body  = async () => (method === 'GET' ? {} : await parseBody(req));
      const ok    = (data) => sendJson(res, 200, data);
      const err   = (code, msg) => { sendJson(res, code, { error: msg }); };

      // ── DB Status & Stats ─────────────────────────────────────
      if (pathname === '/api/master/db-status' && method === 'GET') {
        return ok(db.getDbStats());
      }
      if (pathname === '/api/master/stats' && method === 'GET') {
        return ok(db.getDbStats());
      }

      // ── MONTHS ──────────────────────────────────────────────
      // GET /api/master/months — returns all month columns detected from CW sheet + active month
      if (pathname === '/api/master/months' && method === 'GET') {
        const activeMonth = db.getActiveMonth();
        // Try to fetch live month columns from the CW sheet header row
        let sheetMonths = [];
        try {
          const { getTabValues } = await import('./sheets.js');
          const CW_ID = process.env.CW_SPREADSHEET_ID || '19aIBNOb0C4_Fx47bsZ2mUMVAxogX7j_tly8tSg-bldE';
          const rows = await getTabValues('Website List', 'A2:ZZ2', CW_ID);
          const headers = rows?.[0] || [];
          // Month columns: anything that looks like a month name (with optional year) after first 9 fixed columns
          sheetMonths = headers
            .filter((h, i) => i >= 9 && h && /[a-zA-Z]/.test(h) && /[a-zA-Z]+(\.?\s*\d{0,4})?/.test(h.trim()))
            .map(h => h.trim())
            .filter(Boolean);
        } catch (e) {
          console.warn('[months API] Could not fetch sheet columns:', e.message);
        }
        // Merge with db months (in case sheet fetch failed)
        const dbMonths = db.getAllMonths();
        const allSet = new Set([...sheetMonths, ...dbMonths]);
        // Remove very short or purely numeric entries
        const allMonths = Array.from(allSet).filter(m => m.length >= 3 && /[a-zA-Z]/.test(m));
        return ok({ activeMonth, months: allMonths, sheetMonths, dbMonths });
      }

      // POST /api/master/months/select — set active month (no sheet column creation)
      if (pathname === '/api/master/months/select' && method === 'POST') {
        const b = await body();
        if (!b.monthName) return err(400, 'monthName required');
        const mName = b.monthName.trim();
        const meta = db.getMeta();
        db.setMeta({ ...meta, activeMonth: mName });
        try {
          const allDr = db.getDailyReview();
          const overlaid = overlayMonthStatus(allDr, mName);
          db.setDailyReview(overlaid);
        } catch (e) {
          console.warn('[months/select save daily-review error]:', e.message);
        }
        return ok({ success: true, activeMonth: mName });
      }

      // POST /api/master/add-month — create new column in CW & RM sheets + set as active
      if (pathname === '/api/master/add-month' && method === 'POST') {
        const b = await body();
        if (!b.monthName) return err(400, 'monthName required');
        const { appendMonthColumn } = await import('./sheets.js');
        const CW_ID = process.env.CW_SPREADSHEET_ID || '19aIBNOb0C4_Fx47bsZ2mUMVAxogX7j_tly8tSg-bldE';
        const RM_ID = process.env.RM_SPREADSHEET_ID || '1Fbb-SY2fU0HXFdnJ_OQoHb_AwlFzdk39jWOo3kFMcjY';
        try {
          const [cw, rm] = await Promise.all([
            appendMonthColumn(CW_ID, 'Website List', b.monthName),
            appendMonthColumn(RM_ID, 'Website List', b.monthName),
          ]);
          const result = db.addNewMonth(b.monthName);
          return ok({ success: true, cw, rm, ...result });
        } catch (e) { return err(500, e.message); }
      }

      // POST /api/master/cleanup-empty-columns — remove rogue columns after the last meaningful month.
      // Finds the rightmost non-empty header, then deletes everything that comes after it.
      // This fixes both truly-blank columns AND inherited-header rogue columns.
      if (pathname === '/api/master/cleanup-empty-columns' && method === 'POST') {
        const { getSheetsClient } = await import('./sheets.js');
        const { invalidateCache } = await import('./sheetsCache.js');
        const b = await parseBody(req).catch(() => ({}));
        const CW_ID = process.env.CW_SPREADSHEET_ID || '19aIBNOb0C4_Fx47bsZ2mUMVAxogX7j_tly8tSg-bldE';
        const RM_ID = process.env.RM_SPREADSHEET_ID || '1Fbb-SY2fU0HXFdnJ_OQoHb_AwlFzdk39jWOo3kFMcjY';
        // Optional: caller can pass { keepMonth: "September 26" } to delete everything after that specific month
        const keepMonth = (b.keepMonth || '').trim().toLowerCase();

        async function cleanupSheet(spreadsheetId, tabName) {
          const sheets = await getSheetsClient();
          const meta = await sheets.spreadsheets.get({ spreadsheetId });
          const sheetObj = meta.data.sheets.find((s) => s.properties.title === tabName);
          if (!sheetObj) return { error: `Tab "${tabName}" not found` };
          const sheetId = sheetObj.properties.sheetId;

          const headerRes = await sheets.spreadsheets.values.get({
            spreadsheetId,
            range: `'${tabName}'!A2:ZZ2`,
          });
          const headers = headerRes.data.values?.[0] || [];

          // If a specific month was requested, delete everything after it
          let keepUpToIdx = -1;
          if (keepMonth) {
            for (let i = headers.length - 1; i >= 0; i--) {
              if ((headers[i] || '').trim().toLowerCase() === keepMonth) { keepUpToIdx = i; break; }
            }
          }
          // Otherwise find the rightmost non-empty header
          if (keepUpToIdx === -1) {
            for (let i = headers.length - 1; i >= 0; i--) {
              if ((headers[i] || '').trim() !== '') { keepUpToIdx = i; break; }
            }
          }

          const deleteFrom = keepUpToIdx + 1;
          const totalCols = headers.length;
          if (deleteFrom >= totalCols) return { deletedCount: 0, message: 'No rogue columns found', keptMonth: headers[keepUpToIdx] };

          const count = totalCols - deleteFrom;
          console.log(`[cleanup] Deleting ${count} col(s) after index ${keepUpToIdx} ("${headers[keepUpToIdx]}") in ${spreadsheetId}`);
          await sheets.spreadsheets.batchUpdate({
            spreadsheetId,
            requestBody: {
              requests: [{
                deleteDimension: {
                  range: { sheetId, dimension: 'COLUMNS', startIndex: deleteFrom, endIndex: totalCols },
                },
              }],
            },
          });
          invalidateCache();
          return { deletedCount: count, keptMonth: headers[keepUpToIdx], deletedRange: `cols ${deleteFrom}–${totalCols - 1}` };
        }

        try {
          const [cw, rm] = await Promise.all([
            cleanupSheet(CW_ID, 'Website List'),
            cleanupSheet(RM_ID, 'Website List'),
          ]);
          return ok({ success: true, cw, rm });
        } catch (e) { return err(500, e.message); }
      }

      // ── SYNC (Superadmin) ─────────────────────────────────────
      // Supports dry-run: ?dryRun=1 or body {dryRun:true} → full import +
      // diff report, zero writes (see syncFromSheets.syncAll).
      if (pathname === '/api/master/sync' && method === 'POST') {
        const isSSE = req.headers.accept?.includes('text/event-stream');
        const dryRun = reqUrl.searchParams.get('dryRun') === '1'
          || (await parseBody(req).catch(() => ({}))).dryRun === true;
        if (isSSE) {
          res.writeHead(200, {
            'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache',
            'Access-Control-Allow-Origin': '*', Connection: 'keep-alive',
          });
          const { syncAll, onProgress } = await import('./syncFromSheets.js');
          onProgress((step, pct) => res.write(`data: ${JSON.stringify({ step, pct })}\n\n`));
          try {
            const result = await syncAll({ dryRun });
            res.write(`data: ${JSON.stringify({ done: true, ...result })}\n\n`);
          } catch (e) { res.write(`data: ${JSON.stringify({ error: e.message })}\n\n`); }
          return res.end();
        }
        const { syncAll } = await import('./syncFromSheets.js');
        try { return ok(await syncAll({ dryRun })); }
        catch (e) { return err(500, e.message); }
      }

      // ── USERS ──────────────────────────────────────────────────
      // GET /api/master/users
      if (pathname === '/api/master/users' && method === 'GET') {
        const includeMerged = reqUrl.searchParams.get('includeMerged') === '1';
        return ok({ users: db.getUsers({ includeMerged }) });
      }
      // POST /api/master/users  (superadmin)
      if (pathname === '/api/master/users' && method === 'POST') {
        const b = await body();
        if (!b.name) return err(400, 'name required');
        try {
          const user = db.createUser(b);
          const actor = actorFrom(req, b, reqUrl);
          db.appendAuditLog({
            actor: actor.name, actorId: actor.id,
            action: 'create', entity: 'user', entityId: user.id, label: user.name,
            field: 'all', oldValue: null, newValue: `${user.name} (${user.role})`,
            source: 'User Management', reason: 'Team member created',
          });
          return ok({ user });
        }
        catch (e) { return err(400, e.message); }
      }
      // POST /api/master/users/merge  (superadmin)
      if (pathname === '/api/master/users/merge' && method === 'POST') {
        const authUser = db.resolveAuthUser(req);
        const b = await body();
        const reqRole = authUser ? authUser.role : actorFrom(req, b, reqUrl).role;
        if (reqRole !== 'superadmin') return err(403, 'Superadmin access required');

        const { sourceUserId, targetUserId } = b;
        if (!sourceUserId || !targetUserId) return err(400, 'sourceUserId and targetUserId required');
        try {
          const sourceUser = db.getUserById(sourceUserId);
          const targetUser = db.getUserById(targetUserId);
          if (!sourceUser) return err(404, `Source user not found: ${sourceUserId}`);
          if (!targetUser) return err(404, `Target user not found: ${targetUserId}`);

          const mergedUser = db.mergeUsers(sourceUserId, targetUserId);
          const actor = authUser || actorFrom(req, b, reqUrl);
          db.appendAuditLog({
            actor: actor.name, actorId: actor.id,
            action: 'merge', entity: 'user', entityId: targetUserId, label: mergedUser.name,
            field: 'all',
            oldValue: `${sourceUser.name} (${sourceUser.email || sourceUser.googleEmail || 'unlinked'})`,
            newValue: `${mergedUser.name} (${mergedUser.email || mergedUser.googleEmail || 'linked'})`,
            source: 'User Management', reason: `Merged Google account from ${sourceUser.name} into ${mergedUser.name}`,
          });
          return ok({ ok: true, user: mergedUser });
        } catch (e) {
          return err(400, e.message);
        }
      }
      // POST /api/master/users/:id/link-google  (superadmin)
      if (/^\/api\/master\/users\/([^/]+)\/link-google$/.test(pathname) && method === 'POST') {
        const authUser = db.resolveAuthUser(req);
        const b = await body();
        const reqRole = authUser ? authUser.role : actorFrom(req, b, reqUrl).role;
        if (reqRole !== 'superadmin') return err(403, 'Superadmin access required');

        const id = pathname.split('/')[4];
        const { googleEmail } = b;
        if (!googleEmail) return err(400, 'googleEmail required');
        try {
          const user = db.linkUserGoogleEmail(id, googleEmail);
          const actor = authUser || actorFrom(req, b, reqUrl);
          db.appendAuditLog({
            actor: actor.name, actorId: actor.id,
            action: 'update', entity: 'user', entityId: id, label: user.name,
            field: 'googleEmail', oldValue: null, newValue: googleEmail,
            source: 'User Management', reason: `Linked Google account email: ${googleEmail}`,
          });
          return ok({ ok: true, user });
        } catch (e) {
          return err(400, e.message);
        }
      }
      // POST /api/master/users/:id/unlink-google  (superadmin)
      if (/^\/api\/master\/users\/([^/]+)\/unlink-google$/.test(pathname) && method === 'POST') {
        const authUser = db.resolveAuthUser(req);
        const b = await body();
        const reqRole = authUser ? authUser.role : actorFrom(req, b, reqUrl).role;
        if (reqRole !== 'superadmin') return err(403, 'Superadmin access required');

        const id = pathname.split('/')[4];
        try {
          const before = db.getUserById(id);
          const user = db.unlinkGoogleAccount(id);
          const actor = authUser || actorFrom(req, b, reqUrl);
          db.appendAuditLog({
            actor: actor.name, actorId: actor.id,
            action: 'update', entity: 'user', entityId: id, label: user.name,
            field: 'googleSub', oldValue: before?.googleEmail || 'linked', newValue: null,
            source: 'User Management', reason: 'Unlinked Google account',
          });
          return ok({ ok: true, user });
        } catch (e) {
          return err(400, e.message);
        }
      }

      // POST /api/master/users/temp-assign  (admin+)
      if (pathname === '/api/master/users/temp-assign' && method === 'POST') {
        const b = await body();
        const { fromUserId, toUserId, note = '' } = b;
        if (!fromUserId || !toUserId) return err(400, 'fromUserId and toUserId required');
        try {
          const actor = actorFrom(req, b, reqUrl);
          const result = db.assignTempCoverage({
            fromUserId,
            toUserId,
            assignedBy: actor.name || 'Admin',
            note,
          });
          db.appendAuditLog({
            actor: actor.name, actorId: actor.id,
            action: 'temp_assign', entity: 'user', entityId: fromUserId,
            label: `${result.fromUser.name} -> ${result.toUser.name}`,
            field: 'tempAssignedTo', oldValue: '', newValue: result.toUser.name,
            source: 'User Management', reason: note || 'Temporary site coverage assigned',
          });
          return ok({ ok: true, ...result, users: db.getUsers({ includeMerged: true }) });
        } catch (e) {
          return err(400, e.message);
        }
      }

      // POST /api/master/users/temp-unassign  (admin+)
      if (pathname === '/api/master/users/temp-unassign' && method === 'POST') {
        const b = await body();
        const { fromUserId, toUserId } = b;
        if (!fromUserId || !toUserId) return err(400, 'fromUserId and toUserId required');
        try {
          const actor = actorFrom(req, b, reqUrl);
          const result = db.removeTempCoverage({ fromUserId, toUserId });
          db.appendAuditLog({
            actor: actor.name, actorId: actor.id,
            action: 'temp_unassign', entity: 'user', entityId: fromUserId,
            label: `Revoked coverage (${fromUserId} -> ${toUserId})`,
            field: 'tempAssignedTo', oldValue: toUserId, newValue: '',
            source: 'User Management', reason: 'Temporary coverage revoked',
          });
          return ok({ ok: true, ...result, users: db.getUsers({ includeMerged: true }) });
        } catch (e) {
          return err(400, e.message);
        }
      }

      // PUT /api/master/users/:id  (superadmin)
      if (/^\/api\/master\/users\/([^/]+)$/.test(pathname) && method === 'PUT') {
        const id = pathname.split('/').pop();
        const b = await body();
        try {
          const before = db.getUserById(id);
          const user = db.updateUser(id, b);
          const fields = ['name', 'role', 'email', 'googleEmail', 'active', 'tempAssignedTo', 'tempCoveringUsers'];
          for (const f of fields) {
            if (before && b[f] !== undefined && String(before[f] ?? '') !== String(b[f] ?? '')) {
              const actor = actorFrom(req, b, reqUrl);
              db.appendAuditLog({
                actor: actor.name, actorId: actor.id,
                action: 'update', entity: 'user', entityId: user.id, label: user.name,
                field: f, oldValue: before[f] ?? '', newValue: b[f] ?? '',
                source: 'User Management', reason: 'User edited',
              });
            }
          }
          return ok({ user });
        }
        catch (e) { return err(404, e.message); }
      }

      // POST /api/master/sites/bulk-assign — assign multiple sites to users (admin+)
      if (pathname === '/api/master/sites/bulk-assign' && method === 'POST') {
        const b = await body();
        const { siteIds, userIds, mode = 'add' } = b;
        if (!Array.isArray(siteIds) || !Array.isArray(userIds)) {
          return err(400, 'siteIds and userIds arrays required');
        }
        if (!['add', 'replace', 'remove'].includes(mode)) {
          return err(400, `mode must be one of: add, replace, remove (got "${mode}")`);
        }
        if (mode !== 'remove' && !assertActiveAssignees(res, userIds)) return;
        const updated = [];
        const skipped = [];
        const failed = [];
        const writeBack = [];
        const actor = actorFrom(req, b, reqUrl);
        const wbDryRun = !!(b.dryRun || reqUrl?.searchParams?.get('dryRun') === '1');
        // Optimistic-lock pre-check: read every site up front and reject the
        // WHOLE request with 409 if any of them changed since the client
        // loaded them — a partial bulk operation must never silently clobber
        // a concurrent edit. Supports per-site expectations (expectedUpdatedAtMap)
        // and a single blanket expectation (expectedUpdatedAt).
        {
          const stale = [];
          for (const sId of siteIds) {
            const site = db.getSiteById(sId);
            if (!site) continue;
            const expected = (b.expectedUpdatedAtMap && b.expectedUpdatedAtMap[sId])
              || b.expectedUpdatedAt;
            if (expected && !db.assertRecordFresh(site, expected)) stale.push(site);
          }
          if (stale.length) {
            sendJson(res, 409, {
              error: 'STALE_VERSION',
              message: `${stale.length} of ${siteIds.length} selected site(s) changed since you loaded them (someone else edited them). No assignments were made. Refresh and re-select.`,
              entity: 'site',
              staleCount: stale.length,
              current: stale,
            });
            return;
          }
        }
        for (const sId of siteIds) {
          const site = db.getSiteById(sId);
          if (!site) { skipped.push({ siteId: sId, reason: 'site not found' }); continue; }
          let newUsers = Array.isArray(site.assignedUsers) ? [...site.assignedUsers] : [];
          if (mode === 'add') {
            newUsers = [...new Set([...newUsers, ...userIds])];
          } else if (mode === 'replace') {
            newUsers = [...userIds];
          } else if (mode === 'remove') {
            newUsers = newUsers.filter(uid => !userIds.includes(uid));
          }
          const changed = JSON.stringify([...site.assignedUsers].sort()) !== JSON.stringify([...newUsers].sort());
          try {
            // A dry run must commit NOTHING. Previously only the sheet side was
            // suppressed here, so ?dryRun=1 still wrote assignedUsers to the DB
            // while answering as a preview — live data mutated behind a "dry run"
            // label. Report the plan against a synthetic record instead.
            if (wbDryRun) {
              updated.push({ ...site, assignedUsers: newUsers });
              if (changed) {
                const plan = await syncAssignmentToUserTabs({
                  site: { ...site, assignedUsers: newUsers },
                  beforeUserIds: site.assignedUsers || [], afterUserIds: newUsers,
                  actor, source: 'Team Progress UI (bulk, dry run)', dryRun: true,
                });
                writeBack.push({ siteId: sId, ...plan });
              }
              continue;
            }
            const saved = db.assignUsersToSite(sId, newUsers);
            updated.push(saved);
            if (changed) {
              const before = (site.assignedUsers || []).map(uid => db.getUserById(uid)?.name || uid).join(', ') || '(none)';
              const after = newUsers.map(uid => db.getUserById(uid)?.name || uid).join(', ') || '(none)';
              db.appendAuditLog({
                actor: actor.name, actorId: actor.id, source: 'Team Progress UI',
                action: `assignment:${mode}`, entity: 'site', entityId: sId, label: site.url,
                field: 'assignedUsers', oldValue: before, newValue: after,
                reason: `Bulk ${mode === 'add' ? 'assign' : mode === 'replace' ? 'reassign' : 'unassign'} ${userIds.length} user(s)`,
              });
              // DB→Sheets write-back: make the Daily Review per-user tab reflect
              // the assignment (append on add, soft-remove on remove) and persist
              // each row's location so reconcile stops skipping the site.
              try {
                const rep = await syncAssignmentToUserTabs({
                  site, beforeUserIds: site.assignedUsers || [], afterUserIds: newUsers,
                  actor, source: 'Team Progress UI (bulk)', dryRun: false,
                });
                writeBack.push({ siteId: sId, ...rep });
              } catch (e) {
                // Never let a sheet problem undo (or mask) a committed DB assignment.
                console.warn(`[bulk-assign] user-tab write-back failed for ${sId}:`, e.message);
                writeBack.push({ siteId: sId, failed: [{ reason: 'writeback-threw', error: e.message }] });
              }
            }
          } catch (err) {
            console.warn('[bulk-assign] site error:', sId, err.message);
            failed.push({ siteId: sId, reason: err.message });
          }
        }
        return ok({
          success: true,
          count: updated.length,
          assigned: updated.length,
          skipped: skipped.length,
          failed: failed.length,
          skippedDetails: skipped,
          failedDetails: failed,
          dryRun: wbDryRun,
          ...(wbDryRun ? { note: 'Dry run: no DB and no sheet writes were made. `sites` shows the state that WOULD result.' } : {}),
          userTabWriteBack: writeBack,
          sites: updated,
        });
      }
      // DELETE /api/master/users/:id  (superadmin)
      if (/^\/api\/master\/users\/([^/]+)$/.test(pathname) && method === 'DELETE') {
        const id = pathname.split('/').pop();
        const b = await body();
        const before = db.getUserById(id);
        db.deleteUser(id);
        if (before) {
          const actor = actorFrom(req, b, reqUrl);
          db.appendAuditLog({
            actor: actor.name, actorId: actor.id,
            action: 'delete', entity: 'user', entityId: id, label: before.name,
            field: 'all', oldValue: `${before.name} (${before.role})`, newValue: null,
            source: 'User Management', reason: 'Team member deleted',
          });
        }
        return ok({ success: true });
      }

      // ── SITES ──────────────────────────────────────────────────
      // GET /api/master/sites?userId=&account=&month=
      if (pathname === '/api/master/sites' && method === 'GET') {
        const userId  = reqUrl.searchParams.get('userId');
        const account = reqUrl.searchParams.get('account');
        const month   = reqUrl.searchParams.get('month') || db.getActiveMonth();
        let sites = db.getSites({ userId, account });
        // Resolve latestMonthStatus from monthlyHistory for the requested month
        if (month) {
          sites = sites.map(s => {
            // Strict matcher, same as the reconcile path. The previous substring
            // version reported the 2022 entry for a "sep" query, so this endpoint
            // displayed a stale month as if it were the selected one. No match
            // simply leaves latestMonthStatus absent, which is honest.
            const entry = findMonthlyHistoryEntry(s.monthlyHistory || [], month);
            if (entry) {
              return { ...s, latestMonthStatus: entry.status || '', latestMonth: entry.month };
            }
            return s;
          });
        }
        return ok({ sites });
      }
      // POST /api/master/sites  (admin+)
      if (pathname === '/api/master/sites' && method === 'POST') {
        const b = await body();
        try {
          const site = db.addSite(b);
          // Two-way sync: append to respected Google Sheet (CW or RM)
          import('./sheets.js').then(({ appendNewSiteToSheet }) => {
            appendNewSiteToSheet({
              account: site.account,
              siteUrl: site.url,
              company: site.company,
              cms: site.cms,
              accountManager: site.accountManager,
              status: site.status,
              note: site.note,
            }).catch(err => console.warn('[sheet append new site error]:', err.message));
          }).catch(() => {});

          return ok({ site });
        } catch (e) {
          return err(400, e.message);
        }
      }
      // PUT /api/master/sites/:id/status (admin+)
      if (/^\/api\/master\/sites\/([^/]+)\/status$/.test(pathname) && method === 'PUT') {
        const id = pathname.split('/')[4];
        const b = await body();
        try {
          const before = db.getSiteById(id);
          if (!assertFresh(before, b, res, 'site')) return;
          const site = db.toggleSiteStatus(id, b.status);
          // Two-way sync: update Column A in respected Google Sheet
          import('./sheets.js').then(({ updateSiteStatusInSheet }) => {
            updateSiteStatusInSheet({
              account: site.account,
              siteUrl: site.url,
              status: site.status,
            }).catch(err => console.warn('[sheet update site status error]:', err.message));
          }).catch(() => {});
          if (before && before.status !== site.status) {
            const actor = actorFrom(req, b, reqUrl);
            db.appendAuditLog({
              actor: actor.name, actorId: actor.id,
              action: 'update', entity: 'site', entityId: site.id, label: site.url,
              field: 'status', oldValue: before.status, newValue: site.status,
              source: 'Site status toggle', reason: 'Status changed via All Sites / Team Progress',
            });
          }
          return ok({ site });
        } catch (e) {
          return err(404, e.message);
        }
      }
      // PUT /api/master/sites/:id  (admin+)
      if (/^\/api\/master\/sites\/([^/]+)$/.test(pathname) && method === 'PUT') {
        const id = pathname.split('/').pop();
        const b = await body();
        if (Array.isArray(b.assignedUsers) && !assertActiveAssignees(res, b.assignedUsers)) return;
        try {
          const before = db.getSiteById(id);
          if (!assertFresh(before, b, res, 'site')) return;
          // Capture the REAL prior assignees from the pre-update record.
          // updateSite() spreads `b` into the site, so reading assignedUsers
          // after that call would always yield the NEW list and make the change
          // check (and therefore the audit + write-back) unreachable.
          const beforeUsers = [...((before && before.assignedUsers) || [])];
          const dryRun = !!(b.dryRun || reqUrl?.searchParams?.get('dryRun') === '1');
          // A dry run must commit NOTHING — see the note in bulk-assign above.
          // updateSite() spreads `b` in, so a dry run cannot call it at all.
          if (dryRun) {
            const planned = { ...(before || {}), ...b, assignedUsers: Array.isArray(b.assignedUsers) ? [...b.assignedUsers] : beforeUsers };
            let plan = null;
            if (Array.isArray(b.assignedUsers)
              && JSON.stringify([...beforeUsers].sort()) !== JSON.stringify([...b.assignedUsers].sort())) {
              plan = await syncAssignmentToUserTabs({
                site: planned, beforeUserIds: beforeUsers, afterUserIds: b.assignedUsers,
                actor: actorFrom(req, b, reqUrl), source: 'Site edit form (dry run)', dryRun: true,
              });
            }
            return ok({ dryRun: true, site: planned, userTabWriteBack: plan, note: 'Dry run: no DB and no sheet writes were made.' });
          }
          let site = db.updateSite(id, b);
          let userTabWriteBack = null;
          if (Array.isArray(b.assignedUsers)) {
            site = db.assignUsersToSite(id, b.assignedUsers);
            if (JSON.stringify([...beforeUsers].sort()) !== JSON.stringify([...(site.assignedUsers || [])].sort())) {
              const actor = actorFrom(req, b, reqUrl);
              db.appendAuditLog({
                actor: actor.name, actorId: actor.id,
                action: 'assignment:replace', entity: 'site', entityId: site.id, label: site.url,
                field: 'assignedUsers', oldValue: beforeUsers.map(uid => db.getUserById(uid)?.name || uid).join(', ') || '(none)', newValue: (site.assignedUsers || []).map(uid => db.getUserById(uid)?.name || uid).join(', ') || '(none)',
                source: 'Site edit form', reason: 'Assignees changed while editing site',
              });
              // DB→Sheets write-back: append newly assigned sites into each
              // assignee's Daily Review tab, soft-remove the ones dropped, and
              // persist every row location so reconcile stops skipping them.
              try {
                userTabWriteBack = await syncAssignmentToUserTabs({
                  site, beforeUserIds: beforeUsers, afterUserIds: site.assignedUsers || [],
                  actor, source: 'Site edit form',
                  dryRun: false,
                });
              } catch (e) {
                console.warn(`[site-update] user-tab write-back failed for ${id}:`, e.message);
                userTabWriteBack = { failed: [{ reason: 'writeback-threw', error: e.message }] };
              }
            }
          }
          const editableFields = ['cms', 'company', 'contact', 'accountManager', 'note', 'clickupUrl', 'reportUrl', 'backupUrl', 'domainExpiry'];
          for (const f of editableFields) {
            if (b[f] !== undefined && before && String(before[f] || '') !== String(b[f] || '')) {
              const actor = actorFrom(req, b, reqUrl);
              db.appendAuditLog({
                actor: actor.name, actorId: actor.id,
                action: 'update', entity: 'site', entityId: site.id, label: site.url,
                field: f, oldValue: before[f] || '', newValue: b[f] || '',
                source: 'Site edit form', reason: 'Field edited',
              });
            }
          }
          if (b.status) {
            import('./sheets.js').then(({ updateSiteStatusInSheet }) => {
              updateSiteStatusInSheet({
                account: site.account,
                siteUrl: site.url,
                status: site.status,
              }).catch(err => console.warn('[sheet update site status error]:', err.message));
            }).catch(() => {});
          }
          if (b.latestMonthStatus) {
            import('./sheets.js').then(({ syncSiteStatusToSheet }) => {
              syncSiteStatusToSheet({
                account: site.account || 'CW',
                siteUrl: site.url,
                month: site.latestMonth || db.getActiveMonth(),
                status: b.latestMonthStatus,
              }).catch(err => console.warn('[sheet-sync error]:', err.message));
            }).catch(() => {});
          }
          return ok({ site, userTabWriteBack });
        }
        catch (e) { return err(404, e.message); }
      }
      // POST /api/master/sites/:id/assign — assign users to a site (admin+)
      if (/^\/api\/master\/sites\/([^/]+)\/assign$/.test(pathname) && method === 'POST') {
        const id = pathname.split('/')[4];
        const b = await body();
        if (!Array.isArray(b.userIds)) return err(400, 'userIds array required');
        if (!assertActiveAssignees(res, b.userIds)) return;
        try {
          const before = db.getSiteById(id);
          if (!assertFresh(before, b, res, 'site')) return;
          const dryRun = !!(b.dryRun || reqUrl?.searchParams?.get('dryRun') === '1');
          const changed = !!before && JSON.stringify([...(before.assignedUsers || [])].sort()) !== JSON.stringify([...b.userIds].sort());
          // A dry run must commit NOTHING — see the note in bulk-assign above.
          if (dryRun) {
            let plan = null;
            if (changed) {
              plan = await syncAssignmentToUserTabs({
                site: { ...before, assignedUsers: [...b.userIds] },
                beforeUserIds: before.assignedUsers || [], afterUserIds: b.userIds,
                actor: actorFrom(req, b, reqUrl), source: 'Quick assign (dry run)', dryRun: true,
              });
            }
            return ok({ dryRun: true, site: before, userTabWriteBack: plan, note: 'Dry run: no DB and no sheet writes were made.' });
          }
          const site = db.assignUsersToSite(id, b.userIds);
          let userTabWriteBack = null;
          if (changed) {
            const actor = actorFrom(req, b, reqUrl);
            db.appendAuditLog({
              actor: actor.name, actorId: actor.id,
              action: 'assignment:replace', entity: 'site', entityId: site.id, label: site.url,
              field: 'assignedUsers',
              oldValue: (before.assignedUsers || []).map(uid => db.getUserById(uid)?.name || uid).join(', ') || '(none)',
              newValue: (site.assignedUsers || []).map(uid => db.getUserById(uid)?.name || uid).join(', ') || '(none)',
              source: 'Quick assign', reason: 'Assignees changed via quick-assign',
            });
            try {
              userTabWriteBack = await syncAssignmentToUserTabs({
                site, beforeUserIds: before.assignedUsers || [], afterUserIds: site.assignedUsers || [],
                actor, source: 'Quick assign',
                dryRun: false,
              });
            } catch (e) {
              console.warn(`[quick-assign] user-tab write-back failed for ${id}:`, e.message);
              userTabWriteBack = { failed: [{ reason: 'writeback-threw', error: e.message }] };
            }
          }
          return ok({ site, userTabWriteBack });
        }
        catch (e) { return err(404, e.message); }
      }

      // ── MONTHS & TWO-WAY SHEETS SYNC ───────────────────────────
      // GET /api/master/months
      if (pathname === '/api/master/months' && method === 'GET') {
        return ok({
          activeMonth: db.getActiveMonth(),
          months: db.getAllMonths(),
        });
      }
      // POST /api/master/add-month (Superadmin/Admin)
      if (pathname === '/api/master/add-month' && method === 'POST') {
        const b = await body();
        if (!b.monthName) return err(400, 'monthName required');
        const monthName = b.monthName.trim();
        const { appendMonthColumn } = await import('./sheets.js');

        const cwId = process.env.CW_SPREADSHEET_ID || '19aIBNOb0C4_Fx47bsZ2mUMVAxogX7j_tly8tSg-bldE';
        const rmId = process.env.RM_SPREADSHEET_ID || '1Fbb-SY2fU0HXFdnJ_OQoHb_AwlFzdk39jWOo3kFMcjY';

        let cwResult = null, rmResult = null, cwErr = null, rmErr = null;
        try {
          cwResult = await appendMonthColumn(cwId, 'Website List', monthName);
        } catch (e) {
          cwErr = e.message;
          console.error('[add-month CW error]:', e.message);
        }
        try {
          rmResult = await appendMonthColumn(rmId, 'Website List', monthName);
        } catch (e) {
          rmErr = e.message;
          console.error('[add-month RM error]:', e.message);
        }

        const dbRes = db.addNewMonth(monthName);
        return ok({
          success: true,
          monthName,
          cw: cwResult || { error: cwErr },
          rm: rmResult || { error: rmErr },
          db: dbRes,
        });
      }
      // POST /api/master/sync-status (Explicit manual or programmatic sync to sheet)
      if (pathname === '/api/master/sync-status' && method === 'POST') {
        const b = await body();
        if (!b.siteUrl) return err(400, 'siteUrl required');
        const { syncSiteStatusToSheet } = await import('./sheets.js');
        try {
          const res = await syncSiteStatusToSheet({
            account: b.account || 'CW',
            siteUrl: b.siteUrl,
            month: b.month || db.getActiveMonth(),
            status: b.status,
          });
          return ok(res);
        } catch (e) {
          return err(500, e.message);
        }
      }

      // ── DAILY REVIEW ───────────────────────────────────────────
      // GET /api/master/daily-review?userId=&user=&month=
      if (pathname === '/api/master/daily-review' && method === 'GET') {
        let userId   = reqUrl.searchParams.get('userId');
        let userName = reqUrl.searchParams.get('user') || reqUrl.searchParams.get('userName');
        if (userId === 'all' || userName === 'all' || userName === 'All Team Sites') {
          userId = null;
          userName = null;
        }
        const month    = reqUrl.searchParams.get('month') || db.getActiveMonth();
        let rows = db.getDailyReview({ userId, userName });

        if (rows.length === 0 && (userName === 'Superadmin' || userName === 'Admin' || !userName)) {
          const authUser = db.resolveAuthUser(req);
          if (authUser && authUser.id) {
            rows = db.getDailyReview({ userId: authUser.id, userName: authUser.name });
          }
          if (rows.length === 0) {
            rows = db.getDailyReview();
          }
        }

        // Overlay maintenanceStatus from the CW/RM sheet's monthlyHistory for the
        // selected month. This ensures that when "September 26" is chosen and that
        // column is empty in the sheet, the status shows as blank/todo — NOT the
        // stale value carried over from the Daily Review tab's Maintenance column.
        if (month) {
          const sites  = db.getSites({});
          rows = rows.map(row => {
            const site    = sites.find(s => {
              const sUrl = (s.url || '').toLowerCase().replace(/^https?:\/\//, '').replace(/\/$/, '');
              const rUrl = (row.siteUrl || '').toLowerCase().replace(/^https?:\/\//, '').replace(/\/$/, '');
              return sUrl === rUrl || sUrl.includes(rUrl) || rUrl.includes(sUrl);
            });
            if (!site) return row;
            // Strict month matching - see the note on findMonthlyHistoryEntry().
            // The previous substring lookup here let "sep" resolve to the 2022
            // entry "September 22", and that entry's EMPTY status then overwrote
            // completed cells with "To Do". No match means leave the row alone.
            const entry = findMonthlyHistoryEntry(site.monthlyHistory || [], month);
            if (!entry) return row; // month not found in history → keep as-is
            // Found the month column — use its value (may be empty string = not done yet)
            const rawVal = (entry.status || '').trim();
            const normMap = {
              'updated & backup': 'completed', 'completed': 'completed',
              'in progress': 'in_progress', 'to do': 'todo', 'todo': 'todo',
              'pending': 'pending', '': 'todo',
            };
            const normVal = normMap[(rawVal || '').toLowerCase()] || 'todo';
            // Track original stored value for reconcile comparison (_hadMonthEntry)
            return {
              ...row,
              maintenanceStatus: normVal,
              maintenanceRaw: rawVal || '',
              _origMaintenanceRaw: row.maintenanceRaw || '',
              _hadMonthEntry: true,
              // Carried so a refusal log can name the month it refused for. Without
              // it the log had to say "the selected month", which is the least
              // useful thing to read when a blank column did the damage.
              _monthLabel: month,
            };
          });
        }

        // ── Background reconcile: CW/RM sheet is source of truth (BATCHED) ─────────
        // Groups all mismatched rows by userName and writes them all in ONE batchUpdate
        // call per user tab — not one API call per row. Also rate-limited per user+month.
        if (month) {
          // RANK GUARD. A mismatch is not automatically a write. "Higher wins":
          // if the cell already records further-along work than the month status
          // does, the cell is kept and the row is reported, not overwritten. This
          // is what makes an empty month status mean "no information" rather than
          // "not done" — an empty value ranks 0, so it can never displace a real
          // status. Without it this path destroyed recorded work.
          const reconcileDecisions = rows.map(row => {
            if (!row._hadMonthEntry) return null;
            const curRaw = (row._origMaintenanceRaw || '').trim();
            const newRaw = (row.maintenanceRaw || '').trim();
            if (curRaw.toLowerCase() === newRaw.toLowerCase()) return null;
            const decision = shouldWriteReconciledStatus({
              incomingRaw: newRaw,
              // THE HONEST SOURCE, NOT THE DISPLAY VALUE. The overlay above sets
              // maintenanceStatus to "todo" for a blank month column (normMap[''])
              // so the UI has something to render. Passing that in here made a
              // blank source look like a real "todo", which made incomingStatus
              // truthy and skipped the guard's empty-source branch entirely:
              //   from = rank("To Do") = 1, to = rank("" || "todo") = 1, 1 < 1 false
              // so a month column that says NOTHING was waved through and written
              // over recorded work. Verified on 2026-09-27: it blanked "To Do" on
              // Saiful!21. A blank source must reach the guard as a blank status,
              // or the guard cannot see that it carries no information.
              incomingStatus: newRaw ? row.maintenanceStatus : null,
              currentRaw: curRaw,
            });
            return { row, decision };
          });

          // ONLY rows the guard actually approved go to the writer. This line used
          // to be `.filter(Boolean).map(d => d.row)`, which kept refused rows too —
          // harmless only because the restore block below put the old value back
          // first, so they were written as no-ops. Filtering on the decision rather
          // than on presence is what makes "refused" mean "not written at all".
          const mismatchRows = reconcileDecisions.filter(Boolean).filter(d => d.decision.write).map(d => d.row);
          // EVERY refusal, not just one reason string. Matching on
          // 'downgrade-refused' alone meant the empty-source refusals fell through
          // the restore block below and kept the blank value on the row.
          const refusedDowngrades = reconcileDecisions.filter(Boolean).filter(d => !d.decision.write);

          for (const d of refusedDowngrades) {
            const monthVal = (d.row.maintenanceRaw || '').trim();
            const kept = d.row._origMaintenanceRaw;
            // from/to only exist for the rank-compare refusals. An empty-source
            // refusal has no ranks, and printing "undefined -> undefined" for the
            // one case that silently blanked real work was exactly backwards: the
            // vaguer the log, the less likely anyone reads it.
            const via = d.decision.from != null
              ? `${d.decision.from} -> ${d.decision.to}`
              : 'no information in the month column';
            const why = monthVal === ''
              ? `month column "${d.row._monthLabel || 'selected month'}" is blank, which is not "not done"`
              : `month status "${monthVal}" would downgrade recorded work`;
            console.log(
              `[reconcile] keeping "${kept}" on ${d.row.userName} ` +
              `(row ${d.row.rowIndex ?? '?'}): ${why} (${via}) [${d.decision.reason}]`
            );
          }

          // Put the recorded value BACK on the row for every refused downgrade.
          // Without this the guard would only stop the sheet write while the API
          // still returned "To Do", so the UI would display a downgrade that was
          // never persisted - the cell would read Completed and the screen would
          // say To Do. Refusing means refusing everywhere, not just at the writer.
          if (refusedDowngrades.length) {
            const restore = new Map(refusedDowngrades.map(d => [d.row.id, d.row._origMaintenanceRaw]));
            rows = rows.map(row => {
              if (!restore.has(row.id)) return row;
              const kept = restore.get(row.id);
              const normMap = {
                'updated & backup': 'completed', 'completed': 'completed',
                'in progress': 'in_progress', 'to do': 'todo', 'todo': 'todo',
                'pending': 'pending', '': 'todo',
              };
              return { ...row, maintenanceRaw: kept, maintenanceStatus: normMap[kept.toLowerCase()] || row.maintenanceStatus };
            });
          }
          if (mismatchRows.length > 0) {
            // Persist reconciled statuses immediately to daily-review.json on disk
            try {
              const allDr = db.getDailyReview();
              const rowMap = new Map(rows.map(r => [r.id, r]));
              let updatedAny = false;
              allDr.forEach(r => {
                const upd = rowMap.get(r.id);
                if (!upd) return;
                // Same rank guard on the persisted copy. The sheet writer is
                // already protected; this stops a refused downgrade from
                // reaching disk and then being treated as the new truth on the
                // next read, which would make the loss permanent.
                if (r.maintenanceRaw && !upd.maintenanceRaw) return;
                if (upd.maintenanceRaw &&
                    r.maintenanceRaw &&
                    r.maintenanceRaw.toLowerCase() !== upd.maintenanceRaw.toLowerCase() &&
                    maintenanceStatusRank(upd.maintenanceRaw) < maintenanceStatusRank(r.maintenanceRaw)) {
                  return;
                }
                if (r.maintenanceStatus !== upd.maintenanceStatus || r.maintenanceRaw !== upd.maintenanceRaw) {
                  r.maintenanceStatus = upd.maintenanceStatus;
                  r.maintenanceRaw = upd.maintenanceRaw;
                  r.updatedAt = new Date().toISOString();
                  updatedAny = true;
                }
              });
              if (updatedAny) db.setDailyReview(allDr);
            } catch (err) {
              console.warn('[db save daily-review reconcile error]:', err.message);
            }
            // Group by userName
            const byUser = {};
            mismatchRows.forEach(row => {
              if (!row.userName) return;
              (byUser[row.userName] = byUser[row.userName] || []).push(row);
            });

            // Fire ONE batch call per user (only if not already reconciled recently)
            import('./sheets.js').then(async ({ batchUpdateDailyReviewTab }) => {
              // Build active-user name set from DB
              const activeUsers = new Set(
                (db.getUsers ? db.getUsers() : [])
                  .filter(u => u.active !== false)
                  .map(u => (u.name || '').toLowerCase())
              );
              for (const [uName, uRows] of Object.entries(byUser)) {
                // Skip inactive users — no write-back to their sheet tabs
                if (activeUsers.size > 0 && !activeUsers.has(uName.toLowerCase())) {
                  console.log('[reconcile] Skipping ' + uName + ' (inactive user)');
                  continue;
                }
                if (typeof shouldReconcile === 'function' && !shouldReconcile(uName, month)) {
                  console.log('[reconcile] Skipping ' + uName + ' (cooldown active)');
                  continue;
                }
                const updates = uRows.map(r => ({
                  siteUrl: r.siteUrl,
                  rowIndex: r.rowIndex,
                  maintenanceRaw: r.maintenanceRaw,
                  maintenanceStatus: r.maintenanceStatus,
                }));
                console.log('[reconcile] ' + uName + ': ' + updates.length + ' mismatched row(s) for "' + month + '" — 1 batch call');
                await batchUpdateDailyReviewTab({ userName: uName, updates })
                  .catch(err => console.warn('[reconcile] ' + uName + ': ' + err.message));
              }
            }).catch(() => {});
          }
        }

        // ── Enrich rows with maintenance-mode fields (account manager, per-site
        //    CW/RM sheet link, account name) resolved from the site registry ──
        // Per-site sheet links: when a site has no stored reportUrl (RM's
        // "Website List" has no REPORT_URL column), resolve its own tab in that
        // account's spreadsheet (tabs named after the URL) and build a deep link.
        const maintSites = db.getSites ? db.getSites({}) : [];
        const { findMatchingTab } = await import('./reportUtils.js');
        const { listTabMeta } = await import('./sheets.js');
        const { getAccountConfig } = await import('./config.js');
        const tabMetaCache = {}; // spreadsheetId → { titles, gidByTitle }

        async function resolveSheetLink(site) {
          if (site.reportUrl) return site.reportUrl;
          const acct = getAccountConfig(site.account || 'CW');
          if (tabMetaCache[acct.spreadsheetId] === undefined) {
            try {
              const tabs = await listTabMeta(acct.spreadsheetId);
              tabMetaCache[acct.spreadsheetId] = {
                titles: (tabs || []).map(t => t.title),
                gidByTitle: new Map((tabs || []).map(t => [t.title, t.gid])),
              };
            } catch (e) {
              console.warn('[maint] tab meta fallback failed: ' + e.message);
              tabMetaCache[acct.spreadsheetId] = null;
            }
          }
          const meta = tabMetaCache[acct.spreadsheetId];
          if (!meta) return '';
          const matched = findMatchingTab(meta.titles, site.url, acct.masterTabName);
          const gid = matched ? meta.gidByTitle.get(matched) : undefined;
          return matched && gid !== undefined
            ? `https://docs.google.com/spreadsheets/d/${acct.spreadsheetId}/edit#gid=${gid}`
            : '';
        }

        const findMaintSite = (row) =>
          (row.siteId && maintSites.find(s => s.id === row.siteId)) ||
          maintSites.find(s => {
            const sUrl = (s.url || '').toLowerCase().replace(/^https?:\/\//, '').replace(/\/$/, '');
            const rUrl = (row.siteUrl || '').toLowerCase().replace(/^https?:\/\//, '').replace(/\/$/, '');
            return sUrl === rUrl || sUrl.includes(rUrl) || rUrl.includes(sUrl);
          }) ||
          null;

        const enriched = [];
        // Enrich with Google Sheets tab links — wrapped in a per-row timeout so a
        // slow/unavailable Sheets API can't hang the whole response indefinitely.
        const ENRICH_TIMEOUT_MS = 8000;
        for (const row of rows) {
          const site = findMaintSite(row);
          if (!site) {
            enriched.push({ ...row, accountManager: '', reportUrl: '', siteAccount: '' });
            continue;
          }
          try {
            const reportUrl = await Promise.race([
              resolveSheetLink(site),
              new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ENRICH_TIMEOUT_MS)),
            ]);
            enriched.push({
              ...row,
              accountManager: site.accountManager || '',
              clickupTimeTrackUrl: site.clickupTimeTrackUrl || row.clickupTimeTrackUrl || '',
              reportUrl,
              siteAccount: site.account || row.company || '',
            });
          } catch (e) {
            console.warn(`[daily-review] resolveSheetLink failed for ${site.url || row.siteUrl}: ${e.message}`);
            enriched.push({
              ...row,
              accountManager: site.accountManager || '',
              clickupTimeTrackUrl: site.clickupTimeTrackUrl || row.clickupTimeTrackUrl || '',
              reportUrl: '',
              siteAccount: site.account || row.company || '',
            });
          }
        }
        rows = enriched;

        const clientRows = rows.map(({ _origMaintenanceRaw, _hadMonthEntry, ...r }) => r);
        return ok({ rows: clientRows });
      }
      // GET /api/master/daily-review-all
      if (pathname === '/api/master/daily-review-all' && method === 'GET') {
        const rows = db.getDailyReview();
        // Group by userName
        const byUser = {};
        rows.forEach(r => { (byUser[r.userName] = byUser[r.userName] || []).push(r); });
        return ok(byUser);
      }
      // GET /api/master/summary — per-user completion stats
      if (pathname === '/api/master/summary' && method === 'GET') {
        const month = reqUrl.searchParams.get('month') || db.getActiveMonth();
        const baseRows = db.getDailyReview();
        const rows = month ? overlayMonthStatus(baseRows, month) : baseRows;
        const users = db.getUsers().filter(u => u.active !== false);
        const summary = users.map(u => {
          const uRows = rows.filter(r => r.userId === u.id);
          const completed = uRows.filter(r => r.maintenanceStatus === 'completed').length;
          return {
            userId: u.id, user: u.name, role: u.role,
            total: uRows.length,
            completed,
            inProgress: uRows.filter(r => r.maintenanceStatus === 'in_progress').length,
            pending: uRows.filter(r => !['completed','in_progress'].includes(r.maintenanceStatus)).length,
            reportSent: uRows.filter(r => r.reportSentRaw?.toLowerCase() === 'yes').length,
            pct: uRows.length ? Math.round(completed / uRows.length * 100) : 0,
          };
        });
        return ok({ summary });
      }
      // GET /api/master/report-status — per-user daily report status for the
      // admin/superadmin dashboard. Fed from the Report Automation mirror
      // (refreshed first when stale) so each user's latest Done · In Review ·
      // In Progress · Overdue counts reflect the Worker log accurately.
      if (pathname === '/api/master/report-status' && method === 'GET') {
        const role = reqUrl.searchParams.get('role') || '';
        if (role !== 'admin' && role !== 'superadmin') return err(403, 'Admin access required');
        const config = db.getAssistantConfig();
        const ra = config.reportAutomation || {};
        try {
          const { syncReportMirror, loadReportMirror, isReportMirrorStale, perUserReportStatus, reportMirrorSummary, todayInTeamTZ } = await import('./reportAutomation.js');
          let mirror = loadReportMirror();
          if (ra.enabled !== false && ra.baseUrl && ra.apiKey && isReportMirrorStale(mirror)) {
            // Wrap in a timeout so a slow/unreachable Report Automation endpoint
            // can't hang this request indefinitely — fall back to cached data.
            try {
              mirror = await Promise.race([
                syncReportMirror({ config: ra, refresh: true }),
                new Promise((_, rej) => setTimeout(() => rej(new Error('report-sync timeout')), 5000)),
              ]);
            } catch (syncErr) {
              console.warn('[report-status] syncReportMirror skipped:', syncErr.message);
              // Keep the stale mirror — still returns useful cached data
            }
          }

          const roster = db.getUsers().filter(u => u.active !== false).map(u => u.name);
          const { rows, latestDate, count } = perUserReportStatus(mirror.items || [], roster);
          const summary = reportMirrorSummary();
          return ok({
            rows,
            latestDate,
            count,
            today: todayInTeamTZ(),
            freshness: {
              updatedAt: mirror.updatedAt || null,
              mirrorCount: summary.count,
              latestDate: summary.latestDate,
            },
            configured: Boolean(ra.baseUrl && ra.apiKey && ra.enabled !== false),
          });
        } catch (e) {
          return err(500, `Report status unavailable: ${e.message}`);
        }
      }
      // GET /api/master/audit-log — change history (admin+). Supports optional
      // ?entity= & ?entityId= filters and ?limit= (default 500, newest first).
      if (pathname === '/api/master/audit-log' && method === 'GET') {
        const role = reqUrl.searchParams.get('role') || '';
        if (role !== 'admin' && role !== 'superadmin') return err(403, 'Admin access required');
        const limit = Number(reqUrl.searchParams.get('limit') || 500);
        const entity = reqUrl.searchParams.get('entity') || '';
        const entityId = reqUrl.searchParams.get('entityId') || '';
        let entries = db.getAuditLog(limit <= 0 || limit > 5000 ? 5000 : limit);
        if (entity) entries = entries.filter(e => e.entity === entity);
        if (entityId) entries = entries.filter(e => e.entityId === entityId);
        return ok({ entries, total: db.auditLogStats().count });
      }
      // GET /api/master/audit-log/stats — aggregate counts (admin+)
      if (pathname === '/api/master/audit-log/stats' && method === 'GET') {
        const role = reqUrl.searchParams.get('role') || '';
        if (role !== 'admin' && role !== 'superadmin') return err(403, 'Admin access required');
        return ok(db.auditLogStats());
      }
      // GET /api/master/sync-conflicts — divergences the sync refused to silently
      // resolve (admin+). ?state=open|acknowledged filters.
      if (pathname === '/api/master/sync-conflicts' && method === 'GET') {
        const role = reqUrl.searchParams.get('role') || '';
        if (role !== 'admin' && role !== 'superadmin') return err(403, 'Admin access required');
        const state = reqUrl.searchParams.get('state') || '';
        const limit = Number(reqUrl.searchParams.get('limit') || 500);
        let list = db.getSyncConflicts({ state: state || undefined });
        return ok({ conflicts: list.slice(0, limit <= 0 ? 500 : limit), stats: db.syncConflictStats() });
      }
      // GET /api/master/sync-conflicts/stats — counts (admin+)
      if (pathname === '/api/master/sync-conflicts/stats' && method === 'GET') {
        const role = reqUrl.searchParams.get('role') || '';
        if (role !== 'admin' && role !== 'superadmin') return err(403, 'Admin access required');
        return ok(db.syncConflictStats());
      }
      // POST /api/master/sync-conflicts/:id/ack — acknowledge a flagged conflict
      // after the operator has reviewed it (admin+). Audited.
      if (/^\/api\/master\/sync-conflicts\/([^/]+)\/ack$/.test(pathname) && method === 'POST') {
        const role = reqUrl.searchParams.get('role') || '';
        if (role !== 'admin' && role !== 'superadmin') return err(403, 'Admin access required');
        const id = pathname.split('/')[4];
        const b = await body().catch(() => ({}));
        try {
          const conflict = db.acknowledgeSyncConflict(id, actorFrom(req, b, reqUrl).name);
          db.appendAuditLog({
            actor: actorFrom(req, b, reqUrl).name, actorId: actorFrom(req, b, reqUrl).id,
            action: 'acknowledge', entity: 'sync-conflict', entityId: id,
            label: `${conflict.entity}:${conflict.label}`,
            field: conflict.field,
            oldValue: JSON.stringify({ sheetValue: conflict.sheetValue, dbValue: conflict.dbValue }),
            newValue: 'acknowledged',
            source: 'Change History / Sync Conflicts', reason: 'Operator reviewed flagged divergence and accepted the sync policy',
          });
          return ok({ conflict });
        } catch (e) { return err(404, e.message); }
      }
      // GET /api/master/user-aliases — the explicit name→canonical alias table
      // used to resolve the same person across sheets (admin+, read-only).
      if (pathname === '/api/master/user-aliases' && method === 'GET') {
        const role = reqUrl.searchParams.get('role') || '';
        if (role !== 'admin' && role !== 'superadmin') return err(403, 'Admin access required');
        return ok({ aliases: db.getUserAliases() });
      }
      // GET /api/master/sheets/cache-status — confirms the Sheets caching /
      // rate-limit layers are live (admin+): TTL, cache hit/miss counters, queue.
      if (pathname === '/api/master/sheets/cache-status' && method === 'GET') {
        const role = reqUrl.searchParams.get('role') || '';
        if (role !== 'admin' && role !== 'superadmin') return err(403, 'Admin access required');
        return ok(getCacheStatus());
      }
      // PUT /api/master/daily-review/:id  (user: their own row)
      if (/^\/api\/master\/daily-review\/([^/]+)$/.test(pathname) && method === 'PUT') {
        const id = pathname.split('/').pop();
        const b = await body();
        try {
          // Optimistic lock: the UI passes the row's last-seen updatedAt so a
          // stale editor can't silently overwrite a newer value.
          const before = db.getDailyReview().find(r => r.id === id);
          if (!before) return err(404, `Daily review row not found: ${id}`);
          if (!assertFresh(before, b, res, 'daily-review')) return;

          // Normalize raw status fields if needed
          if (!b.maintenanceRaw && b.maintenanceStatusRaw) b.maintenanceRaw = b.maintenanceStatusRaw;
          if (!b.reportSentRaw && b.reportSentStatusRaw) b.reportSentRaw = b.reportSentStatusRaw;

          const updatedRow = db.updateDailyReviewRow(id, b);

          // Audit the meaningful status fields (a row PUT may also carry
          // maintenance-mode fields; only record actual value changes).
          {
            const fieldMap = [
              { f: 'maintenanceStatus', label: 'maintenance' },
              { f: 'maintenanceRaw', label: 'maintenance (raw)' },
              { f: 'reportSentStatus', label: 'report sent' },
              { f: 'reportSentRaw', label: 'report sent (raw)' },
              { f: 'ga4', label: 'GA4' },
              { f: 'newsletterMail', label: 'newsletter' },
              { f: 'formSubmissionMail', label: 'form' },
              { f: 'bookingLink', label: 'booking' },
              { f: 'cloudflare', label: 'cloudflare' },
              { f: 'clientResponse', label: 'client response' },
              { f: 'uptimeRobot', label: 'uptime robot' },
            ];
            for (const { f, label } of fieldMap) {
              if (before && b[f] !== undefined && String(before[f] ?? '') !== String(b[f] ?? '')) {
                const actor = actorFrom(req, b, reqUrl);
                db.appendAuditLog({
                  actor: actor.name || updatedRow.userName || 'user', actorId: actor.id || updatedRow.userId,
                  action: 'update', entity: 'daily-review', entityId: updatedRow.id, label: `${updatedRow.siteUrl} (${updatedRow.userName})`,
                  field: label, oldValue: before[f] ?? '', newValue: b[f] ?? '',
                  source: 'Daily Review editor', reason: 'Row updated in Daily Review',
                });
              }
            }
          }

          // Also keep site.monthlyHistory in sync for the active month so subsequent queries reflect it
          if (b.maintenanceStatus || b.maintenanceRaw) {
            try {
              const activeMonth = db.getActiveMonth();
              const mRaw = b.maintenanceRaw || (b.maintenanceStatus === 'completed' ? 'Completed' : b.maintenanceStatus === 'in_progress' ? 'In Progress' : 'To Do');
              const sites = db.getSites({});
              const site = sites.find(s => {
                const sUrl = (s.url || '').toLowerCase().replace(/^https?:\/\//, '').replace(/\/$/, '');
                const rUrl = (updatedRow.siteUrl || '').toLowerCase().replace(/^https?:\/\//, '').replace(/\/$/, '');
                return sUrl === rUrl || sUrl.includes(rUrl) || rUrl.includes(sUrl);
              });
              if (site) {
                const history = site.monthlyHistory || [];
                const mLower = activeMonth.trim().toLowerCase();
                const hIdx = history.findIndex(h => (h.month || '').trim().toLowerCase() === mLower);
                const valToWrite = mRaw === 'Completed' ? 'Updated & Backup' : mRaw;
                if (hIdx !== -1) {
                  history[hIdx].status = valToWrite;
                } else {
                  history.push({ month: activeMonth, status: valToWrite });
                }
                site.monthlyHistory = history;
                site.latestMonth = activeMonth;
                site.latestMonthStatus = mRaw;
                db.updateSite(site.id, site);
              }
            } catch (err) {
              console.warn('[db updateSite monthlyHistory error]:', err.message);
            }
          }

          // Bi-directional sync: write to BOTH the CW/RM Maintenance sheet AND the Daily Review sheet
          if (b.maintenanceStatus || b.maintenanceRaw || b.reportSentStatus || b.reportSentRaw) {
            import('./sheets.js').then(({ syncSiteStatusToSheet, syncStatusToDailyReviewSheet }) => {
              const activeMonth = db.getActiveMonth();
              // 1. CW/RM Maintenance sheet — correct month column
              if (b.maintenanceStatus || b.maintenanceRaw) {
                syncSiteStatusToSheet({
                  account: updatedRow.company || 'CW',
                  siteUrl: updatedRow.siteUrl,
                  month: activeMonth,
                  status: b.maintenanceRaw || b.maintenanceStatus,
                }).catch(err => console.warn('[cw-rm-sync error]:', err.message));
              }
              // 2. Daily Review sheet — user tab Maintenance + Report Sent columns (ACTIVE USERS ONLY)
              if (updatedRow.userName) {
                const u = (db.getUsers ? db.getUsers() : []).find(x => (x.name || '').toLowerCase() === (updatedRow.userName || '').toLowerCase() || x.id === updatedRow.userId);
                if (!u || u.active !== false) {
                  syncStatusToDailyReviewSheet({
                    userName: updatedRow.userName,
                    siteUrl: updatedRow.siteUrl,
                    rowIndex: updatedRow.rowIndex,
                    maintenanceStatus: b.maintenanceStatus,
                    maintenanceRaw: b.maintenanceRaw,
                    reportSentStatus: b.reportSentStatus,
                    reportSentRaw: b.reportSentRaw,
                  }).catch(err => console.warn('[daily-review-sync error]:', err.message));
                } else {
                  console.log('[daily-review-sync] Skipping ' + updatedRow.userName + ' (inactive user)');
                }
              }
            }).catch(() => {});
          }
          return ok({ row: updatedRow });
        }
        catch (e) { return err(404, e.message); }
      }
      // POST /api/master/daily-review/batch (batch update multiple rows)
      if (pathname === '/api/master/daily-review/batch' && method === 'POST') {
        const b = await body();
        if (!Array.isArray(b.ids) || !b.ids.length) return err(400, 'ids array required');
        // Optional optimistic lock: when the client sends last-seen updatedAt
        // per row id, any stale row aborts the whole batch before any write.
        if (b.expectedUpdatedAtMap && typeof b.expectedUpdatedAtMap === 'object') {
          const stale = [];
          const all = db.getDailyReview();
          for (const id of b.ids) {
            const expected = b.expectedUpdatedAtMap[id];
            if (!expected) continue;
            const row = all.find(r => r.id === id);
            if (row && !db.assertRecordFresh(row, expected)) stale.push(row);
          }
          if (stale.length) {
            sendJson(res, 409, {
              error: 'STALE_VERSION',
              message: `${stale.length} row(s) changed since you loaded them. No rows were updated. Refresh and retry.`,
              entity: 'daily-review', staleCount: stale.length, current: stale,
            });
            return;
          }
        }
        const rows = db.updateDailyReviewBatch(b.ids, b.updates || {});
        // Bi-directional batch sync: CW/RM Maintenance sheet + Daily Review sheet per row
        if (b.updates?.maintenanceStatus || b.updates?.maintenanceRaw || b.updates?.reportSentStatus || b.updates?.reportSentRaw) {
          import('./sheets.js').then(async ({ syncSiteStatusToSheet, syncStatusToDailyReviewSheet }) => {
            const activeM = db.getActiveMonth();
            const activeUsersSet = new Set(
              (db.getUsers ? db.getUsers() : [])
                .filter(u => u.active !== false)
                .map(u => (u.name || '').toLowerCase())
            );
            for (const r of rows) {
              // 1. CW/RM Maintenance sheet month column
              if (b.updates?.maintenanceStatus || b.updates?.maintenanceRaw) {
                await syncSiteStatusToSheet({
                  account: r.company || 'CW',
                  siteUrl: r.siteUrl,
                  month: activeM,
                  status: b.updates.maintenanceRaw || b.updates.maintenanceStatus,
                }).catch(() => {});
              }
              // 2. Daily Review sheet user tab (ACTIVE USERS ONLY)
              if (r.userName) {
                if (activeUsersSet.size > 0 && !activeUsersSet.has((r.userName || '').toLowerCase())) {
                  console.log('[daily-review-sync] Skipping ' + r.userName + ' (inactive user)');
                  continue;
                }
                await syncStatusToDailyReviewSheet({
                  userName: r.userName,
                  siteUrl: r.siteUrl,
                  rowIndex: r.rowIndex,
                  maintenanceStatus: b.updates.maintenanceStatus,
                  maintenanceRaw: b.updates.maintenanceRaw,
                  reportSentStatus: b.updates.reportSentStatus,
                  reportSentRaw: b.updates.reportSentRaw,
                }).catch(() => {});
              }
            }
          }).catch(() => {});
        }
        return ok({ rows, count: rows.length });
      }

      // ── TASKS ──────────────────────────────────────────────────
      // GET /api/master/tasks?assigneeId=&assigneeName=&user=&status=
      if (pathname === '/api/master/tasks' && method === 'GET') {
        let assigneeId = reqUrl.searchParams.get('assigneeId') || undefined;
        let assigneeName = reqUrl.searchParams.get('assigneeName') || reqUrl.searchParams.get('user') || undefined;
        if (assigneeId === 'all' || assigneeName === 'all' || assigneeName === 'All Team Sites') {
          assigneeId = undefined;
          assigneeName = undefined;
        }
        const filter = {
          assigneeId,
          assigneeName,
          status: reqUrl.searchParams.get('status') || undefined,
        };
        let tasks = db.getTasks(filter);
        if (tasks.length === 0 && (assigneeName === 'Superadmin' || assigneeName === 'Admin')) {
          const authUser = db.resolveAuthUser(req);
          if (authUser && authUser.id) {
            tasks = db.getTasks({ assigneeId: authUser.id, assigneeName: authUser.name, status: filter.status });
          }
          if (tasks.length === 0) {
            tasks = db.getTasks({ status: filter.status });
          }
        }
        return ok({ tasks });
      }
      // POST /api/master/tasks  (admin+)
      if (pathname === '/api/master/tasks' && method === 'POST') {
        const b = await body();
        if (!b.taskName) return err(400, 'taskName required');
        // Resolve siteId from siteUrl if provided
        if (b.siteUrl && !b.siteId) {
          const site = db.getSiteByUrl(b.siteUrl);
          b.siteId = site?.id || null;
        }
        // Resolve assigneeId from assigneeName if provided
        if (b.assigneeName && !b.assigneeId) {
          const user = db.getUserByName(b.assigneeName);
          b.assigneeId = user?.id || null;
        }
        return ok({ task: db.createTask(b) });
      }
      // PUT /api/master/tasks/:id  (admin+)
      if (/^\/api\/master\/tasks\/([^/]+)$/.test(pathname) && method === 'PUT') {
        const id = pathname.split('/').pop();
        const b = await body();
        try { return ok({ task: db.updateTask(id, b) }); }
        catch (e) { return err(404, e.message); }
      }
      // DELETE /api/master/tasks/:id  (admin+)
      if (/^\/api\/master\/tasks\/([^/]+)$/.test(pathname) && method === 'DELETE') {
        const id = pathname.split('/').pop();
        db.deleteTask(id);
        return ok({ success: true });
      }

      // ── PROPERTIES ─────────────────────────────────────────────
      // GET /api/master/properties
      if (pathname === '/api/master/properties' && method === 'GET') {
        return ok({ properties: db.getProperties() });
      }
      // PUT /api/master/properties/:id  (superadmin)
      if (/^\/api\/master\/properties\/([^/]+)$/.test(pathname) && method === 'PUT') {
        const id = pathname.split('/').pop();
        const b = await body();
        try { return ok({ property: db.updateProperty(id, b) }); }
        catch (e) { return err(404, e.message); }
      }
      // DELETE /api/master/properties/:id  (superadmin)
      if (/^\/api\/master\/properties\/([^/]+)$/.test(pathname) && method === 'DELETE') {
        db.deleteProperty(pathname.split('/').pop());
        return ok({ success: true });
      }

      // ── DEV PROJECTS (Two-way Live Sync with Google Sheets) ─────
      // GET /api/master/dev-projects
      if (pathname === '/api/master/dev-projects' && method === 'GET') {
        let projs = db.getDevProjects();
        if (!projs.length || reqUrl.searchParams.get('fresh') === 'true') {
          try {
            const { fetchDevTrackerSheetData } = await import('./sheets.js');
            projs = await fetchDevTrackerSheetData();
            db.setDevProjects(projs);
          } catch (e) {
            console.warn('[dev-projects] Live fetch fallback:', e.message);
          }
        }
        // Column layout of the tracker sheet, read from the schema registry
        // (cache only — no Google call on this path). Lets the UI render a
        // tab's real columns, including any added by hand, without hardcoding.
        let schema = null;
        try {
          const [{ getSheetSchema }, { DEV_TRACKER_SPREADSHEET_ID }] = await Promise.all([
            import('./sheetSchema.js'),
            import('./sheets.js'),
          ]);
          schema = getSheetSchema(DEV_TRACKER_SPREADSHEET_ID);
        } catch { /* schema is optional context for the UI */ }
        return ok({ projects: projs, schema });
      }

      // POST /api/master/dev-projects/fetch-live (Explicit refresh directly from Google Sheets)
      if (pathname === '/api/master/dev-projects/fetch-live' && method === 'POST') {
        try {
          const { fetchDevTrackerSheetData } = await import('./sheets.js');
          const projs = await fetchDevTrackerSheetData();
          db.setDevProjects(projs);
          return ok({ success: true, count: projs.length, projects: projs });
        } catch (e) {
          return err(500, `Failed to fetch from Google Sheets: ${e.message}`);
        }
      }

      // ── DEV ASSISTANT (Chatbot over Dev Tracker data) ───────────
      // GET /api/master/dev-assistant — overview snapshot + suggested questions
      if (pathname === '/api/master/dev-assistant' && method === 'GET') {
        const config = db.getAssistantConfig();
        let projs = db.getDevProjects();
        if (!projs.length) {
          try {
            const { fetchDevTrackerSheetData } = await import('./sheets.js');
            const live = await Promise.race([
              fetchDevTrackerSheetData(),
              new Promise((r) => setTimeout(() => r(null), 1500)),
            ]);
            if (live?.length) { projs = live; db.setDevProjects(projs); }
          } catch (e) {
            console.warn('[dev-assistant] Live fetch fallback:', e.message);
          }
        }
        const { getAssistantMeta, discoverExtraColumns } = await import('./devAssistant.js');
        const meta = getAssistantMeta(projs, process.env, config);
        // Auto-discovered column layout of the configured source sheet → passed
        // to the client so the chat UI can show what columns the assistant can
        // see (including hand-added ones). Discovery is cached, so this is
        // normally free.
        const schemaText = await assistantSchemaText(config);
        const role = reqUrl.searchParams.get('role') || '';
        // Fast local sheet metadata (0ms)
        let allSheetsMeta = null;
        try {
          const { getSheetCredentials } = await import('./db.js');
          const creds = getSheetCredentials() || [];
          allSheetsMeta = { count: creds.length, sheets: creds.map(c => ({ id: c.id, title: c.title || c.key })) };
        } catch (e) {
          console.warn('[dev-assistant] Boot all-sheets metadata failed:', e.message);
        }
        let documentMeta = { documents: [], errors: [], configured: false };
        if (config?.documents?.sources?.length) {
          try {
            const { fetchGoogleDocuments } = await import('./docsRag.js');
            documentMeta = await Promise.race([
              fetchGoogleDocuments(config.documents),
              new Promise((r) => setTimeout(() => r({ documents: [], errors: [], configured: false }), 1000)),
            ]);
          } catch (e) {
            console.warn('[dev-assistant] Document source boot failed:', e.message);
            documentMeta.errors = [{ error: e.message }];
          }
        }
        const documentSummary = { configured: Boolean(documentMeta.configured), documentCount: documentMeta.documents?.length || 0, errors: documentMeta.errors || [], fetchedAt: documentMeta.fetchedAt || '' };
        if (role !== 'superadmin') {
          return ok({
            engine: meta.aiAvailable ? 'llm' : 'builtin',
            aiAvailable: meta.aiAvailable,
            aiProviders: meta.aiProviders,
            overview: meta.overview,
            suggestions: meta.suggestions,
            schemaText,
            detectedColumns: discoverExtraColumns(projs),
            allSheets: allSheetsMeta, documents: documentSummary,
          });
        }
        return ok({ ...meta, schemaText, detectedColumns: discoverExtraColumns(projs), allSheets: allSheetsMeta, documents: documentSummary });
      }

      // POST /api/master/dev-assistant { question, fresh? } — ask the assistant
        if (pathname === '/api/master/dev-assistant' && method === 'POST') {
        const b = await body();
        const q = String(b.question || '').trim();
        if (!q) return err(400, 'question required');
        const config = db.getAssistantConfig();
        let projs = db.getDevProjects();
        const history = Array.isArray(b.history) ? b.history.slice(-6).map((turn) => ({ question: String(turn?.question || '').slice(0, 500), answer: String(turn?.answer || '').slice(0, 2000) })) : [];
        const steps = [];
        // Project questions are live investigations, not snapshot summaries.
        // Resolve an explicit name first; “full details” inherits one project
        // from the immediately preceding conversation when unambiguous.
        const { matchProject, resolveHistoryProjects } = await import('./devAssistant.js');
        let liveProject = matchProject(q, projs);
        if (!liveProject && /\b(full details?|more details?|details?|tell me more|latest|update)\b/i.test(q)) {
          const fromHistory = resolveHistoryProjects(history, projs);
          if (fromHistory.length === 1) liveProject = fromHistory[0];
        }
        let effectiveQuestion = q;
        if (liveProject && !matchProject(q, projs) && /\b(full details?|more details?|details?|tell me more)\b/i.test(q)) {
          effectiveQuestion = `${q} for ${liveProject.project}`;
        }
        let liveData = { attempted: false, fresh: false, project: liveProject?.project || '', error: '' };
        if (liveProject) {
          liveData.attempted = true;
          steps.push({ label: `Reading live ${liveProject.project} sheet…`, status: 'running' });
          try {
            const { fetchDevTrackerSheetData } = await import('./sheets.js');
            const [live] = await fetchDevTrackerSheetData({ tabs: [liveProject.project], forceRefresh: true });
            if (!live) throw new Error('the tab returned no readable project rows');
            projs = projs.map((project) => project.project === live.project ? live : project);
            db.setDevProjects(projs);
            liveProject = live;
            liveData.fresh = true;
            steps[steps.length - 1].status = 'done';
          } catch (e) {
            liveData.error = e.message;
            steps[steps.length - 1].status = 'fallback';
            steps[steps.length - 1].detail = 'Live read failed; using the last synced snapshot.';
            console.warn('[dev-assistant] Live project read failed, using snapshot:', e.message);
          }
        }
        // The v2 Dev Tracker acceptance questions are Sheet-only. For a
        // portfolio question with no project name (for example “how many open
        // items?”), refresh the six tabs once and answer deterministically;
        // do not let a provider paraphrase an old snapshot.
        const devTrackerPortfolioQuestion = !liveProject
          && /\b(open items?|pending|in progress|fully completed|all rows|feedback|development|sitemap|events?[ -]?happenings|projects?)\b/i.test(q)
          && !/\b(maintenance|backup|report sent|clickup|daily review)\b/i.test(q);
        if (devTrackerPortfolioQuestion) {
          liveData.attempted = true;
          steps.push({ label: 'Reading all six live Dev Tracker tabs…', status: 'running' });
          try {
            const { fetchDevTrackerSheetData } = await import('./sheets.js');
            const live = await fetchDevTrackerSheetData({ forceRefresh: true });
            if (!live?.length) throw new Error('the Dev Tracker returned no readable project rows');
            projs = live;
            db.setDevProjects(projs);
            liveData.fresh = true;
            steps[steps.length - 1].status = 'done';
          } catch (e) {
            liveData.error = e.message;
            steps[steps.length - 1].status = 'fallback';
            steps[steps.length - 1].detail = 'Live read failed; using the last synced snapshot.';
            console.warn('[dev-assistant] Live Dev Tracker read failed, using snapshot:', e.message);
          }
        }
        let schemaRefreshed = false;
        // A targeted live investigation already re-read its exact tab. Keep a
        // manual refresh capable of reading all tabs, but avoid seven needless
        // reads on every named-project question.
        if (!liveProject && (b.fresh === true || config.source.freshOnAsk === true)) {
          try {
            const { fetchDevTrackerSheetData } = await import('./sheets.js');
            const live = await fetchDevTrackerSheetData();
            if (live?.length) { projs = live; db.setDevProjects(projs); }
            // When project data is pulled live from the sheet, the column layout
            // may have changed too (a new column was added by hand). Re-discover
            // the schema for ALL connected sheets so SECTION 5 reflects the
            // current layout of every sheet, not a stale cache entry that
            // predates the new column.
            const { getSchemaRegistry } = await import('./sheetSchema.js');
            await getSchemaRegistry({ refresh: true, maxTabs: 14 });
            schemaRefreshed = true;
          } catch (e) {
            console.warn('[dev-assistant] Fresh fetch failed, using cached data:', e.message);
          }
        }
        const { answerDevQuestion } = await import('./devAssistant.js');
        const role = String(b.role || reqUrl.searchParams.get('role') || '');
        // Auto-discovered column layout of the source sheet(s) → SECTION 5, so
        // the assistant knows about columns/tabs added by hand after this code
        // was written. Cheap: cached in memory + data/sheet-schema.json.
        const schemaText = await assistantSchemaText(config);
        // SOP/process questions can be answered by the dedicated handbook
        // index. Decide this before the wider Sheet/Docs retrieval so a simple
        // procedure question does not spend LLM quota building unrelated
        // tracker context. If the Worker is unavailable we still fall through
        // to the normal OfficeOS evidence path below.
        let handbookIntent = false;
        try {
          const { shouldUseHandbook } = await import('./handbookRag.js');
          handbookIntent = shouldUseHandbook(effectiveQuestion, { liveProject: Boolean(liveProject) });
        } catch (e) { console.warn('[dev-assistant] Handbook intent detection failed:', e.message); }

        // Broad RAG: also fetch a compact summary from ALL connected sheets
        // (CW Maintenance, RM Maintenance, Daily Review, Property Registry, etc.)
        // so the assistant can reason across every sheet the project reads, not
        // just the Dev Tracker.  This is a separate data block passed to the LLM
        // as SECTION 6 — it does NOT replace the existing dev-projects flow.
        let allSheetsSummary = null;
        if (!liveProject && !handbookIntent) {
          try {
            const { fetchAllSheetsSummary } = await import('./sheets.js');
            allSheetsSummary = await fetchAllSheetsSummary();
          } catch (e) {
            console.warn('[dev-assistant] All-sheets fetch failed:', e.message);
          }
        }
        let documents = { documents: [], errors: [], configured: false };
        if (!liveProject) {
          try {
            const { fetchGoogleDocuments } = await import('./docsRag.js');
            documents = await fetchGoogleDocuments(config.documents, { refresh: b.fresh === true || config.documents?.freshOnAsk === true });
          } catch (e) {
            console.warn('[dev-assistant] Document retrieval failed:', e.message);
            documents.errors = [{ error: e.message }];
          }
        }
        let enterpriseRag = null;
        try {
          const { retrieveRag, sourceTypeForQuestion } = await import('./enterpriseRag.js');
          enterpriseRag = await retrieveRag(effectiveQuestion, { sourceType: sourceTypeForQuestion(effectiveQuestion), candidateLimit: 20, limit: 5 });
        } catch (e) { console.warn('[dev-assistant] Enterprise RAG retrieval failed:', e.message); }

        // Daily Report Feed bridge: mirror the Report Automation log so chat can
        // answer "who hasn't submitted today", "what did X report yesterday", etc.
        // Refresh when the config says so, when the requester forces fresh data,
        // or the first time a report question arrives with an empty mirror.
        let dailyReports = [];
        let reportMirrorErr = '';
        const ra = config.reportAutomation || {};
        const wantsFreshReports = Boolean(b.fresh) || ra.freshOnAsk === true;
        try {
          const { syncReportMirror, loadReportMirror, isReportMirrorStale } = await import('./reportAutomation.js');
          const currentMirror = loadReportMirror();
          if (ra.enabled !== false && ra.baseUrl && ra.apiKey && (wantsFreshReports || isReportMirrorStale(currentMirror))) {
            const synced = await syncReportMirror({ config: ra, refresh: true });
            dailyReports = synced.items || [];
          } else {
            dailyReports = (currentMirror.items || []).filter((i) => i.reportDate && i.user?.name);
          }
        } catch (e) {
          console.warn('[dev-assistant] Report mirror sync failed:', e.message);
          reportMirrorErr = e.message;
        }
        if (ra.enabled !== false && (reportMirrorErr || dailyReports.length)) {
          steps.push({ label: 'Daily report log', status: reportMirrorErr ? 'fallback' : 'done', detail: reportMirrorErr ? reportMirrorErr : `${dailyReports.length} report(s) read from ${ra.baseUrl || 'Report Automation'}` });
        }

        // ClickUp is deliberately disabled for this Sheet-only phase. The
        // available token can authenticate but cannot enumerate any spaces,
        // lists, tasks, or comments, so using it would create false evidence.
        // Re-enable only after workspace access is proven in a separate phase.
        const clickUpEvidence = []; // Phase 2 only: no ClickUp call in the Sheet-only agent.

        let handbookResult = null;
        try {
          const { askHandbook } = await import('./handbookRag.js');
          if (handbookIntent) {
            steps.push({ label: 'Checking Operations Handbook', status: 'working', detail: 'Read-only SOP retrieval' });
            handbookResult = await askHandbook(effectiveQuestion, config);
            const step = steps[steps.length - 1];
            step.status = handbookResult.ok ? 'complete' : 'fallback';
            step.detail = handbookResult.ok ? `Found ${handbookResult.sources?.length || 0} cited handbook source(s).` : handbookResult.reason === 'not-configured' ? 'Handbook Worker is not configured.' : 'Handbook unavailable; continuing with OfficeOS evidence.';
          }
        } catch (e) { console.warn('[dev-assistant] Handbook retrieval failed:', e.message); }

        let answer;
        if (handbookResult?.ok) {
          const { formatHandbookAnswer } = await import('./handbookRag.js');
          answer = { answer: formatHandbookAnswer(handbookResult), intent: 'handbook', project: null, data: { sources: handbookResult.sources, nextActions: handbookResult.nextActions }, suggestions: handbookResult.nextActions || [], engine: 'handbook-worker', cached: handbookResult.cached === true };
        } else if (handbookIntent && handbookResult?.reason === 'not-configured') {
          answer = {
            answer: '📚 **Operations Handbook is not connected yet.**\n\nOfficeOS is ready to use it, but it needs the deployed `razib-operations-rag` Worker URL first. In **AI Settings → Operations Handbook**, paste the Worker base URL, save it, then use **Test connection**. The Worker must also have completed its initial handbook crawl before it can answer SOP questions.',
            intent: 'handbook-not-configured', project: null, data: {}, suggestions: ['Open AI Settings', 'Connect the Operations Handbook Worker'], engine: 'builtin',
          };
        } else {
          answer = await answerDevQuestion(effectiveQuestion, projs, {
            config, schemaText, debug: role === 'superadmin',
            allSheets: allSheetsSummary, documents, sites: db.getSites(), enterpriseRag,
            history, forceBuiltin: Boolean(liveData.fresh),
            dailyReports, reportUsers: db.getUsers(), reportBaseUrl: ra.baseUrl || '',
          });
        }
        if (liveData.fresh) answer.answer += `\n\n_Source: live read of ${liveProject ? 'the project’s' : 'the connected Dev Tracker'} Google Sheet${liveProject ? '' : ' tabs'}._`;
        if (liveData.attempted && !liveData.fresh) {
          answer.answer += '\n\n_Source note: live Sheet read failed, so this answer uses the last synced project snapshot._';
        }
        if (clickUpEvidence.length) {
          const latest = clickUpEvidence.flatMap((entry) => entry.comments.map((comment) => ({ ...comment, task: entry.task, url: entry.url })))
            .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0];
          const task = latest?.task || clickUpEvidence[0].task;
          answer.answer += `\n\n**Live ClickUp check**\nTask: **${task?.name || task?.id || 'Linked task'}** · current status: **${task?.status || '—'}**`;
          if (latest) answer.answer += `\nLatest comment (${latest.createdAt?.slice(0, 10) || 'undated'} · ${latest.author}): “${String(latest.text || '').slice(0, 500)}”`;
          answer.answer += '\n_Source: live read-only ClickUp task data._';
        }
        answer.steps = steps;
        answer.liveData = liveData;
        return ok(answer);
      }

      // POST /api/master/rag/sync — re-runnable ingestion job. Schedule this
      // route (or run npm run sync:rag) after source edits so the index stays fresh.
      if (pathname === '/api/master/rag/sync' && method === 'POST') {
        const b = await body();
        const role = b.role || reqUrl.searchParams.get('role') || '';
        if (role !== 'superadmin') return err(403, 'Superadmin access required');
        try {
          const { syncRagIndex } = await import('./enterpriseRag.js');
          const index = await syncRagIndex({ refresh: true, sources: { documents: db.getAssistantConfig().documents, reportAutomation: db.getAssistantConfig().reportAutomation } });
          return ok({ success: true, updatedAt: index.updatedAt, chunkCount: index.chunkCount, sources: index.sources, embeddingModel: index.embeddingModel, errors: index.errors });
        } catch (e) { return err(500, `RAG sync failed: ${e.message}`); }
      }

      // GET /api/master/rag/search?q= — diagnostic endpoint for the evaluation
      // workflow; returns chunk metadata + scores, never provider secrets.
      if (pathname === '/api/master/rag/search' && method === 'GET') {
        const q = String(reqUrl.searchParams.get('q') || '').trim();
        if (!q) return err(400, 'q is required');
        try {
          const { retrieveRag, sourceTypeForQuestion } = await import('./enterpriseRag.js');
          return ok(await retrieveRag(q, { sourceType: sourceTypeForQuestion(q), candidateLimit: 20, limit: 5 }));
        } catch (e) { return err(500, `RAG search failed: ${e.message}`); }
      }

// ─ SHEET SCHEMA (auto-discovered columns & tabs) ───────────
      // GET /api/master/sheet-schema — every spreadsheet the app reads, with the
      // columns of each tab exactly as discovered from that tab's header row.
      // `?refresh=1` re-reads from Google; `?tabs=A,B` limits the walk.
      if (pathname === '/api/master/sheet-schema' && method === 'GET') {
        const { getSchemaRegistry, summarizeSchema } = await import('./sheetSchema.js');
        const refresh = reqUrl.searchParams.get('refresh') === '1';
        const tabs = (reqUrl.searchParams.get('tabs') || '').split(',').map((t) => t.trim()).filter(Boolean);
        try {
          const registry = await getSchemaRegistry({ refresh, tabs });
          return ok({ ...summarizeSchema(registry.sheets), updatedAt: registry.updatedAt, errors: registry.errors });
        } catch (e) {
          return err(500, `Schema discovery failed: ${e.message}`);
        }
      }

      // POST /api/master/sheet-schema/refresh — force a fresh discovery.
      // Body: { spreadsheetId?, tabs?, maxTabs?, sampleRows? } (no id = all sheets)
      if (pathname === '/api/master/sheet-schema/refresh' && method === 'POST') {
        const b = await body();
        const { refreshSheetSchema, getSchemaRegistry, summarizeSchema } = await import('./sheetSchema.js');
        try {
          if (b.spreadsheetId) {
            const one = await refreshSheetSchema(String(b.spreadsheetId).trim(), {
              tabs: Array.isArray(b.tabs) ? b.tabs : undefined,
              maxTabs: b.maxTabs,
              sampleRows: b.sampleRows,
            });
            return ok({ success: true, ...summarizeSchema([one]) });
          }
          const registry = await getSchemaRegistry({ refresh: true, tabs: Array.isArray(b.tabs) ? b.tabs : undefined, maxTabs: b.maxTabs });
          return ok({ success: true, ...summarizeSchema(registry.sheets), errors: registry.errors });
        } catch (e) {
          return err(500, `Schema refresh failed: ${e.message}`);
        }
      }

// ── DEV ASSISTANT SETTINGS (superadmin only) ────────────────
      // GET /api/master/assistant-config — provider cards (keys MASKED), live
      // chain status, selectable Google Sheet sources, RAG settings.
      if (pathname === '/api/master/assistant-config' && method === 'GET') {
        const role = reqUrl.searchParams.get('role') || '';
        if (role !== 'superadmin') return err(403, 'Superadmin access required');
        const { resolveProviderSettings, PROVIDER_DEFAULT_ORDER, PROVIDER_DEFAULTS } = await import('./devAssistant.js');
        const config = db.getAssistantConfig();
        const settings = resolveProviderSettings(process.env, config);
        // Keys are masked here — a raw token never leaves the server.
        const providers = settings.map((s) => {
          const envKey = String(process.env[s.keyEnv] || '');
          const dbKey = String(config.providers?.[s.name]?.apiKey || '');
          return {
            name: s.name,
            label: config.providers?.[s.name]?.label || s.name,
            kind: s.kind,
            keyEnv: s.keyEnv,
            enabled: s.enabled,
            configured: s.configured,
            skipReason: s.skipReason || '',
            baseUrl: s.base,
            defaultBaseUrl: PROVIDER_DEFAULTS[s.name]?.base || '',
            defaultModels: PROVIDER_DEFAULTS[s.name]?.models || [],
            models: s.models,
            modelsOverride: config.providers?.[s.name]?.models || '',
            hasKey: Boolean(s.apiKey),
            keySource: dbKey ? 'dashboard' : envKey ? 'env' : 'none',
            keyMasked: s.apiKey ? db.maskSecret(s.apiKey) : '',
            envKeyPresent: Boolean(envKey),
          };
        });
        const sheetOptions = db.getSheetCredentials().map((c) => ({
          id: c.id,
          title: c.title || c.key || c.id,
          spreadsheetId: c.spreadsheetId,
          tabName: c.tabName || '',
          active: c.active !== false,
          isSystem: c.isSystem === true,
          category: c.category || '',
        }));
        const liveNames = settings.filter((s) => s.configured).map((s) => s.name);
        // What the assistant can actually see right now: the hand-added columns
        // of the current snapshot, plus (when already discovered) the stored
        // column layout of the selected source. No Google call is made here —
        // the UI can POST /api/master/sheet-schema/refresh to re-read.
        const { discoverExtraColumns } = await import('./devAssistant.js');
        const { summarizeProviderMetrics } = await import('./assistantMetrics.js');
        const { reportMirrorSummary } = await import('./reportAutomation.js');
        const snapshotProjects = db.getDevProjects();
        const ra = config.reportAutomation || {};
        const raMirror = reportMirrorSummary();
        return ok({
          providers,
          order: config.order,
          providerOrderOptions: PROVIDER_DEFAULT_ORDER,
          source: config.source,
          documents: config.documents,
          handbook: { enabled: config.handbook?.enabled !== false, workerUrl: config.handbook?.workerUrl || '', configured: Boolean(config.handbook?.workerUrl || process.env.HANDBOOK_RAG_WORKER_URL) && config.handbook?.enabled !== false, tokenConfigured: Boolean(process.env.HANDBOOK_RAG_WORKER_TOKEN) },
          reportAutomation: {
            enabled: ra.enabled !== false,
            baseUrl: ra.baseUrl || '',
            hasKey: Boolean(ra.apiKey),
            keyMasked: ra.apiKey ? db.maskSecret(ra.apiKey) : '',
            configured: Boolean(ra.baseUrl && ra.apiKey),
            freshOnAsk: ra.freshOnAsk === true,
            mirrorCount: raMirror.count,
            mirrorUpdatedAt: raMirror.updatedAt,
            mirrorLatestDate: raMirror.latestDate,
          },
          rag: config.rag,
          sheetOptions,
          detectedColumns: discoverExtraColumns(snapshotProjects),
          providerMetrics: summarizeProviderMetrics(),
          updatedAt: config.updatedAt,
          aiAvailable: liveNames.length > 0,
          engine: liveNames.length ? `llm:${liveNames.join('→')}` : 'builtin',
        });
      }
      // GET /api/master/assistant-metrics — aggregate provider/cache trend.
      // Superadmin only; deliberately contains no prompts, answers, or keys.
      if (pathname === '/api/master/assistant-metrics' && method === 'GET') {
        const role = reqUrl.searchParams.get('role') || '';
        if (role !== 'superadmin') return err(403, 'Superadmin access required');
        const { summarizeProviderMetrics } = await import('./assistantMetrics.js');
        return ok(summarizeProviderMetrics());
      }
// PUT /api/master/assistant-config — save provider keys / source / RAG settings
      if (pathname === '/api/master/assistant-config' && method === 'PUT') {
        const b = await body();
        const role = b.role || reqUrl.searchParams.get('role') || '';
        if (role !== 'superadmin') return err(403, 'Superadmin access required');
        const patch = {};
        const cleanedIgnored = [];
        const config = db.getAssistantConfig();
        if (b.providers && typeof b.providers === 'object') {
          patch.providers = {};
          for (const [name, val] of Object.entries(b.providers)) {
            if (!val || typeof val !== 'object') continue;
            const clean = {};
            if ('enabled' in val) clean.enabled = val.enabled !== false;
            if ('baseUrl' in val) clean.baseUrl = String(val.baseUrl || '').trim();
            if ('models' in val) clean.models = String(val.models || '').trim();
            // A key is only written when a REAL value is sent. Two guards:
            //  - a masked preview (contains '•' or '…') means "leave as is"
            //  - provider tokens are long; anything under 16 chars is a mask,
            //    a typo, or a truncated paste, so it is rejected outright.
            // An empty string is honoured as an explicit "clear this key".
            if ('apiKey' in val) {
              const k = String(val.apiKey || '').trim();
              const looksMasked = k.includes('•') || k.includes('…') || k.includes('\uFFFD');
              if (k === '') clean.apiKey = '';
              else if (looksMasked) cleanedIgnored.push(`${name}: masked value sent back — key left unchanged`);
              else if (k.length < 16) cleanedIgnored.push(`${name}: key looks truncated (${k.length} chars) — ignored`);
              else clean.apiKey = k;
            }
            patch.providers[name] = clean;
          }
        }
        if (Array.isArray(b.order)) patch.order = b.order.filter((n) => typeof n === 'string');
        if (b.source && typeof b.source === 'object') {
          patch.source = {
            credentialId: String(b.source.credentialId || '').trim(),
            spreadsheetId: String(b.source.spreadsheetId || '').trim(),
            tabs: Array.isArray(b.source.tabs) ? b.source.tabs.map((t) => String(t).trim()).filter(Boolean) : [],
            freshOnAsk: b.source.freshOnAsk === true,
          };
        }
        if (b.documents && typeof b.documents === 'object') {
          const cleanDoc = (value) => String(value || '').trim().slice(0, 1000);
          patch.documents = {
            sources: Array.isArray(b.documents.sources) ? b.documents.sources
              .map((item) => ({ id: cleanDoc(item?.id || item), url: cleanDoc(item?.url || ''), title: cleanDoc(item?.title || '') }))
              .filter((item) => item.id || item.url) : [],
            folderIds: Array.isArray(b.documents.folderIds) ? b.documents.folderIds.map(cleanDoc).filter(Boolean) : [],
            freshOnAsk: b.documents.freshOnAsk === true,
          };
        }
        if (b.handbook && typeof b.handbook === 'object') {
          let workerUrl = String(b.handbook.workerUrl || '').trim().replace(/\/+$/, '');
          if (workerUrl) {
            try {
              const parsed = new URL(workerUrl);
              if (!['https:', 'http:'].includes(parsed.protocol) || /\/(?:admin|ingest)(?:\/|$)/i.test(parsed.pathname)) throw new Error('invalid');
            } catch { return err(400, 'Handbook URL must be an http(s) Worker base URL, not an /admin or /ingest endpoint'); }
          }
          patch.handbook = { enabled: b.handbook.enabled !== false, workerUrl: workerUrl.slice(0, 1000) };
        }
        if (b.reportAutomation && typeof b.reportAutomation === 'object') {
          // Validate the base URL when provided (defaults to the known worker).
          let raUrl = String(b.reportAutomation.baseUrl || '').trim().replace(/\/+$/, '');
          const prev = config.reportAutomation || {};
          if (raUrl) {
            try {
              const parsed = new URL(raUrl);
              if (!['https:', 'http:'].includes(parsed.protocol)) throw new Error('invalid');
            } catch { return err(400, 'Report Automation base URL must be an http(s) URL'); }
          } else {
            raUrl = prev.baseUrl || '';
          }
          const clean = { enabled: b.reportAutomation.enabled !== false, baseUrl: raUrl.slice(0, 1000), freshOnAsk: b.reportAutomation.freshOnAsk === true, apiKey: prev.apiKey || '' };
          if ('apiKey' in b.reportAutomation) {
            const k = String(b.reportAutomation.apiKey || '').trim();
            const looksMasked = k.includes('•') || k.includes('…') || k.includes('\uFFFD');
            if (k === '') clean.apiKey = '';
            else if (looksMasked) cleanedIgnored.push('reportAutomation: masked value sent back — key left unchanged');
            else if (k.length < 16) cleanedIgnored.push(`reportAutomation: key looks truncated (${k.length} chars) — ignored`);
            else clean.apiKey = k;
          }
          patch.reportAutomation = clean;
        }
        if (b.rag && typeof b.rag === 'object') {
          patch.rag = {};
          if ('strictGrounding' in b.rag) patch.rag.strictGrounding = b.rag.strictGrounding !== false;
          if ('verifyNumbers' in b.rag) patch.rag.verifyNumbers = b.rag.verifyNumbers !== false;
          if ('includePageUrls' in b.rag) patch.rag.includePageUrls = b.rag.includePageUrls !== false;
          if ('evidenceLimit' in b.rag) patch.rag.evidenceLimit = Math.max(0, Math.min(60, Number(b.rag.evidenceLimit) || 0));
          if ('contextChars' in b.rag) patch.rag.contextChars = Math.max(2000, Math.min(60000, Number(b.rag.contextChars) || 0));
        }
        try {
          const saved = db.setAssistantConfig(patch);
          return ok({ success: true, updatedAt: saved.updatedAt, source: saved.source, documents: saved.documents, handbook: { enabled: saved.handbook?.enabled !== false, workerUrl: saved.handbook?.workerUrl || '' }, reportAutomation: { enabled: saved.reportAutomation?.enabled !== false, baseUrl: saved.reportAutomation?.baseUrl || '', hasKey: Boolean(saved.reportAutomation?.apiKey), freshOnAsk: saved.reportAutomation?.freshOnAsk === true }, rag: saved.rag, ignored: cleanedIgnored });
        } catch (e) { return err(400, e.message); }
      }
// POST /api/master/assistant-config/test — live-test one provider or all
      if (pathname === '/api/master/assistant-config/test' && method === 'POST') {
        const b = await body();
        const role = b.role || reqUrl.searchParams.get('role') || '';
        if (role !== 'superadmin') return err(403, 'Superadmin access required');
        const { testProvider, resolveProviderSettings } = await import('./devAssistant.js');
        const config = db.getAssistantConfig();
        // Allow testing a key the superadmin just typed but has not saved yet.
        if (b.draft && typeof b.draft === 'object') {
          for (const [name, val] of Object.entries(b.draft)) {
            if (!val || typeof val !== 'object') continue;
            const merged = { ...(config.providers[name] || {}), ...val };
            const k = String(merged.apiKey || '');
            if (k.includes('•') || k.includes('…')) merged.apiKey = config.providers?.[name]?.apiKey || '';
            config.providers[name] = merged;
          }
        }
        if (b.all === true) {
          const names = resolveProviderSettings(process.env, config).map((s) => s.name);
          const results = [];
          for (const n of names) results.push(await testProvider(n, process.env, config));
          return ok({ success: true, results });
        }
        const name = String(b.provider || '').trim();
        if (!name) return err(400, 'provider required');
        const result = await testProvider(name, process.env, config);
        return ok({ success: result.ok === true, result });
      }

      // POST /api/master/assistant-config/test-source — verify the selected Google
      // Sheet is reachable and report how many rows the assistant would see.
      if (pathname === '/api/master/assistant-config/test-source' && method === 'POST') {
        const b = await body();
        const role = b.role || reqUrl.searchParams.get('role') || '';
        if (role !== 'superadmin') return err(403, 'Superadmin access required');
        const config = db.getAssistantConfig();
        const spreadsheetId = String(b.spreadsheetId || config.source.spreadsheetId || '').trim();
        const wantedTabs = Array.isArray(b.tabs) && b.tabs.length
          ? b.tabs.map((t) => String(t).trim()).filter(Boolean) : [];
        try {
          const { listTabTitles, getTabValues } = await import('./sheets.js');
          const tabs = await listTabTitles(spreadsheetId);
          const target = wantedTabs.length ? tabs.filter((t) => wantedTabs.includes(t)) : tabs;
          let rows = 0;
          const perTab = [];
          for (const tab of target) {
            try {
              const values = await getTabValues(tab, 'A1:E500', spreadsheetId);
              const n = Math.max(0, (values?.length || 0) - 1);
              rows += n;
              perTab.push({ tab, rows: n });
            } catch (e) {
              perTab.push({ tab, rows: 0, error: e.message });
            }
          }
          return ok({
            success: true,
            spreadsheetId,
            allTabs: tabs,
            tabsUsed: wantedTabs.length ? wantedTabs : ['(all tabs)'],
            perTab,
            totalRows: rows,
          });
        } catch (e) {
          return err(500, `Sheet unreachable: ${e.message}`);
        }
      }

      // POST /api/master/assistant-config/test-documents — validates the exact
      // Docs / folders currently selected in AI Settings. Only metadata and
      // errors are returned; document body text never goes to the browser.
      if (pathname === '/api/master/assistant-config/test-documents' && method === 'POST') {
        const b = await body();
        const role = b.role || reqUrl.searchParams.get('role') || '';
        if (role !== 'superadmin') return err(403, 'Superadmin access required');
        const config = db.getAssistantConfig();
        const documents = b.documents && typeof b.documents === 'object' ? b.documents : config.documents;
        try {
          const { fetchGoogleDocuments, documentSourceSummary } = await import('./docsRag.js');
          const result = await fetchGoogleDocuments(documents, { refresh: true });
          return ok({ success: result.errors.length === 0, ...documentSourceSummary(documents), documentCount: result.documents.length, documents: result.documents.map((d) => ({ title: d.title, url: d.url, modifiedTime: d.modifiedTime, chars: d.text.length })), errors: result.errors, fetchedAt: result.fetchedAt });
        } catch (e) { return err(500, `Documents unreachable: ${e.message}`); }
      }

      // POST /api/master/assistant-config/test-handbook — checks only /health.
      if (pathname === '/api/master/assistant-config/test-handbook' && method === 'POST') {
        const b = await body();
        const role = b.role || reqUrl.searchParams.get('role') || '';
        if (role !== 'superadmin') return err(403, 'Superadmin access required');
        const config = db.getAssistantConfig();
        const candidate = b.handbook && typeof b.handbook === 'object' ? { ...config, handbook: { ...config.handbook, ...b.handbook } } : config;
        const { testHandbook } = await import('./handbookRag.js');
        const result = await testHandbook(candidate);
        return ok({ success: result.ok, result: { ok: result.ok, message: result.message, configured: result.configured, workerUrl: result.workerUrl } });
      }

      // POST /api/master/assistant-config/test-report-feed — checks the Read-only
      // Report Automation log connection with the candidate (or saved) config.
      if (pathname === '/api/master/assistant-config/test-report-feed' && method === 'POST') {
        const b = await body();
        const role = b.role || reqUrl.searchParams.get('role') || '';
        if (role !== 'superadmin') return err(403, 'Superadmin access required');
        const config = db.getAssistantConfig();
        const saved = config.reportAutomation || {};
        const candidate = b.reportAutomation && typeof b.reportAutomation === 'object'
          ? { ...saved, ...b.reportAutomation }
          : saved;
        // If the UI sent a masked placeholder back, fall back to the saved key.
        const candidateKey = String(candidate.apiKey || '');
        if (candidateKey.includes('•') || candidateKey.includes('…')) candidate.apiKey = saved.apiKey || '';
        const { testReportFeed } = await import('./reportAutomation.js');
        const result = await testReportFeed(candidate);
        return ok({ success: result.ok, ...result });
      }


      // PUT /api/master/dev-projects/:id/items/:idx (Update item + live write to Google Sheet)
      if (/^\/api\/master\/dev-projects\/[^/]+\/items\/\d+$/.test(pathname) && method === 'PUT') {
        const parts = pathname.split('/');
        const projId = parts[4];
        const itemIdx = parseInt(parts[6], 10);
        const b = await body();
        try {
          const { project, item } = db.updateDevProjectItem(projId, itemIdx, b);

          // Real-time live write to Google Sheet
          let sheetResult = null;
          try {
            const { updateDevTrackerRowInSheet } = await import('./sheets.js');
            if (project?.project && item?.rowNum) {
              // NOTE: devDate/devNotes (columns C/D — Development-Date /
              // Development-Updates) MUST be passed through. They used to be
              // omitted here, and because buildDevTrackerRow() defaults any
              // missing field to '' the writer silently WIPED the Development
              // columns in the sheet on every status change / edit made from
              // the dashboard. Fall back to the incoming body so a partial
              // update can never blank them.
              sheetResult = await updateDevTrackerRowInSheet({
                tabName: project.project,
                rowNum: item.rowNum,
                url: item.url,
                status: item.status,
                devDate: item.devDate ?? b.devDate ?? '',
                devNotes: item.devNotes ?? b.devNotes ?? '',
                feedbackUrl: item.feedbackUrl,
                date: item.date,
                notes: item.notes,
                // Hand-added sheet columns (auto-discovered keys) — forwarded so
                // a dashboard edit can never blank them in the sheet.
                extra: b.extra ?? item.extra ?? {},
              });
              console.log(`[dev-projects] ✅ Live synced to sheet "${project.project}" row ${item.rowNum}`);
            }
          } catch (sheetErr) {
            console.warn(`[dev-projects] ⚠ Warning: Could not write to sheet: ${sheetErr.message}`);
          }

          return ok({ project, item, sheetResult });
        }
        catch (e) { return err(404, e.message); }
      }

      // POST /api/master/dev-projects/:id/items (Add new item + append to Google Sheet)
      if (/^\/api\/master\/dev-projects\/[^/]+\/items$/.test(pathname) && method === 'POST') {
        const parts = pathname.split('/');
        const projId = parts[4];
        const b = await body();
        try {
          const { project, item } = db.addDevProjectItem(projId, b);

          let sheetResult = null;
          try {
            const { appendDevTrackerRowInSheet } = await import('./sheets.js');
            if (project?.project) {
              // devDate/devNotes → sheet columns C/D (Development-Date /
              // Development-Updates). Same reason as the PUT handler: omitting
              // them writes blank cells instead of the real values.
              sheetResult = await appendDevTrackerRowInSheet({
                tabName: project.project,
                url: item.url,
                status: item.status,
                devDate: item.devDate ?? b.devDate ?? '',
                devNotes: item.devNotes ?? b.devNotes ?? '',
                feedbackUrl: item.feedbackUrl,
                date: item.date,
                notes: item.notes,
                extra: b.extra ?? item.extra ?? {},
              });
              console.log(`[dev-projects] ✅ Appended new row to sheet "${project.project}"`);
            }
          } catch (sheetErr) {
            console.warn(`[dev-projects] ⚠ Warning: Could not append to sheet: ${sheetErr.message}`);
          }

          return ok({ project, item, sheetResult });
        } catch (e) { return err(404, e.message); }
      }

      // POST /api/master/dev-projects/:id/feedback-round (Create new feedback cycle + header in Sheet)
      if (/^\/api\/master\/dev-projects\/[^/]+\/feedback-round$/.test(pathname) && method === 'POST') {
        const parts = pathname.split('/');
        const projId = parts[4];
        const b = await body();
        try {
          const { project, headerItem, workItem } = db.addDevProjectFeedbackRound(projId, b);

          let sheetResult = null;
          try {
            const { createNewFeedbackRoundInSheet } = await import('./sheets.js');
            if (project?.project) {
              sheetResult = await createNewFeedbackRoundInSheet({
                tabName: project.project,
                feedbackGroup: b.feedbackGroup || 'Feedback',
                feedbackUrl: b.feedbackUrl,
                date: b.date,
                notes: b.notes,
                status: b.status,
                url: b.url,
                // Development-Date / Development-Updates (columns C/D) — must
                // be forwarded, otherwise the new round's first work row is
                // written with blank Development cells.
                devDate: b.devDate ?? '',
                devNotes: b.devNotes ?? '',
              });
              console.log(`[dev-projects] ✅ Created new feedback round "${b.feedbackGroup}" in sheet "${project.project}"`);
            }
          } catch (sheetErr) {
            console.warn(`[dev-projects] ⚠ Warning: Could not create feedback round in sheet: ${sheetErr.message}`);
          }

          return ok({ project, headerItem, workItem, sheetResult });
        } catch (e) { return err(404, e.message); }
      }

      // POST /api/master/dev-projects/create-project (Create new project tab with sitemap and initial feedback)
      if (pathname === '/api/master/dev-projects/create-project' && method === 'POST') {
        const b = await body();
        try {
          const { project } = db.createDevProject(b);

          let sheetResult = null;
          try {
            const { createNewProjectTabWithSitemapInSheet } = await import('./sheets.js');
            sheetResult = await createNewProjectTabWithSitemapInSheet({
              projectName: project.project,
              urls: b.urls || [],
              feedbackUrl: b.feedbackUrl,
              date: b.date,
              notes: b.notes,
              status: b.status,
            });
            console.log(`[dev-projects] ✅ Created new sheet tab "${project.project}" with sitemap`);
          } catch (sheetErr) {
            console.warn(`[dev-projects] ⚠ Warning: Could not create tab in sheet: ${sheetErr.message}`);
          }

          return ok({ project, sheetResult });
        } catch (e) { return err(400, e.message); }
      }

      // POST /api/master/dev-projects/:id/bulk-sitemap (Bulk import pasted URLs into project and Sheet)
      if (/^\/api\/master\/dev-projects\/[^/]+\/bulk-sitemap$/.test(pathname) && method === 'POST') {
        const parts = pathname.split('/');
        const projId = parts[4];
        const b = await body();
        try {
          const urls = Array.isArray(b.urls) ? b.urls : [];
          if (!urls.length) return err(400, 'No URLs provided');

          const { project, addedCount } = db.bulkAddDevProjectUrls(projId, urls, b.status || 'todo');

          let sheetResult = null;
          try {
            const { bulkAppendSitemapUrlsInSheet } = await import('./sheets.js');
            if (project?.project) {
              sheetResult = await bulkAppendSitemapUrlsInSheet({
                tabName: project.project,
                urls,
                status: b.status || 'todo',
              });
              console.log(`[dev-projects] ✅ Bulk appended ${addedCount} URLs to sheet "${project.project}"`);
            }
          } catch (sheetErr) {
            console.warn(`[dev-projects] ⚠ Warning: Could not bulk append to sheet: ${sheetErr.message}`);
          }

          return ok({ project, addedCount, sheetResult });
        } catch (e) { return err(400, e.message); }
      }

      // ── DOMAIN EXPIRY (read from sites) ────────────────────────
      if (pathname === '/api/master/domain-expiry' && method === 'GET') {
        const sites = db.getSites().filter(s => s.domainExpiry);
        const domains = sites.map(s => ({
          siteId: s.id, url: s.url, company: s.company, account: s.account,
          accountManager: s.accountManager, contact: s.contact, cms: s.cms,
          expiryDate: s.domainExpiry, daysLeft: s.daysLeft,
          urgent: s.daysLeft !== null && s.daysLeft <= 30,
          warning: s.daysLeft !== null && s.daysLeft > 30 && s.daysLeft <= 90,
        }));
        domains.sort((a, b) => (a.daysLeft ?? 9999) - (b.daysLeft ?? 9999));
        return ok({ domains });
      }

      // ── UPTIME CHECK ───────────────────────────────────────────
      // POST /api/master/check-uptime  body: { siteId? } (all if omitted)
      if (pathname === '/api/master/check-uptime' && method === 'POST') {
        const b = await body();
        const { checkSite, checkSitesBatch } = await import('./uptime.js');
        const sites = db.getSites();

        if (b.siteId || b.url || b.rowId) {
          let url = b.url;
          let site = b.siteId ? db.getSiteById(b.siteId) : (url ? db.getSiteByUrl(url) : null);
          if (!site && b.rowId) {
            const rows = db.getDailyReview();
            const r = rows.find(x => x.id === b.rowId);
            if (r) {
              url = r.siteUrl;
              if (r.siteId) site = db.getSiteById(r.siteId);
              if (!site && url) site = db.getSiteByUrl(url);
            }
          }
          if (!url && site) url = site.url;
          if (!url) return err(400, 'Could not resolve URL to check');
          const result = await checkSite(url);
          let updated = null;
          if (site) {
            updated = db.updateSite(site.id, {
              uptimeStatus: result.status,
              uptimeStatusCode: result.statusCode,
              uptimeResponseTime: result.responseTime,
              lastUptimeCheck: result.checkedAt,
            });
          }
          return ok({ site: updated, result });
        }

        // Check all (stream progress via SSE)
        const isSSE = req.headers.accept?.includes('text/event-stream');
        if (isSSE) {
          res.writeHead(200, {
            'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache',
            'Access-Control-Allow-Origin': '*', Connection: 'keep-alive',
          });
          let done = 0;
          await checkSitesBatch(sites.map(s => s.url), (url, result) => {
            const site = sites.find(s => s.url === url);
            if (site) {
              db.updateSite(site.id, {
                uptimeStatus: result.status,
                uptimeStatusCode: result.statusCode,
                uptimeResponseTime: result.responseTime,
                lastUptimeCheck: result.checkedAt,
              });
            }
            done++;
            res.write(`data: ${JSON.stringify({ url, result, done, total: sites.length })}\n\n`);
          });
          res.write(`data: ${JSON.stringify({ complete: true, total: sites.length })}\n\n`);
          return res.end();
        }
        // Non-SSE: just run and return summary
        await checkSitesBatch(sites.map(s => s.url), (url, result) => {
          const site = sites.find(s => s.url === url);
          if (site) db.updateSite(site.id, { uptimeStatus: result.status, lastUptimeCheck: result.checkedAt });
        });
        const updated = db.getSites();
        return ok({ online: updated.filter(s => s.uptimeStatus === 'online').length,
          offline: updated.filter(s => s.uptimeStatus === 'offline').length });
      }

      // ── NOTICES (Notice Board) ──────────────────────────────────
      // GET /api/master/notices
      if (pathname === '/api/master/notices' && method === 'GET') {
        return ok({ notices: db.getNotices() });
      }
      // POST /api/master/notices  (admin+)
      if (pathname === '/api/master/notices' && method === 'POST') {
        const b = await body();
        if (!b.title) return err(400, 'title required');
        return ok({ notice: db.createNotice(b) });
      }
      // PUT /api/master/notices/:id  (admin+)
      if (/^\/api\/master\/notices\/([^/]+)$/.test(pathname) && method === 'PUT') {
        const id = pathname.split('/').pop();
        const b = await body();
        try { return ok({ notice: db.updateNotice(id, b) }); }
        catch (e) { return err(404, e.message); }
      }
      // DELETE /api/master/notices/:id  (admin+)
      if (/^\/api\/master\/notices\/([^/]+)$/.test(pathname) && method === 'DELETE') {
        const id = pathname.split('/').pop();
        db.deleteNotice(id);
        return ok({ success: true });
      }

      // ── DOMAIN EXPIRY REQUESTS (Approval Workflow) ─────────────
      // GET /api/master/domain-expiry-requests?status=
      if (pathname === '/api/master/domain-expiry-requests' && method === 'GET') {
        const status = reqUrl.searchParams.get('status');
        return ok({ requests: db.getDomainExpiryRequests(status ? { status } : {}) });
      }
      // POST /api/master/domain-expiry-requests (user submits, or admin directApply)
      if (pathname === '/api/master/domain-expiry-requests' && method === 'POST') {
        const b = await body();
        if (!b.requestedDate) return err(400, 'requestedDate required');
        if (b.directApply) {
          try {
            const site = db.updateSiteDomainExpiryDirect(b.siteId || b.siteUrl, b.requestedDate);
            return ok({ direct: true, site });
          } catch (e) { return err(404, e.message); }
        }
        try {
          const reqItem = db.createDomainExpiryRequest(b);
          return ok({ request: reqItem });
        } catch (e) { return err(400, e.message); }
      }
      // POST /api/master/domain-expiry-requests/:id/resolve (admin+)
      if (/^\/api\/master\/domain-expiry-requests\/([^/]+)\/resolve$/.test(pathname) && method === 'POST') {
        const id = pathname.split('/')[4];
        const b = await body();
        if (!b.action) return err(400, 'action required (approved or rejected)');
        try {
          const result = db.resolveDomainExpiryRequest(id, b.action, b.resolvedBy || 'admin');
          return ok({ success: true, ...result });
        } catch (e) { return err(400, e.message); }
      }

      // ── SHEET CREDENTIALS & INTEGRATION (Connected Spreadsheets) ──────────
      const sheetProgressCache = new Map();

      async function getOrComputeSheetProgress(cred) {
        if (!cred || !cred.spreadsheetId) return { total: 0, completed: 0, inProgress: 0, pending: 0, completionPct: 0, statusSummary: {} };
        const cached = sheetProgressCache.get(cred.id);
        if (cached && (Date.now() - cached.cachedAt < 90000)) return cached.data;

        try {
          const { getTabValues, listTabTitles } = await import('./sheets.js');
          let targetTab = cred.tabName;
          let allRows = [];
          try {
            allRows = await getTabValues(targetTab, 'A1:ZZ500', cred.spreadsheetId) || [];
          } catch {
            const tabs = await listTabTitles(cred.spreadsheetId).catch(() => []);
            if (tabs.length) {
              targetTab = tabs[0];
              allRows = await getTabValues(targetTab, 'A1:ZZ500', cred.spreadsheetId) || [];
            }
          }

          const hRow = cred.headerRow || 1;
          if (allRows.length < hRow) {
            const res = { total: 0, completed: 0, inProgress: 0, pending: 0, completionPct: 0, statusSummary: {} };
            sheetProgressCache.set(cred.id, { data: res, cachedAt: Date.now() });
            return res;
          }

          const rawHeader = allRows[hRow - 1] || [];
          const headers = rawHeader.map((h, i) => ({ key: `col_${i}`, label: String(h || '').trim(), index: i })).filter(h => h.label);
          const statusCol = headers.find(h => {
            const l = h.label.toLowerCase();
            return l.includes('status') || l.includes('state') || l.includes('progress') || l.includes('stage') || l.includes('phase') || l === 'active' || l.includes('done');
          });

          const isCompletedVal = v => /^(completed|done|finished|resolved|closed|approved|active|live|yes|ok|passed)$/i.test(String(v).trim());
          const isInProgressVal = v => /^(in[ _-]progress|progress|review|client[ _-]review|doing|working|wip|ongoing|testing)$/i.test(String(v).trim());
          const isPendingVal = v => /^(pending|todo|to[ _-]do|backlog|open|planned|hold|draft|new|inactive|deactive)$/i.test(String(v).trim());

          const dataRows = allRows.slice(hRow);
          const statusSummary = {};
          let completed = 0, inProgress = 0, pending = 0;
          let totalWithData = 0;

          dataRows.forEach(r => {
            if (!r || !r.some(v => v !== '' && v !== null && v !== undefined)) return;
            totalWithData++;
            if (statusCol) {
              const val = String(r[statusCol.index] || '').trim();
              if (val) {
                statusSummary[val] = (statusSummary[val] || 0) + 1;
                if (isCompletedVal(val)) completed++;
                else if (isInProgressVal(val)) inProgress++;
                else if (isPendingVal(val)) pending++;
              }
            }
          });

          const totalForPct = statusCol ? Object.values(statusSummary).reduce((a, b) => a + b, 0) : totalWithData;
          const completionPct = totalForPct > 0 ? Math.round((completed / totalForPct) * 100) : 0;
          const res = { total: totalWithData, completed, inProgress, pending, completionPct, statusSummary };
          sheetProgressCache.set(cred.id, { data: res, cachedAt: Date.now() });
          return res;
        } catch {
          return { total: 0, completed: 0, inProgress: 0, pending: 0, completionPct: 0, statusSummary: {} };
        }
      }

      // GET /api/master/sheet-credentials & GET /api/master/custom-sheets
      if ((pathname === '/api/master/sheet-credentials' || pathname === '/api/master/custom-sheets') && method === 'GET') {
        const role = reqUrl.searchParams.get('role') || 'user';
        const isManage = reqUrl.searchParams.get('manage') === '1';
        let credentials = db.getSheetCredentials();
        let sheets = db.getCustomSheets();
        if (!isManage) {
          const uid = reqUrl.searchParams.get('userId') || '';
          const uname = (reqUrl.searchParams.get('userName') || '').toLowerCase();
          credentials = credentials.filter(c => {
            if (c.active === false) return false;
            if (c.showInNav === false) return false;
            if (c.visibleTo && !c.visibleTo.includes(role)) return false;
            if (role === 'user' && Array.isArray(c.assignedUsers) && c.assignedUsers.length > 0) {
              const matched = c.assignedUsers.some(u =>
                String(u).toLowerCase() === uid.toLowerCase() ||
                String(u).toLowerCase() === uname
              );
              if (!matched) return false;
            }
            return true;
          });
          sheets = sheets.filter(s => s.visibleTo?.includes(role));
        }

        if (reqUrl.searchParams.get('progress') === '1') {
          const progressList = await Promise.all(credentials.map(async c => {
            try {
              const metrics = await getOrComputeSheetProgress(c);
              const canEdit = (c.editableBy || []).includes(role);
              return { ...c, metrics, canEdit };
            } catch (e) {
              console.warn(`[sheet-credentials] progress failed for "${c.name || c.id}": ${e.message}`);
              return { ...c, metrics: null, canEdit: (c.editableBy || []).includes(role) };
            }
          }));
          credentials = progressList;
        }

        let serviceAccountEmail = null;
        try {
          const saPath = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_PATH || './service-account.json';
          const saRaw = fs.readFileSync(saPath, 'utf8');
          serviceAccountEmail = JSON.parse(saRaw).client_email || null;
        } catch {}
        return ok({ credentials, sheets, serviceAccountEmail });
      }

      // PUT /api/master/sheet-credentials/:id — update spreadsheet ID, active status, tabName, permissions, etc.
      if (/^\/api\/master\/sheet-credentials\/([^/]+)$/.test(pathname) && method === 'PUT') {
        const id = pathname.split('/').pop();
        const b = await body();
        try {
          sheetProgressCache.delete(id);
          const updated = db.updateSheetCredential(id, b);
          return ok({ success: true, credential: updated });
        } catch (e) { return err(400, e.message); }
      }

      // POST /api/master/sheet-credentials — add a new sheet credential
      if (pathname === '/api/master/sheet-credentials' && method === 'POST') {
        const b = await body();
        try {
          const created = db.createSheetCredential(b);
          return ok({ success: true, credential: created });
        } catch (e) { return err(400, e.message); }
      }

      // DELETE /api/master/sheet-credentials/:id — delete custom sheet credential
      if (/^\/api\/master\/sheet-credentials\/([^/]+)$/.test(pathname) && method === 'DELETE') {
        const id = pathname.split('/').pop();
        try {
          db.deleteSheetCredential(id);
          return ok({ success: true });
        } catch (e) { return err(400, e.message); }
      }

      // POST /api/master/sheet-credentials/:id/test — test live connection to spreadsheet
      if (/^\/api\/master\/sheet-credentials\/([^/]+)\/test$/.test(pathname) && method === 'POST') {
        const id = pathname.split('/')[4];
        const cred = db.getSheetCredentialById(id) || db.getCustomSheetById(id);
        if (!cred) return err(404, 'Sheet credential not found');
        const sheetIdToTest = cred.spreadsheetId;
        try {
          const { listTabTitles, getTabValues } = await import('./sheets.js');
          const tabs = await listTabTitles(sheetIdToTest);
          let rowCount = 0;
          let headerCols = [];
          if (tabs && tabs.length) {
            const targetTab = tabs.includes(cred.tabName) ? cred.tabName : tabs[0];
            const sampleRows = await getTabValues(targetTab, 'A1:ZZ100', sheetIdToTest).catch(() => []);
            rowCount = sampleRows?.length || 0;
            const hRow = cred.headerRow || 1;
            if (sampleRows.length >= hRow) {
              headerCols = (sampleRows[hRow - 1] || []).filter(h => h && String(h).trim());
            }
          }
          const updated = db.updateSheetCredential(id, {
            connectionStatus: 'ok',
            lastChecked: new Date().toISOString(),
            lastError: null,
            detectedTabs: tabs,
          });
          return ok({
            ok: true,
            status: 'ok',
            tabs,
            rowCount,
            headerCols,
            credential: updated,
            message: `Connected successfully! Found ${tabs?.length || 0} tab(s) and ${headerCols.length} columns.`,
          });
        } catch (e) {
          const updated = db.updateSheetCredential(id, {
            connectionStatus: 'error',
            lastChecked: new Date().toISOString(),
            lastError: e.message,
          });
          return ok({
            ok: false,
            status: 'error',
            error: e.message,
            credential: updated,
            message: `Connection failed: ${e.message}`,
          });
        }
      }

      // GET /api/master/sheet-credentials/:id/data — read smart sheet data with status detection & role check
      if (/^\/api\/master\/sheet-credentials\/([^/]+)\/data$/.test(pathname) && method === 'GET') {
        const id = pathname.split('/')[4];
        const role = reqUrl.searchParams.get('role') || 'user';
        const cred = db.getSheetCredentialById(id) || db.getCustomSheetById(id);
        if (!cred) return err(404, 'Sheet credential not found');

        // Check view permission
        if (cred.visibleTo && !cred.visibleTo.includes(role)) {
          return err(403, 'Access denied for your role');
        }

        const canEdit = (cred.editableBy || []).includes(role);
        const search = (reqUrl.searchParams.get('search') || '').toLowerCase().trim();
        const page = Math.max(1, Number(reqUrl.searchParams.get('page') || 1));
        const limit = Math.min(500, Math.max(10, Number(reqUrl.searchParams.get('limit') || 200)));

        try {
          const { getTabValues, listTabTitles } = await import('./sheets.js');
          const headerRowNum = cred.headerRow || 1;
          const reqTab = reqUrl.searchParams.get('tab');
          let targetTab = reqTab || cred.tabName;
          let availableTabs = cred.detectedTabs || [];

          let allRows;
          try {
            allRows = await getTabValues(targetTab, 'A1:ZZ2000', cred.spreadsheetId) || [];
          } catch (tabErr) {
            // If requested tab failed, fetch available tabs and auto-heal to first available tab
            availableTabs = await listTabTitles(cred.spreadsheetId).catch(() => []);
            if (availableTabs.length) {
              targetTab = availableTabs[0];
              allRows = await getTabValues(targetTab, 'A1:ZZ2000', cred.spreadsheetId) || [];
              if (!reqTab) {
                db.updateSheetCredential(id, { tabName: targetTab, detectedTabs: availableTabs });
              }
            } else {
              throw tabErr;
            }
          }

          if (!availableTabs.length) {
            availableTabs = await listTabTitles(cred.spreadsheetId).catch(() => [targetTab]);
          }

          if (allRows.length < headerRowNum) {
            return ok({ rows: [], headers: [], total: 0, page: 1, limit, pages: 0, statusSummary: {}, canEdit, title: cred.title || cred.label, tabName: targetTab, tabs: availableTabs, spreadsheetId: cred.spreadsheetId });
          }

          const rawHeader = allRows[headerRowNum - 1] || [];
          const headers = rawHeader.map((h, i) => ({
            key: `col_${i}`,
            label: (h || `Col ${i + 1}`).trim(),
            index: i,
          })).filter(h => h.label);

          const dataRowsRaw = allRows.slice(headerRowNum);
          let rows = dataRowsRaw.map((r, rowIdx) => {
            const rowNumber = rowIdx + headerRowNum + 1; // 1-indexed spreadsheet row
            const obj = { _rowNumber: rowNumber, _rowIndex: rowIdx };
            headers.forEach(h => {
              obj[h.key] = r[h.index] ?? '';
            });
            return obj;
          });

          // Intelligent Column Detection
          const statusColKeys = headers.filter(h => {
            const l = h.label.toLowerCase();
            return l.includes('status') || l.includes('state') || l.includes('progress') || l.includes('stage') || l.includes('phase') || l === 'active' || l.includes('done');
          }).map(h => h.key);

          const assigneeColKeys = headers.filter(h => {
            const l = h.label.toLowerCase();
            return l.includes('assign') || l.includes('user') || l.includes('dev') || l.includes('owner') || l.includes('member') || l.includes('person') || l.includes('who') || l.includes('author') || l.includes('lead');
          }).map(h => h.key);

          const urlColKeys = headers.filter(h => {
            const l = h.label.toLowerCase();
            return l.includes('url') || l.includes('site') || l.includes('website') || l.includes('domain') || l.includes('link') || l.includes('endpoint');
          }).map(h => h.key);

          const titleColKeys = headers.filter(h => {
            const l = h.label.toLowerCase();
            return l.includes('task') || l.includes('title') || l.includes('name') || l.includes('project') || l.includes('item') || l.includes('feature') || l.includes('summary') || l.includes('issue');
          }).map(h => h.key);

          const priorityColKeys = headers.filter(h => {
            const l = h.label.toLowerCase();
            return l.includes('priority') || l.includes('urgency') || l.includes('level') || l.includes('severity');
          }).map(h => h.key);

          const primaryStatusKey = statusColKeys[0] || null;
          const primaryAssigneeKey = assigneeColKeys[0] || null;
          const primaryUrlKey = urlColKeys[0] || null;
          const primaryTitleKey = titleColKeys[0] || (headers.find(h => h.key !== primaryStatusKey && !urlColKeys.includes(h.key))?.key || headers[0]?.key);
          const primaryPriorityKey = priorityColKeys[0] || null;

          // Compute status summary & progress across all dataset rows
          const statusSummary = {};
          const assigneeSummary = {};
          let completedCount = 0;
          let inProgressCount = 0;
          let pendingCount = 0;

          const isCompletedVal = v => /^(completed|done|finished|resolved|closed|approved|active|live|yes|ok|passed)$/i.test(String(v).trim());
          const isInProgressVal = v => /^(in[ _-]progress|progress|review|client[ _-]review|doing|working|wip|ongoing|testing)$/i.test(String(v).trim());
          const isPendingVal = v => /^(pending|todo|to[ _-]do|backlog|open|planned|hold|draft|new|inactive|deactive)$/i.test(String(v).trim());

          let totalRowsWithData = 0;
          rows.forEach(r => {
            const hasData = Object.keys(r).some(k => !k.startsWith('_') && r[k] !== '' && r[k] !== null && r[k] !== undefined);
            if (!hasData) return;
            totalRowsWithData++;

            if (primaryStatusKey) {
              const val = String(r[primaryStatusKey] || '').trim();
              if (val) {
                statusSummary[val] = (statusSummary[val] || 0) + 1;
                if (isCompletedVal(val)) completedCount++;
                else if (isInProgressVal(val)) inProgressCount++;
                else if (isPendingVal(val)) pendingCount++;
              }
            }
            if (primaryAssigneeKey) {
              const val = String(r[primaryAssigneeKey] || '').trim();
              if (val) {
                assigneeSummary[val] = (assigneeSummary[val] || 0) + 1;
              }
            }
          });

          const totalForPct = primaryStatusKey ? Object.values(statusSummary).reduce((a, b) => a + b, 0) : totalRowsWithData;
          const completionPct = totalForPct > 0 ? Math.round((completedCount / totalForPct) * 100) : 0;

          // Curated status list
          const rawStatusKeys = Object.keys(statusSummary);
          const defaultStatuses = ['Active', 'In Progress', 'Completed', 'Done', 'Pending', 'To Do', 'Deactive'];
          const allStatuses = Array.from(new Set([...rawStatusKeys, ...defaultStatuses])).filter(Boolean);

          // Search filter
          if (search) {
            rows = rows.filter(r => Object.values(r).some(v => String(v).toLowerCase().includes(search)));
          }

          const total = rows.length;
          const paginated = rows.slice((page - 1) * limit, page * limit);

          return ok({
            rows: paginated,
            headers,
            total,
            page,
            limit,
            pages: Math.ceil(total / limit),
            statusColKeys,
            assigneeColKeys,
            urlColKeys,
            titleColKeys,
            priorityColKeys,
            primaryStatusKey,
            primaryAssigneeKey,
            primaryUrlKey,
            primaryTitleKey,
            primaryPriorityKey,
            statusSummary,
            assigneeSummary,
            allStatuses,
            metrics: {
              total: totalRowsWithData,
              completed: completedCount,
              inProgress: inProgressCount,
              pending: pendingCount,
              completionPct,
            },
            canEdit,
            title: cred.title || cred.label,
            tabName: targetTab,
            tabs: availableTabs,
            spreadsheetId: cred.spreadsheetId,
            headerRowNum,
            category: cred.category,
          });
        } catch (e) {
          return err(502, `Failed to fetch sheet data: ${e.message}`);
        }
      }

      // POST /api/master/sheet-credentials/:id/cell — update single cell
      if (/^\/api\/master\/sheet-credentials\/([^/]+)\/cell$/.test(pathname) && method === 'POST') {
        const id = pathname.split('/')[4];
        const role = reqUrl.searchParams.get('role') || 'superadmin';
        const cred = db.getSheetCredentialById(id) || db.getCustomSheetById(id);
        if (!cred) return err(404, 'Sheet credential not found');

        if (cred.editableBy && !cred.editableBy.includes(role)) {
          return err(403, 'You do not have permission to edit this sheet');
        }

        const b = await body();
        const { rowNumber, colIndex, value } = b;
        if (rowNumber === undefined || colIndex === undefined) {
          return err(400, 'rowNumber and colIndex are required');
        }

        try {
          sheetProgressCache.delete(id);
          const { updateSheetCell, colIndexToA1 } = await import('./sheets.js');
          const colLetter = colIndexToA1(colIndex);
          const a1Notation = `${colLetter}${rowNumber}`;
          const tab = b.tabName || cred.tabName;
          await updateSheetCell(cred.spreadsheetId, tab, a1Notation, value ?? '');
          return ok({ success: true, a1Notation, value });
        } catch (e) {
          return err(502, `Failed to update cell in Google Sheet: ${e.message}`);
        }
      }

      // POST /api/master/sheet-credentials/:id/row — append a row to sheet
      if (/^\/api\/master\/sheet-credentials\/([^/]+)\/row$/.test(pathname) && method === 'POST') {
        const id = pathname.split('/')[4];
        const role = reqUrl.searchParams.get('role') || 'superadmin';
        const cred = db.getSheetCredentialById(id) || db.getCustomSheetById(id);
        if (!cred) return err(404, 'Sheet credential not found');

        if (cred.editableBy && !cred.editableBy.includes(role)) {
          return err(403, 'You do not have permission to add rows to this sheet');
        }

        const b = await body();
        const rowValues = Array.isArray(b.rowValues) ? b.rowValues : [];
        const tab = b.tabName || cred.tabName;
        try {
          sheetProgressCache.delete(id);
          const { appendSheetRow } = await import('./sheets.js');
          await appendSheetRow(cred.spreadsheetId, tab, rowValues);
          return ok({ success: true, message: 'Row added directly to Google Sheet' });
        } catch (e) {
          return err(502, `Failed to append row: ${e.message}`);
        }
      }

      // POST /api/master/sheet-credentials/:id/column — append a column to sheet
      if (/^\/api\/master\/sheet-credentials\/([^/]+)\/column$/.test(pathname) && method === 'POST') {
        const id = pathname.split('/')[4];
        const role = reqUrl.searchParams.get('role') || 'superadmin';
        const cred = db.getSheetCredentialById(id) || db.getCustomSheetById(id);
        if (!cred) return err(404, 'Sheet credential not found');

        if (cred.editableBy && !cred.editableBy.includes(role)) {
          return err(403, 'You do not have permission to add columns to this sheet');
        }

        const b = await body();
        const columnName = (b.columnName || '').trim();
        if (!columnName) return err(400, 'columnName is required');
        const tab = b.tabName || cred.tabName;

        try {
          sheetProgressCache.delete(id);
          const { appendSheetColumn } = await import('./sheets.js');
          const res = await appendSheetColumn(cred.spreadsheetId, tab, columnName, cred.headerRow || 1);
          return ok({ success: true, ...res, message: `Column "${columnName}" created in Google Sheet` });
        } catch (e) {
          return err(502, `Failed to append column: ${e.message}`);
        }
      }

      // ── CUSTOM SHEETS (Superadmin-managed external Google Sheets) ─────────
      // POST /api/master/custom-sheets — create
      if (pathname === '/api/master/custom-sheets' && method === 'POST') {
        const b = await body();
        try { return ok({ sheet: db.createCustomSheet(b) }); }
        catch (e) { return err(400, e.message); }
      }

      // PUT /api/master/custom-sheets/:id — update
      if (/^\/api\/master\/custom-sheets\/([^/]+)$/.test(pathname) && method === 'PUT') {
        const id = pathname.split('/').pop();
        const b = await body();
        try { return ok({ sheet: db.updateCustomSheet(id, b) }); }
        catch (e) { return err(404, e.message); }
      }

      // DELETE /api/master/custom-sheets/:id — delete
      if (/^\/api\/master\/custom-sheets\/([^/]+)$/.test(pathname) && method === 'DELETE') {
        const id = pathname.split('/').pop();
        db.deleteCustomSheet(id);
        return ok({ success: true });
      }

      // POST /api/master/custom-sheets/:id/probe — test connection, auto-detect columns
      if (/^\/api\/master\/custom-sheets\/([^/]+)\/probe$/.test(pathname) && method === 'POST') {
        const id = pathname.split('/')[4];
        const sheet = db.getCustomSheetById(id);
        if (!sheet) return err(404, 'Custom sheet not found');
        try {
          const { getTabValues } = await import('./sheets.js');
          // Fetch header row
          const headerRowNum = sheet.headerRow || 1;
          const headerRange = `${sheet.tabName}!A${headerRowNum}:ZZ${headerRowNum}`;
          const headerRows = await getTabValues(sheet.tabName, `A${headerRowNum}:ZZ${headerRowNum}`, sheet.spreadsheetId);
          const headers = (headerRows?.[0] || []).map((h, i) => ({
            key: `col_${i}`,
            label: h || `Column ${i + 1}`,
            index: i,
          })).filter(h => h.label && h.label.trim());

          // Sample first 50 data rows to guess numeric columns
          const dataStart = headerRowNum + 1;
          const dataRows = await getTabValues(sheet.tabName, `A${dataStart}:ZZ${dataStart + 49}`, sheet.spreadsheetId) || [];
          const numericCols = headers
            .map(h => ({ ...h, numericRatio: dataRows.filter(r => r[h.index] !== undefined && r[h.index] !== '' && !isNaN(Number(String(r[h.index]).replace(/[$,%]/g, '')))).length / Math.max(1, dataRows.length) }))
            .filter(h => h.numericRatio > 0.5)
            .map(h => h.key);

          const updated = db.updateCustomSheet(id, {
            columns: headers,
            statColumns: numericCols.slice(0, 4), // max 4 auto-stat cards
            connectionStatus: 'ok',
            lastProbed: new Date().toISOString(),
          });
          return ok({ sheet: updated, headers, suggestedStatColumns: numericCols, rowCount: dataRows.length });
        } catch (e) {
          db.updateCustomSheet(id, { connectionStatus: 'error', lastProbeError: e.message, lastProbed: new Date().toISOString() });
          return err(502, `Cannot connect to sheet: ${e.message}`);
        }
      }

      // GET /api/master/custom-sheets/:id/data?page=1&limit=200&search=
      if (/^\/api\/master\/custom-sheets\/([^/]+)\/data$/.test(pathname) && method === 'GET') {
        const id = pathname.split('/')[4];
        const sheet = db.getCustomSheetById(id);
        if (!sheet) return err(404, 'Custom sheet not found');
        const search = (reqUrl.searchParams.get('search') || '').toLowerCase().trim();
        const page = Math.max(1, Number(reqUrl.searchParams.get('page') || 1));
        const limit = Math.min(500, Math.max(10, Number(reqUrl.searchParams.get('limit') || 200)));
        try {
          const { getTabValues } = await import('./sheets.js');
          const headerRowNum = sheet.headerRow || 1;
          const headers = sheet.columns?.length ? sheet.columns : [];
          // Fetch all data rows (after header)
          const dataStart = headerRowNum + 1;
          const rawRows = await getTabValues(sheet.tabName, `A${dataStart}:ZZ`, sheet.spreadsheetId) || [];

          let rows = rawRows.map((r, rowIdx) => {
            const obj = { _rowIndex: rowIdx + dataStart };
            headers.forEach(h => { obj[h.key] = r[h.index] ?? ''; });
            return obj;
          });

          // Search filter
          if (search) {
            rows = rows.filter(r => Object.values(r).some(v => String(v).toLowerCase().includes(search)));
          }

          const total = rows.length;
          const paginated = rows.slice((page - 1) * limit, page * limit);

          // Stat summaries for numeric stat columns
          const stats = {};
          (sheet.statColumns || []).forEach(key => {
            const col = headers.find(h => h.key === key);
            if (!col) return;
            const nums = rows.map(r => Number(String(r[key] || '').replace(/[$,%]/g, ''))).filter(n => !isNaN(n));
            stats[key] = {
              label: col.label,
              sum: nums.reduce((a, b) => a + b, 0),
              count: nums.length,
              avg: nums.length ? Math.round(nums.reduce((a, b) => a + b, 0) / nums.length * 100) / 100 : 0,
              min: nums.length ? Math.min(...nums) : 0,
              max: nums.length ? Math.max(...nums) : 0,
            };
          });

          return ok({ rows: paginated, total, page, limit, pages: Math.ceil(total / limit), headers, stats });
        } catch (e) {
          return err(502, `Failed to fetch sheet data: ${e.message}`);
        }
      }

      sendJson(res, 404, { error: 'Master API route not found' });
      return;

    }



    // Static Files
    let filePath = path.join(PUBLIC_DIR,
      (pathname === '/' || pathname === '/master' || pathname === '/master.html' || pathname === '/dashboard') ? 'master.html' :
      (pathname === '/mailer' || pathname === '/mailer.html' || pathname === '/index.html' || pathname === '/email' || pathname === '/emails' || pathname === '/emaildashboard' || pathname === '/email-dashboard') ? 'index.html' :
      (pathname === '/setup' || pathname === '/setup.html') ? 'setup.html' :
      pathname
    );
    if (!filePath.startsWith(PUBLIC_DIR)) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('403 Forbidden');
      return;
    }

    serveStatic(res, filePath);
  } catch (err) {
    console.error('Server error on', pathname, ':', err);
    sendJson(res, 500, { error: err.message });
  }
});

function startServer(port, maxTries = 5) {
  server.listen(port, () => {
    console.log(`\n🚀 Maintenance Mailer Dashboard is running!`);
    console.log(`👉 Open in browser: http://localhost:${port}`);
    console.log(`Press Ctrl+C to stop.\n`);
    startRagScheduler();
    refreshReportMirrorOnBoot();

    // Auto-launch Cloudflare tunnel on local PC
    const isWorkerEnv = typeof fs.createWriteStream !== 'function' || typeof process?.versions?.node === 'undefined';
    if (!isWorkerEnv) {
      // Auto-pull cloud settings (sheets, mailer credentials, assistant config) on startup
      import('./cloudSync.js').then(({ pullSettingsFromCloud, startCloudSyncScheduler }) => {
        pullSettingsFromCloud().catch(() => {});
        startCloudSyncScheduler(10 * 60 * 1000); // sync every 10 minutes in background
      }).catch((e) => {
        console.warn('[cloud-sync] Boot sync init warning:', e.message);
      });
    }
    if (!isWorkerEnv && process.env.AUTO_TUNNEL !== 'false') {
      startCloudflareTunnel(port).then((tunnelUrl) => {
        console.log(`============================================================`);
        console.log(`  🌐 CLOUD TUNNEL URL (Quick Public URL):`);
        console.log(`  👉 ${tunnelUrl}`);
        console.log(`  🔗 Live Dashboard: https://officeos-dashboard.taion16240.workers.dev`);
        console.log(`============================================================\n`);
      }).catch((e) => {
        console.log(`[tunnel] Note: Tunnel can be started from UI (${e.message})`);
      });
    }
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE' && maxTries > 0) {
      console.warn(`Port ${port} is currently in use. Trying port ${port + 1}...`);
      server.removeAllListeners('error');
      server.removeAllListeners('listening');
      startServer(port + 1, maxTries - 1);
    } else {
      console.error('Server failed to start:', err);
      process.exit(1);
    }
  });
}

// On boot (and when the dashboard needs fresh report data) the Report
// Automation mirror is refreshed if it is stale, so the admin/superadmin
// report-status panel and chat answers always reflect the Worker log.
let reportMirrorBootRefreshed = false;
async function refreshReportMirrorOnBoot() {
  if (reportMirrorBootRefreshed) return;
  reportMirrorBootRefreshed = true;
  try {
    const config = db.getAssistantConfig();
    const ra = config.reportAutomation || {};
    if (ra.enabled === false || !ra.baseUrl || !ra.apiKey) {
      console.log('[report] Report Automation feed not configured — skipping boot mirror refresh');
      return;
    }
    const { syncReportMirror, loadReportMirror, isReportMirrorStale } = await import('./reportAutomation.js');
    const mirror = loadReportMirror();
    if (isReportMirrorStale(mirror)) {
      const synced = await syncReportMirror({ config: ra, refresh: true });
      console.log(`[report] Mirror refreshed on boot: ${(synced.items || []).length} report(s)`);
    } else {
      console.log(`[report] Mirror is fresh (${(mirror.items || []).length} report(s), updated ${mirror.updatedAt})`);
    }
  } catch (e) {
    console.warn('[report] Boot mirror refresh failed:', e.message);
  }
}

// Optional re-runnable index refresh for a long-running OfficeOS deployment.
// Keep it opt-in: set RAG_SYNC_INTERVAL_MS (e.g. 21600000 for six hours), or
// use the protected POST /api/master/rag/sync from an external cron service.
let ragSyncStarted = false;
function startRagScheduler() {
  if (ragSyncStarted) return;
  const interval = Number(process.env.RAG_SYNC_INTERVAL_MS || 0);
  if (!Number.isFinite(interval) || interval < 60_000) return;
  ragSyncStarted = true;
  const run = async () => {
    try {
      const { syncRagIndex } = await import('./enterpriseRag.js');
      const index = await syncRagIndex({ refresh: true, sources: { documents: db.getAssistantConfig().documents, reportAutomation: db.getAssistantConfig().reportAutomation } });
      console.log(`[rag] scheduled sync complete: ${index.chunkCount} chunks`);
    } catch (e) { console.warn('[rag] scheduled sync failed:', e.message); }
  };
  console.log(`[rag] scheduled sync enabled every ${Math.round(interval / 60000)} minutes`);
  setInterval(run, interval).unref();
}

startServer(DEFAULT_PORT);
