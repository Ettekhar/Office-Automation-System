/**
 * measure-inherit-consensus.mjs — READ-ONLY. Can the site-fact gap be closed
 * SAFELY? Inheritance is only trustworthy when independent sources AGREE, so
 * this buckets the 215 candidate cells by how many sheet-sourced records hold
 * the same value.
 *
 * A cell inheritable with confidence needs >= 2 independent observers agreeing.
 * One observer could be a typo, a stale paste, or a template placeholder.
 * Zero is the current broken state.
 *
 * Placeholders are counted separately and never inheritable at any consensus.
 */
import * as db from '../src/db.js';
import { getTabValues } from '../src/sheets.js';
import {
  getDailyReviewSheetId, resolveUserTab, readAndResolveTab, findAssignmentMarkerColumn,
  normalizeSiteUrl, proposeFieldFills,
} from '../src/userTabWriteBack.js';
import { resolveUserTabAccountColumn } from '../src/columnMap.js';

const SITE_FACTS = ['ga4', 'newsletter', 'formSubmission', 'clientResponse', 'booking', 'cloudflare', 'uptime'];
const TO_DR = {
  ga4: 'ga4', newsletter: 'newsletterMail', formSubmission: 'formSubmissionMail',
  clientResponse: 'clientResponse', booking: 'bookingLink', cloudflare: 'cloudflare', uptime: 'uptimeRobot',
};
const JUNK = /^\{[^}]*\}$/;

const { id: sheetId, headerRow } = getDailyReviewSheetId();
const sites = db.getSites();
const users = (db.getUsers() || []).filter((u) => u.active !== false);
const allDr = db.getDailyReview({}) || [];
const bySite = new Map();
for (const d of allDr) {
  if (!bySite.has(d.siteId)) bySite.set(d.siteId, []);
  bySite.get(d.siteId).push(d);
}
// Only records actually READ FROM A TAB are evidence. app:assign records were
// seeded by the old hardcoded defaults, so they are not observers.
const observers = (siteId, selfUserId) =>
  (bySite.get(siteId) || []).filter((d) => d.userId !== selfUserId && !String(d.source || '').startsWith('app:assign'));

const buckets = { 0: 0, 1: 0, 2: 0, '2+': 0 };
let junkCells = 0;
const perField = {};
const examples = { 1: [], 2: [], '2+': [] };

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
    let hit = -1;
    for (let i = 0; i < rows.length; i++) {
      if (normalizeSiteUrl((rows[i] || [])[urlCol]) === normalizeSiteUrl(s.url)) { hit = i; break; }
    }
    if (hit === -1) continue;
    const mine = allDr.find((d) => d.siteId === s.id && d.userId === u.id) || {};
    const { dataColumns } = proposeFieldFills({ header, rows, urlCol, accountCol, markerCol, site: s, dr: mine });
    const cur = rows[hit] || [];

    for (const f of SITE_FACTS) {
      if (String(mine[TO_DR[f]] ?? '').trim()) continue;
      const col = dataColumns[f];
      if (!Number.isInteger(col) || col < 0) continue;
      if (String(cur[col] ?? '').trim() !== '') continue;         // not blank -> not a gap

      const obs = observers(s.id, u.id);
      if (!obs.length) continue;
      const counts = new Map();
      for (const o of obs) {
        const v = String(o[TO_DR[f]] ?? '').trim();
        if (!v) continue;
        counts.set(v, (counts.get(v) || 0) + 1);
      }
      if (!counts.size) continue;
      const [top, n] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
      const key = n >= 2 ? '2+' : '1';
      buckets[key]++;
      perField[f] = perField[f] || { 1: 0, '2+': 0 };
      perField[f][key]++;
      if (JUNK.test(top)) junkCells++;
      if (examples[key].length < 4) examples[key].push(`${tab}!R${hit + headerRow + 1} [${f}] "${String(top).slice(0, 40)}" x${n} (${s.url})`);
    }
  }
}

console.log(`\n=== INHERITANCE SAFETY: how many independent observers agree? ===`);
console.log(`  gap cells with NO observer        : ${buckets[0]}   (nothing to inherit)`);
console.log(`  gap cells with exactly 1 observer  : ${buckets[1]}   (single source - could be a typo/stale paste)`);
console.log(`  gap cells with 2+ agreeing        : ${buckets['2+']}   (safe to inherit)`);
console.log(`  of the inheritable ones, values that look like placeholders: ${junkCells}`);
console.log('\n  per field:');
for (const [f, v] of Object.entries(perField)) console.log(`    ${f.padEnd(16)} 1 observer=${String(v[1]).padStart(3)}   2+ agree=${String(v['2+']).padStart(3)}`);
for (const k of ['2+', '1']) {
  console.log(`\n  examples (${k}):`);
  for (const e of examples[k]) console.log(`    ${e}`);
}
console.log('\nREAD-ONLY. Nothing written.');
