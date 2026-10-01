/**
 * probe-future-assignment.mjs — READ-ONLY. Answers: "will this keep happening
 * automatically for future assignments?"
 *
 * Simulates assigning an EXISTING site to an active user who does not yet have
 * a daily-review record for it, with dryRun: true so nothing is written. The
 * site chosen is one whose data another user really has recorded, which is
 * exactly the situation that produced the empty Taion row.
 *
 * If the planned row is URL/account/status-only while the other user's row is
 * rich, then yes — the gap recurs on its own, because nothing in the assignment
 * path consults another user's record.
 */
import * as db from '../src/db.js';
import { ensureSiteRowInUserTab } from '../src/userTabWriteBack.js';

const allDr = db.getDailyReview({}) || [];
const users = (db.getUsers() || []).filter((u) => u.active !== false);
const bySite = new Map();
for (const d of allDr) {
  if (!bySite.has(d.siteId)) bySite.set(d.siteId, []);
  bySite.get(d.siteId).push(d);
}

const RICH = ['ga4', 'newsletterMail', 'formSubmissionMail', 'clientResponse', 'bookingLink', 'cloudflare', 'uptimeRobot'];

// Find a site where one user has real site-fact data and another active user has none.
let target = null;
for (const s of db.getSites()) {
  const recs = bySite.get(s.id) || [];
  if (recs.length < 1) continue;
  const donor = recs.find((d) => RICH.some((f) => String(d[f] ?? '').trim() !== ''));
  if (!donor) continue;
  const newcomer = users.find((u) => u.active !== false && !recs.some((d) => d.userId === u.id));
  if (!newcomer) continue;
  target = { site: s, donor, newcomer };
  break;
}

if (!target) { console.log('no suitable site found'); process.exit(0); }

const { site, donor, newcomer } = target;
console.log(`\n=== SIMULATED FUTURE ASSIGNMENT (dryRun, nothing written) ===`);
console.log(`  site      : ${site.url}`);
console.log(`  donor     : ${donor.userName}  (already has a record with real data)`);
for (const f of RICH) {
  const v = String(donor[f] ?? '').trim();
  if (v) console.log(`      ${f.padEnd(20)} = ${JSON.stringify(v.slice(0, 60))}`);
}
console.log(`  newcomer  : ${newcomer.name}  (no daily-review record for this site yet)`);

// A real assignment calls ensureDailyReviewRows() BEFORE the write-back, so the
// record already exists by write time. Passing null (as a naive probe would)
// understates the result, because the status columns come from that record.
// This is the exact shape db.js now creates — empty site facts, no fabrications.
const syntheticDr = {
  userId: newcomer.id, userName: newcomer.name, siteId: site.id, siteUrl: site.url,
  company: site.company || site.account || '', rowIndex: null,
  maintenanceStatus: 'todo', maintenanceRaw: 'To Do',
  reportSentStatus: 'no', reportSentRaw: 'No',
  ga4: '', newsletterMail: '', formSubmissionMail: '', bookingLink: '',
  cloudflare: '', clickupLink: site.clickupUrl || '',
  clickupTimeTrackUrl: site.clickupTimeTrackUrl || '', clientResponse: '', uptimeRobot: '',
};

// ensureSiteRowInUserTab is the function that actually builds the row, and it
// takes the record as an argument — so this is a faithful, write-free preview of
// what a real assignment would produce.
const res = await ensureSiteRowInUserTab({
  siteUrl: site.url,
  userName: newcomer.name,
  account: String(site.account || site.company || '').trim(),
  site, dr: syntheticDr, dryRun: true,
});

console.log(`\n  PLANNED ROW on ${res.tabName}  (action: ${res.action}):`);
const ff = res.filledFields || [];
if (!ff.length) console.log('    (no data fields)');
for (const f of ff) console.log(`    ${f.header || f.field} = ${JSON.stringify(String(f.value).slice(0, 60))}`);

// Report the question that actually matters: of the site facts the donor has,
// how many reach the new row? Counting "fields written" would be misleading —
// Maintenance / Report Sent / ClickUp are not site facts and are not lost.
const carried = RICH.filter((f) => ff.some((x) => x.field === f && String(x.value ?? '').trim() !== ''));
const donorFacts = RICH.filter((f) => String(donor[f] ?? '').trim() !== '');
console.log(`\n    -> ${ff.length} field(s) written in total, but ${ff.length - carried.length} of those are status/ClickUp, not site facts.`);
console.log(`    -> site facts carried over: ${carried.length} of ${donorFacts.length}  ${carried.length ? '(' + carried.join(', ') + ')' : '(NONE)'}`);
console.log(`    -> site facts LOST on this new row: ${donorFacts.length - carried.length}  [${donorFacts.filter((f) => !carried.includes(f)).join(', ')}]`);
console.log('\nREAD-ONLY. Nothing written.');
