/**
 * Fake Sheets layer for the isolated write-back test.
 * Mirrors the REAL Daily Review per-user tab shape (verified 2026-09-25):
 *   header = [" ", "Website", "Maintenance", "Maintenance Report Sent", ...]
 *   col 0  = website domains (the header is a blank placeholder!)
 *   col 1  = account labels ("CW"/"RM") despite being titled "Website"
 * A "Booking / Reservation Link" column is included so the trap is live:
 * a header-only resolver would pick it, the canonical resolver must not.
 */
export const __state = {
  tabs: {
    Sabbir: [
      [' ', 'Website', 'Maintenance', 'Maintenance Report Sent', 'Booking / Reservstion Link'],
      ['https://already-listed-example.com/', 'CW', 'To Do', 'No', ''],
      ['https://second-listed-example.com/', 'CW', 'To Do', 'No', 'https://resy.com/venues/x'],
    ],
    Medul: [
      ['-', 'Website URL', 'Website', 'Maintenance', 'Maintenance Report Sent'],
      ['1', 'governorsinnnd.com', 'CW', 'To Do', 'No'],
      ['2', 'diamondconferencecenter.com', 'CW', 'To Do', 'No'],
    ],
    Taion: [
      [' ', '', 'Maintenance', 'Maintenance Report Sent', 'Booking / Reservstion Link'],
      ['https://horizonsmodernkitchen.com/', 'CW', 'To Do', 'No', 'https://resy.com/cities/x'],
    ],
  },
  appends: [],
  cellWrites: [],
};

export async function listTabMeta(spreadsheetId = null) {
  return Object.keys(__state.tabs).map((title) => ({ properties: { title } }));
}

export async function getTabValues(tabName, range = 'A1:ZZ2000', spreadsheetId = null) {
  const rows = __state.tabs[tabName];
  if (!rows) { const e = new Error(`Unable to parse range: ${tabName}`); throw e; }
  // Honor a single-row header range like A1:ZZ1 for fidelity.
  const m = String(range).match(/^A(\d+):ZZ(\d+)$/);
  if (m) {
    const start = Number(m[1]);
    const end = Number(m[2]);
    return rows.slice(start - 1, end);
  }
  return rows;
}

export async function appendSheetRow(spreadsheetId, tabName, rowValues) {
  const rows = __state.tabs[tabName];
  if (!rows) throw new Error(`No such tab: ${tabName}`);
  rows.push(rowValues);
  const n = rows.length; // header is row 1, so this is the 1-based sheet row
  __state.appends.push({ tabName, rowNumber: n, values: [...rowValues] });
  // FAITHFUL TO THE REAL API AS OBSERVED LIVE 2026-09-25: the append succeeds
  // but `updates.updatedRange` comes back without a usable row number, so a
  // naive caller records no rowIndex. The fake reproduces that on purpose so
  // the offline suite exercises the tab-rescan fallback instead of hiding it.
  return { updates: { updatedRange: `__unparseable__${n}` } };
}

export async function updateSheetCell(spreadsheetId, tabName, a1Notation, value) {
  __state.cellWrites.push({ tabName, cell: a1Notation, value });
  const m = String(a1Notation).match(/^([A-Z]+)(\d+)$/);
  if (m) {
    const col = m[1].split('').reduce((acc, ch) => acc * 26 + (ch.charCodeAt(0) - 64), 0) - 1;
    const row = Number(m[2]) - 1;
    const rows = __state.tabs[tabName];
    if (rows && rows[row]) rows[row][col] = value;
  }
  return { updatedRange: `'${tabName}'!${a1Notation}` };
}

export function colIndexToA1(colIndex) {
  let n = colIndex, s = '';
  while (n >= 0) { s = String.fromCharCode((n % 26) + 65) + s; n = Math.floor(n / 26) - 1; }
  return s;
}

export function invalidateCacheForSpreadsheet() {}
