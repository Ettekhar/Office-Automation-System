// Verify the dashboard-only "hide row" flag and the siteStatus enrichment that
// lets rows of Deactivated sites disappear from the active checklist.
// Runs against a throwaway OFFICEOS_DATA_DIR, never data/.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'officeos-hidden-'));
const now = '2026-10-20T12:00:00.000Z';

fs.writeFileSync(path.join(tmp, 'sites.json'), JSON.stringify([
  { id: 's-active', url: 'https://active.example/', status: 'Active', company: 'CW', updatedAt: now },
  { id: 's-old', url: 'https://old.example/', status: 'Deactived', company: 'CW', updatedAt: now },
], null, 2));

fs.writeFileSync(path.join(tmp, 'daily-review.json'), JSON.stringify([
  {
    id: 'r-active', userId: 'u1', userName: 'Taion', siteId: 's-active', siteUrl: 'https://active.example/',
    company: 'CW', maintenanceStatus: 'completed', maintenanceRaw: 'Completed',
    reportSentStatus: 'sent', reportSentRaw: 'Yes', hidden: false, updatedAt: now,
  },
  {
    id: 'r-old', userId: 'u1', userName: 'Taion', siteId: 's-old', siteUrl: 'https://old.example/',
    company: 'CW', maintenanceStatus: 'todo', maintenanceRaw: 'To Do',
    reportSentStatus: 'no', reportSentRaw: 'No', updatedAt: now,
  },
  {
    id: 'r-second', userId: 'u2', userName: 'Roeich', siteId: 's-active', siteUrl: 'https://active.example/',
    company: 'CW', maintenanceStatus: 'in_progress', maintenanceRaw: 'In Progress',
    reportSentStatus: 'no', reportSentRaw: 'No', updatedAt: now,
  },
], null, 2));

process.env.OFFICEOS_DATA_DIR = tmp;
process.env.DB_MEMO = 'false';

const db = await import('../src/db.js');
const { shouldCarryForwardDailyRow } = await import('../src/syncFromSheets.js');

try {
  const rows = db.getDailyReview();
  assert.equal(rows.length, 3, 'all daily-review rows are returned');

  const active = rows.find(r => r.id === 'r-active');
  const old = rows.find(r => r.id === 'r-old');
  assert.equal(active.siteStatus, 'Active', 'active site status is enriched');
  assert.equal(old.siteStatus, 'Deactived', 'legacy Deactived spelling is exposed verbatim');

  // Individual hide / restore
  const hidden = db.updateDailyReviewRow('r-active', { hidden: true });
  assert.equal(hidden.hidden, true, 'single-row hide persists');
  assert.equal(hidden.maintenanceStatus, 'completed', 'hiding never touches completion');
  assert.equal(hidden.reportSentStatus, 'sent', 'hiding never touches Report Sent');

  const reread = db.getDailyReview().find(r => r.id === 'r-active');
  assert.equal(reread.hidden, true, 'hide survives the next read');

  const restored = db.updateDailyReviewRow('r-active', { hidden: false });
  assert.equal(restored.hidden, false, 'restore clears the flag');
  assert.equal(restored.maintenanceStatus, 'completed', 'restore never changes completion');

  // Batch hide
  const batch = db.updateDailyReviewBatch(['r-active', 'r-second'], { hidden: true });
  assert.equal(batch.length, 2, 'batch updates both rows');
  assert.ok(batch.every(r => r.hidden === true), 'batch hide sets the flag on every target');
  assert.equal(db.getDailyReview().find(r => r.id === 'r-old').hidden, undefined,
    'rows outside the batch are untouched');

  // Hiding must not mutate the site record (no sheet/uptime side effect).
  const site = JSON.parse(fs.readFileSync(path.join(tmp, 'sites.json'), 'utf8')).find(s => s.id === 's-active');
  assert.equal(site.status, 'Active', 'hiding a row does not deactivate the site');
  assert.equal(site.updatedAt, now, 'hiding a row does not touch the site record');

  // Full-sync carry-forward: hidden history survives even when its site is no
  // longer in the registry; ordinary orphan rows still follow the old policy.
  const emptyCarry = { seenKeys: new Set(), siteIds: new Set(), drRows: [] };
  assert.equal(shouldCarryForwardDailyRow(
    { id: 'orphan-hidden', siteId: 'gone', userId: 'u1', hidden: true }, emptyCarry), true,
    'a hidden orphan row is carried forward by a full sync');
  assert.equal(shouldCarryForwardDailyRow(
    { id: 'orphan-hidden-string', siteId: 'gone', userId: 'u1', hidden: 'true' }, emptyCarry), true,
    'a hidden flag stored as a string is carried forward too');
  assert.equal(shouldCarryForwardDailyRow(
    { id: 'orphan-visible', siteId: 'gone', userId: 'u1', hidden: false }, emptyCarry), false,
    'an ordinary orphan row keeps the existing soft-delete policy');
  assert.equal(shouldCarryForwardDailyRow(
    { id: 'linked', siteId: 's-active', userId: 'u1' },
    { seenKeys: new Set(), siteIds: new Set(['s-active']), drRows: [] }), true,
    'a row linked to a live site is still carried forward');
  assert.equal(shouldCarryForwardDailyRow(
    { id: 'seen', siteId: 's-active', userId: 'u1', hidden: true },
    { seenKeys: new Set(['s-active::u1']), siteIds: new Set(['s-active']), drRows: [] }), false,
    'a row already seen this run is not duplicated');
  assert.equal(shouldCarryForwardDailyRow(
    { id: 'dupe', siteId: 's-active', userId: 'u1', hidden: true },
    { seenKeys: new Set(), siteIds: new Set(), drRows: [{ id: 'dupe' }] }), false,
    'a row already in the output is not duplicated');

  console.log('verify-hidden-rows: 17/17 passed');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
