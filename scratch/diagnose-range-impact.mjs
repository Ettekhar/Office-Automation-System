/**
 * READ-ONLY. Does widening A1:D200 -> A1:Z300 actually change what an email
 * would render, on the real sheet?
 *
 * For every report tab we fetch A1:Z300 once, then feed rowsToHtmlTable()
 *   (a) the first 4 cells  = exactly what A1:D200 used to return
 *   (b) all 26 cells       = what A1:Z300 returns now
 * and report every tab where (a) and (b) disagree, plus the offending cell.
 */
import { getAllAccountConfigs } from 'file:///C:/Users/toufi_qicjadj/Downloads/maintenance-mailer/src/config.js';
import { listTabTitles, getTabValues } from 'file:///C:/Users/toufi_qicjadj/Downloads/maintenance-mailer/src/sheets.js';
import { rowsToHtmlTable, getSectionHeaderType } from
  'file:///C:/Users/toufi_qicjadj/Downloads/maintenance-mailer/src/reportUtils.js';

const HEADER_WORDS = /^(plugin updat|plugins updat|other$|deactivat|premium plugin|additional issue)/i;
const colLetter = (i) => {
  let s = ''; i++;
  while (i > 0) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); }
  return s;
};

const accounts = getAllAccountConfigs();
console.log(`accounts: ${accounts.map((a) => a.key).join(', ')}\n`);

let tabsChecked = 0, tabsDifferent = 0;
const findings = [];

for (const acct of accounts) {
  let titles;
  try { titles = await listTabTitles(acct.spreadsheetId); }
  catch (e) { console.log(`  [${acct.key}] listTabTitles failed: ${e.message}`); continue; }

  // Skip the master tab - it is not a per-site report tab.
  const reportTabs = titles.filter((t) => t && t !== acct.masterTabName);
  console.log(`[${acct.key}] ${reportTabs.length} report tab(s)`);

  for (const tab of reportTabs) {
    tabsChecked++;
    let full;
    try { full = await getTabValues(tab, 'A1:Z300', acct.spreadsheetId); }
    catch (e) { continue; }
    if (!full || !full.length) continue;

    const asD = full.map((r) => r.slice(0, 4));   // what A1:D200 returned

    let oldHtml, newHtml;
    try { oldHtml = rowsToHtmlTable(asD).reportHtml; } catch { continue; }
    try { newHtml = rowsToHtmlTable(full).reportHtml; } catch { continue; }

    if (oldHtml === newHtml) continue;

    tabsDifferent++;

    // Which header rows stopped being recognised, and what poisoned them?
    const broken = [];
    for (let i = 0; i < full.length; i++) {
      const aCell = String(full[i]?.[0] ?? '').trim();
      if (!HEADER_WORDS.test(aCell)) continue;
      const before = getSectionHeaderType(asD[i]);
      const after = getSectionHeaderType(full[i]);
      if (before && !after) {
        const filled = [];
        full[i].forEach((c, ci) => { if (String(c ?? '').trim() !== '') filled.push(`${colLetter(ci)}=${JSON.stringify(String(c).trim()).slice(0, 40)}`); });
        broken.push(`  row ${i + 1}: header ${JSON.stringify(aCell)} lost. filled cells in A:Z -> ${filled.join(' | ')}`);
      }
    }

    findings.push({ acct: acct.key, tab, lenOld: oldHtml.length, lenNew: newHtml.length, broken });
  }
}

console.log(`\n=== ${tabsChecked} tab(s) checked, ${tabsDifferent} render DIFFERENTLY under A1:Z300 ===\n`);
if (!findings.length) console.log('  none - widening the range changes nothing on the live sheet');
for (const f of findings) {
  console.log(`  [${f.acct}] "${f.tab}"  A1:D=${f.lenOld}B  A1:Z=${f.lenNew}B  (delta ${f.lenNew - f.lenOld}B)`);
  for (const b of f.broken) console.log(b);
}
