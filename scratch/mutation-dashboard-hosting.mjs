/**
 * mutation-dashboard-hosting.mjs
 *
 * Proves verify-dashboard-hosting.mjs can actually go red. A green suite that
 * would stay green under sabotage is worse than no suite, because it is
 * reported as safety.
 *
 * Each mutation breaks ONE load-bearing thing and runs the real suite. The
 * suite must FAIL. Afterwards the target file is restored and its SHA256 is
 * re-checked, so a partially-restored file cannot quietly poison later runs.
 *
 * Run:  node scratch/mutation-dashboard-hosting.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SUITE = path.join(ROOT, 'scratch', 'verify-dashboard-hosting.mjs');

const sha = (p) => createHash('sha256').update(fs.readFileSync(p)).digest('hex');

// Read the ids under test from the live config rather than pasting them in.
//
// Two reasons. Pasting means the test has to be edited every time a sheet
// changes, and until someone remembers, it quietly stops testing the real thing.
// And pasting writes a live spreadsheet id into a file committed to a public
// repository - which is precisely the leak this suite exists to prevent, so the
// earlier version of D23 tripped its own detector.
const TOML = fs.readFileSync(path.join(ROOT, 'cloudflare-worker', 'dashboard-wrangler.toml'), 'utf8');
const tomlLine = (k) => {
  const m = new RegExp(`^${k}\\s*=\\s*"[^"]+"`, 'm').exec(TOML);
  if (!m) throw new Error(`dashboard-wrangler.toml has no ${k} - D23/D24 cannot anchor`);
  return m[0];
};
// A DIFFERENT real sheet: the stale literal that src/db.js falls back to. Also
// read from src/ so this stays true if that fallback is ever corrected.
const STALE_CW_SHEET = (/process\.env\.CW_SPREADSHEET_ID\s*\|\|\s*'([A-Za-z0-9_-]{20,60})'/
  .exec(fs.readFileSync(path.join(ROOT, 'src', 'db.js'), 'utf8')) || [])[1];
if (!STALE_CW_SHEET) throw new Error('src/db.js no longer has a CW_SPREADSHEET_ID literal fallback');

const MUTATIONS = [
  {
    id: 'D1',
    name: 'the gate fails OPEN when ADMIN_TOKEN is unset',
    file: 'cloudflare-worker/dashboard-worker.js',
    from: '    console.error(\'[dashboard] ADMIN_TOKEN is not set - refusing every request\');\n    return false;',
    to: '    return true;',
    why: 'A missing token must never mean "open". This surface can delete columns from client spreadsheets.',
  },
  {
    id: 'D2',
    name: 'the gate accepts a PREFIX of the real token',
    file: 'cloudflare-worker/dashboard-worker.js',
    from: '  if (bearer) return safeEqual(bearer[1].trim(), expected);',
    to: '  if (bearer) return expected.startsWith(bearer[1].trim());',
    why: 'A prefix check means knowing the first 4 characters of the token is enough to get in.',
  },
  {
    id: 'D3',
    name: 'the gate uses === instead of a constant-time compare',
    file: 'cloudflare-worker/dashboard-worker.js',
    from: '  if (bearer) return safeEqual(bearer[1].trim(), expected);',
    to: '  if (bearer) return bearer[1].trim() === expected;',
    why: 'Not exploitable in one request, but it leaks token length and prefix through timing.',
  },
  {
    id: 'D4',
    name: 'readFileSync returns null for a missing file instead of throwing',
    file: 'cloudflare-worker/dashboard/kv-shim.js',
    from: "  const err = new Error(\n    `ENOENT: no such file or directory, open '${file}' `",
    to: "  if (1) return null;\n  const err = new Error(\n    `ENOENT: no such file or directory, open '${file}' `",
    why: 'This is the bug that shipped first: JSON.parse(null) succeeds, so the real error surfaced three frames away as "cannot read properties of null".',
  },
  {
    id: 'D5',
    name: 'a write is no longer visible to the next read (async-only)',
    file: 'cloudflare-worker/dashboard/kv-shim.js',
    from: '  cache.set(name, parsed);              // synchronous: callers see it at once',
    to: '  // cache.set removed: pretend the write is KV-only',
    why: 'db.js is synchronous. If the cache is not updated inline, every write-then-read returns stale data.',
  },
  {
    id: 'D6',
    name: 'the Worker is allowed to overwrite the locally-built rag-index',
    file: 'cloudflare-worker/dashboard/kv-shim.js',
    from: "export const NEVER_WRITE = new Set([\n  'rag-index',      // 1.9 MB, rebuilt locally by the RAG indexer\n  'assistant-metrics',\n]);",
    to: 'export const NEVER_WRITE = new Set([]);',
    why: 'rag-index.json is a 1.9 MB local artefact. A Worker write would corrupt it with no way back.',
  },
  {
    id: 'D7',
    name: 'the service-account virtual file is never registered',
    file: 'cloudflare-worker/dashboard-worker.js',
    from: "      kvShim.registerVirtualFile('service-account.json', sa);",
    to: "      // registration removed",
    why: 'src/sheets.js reads config.serviceAccountKeyPath off disk. Without the virtual file there is no credential in the Worker.',
  },
  {
    id: 'D8',
    name: 'batchUpdate drops the request list (a silent no-op write)',
    file: 'cloudflare-worker/dashboard/google-shim.js',
    from: "      const data = await apiSend(`${SHEETS}/${encodeURIComponent(spreadsheetId)}:batchUpdate`,\n        'POST', requestBody, auth);",
    to: "      const data = await apiSend(`${SHEETS}/${encodeURIComponent(spreadsheetId)}:batchUpdate`,\n        'POST', { requestBody: {} }, auth);",
    why: 'This is the call that deletes sheet columns. Losing requestBody means the API succeeds and changes nothing.',
  },
  {
    id: 'D9',
    name: 'values.update uses POST instead of PUT',
    file: 'cloudflare-worker/dashboard/google-shim.js',
    from: "        + `?valueInputOption=${encodeURIComponent(valueInputOption || 'RAW')}`,\n        'PUT', requestBody, auth,",
    to: "        + `?valueInputOption=${encodeURIComponent(valueInputOption || 'RAW')}`,\n        'POST', requestBody, auth,",
    why: 'The Sheets API requires PUT for update. The wrong verb either 404s or writes somewhere else.',
  },
  {
    id: 'D10',
    name: 'the Google shim downgrades to a readonly scope',
    file: 'cloudflare-worker/dashboard/google-shim.js',
    from: "    'https://www.googleapis.com/auth/spreadsheets',",
    to: "    'https://www.googleapis.com/auth/spreadsheets.readonly',",
    why: 'The dashboard writes. A readonly token would make every save fail at Google, far from the cause.',
  },
  {
    id: 'D11',
    name: 'the http shim stops capturing the handler',
    file: 'cloudflare-worker/dashboard/http-shim.js',
    from: '  capturedHandler = handler;',
    to: '  capturedHandler = null;',
    why: 'Without the capture there is no request handler and the dashboard cannot serve anything.',
  },
  {
    id: 'D12',
    name: 'the http shim really opens a socket (listen is not a no-op)',
    file: 'cloudflare-worker/dashboard/http-shim.js',
    from: '      capturedPort = port;\n      if (typeof cb === \'function\') cb();\n      return server;',
    to: '      throw new Error(\'EADDRINUSE\');',
    why: 'Workers have no listening socket. This must never run; the no-op is what makes importing server.js safe.',
  },
  {
    id: 'D13',
    name: 'url-shim re-throws on import.meta.url (the original startup crash)',
    file: 'cloudflare-worker/dashboard/url-shim.js',
    from: 'export function fileURLToPath(u) {',
    to: "export function fileURLToPath(u) {\n  return nodeFileURLToPath(u);",
    why: 'Under workerd import.meta.url is not a file: URL. This exact line killed the runtime at startup, before any request.',
  },
  {
    id: 'D14',
    name: 'the nodemailer stub silently succeeds instead of refusing',
    file: 'cloudflare-worker/dashboard/nodemailer-stub.js',
    from: 'export const createTransport = refuse(\'open an SMTP transport\');',
    to: 'export const createTransport = () => ({ sendMail: (o, cb) => cb && cb(null, { accepted: [o.to] }) });',
    why: 'SMTP is local by design. A silent success here would report mail as sent that was never delivered to a client.',
  },
  {
    id: 'D15',
    name: 'a live spreadsheet id is committed to the wrangler config',
    file: 'cloudflare-worker/dashboard-wrangler.toml',
    from: 'id = "c44955e25a1c4791a89f3f3783213e12"',
    to: 'id = "c44955e25a1c4791a89f3f3783213e12"\ncw_spreadsheet_id = "ZZfakeZZsheetZZidZZforZZmutationZZtestingZZonlyZZ0000"',
    why: 'Sheet ids are not credentials, but the public repo should not carry the live ones - that was the whole point of the earlier secrets fix.',
  },
  {
    id: 'D16',
    name: 'an alias is removed so the real node:fs loads in the Worker',
    file: 'cloudflare-worker/dashboard-wrangler.toml',
    from: '"node:fs" = "./dashboard/kv-shim.js"\n"fs" = "./dashboard/kv-shim.js"',
    to: '"node:fs" = "./dashboard/kv-shim.js"',
    why: 'src/db.js imports the bare "fs". Dropping that alias loads real node:fs and the runtime dies at startup.',
  },
  {
    id: 'D17',
    name: 'public health starts reporting configuration',
    file: 'cloudflare-worker/dashboard-worker.js',
    from: "        return json({ service: 'officeos-dashboard', ok: true });",
    to: "        return json({ service: 'officeos-dashboard', ok: true, spreadsheetId: 'ZZfakeZZsheetZZidZZforZZmutationZZtestingZZonlyZZ0000', kv: String(env.DASHBOARD_KV) });",
    why: 'That route is unauthenticated and the URL is not a secret, so anything on it is published. This is the same class of leak as the mailer health route.',
  },
  {
    id: 'D18',
    name: 'Basic auth is dropped, so a browser can never sign in',
    file: 'cloudflare-worker/dashboard-worker.js',
    from: "  const basic = /^Basic\\s+(.+)$/i.exec(h);",
    to: "  const basic = null;",
    why: 'A browser cannot set an Authorization header on a navigation. Without this path the hosted dashboard is a 401 with no way forward - which is exactly how it shipped.',
  },
  {
    id: 'D19',
    name: 'Basic auth accepts any non-empty password',
    file: 'cloudflare-worker/dashboard-worker.js',
    from: '    return safeEqual(decoded.slice(sep + 1), expected);',
    to: '    return decoded.slice(sep + 1).length > 0;',
    why: 'A browser signs in with this path, so a non-comparing check here is a full bypass of the only credential a browser can present.',
  },
  {
    id: 'D20',
    name: 'Basic auth splits the password on the LAST colon',
    file: 'cloudflare-worker/dashboard-worker.js',
    from: '    const sep = decoded.indexOf(\':\');',
    to: '    const sep = decoded.lastIndexOf(\':\');',
    why: 'A token containing a colon would be truncated to its tail, and any string ending in that tail would authenticate.',
  },
  {
    id: 'D21',
    name: 'the 401 drops WWW-Authenticate, so no browser prompt appears',
    file: 'cloudflare-worker/dashboard-worker.js',
    from: "              'WWW-Authenticate': 'Basic realm=\"OfficeOS Master Dashboard\", charset=\"UTF-8\"',",
    to: "              'X-Note': 'challenge removed',",
    why: 'Without the challenge header the browser shows a bare error page and the operator has no way to sign in.',
  },
  {
    id: 'D23',
    name: 'the Worker is pointed at a different sheet than the laptop',
    file: 'cloudflare-worker/dashboard-wrangler.toml',
    // Built at load time from the sheet manager rather than pasted in. A test
    // that hardcodes the id it is checking has to be updated whenever the sheet
    // changes, and until someone remembers, it silently stops testing anything.
    from: tomlLine('CW_SPREADSHEET_ID'),
    to: `CW_SPREADSHEET_ID = "${STALE_CW_SHEET}"`,
    why: 'The cloud copy would read a different spreadsheet than the laptop, and both would answer HTTP 200. Nothing else in the system would notice - which is exactly how this shipped.',
  },
  {
    id: 'D24',
    name: 'the Worker stops setting the sheet id and falls through to the src/ literal',
    file: 'cloudflare-worker/dashboard-wrangler.toml',
    from: `[vars]\n${tomlLine('CW_SPREADSHEET_ID')}\n${tomlLine('RM_SPREADSHEET_ID')}`,
    to: '[vars]',
    why: 'Without these the Worker has no .env, so `process.env.CW_SPREADSHEET_ID || <literal>` resolves to the stale test sheet in src/db.js. Silent, and wrong.',
  },
  {
    id: 'D22',
    name: 'undecodable Basic credentials throw instead of being refused',
    file: 'cloudflare-worker/dashboard-worker.js',
    from: '    try { decoded = atob(basic[1].trim()); } catch { return false; }',
    to: '    decoded = atob(basic[1].trim());',
    why: 'A malformed header from a crawler would produce a 500 instead of a clean 401, and could leak a stack trace.',
  },
];

console.log(`mutating verify-dashboard-hosting.mjs (${MUTATIONS.length} mutations)\n`);

const before = sha(SUITE);
let caught = 0; const missed = []; const brokenAnchors = [];

for (const m of MUTATIONS) {
  const target = path.join(ROOT, m.file);
  if (!fs.existsSync(target)) { brokenAnchors.push(`${m.id}  ${m.file} does not exist`); continue; }
  const original = fs.readFileSync(target, 'utf8');
  const originalSha = sha(target);

  const occurrences = original.split(m.from).length - 1;
  if (occurrences !== 1) {
    brokenAnchors.push(`${m.id}  anchor matched ${occurrences}x in ${m.file} (need exactly 1)`);
    fs.writeFileSync(target, original);
    continue;
  }

  fs.writeFileSync(target, original.replace(m.from, m.to));
  let failed = false; let tally = '';
  try {
    const out = execFileSync(process.execPath, [SUITE], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 300000 });
    tally = (out.match(/(\d+)\/(\d+)\s*$/) || [])[0] || '';
  } catch (e) {
    failed = true;
    const out = `${e.stdout || ''}${e.stderr || ''}`;
    tally = (out.match(/(\d+)\/(\d+)/g) || []).pop() || 'crashed';
  }

  fs.writeFileSync(target, original);
  const restored = sha(target) === originalSha;
  if (!restored) brokenAnchors.push(`${m.id}  RESTORE FAILED for ${m.file}`);

  if (failed) { caught++; console.log(`  ok  ${m.id}  caught  ${m.name}`); }
  else { missed.push(m); console.log(`  XX  ${m.id}  SURVIVED ${m.name}  (suite still ${tally || 'green'})`); }
}

const suiteSha = sha(SUITE);
console.log('');
if (suiteSha !== before) brokenAnchors.push('the suite file itself changed during mutation');

for (const b of brokenAnchors) console.log(`  !  ${b}`);
for (const m of missed) {
  console.log(`\n  ${m.id} SURVIVED - ${m.name}`);
  console.log(`      ${m.why}`);
  console.log(`      the suite does not test this. That is a gap, not a pass.`);
}

const total = caught + missed.length;
console.log(`\n${caught}/${total} mutations caught`);
if (missed.length || brokenAnchors.length) process.exit(1);
console.log('every mutation caught; all targets restored');
