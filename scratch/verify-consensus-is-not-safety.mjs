/**
 * verify-consensus-is-not-safety.mjs — READ-ONLY. Check whether "2+ observers
 * agree" actually implies correctness, using hotelsheldon.com and
 * cayugahospitality.com as the test cases.
 *
 * If the same string appears in two DIFFERENT columns and on two different
 * users' tabs, the agreement is not independent measurement — it is the same
 * copy-paste replicated, so consensus would launder a mistake into the DB.
 */
import * as db from '../src/db.js';
import { getTabValues } from '../src/sheets.js';
import { getDailyReviewSheetId, resolveUserTab, readAndResolveTab, normalizeSiteUrl } from '../src/userTabWriteBack.js';

const { id: sheetId, headerRow } = getDailyReviewSheetId();
const CASES = ['hotelsheldon.com', 'cayugahospitality.com'];

for (const target of CASES) {
  const site = db.getSites().find((s) => normalizeSiteUrl(s.url) === normalizeSiteUrl(target));
  console.log(`\n================ ${target} ================`);
  if (!site) { console.log('  no site record'); continue; }

  for (const u of (db.getUsers() || []).filter((x) => x.active !== false)) {
    const rt = await resolveUserTab(u.name);
    if (!rt.user || rt.reason) continue;
    let header, rows, urlCol;
    try {
      const values = (await getTabValues(rt.tabName, `A${headerRow}:ZZ2000`, sheetId)) || [];
      header = (values[0] || []).map((h) => (h == null ? '' : String(h)));
      rows = values.slice(1);
      const r = await readAndResolveTab(rt.tabName, sheetId, headerRow);
      if (!r.ok) continue;
      urlCol = r.col;
    } catch { continue; }
    const i = rows.findIndex((r2) => normalizeSiteUrl((r2 || [])[urlCol]) === normalizeSiteUrl(site.url));
    if (i < 0) continue;
    const row = rows[i] || [];
    console.log(`  -- ${u.name} [${rt.tabName}] row ${i + headerRow + 1}`);
    for (let c = 0; c < header.length; c++) {
      const v = String(row[c] ?? '').trim();
      if (!v) continue;
      const label = String(header[c] || `(blank header)`).trim() || `(blank header)`;
      // Flag columns whose content is email-like, so we can see them reused.
      const emailish = /[\w.+-]+@[\w.-]+\.\w+/.test(v);
      console.log(`       ${label.padEnd(28)} = ${JSON.stringify(v.slice(0, 66))}${emailish ? '   <-- contains an email' : ''}`);
    }
  }
}
console.log('\nREAD-ONLY. Nothing written.');
