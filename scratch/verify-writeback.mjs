// Read-only verification of userTabWriteBack against the LIVE Daily Review sheet.
// dryRun:true everywhere → zero writes. Proves:
//   1) credential resolution (no hardcoded fallback)
//   2) user→tab resolution via resolveUserByName (aliases too)
//   3) URL column resolved from the real header (columnMap, not hardcoded)
//   4) idempotency: existing site reports 'exists', missing reports 'would-append'
//   5) unknown user never fabricates a tab
import { ensureSiteRowInUserTab, softRemoveSiteRowFromUserTab, getDailyReviewSheetId, readAndResolveTab } from '../src/userTabWriteBack.js';
import * as sheets from '../src/sheets.js';
import { findUrlColumn, looksLikeDomain } from '../src/columnMap.js';

let pass = 0, fail = 0;
const t = (name, cond, extra) => { if (cond) { pass++; console.log('  ok  ', name); } else { fail++; console.log('  FAIL', name, extra !== undefined ? JSON.stringify(extra) : ''); } };

console.log('\n== 1. credential (sheet manager is source of truth) ==');
const cred = getDailyReviewSheetId();
console.log('  sheetId =', cred.id, ' headerRow =', cred.headerRow);
t('uses the real sheet-manager ID (1QqDY9q7…)', cred.id === '1QqDY9q7mRj4QPsuRnFEfFmegFvJoywfDmwanCFtZY6I', cred.id);
t('no stale 1C4jSa49 fallback', cred.id !== '1C4jSa49P6LHEN8ywh92fOgBPif6OSKuXx8PoRONtWzs');

console.log('\n== 2. real header + URL column resolution ==');
const tabs = await sheets.listTabMeta(cred.id);
const titles = tabs.map(t => t?.properties?.title || t?.title);
console.log('  tabs =', titles.join(' | '));
for (const name of ['Taion', 'Sabbir', 'Toufiq']) {
  const hdr = (await sheets.getTabValues(name, `A${cred.headerRow}:ZZ${cred.headerRow}`, cred.id))?.[0] || [];
  const headerOnly = findUrlColumn(hdr);
  // Resolve the way the PRODUCT resolves, via readAndResolveTab -> the canonical
  // resolveUserTabUrlColumn({headers, rows, ...}). Header-only resolution is not
  // trustworthy here and this test used to rely on it: Sabbir's and Taion's
  // column A header is a single space " ", so findUrlColumn(hdr) returns 1 for
  // Sabbir (the "Website" ACCOUNT-label column) and 7 for Taion (Booking/
  // Reservation Link). The old assertion was only `col >= 0`, so it passed while
  // pointing at the wrong column — a green test proving nothing.
  const r = await readAndResolveTab(name, cred.id, cred.headerRow);
  const col = r.ok ? r.col : -1;
  // The meaningful check: the chosen column must actually hold domains.
  const domainHits = r.ok
    ? r.rows.filter((row) => looksLikeDomain((row || [])[col])).length
    : 0;
  console.log(`  ${name}: canonical col=${col} via=${r.via} domainRows=${domainHits}/${r.ok ? r.rows.length : 0}  headerOnly=${headerOnly}  headerA=${JSON.stringify(hdr[0])}`);
  t(`${name} URL column resolved`, r.ok && col >= 0, { col, via: r.via, reason: r.reason });
  t(`${name} resolved column actually holds domains (not just col >= 0)`,
    domainHits > 0, { col, domainHits, headerOnly });
}

console.log('\n== 3. user resolution: canonical, alias, unknown ==');
const a = await ensureSiteRowInUserTab({ siteUrl: 'cogwheelmarketing.com', userName: 'Taion', dryRun: true });
console.log('  Taion →', a.action, a.reason || '', 'tab=', a.tabName, 'urlCol=', a.urlCol);
t('canonical user resolves to their tab', a.tabName === 'Taion' && a.action !== 'skip', a);
const b = await ensureSiteRowInUserTab({ siteUrl: 'cogwheelmarketing.com', userName: 'Ettekhar Taion', dryRun: true });
console.log('  "Ettekhar Taion" →', b.action, b.reason || '', 'tab=', b.tabName, 'matchedBy=', b.matchedBy);
t('alias resolves to Taion tab (identity, not a new tab)', b.tabName === 'Taion', b);
const c = await ensureSiteRowInUserTab({ siteUrl: 'x.com', userName: 'Nobody Person', dryRun: true });
console.log('  unknown →', c.action, c.reason || '');
t('unknown user never fabricates a tab', c.action === 'skip' && c.reason === 'unresolved-user', c);

console.log('\n== 4. idempotency: present vs absent (dry run) ==');
// Pull a real existing URL out of the Sabbir tab so the 'exists' test is real.
// The column MUST come from the canonical resolver. This used to use
// findUrlColumn(headers), which returns 1 for Sabbir because column A's header is
// a single space — so the "real URL" it harvested was the account label "CW",
// the site was then (correctly!) reported as not present, and the idempotency
// assertion failed while the product was working perfectly.
const sabRes = await readAndResolveTab('Sabbir', cred.id, cred.headerRow);
const urlColSab = sabRes.ok ? sabRes.col : -1;
const sab = sabRes.ok ? sabRes.rows : [];
console.log(`  canonical urlCol for Sabbir = ${urlColSab} (via ${sabRes.via})`);
let realUrl = null;
for (const r of sab) { const v = (r || [])[urlColSab]; if (v && String(v).trim()) { realUrl = String(v).trim(); break; } }
console.log('  real URL from Sabbir tab =', realUrl);
t('the harvested URL is a real domain, not an account label', looksLikeDomain(realUrl), realUrl);
if (realUrl) {
  const d = await ensureSiteRowInUserTab({ siteUrl: realUrl, userName: 'Sabbir', dryRun: true });
  console.log('  existing →', d.action, d.reason || '', 'row=', d.rowNumber);
  // A present row whose marker still says Unassigned is reported as
  // 'would-restore-marker' in a dry run; both outcomes mean "found, not appended".
  t('existing site is idempotent (no duplicate append)',
    ['exists', 'would-restore-marker'].includes(d.action), d);
}
const e = await ensureSiteRowInUserTab({ siteUrl: 'zzz-definitely-not-present-smoke-xyz.com', userName: 'Sabbir', dryRun: true });
console.log('  absent →', e.action, e.reason || '', 'plannedRow=', JSON.stringify(e.plannedRow));
t('absent site plans an append (the fix for "not found … skipping")', e.action === 'would-append', e);
// Index by the resolver's OWN reported column, not a separately computed one.
t('planned row puts the URL in the resolved column', e.plannedRow && e.plannedRow[e.urlCol] === 'zzz-definitely-not-present-smoke-xyz.com',
  { usedCol: e.urlCol, canonicalCol: urlColSab, plannedRow: e.plannedRow });

console.log('\n== 5. soft-remove is non-destructive (dry run) ==');
if (realUrl) {
  const f = await softRemoveSiteRowFromUserTab({ siteUrl: realUrl, userName: 'Sabbir', dryRun: true });
  console.log('  soft-remove →', f.action, f.reason || '', 'cell=', f.cell || '(no marker column)');
  t('soft-remove never deletes; marks or reports', ['would-soft-remove', 'skip'].includes(f.action), f);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
