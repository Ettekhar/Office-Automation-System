/**
 * check-remaining-defaults.mjs — READ-ONLY. After the retraction pass, confirm
 * every assignment-created record that still holds a default-looking value is
 * genuinely backed by an observation somewhere, i.e. it was correctly KEPT
 * rather than missed.
 */
import * as db from '../src/db.js';

const all = db.getDailyReview({}) || [];
const bySite = new Map();
for (const d of all) {
  if (!bySite.has(d.siteId)) bySite.set(d.siteId, []);
  bySite.get(d.siteId).push(d);
}

const left = all.filter((d) => String(d.source || '').startsWith('app:assign') && (d.cloudflare === 'No' || d.uptimeRobot === 'Yes'));
console.log(`\nassignment records still holding a default-looking value: ${left.length}`);

let unjustified = 0;
for (const d of left) {
  // Only sheet-sourced records are evidence. Two app:assign records agreeing
  // with each other is circular: the same bug invented both.
  const others = (bySite.get(d.siteId) || [])
    .filter((x) => x.userId !== d.userId)
    .filter((x) => !String(x.source || '').startsWith('app:assign'));
  const realFor = (field) => others
    .map((x) => [x.userName, String(x[field] ?? '').trim()])
    .filter(([, v]) => v !== '')
    .map(([n, v]) => `${n}=${JSON.stringify(v)}`);

  const cf = realFor('cloudflare');
  const up = realFor('uptimeRobot');
  const cfBad = d.cloudflare === 'No' && cf.length === 0;
  const upBad = d.uptimeRobot === 'Yes' && up.length === 0;
  if (cfBad || upBad) unjustified++;

  console.log(`  ${d.userName.padEnd(7)} cloudflare=${JSON.stringify(d.cloudflare).padEnd(6)} uptimeRobot=${JSON.stringify(d.uptimeRobot).padEnd(7)} ${d.siteUrl}`);
  console.log(`      real cloudflare  elsewhere: ${cf.length ? cf.join('  ') : 'NONE'}${cfBad ? '   <-- UNJUSTIFIED, should be retracted' : ''}`);
  console.log(`      real uptimeRobot elsewhere: ${up.length ? up.join('  ') : 'NONE'}${upBad ? '   <-- UNJUSTIFIED, should be retracted' : ''}`);
}

console.log(`\nunjustified leftovers: ${unjustified}  ${unjustified === 0 ? '(all correctly kept)' : '(NEEDS ANOTHER PASS)'}`);
console.log('READ-ONLY. Nothing written.');
process.exit(unjustified ? 1 : 0);
