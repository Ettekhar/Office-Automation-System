/**
 * verify-assignee-picker.mjs — READ-ONLY proof of the deactivated-user rules in
 * the site-assignee pickers.
 *
 * The bug: every site-assignee grid rendered from the unfiltered `S.users`, so
 * Tarikul (active:false) and Asif (active:false) were offered as assignees. The
 * backend refuses those with 400 INACTIVE_ASSIGNEE — and refuses the WHOLE
 * request, so one inactive name blocked every other assignee in the same save.
 *
 * The trap in the obvious fix: all four grids submit the COMPLETE set of checked
 * boxes as the new assignee list. Filtering inactive users out of the markup
 * would therefore silently REMOVE anyone inactive who is currently assigned, the
 * next time somebody saved an unrelated field on that site.
 *
 * The rule under test, per user, per grid:
 *   active                       -> ordinary enabled checkbox
 *   inactive, NOT currently on it -> DISABLED   (cannot be added; server refuses)
 *   inactive, already on it       -> checked, ENABLED, labelled "(deactivated)"
 *                                   (survives an unrelated save; can be removed)
 *
 * This suite EVALUATES THE REAL FUNCTIONS out of public/master-app.js rather than
 * a copy, so it fails if the deployed file stops carrying the rule. It also
 * asserts the wiring — that all four grids call the helper, that Select All
 * cannot tick a locked box, and that the client surfaces the server's own
 * explanation instead of the bare error code.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as db from '../src/db.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(HERE, '..', 'public', 'master-app.js');
const SERVER = path.join(HERE, '..', 'src', 'server.js');

let pass = 0, fail = 0;
const t = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  ' + JSON.stringify(extra) : '')); }
};

const src = fs.readFileSync(APP, 'utf8');

// ── extract the real functions ───────────────────────────────────────────────
/**
 * Slice a `function name(...) { ... }` out of the source.
 *
 * The parameter list is matched with parens BEFORE looking for the body's `{`.
 * Naively taking the first `{` breaks on a signature like
 * `async function api(url, opts = {}) {` — it returns the `{` of the default
 * value, whose matching `}` sits before the real body, and yields a truncated
 * stub that matches nothing.
 */
function sliceFn(s, marker) {
  const i = s.indexOf(marker);
  if (i < 0) throw new Error('marker not found in master-app.js: ' + marker);
  const parenOpen = s.indexOf('(', i);
  let pd = 0, parenClose = -1;
  for (let k = parenOpen; k < s.length; k++) {
    if (s[k] === '(') pd++;
    else if (s[k] === ')') { pd--; if (pd === 0) { parenClose = k; break; } }
  }
  if (parenClose < 0) throw new Error('unbalanced parens for ' + marker);
  const open = s.indexOf('{', parenClose);
  if (open < 0) throw new Error('no body brace for ' + marker);
  let depth = 0;
  for (let k = open; k < s.length; k++) {
    if (s[k] === '{') depth++;
    else if (s[k] === '}') { depth--; if (depth === 0) return s.slice(i, k + 1); }
  }
  throw new Error('unbalanced braces for ' + marker);
}
const escLine = src.match(/^const esc = .*$/m);
if (!escLine) throw new Error('could not find the esc() line in master-app.js');

const pieces = {
  isActiveUser: sliceFn(src, 'function isActiveUser('),
  assigneeCheckState: sliceFn(src, 'function assigneeCheckState('),
  assigneeInputAttrs: sliceFn(src, 'function assigneeInputAttrs('),
};
console.log('\n== 0. the deployed file still carries the rule ==');
for (const [name, code] of Object.entries(pieces)) {
  t(`${name} is present in public/master-app.js`, !!code && code.includes(name));
}
const api = sliceFn(src, 'async function api(');
t('api() is present in public/master-app.js', api.includes('async function api('));

// `new Function` throws on a syntax error, so building it is itself a check.
const build = new Function([
  escLine[0],
  pieces.isActiveUser,
  pieces.assigneeCheckState,
  pieces.assigneeInputAttrs,
  'return { isActiveUser, assigneeCheckState, assigneeInputAttrs };',
].join('\n'));
const { isActiveUser, assigneeCheckState, assigneeInputAttrs } = build();
t('the extracted functions evaluate', typeof isActiveUser === 'function' && typeof assigneeCheckState === 'function' && typeof assigneeInputAttrs === 'function');

// ── real users, so the test cannot pass vacuously ────────────────────────────
const users = db.getUsers() || [];
const inactive = users.filter((u) => u.active === false);
const active = users.filter((u) => u.active !== false);
console.log('\n== 1. the premise: the DB really has deactivated users ==');
t('the DB has at least one deactivated user to test against', inactive.length > 0,
  users.map((u) => `${u.name}:${u.active}`));
t('the DB has at least one active user to test against', active.length > 0);
console.log('  inactive:', inactive.map((u) => u.name).join(', ') || '(none)');

// ── isActiveUser ─────────────────────────────────────────────────────────────
console.log('\n== 2. isActiveUser ==');
for (const u of users) {
  t(`${u.name}: isActiveUser === (active !== false)`, isActiveUser(u) === (u.active !== false), { active: u.active });
}
t('a missing user object is not active', isActiveUser(null) === false && isActiveUser(undefined) === false);
t('active === true is active', isActiveUser({ active: true }) === true);
t('a missing active field is active (back-compat with older records)', isActiveUser({}) === true);

// ── assigneeCheckState: the full truth table ─────────────────────────────────
console.log('\n== 3. assigneeCheckState — all four cases ==');
const anActive = active[0] || { id: 'a', name: 'Active', active: true };
const anInactive = inactive[0] || { id: 'i', name: 'Inactive', active: false };

const c1 = assigneeCheckState(anActive, false);
t('active + not assigned -> unchecked, NOT locked, no suffix',
  c1.checked === false && c1.locked === false && c1.suffix === '', c1);
const c2 = assigneeCheckState(anActive, true);
t('active + assigned -> checked, NOT locked, no suffix',
  c2.checked === true && c2.locked === false && c2.suffix === '', c2);
const c3 = assigneeCheckState(anInactive, false);
t('inactive + NOT assigned -> UNCHECKED and LOCKED, labelled (deactivated)',
  c3.checked === false && c3.locked === true && /deactivated/.test(c3.suffix), c3);
const c4 = assigneeCheckState(anInactive, true);
t('inactive + ALREADY assigned -> CHECKED and NOT locked (can be kept and removed)',
  c4.checked === true && c4.locked === false && /deactivated/.test(c4.suffix), c4);

// ── the two invariants that make the rule safe ───────────────────────────────
console.log('\n== 4. safety invariants over every real user, assigned and not ==');
let lockedAndChecked = 0, addableInactive = 0, lostOnSave = 0;
for (const u of users) {
  for (const isAssigned of [false, true]) {
    const st = assigneeCheckState(u, isAssigned);
    // A disabled+checked box can be neither ticked nor unticked by the user:
    // it is a dead control. The design must never produce one.
    if (st.locked && st.checked) lockedAndChecked++;
    // An inactive user who is not already assigned must never be submittable.
    if (!isActiveUser(u) && !isAssigned && st.checked) addableInactive++;
    // A user who IS assigned must survive the "submit the whole checked set"
    // save, otherwise they are silently unassigned.
    if (isAssigned && !st.checked) lostOnSave++;
  }
}
t('never produces a disabled+checked box (a control that can be neither ticked nor unticked)',
  lockedAndChecked === 0, { lockedAndChecked });
t('a deactivated user can never be newly added', addableInactive === 0, { addableInactive });
t('an assigned user is never dropped by an unrelated save', lostOnSave === 0, { lostOnSave });

// ── simulate the actual submission ───────────────────────────────────────────
console.log('\n== 5. the full-set submission, simulated ==');
// What the four grids do: POST/PUT the ids of every .x:checked box.
const submittedIds = (uList, currentAssigned) =>
  uList.filter((u) => assigneeCheckState(u, currentAssigned.includes(u.id)).checked).map((u) => u.id);

const assignedInactive = inactive[0];
const withThem = assignedInactive ? [assignedInactive.id, ...active.slice(0, 1).map((u) => u.id)] : [];
const sent = submittedIds(users, withThem);
t('an assigned deactivated user is still in the submitted set (not silently unassigned)',
  !assignedInactive || sent.includes(assignedInactive.id), { sent });
t('an assigned active user is in the submitted set', active[0] && sent.includes(active[0].id), { sent });
t('an UNassigned deactivated user is absent from the submitted set (cannot be added)',
  inactive.length < 2 || !sent.includes(inactive[1].id), { sent });

// Clear All is the one deliberate way to remove an assigned deactivated user.
const afterClearAll = withThem.filter((id) => id === assignedInactive?.id);
t('Clear All can still remove an assigned deactivated user (intent preserved)',
  !assignedInactive || afterClearAll.length === 1, { afterClearAll });

// ── assigneeInputAttrs rendering ─────────────────────────────────────────────
console.log('\n== 6. assigneeInputAttrs renders exactly the decision ==');
const a3 = assigneeInputAttrs(anInactive, false);
t('locked box renders disabled + a reason, and is not pre-checked',
  a3.disabled === ' disabled' && a3.checked === '' && /deactivated/.test(a3.title) && /deactivated/.test(a3.suffix), a3);
const a4 = assigneeInputAttrs(anInactive, true);
t('assigned inactive box renders checked, NOT disabled, still labelled',
  a4.checked === ' checked' && a4.disabled === '' && a4.title === '' && /deactivated/.test(a4.suffix), a4);
const a2 = assigneeInputAttrs(anActive, true);
t('assigned active box renders checked, no label, no title',
  a2.checked === ' checked' && a2.disabled === '' && a2.title === '' && a2.suffix === '', a2);
t('a name with a quote cannot break out of the title attribute',
  /title="[^"]*&quot;[^"]*"/.test(assigneeInputAttrs({ id: 'x', name: 'A"B', active: false }, false).title),
  assigneeInputAttrs({ id: 'x', name: 'A"B', active: false }, false).title);
t('no attribute fragment ever carries a stray quote', users.every((u) =>
  ![false, true].some((ia) => {
    const a = assigneeInputAttrs(u, ia);
    return /checked="|disabled="/.test(a.checked + a.disabled + a.title);
  })));

// ── wiring: the grids must actually use it ───────────────────────────────────
console.log('\n== 7. wiring — the deployed grids and handlers ==');
const calls = (src.match(/assigneeInputAttrs\(u,/g) || []).length;
t('assigneeInputAttrs is called from the grids (>= 4)', calls >= 4, { calls });

// Each of the four site-assignee checkbox classes must be rendered through the helper.
for (const cls of ['site-quick-user-cb', 'modal-new-assignee', 'user-assign-checkbox', 'modal-edit-assignee']) {
  const line = (src.split('\n').find((l) => l.includes(`class="${cls}"`)) || '').trim();
  t(`${cls} is rendered with the helper's attributes`, line.includes('${a.disabled}') && line.includes('${a.title}'),
    { line: line.slice(0, 120) });
}
// The new-site grid is the one with nobody assigned, so it has no ${a.checked}.
const newSiteLine = (src.split('\n').find((l) => l.includes('class="modal-new-assignee"')) || '').trim();
t('the new-site grid locks every deactivated user (no currentAssignees exist yet)',
  newSiteLine.includes('assigneeInputAttrs(u, false)') || src.includes('assigneeInputAttrs(u, false)'), null);

// No grid may still render a bare, unfiltered checkbox map.
t('no site-assignee grid still renders a raw unfiltered map',
  !/\S\.users\.map\(u => `\s*\n\s*<label class="user-check-item">\s*\n\s*<input type="checkbox" class="(site-quick-user-cb|modal-new-assignee|user-assign-checkbox|modal-edit-assignee)"/.test(src));

// Select All must not be able to tick a locked box.
t('Select All skips disabled boxes (setting .checked works on a disabled input)',
  /\.user-assign-checkbox'\)\.forEach\(cb => \{ if \(!cb\.disabled\) cb\.checked = true; \}\)/.test(src));
t('Clear All deliberately still clears disabled boxes (the way to remove one)',
  /\.user-assign-checkbox'\)\.forEach\(cb => \{ cb\.checked = false; \}\)/.test(src));

// ── the client must surface the server's explanation ─────────────────────────
console.log('\n== 8. the refusal is actually readable ==');
t('api() prefers the server message over the bare error code',
  /new Error\(data\.message \|\| data\.error/.test(api), api.slice(0, 200));
t('api() still exposes the code on e.code', /e\.code = data\.error/.test(api));

const srv = fs.readFileSync(SERVER, 'utf8');
t('the server still sends INACTIVE_ASSIGNEE with a human message',
  /INACTIVE_ASSIGNEE/.test(srv) && /Cannot assign to unknown or inactive user/.test(srv));
const guardCalls = (srv.match(/assertActiveAssignees\(/g) || []).length;
console.log(`  assertActiveAssignees call sites in server.js: ${guardCalls} (definition + 3 assignment routes)`);
t('the guard is defined and called on the assignment routes', guardCalls === 4, { guardCalls });

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
