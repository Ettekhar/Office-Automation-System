/**
 * probe-brand-new-site.mjs — READ-ONLY. "If we assign a NEW website to a user,
 * will the missing data fill up automatically?"
 *
 * A brand-new site has no observer at all, so there is nothing to inherit. This
 * probe builds the row the assignment path would produce for a site nobody has
 * ever touched, and compares it with the existing-site case, so the two are not
 * confused. dryRun: true throughout — nothing is written.
 */
import * as db from '../src/db.js';
import { ensureSiteRowInUserTab } from '../src/userTabWriteBack.js';

const user = (db.getUsers() || []).find((u) => u.active !== false && u.name === 'Toufiq')
  || (db.getUsers() || []).find((u) => u.active !== false);

// A site that does not exist in the DB and appears on no tab.
const brandNewSite = {
  id: 'probe-brand-new',
  url: 'brandnewsite-probe.example',
  account: 'CW',
  company: 'CW',
  status: 'Active',
  clickupUrl: 'https://app.clickup.com/t/868a6gkvn',
  clickupTimeTrackUrl: '',
  assignedUsers: [user.id],
  monthlyHistory: [],
};

console.log(`\n=== CASE A: BRAND-NEW website assigned to ${user.name} (nobody has ever touched it) ===`);
const a = await ensureSiteRowInUserTab({
  siteUrl: brandNewSite.url,
  userName: user.name,
  account: 'CW',
  site: brandNewSite,
  dr: {
    userId: user.id, userName: user.name, siteId: brandNewSite.id, siteUrl: brandNewSite.url,
    company: 'CW', rowIndex: null,
    maintenanceStatus: 'todo', maintenanceRaw: 'To Do',
    reportSentStatus: 'no', reportSentRaw: 'No',
    ga4: '', newsletterMail: '', formSubmissionMail: '', bookingLink: '',
    cloudflare: '', clickupLink: brandNewSite.clickupUrl,
    clickupTimeTrackUrl: '', clientResponse: '', uptimeRobot: '',
  },
  dryRun: true,
});

console.log(`  action: ${a.action}   tab: ${a.tabName}`);
const fields = a.filledFields || [];
if (!fields.length) console.log('  (no data fields at all)');
for (const f of fields) console.log(`    ${(f.header || f.field).padEnd(28)} = ${JSON.stringify(String(f.value).slice(0, 50))}`);
console.log(`\n  -> ${fields.length} field(s) written. Everything else is blank.`);
console.log('  -> That is CORRECT: nobody has checked GA4 / newsletter / booking for a site');
console.log('     that did not exist until now. A blank cell is honest, not "missing".');

console.log(`\n=== CASE B: EXISTING website (governorsinnnd.com) assigned to another user ===`);
const site = db.getSites().find((s) => s.url.includes('governorsinnnd'));
const roeichId = (db.getUsers() || []).find((u) => u.name === 'Roeich')?.id;
const drRows = db.getDailyReview({}) || [];
const usersById = Object.fromEntries((db.getUsers() || []).map((u) => [u.id, u]));

// Build the record exactly as the assignment path now does: per-person status
// fresh, site facts INHERITED from whoever already recorded them.
const inh = db.collectInheritedSiteFacts(drRows, site.id, roeichId, usersById);
console.log(`  inherited from: ${Object.entries(inh.siteFactsFrom).map(([f, p]) => `${f}<-${p.from}`).join(', ') || '(nothing)'}`);

const b = await ensureSiteRowInUserTab({
  siteUrl: site.url,
  userName: 'Roeich',
  account: String(site.account || '').trim(),
  site,
  dr: {
    userId: roeichId, userName: 'Roeich', siteId: site.id, siteUrl: site.url,
    company: site.company || site.account || '', rowIndex: null,
    maintenanceStatus: 'todo', maintenanceRaw: 'To Do',
    reportSentStatus: 'no', reportSentRaw: 'No',
    ga4: inh.inherited.ga4 || '', newsletterMail: inh.inherited.newsletterMail || '',
    formSubmissionMail: inh.inherited.formSubmissionMail || '', bookingLink: inh.inherited.bookingLink || '',
    cloudflare: inh.inherited.cloudflare || '',
    clickupLink: site.clickupUrl || '',
    clickupTimeTrackUrl: site.clickupTimeTrackUrl || '',
    clientResponse: inh.inherited.clientResponse || '', uptimeRobot: inh.inherited.uptimeRobot || '',
  },
  dryRun: true,
});
console.log(`  action: ${b.action}   tab: ${b.tabName}`);
for (const f of (b.filledFields || [])) console.log(`    ${(f.header || f.field).padEnd(28)} = ${JSON.stringify(String(f.value).slice(0, 50))}`);
const carried = ['ga4', 'newsletter', 'formSubmission', 'booking', 'clientResponse', 'cloudflare']
  .filter((f) => (b.filledFields || []).some((x) => x.field === f));
console.log(`\n  -> site facts that would now reach the sheet: ${carried.length}  [${carried.join(', ')}]`);
console.log('  -> any without a column on this tab are skipped, not lost.');

console.log('\nREAD-ONLY. Nothing written.');
