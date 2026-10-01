/**
 * verify-inheritance.mjs — READ-ONLY. Proves the new site-fact inheritance does
 * what it should and, just as importantly, what it must NOT do.
 *
 * Runs collectInheritedSiteFacts() over the REAL records for
 * governorsinnnd.com (Medul has data, Taion does not) and asserts:
 *   - Taion WOULD inherit Medul's site facts
 *   - Taion would NOT inherit Medul's maintenance / report-sent status
 *   - an inactive user's stale record is not used as a donor
 *   - template placeholders are refused
 *   - a site nobody has data for yields nothing (no fabrication)
 */
import * as db from '../src/db.js';

const drRows = db.getDailyReview({}) || [];
const allUsers = db.getUsers() || [];
const usersById = Object.fromEntries(allUsers.map((u) => [u.id, u]));
const idOf = (name) => (allUsers.find((u) => u.name === name) || {}).id;

let pass = 0, fail = 0;
const t = (name, cond, extra) => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${extra !== undefined ? '  ' + JSON.stringify(extra) : ''}`); }
};
const SITE_FACTS = ['ga4', 'newsletterMail', 'formSubmissionMail', 'bookingLink', 'clientResponse', 'cloudflare', 'uptimeRobot'];

const site = db.getSites().find((s) => s.url.includes('governorsinnnd'));
console.log(`\n=== governorsinnnd.com — real records ===`);
for (const d of drRows.filter((d) => d.siteId === site.id)) {
  const facts = SITE_FACTS.filter((f) => String(d[f] || '').trim());
  console.log(`  ${String(d.userName).padEnd(8)} active=${usersById[d.userId]?.active !== false} source=${String(d.source).split(' ')[0]}  facts: ${facts.join(', ') || '(none)'}`);
}

// 1. The main case: a newcomer inherits the site facts.
const res = db.collectInheritedSiteFacts(drRows, site.id, idOf('Taion'), usersById);
console.log(`\n=== what Taion would inherit ===`);
for (const f of SITE_FACTS) {
  if (res.inherited[f]) {
    const p = res.siteFactsFrom[f];
    console.log(`  ${f.padEnd(20)} = ${JSON.stringify(String(res.inherited[f]).slice(0, 52))}   from ${p.from}${p.contested ? '  [CONTESTED]' : ''}`);
  }
}
t('inherits ga4 from the observer', res.inherited.ga4 === 'Yes', res.inherited.ga4);
t('inherits newsletterMail', res.inherited.newsletterMail === 'N/A', res.inherited.newsletterMail);
t('inherits formSubmissionMail', /CasseltonHospitality/.test(res.inherited.formSubmissionMail || ''));
t('inherits bookingLink', /wyndhamhotels/.test(res.inherited.bookingLink || ''));
t('records who each value came from', res.siteFactsFrom.ga4?.from === 'Medul', res.siteFactsFrom.ga4);
t('does NOT invent a maintenance status', !('maintenanceStatus' in res.inherited));
t('does NOT invent a report-sent status', !('reportSentStatus' in res.inherited));
t('inheritance keys are site facts only',
  Object.keys(res.inherited).every((k) => SITE_FACTS.includes(k)), Object.keys(res.inherited));

// 2. Nobody has data -> nothing invented.
const bare = db.getSites().find((s) => !drRows.some((d) => d.siteId === s.id && SITE_FACTS.some((f) => String(d[f] || '').trim())));
const bareRes = db.collectInheritedSiteFacts(drRows, bare.id, idOf('Toufiq'), usersById);
t('a site nobody has data for inherits nothing', Object.keys(bareRes.inherited).length === 0, bareRes.inherited);

// 3. Inactive users are not donors.
const inactive = allUsers.find((u) => u.active === false);
const inactiveDonor = db.collectInheritedSiteFacts(drRows, site.id, idOf('Roeich'), { ...usersById, [idOf('Asif')]: { ...usersById[idOf('Asif')], active: false } });
t('inactive user excluded as donor (governorsinnnd has no inactive record)',
  !Object.values(inactiveDonor.siteFactsFrom || {}).some((p) => /Asif/.test(p.from || '')), inactiveDonor.siteFactsFrom);

// 4. Template placeholders refused, using the real cayugahospitality case.
const cayuga = db.getSites().find((s) => s.url.includes('cayugahospitality'));
const cay = db.collectInheritedSiteFacts(drRows, cayuga.id, idOf('Roeich'), usersById);
t('refuses the literal "{admin_email}" placeholder',
  !Object.values(cay.inherited).some((v) => /^\{[^}]*\}$/.test(String(v))), cay.inherited);
console.log(`  note: placeholders refused -> ${JSON.stringify(cay.refused)}`);

// 5. Idempotent: inheriting again yields the same answer.
const again = db.collectInheritedSiteFacts(drRows, site.id, idOf('Taion'), usersById);
t('stable across calls', JSON.stringify(again.inherited) === JSON.stringify(res.inherited));

console.log(`\n${pass} passed, ${fail} failed`);
console.log('READ-ONLY. Nothing written.');
process.exit(fail ? 1 : 0);
