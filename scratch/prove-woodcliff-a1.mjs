/**
 * READ-ONLY falsification: is the single space in A1 the ONLY reason
 * woodcliffhotelspa renders no plugin table?
 * Renders the tab as-is, then patches row1[0] = "Plugin Updated" in memory
 * (no sheet write) and renders again.
 */
import { getSheetsClient } from 'file:///C:/Users/toufi_qicjadj/Downloads/maintenance-mailer/src/sheets.js';
import { getAllAccountConfigs } from 'file:///C:/Users/toufi_qicjadj/Downloads/maintenance-mailer/src/config.js';
import { rowsToHtmlTable, getSectionHeaderType } from 'file:///C:/Users/toufi_qicjadj/Downloads/maintenance-mailer/src/reportUtils.js';

const cw = getAllAccountConfigs().find((a) => a.key === 'CW');
const sheets = await getSheetsClient();
const res = await sheets.spreadsheets.values.get({
  spreadsheetId: cw.spreadsheetId,
  range: `'https://woodcliffhotelspa.com'!A1:Z300`,
});
const raw = res.data.values || [];

const row1 = raw[0] || [];
console.log(`A1 raw value     : ${JSON.stringify(row1[0])}`);
console.log(`A1 trimmed       : ${JSON.stringify(String(row1[0] ?? '').trim())}`);
console.log(`A1 :D as fetched : ${JSON.stringify(row1.slice(0, 4))}`);
console.log(`header type, A:D : ${getSectionHeaderType(row1.slice(0, 4))}`);
console.log(`header type, A:Z : ${getSectionHeaderType(row1)}`);

const before = rowsToHtmlTable(raw).reportHtml;
console.log(`\nas-is      : ${before.length} B  band=${/Plugin Updated/.test(before)}  'To Version'=${(before.match(/To Version/g) || []).length}`);

// the ONLY change: fill A1 with the header text
const patched = raw.map((r, i) => (i === 0 ? ['Plugin Updated', ...(r || []).slice(1)] : r));
const after = rowsToHtmlTable(patched).reportHtml;
console.log(`A1 filled  : ${after.length} B  band=${/Plugin Updated/.test(after)}  'To Version'=${(after.match(/To Version/g) || []).length}`);
console.log(`\nheader type after patch, A:D : ${getSectionHeaderType(patched[0].slice(0, 4))}`);
console.log(`\nverdict: filling that one cell is ${/Plugin Updated/.test(after) && !/Plugin Updated/.test(before) ? 'SUFFICIENT' : 'NOT sufficient'} to make the table render`);
