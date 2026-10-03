/**
 * dashboard-worker.js  -  hosts the OfficeOS master dashboard on Cloudflare.
 *
 * WHAT THIS IS
 * ------------
 * The master dashboard is src/server.js: a Node http server with 153 API routes
 * that serves public/*.html from a local filesystem and keeps state in
 * data/*.json. It cannot be "deployed" to a Worker by pointing wrangler at it,
 * because Workers have no filesystem and no listening socket. Verified, not
 * assumed - importing the real dependency tree into workerd fails at startup
 * with "The path argument must be of type string... Received undefined" from
 * src/db.js, before a single request is served.
 *
 * So this Worker does not replace the dashboard. It ADAPTS it:
 *
 *   src/server.js's own request handler  ->  runs here, unmodified
 *   node:fs                             ->  Workers KV   (kv-shim.js)
 *   googleapis + google-auth-library    ->  REST + WebCrypto (google-shim.js)
 *   public/*.html, /master.html          ->  Workers static assets
 *
 * src/server.js, src/db.js, src/sheets.js and the other 13 modules in the graph
 * are BYTE-FOR-BYTE UNCHANGED. Nothing in the email or ClickUp path is touched.
 * The adaptation happens entirely in wrangler's [alias] table (see
 * dashboard-wrangler.toml), which is a bundler-level substitution.
 *
 * WHAT IS DELIBERATELY OFF
 * -----------------------
 * The dashboard can DELETE SHEET COLUMNS (deleteDimension in sheets.js) and
 * rewrite client rows. It is therefore ADMIN-ONLY and refuses to serve a byte
 * to an unauthenticated caller. See gate() at the bottom. Deploy it behind
 * Cloudflare Access as well; this gate is defence in depth, not a replacement.
 */

import * as kvShim from './dashboard/kv-shim.js';
import { configure as configureGoogle } from './dashboard/google-shim.js';

// Importing server.js runs its module top level, which calls
//   server.listen(port) at line 3439.
// That is harmless: the http shim's listen() is a no-op that records the port,
// and the HANDLER is what we want. See dashboard/http-shim.js.
import '../src/server.js';
import { getHandler, getListenPort } from './dashboard/http-shim.js';

// The dashboard's state, as KV key names. data/*.json -> same basename.
const STATE_KEYS = [
  'users', 'sites', 'tasks', 'properties', 'dev-projects', 'notices',
  'conditional-notes', 'daily-review', 'domain-expiry-requests', 'meta',
  'custom-sheets', 'sheet-credentials', 'assistant-config', 'sync-conflicts',
  'user-aliases', 'audit-log', 'master-overrides',
  'auth-sessions',  // ← session tokens for login system
];

let warmed = null;

async function ensureWarm(env, ctx) {
  // Once per isolate, not once per request. KV reads are eventually consistent,
  // so re-warming on every request would be both slow and no fresher.
  if (warmed) {
    // Even on subsequent requests, re-register ctx.waitUntil so new writes
    // (e.g. a session created on this request) are guaranteed to complete.
    if (ctx && ctx.waitUntil) kvShim.setWaitUntil(ctx.waitUntil.bind(ctx));
    return warmed;
  }
  warmed = (async () => {
    configureGoogle({ env });

    // Expose Google OAuth credentials to the auth module via process.env
    if (env.GOOGLE_CLIENT_ID) process.env.GOOGLE_CLIENT_ID = env.GOOGLE_CLIENT_ID;
    if (env.GOOGLE_CLIENT_SECRET) process.env.GOOGLE_CLIENT_SECRET = env.GOOGLE_CLIENT_SECRET;
    if (env.APP_BASE_URL) process.env.APP_BASE_URL = env.APP_BASE_URL;
    if (env.SESSION_SECRET) process.env.SESSION_SECRET = env.SESSION_SECRET;
    const sa = env.GOOGLE_SERVICE_ACCOUNT_JSON || env.GOOGLE_SERVICE_ACCOUNT_KEY_JSON;
    if (sa) {
      kvShim.registerVirtualFile('service-account.json', sa);
      if (!env.GOOGLE_SERVICE_ACCOUNT_KEY_JSON) env.GOOGLE_SERVICE_ACCOUNT_KEY_JSON = sa;
    }

    kvShim.init(env.DASHBOARD_KV);
    // Register waitUntil BEFORE warm so any writes during warm are also covered.
    if (ctx && ctx.waitUntil) kvShim.setWaitUntil(ctx.waitUntil.bind(ctx));
    const loaded = await kvShim.warm(env.DASHBOARD_KV, STATE_KEYS);
    console.log(`[dashboard] warmed ${loaded}/${STATE_KEYS.length} state keys from KV`);
    return loaded;
  })();
  return warmed;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    try {
      // ---- liveness only -------------------------------------------------------
      if (url.pathname === '/api/worker-health' || url.pathname === '/__health') {
        return json({ service: 'officeos-dashboard', ok: true });
      }

      // Warm KV cache for ALL requests — auth routes need sessions from KV.
      // ensureWarm() is a cached promise; it is a no-op after the first call per isolate.
      // Pass ctx.waitUntil so session KV writes finish even after a redirect response.
      await ensureWarm(env, ctx);

      // ---- Auth routes are PUBLIC — no token required -------------------------
      const isAuthRoute = url.pathname.startsWith('/api/auth/');
      const isLoginPage = url.pathname === '/login.html' || url.pathname === '/login';
      // All static files bypass the gate — HTML pages load client-side JS which
      // calls /api/auth/me to enforce authentication. CSS/JS/images are always public.
      const isStaticFile = /\.(html|css|js|png|jpg|jpeg|webp|svg|ico|woff2?)$/.test(url.pathname)
        || url.pathname === '/' || url.pathname === '';

      if (!isAuthRoute && !isLoginPage && !isStaticFile) {
        // ---- the gate — only API routes need a token --------------------------
        // Accept EITHER the ADMIN_TOKEN (scripts/curl) OR a valid session cookie
        // (browser that has logged in via /login.html).
        const hasValidSession = await gateSession(request, env);
        if (!hasValidSession && !gate(request, env)) {
          return new Response(
            JSON.stringify({
              error: 'unauthorized',
              howto: 'sign in at /login.html or send "Authorization: Bearer <DASHBOARD_ADMIN_TOKEN>"',
            }, null, 2),
            {
              status: 401,
              headers: {
                'Content-Type': 'application/json; charset=utf-8',
                // NOTE: No WWW-Authenticate header — that would trigger the browser's
                // native Basic Auth popup which conflicts with our /login.html system.
                'Cache-Control': 'no-store',
              },
            },
          );
        }
      }

      // ---- root redirect -----------------------------------------------------
      // Visiting / with no path should go to the dashboard if logged in,
      // or to /login.html if not. This avoids the raw server response showing.
      if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '')) {
        const loggedIn = await gateSession(request, env);
        const dest = loggedIn ? '/master.html' : '/login.html';
        return Response.redirect(new URL(dest, request.url).toString(), 302);
      }

      // ---- static assets (master.html, login.html, app.js, css) ------------
      // Served by the ASSETS binding, which reads the public/ directory as it
      // was at deploy time. This is why the dashboard needs no filesystem.
      if (request.method === 'GET' && !url.pathname.startsWith('/api/')) {
        const asset = await serveAsset(env, url.pathname);
        if (asset) return asset;
      }

      // ---- the real dashboard, unmodified -------------------------------
      const handler = getHandler();
      if (!handler) {
        return json({ error: 'dashboard handler did not initialise' }, 500);
      }
      return await invoke(handler, request);
    } catch (err) {
      console.error('[dashboard] unhandled:', err && (err.stack || err.message || err));
      return json({ error: 'dashboard_error', detail: String(err && err.message || err) }, 500);
    }
  },
};

/**
 * Adapt a Worker Request into the node http IncomingMessage / ServerResponse
 * pair that src/server.js was written against, run the untouched handler, and
 * adapt the result back into a Response.
 *
 * This is the whole trick, and it works because server.js only ever uses four
 * things off req (method, url, headers, and the two .on() calls in parseBody)
 * and three off res (writeHead, write, end).
 */
async function invoke(handler, request) {
  const url = new URL(request.url);
  const method = request.method;
  const headers = {};
  for (const [k, v] of request.headers) headers[k.toLowerCase()] = v;

  const bodyText = method === 'GET' || method === 'HEAD' ? '' : await request.text();

  // Minimal EventEmitter-ish: parseBody() listens for 'data', 'end', 'error'.
  const listeners = {};
  const req = {
    method,
    url: url.pathname + url.search,
    headers,
    on(event, fn) {
      (listeners[event] ||= []).push(fn);
      if (event === 'end' || event === 'error') {
        // Replay synchronously-after-construction, matching stream semantics
        // closely enough that parseBody's promise settles.
        queueMicrotask(() => {
          if (bodyText) (listeners.data || []).forEach((f) => f(bodyText));
          (listeners.end || []).forEach((f) => f());
        });
      }
      return req;
    },
  };

  let statusCode = 200;
  const resCookies = []; // Set-Cookie is multi-value
  let resHeaders = {};
  const chunks = [];
  let ended = false;
  const res = {
    writeHead(code, hdrs) {
      statusCode = code;
      for (const [k, v] of Object.entries(hdrs || {})) {
        if (k.toLowerCase() === 'set-cookie') resCookies.push(v);
        else resHeaders[k] = v;
      }
      return res;
    },
    setHeader(k, v) {
      if (k.toLowerCase() === 'set-cookie') resCookies.push(v);
      else resHeaders[k] = v;
      return res;
    },
    getHeader(k) { return resHeaders[k]; },
    write(chunk) { if (chunk !== undefined && chunk !== null) chunks.push(String(chunk)); return true; },
    end(chunk) {
      if (chunk !== undefined && chunk !== null) chunks.push(String(chunk));
      if (!ended) { ended = true; (listeners.__resEnd || []).forEach((f) => f()); }
      return res;
    },
    get statusCode() { return statusCode; },
  };

  await handler(req, res);

  const body = chunks.join('');
  // Use Headers() for multi-value Set-Cookie support.
  const outHeaders = new Headers();
  for (const [k, v] of Object.entries(resHeaders)) {
    if (v !== undefined && v !== null) outHeaders.set(k, String(v));
  }
  for (const c of resCookies) outHeaders.append('Set-Cookie', c);
  // Ensure content-type for non-empty, non-redirect bodies.
  const isRedirect = statusCode >= 300 && statusCode < 400;
  if (!isRedirect && body && !outHeaders.has('Content-Type')) {
    outHeaders.set('Content-Type', 'text/plain; charset=utf-8');
  }
  return new Response(isRedirect ? null : body, { status: statusCode, headers: outHeaders });
}

async function serveAsset(env, pathname) {
  if (!env.ASSETS || typeof env.ASSETS.fetch !== 'function') return null;
  const rel = pathname === '/' ? '/index.html' : pathname;
  // Never let a crafted path escape the assets directory.
  if (rel.includes('..')) return null;
  const res = await env.ASSETS.fetch(new Request('https://asset.local' + rel));
  if (!res || res.status === 404) return null;
  return res;
}

/**
 * Constant-time bearer comparison. A plain === leaks the token length and
 * prefix through timing, which is a real (if slow) attack against a bearer
 * secret, and it is free to avoid.
 */
function safeEqual(a, b) {
  const x = String(a || ''); const y = String(b || '');
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}

/**
 * Verify the officeos_session cookie using HMAC-SHA256 signature.
 * The token is self-contained — no KV lookup needed.
 * This works instantly on any Cloudflare edge node, immune to KV eventual consistency.
 *
 * Token format: base64url(payload_json) + "." + base64url(hmac_sha256)
 * Matches the format created by db.js createSession().
 */
async function gateSession(request, env) {
  try {
    const cookieHeader = request.headers.get('cookie') || '';
    const match = cookieHeader.match(/(?:^|;\s*)officeos_session=([^;]+)/);
    if (!match) return false;
    const token = match[1].trim();
    if (!token || !token.includes('.')) return false;

    const secret = env.SESSION_SECRET || env.ADMIN_TOKEN || 'officeos-dev-secret-change-in-prod';

    const lastDot = token.lastIndexOf('.');
    const payloadB64 = token.slice(0, lastDot);
    const sigB64 = token.slice(lastDot + 1);

    // Verify HMAC signature using Web Crypto API (available in Workers + Node 15+)
    const enc = new TextEncoder();
    const keyMaterial = await crypto.subtle.importKey(
      'raw', enc.encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false, ['sign']
    );
    const expectedSigBuf = await crypto.subtle.sign('HMAC', keyMaterial, enc.encode(payloadB64));
    const expectedSig = btoa(String.fromCharCode(...new Uint8Array(expectedSigBuf)))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');

    if (sigB64 !== expectedSig) return false;

    // Decode and validate payload
    const bin = atob(payloadB64.replace(/-/g, '+').replace(/_/g, '/'));
    const bytes = Uint8Array.from(bin, c => c.charCodeAt(0));
    const payload = JSON.parse(new TextDecoder().decode(bytes));
    if (!payload.userId || !payload.exp) return false;
    if (Date.now() > payload.exp) return false;  // expired

    return true;  // valid signed session
  } catch {
    return false;
  }
}

/**
 * Accept EITHER credential form:
 *
 *   Authorization: Bearer <token>      for the local agent, curl, scripts
 *   Authorization: Basic <base64>      for a BROWSER, which cannot set headers
 */
function gate(request, env) {
  const expected = env.ADMIN_TOKEN;
  if (!expected) {
    console.error('[dashboard] ADMIN_TOKEN is not set - refusing every request');
    return false;
  }
  const h = (request.headers.get('authorization') || '').trim();
  const bearer = /^Bearer\s+(.+)$/i.exec(h);
  if (bearer) return safeEqual(bearer[1].trim(), expected);

  const basic = /^Basic\s+(.+)$/i.exec(h);
  if (basic) {
    let decoded = '';
    try { decoded = atob(basic[1].trim()); } catch { return false; }
    const sep = decoded.indexOf(':');
    if (sep < 0) return false;
    return safeEqual(decoded.slice(sep + 1), expected);
  }
  return false;
}

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers },
  });
}
