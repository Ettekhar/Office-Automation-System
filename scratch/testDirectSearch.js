import { listTabTitles, getTabValues } from '../src/sheets.js';
import { resolveConditionalNotes } from '../src/reportUtils.js';
import { getConditionalNotes } from '../src/db.js';

async function test() {
  const account = 'CW';
  const sheetId = '1Ua3ttqdT7AkiDCHlq6WyMIotRfXGTWWhw7Hzm-c4im8'; // CW sheet ID
  
  try {
    const tabs = await listTabTitles(sheetId);
    
    for (let i = 2; i < 20; i++) { // just check a few to avoid 429
      const tabName = tabs[i];
      const reportRows = await getTabValues(tabName, 'A1:Z300', sheetId);
      for (const row of reportRows) {
        for (const cell of row) {
          if (String(cell).toLowerCase().includes('a11y')) {
            console.log(`FOUND a11y in ${tabName}:`, cell);
          }
        }
      }
    }
  } catch(e) {
    console.error(e);
  }
}

test();
