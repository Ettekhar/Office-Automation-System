/**
 * repair-fabricated-and-inherited-cells.mjs — two approved corrections.
 * Dry run by default; --apply writes.
 *
 * PART 1 — retract 3 fabricated cells.
 * db.js used to hardcode cloudflare:'No' / uptimeRobot:'Yes' on every newly
 * assigned (site,user) record. Nothing had actually checked Cloudflare, but the
 * sheet write-back published the default into the tab, so 3 cells now assert
 * "No" with NO observation behind them anywhere in the DB. Those are inventions
 * and must be retracted to blank.
 *
 * A cell is only retracted when the site's value was observed NOWHERE: if any
 * other user's record for that site holds a real value, the cell is legitimate
 * and is left alone.
 *
 * PART 2 — fill one row with real values.
 * Taion's row for governorsinnnd.com is missing 3 values that his tab HAS
 * columns for (Newsletter Mail, Form Submission Mail, Booking / Reservstion
 * Link). They are taken from Medul's record for the SAME site, after checking
 * each value is a real observation and not a template placeholder.
 *
 * The 2 values Taion's tab has no column for (GA4 Report, SMTP/Client Response)
 * are NOT written — inventing a column is not this script's call.
 *
 * Per-user status (maintenance, report sent) is never inherited or altered.
 */
import * as db from '../src/db.js';
import { getTabValues, updateSheetCell, colIndexToA1 } from '../src/sheets.js';
import {
  getDailyReviewSheetId, resolveUserTab, normalizeSiteUrl, readAndResolveTab,
} from '../src/userTabWriteBack.js';

const APPLY = process.argv.includes('--apply');
const { id: sheetId, headerRow } = getDailyReviewSheetId();
const allDr = db.getDailyReview({}) || [];
const bySite = new Map();
for (const d of allDr) {
  if (!bySite.has(d.siteId)) bySite.set(d.siteId, []);
  bySite.get(d.siteId).push(d);
}

const colFor = (header, name) => header.findIndex((h) => String(h).trim().toLowerCase() === name);
// A value counts as a real observation only if it was actually READ FROM A TAB.
// Records created by assignment carry the old hardcoded defaults, so two such
// records "agreeing" with each other is circular, not corroboration — they were
// both invented by the same bug. Only a sheet-sourced record is evidence.
const observedElsewhere = (siteId, field, selfUserId) =>
  (bySite.get(siteId) || [])
    .filter((d) => d.userId !== selfUserId)
    .filter((d) => !String(d.source || '').startsWith('app:assign'))
    .map((d) => String(d[field] ?? '').trim())
    .filter(Boolean);

// ── load every active user's tab once ──
const tabs = new Map();
for (const u of (db.getUsers() || []).filter((x) => x.active !== false)) {
  const rt = await resolveUserTab(u.name);
  if (!rt.user || rt.reason) continue;
  try {
    const values = (await getTabValues(rt.tabName, `A${headerRow}:ZZ2000`, sheetId)) || [];
    tabs.set(u.name, {
      tab: rt.tabName,
      header: (values[0] || []).map((h) => (h == null ? '' : String(h))),
      rows: values.slice(1),
      urlCol: (await readAndResolveTab(rt.tabName, sheetId, headerRow)).col,
    });
  } catch { /* skip unreadable tab */ }
}
const rowOf = (t, siteUrl) => t.rows.findIndex((r) => normalizeSiteUrl((r || [])[t.urlCol]) === normalizeSiteUrl(siteUrl));

// ══ PART 1 ══
const sheetWrites = [];
const dbFixes = [];

for (const d of allDr) {
  if (!String(d.source || '').startsWith('app:assign')) continue;   // only assignment-created records
  const t = tabs.get(d.userName);
  if (!t) continue;

  for (const [field, headerName] of [['cloudflare', 'cloudflare issues'], ['uptimeRobot', 'uptime robot monitoring']]) {
    if (String(d[field] ?? '').trim() === '') continue;
    if (observedElsewhere(d.siteId, field, d.userId).length) continue;   // real value exists -> keep

    // The DB value is retracted whether or not the tab has a column for it: the
    // fabricated uptimeRobot:'Yes' is what makes db.js derive uptimeStatus
    // 'online' for a site nobody has actually monitored.
    dbFixes.push({ kind: 'retract', drId: d.id, field, old: d[field], reason: 'hardcoded default, never observed' });

    const col = colFor(t.header, headerName);
    const i = rowOf(t, d.siteUrl);
    if (col < 0) { console.log(`  ${d.userName}: tab has no "${headerName}" column — DB value retracted, no cell to clear`); continue; }
    if (i < 0) { console.log(`  ${d.userName}: no row for ${d.siteUrl} — DB value retracted, no cell to clear`); continue; }

    const cellVal = String((t.rows[i] || [])[col] ?? '').trim();
    if (cellVal === '') continue;                                       // already blank

    const a1 = `${colIndexToA1(col)}${i + headerRow + 1}`;
    sheetWrites.push({ kind: 'retract', userName: d.userName, tab: t.tab, a1, header: headerName, current: cellVal, url: d.siteUrl, drId: d.id, field });
  }
}

// ══ PART 2 ══
const SITE = 'governorsinnnd.com';
const TARGET_USER = 'Taion';
const DONOR_USER = 'Medul';
const site = db.getSites().find((s) => normalizeSiteUrl(s.url) === normalizeSiteUrl(SITE));
const donor = (bySite.get(site.id) || []).find((d) => d.userName === DONOR_USER);
const targetDr = (bySite.get(site.id) || []).find((d) => d.userName === TARGET_USER);
const t = tabs.get(TARGET_USER);

// A value is only worth copying if it is a real observation, not a template
// placeholder like "{admin_email}" and not obviously the wrong kind of link.
const JUNK = /^\{[^}]*\}$|^\s*todo\s*$/i;
const PART2 = [
  { header: 'newsletter mail', field: 'newsletterMail' },
  { header: 'form submission mail', field: 'formSubmissionMail' },
  { header: 'booking / reservstion link', field: 'bookingLink' },
];

if (t && donor && targetDr) {
  const i = rowOf(t, SITE);
  if (i < 0) console.log(`  PART 2 skipped: no row for ${SITE} on ${TARGET_USER}`);
  else {
    for (const p of PART2) {
      const col = colFor(t.header, p.header);
      const val = String(donor[p.field] ?? '').trim();
      if (col < 0) { console.log(`  PART 2 skip: ${TARGET_USER} tab has no "${p.header}" column`); continue; }
      if (!val) { console.log(`  PART 2 skip: ${DONOR_USER} has no ${p.field}`); continue; }
      if (JUNK.test(val)) { console.log(`  PART 2 REFUSED: ${p.field} looks like a placeholder: ${JSON.stringify(val)}`); continue; }
      const cellVal = String((t.rows[i] || [])[col] ?? '').trim();
      if (cellVal) { console.log(`  PART 2 skip: ${t.tab}!${colIndexToA1(col)}${i + headerRow + 1} already has content`); continue; }
      const a1 = `${colIndexToA1(col)}${i + headerRow + 1}`;
      sheetWrites.push({ kind: 'fill', userName: TARGET_USER, tab: t.tab, a1, header: t.header[col], current: '', value: val, url: SITE, drId: targetDr.id, field: p.field });
      dbFixes.push({ kind: 'fill', drId: targetDr.id, field: p.field, old: '', value: val });
    }
    // Recorded, never silently dropped.
    for (const [field, headerName] of [['ga4', 'ga4 report'], ['clientResponse', 'smtp/client response']]) {
      if (colFor(t.header, headerName) < 0) {
        console.log(`  PART 2 not writable: ${TARGET_USER} tab has NO "${headerName}" column (donor has ${JSON.stringify(String(donor[field] || '').slice(0, 40))}) — column not invented`);
      }
    }
  }
}

console.log(`\n=== ${APPLY ? 'APPLYING' : 'DRY RUN'} ===`);
console.log(`\nPART 1 — retract fabricated values (no observation anywhere):`);
if (!sheetWrites.filter((w) => w.kind === 'retract').length) console.log('  (none)');
for (const w of sheetWrites.filter((w) => w.kind === 'retract')) {
  console.log(`  CLEAR ${w.tab}!${w.a1} [${w.header}]  "${w.current}" -> (blank)   ${w.url}`);
}
console.log(`\nPART 2 — fill ${TARGET_USER}'s row with real values from ${DONOR_USER}:`);
if (!sheetWrites.filter((w) => w.kind === 'fill').length) console.log('  (none)');
for (const w of sheetWrites.filter((w) => w.kind === 'fill')) {
  console.log(`  FILL  ${w.tab}!${w.a1} [${w.header}]  (blank) -> ${JSON.stringify(String(w.value).slice(0, 70))}`);
}

if (!APPLY) {
  console.log(`\n${sheetWrites.length} sheet write(s) + ${dbFixes.length} DB correction(s) planned. Nothing written. Re-run with --apply.`);
  process.exit(0);
}

// ── apply ──
let ok = 0; const failed = [];
for (const w of sheetWrites) {
  try { await updateSheetCell(sheetId, w.tab, w.a1, w.kind === 'retract' ? '' : w.value); ok++; }
  catch (e) { failed.push({ ...w, error: e.message }); }
}
console.log(`\nsheet writes: ${ok}/${sheetWrites.length}` + (failed.length ? `  FAILED: ${failed.map((f) => `${f.tab}!${f.a1} ${f.error}`).join('; ')}` : ''));

for (const f of dbFixes) {
  const rec = allDr.find((d) => d.id === f.drId);
  if (!rec) continue;
  const before = rec[f.field];
  rec[f.field] = f.kind === 'retract' ? '' : f.value;
  rec.updatedAt = new Date().toISOString();
  try {
    db.updateDailyReviewRow(f.drId, { [f.field]: rec[f.field], updatedAt: rec.updatedAt });
    console.log(`  db ${f.drId.slice(0, 8)} ${f.field}: ${JSON.stringify(before)} -> ${JSON.stringify(rec[f.field])}`);
  } catch (e) { console.log(`  db FAILED ${f.drId}: ${e.message}`); }
}

try {
  db.appendAuditLog({
    actor: 'repair-fabricated-and-inherited', actorId: '', source: 'Manual data repair (approved)',
    action: 'sheet:cell-retract+fill', entity: 'daily-review', entityId: sheetId,
    label: `${sheetWrites.filter((w) => w.kind === 'retract').length} fabricated cell(s) retracted, ${sheetWrites.filter((w) => w.kind === 'fill').length} cell(s) filled`,
    field: 'cloudflare / uptimeRobot / newsletterMail / formSubmissionMail / bookingLink',
    oldValue: 'hardcoded defaults asserted unverified findings',
    newValue: 'blank where never observed; real site values where they exist',
    reason: 'Retracted Cloudflare/uptimeRobot values that came from hardcoded db.js defaults with no observation behind them. ' +
      `Filled ${TARGET_USER}'s ${SITE} row with values observed by ${DONOR_USER} on the same site. ` +
      'Per-user maintenance/report-sent status was never inherited or changed.',
  });
  console.log('audit entry written.');
} catch (e) { console.log('audit failed:', e.message); }
