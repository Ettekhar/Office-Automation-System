/**
 * Add the "Assignment" marker column to the 8 live Daily Review tabs.
 *
 * DEFAULT = DRY RUN. Pass --apply to actually write.
 *
 * Why this exists: unassign is a SOFT remove (the row and its URL are kept), so
 * the sheet needs somewhere to record that the assignment ended. Without it the
 * unassign path can only flag a conflict and leave the sheet silent.
 *
 * Why not sheets.appendSheetColumn(): that writes at `headers.length`, and the
 * Sheets API trims trailing empty header cells. On a tab whose data extends past
 * its last header that lands on a column that already holds data. Measured live:
 *   Taion col 9 -> "Plugings update option not found", "Ga4 Access needed"
 *   Asif  col 3 -> 18 real booking/reservation URLs (unheadered)
 * ensureAssignmentMarkerColumn() instead targets the first column that is empty
 * across the header AND every data row.
 *
 * The script fingerprints every tab before and after, so any change to a cell
 * other than the single intended header is detected and reported.
 */
import { createHash } from 'node:crypto';
import * as db from '../src/db.js';
import { getTabValues } from '../src/sheets.js';
import { getDailyReviewSheetId, ensureAssignmentMarkerColumn } from '../src/userTabWriteBack.js';

const APPLY = process.argv.includes('--apply');
const TABS = ['Toufiq', 'Sabbir', 'Taion', 'Medul', 'Saiful', 'Tarikul', 'Roeich', 'Asif'];
const { id: SHEET_ID, headerRow } = getDailyReviewSheetId();

const fingerprint = async (tab) => {
  const values = (await getTabValues(tab, `A${headerRow}:ZZ2000`, SHEET_ID)) || [];
  return { hash: createHash('sha256').update(JSON.stringify(values)).digest('hex'), rowCount: values.length };
};

console.log(`Sheet ${SHEET_ID}  headerRow=${headerRow}  mode=${APPLY ? 'APPLY' : 'DRY-RUN'}\n`);

const before = new Map();
const results = [];
for (const tab of TABS) {
  before.set(tab, await fingerprint(tab));
  const r = await ensureAssignmentMarkerColumn({ tabName: tab, sheetId: SHEET_ID, headerRow, dryRun: !APPLY });
  results.push(r);
  const detail = r.action === 'already-present' ? `already at col ${r.col} ("${r.headerName}")`
    : r.action === 'error' ? `ERROR ${r.reason}: ${r.error}`
    : `${r.action} col ${r.col} (${r.cell}) — data occupied through col ${r.lastUsedCol}`;
  console.log(`  ${tab.padEnd(9)} ${r.action.padEnd(16)} ${detail}`);
  if (r.action === 'error') {
    console.log(`\n  ABORTED: ${tab} failed; no audit written. Resolve before retrying.`);
    process.exit(1);
  }
}

if (!APPLY) {
  console.log(`\n  DRY RUN — nothing written. Re-run with --apply to perform these changes.`);
  process.exit(0);
}

// ── verify: exactly the intended header cell changed, nothing else ──
console.log(`\n  === post-write verification ===`);
let bad = 0;
for (const { tabName, col, cell } of results) {
  if (col == null) continue;
  const after = await fingerprint(tabName);
  const prior = before.get(tabName);
  let note;
  if (after.hash === prior.hash) {
    note = 'UNCHANGED (idempotent)';
  } else {
    // Re-read and confirm the only difference is the intended header cell.
    const now = (await getTabValues(tabName, `A${headerRow}:ZZ2000`, SHEET_ID)) || [];
    const headerNow = now[0] || [];
    const expected = headerNow[col];
    note = expected === 'Assignment'
      ? `header[col ${col}] == "Assignment"; rows ${prior.rowCount} -> ${after.rowCount}`
      : `UNEXPECTED value at col ${col}: ${JSON.stringify(expected)}`;
    if (expected !== 'Assignment') bad++;
  }
  console.log(`  ${tabName.padEnd(9)} ${note}`);
}
if (bad) {
  console.log(`\n  ${bad} tab(s) did not land the expected header — investigate before trusting this.`);
  process.exit(1);
}

// ── audit the schema change (meaningful change: who/what/when/old->new/source) ──
for (const r of results) {
  if (r.action !== 'added') continue;
  db.appendAuditLog({
    actor: 'opencode',
    action: 'sheet:schema-add-column',
    entity: 'daily-review-tab',
    entityId: r.tabName,
    label: `Added "Assignment" marker column to Daily Review tab "${r.tabName}" at ${r.cell} so unassign soft-remove is visible in the sheet`,
    field: 'header',
    oldValue: '(empty)',
    newValue: r.headerName,
    source: 'userTabWriteBack.ensureAssignmentMarkerColumn',
    reason: `First column empty across the header and every data row; data occupied through column ${r.lastUsedCol}, so no existing cell was overwritten.`,
  });
}
const added = results.filter((r) => r.action === 'added').length;
const present = results.filter((r) => r.action === 'already-present').length;
console.log(`\n  added=${added} alreadyPresent=${present}  (audited to data/audit-log.json)`);
