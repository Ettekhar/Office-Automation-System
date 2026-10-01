/**
 * Zero-write regression check for the Daily Review writer.
 *
 * A missing target makes batchUpdateDailyReviewTab() resolve the sheet-manager
 * credential, read the real tab, and return before batchUpdate. That exercises
 * the formerly broken getSheetCredentials path without changing a single cell.
 */
import { getTabValues } from '../src/sheets.js';
import { batchUpdateDailyReviewTab } from '../src/sheets.js';
import { getDailyReviewSheetId } from '../src/userTabWriteBack.js';

const userName = 'Sabbir'; // active user
const { id: sheetId } = getDailyReviewSheetId();
const before = await getTabValues(userName, 'A:ZZ', sheetId);
const result = await batchUpdateDailyReviewTab({
  userName,
  updates: [{
    siteUrl: '__credential-resolution-probe.invalid__',
    rowIndex: null,
    maintenanceRaw: 'this value must never be written',
    maintenanceStatus: 'todo',
  }],
});
const after = await getTabValues(userName, 'A:ZZ', sheetId);
const unchanged = JSON.stringify(before) === JSON.stringify(after);
const ok = result?.success === true && result?.written === 0 && unchanged;
console.log(`  writer result: ${JSON.stringify(result)}`);
console.log(`  ${userName} tab byte-identical: ${unchanged}`);
console.log(`  ${ok ? 'ok  ' : 'FAIL'} credential-resolution path is live and the probe wrote nothing`);
if (!ok) process.exit(1);
