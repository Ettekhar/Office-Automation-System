/**
 * verify-sync-dataquality.mjs — READ-ONLY dry run of the real sync pipeline.
 * Confirms the data-quality check actually executes inside syncAll(), reports
 * through the operator-visible log, and surfaces in the returned payload.
 */
import { syncAll } from '../src/syncFromSheets.js';

const r = await syncAll({ dryRun: true });

console.log('\n================ RESULT PAYLOAD ================');
console.log('dryRun          :', r.dryRun);
console.log('dailyReviewRows :', r.counts.dailyReviewRows);
console.log('dataQuality ok  :', r.dataQuality && r.dataQuality.ok);
console.log('summary         :', r.dataQuality && r.dataQuality.summary);
console.log('live / dormant  :', r.dataQuality && r.dataQuality.liveRiskCount, '/', r.dataQuality && r.dataQuality.dormantRiskCount);
console.log('would reach pend:', JSON.stringify(r.dataQuality && r.dataQuality.wouldReachPendingAssignee));
console.log('\nper-site:');
for (const d of (r.dataQuality && r.dataQuality.duplicatedMailAddresses) || []) {
  console.log(`  ${d.status.padEnd(8)} ${d.siteUrl}  "${String(d.value).slice(0, 40)}"`);
  console.log(`           holders: ${d.holders.map((h) => h.userName + (h.active ? '' : ' (inactive)')).join(', ')}`);
  if (d.status === 'dormant') console.log(`           why safe: ${d.dormantBecause}`);
}
console.log('\nDRY RUN - nothing written by definition.');
