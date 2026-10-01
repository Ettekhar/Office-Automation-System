/**
 * trace-consensus-source.mjs — READ-ONLY. The consensus count said 2 observers
 * hold "reservations@hotelsheldon.com" for hotelsheldon.com, but Sabbir's live
 * tab row has no Newsletter cell at all. Where did the second observer come
 * from, and is the DB simply stale relative to the tabs?
 */
import * as db from '../src/db.js';
import { getTabValues } from '../src/sheets.js';
import { getDailyReviewSheetId, resolveUserTab, readAndResolveTab, normalizeSiteUrl } from '../src/userTabWriteBack.js';

const { id: sheetId, headerRow } = getDailyReviewSheetId();
const allDr = db.getDailyReview({}) || [];

for (const target of ['hotelsheldon.com', 'cayugahospitality.com']) {
  const site = db.getSites().find((s) => normalizeSiteUrl(s.url) === normalizeSiteUrl(target));
  console.log(`\n================ ${target} ================`);
  const recs = allDr.filter((d) => d.siteId === site.id);
  console.log(`  DB records for this site: ${recs.length}`);
  for (const d of recs) {
    const u = (db.getUsers() || []).find((x) => x.id === d.userId);
    console.log(`   user=${String(d.userName).padEnd(8)} active=${u?.active !== false}  source=${d.source}  rowIndex=${d.rowIndex}`);
    console.log(`      newsletterMail     = ${JSON.stringify(d.newsletterMail)}`);
    console.log(`      formSubmissionMail = ${JSON.stringify(String(d.formSubmissionMail || '').slice(0, 50))}`);
    console.log(`      lastSeenAt         = ${d.lastSeenAt || '(none)'}   updatedAt=${d.updatedAt || '(none)'}`);
  }

  // Now read the live tabs for EVERY user, including inactive ones if a tab exists.
  console.log('  live tab reality:');
  for (const u of (db.getUsers() || [])) {
    const rt = await resolveUserTab(u.name);
    if (!rt.user) continue;
    try {
      const values = (await getTabValues(rt.tabName, `A${headerRow}:ZZ2000`, sheetId)) || [];
      const header = (values[0] || []).map((h) => (h == null ? '' : String(h)));
      const rows = values.slice(1);
      const r = await readAndResolveTab(rt.tabName, sheetId, headerRow);
      if (!r.ok) continue;
      const i = rows.findIndex((x) => normalizeSiteUrl((x || [])[r.col]) === normalizeSiteUrl(site.url));
      if (i < 0) { console.log(`   ${u.name} [${rt.tabName}]: no row`); continue; }
      const row = rows[i] || [];
      const nl = header.findIndex((h) => h.trim().toLowerCase() === 'newsletter mail');
      const fs = header.findIndex((h) => h.trim().toLowerCase() === 'form submission mail');
      console.log(`   ${u.name} [${rt.tabName}] row ${i + headerRow + 1}  newsletter=${JSON.stringify(nl >= 0 ? String(row[nl] ?? '').trim() : '(no col)')}  formSubmission=${JSON.stringify(fs >= 0 ? String(row[fs] ?? '').trim().slice(0, 40) : '(no col)')}`);
    } catch (e) { console.log(`   ${u.name}: read failed ${e.message}`); }
  }
}
console.log('\nREAD-ONLY. Nothing written.');
