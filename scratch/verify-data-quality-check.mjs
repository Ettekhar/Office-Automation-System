/**
 * verify-data-quality-check.mjs — READ-ONLY.
 *
 * Covers the standing sync check, and in particular the invariant that the
 * in-code comment in db.js only asserts: that duneclimbinn.com is dormant
 * BECAUSE every holder is inactive, and that it would be reported as live the
 * moment that stopped being true.
 */
import * as db from '../src/db.js';
import {
  findDuplicatedMailAddresses, findAddressSpreadAcrossFields,
  assessDuplicatedAddressRisk, runDataQualityChecks, formatDataQualityReport,
} from '../src/dataQuality.js';

const allDr = db.getDailyReview({}) || [];
const allUsers = db.getUsers() || [];
const sites = db.getSites() || [];
const usersById = Object.fromEntries(allUsers.map((u) => [u.id, u]));

let pass = 0, fail = 0;
const t = (n, c, e) => { if (c) { pass++; console.log(`  ok   ${n}`); } else { fail++; console.log(`  FAIL ${n}${e !== undefined ? '  ' + JSON.stringify(e) : ''}`); } };

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const DUNE = 'https://duneclimbinn.com/';

// ── 1. What the smell detector reports ──
console.log(`\n=== 1. duplicated mail addresses found in the real data ===`);
const dupes = findDuplicatedMailAddresses(allDr);
for (const d of dupes) {
  console.log(`  ${String(d.userName).padEnd(8)} active=${usersById[d.userId]?.active !== false}  ${String(d.value).slice(0, 40)}  (${d.fields.join(' + ')})`);
}
t('finds the 7 known records', dupes.length === 7, dupes.length);
t('every hit is a real address', dupes.every((d) => EMAIL.test(d.value)), dupes.map((d) => d.value));

// ── 2. The false alarms it must NOT produce ──
console.log(`\n=== 2. shapes that must NOT be flagged ===`);
const naBoth = allDr.filter((d) => String(d.newsletterMail || '').trim() === 'N/A' && String(d.formSubmissionMail || '').trim() === 'N/A');
t('"N/A" in both columns is not a smell (a site can have neither)', naBoth.length > 0 && dupes.every((d) => d.value !== 'N/A'), naBoth.length);
t('the old noisy detector would have fired ~44x; this one stays quiet',
  dupes.length < 10, dupes.length);
const diffAddrs = allDr.filter((d) => {
  const a = String(d.newsletterMail || '').trim(), b = String(d.formSubmissionMail || '').trim();
  return a && b && a !== b && EMAIL.test(a) && EMAIL.test(b);
});
t('different addresses in the two columns are fine', diffAddrs.length > 0 && !dupes.some((d) => d.recordId && diffAddrs.some((x) => x.id === d.recordId)), diffAddrs.length);
console.log(`  (${diffAddrs.length} records have two DIFFERENT addresses - correctly not flagged)`);

// ── 3. The standing invariant: dormant because every holder is inactive ──
console.log(`\n=== 3. risk assessment ===`);
const risk = assessDuplicatedAddressRisk(allDr, sites, usersById);
for (const r of risk) {
  console.log(`  ${r.status.toUpperCase().padEnd(8)} ${r.siteUrl}  "${String(r.value).slice(0, 34)}"`);
  console.log(`           holders: ${r.holders.map((h) => h.userName + (h.active ? '' : '(inactive)')).join(', ')}`);
}
const dune = risk.find((r) => r.siteUrl === DUNE);
t('duneclimbinn.com is present in the report', !!dune, risk.map((r) => r.siteUrl));
t('duneclimbinn.com is DORMANT (all holders inactive)', dune?.status === 'dormant', dune?.status);
t('and it says WHY, in words', /inactive/.test(dune?.dormantBecause || ''), dune?.dormantBecause);
const liveSites = risk.filter((r) => r.status === 'live').map((r) => r.siteUrl);
t('the other three sites are LIVE', liveSites.length === 3, liveSites);
t('no pending assignee would receive one today',
  risk.every((r) => !r.wouldReachPendingAssignee), risk.filter((r) => r.wouldReachPendingAssignee));

// ── 4. THE FLIP: this is the whole point of making it standing ──
console.log(`\n=== 4. counter-test: reactivate duneclimbinn's holder ===`);
const tarikul = allUsers.find((u) => u.name === 'Tarikul');
const flipped = { ...usersById, [tarikul.id]: { ...tarikul, active: true } };
const afterFlip = assessDuplicatedAddressRisk(allDr, sites, flipped).find((r) => r.siteUrl === DUNE);
console.log(`  status: ${afterFlip.status}   activeHolders: ${JSON.stringify(afterFlip.activeHolders)}`);
t('reactivating the holder flips DORMANT -> LIVE', afterFlip.status === 'live', afterFlip.status);
t('and the report now names who could donate it', afterFlip.activeHolders.includes('Tarikul'), afterFlip.activeHolders);
// A second ACTIVE holder of the same site must also flip it.
t('a new active holder of the same site also flips it',
  assessDuplicatedAddressRisk([...allDr, { id: 'x', userId: allUsers[0].id, userName: allUsers[0].name, siteId: dune.siteId, newsletterMail: dune.value, formSubmissionMail: dune.value }], sites, usersById)
    .find((r) => r.siteUrl === DUNE).status === 'live');

// ── 5. Robustness: a broken check must never break a sync ──
console.log(`\n=== 5. hostile input ===`);
t('null rows does not throw', runDataQualityChecks(null, null, null).ok === true);
t('undefined users map does not throw', runDataQualityChecks([{ id: 'a', newsletterMail: 'a@b.com', formSubmissionMail: 'a@b.com' }], [], undefined).ok === true);
const hostile = runDataQualityChecks([{ id: 'a' }, null, undefined, { id: 'b', newsletterMail: 12345, formSubmissionMail: { weird: true } }], [{ id: 's' }], {});
t('malformed records are skipped, not fatal', hostile.ok === true, hostile);
t('non-string values are not treated as addresses',
  !findDuplicatedMailAddresses([{ id: 'z', newsletterMail: 42, formSubmissionMail: 42 }]).length);
t('no rows is a clean report, not a failure',
  runDataQualityChecks([], [], {}).summary === 'no duplicated mail addresses');

// ── 6. The rendered report says the useful thing ──
console.log(`\n=== 6. rendered output ===`);
const txt = formatDataQualityReport(runDataQualityChecks(allDr, sites, usersById));
console.log(txt);
t('mentions DORMANT', txt.includes('DORMANT'));
t('mentions LIVE', txt.includes('LIVE'));
t('names the site that is only safe because of the rule', txt.includes('duneclimbinn.com'));
t('clean input renders a one-liner',
  formatDataQualityReport(runDataQualityChecks([], [], {})).includes('no duplicated mail addresses'));

console.log(`\n${pass} passed, ${fail} failed`);
console.log('READ-ONLY. Nothing written.');
process.exit(fail ? 1 : 0);
