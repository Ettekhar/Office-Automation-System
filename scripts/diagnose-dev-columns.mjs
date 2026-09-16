/**
 * diagnose-dev-columns.mjs — READ-ONLY diagnostic.
 *
 * Dumps the raw header row + first rows of EVERY Dev Tracker tab, then prints
 * what fetchDevTrackerSheetData() actually parsed for each one — so we can see
 * tabs whose column layout differs from the assumed A:G
 * (URL, Status, Development-Date, Development-Updates, Feedbacks URL,
 *  Feedback-Date, Feedback-Note/Updates).
 *
 * Run: node scripts/diagnose-dev-columns.mjs [tabNameFilter]
 * Makes zero writes to Google Sheets.
 */

import { listTabTitles, getTabValues, fetchDevTrackerSheetData, DEV_TRACKER_SPREADSHEET_ID } from '../src/sheets.js';

const filter = process.argv[2] ? new RegExp(process.argv[2], 'i') : null;

console.log('Spreadsheet:', DEV_TRACKER_SPREADSHEET_ID);

const tabs = await listTabTitles(DEV_TRACKER_SPREADSHEET_ID);
console.log(`\n${tabs.length} tabs: ${JSON.stringify(tabs)}`);

for (const tab of tabs) {
  if (filter && !filter.test(tab)) continue;

  // A1:J6 — header row + a few data rows, enough to see the layout.
  const rows = await getTabValues(tab, 'A1:J6', DEV_TRACKER_SPREADSHEET_ID);
  console.log(`\n${'='.repeat(72)}\nTAB: "${tab}"  — full tab read (${(await getTabValues(tab, 'A1:G500', DEV_TRACKER_SPREADSHEET_ID)).length} rows)\n${'='.repeat(72)}`);
  rows.forEach((r, i) => {
    console.log(`  ${i === 0 ? 'HEADER' : `row ${String(i + 1).padStart(3)}`}: ${JSON.stringify(r)}`);
  });
}

console.log(`\n${'='.repeat(72)}\nPARSED BY fetchDevTrackerSheetData() — non-empty dev/feedback fields\n${'='.repeat(72)}`);
const projects = await fetchDevTrackerSheetData();
for (const p of projects) {
  if (filter && !filter.test(p.project)) continue;
  console.log(`\n── ${p.project} (${p.items.length} items)`);
  const interesting = p.items.filter((it) => it.isHeader || it.url || it.devDate || it.devNotes || it.feedbackUrl || it.date || it.notes);
  interesting.forEach((it) => {
    console.log(
      `  row ${String(it.rowNum).padStart(3)} | status=${JSON.stringify(it.status)}` +
      `\n        devDate=${JSON.stringify(it.devDate)} | devNotes=${JSON.stringify(it.devNotes)}` +
      `\n        feedbackUrl=${JSON.stringify(it.feedbackUrl)} | feedbackDate=${JSON.stringify(it.date)} | feedbackNotes=${JSON.stringify((it.notes || '').slice(0, 70))}`
    );
  });
}