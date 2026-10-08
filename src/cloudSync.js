/**
 * cloudSync.js — Automated Settings & Data Synchronization
 *
 * Automatically pulls and syncs all configuration from the cloud-hosted master dashboard
 * (Cloudflare Worker KV) into the local environment on startup and in the background.
 *
 * Synced settings include:
 *  - Sheet Management (all connected Google Sheets, tabs, permissions, and custom sheets)
 *  - Email Mailer Credentials (CW & RM SMTP credentials, sender emails/names, spreadsheet IDs)
 *  - Google Service Account (service-account.json written and hydrated)
 *  - Assistant Config (AI provider keys, RAG settings, handbook & report automation configs)
 *  - User Profiles & Roles
 *  - Email conditional notes, notices, and user aliases
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import * as db from './db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');

const DEFAULT_CLOUD_URL = 'https://officeos-dashboard.taion16240.workers.dev';

const SYNC_KEYS = [
  'sheet-credentials',
  'custom-sheets',
  'sheet-schema',
  'mailer-credentials',
  'assistant-config',
  'users',
  'conditional-notes',
  'notices',
  'user-aliases',
];

export function getCloudConfig() {
  let dbToken = '';
  try {
    const creds = db.dbRead('mailer-credentials');
    dbToken = creds?.vars?.DASHBOARD_ADMIN_TOKEN || creds?.vars?.ADMIN_TOKEN || '';
  } catch {}

  const url = (
    process.env.DASHBOARD_WORKER_URL ||
    process.env.CLOUDFLARE_WORKER_URL ||
    DEFAULT_CLOUD_URL
  ).replace(/\/+$/, '');

  const token = (
    process.env.DASHBOARD_ADMIN_TOKEN ||
    process.env.CLOUDFLARE_WORKER_TOKEN ||
    process.env.ADMIN_TOKEN ||
    dbToken ||
    ''
  ).trim();

  return { url, token };
}

/**
 * Collect all core settings into a portable bundle object.
 * Works identically on local Node.js and Cloudflare Worker.
 */
export function getExportBundle() {
  const bundle = {};
  for (const key of SYNC_KEYS) {
    try {
      const data = db.dbRead(key);
      if (data !== null && data !== undefined) {
        bundle[key] = data;
      }
    } catch {}
  }

  // Ensure mailer-credentials has complete ClickUp, Sheets, and SA configs
  if (!bundle['mailer-credentials']) {
    bundle['mailer-credentials'] = { vars: {} };
  }
  if (!bundle['mailer-credentials'].vars) {
    bundle['mailer-credentials'].vars = {};
  }
  const vars = bundle['mailer-credentials'].vars;

  // Include ClickUp configuration if present in environment
  if (process.env.CLICKUP_API_TOKEN && !vars.CLICKUP_API_TOKEN) {
    vars.CLICKUP_API_TOKEN = process.env.CLICKUP_API_TOKEN;
  }
  if (process.env.CLICKUP_AUTO_CLOSE_ENABLED && !vars.CLICKUP_AUTO_CLOSE_ENABLED) {
    vars.CLICKUP_AUTO_CLOSE_ENABLED = process.env.CLICKUP_AUTO_CLOSE_ENABLED;
  }

  // Include Sheet IDs and Master Tabs if present in environment
  for (const k of [
    'CW_SPREADSHEET_ID', 'CW_MASTER_TAB_NAME',
    'RM_SPREADSHEET_ID', 'RM_MASTER_TAB_NAME',
    'CW_NAME', 'RM_NAME',
    'CW_SMTP_HOST', 'CW_SMTP_PORT', 'CW_SMTP_SECURE', 'CW_SMTP_USER', 'CW_SMTP_PASS', 'CW_FROM_EMAIL', 'CW_FROM_NAME',
    'RM_SMTP_HOST', 'RM_SMTP_PORT', 'RM_SMTP_SECURE', 'RM_SMTP_USER', 'RM_SMTP_PASS', 'RM_FROM_EMAIL', 'RM_FROM_NAME',
    'MAX_EMAILS_PER_RUN', 'DASHBOARD_ADMIN_TOKEN', 'ADMIN_TOKEN'
  ]) {
    if (process.env[k] && !vars[k]) {
      vars[k] = process.env[k];
    }
  }

  // Include service account if present in environment
  if (!bundle['mailer-credentials'].serviceAccount && process.env.GOOGLE_SERVICE_ACCOUNT_KEY_JSON) {
    try {
      bundle['mailer-credentials'].serviceAccount = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY_JSON);
    } catch {}
  }

  return {
    ok: true,
    version: '2026.10',
    exportedAt: new Date().toISOString(),
    keys: Object.keys(bundle),
    data: bundle,
  };
}

/**
 * Apply a settings bundle to the current environment.
 * Updates the database, hydrates process.env, and writes local files.
 */
export function applySettingsBundle(bundle) {
  if (!bundle || typeof bundle !== 'object') {
    throw new Error('Invalid bundle object');
  }

  const data = bundle.data || bundle;
  const isWorkerEnv = typeof fs.writeFileSync !== 'function' || typeof process?.versions?.node === 'undefined';
  const stats = {
    sheetsUpdated: 0,
    mailerVarsUpdated: 0,
    serviceAccountUpdated: false,
    usersUpdated: 0,
    assistantUpdated: false,
    keysApplied: [],
  };

  // 1. Sheet Credentials & Custom Sheets & Schema
  if (Array.isArray(data['sheet-credentials'])) {
    db.dbWrite('sheet-credentials', data['sheet-credentials']);
    stats.sheetsUpdated = data['sheet-credentials'].length;
    stats.keysApplied.push('sheet-credentials');
  }
  if (Array.isArray(data['custom-sheets'])) {
    db.dbWrite('custom-sheets', data['custom-sheets']);
    stats.keysApplied.push('custom-sheets');
  }
  if (data['sheet-schema'] && typeof data['sheet-schema'] === 'object') {
    db.dbWrite('sheet-schema', data['sheet-schema']);
    stats.keysApplied.push('sheet-schema');
  }

  // 2. Mailer Credentials & Environment Hydration
  if (data['mailer-credentials'] && typeof data['mailer-credentials'] === 'object') {
    const creds = data['mailer-credentials'];
    db.dbWrite('mailer-credentials', creds);
    // A cloud/tunnel credential push must also update the two Sheet Manager
    // system cards. Otherwise a connected local Mailer can receive the new RM
    // ID while its interactive dashboard still reads the former one.
    const sheetAlignment = db.syncMaintenanceSheetCredentialsFromMailerVars(creds.vars || {});
    stats.maintenanceSheetsAligned = sheetAlignment.updated;
    stats.keysApplied.push('mailer-credentials');

    // Service Account JSON
    if (creds.serviceAccount) {
      try {
        const saObj = typeof creds.serviceAccount === 'string'
          ? JSON.parse(creds.serviceAccount)
          : creds.serviceAccount;

        if (saObj && saObj.client_email && saObj.private_key) {
          if (!isWorkerEnv) {
            const saPath = path.join(ROOT_DIR, 'service-account.json');
            fs.writeFileSync(saPath, JSON.stringify(saObj, null, 2), 'utf8');
            process.env.GOOGLE_SERVICE_ACCOUNT_KEY_PATH = saPath;
          }
          process.env.GOOGLE_SERVICE_ACCOUNT_KEY_JSON = JSON.stringify(saObj);
          stats.serviceAccountUpdated = true;

          // Reset cached Google Sheets API client so it re-authorizes with new SA
          try {
            import('./sheets.js').then((m) => {
              if (typeof m.resetSheetsClient === 'function') m.resetSheetsClient();
            }).catch(() => {});
          } catch {}
        }
      } catch (e) {
        console.warn('[cloud-sync] Warning: Could not write service-account.json:', e.message);
      }
    }

    // Mailer vars & SMTP config
    if (creds.vars && typeof creds.vars === 'object') {
      const newVars = creds.vars;
      for (const [k, v] of Object.entries(newVars)) {
        if (v !== undefined && v !== null && v !== '') {
          process.env[k] = String(v);
        }
      }
      stats.mailerVarsUpdated = Object.keys(newVars).length;

      // Update local .env file so subsequent scripts & restarts keep the values
      if (!isWorkerEnv) {
        try {
          const envPath = path.join(ROOT_DIR, '.env');
          let envContent = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
          const existingKeys = new Set();
          const lines = envContent.split(/\r?\n/);
          const updatedLines = [];

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('#')) {
              updatedLines.push(line);
              continue;
            }
            const eqIdx = line.indexOf('=');
            if (eqIdx > 0) {
              const k = line.slice(0, eqIdx).trim();
              existingKeys.add(k);
              if (newVars[k] !== undefined && newVars[k] !== null && String(newVars[k]) !== '') {
                updatedLines.push(`${k}=${newVars[k]}`);
              } else {
                updatedLines.push(line);
              }
            } else {
              updatedLines.push(line);
            }
          }

          // Append any variables not yet in .env
          for (const [k, v] of Object.entries(newVars)) {
            if (!existingKeys.has(k) && v !== undefined && v !== null && String(v) !== '') {
              updatedLines.push(`${k}=${v}`);
            }
          }

          fs.writeFileSync(envPath, updatedLines.join('\n') + '\n', 'utf8');
        } catch (e) {
          console.warn('[cloud-sync] Warning: Could not update .env file:', e.message);
        }
      }
    }
  }

  // 3. Assistant Config
  if (data['assistant-config'] && typeof data['assistant-config'] === 'object') {
    db.dbWrite('assistant-config', data['assistant-config']);
    stats.assistantUpdated = true;
    stats.keysApplied.push('assistant-config');
  }

  // 4. Users (Preserve local password hashes while merging roles and profiles)
  if (Array.isArray(data['users'])) {
    try {
      const localUsers = db.getUsers({ includeMerged: true }) || [];
      const localPasswordMap = new Map();
      for (const u of localUsers) {
        if (u.id && u.passwordHash) localPasswordMap.set(u.id, u.passwordHash);
        if (u.email && u.passwordHash) localPasswordMap.set(u.email.toLowerCase(), u.passwordHash);
      }

      const mergedUsers = data['users'].map((cloudUser) => {
        const existingHash = localPasswordMap.get(cloudUser.id) ||
          (cloudUser.email ? localPasswordMap.get(cloudUser.email.toLowerCase()) : null);

        // Keep local password hash if cloud doesn't have one or if local was explicitly updated
        if (!cloudUser.passwordHash && existingHash) {
          return { ...cloudUser, passwordHash: existingHash };
        }
        return cloudUser;
      });

      db.dbWrite('users', mergedUsers);
      stats.usersUpdated = mergedUsers.length;
      stats.keysApplied.push('users');
    } catch (e) {
      console.warn('[cloud-sync] Warning: Could not merge users:', e.message);
    }
  }

  // 5. Additional collections
  for (const extraKey of ['conditional-notes', 'notices', 'user-aliases']) {
    if (data[extraKey] !== undefined) {
      db.dbWrite(extraKey, data[extraKey]);
      stats.keysApplied.push(extraKey);
    }
  }

  return stats;
}

/**
 * Pull all settings from the Cloudflare Worker into the local server.
 */
export async function pullSettingsFromCloud(options = {}) {
  const isWorkerEnv = typeof fs.writeFileSync !== 'function' || typeof process?.versions?.node === 'undefined';
  if (isWorkerEnv) {
    return { ok: false, message: 'pullSettingsFromCloud only runs on local Node server' };
  }

  const { url, token } = getCloudConfig();
  const endpoint = `${url}/api/cloud-sync/export`;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs || 15000);

    const res = await fetch(endpoint, {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
      },
      signal: controller.signal,
    }).finally(() => clearTimeout(timeout));

    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status}: ${errBody || res.statusText}`);
    }

    const payload = await res.json();
    if (!payload.ok || !payload.data) {
      throw new Error(payload.error || 'Invalid response from cloud sync endpoint');
    }

    const stats = applySettingsBundle(payload);
    const result = {
      ok: true,
      syncedAt: new Date().toISOString(),
      cloudUrl: url,
      stats,
    };

    console.log(`[cloud-sync] ☁️ Successfully pulled settings from cloud (${url})`);
    console.log(`[cloud-sync]   ✔ Sheet Management: ${stats.sheetsUpdated} sheet(s) synced`);
    console.log(`[cloud-sync]   ✔ Mailer Config: ${stats.mailerVarsUpdated} variable(s) synced`);
    if (stats.serviceAccountUpdated) {
      console.log(`[cloud-sync]   ✔ Service Account: updated service-account.json`);
    }
    if (stats.assistantUpdated) {
      console.log(`[cloud-sync]   ✔ Assistant: AI providers & RAG synced`);
    }

    return result;
  } catch (err) {
    const isAbort = err.name === 'AbortError';
    const msg = isAbort ? 'Connection timed out (15s)' : err.message;
    console.warn(`[cloud-sync] ⚠️ Cloud sync warning: ${msg}`);
    return {
      ok: false,
      error: msg,
      cloudUrl: url,
      fallbackToLocal: true,
    };
  }
}

/**
 * Push local settings up to the Cloudflare Worker.
 */
export async function pushSettingsToCloud(options = {}) {
  const { url, token } = getCloudConfig();
  const endpoint = `${url}/api/cloud-sync/push`;

  try {
    const bundle = getExportBundle();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs || 20000);

    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(bundle),
      signal: controller.signal,
    }).finally(() => clearTimeout(timeout));

    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status}: ${errBody || res.statusText}`);
    }

    const payload = await res.json();
    return {
      ok: true,
      pushedAt: new Date().toISOString(),
      cloudUrl: url,
      response: payload,
    };
  } catch (err) {
    return {
      ok: false,
      error: err.message,
      cloudUrl: url,
    };
  }
}

/**
 * Start periodic background sync on local PC.
 */
let _schedulerInterval = null;
export function startCloudSyncScheduler(intervalMs = 10 * 60 * 1000) {
  const isWorkerEnv = typeof fs.writeFileSync !== 'function' || typeof process?.versions?.node === 'undefined';
  if (isWorkerEnv) return;

  if (_schedulerInterval) clearInterval(_schedulerInterval);

  _schedulerInterval = setInterval(() => {
    pullSettingsFromCloud().catch(() => {});
  }, intervalMs);

  if (_schedulerInterval.unref) _schedulerInterval.unref();
}
