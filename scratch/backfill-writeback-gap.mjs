/**
 * Backfill Daily Review rows for (site,user) pairs the DB says are assigned but
 * whose row is missing from the assignee's tab. This is the exact gap that
 * produced "[batch-sync] <site> not found in <User> tab — skipping".
 *
 * Nothing is fabricated: every pair comes from an existing DB assignment, and the
 * URL written is the site's own URL. DEFAULT = DRY RUN; pass --apply to write.
 *
 * Uses the same syncAssignmentToUserTabs() the assign routes call, so this also
 * serves as a live end-to-end exercise of the write-back path: append, persist
 * rowIndex + provenance, audit.
 */
import * as db from '../src/db.js';
import { getTabValues } from '../src/sheets.js';
import { getDailyReviewSheetId, readAndResolveTab, resolveUserTab, normalizeSiteUrl } from '../src/userTabWriteBack.js';
import { syncAssignmentToUserTabs } from '../src/assignmentWriteBack.js';

const APPLY = process.argv.includes('--apply');
const { id: SHEET_ID, headerRow } = getDailyReviewSheetId();
const users = db.getUsers();
const sites = db.getSites();

async function presentSet(userName) {
  const rt = await resolveUserTab(userName);
  if (!rt.user || rt.reason) return { skipped: rt.reason };
  const t = await readAndResolveTab(rt.tabName, SHEET_ID, headerRow);
  if (!t.ok) return { skipped: t.reason };
  const set = new Set();
  for (const r of t.rows) { const v = normalizeSiteUrl((r || [])[t.col]); if (v) set.add(v); }
  return { set, tabName: rt.tabName, col: t.col };
}

const gaps = [];
for (const s of sites) {
  for (const uid of s.assignedUsers || []) {
    const u = users.find((x) => x.id === uid);
    if (!u) continue;
    const p = await presentSet(u.name);
    if (p.skipped) continue;                       // inactive / unresolved — by design
    if (!p.set.has(normalizeSiteUrl(s.url))) gaps.push({ site: s, user: u, tabName: p.tabName, col: p.col });
  }
}

console.log(`  mode=${APPLY ? 'APPLY' : 'DRY-RUN'}   gaps found: ${gaps.length}\n`);
for (const g of gaps) console.log(`  ${g.user.name.padEnd(8)} ${g.tabName.padEnd(8)} col ${g.col}  ${g.site.url}`);

if (!gaps.length) { console.log('\n  nothing to backfill.'); process.exit(0); }
if (!APPLY) { console.log('\n  DRY RUN — nothing written. Re-run with --apply.'); process.exit(0); }

console.log('');
for (const g of gaps) {
  const before = (await presentSet(g.user.name)).set;
  const r = await syncAssignmentToUserTabs({
    site: g.site,
    beforeUserIds: [],            // treat as "this assignee needs a row"
    afterUserIds: [g.user.id],
    actor: { name: 'opencode', id: '' },
    source: 'write-back gap backfill',
  });
  const rec = (db.getDailyReview() || []).find((d) => d.siteId === g.site.id && d.userId === g.user.id);
  console.log(`  ${g.user.name} / ${g.site.url}`);
  console.log(`      report      : ${JSON.stringify({ appended: r.appended, existing: r.existing, skipped: r.skipped, failed: r.failed })}`);
  console.log(`      rowIndex    : ${rec?.rowIndex ?? '(none)'}   sourceTab=${rec?.sourceTab ?? '-'} sourceRow=${rec?.sourceRow ?? '-'} sheet=${rec?.sheetSpreadsheetId ? 'set' : 'MISSING'}`);

  // idempotency: a second pass must find the row, never append a duplicate
  const again = await syncAssignmentToUserTabs({
    site: g.site, beforeUserIds: [], afterUserIds: [g.user.id],
    actor: { name: 'opencode', id: '' }, source: 'write-back gap backfill (idempotency re-run)',
  });
  const after = (await presentSet(g.user.name)).set;
  console.log(`      re-run      : appended=${again.appended.length} existing=${again.existing.length} (expect 0 / 1)`);
  console.log(`      rows in tab : before=${before.size} after=${after.size} (expect +1)`);
}
console.log('\n  done');
