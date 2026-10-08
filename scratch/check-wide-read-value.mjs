/**
 * READ-ONLY. Does reading past column D actually buy anything?
 * Scans E..Z of every report tab for conditional-note-shaped cells
 * ("<condition>:<link>" or a bare registered condition standing alone),
 * which is the only thing A1:Z300 could see that A1:D200 could not.
 */
import { getAllAccountConfigs } from 'file:///C:/Users/toufi_qicjadj/Downloads/maintenance-mailer/src/config.js';
import { listTabTitles, getTabValues } from 'file:///C:/Users/toufi_qicjadj/Downloads/maintenance-mailer/src/sheets.js';
import { getConditionalNotes } from 'file:///C:/Users/toufi_qicjadj/Downloads/maintenance-mailer/src/db.js';

const accounts = getAllAccountConfigs();
const colLetter = (i) => { let s = ''; i++; while (i > 0) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; };

let hits = 0, tabsScanned = 0;

for (const acct of accounts) {
  const notes = getConditionalNotes({ account: acct.key, enabledOnly: true }) || [];
  const keys = notes.map((n) => String(n.condition ?? '').trim().toLowerCase()).filter(Boolean);
  if (!keys.length) continue;

  let titles = [];
  try { titles = await listTabTitles(acct.spreadsheetId); } catch { continue; }

  for (const tab of titles.filter((t) => t && t !== acct.masterTabName)) {
    tabsScanned++;
    let rows = [];
    try { rows = await getTabValues(tab, 'A1:Z300', acct.spreadsheetId); } catch { continue; }

    rows.forEach((row, ri) => {
      const filledInRow = row.reduce((n, c) => (String(c ?? '').trim() ? n + 1 : n), 0);
      row.forEach((cell, ci) => {
        if (ci < 4) return;                          // A..D were always read
        const v = String(cell ?? '').trim();
        if (!v) return;
        const [head] = v.split(':');
        const bare = head.trim().toLowerCase();
        const isKey = keys.includes(bare);
        const colonMatch = v.includes(':') && keys.includes(bare);
        if (isKey && (colonMatch || filledInRow === 1)) {
          hits++;
          console.log(`  NOTE past col D: [${acct.key}] "${tab}" ${colLetter(ci)}${ri + 1} = ${JSON.stringify(v.slice(0, 70))}`);
        }
      });
    });
  }
}
console.log(`\n  tabs scanned: ${tabsScanned}`);
console.log(`  conditional-note-shaped cells in E..Z: ${hits}`);
console.log(hits === 0
  ? '  => reading past column D buys NOTHING for conditional notes.'
  : '  => the wide read IS used by conditional notes; do not simply revert.');
