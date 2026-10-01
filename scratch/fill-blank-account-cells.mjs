/**
 * Fill a BLANK account cell on rows appended before the account-column fix.
 *
 * The two rows backfilled earlier (Sabbir/cogwheelmarketing.com,
 * Taion/thesagaponackny.com) were written with an empty account cell, so they
 * looked different from every other row in those tabs. The account is not a
 * guess: it is read from the site's own DB record (site.account / site.company),
 * the same value every pre-existing row carries.
 *
 * SAFETY: writes ONLY where the cell is currently empty. If a cell already has
 * a value it is left alone and reported — this can never overwrite data.
 *
 * DEFAULT = DRY RUN. Pass --apply to write.
 */
import * as db from '../src/db.js';
import { getTabValues, updateSheetCell, colIndexToA1 } from '../src/sheets.js';
import {
  getDailyReviewSheetId, readAndResolveTab, resolveUserTab, normalizeSiteUrl,
} from '../src/userTabWriteBack.js';
import { resolveUserTabAccountColumn } from '../src/columnMap.js';

const APPLY = process.argv.includes('--apply');
const { id: SHEET_ID, headerRow } = getDailyReviewSheetId();
const TARGETS = [
  { user: 'Sabbir', domain: 'cogwheelmarketing.com' },
  { user: 'Taion', domain: 'thesagaponackny.com' },
];

console.log(`  mode=${APPLY ? 'APPLY' : 'DRY-RUN'}\n`);
let wrote = 0, skipped = 0, failed = 0;

for (const t of TARGETS) {
  const rt = await resolveUserTab(t.user);
  const tab = await readAndResolveTab(rt.tabName, SHEET_ID, headerRow);
  if (!tab.ok) { console.log(`  ${t.user}: tab unreadable (${tab.reason})`); failed++; continue; }

  const site = db.getSites().find((s) => normalizeSiteUrl(s.url) === normalizeSiteUrl(t.domain));
  const account = String(site?.account || site?.company || '').trim();
  const accRes = resolveUserTabAccountColumn({ headers: tab.header, rows: tab.rows, urlCol: tab.col });
  const accCol = Number.isInteger(accRes?.col) ? accRes.col : -1;

  let hit = -1;
  for (let i = tab.rows.length - 1; i >= 0; i--) {
    if (normalizeSiteUrl((tab.rows[i] || [])[tab.col]) === normalizeSiteUrl(t.domain)) { hit = i; break; }
  }

  if (hit === -1) { console.log(`  ${t.user}/${t.domain}: row not found`); failed++; continue; }
  const rowNumber = headerRow + 1 + hit;
  const current = (tab.rows[hit] || [])[accCol];

  if (accCol === -1) { console.log(`  ${t.user}/${t.domain}: tab has no account column — nothing to fill`); skipped++; continue; }
  if (!account) { console.log(`  ${t.user}/${t.domain}: DB has no account value — refusing to invent one`); skipped++; continue; }
  if (String(current ?? '').trim() !== '') {
    console.log(`  ${t.user}/${t.domain}: account cell already "${current}" — left untouched`);
    skipped++; continue;
  }

  const cell = `${colIndexToA1(accCol)}${rowNumber}`;
  if (!APPLY) { console.log(`  ${t.user}/${t.domain}: would write "${account}" to ${cell}`); continue; }

  try {
    await updateSheetCell(SHEET_ID, rt.tabName, cell, account);
    // Read back to prove the write landed and nothing else moved.
    const after = await readAndResolveTab(rt.tabName, SHEET_ID, headerRow);
    const i = after.rows.findIndex((r) => normalizeSiteUrl((r || [])[after.col]) === normalizeSiteUrl(t.domain));
    const nowVal = i === -1 ? '(row gone!)' : (after.rows[i] || [])[accCol];
    const ok = String(nowVal ?? '') === account;
    console.log(`  ${t.user}/${t.domain}: ${cell} = "${nowVal}" ${ok ? '✓' : '✗ MISMATCH'}`);
    ok ? wrote++ : failed++;
  } catch (e) {
    console.log(`  ${t.user}/${t.domain}: write failed — ${e.message}`);
    failed++;
  }
}
console.log(`\n  wrote=${wrote} skipped=${skipped} failed=${failed}`);
if (!APPLY) console.log('  DRY RUN — nothing written. Re-run with --apply.');
process.exit(failed ? 1 : 0);
