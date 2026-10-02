/**
 * probe-sheet-identity.mjs
 *
 * READ-ONLY. Fetches the title and header cells of each candidate spreadsheet so
 * we can tell which sheet is which. No writes, no batchUpdate, nothing that can
 * change a cell.
 *
 * Why this exists: the dashboard Worker has no .env, so any code shaped
 * `process.env.CW_SPREADSHEET_ID || '<literal>'` falls through to the literal.
 * That made it possible for the cloud copy and the laptop to read DIFFERENT
 * sheets while both looked perfectly healthy.
 *
 * Note on indexing: the Sheets API trims leading empty cells out of a returned
 * row, so a bare index into values[0] does not equal the spreadsheet column.
 * Every cell below is therefore read at an explicit letter range, and printed
 * as the column letter it actually lives in.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const key = JSON.parse(fs.readFileSync(path.join(ROOT, 'service-account.json'), 'utf8'));

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const sign = (d) => crypto.sign('RSA-SHA256', Buffer.from(d), key.private_key).toString('base64url');

async function token() {
  const now = Math.floor(Date.now() / 1000);
  const h = b64({ alg: 'RS256', typ: 'JWT' });
  const c = b64({
    iss: key.client_email, scope: 'https://www.googleapis.com/auth/spreadsheets.readonly',
    aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600,
  });
  const jwt = `${h}.${c}.${sign(`${h}.${c}`)}`;
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt }),
  });
  const j = await r.json();
  if (!j.access_token) throw new Error(`token failed: ${JSON.stringify(j).slice(0, 300)}`);
  return j.access_token;
}

const envLines = fs.existsSync(path.join(ROOT, '.env')) ? fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split('\n') : [];
const envVal = (k) => {
  const l = envLines.find((x) => x.startsWith(`${k}=`));
  return l ? l.split('=').slice(1).join('=').trim() : null;
};
const sm = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'sheet-credentials.json'), 'utf8'));

// Read the literal candidates out of src/ rather than pasting them here.
// This file is committed to a public repository, and pasting a live spreadsheet
// id into it would publish that id - the exact leak the suite guards against.
const readLiterals = () => {
  const grab = (file, re) => {
    const raw = fs.readFileSync(path.join(ROOT, 'src', file), 'utf8');
    return re.exec(raw)?.[1] ?? null;
  };
  return {
    config: grab('config.js', /CW_SPREADSHEET_ID',\s*getEnv\('SPREADSHEET_ID',\s*'([A-Za-z0-9_-]{40,60})'\)/),
    dbjs: grab('db.js', /process\.env\.CW_SPREADSHEET_ID\s*\|\|\s*'([A-Za-z0-9_-]{40,60})'/),
  };
};
const LIT = readLiterals();

const CANDIDATES = [
  ['.env  CW_SPREADSHEET_ID (laptop)', envVal('CW_SPREADSHEET_ID')],
  ['sheet-manager  cw-maintenance', sm.find((s) => s.id === 'cw-maintenance')?.spreadsheetId],
  ['src/config.js  default', LIT.config],
  ['src/db.js     hardcoded literal', LIT.dbjs],
];

const LETTERS = 'ABCDEFGHIJKL'.split('');
const t = await token();
console.log('READ-ONLY probe - titles and header cells, no writes');
console.log('cells are read at explicit letter ranges so the column is unambiguous\n');

const seen = new Map();
for (const [label, id] of CANDIDATES) {
  if (!id) { console.log(`${label}\n  (not set)\n`); continue; }
  if (seen.has(id)) { console.log(`${label}\n  SAME SHEET AS: ${seen.get(id)}\n`); continue; }
  try {
    const meta = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${id}`, { headers: { Authorization: `Bearer ${t}` } });
    if (!meta.ok) { console.log(`${label}\n  ${id.slice(0, 12)}... -> HTTP ${meta.status} ${(await meta.text()).slice(0, 140)}\n`); continue; }
    const m = await meta.json();
    seen.set(id, label);

    console.log(label);
    console.log(`  id    ${id}`);
    console.log(`  title ${m.properties?.title}`);
    const tab1 = m.sheets?.[0]?.properties?.title;

    for (const rowNum of [1, 2]) {
      const parts = await Promise.all(LETTERS.map(async (col) => {
        const u = `https://sheets.googleapis.com/v4/spreadsheets/${id}/values/${encodeURIComponent(`'${tab1}'!${col}${rowNum}`)}`;
        const r = await fetch(u, { headers: { Authorization: `Bearer ${t}` } });
        if (!r.ok) return null;
        const v = await r.json();
        const cell = v.values?.[0]?.[0];
        return cell ? `${col}=${String(cell).slice(0, 14)}` : null;
      }));
      const line = parts.filter(Boolean).join('  ');
      console.log(`  row${rowNum} ${line}`);
    }
    console.log('');
  } catch (e) { console.log(`${label}\n  ERROR ${e.message}\n`); }
}

console.log(`distinct sheets among the candidates: ${seen.size}`);
console.log('\nThe Worker has no .env, so it resolves CW_SPREADSHEET_ID from whichever');
console.log('candidate sits in a `|| <literal>` fallback inside src/.');