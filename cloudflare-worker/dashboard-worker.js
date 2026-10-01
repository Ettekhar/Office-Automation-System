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
];

let warmed = null;

async function ensureWarm(env) {
  // Once per isolate, not once per request. KV reads are eventually consistent,
  // so re-warming on every request would be both slow and no fresher.
  if (warmed) return warmed;
  warmed = (async () => {
    configureGoogle({ env });

    // The service account is a secret here and a file on the laptop. Register
    // it as a virtual file so src/sheets.js's existing
    //   JSON.parse(fs.readFileSync(config.serviceAccountKeyPath, 'utf8'))
    // resolves to the same bytes it always did, with no call-site change.
    const sa = env.GOOGLE_SERVICE_ACCOUNT_JSON || env.GOOGLE_SERVICE_ACCOUNT_KEY_JSON;
    if (sa) {
      kvShim.registerVirtualFile('service-account.json', sa);
      // config.js sets serviceAccountKeyPath to null when this var is present,
      // which is the path sheets.js prefers. Set both so either route works.
      if (!env.GOOGLE_SERVICE_ACCOUNT_KEY_JSON) env.GOOGLE_SERVICE_ACCOUNT_KEY_JSON = sa;
    }

    kvShim.init(env.DASHBOARD_KV);
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
      // ---- unauthenticated: liveness only -------------------------------
      // Deliberately says nothing about configuration, state, sheet ids or
      // counts. This route is public, so anything on it is published.
      if (url.pathname === '/api/worker-health' || url.pathname === '/__health') {
        return json({ service: 'officeos-dashboard', ok: true });
      }

      // ---- the gate ------------------------------------------------------
      // Everything else needs a token. The dashboard can delete columns from
      // client spreadsheets; it must never be an open URL.
      if (!gate(request, env)) {
        // WWW-Authenticate is what makes a BROWSER work. Without it the
        // visitor just gets a 401 JSON blob and no way in, because a browser
        // cannot attach an Authorization header to a navigation on its own.
        // With it, the browser raises its own sign-in dialog and resends the
        // request as Basic auth, which gate() also accepts. The user never has
        // to paste a token into a header by hand.
        return new Response(
          JSON.stringify({
            error: 'unauthorized',
            howto: 'send "Authorization: Bearer <DASHBOARD_ADMIN_TOKEN>", or sign in with the browser prompt (user is ignored, password is the token)',
          }, null, 2),
          {
            status: 401,
            headers: {
              'Content-Type': 'application/json; charset=utf-8',
              'WWW-Authenticate': 'Basic realm="OfficeOS Master Dashboard", charset="UTF-8"',
              'Cache-Control': 'no-store',
            },
          },
        );
      }

      await ensureWarm(env);

      // ---- static assets (master.html, app.js, css) ---------------------
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
  let resHeaders = {};
  const chunks = [];
  let ended = false;
  const res = {
    writeHead(code, hdrs) { statusCode = code; resHeaders = { ...resHeaders, ...(hdrs || {}) }; return res; },
    setHeader(k, v) { resHeaders[k] = v; return res; },
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
  const outHeaders = { ...resHeaders };
  // Node lowercases nothing; make sure content-type exists for non-empty bodies.
  if (body && !Object.keys(outHeaders).some((k) => k.toLowerCase() === 'content-type')) {
    outHeaders['Content-Type'] = 'text/plain; charset=utf-8';
  }
  return new Response(body, { status: statusCode, headers: outHeaders });
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
 * Accept EITHER credential form:
 *
 *   Authorization: Bearer <token>      for the local agent, curl, scripts
 *   Authorization: Basic <base64>      for a BROWSER, which cannot set headers
 *
 * The Basic username is ignored on purpose - there is exactly one operator, and
 * making them invent a username adds a second thing to get wrong for no
 * security gain. The password is the token, and it is compared the same
 * constant-time way.
 */
function gate(request, env) {
  const expected = env.ADMIN_TOKEN;
  if (!expected) {
    // Refusing is the safe default. An unset token must never mean "open",
    // because this surface can delete client spreadsheet columns.
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
    // everything after the FIRST colon is the password, so a token containing
    // a colon still works
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
