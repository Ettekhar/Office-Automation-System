import { listTabTitles, getTabValues } from '../src/sheets.js';
import { resolveConditionalNotes } from '../src/reportUtils.js';
import { getConditionalNotes } from '../src/db.js';

async function test() {
  const account = 'CW';
  const sheetId = '1Ua3ttqdT7AkiDCHlq6WyMIotRfXGTWWhw7Hzm-c4im8'; // CW sheet ID
  
  try {
    const tabs = await listTabTitles(sheetId);
    const notes = getConditionalNotes({ account, enabledOnly: true });
    
    for (let i = 2; i < tabs.length; i++) {
      const tabName = tabs[i];
      const reportRows = await getTabValues(tabName, 'A1:D300', sheetId);
      const resolved = resolveConditionalNotes(reportRows, notes);
      if (resolved.length > 0) {
        console.log(`Tab: ${tabName} -> `, resolved);
      }
    }
  } catch(e) {
    console.error(e);
  }
}

test();
