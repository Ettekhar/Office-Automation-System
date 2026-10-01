/**
 * url-shim.js  -  stands in for node:url for the one function the dashboard
 * actually calls: fileURLToPath(import.meta.url).
 *
 * WHY THIS IS NEEDED
 * ------------------
 * src/server.js line 22 and src/db.js both do:
 *     const __filename = fileURLToPath(import.meta.url);
 *
 * Under workerd, import.meta.url is not a file: URL, and Node's fileURLToPath
 * rejects it outright:
 *     TypeError: The "path" argument must be of type string or an instance of
 *     URL. Received undefined
 * which killed the runtime at STARTUP in testing. This shim returns a stable
 * synthetic path instead.
 *
 * WHAT THE PATH IS FOR, AND WHY IT DOES NOT MATTER HERE
 * -----------------------------------------------------
 * server.js uses __dirname for exactly one thing:
 *     const PUBLIC_DIR = path.resolve(__dirname, '../public');
 * ...and then serves files out of it. In the Worker, static files are served by
 * the ASSETS binding in dashboard-worker.js BEFORE the request reaches the
 * handler, so the Node static branch is unreachable. The value is only ever
 * used for a startsWith() containment check on a path that is never read.
 *
 * It is still returned as a plausible absolute POSIX path rather than a lie
 * like "/", so that if this shim is ever wrong the failure is a 404 on a
 * sensible path rather than something inexplicable.
 */

const FAKE_ROOT = '/opt/officeos/dashboard-worker';

export function fileURLToPath(u) {
  // If a real file: URL ever does arrive, honour it.
  if (typeof u === 'string' && u.startsWith('file://')) {
    try { return decodeURIComponent(new URL(u).pathname); } catch { /* fall through */ }
  }
  return `${FAKE_ROOT}/${(globalThis.__OFFICEOS_ENTRY || 'index.js')}`;
}

export function pathToFileURL(p) {
  return new URL(`file://${String(p).startsWith('/') ? '' : '/'}${p}`);
}

// node:url re-exports the WHATWG URL class, and src/uptime.js does
// `import { URL } from 'url'`. Workers have it as a global, so hand back the
// real thing - substituting a fake here would silently change URL parsing.
export const URL = globalThis.URL;
export const URLSearchParams = globalThis.URLSearchParams;

export default { fileURLToPath, pathToFileURL, URL, URLSearchParams };
