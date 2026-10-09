/**
 * READ-ONLY. Which tab is gid=1790440627, and how many tabs match "woodcliff"?
 * Prints every tab in the CW spreadsheet with its sheetId/title, then dumps the
 * gid the operator pointed at.
 */
import { getSheetsClient } from 'file:///C:/Users/toufi_qicjadj/Downloads/maintenance-mailer/src/sheets.js';
import { getAllAccountConfigs } from 'file:///C:/Users/toufi_qicjadj/Downloads/maintenance-mailer/src/config.js';

const TARGET_GID = 1790440627;
const colLetter = (i) => { let s = ''; i++; while (i > 0) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; };

const cw = getAllAccountConfigs().find((a) => a.key === 'CW');
console.log(`CW spreadsheetId = ${cw.spreadsheetId}\n`);

const sheets = await getSheetsClient();
const meta = await sheets.spreadsheets.get({
  spreadsheetId: cw.spreadsheetId,
  fields: 'sheets(properties(sheetId,title,index,gridProperties(rowCount,columnCount)))',
});

const tabs = meta.data.sheets.map((s) => s.properties);
console.log(`total tabs: ${tabs.length}`);
console.log('\ntabs matching /woodcliff/i:');
for (const t of tabs) {
  if (/woodcliff/i.test(t.title)) {
    console.log(`  gid=${String(t.sheetId).padEnd(12)} title=${JSON.stringify(t.title)}`);
  }
}

const target = tabs.find((t) => String(t.sheetId) === String(TARGET_GID));
console.log(`\ngid ${TARGET_GID} -> ${target ? JSON.stringify(target.title) : 'NOT FOUND'}`);
if (!target) process.exit(0);

const res = await sheets.spreadsheets.values.get({
  spreadsheetId: cw.spreadsheetId,
  range: `'${target.title.replace(/'/g, "''")}'!A1:Z30`,
});
const rows = res.data.values || [];
console.log(`\n--- rows 1-16 of ${JSON.stringify(target.title)} (A1:Z30, ${rows.length} rows) ---`);
for (let i = 0; i < Math.min(16, rows.length); i++) {
  const cells = [];
  (rows[i] || []).forEach((c, ci) => {
    const v = String(c ?? '').trim();
    if (v) cells.push(`${colLetter(ci)}=${JSON.stringify(v.slice(0, 34))}`);
  });
  console.log(`  row ${String(i + 1).padStart(2)}: ${cells.length ? cells.join('  ') : '(empty)'}`);
}

// also dump the tab my earlier probe matched, by title
const earlier = tabs.find((t) => (t.title || '').toLowerCase().includes('https://woodcliffhotelspa'));
if (earlier && earlier.title !== target.title) {
  console.log(`\n--- for comparison, the tab my probe matched: ${JSON.stringify(earlier.title)} (gid=${earlier.sheetId}) ---`);
  const r2 = await sheets.spreadsheets.values.get({
    spreadsheetId: cw.spreadsheetId,
    range: `'${earlier.title.replace(/'/g, "''")}'!A1:Z12`,
  });
  for (let i = 0; i < Math.min(12, (r2.data.values || []).length); i++) {
    const cells = [];
    ((r2.data.values || [])[i] || []).forEach((c, ci) => {
      const v = String(c ?? '').trim();
      if (v) cells.push(`${colLetter(ci)}=${JSON.stringify(v.slice(0, 34))}`);
    });
    console.log(`  row ${String(i + 1).padStart(2)}: ${cells.length ? cells.join('  ') : '(empty)'}`);
  }
}
