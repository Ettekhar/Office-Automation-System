/**
 * verify-smart-fill-live.mjs — READ-ONLY live preview of the smart column fill.
 *
 * Zero writes. For each active user, takes a site already assigned to them and
 * shows what ensureSiteRowInUserTab WOULD put in a fresh row, using the real
 * live headers, so the fill can be reviewed before any new row is ever written.
 */
import * as db from '../src/db.js';
import { getDailyReviewSheetId } from '../src/userTabWriteBack.js';
import { ensureSiteRowInUserTab } from '../src/userTabWriteBack.js';

const { id: sheetId } = getDailyReviewSheetId();
const sites = db.getSites();
const users = (db.getUsers() || []).filter((u) => u.active !== false);

console.log('Live smart-fill preview (DRY RUN — no writes)\n');

let anyAppend = 0;
for (const u of users) {
  const site = sites.find((s) => (s.assignedUsers || []).includes(u.id) && s.url);
  if (!site) { console.log(`${u.name}: no assigned site to preview`); continue; }
  const dr = (db.getDailyReview({ siteId: site.id, userId: u.id }) || [])[0] || null;
  const res = await ensureSiteRowInUserTab({
    siteUrl: site.url, userName: u.name, dryRun: true,
    account: String(site.account || site.company || ''), site, dr,
  });

  if (res.action === 'exists') {
    // Already in the tab — show what a fresh row WOULD carry for this tab shape.
    const marker = res.markerColumn;
    const filled = res.filledFields || [];
    console.log(`${u.name} [${res.tabName}] ${site.url}`);
    console.log(`   already present at row ${res.rowNumber}; a NEW row would fill: ` +
      (filled.length ? filled.map((f) => `${f.header || f.field}="${f.value}"`).join(', ') : '(nothing — no DB data)'));
    continue;
  }
  if (res.action === 'would-append') {
    anyAppend++;
    console.log(`${u.name} [${res.tabName}] ${site.url}`);
    console.log(`   WOULD APPEND url col ${res.urlCol}, account col ${res.accountColumn}, marker col ${res.markerColumn}`);
    console.log(`   fill: ` + (res.filledFields || []).map((f) => `${f.header || f.field}="${f.value}"`).join(', '));
    continue;
  }
  console.log(`${u.name}: action=${res.action} reason=${res.reason || '-'}`);
}
console.log(`\n${anyAppend} tab(s) would receive a new row. Nothing was written.`);
