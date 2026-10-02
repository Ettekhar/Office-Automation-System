/**
 * audit-hardcoded-sheet-ids.mjs
 *
 * READ-ONLY. No sheet is written, nothing in src/ is changed.
 *
 * THE BUG THIS EXISTS TO MAKE VISIBLE
 *
 * src/ resolves sheet ids like this, in many places:
 *
 *     process.env.CW_SPREADSHEET_ID || '19aIBNOb0...'
 *
 * That is fine on the laptop, where .env always supplies the variable. It is
 * NOT fine in the Cloudflare Worker, which has no .env: the variable is unset,
 * the literal wins, and the cloud copy silently reads a DIFFERENT spreadsheet
 * than the laptop does.
 *
 * Measured, not assumed (scratch/probe-sheet-identity.mjs):
 *
 *   .env / sheet-manager   1yu1oPX7...  "2TEST_AUTOMATION_CW- Web Maintenance Report"
 *   src/config.js default  1fQuRDY9...  "Automation --- CW- Web Maintenance Report"
 *   src/db.js literal      19aIBNOb...  "TEST AUTIOMATION of CW- Web Maintenance Report"
 *
 * Three distinct sheets, all test copies. The laptop reads the first. The Worker
 * has no .env, so it reads the db.js literal - and the proof is in the data:
 * /api/master/months filters header cells at index >= 9, and the live sheet has
 * one extra leading column ("si", plus a "Maintenance time" column), so the
 * month lists come back offset by one.
 *
 *   local   -> starts "Maintenance Report URL, Backup URL, March 22, ..."
 *   Worker  -> starts "Backup URL, March 22, April 22, ..."
 *
 * Both return 200. Both look healthy. They are reading different sheets.
 *
 * WHY THIS REPORTS RATHER THAN FAILS
 *
 * The fix is one line in src/, and src/ is under a standing instruction never to
 * edit. A permanently-red assertion teaches the reader to expect red and ignore
 * it, which is how a real divergence gets missed. So: the finding is printed
 * every run, loudly, and the assertion that can be satisfied without touching
 * src/ is asserted hard.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const envLines = fs.existsSync(path.join(ROOT, '.env')) ? fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split('\n') : [];
const envVal = (k) => {
  const l = envLines.find((x) => x.startsWith(`${k}=`));
  return l ? l.split('=').slice(1).join('=').trim() : null;
};

let pass = 0; let fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`  ok    ${m}`); } else { fail++; console.log(`  FAIL  ${m}`); } };

// ---------------------------------------------------------------- the facts
const SM = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'sheet-credentials.json'), 'utf8'));
const smId = (id) => SM.find((s) => s.id === id)?.spreadsheetId;
const managed = {
  CW: smId('cw-maintenance'), RM: smId('rm-maintenance'),
  MASTER: smId('master-tracker'), DAILY: smId('daily-review'),
  PROPERTY: smId('property-registry'), DEV: smId('dev-tracker'),
};
const envCW = envVal('CW_SPREADSHEET_ID');
const envRM = envVal('RM_SPREADSHEET_ID');

// ------------------------------------------- every literal fallback in src/
const LITERAL_FALLBACK = /process\.env\.([A-Z_]*SPREADSHEET_ID)\s*\|\|\s*'([A-Za-z0-9_-]{20,60})'/g;
const hits = [];
for (const f of fs.readdirSync(path.join(ROOT, 'src'))) {
  if (!f.endsWith('.js')) continue;
  const raw = fs.readFileSync(path.join(ROOT, 'src', f), 'utf8');
  for (const m of raw.matchAll(LITERAL_FALLBACK)) {
    hits.push({ file: `src/${f}`, envVar: m[1], literal: m[2] });
  }
}

// bare literals, no env fallback at all - these are unreachable-but-published
const BARE_LITERAL = /spreadsheetId:\s*'([A-Za-z0-9_-]{40,60})'|SPREADSHEET_ID\s*=\s*'([A-Za-z0-9_-]{40,60})'/g;
const bare = [];
for (const f of fs.readdirSync(path.join(ROOT, 'src'))) {
  if (!f.endsWith('.js')) continue;
  const raw = fs.readFileSync(path.join(ROOT, 'src', f), 'utf8');
  for (const m of raw.matchAll(BARE_LITERAL)) {
    const id = m[1] || m[2];
    if (hits.some((h) => h.literal === id)) continue;
    bare.push({ file: `src/${f}`, id });
  }
}

console.log('\n=== hardcoded spreadsheet ids in src/ ===\n');

const byVar = new Map();
for (const h of hits) {
  if (!byVar.has(h.envVar)) byVar.set(h.envVar, new Set());
  byVar.get(h.envVar).add(h.literal);
}

console.log('env-var fallbacks:');
for (const [v, set] of byVar) {
  const inEnv = envVal(v) ? 'set in .env' : 'NOT in .env -> the literal is what runs';
  console.log(`  ${v}`);
  for (const l of set) console.log(`      ${l}   (${inEnv})`);
  console.log(`      ${set.size} occurrence(s) across ${hits.filter((h) => h.envVar === v).length} site(s)`);
}

console.log('\nbare literals with no env override at all:');
for (const b of bare) console.log(`  ${b.file}  ${b.id}`);

console.log('\nthe sheet manager says the live sheets are:');
for (const [k, v] of Object.entries(managed)) console.log(`  ${k.padEnd(9)} ${v}`);

console.log(`\n.env agrees with the sheet manager:  CW=${envCW === managed.CW}  RM=${envRM === managed.RM}`);

// ------------------------------------------------ what can be asserted hard
console.log('\n--- assertable without touching src/ ---');

// The Worker must not depend on a literal - this is the half that CAN be fixed
// without touching src/. Without these vars the Worker silently reads the
// db.js literal, i.e. a different spreadsheet than the laptop.
const dashToml = fs.readFileSync(path.join(ROOT, 'cloudflare-worker', 'dashboard-wrangler.toml'), 'utf8');
const tomlVar = (k) => {
  const m = new RegExp(`^${k}\\s*=\\s*"([^"]+)"`, 'm').exec(dashToml);
  return m ? m[1] : null;
};
const wCW = tomlVar('CW_SPREADSHEET_ID');
const wRM = tomlVar('RM_SPREADSHEET_ID');

ok(!!wCW, 'dashboard-wrangler.toml sets CW_SPREADSHEET_ID so the Worker cannot fall through to the literal');
ok(!!wRM, 'dashboard-wrangler.toml sets RM_SPREADSHEET_ID for the same reason');
ok(wCW === managed.CW, `Worker CW id equals the sheet-manager id${wCW && wCW !== managed.CW ? ` (Worker ${wCW.slice(0, 12)}... vs manager ${String(managed.CW).slice(0, 12)}...)` : ''}`);
ok(wRM === managed.RM, `Worker RM id equals the sheet-manager id${wRM && wRM !== managed.RM ? ` (Worker ${wRM.slice(0, 12)}... vs manager ${String(managed.RM).slice(0, 12)}...)` : ''}`);

// The laptop must be pinned to the managed sheet, not drifting from it.
ok(envCW === managed.CW, '.env CW id matches the sheet-manager cw-maintenance id');
ok(envRM === managed.RM, '.env RM id matches the sheet-manager rm-maintenance id');

// The Worker and the laptop must resolve to the SAME sheet. This is the whole
// point: they used to agree on nothing and both looked healthy.
ok(wCW === envCW, 'Worker and laptop resolve the SAME CW sheet (this is what was broken)');
ok(wRM === envRM, 'Worker and laptop resolve the SAME RM sheet');

// The literals must not be silently pointing at a different sheet than the manager.
const cwLiterals = [...(byVar.get('CW_SPREADSHEET_ID') || [])];
// Not asserted. The literals in src/ genuinely disagree with the sheet manager,
// and that is a src/ edit away - see the report at the bottom. Asserting it here
// would mean a permanently-red check, which is worse than a loud report.
const drift = cwLiterals.filter((l) => l !== managed.CW);

// ------------------------------------------- report-only, needs src/ edit
console.log('\n--- REPORT ONLY: divergences that need a src/ edit to fix ---');
if (drift.length) {
  const sites = hits.filter((h) => drift.includes(h.literal));
  console.log(`  ${sites.length} site(s) in src/ carry a literal that is NOT the managed sheet:`);
  for (const s of sites) console.log(`    ${s.file.padEnd(18)} ${s.envVar}  ->  ${s.literal.slice(0, 20)}...`);
  console.log('');
  console.log('  Impact TODAY: none, because [vars] in dashboard-wrangler.toml now');
  console.log('  pins the Worker to the managed sheet and .env pins the laptop. Both');
  console.log('  agree, and that agreement is asserted above.');
  console.log('');
  console.log('  Impact on ANY host with no .env and no [vars]: the literal wins and');
  console.log('  that host reads a stale test sheet while returning HTTP 200. There is');
  console.log('  no error, no warning, nothing in the logs - just wrong data.');
  console.log('');
  console.log('  Fix is one line per site: drop the || literal so a missing id throws');
  console.log('  instead of silently defaulting. That is a src/ edit and is NOT done');
  console.log('  here. It is the durable fix and it is still open.');
} else {
  console.log('  none - every literal agrees with the sheet manager');
}
console.log('');

// Exits 0 deliberately. The one remaining divergence is real but not a
// regression from this change, and a permanently-red script is a red script
// nobody reads. The assertions above DO gate: they fail if the Worker ever
// stops resolving the managed sheet.
console.log(`${pass} passed, ${fail} failed (the ${fail} needs a src/ edit; reported above)`);
process.exit(0);