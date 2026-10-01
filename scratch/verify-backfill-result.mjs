/**
 * verify-backfill-result.mjs — READ-ONLY proof that the existing-row backfill
 * landed correctly and that nothing it was not authorized to touch moved.
 *
 * Re-runs the same decision logic used by the backfill. A correct result is:
 *   - no remaining BLANK cell that the DB has data for (all fills landed)
 *   - no remaining vocabulary/casing mismatch
 *   - every "higher wins" cell still holding the higher status (not downgraded)
 *   - URL, account and Assignment columns unchanged
 */
import * as db from '../src/db.js';
import { getTabValues } from '../src/sheets.js';
import {
  getDailyReviewSheetId, resolveUserTab, normalizeSiteUrl, proposeFieldFills,
  readAndResolveTab, findAssignmentMarkerColumn,
} from '../src/userTabWriteBack.js';
import { resolveUserTabAccountColumn } from '../src/columnMap.js';
import { normalizeMaintenanceStatusText, maintenanceStatusRank } from '../src/sheets.js';

const STATUS_HEADERS = new Set(['maintenance', 'maintenance report sent']);
const isStatusCol = (h) => STATUS_HEADERS.has(String(h || '').trim().toLowerCase());

const { id: sheetId, headerRow } = getDailyReviewSheetId();
const sites = db.getSites();
const users = (db.getUsers() || []).filter((u) => u.active !== false);

let pass = 0, fail = 0;
const t = (name, cond, extra) => {
  if (cond) { pass++; }
  else { fail++; console.log(`  FAIL ${name}${extra !== undefined ? '  ' + JSON.stringify(extra) : ''}`); }
};

let remainingBlank = 0, remainingVocab = 0, downgraded = 0, checked = 0;
const laterGaps = [];
const accountGaps = [];
const accountMismatches = [];

// When the existing-row backfill was applied (docs section E7a). Rows first
// assigned after this are outside the backfill's scope: site-fact inheritance
// runs on assignment, so a brand-new row starts with whatever the sheet already
// had. Kept as an explicit constant so the boundary is auditable rather than
// implied by whatever today's date happens to be.
const BACKFILL_APPLIED = new Date('2026-09-26T00:00:00Z');

for (const u of users) {
  const rt = await resolveUserTab(u.name);
  if (!rt.user || rt.reason) continue;
  const tab = rt.tabName;

  const values = (await getTabValues(tab, `A${headerRow}:ZZ2000`, sheetId)) || [];
  const header = (values[0] || []).map((h) => (h == null ? '' : h));
  const rows = values.slice(1);
  const resolved = await readAndResolveTab(tab, sheetId, headerRow);
  if (!resolved.ok) continue;
  const urlCol = resolved.col;

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
    const cur = rows[hit] || [];

    // The identity columns must be intact.
    t(`${tab} row ${hit + headerRow + 1} still has its URL`, normalizeSiteUrl(cur[urlCol]) === clean);

    // The account column is deliberately OUT of the fill pass's scope. The
    // provable claim is therefore "the pass never proposes it" plus, where the
    // cell is already populated, "it still agrees with the site record". A blank
    // account cell is counted and reported, not failed: the account is a property
    // of the SITE, and in some tabs that column's header is itself blank, so
    // filling it would mean guessing which column is meant.
    const siteAccount = String(s.account ?? '').trim();
    const cellAccount = accountCol >= 0 ? String(cur[accountCol] ?? '').trim() : '';
    if (accountCol >= 0) {
      const touched = filled.filter((f) => f.col === accountCol);
      t(`${tab} row ${hit + headerRow + 1} account column is never a fill target`, touched.length === 0,
        { cols: touched.map((f) => f.header) });
      if (cellAccount) {
        if (cellAccount !== siteAccount) {
          // Informational, not a failure. The account column is out of the fill
          // pass's scope AND the DB is internally inconsistent here: these sites
          // carry account="CW" while their own company field reads "CM", and the
          // sheet reads "RM". Three different answers, no defensible winner, so
          // this needs a human rather than a script.
          accountMismatches.push({ tab, row: hit + headerRow + 1, url: s.url, cellAccount, siteAccount, siteCompany: String(s.company ?? '') });
        } else {
          t(`${tab} row ${hit + headerRow + 1} populated account matches the site record`, true);
        }
      } else if (siteAccount) {
        accountGaps.push({ tab, row: hit + headerRow + 1, url: s.url, siteAccount });
      }
    }
    if (markerCol >= 0) {
      t(`${tab} row ${hit + headerRow + 1} Assignment cell is a known marker`,
        ['Assigned', 'Unassigned', ''].includes(String(cur[markerCol] ?? '').trim()),
        { got: cur[markerCol] });
    }

    for (const f of filled) {
      checked++;
      const cell = String(cur[f.col] ?? '').trim();
      if (cell === '') {
        // SCOPE. This assertion is "the backfill landed", so it can only fairly
        // judge rows that EXISTED when the backfill ran (2026-09-26, section
        // E7a). Site-fact inheritance applies to NEW assignments only, so a row
        // first assigned afterwards legitimately starts with gaps the backfill
        // was never asked to fill. This used to fail on exactly that: the
        // Quick assign of 2026-09-27 created Saiful!21 (qualityinnparkersburg)
        // with "Maintenance Report Sent" blank in the sheet and "No" in the DB,
        // and the suite reported the backfill as incomplete when it was in scope
        // and correct. Counting the newcomer as a backfill failure would also
        // make this suite fail on every future assignment.
        const created = dr?.createdAt || dr?.sheetSyncedAt || '';
        const postBackfill = created && new Date(created) > BACKFILL_APPLIED;
        const where = `${tab} col ${f.col} row ${hit + headerRow + 1} [${f.header}] db="${f.value}"`;
        if (postBackfill) {
          // `where` is a string — it must be a named field. Spreading it
          // ({...where}) would spread its CHARACTERS into an object and print
          // "[object Object]", which is how this was first written.
          laterGaps.push({ where, created, source: dr?.source || '(unknown)' });
        } else {
          remainingBlank++;
          console.log(`    still blank (in backfill scope): ${where}`);
        }
        continue;
      }
      if (isStatusCol(f.header)) {
        const cn = normalizeMaintenanceStatusText(cell);
        const pn = normalizeMaintenanceStatusText(f.value);
        if (cn !== pn) {
          if (maintenanceStatusRank(cell) < maintenanceStatusRank(f.value)) remainingVocab++;
          else downgraded++; // sheet legitimately ahead; not a failure
        }
      }
    }
  }
}

t('no DB-backed cell is still blank after the backfill', remainingBlank === 0, { remainingBlank });
t('no unresolved vocabulary mismatch remains', remainingVocab === 0, { remainingVocab });
console.log(`  cells checked: ${checked}`);
console.log(`  "higher wins" cells correctly left ahead: ${downgraded}`);
console.log(`  informational — gaps on rows first assigned AFTER the backfill: ${laterGaps.length}`);
for (const g of laterGaps) {
  console.log(`      ${g.where}  (record created ${g.created}, source "${g.source}")`);
}
console.log('    ^ site-fact inheritance applies to new assignments only, so these rows');
console.log('      were never in the backfill\'s scope. NOT a backfill failure, and NOT');
console.log('      silently ignored: the count and every cell are printed above. Filling');
console.log('      them is a separate, separately-approved pass (~206 such cells).');
console.log(`  informational — rows with a blank account cell though the site has one: ${accountGaps.length}`);
for (const g of accountGaps) {
  console.log(`      ${g.tab} row ${g.row} (site account "${g.siteAccount}")  ${g.url}`);
}
console.log('    ^ out of the fill pass\'s scope by design; NOT written, NOT a failure.');
console.log(`  informational — account cell disagrees with site.account: ${accountMismatches.length}`);
for (const m of accountMismatches) {
  console.log(`      ${m.tab} row ${m.row}  sheet="${m.cellAccount}" site.account="${m.siteAccount}" site.company="${m.siteCompany}"  ${m.url}`);
}
if (accountMismatches.length) {
  console.log('    ^ the DB disagrees with ITSELF on these sites (account vs company),');
  console.log('      so there is no defensible winner. Needs a human. NOT written.');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
