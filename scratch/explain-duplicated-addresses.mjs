/**
 * explain-duplicated-addresses.mjs — READ-ONLY. Human-readable explanation of the
 * data-quality check that now runs on every sync.
 *
 * This script deliberately contains NO detection logic of its own. An earlier
 * version of it did, and had already drifted: it flagged "same string in 2+
 * site-fact fields", which fires on 44 of 184 records purely because
 * ga4/cloudflare/clientResponse all legitimately answer "No". It also had a
 * broken target-id lookup that made it claim Medul inherits from Medul.
 *
 * The single implementation lives in src/dataQuality.js and is what the sync
 * pipeline runs. This file only narrates its output, so there is nothing here
 * that can rot out of step with production behaviour.
 */
import * as db from '../src/db.js';
import { runDataQualityChecks, formatDataQualityReport } from '../src/dataQuality.js';

const EMAILY = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

const allDr = db.getDailyReview({}) || [];
const allUsers = db.getUsers() || [];
const sites = db.getSites() || [];
const usersById = Object.fromEntries(allUsers.map((u) => [u.id, u]));

console.log(`\n=== 1. what the two "where does mail go" columns normally contain ===`);
for (const key of ['newsletterMail', 'formSubmissionMail']) {
  const vals = allDr.map((d) => String(d[key] || '').trim()).filter(Boolean);
  const emails = vals.filter((v) => EMAILY.test(v));
  console.log(`  ${key.padEnd(19)} ${String(vals.length).padStart(3)} filled, ${emails.length} of them addresses`);
  console.log(`    non-address: ${[...new Set(vals.filter((v) => !EMAILY.test(v)))].slice(0, 8).map((v) => v.slice(0, 24)).join(' | ')}`);
}
console.log(`\n  -> BOTH columns legitimately hold addresses as well as tool names.`);
console.log(`     An address in Newsletter is therefore NOT suspicious on its own.`);
console.log(`     Only the SAME address in BOTH columns is worth a look.`);

console.log(`\n=== 2. what the standing check reports (this is what a sync prints) ===`);
const dq = runDataQualityChecks(allDr, sites, usersById);
console.log(formatDataQualityReport(dq));

console.log(`\n=== 3. why "live" and "dormant" are different questions ===`);
console.log(`  LIVE     an active holder exists, so assigning somebody new to that site`);
console.log(`           WOULD hand them the address. A human should fix the source row.`);
console.log(`  DORMANT  every holder is inactive, so collectInheritedSiteFacts() refuses`);
console.log(`           them as donors and the value cannot reach anybody. Reactivating`);
console.log(`           such a user flips this to LIVE, which is why the check re-runs`);
console.log(`           on every sync instead of being a one-time finding.`);

console.log(`\n=== 4. would anything actually reach someone today? ===`);
if (!dq.wouldReachPendingAssignee.length) {
  console.log(`  No. Every active user assigned to these sites already has a row for the`);
  console.log(`  site, so no new record is created and no inheritance happens.`);
  console.log(`  (Note: "has a row" counts even when that row's two cells are empty -`);
  console.log(`  the record existing is what prevents a new one being made.)`);
} else {
  for (const s of dq.wouldReachPendingAssignee) console.log(`  ${s}`);
}

console.log('\nREAD-ONLY. Nothing written.');
