/**
 * READ-ONLY. Why does woodcliffhotelspa.com render no "Plugin Updated" band?
 * Prints every non-empty column-A cell (the section-header column), the parsed
 * sections, and an A1:D vs A1:Z render comparison for that one tab.
 */
import { getAllAccountConfigs } from 'file:///C:/Users/toufi_qicjadj/Downloads/maintenance-mailer/src/config.js';
import { listTabTitles, getTabValues } from 'file:///C:/Users/toufi_qicjadj/Downloads/maintenance-mailer/src/sheets.js';
import { parseReportSections, rowsToHtmlTable, getSectionHeaderType } from
  'file:///C:/Users/toufi_qicjadj/Downloads/maintenance-mailer/src/reportUtils.js';

const NEEDLE = 'woodcliffhotelspa';

for (const acct of getAllAccountConfigs()) {
  let titles = [];
  try { titles = await listTabTitles(acct.spreadsheetId); } catch { continue; }
  const tab = titles.find((t) => (t || '').toLowerCase().includes(NEEDLE));
  if (!tab) continue;

  console.log(`account=${acct.key}  tab=${JSON.stringify(tab)}`);
  const full = await getTabValues(tab, 'A1:Z300', acct.spreadsheetId);
  console.log(`rows fetched: ${full.length}\n`);

  const colA = [];
  full.forEach((r, i) => {
    const a = String(r?.[0] ?? '').trim();
    if (a) colA.push({ row: i + 1, a, filled: r.filter((c) => String(c ?? '').trim() !== '').length, type: getSectionHeaderType(r) });
  });
  console.log('non-empty column A (what section headers look like):');
  for (const c of colA.slice(0, 40)) {
    console.log(`  row ${String(c.row).padStart(3)}  filled(A:Z)=${String(c.filled).padStart(2)}  type=${String(c.type).padEnd(15)} ${JSON.stringify(c.a.slice(0, 55))}`);
  }
  if (colA.length > 40) console.log(`  ... ${colA.length - 40} more`);

  console.log('\nparsed sections (A:Z):');
  for (const s of parseReportSections(full)) {
    console.log(`  ${s.type.padEnd(16)} rows=${String(s.rows.length).padStart(3)}  header=${JSON.stringify(String(s.headerText).slice(0, 40))}`);
  }

  const asD = full.map((r) => r.slice(0, 4));
  const a = rowsToHtmlTable(asD).reportHtml;
  const b = rowsToHtmlTable(full).reportHtml;
  console.log(`\nrender A1:D = ${a.length} B   render A1:Z = ${b.length} B   identical=${a === b}`);
  console.log(`  A1:D has band: ${/Plugin Updat/i.test(a)}   A1:Z has band: ${/Plugin Updat/i.test(b)}`);
  console.log(`  A1:D 'To Version' cells: ${(a.match(/To Version/g) || []).length}`);
}
