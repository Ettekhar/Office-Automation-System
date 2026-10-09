/**
 * READ-ONLY. Compare the top rows of tabs that render vs woodcliffhotelspa.
 * Focus: what sits in row 1 column A across the CW spreadsheet.
 */
import { getSheetsClient } from 'file:///C:/Users/toufi_qicjadj/Downloads/maintenance-mailer/src/sheets.js';
import { getAllAccountConfigs } from 'file:///C:/Users/toufi_qicjadj/Downloads/maintenance-mailer/src/config.js';

const cw = getAllAccountConfigs().find((a) => a.key === 'CW');
const sheets = await getSheetsClient();
const meta = await sheets.spreadsheets.get({
  spreadsheetId: cw.spreadsheetId,
  fields: 'sheets(properties(sheetId,title))',
});
const tabs = meta.data.sheets.map((s) => s.properties);

// sample: woodcliffhotelspa + a handful of others that rendered fine
const wanted = [
  'https://woodcliffhotelspa.com',
  'https://tcrmservices.com',
  'https://www.theguildhotel.com',
  'https://applevalleyrestaurant.com',
];

for (const title of wanted) {
  const t = tabs.find((x) => x.title.toLowerCase() === title.toLowerCase())
    || tabs.find((x) => x.title.toLowerCase().includes(title.replace('https://', '').toLowerCase()));
  if (!t) { console.log(`\n${title}: tab not found`); continue; }
  const r = await sheets.spreadsheets.values.get({
    spreadsheetId: cw.spreadsheetId,
    range: `'${t.title.replace(/'/g, "''")}'!A1:D3`,
  });
  const rows = r.data.values || [];
  console.log(`\n${JSON.stringify(t.title)}  gid=${t.sheetId}`);
  rows.forEach((row, i) => {
    console.log(`  row ${i + 1}: A=${JSON.stringify(row[0] ?? '')}  B=${JSON.stringify((row[1] ?? '').slice(0, 32))}  C=${JSON.stringify(row[2] ?? '')}  D=${JSON.stringify(row[3] ?? '')}`);
  });
}

// and: the F-K scaffold on row 1 for each — the thing the header test counts
console.log('\n--- row 1, columns A:K (what getSectionHeaderType counts) ---');
for (const t of tabs) {
  if (!/woodcliffhotelspa|tcrmservices|guildhotel|applevalleyrestaurant/i.test(t.title)) continue;
  const r = await sheets.spreadsheets.values.get({
    spreadsheetId: cw.spreadsheetId,
    range: `'${t.title.replace(/'/g, "''")}'!A1:K1`,
  });
  const cells = (r.data.values?.[0] || []).map((c) => String(c ?? '').trim());
  const filled = cells.filter(Boolean);
  console.log(`  ${String(t.title).padEnd(42)} filled=${filled.length}  [${filled.map((v) => v.slice(0, 18)).join(' | ')}]`);
}
