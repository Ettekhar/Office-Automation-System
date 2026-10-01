// ISOLATED test of the REAL append/unassign write path (no network, no live data).
// Runs against a copy of the app in %TEMP% with a fake Sheets layer whose tab
// shape matches the real workbook, including the "Website"/"Booking Link" traps.
//
// Proves:
//   A. assign -> appends ONE row, URL in the data-resolved column (0)
//   B. rowIndex + sourceTab + sourceRow persisted on the daily-review record
//   C. audit entry written with old -> new rowIndex
//   D. re-running is IDEMPOTENT: 'exists', no second row, row number unchanged
//   E. Medul resolves col 1 (its "Website URL" header) — not col 0
//   F. unassign -> SOFT remove: row + URL retained, nothing deleted,
//      and the absence of a marker column is FLAGGED (conflict recorded)
//   G. a failing write-back still leaves the DB assignment intact and is flagged
import * as db from './src/db.js';
import { syncAssignmentToUserTabs } from './src/assignmentWriteBack.js';
import { ensureSiteRowInUserTab, ensureAssignmentMarkerColumn, softRemoveSiteRowFromUserTab } from './src/userTabWriteBack.js';
import { __state } from './src/sheets.js';

let pass = 0, fail = 0;
const t = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  ' + JSON.stringify(extra) : '')); }
};

const users = db.getUsers();
const sabbir = users.find((u) => u.name === 'Sabbir');
const medul = users.find((u) => u.name === 'Medul');
const site = db.getSites().find((s) => /cogwheelmarketing\.com/i.test(s.url || ''));
t('fixture: site + Sabbir + Medul present', !!site && !!sabbir && !!medul);

const actor = { name: 'offline-test', id: 'offline-test' };
const drRow = () => db.getDailyReview().find((r) => r.siteId === site.id && r.userId === sabbir.id);

// ══ A/B/C. assign → append + persist provenance + audit ══
db.assignUsersToSite(site.id, [sabbir.id]);           // commit the DB assignment first
const rowsBefore = __state.tabs.Sabbir.length;
// Snapshot the append-only audit log BEFORE the write-back runs, so the
// assertion below measures the delta (repeat runs append, never replace).
const audits0 = (db.getAuditLog ? db.getAuditLog() : []).filter((a) => String(a.action || '').startsWith('user-tab:appended')).length;
const add = await syncAssignmentToUserTabs({ site, beforeUserIds: [], afterUserIds: [sabbir.id], actor, source: 'offline test' });
console.log('\n  A. add Sabbir ->', JSON.stringify(add));
t('exactly one row appended', __state.appends.length === 1, __state.appends);
t('tab grew by exactly one row', __state.tabs.Sabbir.length === rowsBefore + 1);
t('report says appended with a row number', add.appended.length === 1 && Number.isInteger(add.appended[0].rowNumber), add.appended);
t('URL landed in the data-resolved column 0 (not the "Website" label column)', add.appended[0]?.urlCol === 0, add.appended[0]);

const appendedRow = __state.tabs.Sabbir[__state.tabs.Sabbir.length - 1];
t('sheet cell col0 == site url', appendedRow[0] === site.url, appendedRow);
t('account label column carries the account the DB already knows (not a blank)',
  appendedRow[1] === (site.account || site.company), { col1: appendedRow[1], account: site.account, company: site.company });
t('checklist columns left ready/blank', appendedRow.slice(2, 5).every((v) => v === ''), appendedRow);
t('row number recovered by tab rescan because the append response had none',
  add.appended[0]?.rowNumberFrom === 'tab-rescan', { rowNumberFrom: add.appended[0]?.rowNumberFrom, updatedRange: add.appended[0]?.updatedRange });

const row = drRow();
t('B. rowIndex persisted on the daily-review record', row?.rowIndex === add.appended[0]?.rowNumber, { rowIndex: row?.rowIndex, appended: add.appended[0]?.rowNumber });
t('B. sourceTab persisted', row?.sourceTab === 'Sabbir', row?.sourceTab);
t('B. sourceRow persisted', row?.sourceRow === add.appended[0]?.rowNumber, row?.sourceRow);
t('B. spreadsheetId persisted', !!row?.sheetSpreadsheetId, row?.sheetSpreadsheetId);

const audits = db.getAuditLog ? db.getAuditLog() : [];
const wbAudit = audits.filter((a) => String(a.action || '').startsWith('user-tab:appended'));
t('C. exactly one audit entry written for the append (delta, not total)',
  wbAudit.length - audits0 === 1, { added: wbAudit.length - audits0, preexisting: audits0 });
const mine = wbAudit[wbAudit.length - 1];
t('C. audit records old -> new rowIndex', mine?.field === 'rowIndex' && mine?.oldValue === '(none)' && String(mine?.newValue) === String(add.appended[0]?.rowNumber), mine);
t('C. audit attributes actor + source', mine?.actor === 'offline-test' && mine?.source === 'offline test', mine);

// ══ D. idempotency: the same assign again must NOT duplicate ══
const again = await syncAssignmentToUserTabs({ site, beforeUserIds: [], afterUserIds: [sabbir.id], actor, source: 'offline test' });
console.log('\n  D. re-assign ->', JSON.stringify(again));
t('D. no second append happened', __state.appends.length === 1 && __state.tabs.Sabbir.length === rowsBefore + 1, { appends: __state.appends.length });
t('D. reported as already present', again.existing.length === 1 && again.appended.length === 0, again);
t('D. same row number resolved', again.existing[0]?.rowNumber === add.appended[0]?.rowNumber, { first: add.appended[0]?.rowNumber, second: again.existing[0]?.rowNumber });
t('D. no duplicate domain in the tab', __state.tabs.Sabbir.filter((r) => r[0] === site.url).length === 1);

// ══ E. Medul resolves its own (headered) column ══
const med = await ensureSiteRowInUserTab({ siteUrl: 'https://brand-new-for-medul.com/', userName: 'Medul', account: site.account });
t('E. Medul uses column 1 ("Website URL"), not 0', med.urlCol === 1 && med.action === 'appended', med);
t('E. Medul URL in col 1', __state.tabs.Medul[__state.tabs.Medul.length - 1][1] === 'https://brand-new-for-medul.com/');

// ══ F. unassign = soft remove (keep the row) ══
db.assignUsersToSite(site.id, []);                     // commit the DB unassignment
const un = await syncAssignmentToUserTabs({ site, beforeUserIds: [sabbir.id], afterUserIds: [], actor, source: 'offline test' });
console.log('\n  F. unassign Sabbir ->', JSON.stringify(un));
t('F. the sheet row is still there (nothing deleted)', __state.tabs.Sabbir.some((r) => r[0] === site.url));
t('F. no append happened on unassign', __state.appends.length === 2, __state.appends.length);
const conflicts = db.getSyncConflicts();
const fConflict = conflicts.find((c) => c.entityId === `${site.id}:${sabbir.id}`);
t('F. missing marker column is FLAGGED as a conflict, not silent', !!fConflict, conflicts.map((c) => c.entityId));
t('F. conflict says manual action is needed', fConflict?.policy === 'manual' && fConflict?.state === 'open', fConflict);
t('F. conflict names the reason', /marker/i.test(fConflict?.label || ''), fConflict?.label);

// ══ G. a sheet failure must not roll back the DB assignment ══
const taion = users.find((u) => u.name === 'Taion');
db.assignUsersToSite(site.id, [taion.id]);
const savedTab = __state.tabs.Taion;
__state.tabs.Taion = undefined;                        // force a read failure
const broke = await syncAssignmentToUserTabs({ site, beforeUserIds: [], afterUserIds: [taion.id], actor, source: 'offline test' });
__state.tabs.Taion = savedTab;
console.log('\n  G. forced sheet failure ->', JSON.stringify(broke));
const stillAssigned = db.getSiteById(site.id).assignedUsers || [];
t('G. DB assignment survived the sheet failure', stillAssigned.includes(taion.id), stillAssigned);
t('G. failure was reported, not swallowed', broke.failed.length === 1, broke);
t('G. failure recorded as a conflict', db.getSyncConflicts().some((c) => c.entityId === `${site.id}:${taion.id}`));

// ══ H. Assignment marker column ══
// H1: add the marker safely (dry-run first, then real).
const markerDry = await ensureAssignmentMarkerColumn({ tabName: 'Sabbir', sheetId: 'fake', dryRun: true });
console.log('\n  H1. dry-run marker add ->', JSON.stringify(markerDry));
t('H1. dry-run plans an add', markerDry.action === 'would-add', markerDry);
t('H1. dry-run targets the first column empty across header AND data', markerDry.col === 5, markerDry);
t('H1. dry-run wrote NOTHING', !__state.cellWrites.some((w) => w.tabName === 'Sabbir'), __state.cellWrites);

const markerReal = await ensureAssignmentMarkerColumn({ tabName: 'Sabbir', sheetId: 'fake' });
t('H1. real add reports added', markerReal.action === 'added', markerReal);
t('H1. header now reads Assignment in the planned cell', __state.tabs.Sabbir[0][5] === 'Assignment', __state.tabs.Sabbir[0]);
t('H1. re-running is idempotent (already-present, no second write)',
  (await ensureAssignmentMarkerColumn({ tabName: 'Sabbir', sheetId: 'fake' })).action === 'already-present');

// H2: REGRESSION GUARD for the overwrite hazard. A tab whose data extends past
// its last header (real Taion: col 9 stray; real Asif: 18 booking URLs) must NOT
// have its data column chosen as the marker slot.
__state.tabs.Taion[1][5] = 'Plugings update option not found';   // data, no header
t('H2. setup: Taion has data one column past its header', __state.tabs.Taion[0].length === 5 && __state.tabs.Taion[1][5], { headerLen: __state.tabs.Taion[0].length });
const taionMarker = await ensureAssignmentMarkerColumn({ tabName: 'Taion', sheetId: 'fake' });
console.log('\n  H2. Taion marker add ->', JSON.stringify(taionMarker));
t('H2. skips the data column and uses the one after it', taionMarker.col === 6, taionMarker);
t('H2. the existing data cell was NOT overwritten', __state.tabs.Taion[1][5] === 'Plugings update option not found', __state.tabs.Taion[1]);
t('H2. the header went in the safe column', __state.tabs.Taion[0][6] === 'Assignment', __state.tabs.Taion[0]);

// H3: a newly appended row is known-assigned, so it is stamped "Assigned".
const stamped = await ensureSiteRowInUserTab({ siteUrl: 'https://marker-stamped-example.com/', userName: 'Sabbir' });
t('H3. append succeeded', stamped.action === 'appended', stamped);
t('H3. report exposes the marker column', stamped.markerColumn === 5, stamped);
t('H3. row is stamped Assigned', __state.tabs.Sabbir[__state.tabs.Sabbir.length - 1][5] === 'Assigned', __state.tabs.Sabbir[__state.tabs.Sabbir.length - 1]);
t('H3. URL still in the resolved col 0', __state.tabs.Sabbir[__state.tabs.Sabbir.length - 1][0] === 'https://marker-stamped-example.com/');

// H4: unassign now marks the row instead of flagging no-marker-column.
const soft = await softRemoveSiteRowFromUserTab({ siteUrl: 'https://marker-stamped-example.com/', userName: 'Sabbir' });
console.log('\n  H4. soft remove ->', JSON.stringify(soft));
t('H4. soft-removed (marker column found)', soft.action === 'soft-removed', soft);
const stampedUrl = 'https://marker-stamped-example.com/';
const stampedIdx = __state.tabs.Sabbir.findIndex((r) => r[0] === stampedUrl);
t('H4. URL is STILL in the row (nothing deleted)', stampedIdx !== -1);
t('H4. the marker cell says Unassigned, in the right row',
  soft.action === 'soft-removed' && stampedIdx !== -1 && __state.tabs.Sabbir[stampedIdx][5] === 'Unassigned',
  { cell: soft.cell, rowNumber: soft.rowNumber, row: __state.tabs.Sabbir[stampedIdx] });

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
