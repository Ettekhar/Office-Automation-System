/**
 * measure-inherited-field-gap.mjs — READ-ONLY. Blast radius of the bug found in
 * Taion row 31: the checklist facts (ga4, newsletter, form mail, client
 * response, booking link, cloudflare, uptime) are stored PER (site,user) but
 * describe the SITE. A user assigned later gets a fresh, empty record, so their
 * tab row is written blank even though the DB already knows the answers under
 * another user.
 *
 * For every assigned (site,user) pair that already has a row, compare that
 * user's record against the best value any OTHER user's record holds for the
 * same site, and report only the cells the user's tab actually HAS a column for
 * (those are the ones that are visibly blank and fillable).
 *
 * Status fields are intentionally excluded: maintenance / report-sent are
 * per-person work, not site facts, and must never be inherited.
 */
import * as db from '../src/db.js';
import { getTabValues } from '../src/sheets.js';
import {
  getDailyReviewSheetId, resolveUserTab, readAndResolveTab, findAssignmentMarkerColumn,
  normalizeSiteUrl, proposeFieldFills,
} from '../src/userTabWriteBack.js';
import { resolveUserTabAccountColumn } from '../src/columnMap.js';

const SITE_FACTS = ['ga4', 'newsletter', 'formSubmission', 'clientResponse', 'booking', 'cloudflare', 'uptime'];
const FIELD_TO_DR = {
  ga4: 'ga4', newsletter: 'newsletterMail', formSubmission: 'formSubmissionMail',
  clientResponse: 'clientResponse', booking: 'bookingLink', cloudflare: 'cloudflare', uptime: 'uptimeRobot',
};

const { id: sheetId, headerRow } = getDailyReviewSheetId();
const sites = db.getSites();
const users = (db.getUsers() || []).filter((u) => u.active !== false);
const allDr = db.getDailyReview({}) || [];

const bySite = new Map();
for (const d of allDr) {
  if (!bySite.has(d.siteId)) bySite.set(d.siteId, []);
  bySite.get(d.siteId).push(d);
}

let pairRows = 0, affectedRows = 0;
const cells = [];
const noColumnButKnown = [];

for (const u of users) {
  const rt = await resolveUserTab(u.name);
  if (!rt.user || rt.reason) continue;
  const tab = rt.tabName;
  let header, rows, urlCol, accountCol, markerCol;
  try {
    const values = (await getTabValues(tab, `A${headerRow}:ZZ2000`, sheetId)) || [];
    header = (values[0] || []).map((h) => (h == null ? '' : String(h)));
    rows = values.slice(1);
    const r = await readAndResolveTab(tab, sheetId, headerRow);
    if (!r.ok) continue;
    urlCol = r.col;
    const a = resolveUserTabAccountColumn({ headers: header, rows, urlCol });
    accountCol = Number.isInteger(a?.col) ? a.col : -1;
    markerCol = findAssignmentMarkerColumn(header);
  } catch { continue; }

  for (const s of sites.filter((x) => (x.assignedUsers || []).includes(u.id))) {
    const clean = normalizeSiteUrl(s.url);
    let hit = -1;
    for (let i = 0; i < rows.length; i++) {
      if (normalizeSiteUrl((rows[i] || [])[urlCol]) === clean) { hit = i; break; }
    }
    if (hit === -1) continue;
    pairRows++;

    const mine = (allDr.find((d) => d.siteId === s.id && d.userId === u.id)) || {};
    const others = (bySite.get(s.id) || []).filter((d) => d.userId !== u.id);
    const cur = rows[hit] || [];

    // Which columns does this tab actually have?
    const { dataColumns } = proposeFieldFills({ header, rows, urlCol, accountCol, markerCol, site: s, dr: mine });

    for (const f of SITE_FACTS) {
      const mineVal = String(mine[FIELD_TO_DR[f]] ?? '').trim();
      if (mineVal) continue;                       // this user already has it
      const col = dataColumns[f];
      const hasCol = Number.isInteger(col) && col >= 0;
      // Best value any other user holds for the same site.
      let donor = null;
      for (const o of others) {
        const v = String(o[FIELD_TO_DR[f]] ?? '').trim();
        if (v && v !== mineVal) { donor = { userName: o.userName, value: v }; break; }
      }
      if (!donor) continue;
      const cellVal = hasCol ? String(cur[col] ?? '').trim() : null;
      if (hasCol && cellVal === '') {
        cells.push({ tab, user: u.name, url: s.url, row: hit + headerRow + 1, col, field: f, header: header[col], donor: donor.userName, value: donor.value });
      } else if (!hasCol) {
        noColumnButKnown.push({ tab, user: u.name, url: s.url, field: f, donor: donor.userName, value: donor.value });
      }
    }
  }
}

const tabs = [...new Set(cells.map((c) => c.tab))];
affectedRows = new Set(cells.map((c) => `${c.tab}!${c.row}`)).size;

console.log(`\n=== INHERITED-FIELD GAP (read-only survey) ===`);
console.log(`  assigned pairs with an existing row checked : ${pairRows}`);
console.log(`  rows with at least one visibly blank cell   : ${affectedRows}`);
console.log(`  fillable cells (tab HAS the column, cell is blank) : ${cells.length}`);
console.log(`  tabs involved : ${tabs.length ? tabs.join(', ') : '(none)'}`);
const byField = {};
for (const c of cells) byField[c.field] = (byField[c.field] || 0) + 1;
for (const [k, v] of Object.entries(byField).sort((a, b) => b[1] - a[1])) console.log(`      ${k.padEnd(16)} ${v}`);
console.log(`\n  known-but-unwritable (tab has NO such column) : ${noColumnButKnown.length}`);
const nf = {};
for (const c of noColumnButKnown) nf[c.field] = (nf[c.field] || 0) + 1;
for (const [k, v] of Object.entries(nf).sort((a, b) => b[1] - a[1])) console.log(`      ${k.padEnd(16)} ${v}`);

console.log('\n  first 25 fillable cells:');
for (const c of cells.slice(0, 25)) {
  console.log(`    ${c.tab}!R${c.row}C${c.col} [${c.header}] = ${JSON.stringify(String(c.value).slice(0, 50))}   (donor: ${c.donor})   ${c.url}`);
}
console.log('\nREAD-ONLY. Nothing written.');
