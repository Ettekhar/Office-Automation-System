/**
 * google-shim.js  -  a minimal, faithful stand-in for the `googleapis` and
 * `google-auth-library` packages, implemented over the REST API with WebCrypto.
 *
 * WHY
 * ---
 * src/sheets.js does `import { google } from 'googleapis'` and builds a client
 * with a JWT. googleapis is ~25 MB of Node code that cannot run in a Worker.
 * But the dashboard only ever touches SIX sheets methods and one drive method,
 * and every call uses the same `{data: ...}` response envelope. So this shim
 * reproduces exactly that surface and nothing else.
 *
 * Anything not implemented here THROWS. A silent no-op on a method that writes
 * to a client's spreadsheet is the worst possible failure mode, so an
 * unimplemented call has to be impossible to miss.
 *
 * SCOPE - READ THE DIFFERENCE FROM THE MAILER WORKER
 * -------------------------------------------------
 * cloudflare-worker/mailer-worker.js requests
 *     https://www.googleapis.com/auth/spreadsheets.readonly
 * because it only ever reads. The dashboard DELETES COLUMNS and rewrites rows,
 * so it must request the full
 *     https://www.googleapis.com/auth/spreadsheets
 * That is a real widening of what the service-account key can do. It is not a
 * bug and not a shortcut - the dashboard's job is to edit the sheet - but it
 * means this key is strictly more powerful than the mailer's, and the Worker
 * holding it must stay behind auth. See docs/cloudflare-dashboard-hosting.md.
 */

const SHEETS = 'https://sheets.googleapis.com/v4/spreadsheets';
const DRIVE = 'https://www.googleapis.com/drive/v3/files';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const enc = new TextEncoder();

let CONFIG = { serviceAccountJson: '', env: {} };
let cachedToken = null;   // { access_token, expires_at }

export function configure({ serviceAccountJson, env }) {
  CONFIG = { serviceAccountJson: serviceAccountJson || '', env: env || {} };
  cachedToken = null;
}

const b64url = (bytes) => {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

const b64uToBytes = (s) => {
  const pad = s.length % 4 ? '='.repeat(4 - (s.length % 4)) : '';
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

function pemToDer(pem) {
  const body = String(pem)
    .replace(/-----BEGIN [A-Z ]+-----/, '')
    .replace(/-----END [A-Z ]+-----/, '')
    .replace(/\s+/g, '');
  return b64uToBytes(body);
}

async function sign(privateKeyPem, message) {
  const key = await crypto.subtle.importKey(
    'pkcs8', pemToDer(privateKeyPem), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign'],
  );
  return new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, enc.encode(message)));
}

/** A JWT shaped like google-auth-library's: sheets.js only calls authorize(). */
export class JWT {
  constructor(opts) { this.opts = opts || {}; this.credentials = null; }
  async authorize() {
    this.credentials = await getAccessToken();
    return this.credentials;
  }
  async getRequestHeaders() {
    const c = this.credentials || (this.credentials = await getAccessToken());
    return { Authorization: `Bearer ${c.access_token}` };
  }
}

export async function getAccessToken() {
  if (cachedToken && cachedToken.expires_at > Date.now() + 60_000) return cachedToken;

  const raw = CONFIG.serviceAccountJson || CONFIG.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) {
    throw new Error(
      'google-shim: no service account. Set the GOOGLE_SERVICE_ACCOUNT_JSON Worker secret.',
    );
  }
  let key;
  try { key = JSON.parse(raw); } catch {
    throw new Error('google-shim: GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON');
  }
  if (!key.client_email || !key.private_key) {
    throw new Error('google-shim: service account is missing client_email or private_key');
  }

  const scope = [
    'https://www.googleapis.com/auth/spreadsheets',
    'https://www.googleapis.com/auth/drive.readonly',
  ].join(' ');

  const now = Math.floor(Date.now() / 1000);
  const header = b64url(enc.encode(JSON.stringify({ alg: 'RS256', typ: 'JWT' })));
  const claims = b64url(enc.encode(JSON.stringify({
    iss: key.client_email, scope, aud: TOKEN_URL,
    iat: now, exp: now + 3600,
  })));
  const sig = b64url(await sign(key.private_key, `${header}.${claims}`));

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${header}.${claims}.${sig}`,
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`google-shim: token request failed ${res.status}: ${detail.slice(0, 200)}`);
  }
  const tok = await res.json();
  cachedToken = { access_token: tok.access_token, expires_at: Date.now() + (tok.expires_in || 3600) * 1000 };
  return cachedToken;
}

async function apiGet(url, params, auth) {
  const u = new URL(url);
  for (const [k, v] of Object.entries(params || {})) {
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) v.forEach((x) => u.searchParams.append(k, x));
    else u.searchParams.set(k, v);
  }
  const headers = await authHeaders(auth);
  const res = await fetch(u.toString(), { headers });
  if (!res.ok) throw await googleError(res, 'GET', u.toString());
  return res.json();
}

async function apiSend(url, method, body, auth) {
  const headers = await authHeaders(auth);
  headers['Content-Type'] = 'application/json';
  const res = await fetch(url, { method, headers, body: JSON.stringify(body ?? {}) });
  if (!res.ok) throw await googleError(res, method, url);
  const text = await res.text();
  return text ? JSON.parse(text) : {};
}

async function authHeaders(auth) {
  const token = (auth && typeof auth.getRequestHeaders === 'function')
    ? await auth.getRequestHeaders()
    : { Authorization: `Bearer ${(await getAccessToken()).access_token}` };
  return { ...token };
}

async function googleError(res, method, url) {
  const body = await res.text().catch(() => '');
  let detail = body;
  try {
    const j = JSON.parse(body);
    detail = j?.error?.message || JSON.stringify(j?.error || j);
  } catch { /* keep raw */ }
  const err = new Error(`google-shim: ${method} ${url} -> ${res.status}: ${detail}`);
  err.status = res.status;
  err.code = res.status;
  return err;
}

function sheetsFactory(auth) {
  const spreadsheets = {
    async get({ spreadsheetId, fields, ranges, includeGridData }) {
      const data = await apiGet(`${SHEETS}/${encodeURIComponent(spreadsheetId)}`,
        { fields, ranges, includeGridData: includeGridData ? true : undefined }, auth);
      return { data };
    },
    async batchUpdate({ spreadsheetId, requestBody }) {
      const data = await apiSend(`${SHEETS}/${encodeURIComponent(spreadsheetId)}:batchUpdate`,
        'POST', requestBody, auth);
      return { data };
    },
  };

  const values = {
    async get({ spreadsheetId, range, valueRenderOption, dateTimeRenderOption, majorDimension }) {
      const data = await apiGet(
        `${SHEETS}/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}`,
        { valueRenderOption, dateTimeRenderOption, majorDimension }, auth,
      );
      return { data };
    },
    async update({ spreadsheetId, range, valueInputOption, requestBody }) {
      const data = await apiSend(
        `${SHEETS}/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}`
        + `?valueInputOption=${encodeURIComponent(valueInputOption || 'RAW')}`,
        'PUT', requestBody, auth,
      );
      return { data };
    },
    async append({ spreadsheetId, range, valueInputOption, insertDataOption, requestBody }) {
      const data = await apiSend(
        `${SHEETS}/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}:append`
        + `?valueInputOption=${encodeURIComponent(valueInputOption || 'RAW')}`
        + `&insertDataOption=${encodeURIComponent(insertDataOption || 'OVERWRITE')}`
        + `&includeValuesInResponse=false`,
        'POST', requestBody, auth,
      );
      return { data };
    },
    async batchUpdate({ spreadsheetId, requestBody }) {
      const data = await apiSend(
        `${SHEETS}/${encodeURIComponent(spreadsheetId)}/values:batchUpdate`, 'POST', requestBody, auth,
      );
      return { data };
    },
    async clear({ spreadsheetId, range }) {
      const data = await apiSend(
        `${SHEETS}/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}:clear`,
        'POST', {}, auth,
      );
      return { data };
    },
  };

  return { spreadsheets: { ...spreadsheets, values } };
}

function driveFactory(auth) {
  return {
    files: {
      async list(params) { return { data: await apiGet(DRIVE, params, auth) }; },
      async get(params) {
        return { data: await apiGet(`${DRIVE}/${encodeURIComponent(params.fileId)}`,
          { fields: params.fields }, auth) };
      },
      async export({ fileId, mimeType }) {
        const headers = await authHeaders(auth);
        const res = await fetch(
          `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}/export?mimeType=${encodeURIComponent(mimeType)}`,
          { headers },
        );
        if (!res.ok) throw await googleError(res, 'EXPORT', fileId);
        return { data: await res.text() };
      },
    },
  };
}

export const google = {
  sheets: (opts = {}) => sheetsFactory(opts.auth),
  drive: (opts = {}) => driveFactory(opts.auth),
};

export default { google, JWT, configure, getAccessToken };
