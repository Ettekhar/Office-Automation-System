/**
 * apply-row-highlight.mjs — WRITES to the live Daily Review sheet.
 *
 * Explicitly approved 2026-09-26: paint #FCE5CD on the unassigned rows.
 *
 * Three phases, in this order, and each one has to earn the next:
 *
 *   1. SNAPSHOT. Every cell's current background in every row this run could
 *      touch, written to scratch/row-highlight-before.json. A background write is
 *      not undoable by re-running anything, so the prior state is recorded to disk
 *      BEFORE the first write, not reconstructed afterwards.
 *   2. APPLY. syncTabRowHighlights(dryRun: false) per tab.
 *   3. VERIFY. Re-read the cells from the API. "The request was accepted" is not
 *      the same claim as "the fill is there", and the company cell keeping its own
 *      colour is a separate claim that has to be checked, not assumed.
 *
 * If phase 3 finds any row wrong, it says so and names it. It does not re-apply.
 */
import { writeFileSync } from 'fs';
import { listTabMeta, getRangeBackgroundColors, colIndexToA1 } from '../src/sheets.js';
import { getDailyReviewSheetId, syncTabRowHighlights, readAndResolveTab } from '../src/userTabWriteBack.js';
import { UNASSIGNED_ROW_FILL_HEX, planBatchRowHighlight } from '../src/rowHighlight.js';
import { resolveUserTabAccountColumn } from '../src/columnMap.js';

const { id: sheetId, headerRow } = getDailyReviewSheetId();
const WANT = UNASSIGNED_ROW_FILL_HEX.toUpperCase();

console.log(`spreadsheet : ${sheetId}`);
console.log(`fill        : ${WANT}`);
console.log(`mode        : APPLY (writes to the live sheet)\n`);

const tabs = (await listTabMeta(sheetId) || []).map((t) => (typeof t === 'string' ? t : t.title));

// ── Phase 1: plan, then snapshot exactly what those plans will touch ─────────
const plan = [];
for (const tabName of tabs) {
  const dry = await syncTabRowHighlights({ tabName, sheetId, headerRow, dryRun: true });
  if (dry.action === 'error' || dry.action === 'skip') continue;
  const rows = [...(dry.fillRows || []), ...(dry.clearRows || [])];
  if (!rows.length) continue;
  const tab = await readAndResolveTab(tabName, sheetId, headerRow);
  if (!tab.ok) { console.log(`  ${tabName}: unreadable, skipped`); continue; }
  const acc = resolveUserTabAccountColumn({ headers: tab.header, rows: tab.rows, urlCol: tab.col });
  plan.push({
    tabName, rows, fillRows: dry.fillRows || [], clearRows: dry.clearRows || [],
    lastCol: Math.max(0, tab.width - 1),
    accountCol: Number.isInteger(acc.col) ? acc.col : -1,
  });
}

const totalRows = plan.reduce((n, p) => n + p.rows.length, 0);
if (!totalRows) {
  console.log('Nothing to do — every tab already agrees with its marker cells. No writes made.');
  process.exit(0);
}

const snapshot = { takenAt: new Date().toISOString(), fill: WANT, spreadsheetId: sheetId, tabs: [] };
for (const p of plan) {
  const range = `A1:${colIndexToA1(p.lastCol)}${Math.max(...p.rows) + 1}`;
  const before = await getRangeBackgroundColors(sheetId, p.tabName, range);
  snapshot.tabs.push({ tabName: p.tabName, rows: p.rows, lastCol: p.lastCol, accountCol: p.accountCol, before });
}
writeFileSync(
  new URL('./row-highlight-before.json', import.meta.url),
  JSON.stringify(snapshot, null, 2),
);
console.log(`PHASE 1 snapshot -> scratch/row-highlight-before.json`);
console.log(`  ${plan.length} tab(s), ${totalRows} row(s) in scope\n`);

// ── Phase 2: apply ──────────────────────────────────────────────────────────
console.log('PHASE 2 apply');
const applied = [];
for (const p of plan) {
  const r = await syncTabRowHighlights({ tabName: p.tabName, sheetId, headerRow, dryRun: false });
  applied.push({ tabName: p.tabName, action: r.action, rows: p.rows });
  console.log(`  ${p.tabName.padEnd(9)} rows ${p.rows.join(',').padEnd(12)} -> ${r.action}`);
  for (const a of r.applied || []) console.log(`      ${a.mode}: ${a.action}${a.error ? `  ERROR ${a.error}` : ''}`);
}
console.log('');

// ── Phase 3: verify against a fresh read ────────────────────────────────────
console.log('PHASE 3 verify (fresh API read)');
let bad = 0, ok = 0;
for (const p of plan) {
  const range = `A1:${colIndexToA1(p.lastCol)}${Math.max(...p.rows) + 1}`;
  const after = await getRangeBackgroundColors(sheetId, p.tabName, range);

  for (const rn of p.fillRows) {
    // Rebuild the paintable columns exactly as the planner does, so the check
    // cannot pass by being laxer than the write.
    const segs = planBatchRowHighlight({
      sheetId: 0, tabName: p.tabName, rows: [rn], firstCol: 0, lastCol: p.lastCol,
      preserveCols: p.accountCol >= 0 ? [p.accountCol] : [], mode: 'fill',
    }).requests.map((r) => r.repeatCell.range);
    const wrong = [];
    for (const s of segs) {
      for (let c = s.startColumnIndex; c < s.endColumnIndex; c++) {
        if (after[rn]?.[c] !== WANT) wrong.push(`${colIndexToA1(c)}${rn}=${after[rn]?.[c] || 'no-fill'}`);
      }
    }
    if (wrong.length) { bad++; console.log(`  BAD  ${p.tabName}!${rn}  not tinted: ${wrong.join(' ')}`); }
    else { ok++; console.log(`  ok   ${p.tabName}!${rn}  tinted across ${segs.length} range(s)`); }

    // The company cell must be exactly as it was.
    if (p.accountCol >= 0) {
      const was = snapshot.tabs.find((s) => s.tabName === p.tabName).before[rn]?.[p.accountCol];
      const now = after[rn]?.[p.accountCol];
      if (was !== now) { bad++; console.log(`  BAD  ${p.tabName}!${rn}  company cell changed ${was || 'no-fill'} -> ${now || 'no-fill'}`); }
    }
  }
  for (const rn of p.clearRows) {
    const stray = Object.entries(after[rn] || {})
      .filter(([c, hex]) => Number(c) !== p.accountCol && String(hex).toUpperCase() === WANT)
      .map(([c]) => colIndexToA1(Number(c)) + rn);
    if (stray.length) { bad++; console.log(`  BAD  ${p.tabName}!${rn}  tint survived a clear at ${stray.join(' ')}`); }
    else { ok++; console.log(`  ok   ${p.tabName}!${rn}  clear confirmed, no ${WANT} left`); }
  }
}

console.log(`\n${ok} row(s) verified, ${bad} problem(s)`);
if (bad) {
  console.log('The snapshot in scratch/row-highlight-before.json is what the sheet looked like');
  console.log('before this run, so any of the above can be put back from it.');
} else {
  console.log('To undo: re-apply the `before` fills from scratch/row-highlight-before.json.');
}
