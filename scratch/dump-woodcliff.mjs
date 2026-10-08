import { getAllAccountConfigs } from 'file:///C:/Users/toufi_qicjadj/Downloads/maintenance-mailer/src/config.js';
import { listTabTitles, getTabValues } from 'file:///C:/Users/toufi_qicjadj/Downloads/maintenance-mailer/src/sheets.js';

const colLetter = (i) => { let s = ''; i++; while (i > 0) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; };

for (const acct of getAllAccountConfigs()) {
  let titles = [];
  try { titles = await listTabTitles(acct.spreadsheetId); } catch { continue; }
  const tab = titles.find((t) => (t || '').toLowerCase().includes('woodcliffhotelspa'));
  if (!tab) continue;
  const full = await getTabValues(tab, 'A1:Z300', acct.spreadsheetId);
  console.log(`tab=${JSON.stringify(tab)}  rows=${full.length}\n`);
  console.log('every non-empty cell, rows 1-14:');
  for (let i = 0; i < Math.min(14, full.length); i++) {
    const cells = [];
    (full[i] || []).forEach((c, ci) => {
      const v = String(c ?? '').trim();
      if (v) cells.push(`${colLetter(ci)}=${JSON.stringify(v.slice(0, 34))}`);
    });
    console.log(`  row ${String(i + 1).padStart(2)}: ${cells.length ? cells.join('  ') : '(entirely empty)'}`);
  }
}
