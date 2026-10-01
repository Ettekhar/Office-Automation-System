/**
 * kv-shim.js  -  a drop-in replacement for the parts of node:fs that src/db.js
 * uses, backed by a Workers KV namespace instead of local files.
 *
 * WHY THIS EXISTS
 * ---------------
 * The dashboard (src/server.js) is a stateful Node server. It keeps its state in
 * data/*.json, read and written with SYNCHRONOUS fs calls:
 *
 *     dbRead(name)  -> fs.readFileSync(DATA_DIR/name.json)
 *     dbWrite(name) -> fs.writeFileSync(DATA_DIR/name.json, ...)
 *
 * A Worker has no filesystem, and - this is the part that matters - KV is
 * ASYNCHRONOUS. So the naive port of db.js to KV would ripple async/await
 * through 1967 lines and every one of the 153 routes that call it.
 *
 * Instead this shim keeps the SAME SYNCHRONOUS SIGNATURE by serving reads from
 * an in-memory cache that is warmed once per isolate, and turning writes into
 * fire-and-forget KV puts. Callers cannot tell the difference; that is the whole
 * point, because it means src/db.js is used UNMODIFIED.
 *
 * THE TWO REAL TRADEOFFS, STATED PLAINLY
 * ---------------------------------------
 * 1. FIRST WRITE WINS THE RACE. Writes are not awaited. If two requests write the
 *    same key in the same isolate, the LAST one to reach KV.put() wins, which is
 *    the same last-write-wins a JSON file gives you. No change in behaviour.
 *
 * 2. THE CACHE IS PER-ISOLATE AND EVENTUALLY CONSISTENT. Cloudflare runs many
 *    isolates with no shared memory. An isolate warmed 30 seconds ago will not
 *    see a write another isolate made 5 seconds ago. For a superadmin dashboard
 *    that is one human and a handful of tabs, this is fine in practice. It is NOT
 *    fine for concurrent multi-user editing, and this file says so rather than
 *    pretending otherwise.
 *
 * The Google Sheet remains the source of truth (see syncFromSheets.js); this
 * cache is a mirror of it, exactly as data/*.json is on disk today.
 */

// Populated once per isolate by init(). Every read below is a Map lookup, which
// is what keeps dbRead() synchronous.
const cache = new Map();

// Files that exist in the Node version of this app but not in a Worker,
// because here they are Cloudflare SECRETS rather than files on disk. The
// Worker registers them at startup (see dashboard-worker.js). Keyed by
// basename so any path that would have reached the real file resolves.
const virtualFiles = new Map();

let ns = null;
let inited = false;

// Names that are large and/or machine-specific. Reading them is allowed (they
// come from the warm), but they are never WRITTEN from the Worker, because a
// browser upload or a Worker write would corrupt a document that only makes
// sense locally. Attempting it throws rather than silently clobbering.
export const NEVER_WRITE = new Set([
  'rag-index',      // 1.9 MB, rebuilt locally by the RAG indexer
  'assistant-metrics',
]);

export function init(kvNamespace) {
  ns = kvNamespace;
  cache.clear();
  inited = false;
}

/**
 * Make a file that does not exist on disk readable by its basename.
 *
 * The only one this app needs is the Google service account, which is a secret
 * in the Worker and a file on the laptop. Registering it means src/sheets.js
 * and src/server.js keep using the same readFileSync(config.serviceAccountKeyPath)
 * call they always did, and get the same bytes - they just arrive from a
 * Worker secret instead of a file. No call site changes.
 */
export function registerVirtualFile(basename, contents) {
  virtualFiles.set(String(basename).replace(/\\/g, '/').split('/').pop(), contents);
}

export async function warm(kvNamespace, names) {
  ns = kvNamespace;
  const results = await Promise.all(
    names.map(async (n) => {
      const v = await ns.get(n, 'json');
      return [n, v === null ? undefined : v];
    }),
  );
  for (const [n, v] of results) if (v !== undefined) cache.set(n, v);
  inited = true;
  return cache.size;
}

export function isWarm() { return inited; }
export function cachedKeys() { return [...cache.keys()].sort(); }

// ---------------------------------------------------------------- fs surface
// Only the four functions src/db.js actually calls. Anything else is a loud
// error rather than a silent no-op, so a future caller finds out immediately.

export function readFileSync(file) {
  const base = String(file).replace(/\\/g, '/').split('/').pop() || '';

  // 1. a secret standing in for a file (service-account.json)
  if (virtualFiles.has(base)) return virtualFiles.get(base);

  // 2. state from KV
  const name = base.replace(/\.json$/, '');
  if (cache.has(name)) return JSON.stringify(cache.get(name), null, 2);

  // 3. absent.
  //
  // Node THROWS here, and so does this. An earlier version returned null, which
  // was a quiet lie: src/sheets.js does JSON.parse(fs.readFileSync(path)) with
  // no guard, so null parsed to null and the failure surfaced three frames
  // later as "cannot read properties of null (reading 'client_email')" - a
  // message that points at the wrong file entirely. Throwing here names the
  // actual problem. db.js is unaffected because it checks existsSync() first.
  const err = new Error(
    `ENOENT: no such file or directory, open '${file}' `
    + `(kv-shim: '${name}' is not in KV and no virtual file is registered for it)`,
  );
  err.code = 'ENOENT';
  err.path = String(file);
  throw err;
}

export function writeFileSync(file, contents) {
  const name = nameFor(file);
  if (NEVER_WRITE.has(name)) {
    throw new Error(
      `refusing to write '${name}' from the Cloudflare dashboard: it is a ` +
      `locally-built artefact and overwriting it from a Worker would corrupt it`,
    );
  }
  let parsed;
  try { parsed = JSON.parse(contents); } catch { parsed = contents; }
  cache.set(name, parsed);              // synchronous: callers see it at once
  if (!ns) throw new Error('kv-shim: write before init()');
  // Deliberately not awaited. See the header note on writes.
  Promise.resolve(ns.put(name, JSON.stringify(parsed)))
    .catch((e) => console.error(`kv-shim: write of '${name}' failed:`, e?.message || e));
  return undefined;
}

export function existsSync(file) {
  const base = String(file).replace(/\\/g, '/').split('/').pop() || '';
  if (virtualFiles.has(base)) return true;
  return cache.has(base.replace(/\.json$/, ''));
}

/**
 * The async callback form, used once in the whole graph: serveStatic() in
 * src/server.js line 179.
 *
 * In the Worker that branch is unreachable, because dashboard-worker.js serves
 * static files from the ASSETS binding before a request ever reaches the
 * handler. It is implemented anyway so that if it IS reached it fails the way
 * Node would - callback with ENOENT - instead of throwing a TypeError about a
 * missing function, which is the failure this shim originally produced.
 */
export function readFile(file, options, callback) {
  const cb = typeof options === 'function' ? options : callback;
  // Node accepts an encoding as either a string ('utf8') or an options object
  // ({ encoding: 'utf8' }). Both mean "hand me back a string".
  const encoding = typeof options === 'string' ? options
    : (options && typeof options === 'object' ? options.encoding : null);
  let content;
  try { content = readFileSync(file); } catch (e) { queueMicrotask(() => cb(e)); return undefined; }
  if (encoding) {
    queueMicrotask(() => cb(null, content));
  } else {
    const bytes = new TextEncoder();
    queueMicrotask(() => cb(null, bytes.encode(content)));
  }
  return undefined;
}

export function mkdirSync() {
  // Directories are a filesystem concept. There is exactly one logical
  // directory (the namespace), and it exists by virtue of being bound, so this
  // is a correct no-op rather than a stub.
  return undefined;
}

export function nameFor(file) {
  const base = String(file).replace(/\\/g, '/').split('/').pop() || '';
  return base.replace(/\.json$/, '');
}

export default { readFileSync, readFile, writeFileSync, existsSync, mkdirSync, init, warm, isWarm, cachedKeys, registerVirtualFile, NEVER_WRITE };
