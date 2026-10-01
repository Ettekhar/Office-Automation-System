/**
 * verify-inactive-donor-excluded.mjs — READ-ONLY. The hotelsheldon case is the
 * one that proved the rule matters: the ONLY other record for that site belongs
 * to Asif, who is inactive, and its values are a stale copy of Toufiq's — with
 * the same email pasted into two different columns.
 *
 * If inactive users were allowed to donate, Sabbir would inherit that duplicated
 * address. This asserts the rule blocks it.
 */
import * as db from '../src/db.js';

const drRows = db.getDailyReview({}) || [];
const allUsers = db.getUsers() || [];
const usersById = Object.fromEntries(allUsers.map((u) => [u.id, u]));
const idOf = (n) => (allUsers.find((u) => u.name === n) || {}).id;

let pass = 0, fail = 0;
const t = (n, c, e) => { if (c) { pass++; console.log(`  ok   ${n}`); } else { fail++; console.log(`  FAIL ${n}${e !== undefined ? '  ' + JSON.stringify(e) : ''}`); } };

const site = db.getSites().find((s) => s.url.includes('hotelsheldon'));
console.log(`\n=== hotelsheldon.com — who actually holds data ===`);
for (const d of drRows.filter((d) => d.siteId === site.id)) {
  const u = usersById[d.userId];
  console.log(`  ${String(d.userName).padEnd(8)} active=${u?.active !== false}  newsletter=${JSON.stringify(d.newsletterMail)}  formSubmission=${JSON.stringify(String(d.formSubmissionMail || '').slice(0, 45))}`);
}

// Isolate the rule properly: remove the ACTIVE holder (Toufiq) so the ONLY
// remaining record is Asif's, who is inactive. Then nothing may be inherited.
const onlyInactive = drRows.filter((d) => !(d.siteId === site.id && d.userName === 'Toufiq'));
console.log(`\n  (isolating: with Toufiq's record removed, the only holder left is inactive Asif)`);
const res = db.collectInheritedSiteFacts(onlyInactive, site.id, idOf('Sabbir'), usersById);
console.log(`  Sabbir would inherit: ${JSON.stringify(res.inherited)}`);
t('nothing inherited when the only holder is inactive',
  Object.keys(res.inherited).length === 0, res.inherited);
t('did not inherit the duplicated reservations@ address from a stale record',
  !Object.values(res.inherited).some((v) => /reservations@/.test(String(v))));

// And the rule is load-bearing: flip Asif to active and the value would flow.
const forced = { ...usersById, [idOf('Asif')]: { ...usersById[idOf('Asif')], active: true } };
const leaky = db.collectInheritedSiteFacts(onlyInactive, site.id, idOf('Sabbir'), forced);
console.log(`  counter-test, if Asif were ACTIVE: ${JSON.stringify(Object.keys(leaky.inherited))}`);
t('counter-test shows the rule is load-bearing (would have inherited if allowed)',
  Object.keys(leaky.inherited).length > 0, leaky.inherited);
t('  and what it would have copied is the same string in two fields',
  leaky.inherited.newsletterMail === leaky.inherited.formSubmissionMail, leaky.inherited);

// Separately: inheritance from the ACTIVE holder does work, and it faithfully
// copies Toufiq's duplicated address. That duplication is a pre-existing defect
// in Toufiq's row, NOT something inheritance introduces.
const live = db.collectInheritedSiteFacts(drRows, site.id, idOf('Sabbir'), usersById);
console.log(`\n  with the real records, Sabbir inherits from: ${live.siteFactsFrom?.newsletterMail?.from}`);
t('does inherit from the active holder', live.inherited.newsletterMail === 'reservations@hotelsheldon.com');
t('and the copied value is traceable to its source',
  live.siteFactsFrom.newsletterMail.from === 'Toufiq', live.siteFactsFrom.newsletterMail);

console.log(`\n${pass} passed, ${fail} failed`);
console.log('READ-ONLY. Nothing written.');
process.exit(fail ? 1 : 0);
