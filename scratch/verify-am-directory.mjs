/**
 * verify-am-directory.mjs  (OFFLINE)
 *
 * Verifies the sheet-derived Account Manager directory in clickup.js:
 *   getAccountManagersList({ sheetNames, members })
 *   matchClickUpMember(token, members)
 * and that resolveAccountManager / @mention building is untouched.
 *
 * Uses a fake ClickUp roster - never touches the network or the sheets.
 * Import target is CLICKUP_MOD_PATH (default ../src/clickup.js) so the
 * mutation harness can point this suite at a mutated copy.
 *
 * Exit code is 1 if FAILURES: is non-zero.
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const modPath = process.env.CLICKUP_MOD_PATH || '../src/clickup.js';
const clickup = await import(pathToFileURL(path.resolve(here, modPath)).href);

let failures = 0;
let passed = 0;
function check(label, cond, detail = '') {
  if (cond) {
    passed += 1;
    console.log(`  ok   ${label}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${label}${detail ? `  (${detail})` : ''}`);
  }
}

const FAKE_MEMBERS = [
  { id: 30032526, username: 'Mohammed Razib', email: 'mohammed@cogwheelmarketing.com' },
  { id: 87307012, username: 'Jacob Smith', email: 'jacob@cogwheelmarketing.com' },
  { id: 88888888, username: 'JT', email: 'jt@cogwheelmarketing.com' },
  { id: 99999999, username: 'Jordan Clark', email: 'jordan@cogwheelmarketing.com' },
  { id: 77777777, username: '', email: 'ann@cogwheelmarketing.com' },
];

const byStatus = (list, status) => list.filter((e) => e.status === status);

// ── matchClickUpMember ──────────────────────────────────────────────────────
console.log('matchClickUpMember:');
check('exact full-name', clickup.matchClickUpMember('mohammed razib', FAKE_MEMBERS)?.id === 30032526 && clickup.matchClickUpMember('mohammed razib', FAKE_MEMBERS)?.confidence === 'exact');
check('first-name-only is weak', clickup.matchClickUpMember('mohammed', FAKE_MEMBERS)?.confidence === 'first');
check('email match', clickup.matchClickUpMember('jt@cogwheelmarketing.com', FAKE_MEMBERS)?.id === 88888888 && clickup.matchClickUpMember('jt@cogwheelmarketing.com', FAKE_MEMBERS)?.confidence === 'email');
check('full-name token match (reversed words)', clickup.matchClickUpMember('clark jordan', FAKE_MEMBERS)?.id === 99999999 && clickup.matchClickUpMember('clark jordan', FAKE_MEMBERS)?.confidence === 'full');
check('no match -> null', clickup.matchClickUpMember('zzz nothing', FAKE_MEMBERS) === null);
check('empty token -> null', clickup.matchClickUpMember('   ', FAKE_MEMBERS) === null);

// ── getAccountManagersList with sheetNames + members ───────────────────────
console.log('getAccountManagersList (sheet-derived, fake roster):');
const dir = clickup.getAccountManagersList({
  sheetNames: [
    'Mohammed',
    'Jacob Smith',
    'Rifat, Sajedur',
    'Brand New AM',
    'Support Team',
    'N/A',
    'jt@cogwheelmarketing.com',
    'Jordan Clark',
    'Dana Sparks',
  ],
  members: FAKE_MEMBERS,
});

const linked = byStatus(dir.accountManagers, 'linked');
const suggested = byStatus(dir.accountManagers, 'suggested');
const notLinked = byStatus(dir.accountManagers, 'not_linked');

check('linked count = 5 (Mohammed, Jacob, Rifat, Sajedur, Dana)', linked.length === 5, `got ${linked.length}`);
check('suggested count = 2 (JT-by-email, Jordan-exact)', suggested.length === 2, `got ${suggested.length}`);
check('not_linked count = 1 (Brand New AM)', notLinked.length === 1, `got ${notLinked.length}`);
check('total = 8', dir.total === 8, `got ${dir.total}`);
check('counters agree with arrays', dir.linked === linked.length && dir.suggested === suggested.length && dir.notLinked === notLinked.length);
check('Mohammed linked via directory with verified id', linked.some((e) => e.id === 30032526 && e.source === 'directory'));
check('MD Rifat linked (multi-name cell split)', linked.some((e) => e.id === 57032730 && /rifat/i.test(e.name)));
check('Sajedur linked', linked.some((e) => e.id === 182653419));
check('Dana Sparks linked', linked.some((e) => e.id === 57226062 && e.email === 'accounting@cogwheelmarketing.com'));
check('email suggestion unverified (id present, status suggested)', suggested.some((e) => e.id === 88888888 && e.confidence === 'email'));
check('exact suggestion unverified', suggested.some((e) => e.id === 99999999 && e.confidence === 'exact'));
check('dedupe: one entry per ClickUp id', suggested.filter((e) => e.id === 99999999).length === 1);
check('Brand New AM has no fabricated id', notLinked.some((e) => e.id === undefined && e.status === 'not_linked'));
check('Support Team excluded', !dir.accountManagers.some((e) => /support/i.test(e.name)));
check('N/A excluded', !dir.accountManagers.some((e) => /^n\/?a$/i.test(e.name)));
check('sort: all linked before suggested before not_linked', dir.accountManagers.map((e) => e.status).join(',') === [...linked.map(() => 'linked'), ...suggested.map(() => 'suggested'), ...notLinked.map(() => 'not_linked')].join(','));
check('within linked, alphabetical', linked.map((e) => e.name).join('|') === linked.map((e) => e.name).sort((a, b) => a.localeCompare(b)).join('|'));

// ── removed AM disappears with the sheet ────────────────────────────────────
const dir2 = clickup.getAccountManagersList({
  sheetNames: ['Mohammed', 'Jacob Smith', 'Brand New AM'],
  members: FAKE_MEMBERS,
});
check('removed AM (Rifat) not in directory', !dir2.accountManagers.some((e) => e.id === 57032730));
check('removed AM (Dana) not in directory', !dir2.accountManagers.some((e) => e.id === 57226062));

// ── no sheet names -> hardcoded fallback (old behaviour) ────────────────────
const fallback = clickup.getAccountManagersList();
check('no-args fallback returns 17 unique linked AMs', fallback.total === 17 && fallback.linked === 17 && fallback.suggested === 0 && fallback.notLinked === 0, `got ${fallback.total}/${fallback.linked}`);
check('fallback includes same ids as AM_DIRECTORY', fallback.accountManagers.some((e) => e.id === 30032526) && fallback.accountManagers.some((e) => e.id === 57226062));

const fallback2 = clickup.getAccountManagersList({ sheetNames: [], members: [] });
check('empty sheetNames + empty members -> fallback 17', fallback2.total === 17 && fallback2.notLinked === 0);

// ── @mention behaviour must be untouched ────────────────────────────────────
console.log('resolveAccountManager (unchanged):');
const res = clickup.resolveAccountManager('Mohammed');
check('Mohammed resolves to the same @mention id', res.matchedUsers.length === 1 && res.matchedUsers[0].id === 30032526);
const resMulti = clickup.resolveAccountManager('Rifat, Sajedur');
check('multi-assignee mention behaviour unchanged', resMulti.matchedUsers.map((u) => u.id).sort().join(',') === '182653419,57032730');
const resFyi = clickup.resolveAccountManager('Support Team');
check('non-person still yields FYI-only mention', resFyi.isNonPerson === true && resFyi.matchedUsers.length === 0);

// ── no-token path of getClickUpMembers is offline-safe ──────────────────────
console.log('getClickUpMembers (no token):');
const hadToken = process.env.CLICKUP_API_TOKEN;
delete process.env.CLICKUP_API_TOKEN;
const noTok = await clickup.getClickUpMembers();
if (hadToken !== undefined) process.env.CLICKUP_API_TOKEN = hadToken;
check('no token -> empty members + error string', Array.isArray(noTok.members) && noTok.members.length === 0 && typeof noTok.error === 'string' && noTok.error.length > 0);

console.log(`\nPASSED: ${passed}`);
console.log(`FAILURES: ${failures}`);
if (failures > 0) process.exitCode = 1;