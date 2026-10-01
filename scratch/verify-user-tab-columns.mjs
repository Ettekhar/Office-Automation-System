// READ-ONLY verification of the canonical per-user-tab URL column resolution.
// Proves the two header traps are closed and that the canonical resolver agrees
// with the legacy per-user hardcodes (two independent signals) on all 8 tabs.
import { resolveUserTabUrlColumn, findUrlColumn, looksLikeDomain } from '../src/columnMap.js';
import * as db from '../src/db.js';
import { readAndResolveTab, ensureSiteRowInUserTab, softRemoveSiteRowFromUserTab, getDailyReviewSheetId, normalizeSiteUrl, clearTabTitleCache } from '../src/userTabWriteBack.js';
import * as sheets from '../src/sheets.js';

const TABS = ['Toufiq', 'Sabbir', 'Taion', 'Medul', 'Saiful', 'Tarikul', 'Roeich', 'Asif'];
// Legacy hardcodes from sheets.js batchUpdateDailyReviewTab (the prior behavior).
const LEGACY = { medul: 1, sabbir: 0, taion: 0 };

let pass = 0, fail = 0;
const t = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  ' + JSON.stringify(extra) : '')); }
};

const { id, headerRow } = getDailyReviewSheetId();
console.log('sheet =', id, 'headerRow =', headerRow);

console.log('\n== 1. column resolution: canonical vs legacy vs header-only ==');
console.log('  tab       canon  via                headerOnly  legacy  agree');
const canon = {};
for (const tab of TABS) {
  const r = await readAndResolveTab(tab, id, headerRow);
  if (!r.ok) { t(`${tab} resolves`, false, r); continue; }
  const hdr = (await sheets.getTabValues(tab, `A${headerRow}:ZZ${headerRow}`, id))?.[0] || [];
  const headerOnly = findUrlColumn(hdr);
  const legacy = LEGACY[tab.toLowerCase()] ?? 0;
  canon[tab] = r.col;
  const agree = r.col === legacy;
  console.log(`  ${tab.padEnd(9)} ${String(r.col).padEnd(6)} ${String(r.via).padEnd(17)} ${String(headerOnly).padEnd(11)} ${String(legacy).padEnd(7)} ${agree ? 'YES' : 'NO  <-- MISMATCH'}`);
  t(`${tab} canonical column matches legacy`, agree, { canon: r.col, legacy });
}
t('Taion is NOT the Booking/Reservation Link column (7)', canon.Taion !== 7, canon.Taion);
t('Sabbir is NOT the "Website" account-label column (1)', canon.Sabbir !== 1, canon.Sabbir);
t('Taion uses col 0 (where its domains actually live)', canon.Taion === 0, canon.Taion);
t('Sabbir uses col 0 (where its domains actually live)', canon.Sabbir === 0, canon.Sabbir);
t('Medul uses col 1 (its "Website URL" column)', canon.Medul === 1, canon.Medul);

console.log('\n== 2. looksLikeDomain sanity ==');
t('"CW" is not a domain', !looksLikeDomain('CW'));
t('"To Do" is not a domain', !looksLikeDomain('To Do'));
t('"" is not a domain', !looksLikeDomain(''));
t('null is not a domain', !looksLikeDomain(null));
t('bare domain is a domain', looksLikeDomain('cogwheelmarketing.com'));
t('https URL is a domain', looksLikeDomain('https://www.horizonsmodernkitchen.com/'));
t('prose with a URL is not a domain', !looksLikeDomain('Book at https://resy.com/venues/x or call'));

console.log('\n== 3. idempotency: a real existing row is found, never duplicated ==');
// DERIVE the inactive set from the DB, never hardcode it. This used to assert
// `new Set(['Toufiq','Tarikul','Asif'])` on the comment "Live DB has Toufiq /
// Tarikul / Asif as active:false". Toufiq was reactivated, so the fixture went
// stale and the suite failed for a user the guard was RIGHT to accept. Swapping
// Toufiq for another name would just re-arm the same trap at the next
// reactivation, so the invariant is read from the source of truth instead — and
// asserted non-empty, so this can never silently stop testing the skip path.
const INACTIVE = new Set(
  (db.getUsers() || []).filter((u) => u.active === false).map((u) => String(u.name || '').trim().toLowerCase())
);
console.log('  inactive per DB:', INACTIVE.size ? [...INACTIVE].join(', ') : '(none)');
t('the DB has inactive users, so the skip path is really exercised', INACTIVE.size > 0, [...INACTIVE]);
for (const tab of TABS) {
  const r = await readAndResolveTab(tab, id, headerRow);
  let real = null, realRow = null;
  for (let i = 0; i < r.rows.length; i++) {
    const v = (r.rows[i] || [])[r.col];
    if (looksLikeDomain(v)) { real = v; realRow = headerRow + 1 + i; break; }
  }
  if (!real) { t(`${tab} has a real row to test`, false); continue; }
  const e = await ensureSiteRowInUserTab({ siteUrl: real, userName: tab, dryRun: true });
  if (INACTIVE.has(tab.toLowerCase())) {
    t(`${tab} (deactivated) skips with the precise reason 'inactive-user'`,
      e.action === 'skip' && e.reason === 'inactive-user', { action: e.action, reason: e.reason });
    continue;
  }
  t(`${tab}: existing domain is 'exists' at its own row`, e.action === 'exists' && e.rowNumber === realRow,
    { url: real, action: e.action, reason: e.reason, gotRow: e.rowNumber, wantRow: realRow, col: e.urlCol, via: e.urlColVia });
}

console.log('\n== 4. the reported bug: site absent from assignee tab plans an append ==');
// The real site is checked first: after the write-back backfill it must now be
// PRESENT at its own row (this is the proof the backfill landed).
const absent = await ensureSiteRowInUserTab({ siteUrl: 'cogwheelmarketing.com', userName: 'Sabbir', dryRun: true });
console.log('  Sabbir/cogwheelmarketing.com ->', absent.action, absent.reason || '', 'col=', absent.urlCol, 'via=', absent.urlColVia);
// PRESENCE is the claim, not a particular action string. This asserted
// `action === 'exists'`, which was correct until the marker-restore path was
// added: a row that is present but still says `Unassigned` is reported in a dry
// run as `would-restore-marker` (userTabWriteBack.js:555-565, dry-run only — the
// real path returns action 'exists' with reason 'already-present-marker-restored').
// Both mean the row was found, which is what the backfill is supposed to prove.
// Asserting presence directly keeps the test honest about its actual claim.
t('the real gap site is now present in the tab (backfill landed)',
  ['exists', 'would-restore-marker'].includes(absent.action) && absent.rowNumber > 1,
  { action: absent.action, reason: absent.reason, rowNumber: absent.rowNumber });
t('present at a concrete row number', Number.isInteger(absent.rowNumber) && absent.rowNumber > 1, absent);

// Plan-shape coverage must not depend on a live gap existing, so probe with a
// URL that cannot be in the tab. dryRun writes NOTHING, so this cannot fabricate
// a row — it only reports what would be written.
const probeUrl = 'plan-shape-probe.invalid';
const absent2 = await ensureSiteRowInUserTab({ siteUrl: probeUrl, userName: 'Sabbir', account: 'CW', dryRun: true });
console.log(`  Sabbir/${probeUrl} ->`, absent2.action, absent2.reason || '', 'col=', absent2.urlCol, 'via=', absent2.urlColVia);
t('absent site -> would-append (fixes "not found … skipping")', absent2.action === 'would-append', absent2);
if (absent2.action === 'would-append') {
  const p = absent2.plannedRow;
  t('URL lands in the resolved column', p[absent2.urlCol] === probeUrl, p);
  t('the marker column was resolved on the live tab', absent2.markerColumn === 10, absent2.markerColumn);
  t('marker cell says Assigned', p[absent2.markerColumn] === 'Assigned', { markerColumn: absent2.markerColumn, value: p[absent2.markerColumn] });
  t('account label column resolved to col 1', absent2.accountColumn === 1, absent2.accountColumn);
  t('account cell carries the DB account', p[1] === 'CW', { col1: p[1] });
  t('every other cell is blank',
    p.filter((v, i) => v !== '' && i !== absent2.urlCol && i !== absent2.markerColumn && i !== absent2.accountColumn).length === 0, p);
}

console.log('\n== 5. identity: alias resolves, unknown never fabricates ==');
clearTabTitleCache();
const alias = await ensureSiteRowInUserTab({ siteUrl: 'cogwheelmarketing.com', userName: 'Ettekhar Taion', dryRun: true });
t('alias "Ettekhar Taion" -> Taion tab', alias.tabName === 'Taion' && alias.matchedBy === 'alias', { tab: alias.tabName, via: alias.matchedBy });
const full = await ensureSiteRowInUserTab({ siteUrl: 'cogwheelmarketing.com', userName: 'Md. Ettekhar Rahman Taion', dryRun: true });
t('full name "Md. Ettekhar Rahman Taion" -> Taion tab', full.tabName === 'Taion', { tab: full.tabName, via: full.matchedBy });
const ghost = await ensureSiteRowInUserTab({ siteUrl: 'cogwheelmarketing.com', userName: 'Nobody Person', dryRun: true });
t('unknown user -> skip/unresolved-user (no tab fabricated)', ghost.action === 'skip' && ghost.reason === 'unresolved-user', ghost);

console.log('\n== 6. unassign is non-destructive ==');
const rMed = await readAndResolveTab('Medul', id, headerRow);
let medUrl = null;
for (const row of rMed.rows) { const v = (row || [])[rMed.col]; if (looksLikeDomain(v)) { medUrl = v; break; } }
const sr = await softRemoveSiteRowFromUserTab({ siteUrl: medUrl, userName: 'Medul', dryRun: true });
console.log('  soft-remove ->', sr.action, sr.reason || '', 'row=', sr.rowNumber, 'col=', sr.urlCol);
t('soft-remove never deletes (reports marker/absence only)', ['would-soft-remove', 'skip'].includes(sr.action), sr);
t('soft-remove found the row in the resolved column', sr.rowNumber != null, sr);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
