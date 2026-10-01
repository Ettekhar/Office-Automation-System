// LIVE dry-run (read-only) of the full assignment write-back orchestration.
// Proves, against the real Daily Review sheet and the real DB:
//   1. a newly assigned site plans an append in the assignee's tab
//   2. the URL column is the resolved one (not the "Website"/"Booking Link" trap)
//   3. an unassign plans a soft-remove and never a delete
//   4. a deactivated assignee is reported precisely, not silently
//   5. NOTHING is written: every data/*.json is byte-identical before/after
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { syncAssignmentToUserTabs } from '../src/assignmentWriteBack.js';
import * as db from '../src/db.js';

const DATA_DIR = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '../data');

const hashAll = () => {
  const out = {};
  for (const f of fs.readdirSync(DATA_DIR).filter((f) => f.endsWith('.json')).sort()) {
    const p = path.join(DATA_DIR, f);
    out[f] = crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex').slice(0, 16);
  }
  return out;
};

let pass = 0, fail = 0;
const t = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  ' + JSON.stringify(extra) : '')); }
};

const before = hashAll();
console.log('  data/ files hashed:', Object.keys(before).length);

const users = db.getUsers();
const sabbir = users.find((u) => u.name === 'Sabbir');
const site = db.getSites().find((s) => /cogwheelmarketing\.com/i.test(s.url || ''));
t('found the reported site (cogwheelmarketing.com)', !!site, site && site.url);
t('found Sabbir', !!sabbir);
// PICK the deactivated user from the DB. This used to hardcode Toufiq, on the
// assumption he was active:false. He has since been reactivated, so the fixture
// was stale and the suite failed for an assignee the guard was RIGHT to accept.
// Naming a different person would only re-arm the trap at the next
// reactivation, so the precondition is read from the source of truth — and
// asserted to exist, so this block can never quietly stop testing anything.
const inactiveUser = users.find((u) => u.active === false);
console.log('  inactive user from DB:', inactiveUser ? `${inactiveUser.name} (active:false)` : '(none)');
t('the DB has a deactivated user to exercise the skip path', !!inactiveUser,
  users.map((u) => `${u.name}:${u.active}`));

// ── 1. add Sabbir (dry run) ──
const add = await syncAssignmentToUserTabs({
  site, beforeUserIds: [], afterUserIds: [sabbir.id],
  actor: { name: 'verify', id: 'verify' }, source: 'offline verification', dryRun: true,
});
console.log('\n  add Sabbir ->', JSON.stringify(add, null, 0));
t('plans an append (wouldAppend)', add.wouldAppend.length === 1, add);
t('nothing was actually appended', add.appended.length === 0 && add.existing.length === 0, add);
t('target tab is Sabbir', add.wouldAppend[0]?.tabName === 'Sabbir', add.wouldAppend[0]);
t('URL column resolved by data (col 0), not the "Website" label column',
  add.wouldAppend[0]?.urlCol === 0, add.wouldAppend[0]);

// ── 2. remove Sabbir (dry run) — must be a soft remove, never a delete ──
const remove = await syncAssignmentToUserTabs({
  site, beforeUserIds: [sabbir.id], afterUserIds: [],
  actor: { name: 'verify', id: 'verify' }, source: 'offline verification', dryRun: true,
});
console.log('\n  remove Sabbir ->', JSON.stringify(remove, null, 0));
t('unassign never deletes (no delete action exists in the report)',
  !JSON.stringify(remove).includes('delete'), remove);
t('unassign is planned as a soft-remove or a flagged skip',
  remove.wouldAppend.some((x) => x.action === 'would-soft-remove') || remove.skipped.length === 1, remove);

// ── 3. deactivated assignee is reported precisely ──
const inact = await syncAssignmentToUserTabs({
  site, beforeUserIds: [], afterUserIds: [inactiveUser.id],
  actor: { name: 'verify', id: 'verify' }, source: 'offline verification', dryRun: true,
});
console.log(`\n  add ${inactiveUser.name} (deactivated) ->`, JSON.stringify(inact, null, 0));
t('deactivated assignee is reported, not silently dropped',
  inact.skipped.length === 1 && inact.skipped[0].reason === 'inactive-user', inact);

// ── 4. unknown/absent user id ──
const bogus = await syncAssignmentToUserTabs({
  site, beforeUserIds: [], afterUserIds: ['no-such-user-id'],
  actor: { name: 'verify', id: 'verify' }, source: 'offline verification', dryRun: true,
});
t('unknown user id cannot fabricate a row', bogus.appended.length === 0 && bogus.wouldAppend.length === 0, bogus);

// ── 5. no-op when assignees unchanged ──
const noop = await syncAssignmentToUserTabs({
  site, beforeUserIds: [sabbir.id], afterUserIds: [sabbir.id], dryRun: true,
});
t('unchanged assignees produce no work at all',
  noop.appended.length + noop.existing.length + noop.wouldAppend.length + noop.skipped.length + noop.failed.length === 0, noop);

// ── 6. nothing was written ──
const after = hashAll();
const changed = Object.keys({ ...before, ...after }).filter((f) => before[f] !== after[f]);
console.log('\n  data/ hashes after:', Object.keys(after).length);
t('ZERO writes to data/ (every file byte-identical)', changed.length === 0, changed);
if (changed.length) for (const f of changed) console.log(`    changed: ${f} ${before[f]} -> ${after[f]}`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
