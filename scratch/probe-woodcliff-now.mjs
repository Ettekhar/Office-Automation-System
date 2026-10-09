import { getAllAccountConfigs } from 'file:///C:/Users/toufi_qicjadj/Downloads/maintenance-mailer/src/config.js';
import { getSheetsClient } from 'file:///C:/Users/toufi_qicjadj/Downloads/maintenance-mailer/src/sheets.js';
import { findUnsectionedRows, getSectionHeaderType } from 'file:///C:/Users/toufi_qicjadj/Downloads/maintenance-mailer/src/reportUtils.js';

const cw = getAllAccountConfigs().find((a) => a.key === 'CW');
const sheets = await getSheetsClient();
const TAB = 'https://woodcliffhotelspa.com';

const r = await sheets.spreadsheets.values.get({ spreadsheetId: cw.spreadsheetId, range: `'${TAB}'!A1:D4` });
console.log('first 4 rows, A:D:');
(r.data.values || []).forEach((row, i) => {
  const cells = (row || []).map((v, j) => String.fromCharCode(65 + j) + '=' + JSON.stringify(v));
  console.log(`  row ${i + 1}: ${cells.join('  ') || '(empty)'}`);
});

const a1 = (r.data.values?.[0] || [])[0];
console.log(`\nA1 raw   : ${JSON.stringify(a1)}`);
console.log(`A1 codes : ${String(a1 ?? '').split('').map((c) => c.charCodeAt(0)).join(',') || '(none)'}`);
console.log(`A1 trim  : ${JSON.stringify(String(a1 ?? '').trim())}`);

const full = await sheets.spreadsheets.values.get({ spreadsheetId: cw.spreadsheetId, range: `'${TAB}'!A1:Z300` });
const rows = full.data.values || [];
console.log(`\nrows fetched (A1:Z300): ${rows.length}`);
const dropped = findUnsectionedRows(rows.map((x) => (x || []).slice(0, 4)));
console.log(`unsectioned rows now  : ${dropped.length}`);
console.log(`row1 header type      : ${getSectionHeaderType((rows[0] || []).slice(0, 4))}`);
console.log(`row1 as A:D           : ${JSON.stringify((rows[0] || []).slice(0, 4))}`);
