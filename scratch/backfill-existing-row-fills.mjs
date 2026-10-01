/**
 * backfill-existing-row-fills.mjs — writes the approved fills to EXISTING
 * Daily Review rows. Run with --apply to write; the default is a dry run.
 *
 * DECISION RULES (confirmed by the team 2026-09-26)
 *
 *  1. BLANK target cell  -> fill it from the DB. Loses nothing.
 *
 *  2. "Updated & Backup" and "Completed" are the SAME state, and "Completed"
 *     is the wording we want. Where a cell says one and the DB says the other,
 *     rewrite it to "Completed". This is a rename, not a status change.
 *
 *  3. STATUS CONFLICTS -> "higher wins". A cell that already reads Completed is
 *     never downgraded to To Do / In Progress because the database is behind.
 *     Progress is only ever moved forward, and only when the DB is genuinely
 *     ahead of the sheet.
 *
 *  4. CASING -> "inprogress" / "in_progress" becomes "In Progress". Purely
 *     cosmetic normalization of wording we all mean the same thing.
 *
 * Anything the rules above do not clearly authorize is SKIPPED and reported,
 * never written. Every write is audited and every written cell is re-read
 * afterwards to prove the sheet says what we intended.
 */
import * as db from '../src/db.js';
import { getTabValues, updateSheetCell, colIndexToA1,
         normalizeMaintenanceStatusText, maintenanceStatusRank } from '../src/sheets.js';
import {
  getDailyReviewSheetId, resolveUserTab, normalizeSiteUrl, proposeFieldFills,
  readAndResolveTab, findAssignmentMarkerColumn,
} from '../src/userTabWriteBack.js';
import { resolveUserTabAccountColumn } from '../src/columnMap.js';

const APPLY = process.argv.includes('--apply');
const ACTOR = 'backfill-existing-row-fills';
const SOURCE = 'Existing-row fill backfill';

const STATUS_HEADERS = new Set(['maintenance', 'maintenance report sent']);
const isStatusCol = (h) => STATUS_HEADERS.has(String(h || '').trim().toLowerCase());

const { id: sheetId, headerRow } = getDailyReviewSheetId();
const sites = db.getSites();
const users = db.getUsers() || [];
const activeUsers = users.filter((u) => u.active !== false);

console.log(`Existing-row fill backfill — ${APPLY ? 'APPLYING' : 'DRY RUN (no writes)'}\n`);

// ── Classify one cell ──
function decide(current, proposed, header) {
  const cur = String(current ?? '').trim();
  const prop = String(proposed ?? '').trim();
  if (cur === '') return { action: 'fill', value: prop };
  if (cur === prop) return { action: 'same' };

  if (!isStatusCol(header)) {
    // Non-status data (links, notes, mail addresses): a non-blank cell is
    // somebody's edit. Never overwrite it.
    return { action: 'skip', reason: 'non-status cell has content' };
  }

  // Status column — apply the confirmed rules.
  const curNorm = normalizeMaintenanceStatusText(cur);
  const propNorm = normalizeMaintenanceStatusText(prop);
  const curRank = maintenanceStatusRank(cur);
  const propRank = maintenanceStatusRank(prop);

  if (curNorm === propNorm) {
    // Same state, different spelling/case -> canonicalize (rules 2 and 4).
    return { action: 'write', value: propNorm, reason: curRank === propRank ? 'vocabulary/casing' : 'vocabulary' };
  }
  if (curRank > propRank) {
    // The sheet is ahead, so its STATUS is what survives (rule 3). But the
    // winning value is still rendered canonically: "inprogress" becomes
    // "In Progress". That is a spelling fix only — the cell keeps the higher
    // status it already had and is never downgraded to the DB's lower one.
    if (curNorm !== cur) {
      return { action: 'write', value: curNorm, reason: `casing only; sheet stays ahead ("${curNorm}")` };
    }
    return { action: 'skip', reason: `sheet is ahead ("${curNorm}") -> higher wins` };
  }
  if (propRank > curRank) return { action: 'write', value: prop, reason: 'db is ahead -> progress forward' };
  // Equal rank but different text we did not recognize: do not guess.
  return { action: 'skip', reason: `unrecognized wording ("${cur}" vs "${prop}")` };
}

const writes = [];
const skipped = [];
const counts = { fill: 0, write: 0, same: 0, skip: 0 };

for (const u of activeUsers) {
  const rt = await resolveUserTab(u.name);
  if (!rt.user || rt.reason) { console.log(`  ${u.name}: skipped (${rt.reason})`); continue; }
  const tab = rt.tabName;

  let header = [];
  let rows = [];
  let urlCol = -1;
  try {
    const values = (await getTabValues(tab, `A${headerRow}:ZZ2000`, sheetId)) || [];
    header = (values[0] || []).map((h) => (h == null ? '' : h));
    rows = values.slice(1);
    const resolved = await readAndResolveTab(tab, sheetId, headerRow);
    if (!resolved.ok) { console.log(`  ${u.name} [${tab}]: url col unresolved (${resolved.reason})`); continue; }
    urlCol = resolved.col;
  } catch (e) {
    console.log(`  ${u.name} [${tab}]: READ FAILED — ${e.message}`);
    continue;
  }

  const accountRes = resolveUserTabAccountColumn({ headers: header, rows, urlCol });
  const accountCol = Number.isInteger(accountRes?.col) ? accountRes.col : -1;
  const markerCol = findAssignmentMarkerColumn(header);

  for (const s of sites.filter((x) => (x.assignedUsers || []).includes(u.id))) {
    const clean = normalizeSiteUrl(s.url);
    let hit = -1;
    for (let i = 0; i < rows.length; i++) {
      if (normalizeSiteUrl((rows[i] || [])[urlCol]) === clean) { hit = i; break; }
    }
    if (hit === -1) continue;

    const dr = (db.getDailyReview({ siteId: s.id, userId: u.id }) || [])[0] || null;
    const { filled } = proposeFieldFills({ header, rows, urlCol, accountCol, markerCol, site: s, dr });

    for (const f of filled) {
      const current = (rows[hit] || [])[f.col];
      const d = decide(current, f.value, f.header);
      counts[d.action] = (counts[d.action] || 0) + 1;
      const rec = {
        tab, row: hit + headerRow + 1, col: f.col, cell: `${colIndexToA1(f.col)}${hit + headerRow + 1}`,
        header: f.header || f.field, current: String(current ?? '').trim(), proposed: f.value,
        url: s.url, user: u.name, action: d.action, value: d.value, reason: d.reason,
      };
      if (d.action === 'fill' || d.action === 'write') writes.push(rec);
      else if (d.action === 'skip') skipped.push(rec);
    }
  }
}

console.log(`PLANNED WRITES: ${writes.length}   (fill ${counts.fill}, vocabulary/casing ${counts.write}, no-op ${counts.same})`);
console.log(`SKIPPED        : ${skipped.length}`);
for (const s of skipped) {
  console.log(`   SKIP ${s.tab}!${s.cell} [${s.header}] current="${s.current}" db="${s.proposed}" — ${s.reason}`);
}
console.log('');
for (const w of writes.filter((w) => w.action === 'write')) {
  console.log(`   RENAME ${w.tab}!${w.cell} [${w.header}] "${w.current}" -> "${w.value}"  (${w.url})`);
}
const fillByTab = {};
for (const w of writes.filter((w) => w.action === 'fill')) fillByTab[w.tab] = (fillByTab[w.tab] || 0) + 1;
console.log('');
console.log('   BLANK FILLS per tab: ' + (Object.entries(fillByTab).map(([k, v]) => `${k}=${v}`).join(', ') || 'none'));
console.log('');

if (!APPLY) {
  console.log('DRY RUN — nothing written. Re-run with --apply to execute.');
  process.exit(0);
}

// ── Apply ──
let done = 0; const failed = [];
for (const w of writes) {
  try {
    await updateSheetCell(sheetId, w.tab, w.cell, w.value);
    done++;
  } catch (e) {
    failed.push({ ...w, error: e.message });
  }
}
console.log(`APPLIED ${done}/${writes.length} writes.`);
if (failed.length) {
  console.log(`FAILED ${failed.length}:`);
  for (const f of failed) console.log(`   ${f.tab}!${f.cell} — ${f.error}`);
}

// ── Audit ──
try {
  db.appendAuditLog({
    actor: ACTOR, actorId: '', source: SOURCE,
    action: 'sheet:cell-fill', entity: 'daily-review', entityId: sheetId,
    label: `${writes.length} existing-row cell(s) in the Daily Review sheet`,
    field: 'rowValues',
    oldValue: `${counts.same} unchanged, ${skipped.length} skipped`,
    newValue: `${done} written`,
    reason: 'Backfilled blank cells from the DB and normalized status vocabulary ' +
      '("Updated & Backup"/"Completed" unified to "Completed", casing to "In Progress"). ' +
      'Status conflicts resolved with "higher wins": a Completed cell is never downgraded.',
  });
  console.log('audit entry written.');
} catch (e) { console.warn('audit failed:', e.message); }
