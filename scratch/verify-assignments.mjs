/**
 * verify-assignments.mjs — the personal asks store (My Tasks), no network.
 *
 * Checks the parts the UI depends on: date/time → remindAt, the sender being
 * immutable, filters used by "For me" / "I sent", and completion/snooze state.
 *
 * Run: node scratch/verify-assignments.mjs
 */
import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'officeos-assign-'));
process.env.OFFICEOS_DATA_DIR = dir;
process.env.DB_MEMO = 'false';

// Seed two teammates before db.js reads anything.
fs.writeFileSync(path.join(dir, 'users.json'), JSON.stringify([
  { id: 'u1', name: 'Mona', role: 'user', active: true },
  { id: 'u2', name: 'Ali', role: 'admin', active: true },
]), 'utf8');

const db = await import('../src/db.js');

let pass = 0;
let fail = 0;
const t = (name, fn) => {
  try { fn(); pass++; console.log('  \u2713 ' + name); }
  catch (e) { fail++; console.error('  \u2717 ' + name + ' \u2014 ' + e.message); }
};

const at = (date, time) => new Date(`${date}T${time}:00`);

console.log('\nassignments store\n');

t('localDate is the local calendar day, not UTC', () => {
  assert.equal(db.localDate(new Date(2026, 9, 20, 23, 30)), '2026-10-20');
});

t('assignmentRemindAt builds a local instant', () => {
  const iso = db.assignmentRemindAt('2026-10-20', '09:30');
  assert.ok(iso, 'expected an ISO value');
  const d = new Date(iso);
  assert.equal(d.getFullYear(), 2026);
  assert.equal(d.getMonth(), 9);
  assert.equal(d.getDate(), 20);
  assert.equal(d.getHours(), 9);
  assert.equal(d.getMinutes(), 30);
});

t('assignmentRemindAt is empty without a time', () => {
  assert.equal(db.assignmentRemindAt('2026-10-20', ''), '');
  assert.equal(db.assignmentRemindAt('bad-date', '09:30'), '');
});

let first;
t('createAssignment fills defaults and computes remindAt', () => {
  first = db.createAssignment({
    title: '  Check the morning mail  ',
    toUserId: 'u1', toUserName: 'Mona',
    fromUserId: 'u2', fromUserName: 'Ali',
    date: '2026-10-20', time: '09:30',
  });
  assert.equal(first.title, 'Check the morning mail');
  assert.equal(first.status, 'open');
  assert.equal(first.kind, 'task');
  assert.equal(first.snoozeCount, 0);
  assert.equal(first.completedAt, '');
  assert.equal(first.remindAt, at('2026-10-20', '09:30').toISOString());
});

t('title is required', () => {
  assert.throws(() => db.createAssignment({ toUserId: 'u1', title: '   ' }), /Write what you need/);
});

t('a recipient is required', () => {
  assert.throws(() => db.createAssignment({ title: 'x' }), /Pick who this is for/);
});

t('bad kind falls back to task; bad time clears the alarm', () => {
  const a = db.createAssignment({
    title: 'Odd input', kind: 'nonsense', time: '99:99',
    toUserId: 'u1', date: '2026-10-21',
  });
  assert.equal(a.kind, 'task');
  assert.equal(a.time, '');
  assert.equal(a.remindAt, '');
  db.deleteAssignment(a.id);
});

t('missing date defaults to today', () => {
  const a = db.createAssignment({ title: 'Today please', toUserId: 'u1' });
  assert.equal(a.date, db.localDate());
  db.deleteAssignment(a.id);
});

t('kind reminder survives', () => {
  const a = db.createAssignment({ title: 'Call the host', kind: 'reminder', toUserId: 'u2' });
  assert.equal(a.kind, 'reminder');
  db.deleteAssignment(a.id);
});

t('filters: recipient id, recipient name, sender, status', () => {
  assert.ok(db.getAssignments({ toUserId: 'u1' }).some(a => a.id === first.id));
  assert.ok(db.getAssignments({ toUserId: 'nope', toUserName: 'Mona' }).some(a => a.id === first.id));
  assert.ok(db.getAssignments({ fromUserId: 'u2' }).some(a => a.id === first.id));
  assert.equal(db.getAssignments({ status: 'done' }).length, 0);
  assert.ok(db.getAssignments({ status: 'open' }).some(a => a.id === first.id));
});

t('done sets completedAt, reopening clears it', () => {
  const done = db.updateAssignment(first.id, { status: 'done' });
  assert.equal(done.status, 'done');
  assert.ok(Date.parse(done.completedAt) > 0);
  assert.equal(db.getAssignments({ status: 'done' }).length, 1);
  const open = db.updateAssignment(first.id, { status: 'open' });
  assert.equal(open.completedAt, '');
});

t('snooze pushes remindAt into the future and reopens', () => {
  db.updateAssignment(first.id, { status: 'done' });
  const s = db.updateAssignment(first.id, { snoozeMinutes: 10 });
  assert.equal(s.status, 'open');
  assert.equal(s.completedAt, '');
  assert.equal(s.snoozeCount, 1);
  assert.ok(Date.parse(s.remindAt) > Date.now() + 8 * 60_000);
});

t('changing date/time recomputes remindAt', () => {
  const u = db.updateAssignment(first.id, { date: '2026-10-22', time: '16:45' });
  assert.equal(u.remindAt, at('2026-10-22', '16:45').toISOString());
});

t('clearing the time clears the alarm', () => {
  const u = db.updateAssignment(first.id, { time: '' });
  assert.equal(u.remindAt, '');
});

t('an explicit remindAt wins over date/time', () => {
  const iso = new Date(Date.now() + 3600_000).toISOString();
  const u = db.updateAssignment(first.id, { date: '2026-10-23', time: '08:00', remindAt: iso });
  assert.equal(u.remindAt, iso);
});

t('the sender cannot be rewritten by a client', () => {
  const u = db.updateAssignment(first.id, { fromUserId: 'hacker', fromUserName: 'Nobody', title: 'Edited' });
  assert.equal(u.fromUserId, 'u2');
  assert.equal(u.fromUserName, 'Ali');
  assert.equal(u.title, 'Edited');
});

t('invalid status is rejected', () => {
  assert.throws(() => db.updateAssignment(first.id, { status: 'banana' }), /Unknown status/);
});

t('list order is by day then time', () => {
  const later = db.createAssignment({ title: 'Later', toUserId: 'u1', date: '2026-10-24', time: '10:00' });
  const early = db.createAssignment({ title: 'Early', toUserId: 'u1', date: '2026-10-24', time: '08:00' });
  const ids = db.getAssignments({ toUserId: 'u1', status: 'open' }).map(a => a.id);
  assert.ok(ids.indexOf(early.id) < ids.indexOf(later.id));
  db.deleteAssignment(later.id);
  db.deleteAssignment(early.id);
});

t('delete removes the ask', () => {
  db.deleteAssignment(first.id);
  assert.equal(db.getAssignmentById(first.id), null);
});

t('data is persisted to its own assignments.json', () => {
  const a = db.createAssignment({ title: 'Persist me', toUserId: 'u1' });
  const raw = JSON.parse(fs.readFileSync(path.join(dir, 'assignments.json'), 'utf8'));
  assert.ok(raw.some(x => x.id === a.id));
  db.deleteAssignment(a.id);
});

fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
