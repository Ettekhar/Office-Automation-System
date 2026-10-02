/**
 * verify-dashboard-hosting.mjs
 *
 * Offline verification for hosting the master dashboard on a Cloudflare Worker.
 *
 * WHAT IS WORTH TESTING HERE, AND WHY
 * -----------------------------------
 * src/server.js, src/db.js and src/sheets.js are UNCHANGED - that is the whole
 * design. So there is no new application logic to test. What there IS, in
 * cloudflare-worker/dashboard/, is four shims standing between Node and
 * workerd, and every one of them fails SILENTLY or MISLEADINGLY if it is wrong:
 *
 *   - a missing [alias] entry means the real node:fs loads, and the Worker
 *     dies at startup with an error about a path argument;
 *   - a readFileSync that returns null instead of throwing makes
 *     JSON.parse(null) succeed and the real error surface three frames away;
 *   - a gate that fails open exposes a surface that can DELETE spreadsheet
 *     columns.
 *
 * Those are the failures worth a test. The test that mattered most while
 * building this was the alias-coverage one: it broke three separate times
 * (url/URL, fs/readFile, nodemailer's default export) and each time the error
 * pointed somewhere other than the cause.
 *
 * Run:  node scratch/verify-dashboard-hosting.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DASH = path.join(ROOT, 'cloudflare-worker', 'dashboard');
// Windows absolute paths are not valid ESM specifiers; imports need file:// URLs.
const imp = (abs) => import(pathToFileURL(abs).href);
let pass = 0; const failures = [];

function check(ok, label, detail = '') {
  if (ok) { pass++; return true; }
  failures.push({ label, detail });
  console.log(`  FAIL  ${label}${detail ? `\n        ${detail}` : ''}`);
  return false;
}
const section = (t) => console.log(`\n-- ${t}`);

/**
 * Pull a whole function body out of source by counting braces.
 *
 * A regex like /function gate\(...\)\s*\{[\s\S]*?\n\}/ is wrong the moment the
 * function contains a nested block, because it stops at the first closing brace
 * at column 0 - which is the end of the first `if`, not the end of the function.
 * That silently truncates the code under test into something that either fails
 * to parse or, worse, parses into a weaker function and passes.
 */
function extractFunction(src, signature) {
  const start = src.indexOf(signature);
  if (start < 0) return null;
  const open = src.indexOf('{', start);
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  return null;
}

// ===========================================================================
section('1. the alias table covers EVERY bare import in the dashboard graph');
// ===========================================================================
// This is the test that earns its keep. If src/ ever gains a new bare import
// (say `sharp`), and nobody adds an alias for it, wrangler either bundles the
// real package - which then explodes at runtime - or fails the build. Either
// way the operator finds out from a Cloudflare error, not from a test.

const toml = fs.readFileSync(path.join(ROOT, 'cloudflare-worker', 'dashboard-wrangler.toml'), 'utf8');
// Anchor to a line that is exactly [alias] - the file's own comment block
// contains the literal text "[alias]", and matching that would silently parse
// the prose instead of the table.
const aliasBlock = /^alias\s*$|^\[alias\]$/m.test(toml)
  ? /^\[alias\]\r?\n([\s\S]*)/m.exec(toml)
  : null;
check(!!aliasBlock, 'dashboard-wrangler.toml has an [alias] table');
const aliases = new Map();
for (const line of (aliasBlock ? aliasBlock[1] : '').split('\n')) {
  const m = /^\s*"([^"]+)"\s*=\s*"([^"]+)"/.exec(line);
  if (m) aliases.set(m[1], m[2]);
}
check(aliases.size > 0, `[alias] parsed (${aliases.size} entries)`);

// Rebuild the transitive graph from src/server.js.
const seen = new Set(); const graph = []; const bare = new Set();
(function walk(f) {
  const abs = path.resolve(f);
  if (seen.has(abs)) return;
  seen.add(abs);
  if (!fs.existsSync(abs)) return;
  graph.push(abs);
  const raw = fs.readFileSync(abs, 'utf8');
  for (const m of raw.matchAll(/from\s+'([^']+)'/g)) {
    const t = m[1];
    if (t.startsWith('.')) { let p = path.resolve(path.dirname(abs), t); if (!p.endsWith('.js')) p += '.js'; walk(p); }
    else bare.add(t);
  }
  for (const m of raw.matchAll(/import\s+'([^']+)'/g)) {
    if (!m[1].startsWith('.')) bare.add(m[1]);
  }
})(path.join(ROOT, 'src', 'server.js'));

check(graph.length >= 15, `graph from src/server.js reached ${graph.length} modules (>= 15)`);

// Node builtins that workerd provides natively under nodejs_compat. These do
// NOT need an alias - aliasing them would be wrong.
const NATIVE_OK = new Set(['path', 'crypto', 'buffer', 'util', 'events', 'stream', 'assert', 'querystring', 'zlib', 'string_decoder']);

for (const spec of [...bare].sort()) {
  if (NATIVE_OK.has(spec)) continue;
  const has = aliases.has(spec);
  check(has, `bare import '${spec}' has an alias`, has ? '' : `add "${spec}" = "./dashboard/<shim>.js" to [alias] in dashboard-wrangler.toml`);
}

// Every alias target must exist, and every shim must be inside cloudflare-worker/.
for (const [spec, target] of aliases) {
  const abs = path.resolve(ROOT, 'cloudflare-worker', target);
  check(fs.existsSync(abs), `alias '${spec}' -> ${target} exists`);
  check(abs.startsWith(path.join(ROOT, 'cloudflare-worker')), `alias '${spec}' stays inside cloudflare-worker/`);
}

// ===========================================================================
section('2. src/ and public/ are UNCHANGED (the whole design rests on this)');
// ===========================================================================
// If a future change edits src/server.js to "just fix a Worker issue", the
// adaptation guarantee is gone and the dashboard starts drifting from the
// laptop. Fail loudly instead.
{
  let diff = '';
  try {
    diff = execFileSync('git', ['diff', '--name-only', 'HEAD', '--', 'src/', 'public/'], { cwd: ROOT, encoding: 'utf8' });
  } catch (e) { diff = (e.stdout || '').toString(); }
  const changed = diff.split('\n').map((s) => s.trim()).filter(Boolean);
  check(changed.length === 0, 'no tracked file in src/ or public/ is modified',
    changed.length ? `modified: ${changed.join(', ')}` : '');
}

// The email path specifically must be untouched.
for (const f of ['src/mailer.js', 'src/index.js', 'src/clickup.js', 'src/localMailAgent.js', 'src/db.js', 'src/server.js', 'src/sheets.js']) {
  check(fs.existsSync(path.join(ROOT, f)), `${f} still present and used unmodified`);
}

// ===========================================================================
section('3. kv-shim: synchronous reads, faithful failures');
// ===========================================================================
const kv = await imp(path.join(DASH, 'kv-shim.js'));

const fakeKv = (seed = {}) => {
  const store = { ...seed };
  return {
    store,
    get: async (k) => (k in store ? JSON.parse(store[k]) : null),
    put: async (k, v) => { store[k] = v; },
  };
};

check(typeof kv.readFileSync === 'function', 'readFileSync exists');
check(typeof kv.writeFileSync === 'function', 'writeFileSync exists');
check(typeof kv.readFile === 'function', 'async readFile exists (serveStatic uses it)');

// -- a KV-backed read round-trips, and is SYNCHRONOUS (that is the whole point)
{
  const ns = fakeKv({ sites: JSON.stringify([{ id: '1', url: 'a.test' }]) });
  kv.init(ns);
  await kv.warm(ns, ['sites']);
  const out = kv.readFileSync('/var/data/sites.json');
  check(typeof out === 'string', 'readFileSync returns a STRING synchronously (not a Promise)');
  check(JSON.parse(out)[0].url === 'a.test', 'readFileSync round-trips the KV value');
  check(kv.existsSync('/var/data/sites.json'), 'existsSync true for a warmed key');
}

// -- a write is visible to the very next read, with no await (db.js depends on it)
{
  const ns = fakeKv({});
  kv.init(ns);
  await kv.warm(ns, ['tasks']);
  kv.writeFileSync('/var/data/tasks.json', JSON.stringify([{ id: 't1' }]));
  const immediate = JSON.parse(kv.readFileSync('/var/data/tasks.json'));
  check(immediate.length === 1, 'a write is readable immediately, with no await');
  await new Promise((r) => setTimeout(r, 10));
  check(JSON.parse(ns.store.tasks).length === 1, 'the write also reached KV');
}

// -- a genuinely missing file THROWS, naming the file. This is the bug that
//    produced "cannot read properties of null (reading client_email)".
{
  const ns = fakeKv({});
  kv.init(ns);
  await kv.warm(ns, ['sites']);
  let err = null;
  try { kv.readFileSync('/var/data/nope.json'); } catch (e) { err = e; }
  check(err !== null, 'a missing file throws instead of returning null');
  check(err && err.code === 'ENOENT', 'the throw carries code ENOENT like Node');
  check(err && String(err.message).includes('nope.json'), 'the message names the file that was missing',
    err ? err.message : '');
  check(kv.existsSync('/var/data/nope.json') === false, 'existsSync false for an absent key');
}

// -- db.js's own guard still behaves: existsSync first, so it never throws
{
  const ns = fakeKv({});
  kv.init(ns);
  await kv.warm(ns, ['meta']);
  const guarded = kv.existsSync('/var/data/x.json') ? JSON.parse(kv.readFileSync('/var/data/x.json')) : null;
  check(guarded === null, "db.js's existsSync-guard pattern still yields null for absent data");
}

// -- virtual files: the service account is a secret, not a file
{
  const ns = fakeKv({});
  kv.init(ns);
  kv.registerVirtualFile('service-account.json', '{"client_email":"x@y.iam.gserviceaccount.com"}');
  check(kv.existsSync('./service-account.json') === true, 'a virtual file satisfies existsSync');
  const raw = kv.readFileSync('./service-account.json');
  check(JSON.parse(raw).client_email === 'x@y.iam.gserviceaccount.com',
    'a virtual file is readable by the same path sheets.js already uses');
}

// -- artefacts that must never be written from a Worker
{
  const ns = fakeKv({});
  kv.init(ns);
  await kv.warm(ns, ['rag-index']);
  let threw = null;
  try { kv.writeFileSync('/var/data/rag-index.json', '[]'); } catch (e) { threw = e; }
  check(threw !== null, 'writing rag-index from a Worker is REFUSED');
  check(threw && /locally-built/.test(threw.message), 'the refusal explains why',
    threw ? threw.message : '');
}

// -- the async form used once by serveStatic
{
  const ns = fakeKv({ sites: JSON.stringify([{ id: 's1' }]) });
  kv.init(ns);
  await kv.warm(ns, ['sites']);
  const got = await new Promise((res) => kv.readFile('/var/data/sites.json', 'utf8', (e, d) => res({ e, d })));
  check(got.e === null && typeof got.d === 'string', 'async readFile with a string encoding calls back with a STRING',
    JSON.stringify({ e: String(got.e), type: typeof got.d }));
  const asObj = await new Promise((res) => kv.readFile('/var/data/sites.json', { encoding: 'utf8' }, (e, d) => res({ e, d })));
  check(asObj.e === null && typeof asObj.d === 'string', 'async readFile with an options object also yields a string');
  const missed = await new Promise((res) => kv.readFile('/var/data/ghost.json', 'utf8', (e) => res(e)));
  check(missed && missed.code === 'ENOENT', 'async readFile reports ENOENT rather than throwing');
}

// ===========================================================================
section('4. google-shim: REST URLs and auth, with fetch stubbed');
// ===========================================================================
const gs = await imp(path.join(DASH, 'google-shim.js'));

{
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify({ values: [['a', 'b']] }), { status: 200 });
  };
  try {
    const auth = { getRequestHeaders: async () => ({ Authorization: 'Bearer stub' }) };
    const sh = gs.google.sheets({ auth });

    // values.get - the single most-used call in the whole app
    const got = await sh.spreadsheets.values.get({ spreadsheetId: 'SID', range: "'Tab'!A1:ZZ2000", valueRenderOption: 'FORMATTED_VALUE' });
    check(got.data.values[0][0] === 'a', 'values.get returns the googleapis {data:{values}} envelope');
    check(calls.at(-1).url.includes('/values/'), 'values.get hits the values endpoint');
    check(decodeURIComponent(calls.at(-1).url).includes("'Tab'!A1:ZZ2000"), 'values.get preserves the quoted tab name and range');
    check(calls.at(-1).url.includes('valueRenderOption=FORMATTED_VALUE'), 'values.get forwards valueRenderOption');

    // spreadsheets.get, with the fields/ranges the tab-lookup code relies on
    await sh.spreadsheets.get({ spreadsheetId: 'SID', fields: 'sheets(properties(sheetId,title))' });
    check(calls.at(-1).url.includes('fields=sheets'), 'spreadsheets.get forwards fields');

    // values.update - a WRITE. Method and query must be exact.
    await sh.spreadsheets.values.update({ spreadsheetId: 'SID', range: "'T'!B2", valueInputOption: 'USER_ENTERED', requestBody: { values: [['x']] } });
    check(calls.at(-1).init.method === 'PUT', 'values.update uses PUT');
    check(calls.at(-1).url.includes('valueInputOption=USER_ENTERED'), 'values.update sends valueInputOption');

    // values.append
    await sh.spreadsheets.values.append({ spreadsheetId: 'SID', range: "'T'!A:ZZ", valueInputOption: 'USER_ENTERED', insertDataOption: 'INSERT_ROWS', requestBody: { values: [['y']] } });
    check(calls.at(-1).url.includes(':append'), 'values.append hits the :append endpoint');
    check(calls.at(-1).url.includes('insertDataOption=INSERT_ROWS'), 'values.append sends insertDataOption');

    // batchUpdate - this is the one that DELETES COLUMNS. It must be POST :batchUpdate.
    await sh.spreadsheets.batchUpdate({ spreadsheetId: 'SID', requestBody: { requests: [{ deleteDimension: { range: { sheetId: 0, dimension: 'COLUMNS', startIndex: 5, endIndex: 9 } } }] } });
    check(calls.at(-1).init.method === 'POST', 'batchUpdate uses POST');
    check(calls.at(-1).url.endsWith(':batchUpdate'), 'batchUpdate posts to :batchUpdate');
    const sent = JSON.parse(calls.at(-1).init.body);
    check(Array.isArray(sent.requests) && sent.requests[0].deleteDimension, 'batchUpdate forwards the request list verbatim');

    // values.batchUpdate (the daily-review writer)
    await sh.spreadsheets.values.batchUpdate({ spreadsheetId: 'SID', requestBody: { valueInputOption: 'USER_ENTERED', data: [] } });
    check(calls.at(-1).url.endsWith('/values:batchUpdate'), 'values.batchUpdate hits /values:batchUpdate');

    // an API error must become a useful Error, not a silent empty object
    globalThis.fetch = async () => new Response(JSON.stringify({ error: { message: 'Requested entity was not found.' } }), { status: 404 });
    let err = null;
    try { await sh.spreadsheets.get({ spreadsheetId: 'NOPE' }); } catch (e) { err = e; }
    check(err !== null, 'a 4xx from Google throws');
    check(err && /Requested entity was not found/.test(err.message), "Google's own message survives into the Error",
      err ? err.message : '');
    check(err && err.status === 404, 'the Error carries .status');
  } finally { globalThis.fetch = realFetch; }
}

// -- auth: a real RS256 JWT is built, and its parts are verifiable
{
  const { generateKeyPairSync, createVerify } = await import('node:crypto');
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const sa = JSON.stringify({ client_email: 'dev@example.iam.gserviceaccount.com', private_key: pem });

  let posted = null;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    posted = { url: String(url), body: String(init.body) };
    return new Response(JSON.stringify({ access_token: 'tok-123', expires_in: 3600 }), { status: 200 });
  };
  try {
    gs.configure({ env: { GOOGLE_SERVICE_ACCOUNT_JSON: sa } });
    const tok = await gs.getAccessToken();
    check(tok.access_token === 'tok-123', 'a token is obtained');

    const params = new URLSearchParams(posted.body);
    check(params.get('grant_type') === 'urn:ietf:params:oauth:grant-type:jwt-bearer', 'the JWT bearer grant type is used');
    const assertion = params.get('assertion') || '';
    const [h, c, s] = assertion.split('.');
    check(!!h && !!c && !!s, 'the assertion is a three-part JWT');

    const header = JSON.parse(Buffer.from(h, 'base64url').toString());
    check(header.alg === 'RS256' && header.typ === 'JWT', 'the JWT header declares RS256');

    const claims = JSON.parse(Buffer.from(c, 'base64url').toString());
    check(claims.iss === 'dev@example.iam.gserviceaccount.com', 'the JWT subject is the service account email');
    check(claims.aud === 'https://oauth2.googleapis.com/token', 'the JWT audience is the token endpoint');
    check(/auth\/spreadsheets$/.test(claims.scope.split(' ')[0]),
      'the FIRST scope is full spreadsheets, not readonly - the dashboard writes',
      claims.scope);

    // The signature must actually verify against the declared public key.
    const verifier = createVerify('RSA-SHA256');
    verifier.update(`${h}.${c}`);
    verifier.end();
    const okSig = verifier.verify(publicKey, Buffer.from(s, 'base64url'));
    check(okSig, 'the JWT signature verifies against the service account public key');

    // a token must be cached, not re-minted on every call
    const before = posted.body;
    await gs.getAccessToken();
    check(posted.body === before, 'the access token is cached across calls');
  } finally { globalThis.fetch = realFetch; gs.configure({ env: {} }); }
}

// -- no credential is a loud failure, never a silent anonymous request
{
  gs.configure({ env: {} });
  let err = null;
  try { await gs.getAccessToken(); } catch (e) { err = e; }
  check(err !== null, 'no service account throws');
  check(err && /GOOGLE_SERVICE_ACCOUNT_JSON/.test(err.message), 'the error names the missing secret',
    err ? err.message : '');
}

// ===========================================================================
section('5. http-shim / url-shim / nodemailer-stub');
// ===========================================================================
{
  const http = await imp(path.join(DASH, 'http-shim.js'));
  const marker = async () => {};
  const srv = http.createServer(marker);
  check(http.getHandler() === marker, 'createServer captures the handler');
  check(typeof srv.listen === 'function' && srv.listen(3000) === srv, 'listen() is a no-op that returns the server');
  check(http.getListenPort() === 3000, 'the port server.js asked for is recorded, not bound');
  check(srv.on('error', () => {}) === srv, 'on() exists so startServer()\'s error handling does not crash');
  check(srv.removeAllListeners('error') === srv, 'removeAllListeners() exists (startServer calls it on retry)');
}

{
  const u = await imp(path.join(DASH, 'url-shim.js'));
  let threw = null; let out = null;
  try { out = u.fileURLToPath(undefined); } catch (e) { threw = e; }
  check(threw === null, 'fileURLToPath(undefined) does NOT throw - this killed the runtime at startup',
    threw ? threw.message : '');
  check(typeof out === 'string' && out.startsWith('/'), 'fileURLToPath returns a plausible absolute path', String(out));
  check(u.URL === globalThis.URL, 'URL is re-exported as the real WHATWG class (src/uptime.js imports it)');
}

{
  const nm = await imp(path.join(DASH, 'nodemailer-stub.js'));
  const mod = nm.default || nm;
  let threw = null;
  try { mod.createTransport({}); } catch (e) { threw = e; }
  check(threw !== null, 'createTransport REFUSES - the Worker must never open SMTP');
  check(threw && /local/i.test(threw.message), 'the refusal says SMTP is local and points at the relay',
    threw ? threw.message : '');
  let threw2 = null;
  try { mod.sendMail({}); } catch (e) { threw2 = e; }
  check(threw2 !== null, 'sendMail REFUSES too');
}

// ===========================================================================
section('6. the gate fails CLOSED, and health leaks nothing');
// ===========================================================================
// Read the gate out of the deployed Worker source and exercise the real
// function via a tiny harness, so this tests the shipped logic rather than a
// paraphrase of it.
{
  const src = fs.readFileSync(path.join(ROOT, 'cloudflare-worker', 'dashboard-worker.js'), 'utf8');

  check(/ADMIN_TOKEN is not set - refusing every request/.test(src),
    'an unset ADMIN_TOKEN refuses every request rather than opening the surface');
  check(!/if \(!expected\) return true/.test(src), 'there is no fail-open branch on a missing token');

  const gateSrc = extractFunction(src, 'function gate(request, env)');
  check(!!gateSrc, 'gate() is present and extractable');

  // Recreate the module scope gate() closes over, then run the real body.
  const safeEqual = (a, b) => {
    const x = String(a || ''); const y = String(b || '');
    if (x.length !== y.length) return false;
    let diff = 0;
    for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
    return diff === 0;
  };
  const console_ = { error: () => {} };
  const gate = new Function('safeEqual', 'console', 'atob', `${gateSrc}; return gate;`)(safeEqual, console_, globalThis.atob);

  const req = (auth) => ({ headers: { get: (k) => (k === 'authorization' ? auth : null) } });
  const basic = (user, pass) => `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;

  check(gate(req(null), { ADMIN_TOKEN: 'secret' }) === false, 'no Authorization header -> refused');
  check(gate(req('Bearer wrong'), { ADMIN_TOKEN: 'secret' }) === false, 'wrong token -> refused');
  check(gate(req('bearer secret'), { ADMIN_TOKEN: 'secret' }) === true, 'correct token -> allowed (case-insensitive scheme)');

  // The property that actually matters: NO partial match. A prefix, a
  // superstring, or a token with the right characters in the wrong order must
  // all be refused, or the gate is decorative.
  check(gate(req('Bearer secre'), { ADMIN_TOKEN: 'secret' }) === false, 'a PREFIX of the token is refused');
  check(gate(req('Bearer secretX'), { ADMIN_TOKEN: 'secret' }) === false, 'the token plus a suffix is refused');
  check(gate(req('Bearer sercret'), { ADMIN_TOKEN: 'secret' }) === false, 'a transposition is refused');
  check(gate(req('Bearer '), { ADMIN_TOKEN: 'secret' }) === false, 'an empty bearer value is refused');
  check(gate(req('secret'), { ADMIN_TOKEN: 'secret' }) === false, 'a bare token with no Bearer scheme is refused');
  check(gate(req('Basic secret'), { ADMIN_TOKEN: 'secret' }) === false, 'a different auth scheme is refused');
  check(gate(req('Bearer secret'), {}) === false, 'unset ADMIN_TOKEN -> refused, NOT open');
  check(gate(req('Bearer secret'), { ADMIN_TOKEN: '' }) === false, 'empty ADMIN_TOKEN -> refused');
  check(gate(req('Bearer secret'), { ADMIN_TOKEN: 'other' }) === false, 'a different configured token is refused');

  // -- Basic auth, which is how a BROWSER gets in. A browser cannot set an
  //    Authorization header on a navigation, so without this path the hosted
  //    dashboard is unreachable from a browser at all - verified: it returned
  //    a bare 401 JSON with no way forward.
  check(gate(req(basic('admin', 'secret')), { ADMIN_TOKEN: 'secret' }) === true,
    'Basic auth with the token as the password is ALLOWED (this is the browser path)');
  check(gate(req(basic('anything', 'secret')), { ADMIN_TOKEN: 'secret' }) === true,
    'the Basic username is ignored - one operator, no second thing to get wrong');
  check(gate(req(basic('', 'secret')), { ADMIN_TOKEN: 'secret' }) === true, 'an empty Basic username is fine');
  check(gate(req(basic('admin', 'wrong')), { ADMIN_TOKEN: 'secret' }) === false, 'Basic with a wrong password is refused');
  check(gate(req(basic('admin', 'secre')), { ADMIN_TOKEN: 'secret' }) === false, 'Basic with a PREFIX password is refused');
  check(gate(req(basic('admin', 'secretX')), { ADMIN_TOKEN: 'secret' }) === false, 'Basic with a suffixed password is refused');
  check(gate(req('Basic not-base64!!'), { ADMIN_TOKEN: 'secret' }) === false, 'undecodable Basic is refused, not thrown');
  check(gate(req(`Basic ${Buffer.from('nocolon').toString('base64')}`), { ADMIN_TOKEN: 'secret' }) === false,
    'Basic with no colon separator is refused');
  // RFC 7617 forbids a colon in the username, so such input is malformed. It
  // must be REFUSED, never mis-split into a password that happens to match.
  check(gate(req(basic('a:b', 'b:secret')), { ADMIN_TOKEN: 'b:secret' }) === false,
    'a colon in the username is refused rather than mis-split into a match');
  // a token that itself contains a colon must survive the split
  check(gate(req(basic('admin', 'se:cret')), { ADMIN_TOKEN: 'se:cret' }) === true,
    'a token containing a colon is compared in full');
  check(gate(req(basic('admin', 'se')), { ADMIN_TOKEN: 'se:cret' }) === false,
    'splitting on the first colon does not let a prefix in');
  check(gate(req(basic('admin', 'cret')), { ADMIN_TOKEN: 'se:cret' }) === false,
    'the tail after a colon is not accepted on its own');

  // the 401 must carry WWW-Authenticate, or the browser never prompts
  check(/WWW-Authenticate/.test(src), 'the 401 carries WWW-Authenticate so a browser raises its sign-in dialog');
  check(/Basic realm=/.test(src), 'the challenge names the Basic realm');

  // The public route must not carry configuration, ids or counts.
  const healthSrc = /if \(url\.pathname === '\/api\/worker-health'[\s\S]*?\n {6}\}/.exec(src);
  check(!!healthSrc, 'the public health route is identifiable');
  const health = healthSrc ? healthSrc[0] : '';
  check(!/spreadsheet/i.test(health), 'public health does not mention a spreadsheet id');
  check(!/DASHBOARD_KV|GOOGLE_SERVICE/.test(health), 'public health does not disclose a binding or secret name');
  check(/ok:\s*true/.test(health), 'public health still reports liveness');
}

// ===========================================================================
section('7. nothing secret is committed');
// ===========================================================================
{
  const sa = JSON.parse(fs.readFileSync(path.join(ROOT, 'service-account.json'), 'utf8'));
  // Files this change is responsible for. The Worker, its shims, its config and
  // the harnesses - every one of them new in this commit, so anything sheet-id
  // shaped in here is something I introduced.
  //
  // The harnesses matter most. A test that proves "no sheet id is committed"
  // almost always wants to quote one, and quoting the LIVE one publishes it in a
  // public repository. That is not hypothetical: the first version of
  // mutation-dashboard-hosting.mjs did exactly that.
  const scan = ['cloudflare-worker/dashboard-worker.js', 'cloudflare-worker/dashboard-wrangler.toml',
    ...fs.readdirSync(DASH).map((f) => `cloudflare-worker/dashboard/${f}`),
    'scratch/verify-dashboard-hosting.mjs', 'scratch/mutation-dashboard-hosting.mjs',
    'scratch/classify-routes.mjs', 'scratch/sweep-dashboard-live.mjs',
    'scratch/dryrun-seed-kv.mjs', 'docs/cloudflare-dashboard-hosting.md'];
  // Sheet ids the dashboard config is ALLOWED to name, and where.
//
// The Worker needs CW_SPREADSHEET_ID and RM_SPREADSHEET_ID in [vars]. Without
// them the src/ literals win and the cloud copy silently reads a different
// spreadsheet than the laptop - see scratch/audit-hardcoded-sheet-ids.mjs.
//
// So these ids have to be committed. That is not a weakened check: the ids are
// read from the sheet manager, so the test fails if they ever drift from the
// live configuration, and it is scoped to this one file, so a sheet id appearing
// anywhere else still fails.
const CONFIGURED_SHEET_IDS = (() => {
  const p = path.join(ROOT, 'data', 'sheet-credentials.json');
  if (!fs.existsSync(p)) return new Map();
  const sm = JSON.parse(fs.readFileSync(p, 'utf8'));
  const m = new Map();
  for (const key of ['cw-maintenance', 'rm-maintenance']) {
    const row = sm.find((s) => s.id === key);
    if (row?.spreadsheetId) {
      m.set(row.spreadsheetId, new Set(['cloudflare-worker/dashboard-wrangler.toml']));
    }
  }
  return m;
})();

  let leaks = 0;
  // Detect a Google Sheets id by SHAPE, not by naming any specific one.
  //
  // A denylist of the real ids would have to contain the real ids, and this is
  // a public repository - so the list itself would publish them, which is the
  // exact leak the check exists to prevent. A shape catches every sheet id,
  // including ones nobody remembered to list, and names none of them.
  const SHEET_ID_SHAPE = /["']([A-Za-z0-9_-]{40,60})["']/g;
  // Identifiers that legitimately look like sheet ids, and the ONE file each is
  // allowed to appear in.
  //
  // The file scoping is the whole point. An earlier version allowlisted the fake
  // mutation fixture by value alone, which silently exempts that same string
  // everywhere - including in the wrangler config that mutation D15 injects it
  // into. D15 then survived, i.e. the suite could no longer detect the exact
  // leak it exists to detect. An exemption must be as narrow as the thing it
  // excuses, or it becomes a hole shaped like a safety.
  const ALLOWED_40PLUS = new Map([
    // The KV namespace id: an identifier, not a credential, and it must be
    // committed for the Worker to bind at all.
    ['c44955e25a1c4791a89f3f3783213e12', new Set(['cloudflare-worker/dashboard-wrangler.toml'])],
    // The fake sheet id used as a MUTATION FIXTURE. It has to be sheet-id-shaped
    // or D15/D17 would stop proving anything, and it has to be fake or this
    // public repository would ship the real one. Declared here, permitted only in
    // the two harness files that quote it - never in a config or source file.
    ['ZZfakeZZsheetZZidZZforZZmutationZZtestingZZonlyZZ0000', new Set([
      'scratch/verify-dashboard-hosting.mjs', 'scratch/mutation-dashboard-hosting.mjs',
    ])],
  ]);
  for (const rel of scan) {
    const p = path.join(ROOT, rel);
    if (!fs.existsSync(p)) continue;
    const raw = fs.readFileSync(p, 'utf8');
    if (raw.includes(sa.private_key)) { check(false, `${rel} contains the service account private key`); leaks++; }
    if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(raw)) { check(false, `${rel} contains PEM key material`); leaks++; }
    for (const m of raw.matchAll(SHEET_ID_SHAPE)) {
      if (ALLOWED_40PLUS.get(m[1])?.has(rel)) continue;
      if (CONFIGURED_SHEET_IDS.get(m[1])?.has(rel)) continue;
      // hex digests and base64 keys in this repo are not sheet ids; a sheet id
      // always has at least one letter and is not pure hex.
      if (/^[0-9a-f]+$/.test(m[1])) continue;
      check(false, `${rel} contains a Google-Sheets-shaped id`, `  ${m[1].slice(0, 12)}...`);
      leaks++;
    }
  }
  // The config must name exactly the sheets the sheet manager has, no more.
  // If someone points the Worker at a different sheet, this goes red - which is
  // the drift that made the cloud copy disagree with the laptop.
  const tomlRaw = fs.readFileSync(path.join(ROOT, 'cloudflare-worker', 'dashboard-wrangler.toml'), 'utf8');
  const smRaw = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'sheet-credentials.json'), 'utf8'));
  for (const key of ['cw-maintenance', 'rm-maintenance']) {
    const want = smRaw.find((s) => s.id === key)?.spreadsheetId;
    const varName = key === 'cw-maintenance' ? 'CW_SPREADSHEET_ID' : 'RM_SPREADSHEET_ID';
    const got = new RegExp(`^${varName}\\s*=\\s*"([^"]+)"`, 'm').exec(tomlRaw)?.[1];
    check(got === want,
      `${varName} in dashboard-wrangler.toml equals the sheet-manager ${key} id`,
      got && want && got !== want ? `  config ${String(got).slice(0, 12)}... vs manager ${String(want).slice(0, 12)}...` : '');
  }
  check(leaks === 0, `no unexpected sheet id in any file this change adds (${scan.length} scanned)`);

  // ---- PRE-EXISTING, NOT MINE, NOT FIXABLE HERE ---------------------------
  // Widening the scan past this commit's own files immediately found two live
  // sheet ids in tracked files that predate the dashboard work:
  //
  //   1QqDY9...  src/db.js, data/daily-review.json, docs/database-architecture.md,
  //              scratch/{probe-all-tabs,probe-tab-extents,probe-taion-cols,
  //              verify-importer-parity,verify-writeback}.mjs
  //   1C4jSa...  data/sheet-schema.json, scripts/inspect-sheets.mjs,
  //              scripts/sheet-schema.json, console.txt, scratch/verify-writeback.mjs
  //
  // Both are already in pushed history across 10+ commits, so the repository is
  // public and this cannot be undone by a commit - it would take a history
  // rewrite, which is the operator's decision, not mine.
  //
  // It is reported rather than failed on purpose. `src/db.js` is the one file
  // under a standing instruction never to edit, and `data/*.json` is live client
  // data, so there is no in-scope fix. A failing assertion here would train the
  // reader to expect red and ignore it, which is how a real leak gets missed.
  // What it does mean: this repo should be treated as public, and the sheets
  // behind these ids should be assumed reachable by anyone who has seen it.
  const preexisting = [];
  try {
    const tracked = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      .split('\n').filter(Boolean).filter((f) => !scan.includes(f) && /\.(js|mjs|json|md|txt)$/.test(f));
    for (const rel of tracked) {
      const raw = fs.readFileSync(path.join(ROOT, rel), 'utf8');
      for (const m of raw.matchAll(SHEET_ID_SHAPE)) {
        if (ALLOWED_40PLUS.get(m[1])?.has(rel) || /^[0-9a-f]+$/.test(m[1])) continue;
        preexisting.push(`${rel}  ${m[1].slice(0, 12)}...`);
      }
    }
  } catch { /* git not available; the primary scan above still ran */ }
  const uniq = [...new Set(preexisting)];
  console.log(`\\n   note: ${uniq.length} pre-existing sheet-id exposure(s) in tracked files`);
  for (const u of uniq) console.log(`     ${u}`);
  console.log('   these predate this change and need a history rewrite (operator decision)');

  let tracked = '';
  try {
    tracked = execFileSync('git', ['ls-files', '--error-unmatch', 'service-account.json'],
      { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch { tracked = ''; }
  check(!(tracked || '').trim(), 'service-account.json is not tracked by git');

  const envExample = fs.readFileSync(path.join(ROOT, '.env.example'), 'utf8');
  const dashTokLine = (/^DASHBOARD_ADMIN_TOKEN=(.*)$/m.exec(envExample) || [])[1];
  check(dashTokLine === undefined || dashTokLine.trim() === '',
    '.env.example carries no real dashboard token', dashTokLine ? `found: ${dashTokLine.slice(0, 12)}...` : '');
}

// ===========================================================================
section('8. the Worker actually WIRES the shims together');
// ===========================================================================
// Sections 3-6 test each shim in isolation. That is not the same as proving
// the deployed Worker connects them, and the difference is where every real
// bug in this build lived: a shim that works but is never called, or a gate
// that is defined and never invoked. These are source-level assertions on
// purpose - a wiring fault is not observable by calling the shim directly.
{
  const src = fs.readFileSync(path.join(ROOT, 'cloudflare-worker', 'dashboard-worker.js'), 'utf8');

  // -- the credential must be registered, or there is no service account
  check(/registerVirtualFile\(\s*'service-account\.json'/.test(src),
    'the Worker registers the service account as a virtual file');
  check(/GOOGLE_SERVICE_ACCOUNT_KEY_JSON/.test(src),
    'the Worker also sets the env var config.js keys off, so sheets.js takes its preferred path');

  // -- the gate must use a constant-time compare
  const gateBody = extractFunction(src, 'function gate(request, env)') || '';
  check(gateBody.length > 0, 'gate() body is extracted whole (brace-counted, not regex-truncated)');
  check(/safeEqual\(/.test(gateBody), 'gate() compares the token with safeEqual, not ===');
  check(!/===\s*expected/.test(gateBody), 'gate() contains no plain === against the expected token');
  check(/Basic/.test(gateBody), 'gate() accepts Basic auth so a browser can sign in');

  // -- the gate must be CALLED, and before any dashboard work happens
  check(/if \(!gate\(request, env\)\)/.test(src), 'gate() is actually invoked in the request path');
  const gateAt = src.indexOf('if (!gate(request, env))');
  const warmAt = src.indexOf('await ensureWarm(env)');
  const invokeAt = src.indexOf('return await invoke(handler, request)');
  check(gateAt > -1 && warmAt > gateAt, 'the gate runs BEFORE any state is read from KV');
  check(gateAt > -1 && invokeAt > gateAt, 'the gate runs BEFORE the dashboard handler is reached');
  const healthAt = src.indexOf("url.pathname === '/api/worker-health'");
  check(healthAt > -1 && healthAt < gateAt, 'the public health route is matched BEFORE the gate, so it is reachable without a token');

  // -- the shims must be imported from the dashboard directory
  check(/from '\.\/dashboard\/kv-shim\.js'/.test(src), 'kv-shim is imported by the Worker');
  check(/from '\.\/dashboard\/google-shim\.js'/.test(src), 'google-shim is imported by the Worker');
  check(/getHandler/.test(src), 'the Worker uses the handler the http shim captured');
  check(/env\.ASSETS/.test(src), 'static files come from the ASSETS binding, not node:fs');
}

// ===========================================================================
console.log(`\n${pass}/${pass + failures.length}`);
if (failures.length) {
  console.log(`\n${failures.length} FAILURE(S):`);
  for (const f of failures) console.log(`  x ${f.label}${f.detail ? `\n      ${f.detail}` : ''}`);
  process.exit(1);
}
console.log('dashboard hosting verified offline');
