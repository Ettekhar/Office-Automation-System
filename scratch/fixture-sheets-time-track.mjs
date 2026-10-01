/** Fixture standing in for src/sheets.js — two real master-tab layouts. */
export const CALLS = { listTabTitles: [], getTabValues: [] };

// Layout overrides, so one suite can also cover sheets that do not carry the
// column at all and cells that are padded. Both are real conditions: a sheet
// predating the column, and a cell someone typed with a trailing space.
const STATE = { dropColumn: false, padCells: false };

export function setLayout({ dropColumn = false, padCells = false } = {}) {
  STATE.dropColumn = dropColumn;
  STATE.padCells = padCells;
}

const pad = (v) => (STATE.padCells ? `  ${v} ` : v);

export async function listTabTitles(spreadsheetId) {
  CALLS.listTabTitles.push(spreadsheetId);
  return [];
}

export async function getTabValues(tabName, range, spreadsheetId) {
  CALLS.getTabValues.push({ tabName, range, spreadsheetId });
  const isCW = String(spreadsheetId).startsWith('cw-');
  if (isCW) {
    const header = ['si', 'CMS', 'Company', 'Contact', 'A/C Manager', 'Note', 'Website URL'];
    // A sheet that predates the time-track column simply has no such header.
    if (!STATE.dropColumn) header.push('Maintenance time tracking ClickUp URL');
    header.push('Maintenance Task ClickUp URL', 'Maintenance Report URL',
      'Backup URL', 'March 22', 'April 22', 'May 22');
    const tt = STATE.dropColumn
      ? 'https://app.clickup.com/t/868j7v43c'   // the Task column shifted into the gap
      : pad('https://app.clickup.com/t/8687wvcgm');
    return [
      ['filler'],
      header,
      // Time track FILLED, task link also filled — a wrong index would confuse them.
      ['Active', 'WordPress', 'Acme Co', 'a@b.com', 'Jo', 'note', 'cw-filled.test',
        tt, 'https://app.clickup.com/t/868j7v43c',
        'https://docs.google.com/1', 'https://backup/1', 'DONE', ''],
      // Time track BLANK, task link filled.
      ['Active', 'WordPress', 'Blank Co', 'c@d.com', 'Jo', '', 'cw-blank.test',
        '', 'https://app.clickup.com/t/868j7v43c', '', '', '', ''],
    ];
  }
  return [
    ['filler'],
    ['', 'CMS', 'Company', 'Contact', 'A/C Manager', 'Website URL',
      'Maintenance time tracking ClickUp URL', 'Maintenance Task ClickUp Link',
      'March 22', 'April 22', 'May 22'],
    ['Active', 'WordPress', 'RM Co', 'e@f.com', 'Sam', 'rm-filled.test',
      'https://app.clickup.com/t/868wvcgm', 'https://app.clickup.com/t/868j7v43c', 'DONE', '', ''],
    // Time track BLANK, task link filled. RM puts time track at 6 and task at 7,
    // so a hardcoded 7 returns the task link here.
    ['Active', 'WordPress', 'RM Blank', 'g@h.com', 'Sam', 'rm-blank.test',
      '', 'https://app.clickup.com/t/SHOULD-NOT-SHOW', 'DONE', '', ''],
  ];
}

export default { listTabTitles, getTabValues };
