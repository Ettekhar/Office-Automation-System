import { listTabTitles, getTabValues } from '../src/sheets.js';

async function test() {
  const sheetId = '1Ua3ttqdT7AkiDCHlq6WyMIotRfXGTWWhw7Hzm-c4im8'; // CW sheet ID
  
  try {
    const tabs = await listTabTitles(sheetId);
    
    for (let i = 2; i < 20; i++) { // just check a few to avoid 429
      const tabName = tabs[i];
      const reportRows = await getTabValues(tabName, 'A1:Z300', sheetId);
      for (let r = 0; r < reportRows.length; r++) {
        for (let c = 0; c < reportRows[r].length; c++) {
          const cell = reportRows[r][c];
          if (String(cell).toLowerCase().includes('a11y')) {
            console.log(`FOUND a11y in ${tabName} at Row ${r+1}, Col ${String.fromCharCode(65+c)}:`, cell);
          }
        }
      }
    }
  } catch(e) {
    console.error(e);
  }
}

test();
