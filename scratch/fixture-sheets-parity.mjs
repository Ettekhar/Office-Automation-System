/**
 * Fixture standing in for src/sheets.js, for the eligibility parity suite.
 *
 * The point of this fixture is that it is NOT a happy path. Every guard in
 * src/index.js gets at least one row that trips it, plus the two guards that
 * bail out silently (blank URL, invalid URL) and the note-prefixed URL that
 * isValidWebsiteUrl rejects on purpose. If the Worker's planner and the CLI
 * ever disagree about who gets mail, it will disagree here.
 *
 * The account is resolved from the real spreadsheet id via src/config.js, so
 * this works with whatever ids .env happens to hold and never needs updating.
 *
 * EXPORTED so the parity suite can declare, per row, what BOTH sides must do
 * with it. The suite then checks the CLI and the Worker against that same
 * table, which pins each side independently instead of only pinning that the
 * two agree (two wrong planners can agree with each other).
 */

import { getAllAccountConfigs } from '../src/config.js';

const ID_TO_KEY = new Map(getAllAccountConfigs().map((a) => [a.spreadsheetId, a.key]));

export const CALLS = { listTabTitles: [], getTabValues: [] };

// Real CW layout: status, CMS, Company, Contact, A/C Manager, Note, Website URL,
// then the time-track and task columns, then month columns.
const CW_HEADER = [
  'si', 'CMS', 'Company', 'Contact', 'A/C Manager', 'Note', 'Website URL',
  'Maintenance time tracking ClickUp URL', 'Maintenance Task ClickUp URL',
  'Maintenance Report URL', 'Backup URL', 'March 22', 'April 22', 'May 22',
];

// Real RM layout: no si column, and the time-track column sits one position
// earlier than CW's. A hardcoded index would read the Task link here.
const RM_HEADER = [
  'si', 'CMS', 'Company', 'Contact', 'A/C Manager', 'Note', 'Website URL',
  'Maintenance time tracking ClickUp URL', 'Maintenance Task ClickUp Link',
  'March 22', 'April 22', 'May 22',
];

const DONE = 'updated & backup';

// resolveMonthColumn(header, first, null) returns the LAST month column, not the
// first — that is what the real sheets look like, since the current month is the
// newest column. Deriving the index from the header rather than hardcoding it
// means adding or removing a month column cannot silently move the marker into
// an empty cell and turn every row into "not done".
export const MONTH_COL = {
  CW: CW_HEADER.length - 1,
  RM: RM_HEADER.length - 1,
};

const blankRow = (n) => new Array(n).fill('');

const cw = (status, company, contact, url, monthCell, extra = {}) => {
  const r = blankRow(CW_HEADER.length);
  r[0] = status; r[2] = company; r[3] = contact; r[4] = 'Jo'; r[6] = url;
  r[7] = extra.timeTrack ?? ''; r[8] = extra.task ?? '';
  r[MONTH_COL.CW] = monthCell;
  return r;
};

const rm = (status, company, contact, url, monthCell, extra = {}) => {
  const r = blankRow(RM_HEADER.length);
  r[0] = status; r[2] = company; r[3] = contact; r[4] = 'Sam'; r[6] = url;
  r[7] = extra.timeTrack ?? ''; r[8] = extra.task ?? '';
  r[MONTH_COL.RM] = monthCell;
  return r;
};

const CW_ROWS = [
  ['filler row above the header'],
  CW_HEADER,
  // 1 — the plain case: everything in order, time-track URL present.
  cw('Active', 'Acme Co', 'a@b.com', 'cw-ok.test', DONE, { timeTrack: 'https://app.clickup.com/t/tt-1' }),
  // 2 — inactive. Passes every other check, so it can only be caught by isActive.
  cw('Inactive', 'Dormant Co', 'dormant@b.com', 'cw-inactive.test', DONE),
  // 3 — active but the month cell is not done.
  cw('Active', 'Halfway Co', 'half@b.com', 'cw-notdone.test', 'in progress'),
  // 4 — done, but no contact email. The contact cell holds text, not an address.
  cw('Active', 'NoContact Co', 'ask us on the forum', 'cw-nocontact.test', DONE),
  // 5 — done and contactable, but no tab of that name exists.
  cw('Active', 'NoTab Co', 'notab@b.com', 'cw-notab.test', DONE),
  // 6 — not a URL. Skipped silently by both, with no skip reason recorded.
  cw('Active', 'Junk Co', 'junk@b.com', 'not a url', DONE),
  // 7 — blank URL. Same silent skip.
  cw('Active', 'Blank Co', 'blank@b.com', '', DONE),
  // 8 — note-prefixed URL, the bad-data pattern isValidWebsiteUrl exists for.
  cw('Active', 'Note Co', 'note@b.com', 'note: ask before mailing', DONE),
  // 9 — done, no time-track URL. Queues, and ClickUp must stay 'none'.
  cw('Active', 'NoTrack Co', 'notrack@b.com', 'cw-notrack.test', DONE),
  // 10 — done marker written in a different case. Must still count as done.
  cw('Active', 'Case Co', 'case@b.com', 'cw-case.test', 'UPDATED & BACKUP'),
  // 11 — two contacts, one of them junk. Only the valid one is taken.
  cw('Active', 'Two Co', 'one@b.com, two@b.com, not-an-email', 'cw-two.test', DONE),
  // 12 — tab exists under the full https:// form; the cell has a trailing slash.
  cw('Active', 'Scheme Co', 'scheme@b.com', 'https://cw-scheme.test/', DONE),
  // 13 — month cell is empty, which is "not done" rather than an error.
  cw('Active', 'EmptyMonth Co', 'empty@b.com', 'cw-emptymonth.test', ''),
  // 14 — status cell blank. isActive requires it to start with "active".
  (() => { const r = cw('', 'NoStatus Co', 'nostatus@b.com', 'cw-nostatus.test', DONE); r[0] = ''; return r; })(),
  // 15 — BOTH guards fail: inactive AND the month is not done. src/index.js asks
  //      about status first, so the recorded reason must be "inactive". A planner
  //      that checks the month first reports the same site under a different
  //      reason and a different dashboard bucket, with no error anywhere — this
  //      row is the only thing in the fixture that can see that.
  cw('Inactive', 'Both Co', 'both@b.com', 'cw-both.test', 'in progress'),
];

const RM_ROWS = [
  ['filler'],
  RM_HEADER,
  rm('Active', 'RM Acme', 'e@f.com', 'rm-ok.test', DONE, { timeTrack: 'https://app.clickup.com/t/rm-1' }),
  rm('Inactive', 'RM Dormant', 'rmd@f.com', 'rm-inactive.test', DONE),
  rm('Active', 'RM Half', 'rmh@f.com', 'rm-notdone.test', 'pending'),
  rm('Active', 'RM NoContact', 'ring the office', 'rm-nocontact.test', DONE),
  rm('Active', 'RM NoTab', 'rmnt@f.com', 'rm-notab.test', DONE),
  // Time-track blank, task link filled — a hardcoded 7 would send the task link.
  rm('Active', 'RM NoTrack', 'rmntk@f.com', 'rm-notrack.test', DONE, { task: 'https://app.clickup.com/t/SHOULD-NOT-SHOW' }),
  rm('Inactive', 'RM Both', 'rmboth@f.com', 'rm-both.test', 'in progress'),
];

/**
 * Tab titles. Every "queued" row below has one; the two no-tab rows deliberately
 * have none, so the "no matching report tab" guard is genuinely exercised rather
 * than accidentally satisfied.
 */
const CW_TABS = ['Website List', 'cw-ok.test', 'cw-inactive.test', 'cw-notdone.test',
  'cw-nocontact.test', 'cw-notrack.test', 'cw-case.test',
  'cw-two.test', 'https://cw-scheme.test', 'cw-emptymonth.test', 'cw-nostatus.test'];

const RM_TABS = ['Website List', 'rm-ok.test', 'rm-inactive.test', 'rm-notdone.test',
  'rm-nocontact.test', 'rm-notrack.test'];

const DATA = {
  CW: { rows: CW_ROWS, tabs: CW_TABS },
  RM: { rows: RM_ROWS, tabs: RM_TABS },
};

export const FIXTURE = DATA;

/**
 * The truth table. `outcome` is what a correct planner must decide:
 *   queued  → mail goes out; `recipients` and `tab` are then also asserted
 *   <reason> → no mail; `reason` is the planner's own skip reason
 *   silent   → not a URL, so the row is dropped with no reason recorded
 */
export const EXPECTED = {
  CW: [
    { url: 'cw-ok.test', outcome: 'queued', recipients: ['a@b.com'], tab: 'cw-ok.test' },
    { url: 'cw-inactive.test', outcome: 'inactive' },
    { url: 'cw-notdone.test', outcome: 'month cell not marked done' },
    { url: 'cw-nocontact.test', outcome: 'no contact email' },
    { url: 'cw-notab.test', outcome: 'no matching report tab', recipients: ['notab@b.com'] },
    { url: 'not a url', outcome: 'silent' },
    { url: '', outcome: 'silent' },
    { url: 'note: ask before mailing', outcome: 'silent' },
    { url: 'cw-notrack.test', outcome: 'queued', recipients: ['notrack@b.com'], tab: 'cw-notrack.test' },
    { url: 'cw-case.test', outcome: 'queued', recipients: ['case@b.com'], tab: 'cw-case.test' },
    { url: 'cw-two.test', outcome: 'queued', recipients: ['one@b.com', 'two@b.com'], tab: 'cw-two.test' },
    { url: 'https://cw-scheme.test/', outcome: 'queued', recipients: ['scheme@b.com'], tab: 'https://cw-scheme.test' },
    { url: 'cw-emptymonth.test', outcome: 'month cell not marked done' },
    { url: 'cw-nostatus.test', outcome: 'inactive' },
    { url: 'cw-both.test', outcome: 'inactive' },
  ],
  RM: [
    { url: 'rm-ok.test', outcome: 'queued', recipients: ['e@f.com'], tab: 'rm-ok.test' },
    { url: 'rm-inactive.test', outcome: 'inactive' },
    { url: 'rm-notdone.test', outcome: 'month cell not marked done' },
    { url: 'rm-nocontact.test', outcome: 'no contact email' },
    { url: 'rm-notab.test', outcome: 'no matching report tab', recipients: ['rmnt@f.com'] },
    { url: 'rm-notrack.test', outcome: 'queued', recipients: ['rmntk@f.com'], tab: 'rm-notrack.test' },
    { url: 'rm-both.test', outcome: 'inactive' },
  ],
};

export async function listTabTitles(spreadsheetId) {
  CALLS.listTabTitles.push(spreadsheetId);
  const key = ID_TO_KEY.get(String(spreadsheetId));
  return key ? [...DATA[key].tabs] : [];
}

export async function getTabValues(tabName, range, spreadsheetId) {
  CALLS.getTabValues.push({ tabName, range, spreadsheetId });
  const key = ID_TO_KEY.get(String(spreadsheetId));
  if (!key) return [];
  // The master tab is the wide read; report tabs are the A1:D200 grid the
  // product fetches. Both matter: a planner that read the wrong one would look
  // plausible and send nothing.
  if (String(range).startsWith('A1:ZZ')) return DATA[key].rows.map((r) => [...r]);
  return [
    ['Website', 'Status', 'Action', 'Note'],
    ['Plugin Update', 'DONE', 'Updated all plugins', ''],
  ];
}

export default { listTabTitles, getTabValues };
