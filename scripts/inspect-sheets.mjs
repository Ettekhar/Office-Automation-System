/**
 * inspect-sheets.mjs
 * Fetches metadata + first 5 rows from every tab of every spreadsheet
 * listed below so we can understand the full schema before building
 * the master dashboard.
 */

import { google } from 'googleapis';
import { JWT } from 'google-auth-library';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import 'dotenv/config';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const keyPath = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_PATH || './service-account.json';
const keyFile = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', keyPath), 'utf8'));

const auth = new JWT({
  email: keyFile.client_email,
  key: keyFile.private_key,
  scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
});
await auth.authorize();
const sheets = google.sheets({ version: 'v4', auth });

const SPREADSHEETS = [
  { id: '1VnI5ZxVr5QykBOwYDOLp_1bbCpApfc0Jwljf01Q7djU', label: 'Daily Review / Assignments' },
  { id: '1C4jSa49P6LHEN8ywh92fOgBPif6OSKuXx8PoRONtWzs', label: 'Sheet2 (unknown)' },
  { id: '1sWz7sNsQmi0xigD2AiMbxbC0lHDbKyQIGOB_jrrNJzY', label: 'Sheet3 (unknown)' },
  { id: '14PXRHUkFG-gf0DwbGVqeyPA7aQ4LyhDMjAeTVatOI78', label: 'Sheet4 (unknown)' },
  { id: '19aIBNOb0C4_Fx47bsZ2mUMVAxogX7j_tly8tSg-bldE', label: 'CW Maintenance (existing)' },
  { id: '1Fbb-SY2fU0HXFdnJ_OQoHb_AwlFzdk39jWOo3kFMcjY', label: 'RM Maintenance (existing)' },
];

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const results = {};

for (const sp of SPREADSHEETS) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`SPREADSHEET: ${sp.label}`);
  console.log(`ID: ${sp.id}`);
  console.log('='.repeat(60));

  try {
    const meta = await sheets.spreadsheets.get({ spreadsheetId: sp.id });
    const tabList = meta.data.sheets.map(s => ({
      title: s.properties.title,
      index: s.properties.index,
      rows: s.properties.gridProperties?.rowCount,
      cols: s.properties.gridProperties?.columnCount,
    }));

    console.log(`Tabs (${tabList.length}):`);
    tabList.forEach(t => console.log(`  [${t.index}] "${t.title}" — ${t.rows}r × ${t.cols}c`));

    results[sp.id] = { label: sp.label, tabs: [] };

    for (const tab of tabList) {
      await sleep(1500); // respect rate limit
      try {
        const res = await sheets.spreadsheets.values.get({
          spreadsheetId: sp.id,
          range: `'${tab.title}'!A1:Z10`,
          valueRenderOption: 'FORMATTED_VALUE',
        });
        const rows = res.data.values || [];
        const headers = rows[0] || [];
        const sample = rows.slice(1, 4);

        console.log(`\n  TAB: "${tab.title}"`);
        console.log(`  Headers (${headers.length}): ${JSON.stringify(headers)}`);
        sample.forEach((r, i) => console.log(`  Row ${i + 2}: ${JSON.stringify(r)}`));

        results[sp.id].tabs.push({ title: tab.title, headers, sample });
      } catch (e) {
        console.log(`  TAB "${tab.title}" ERROR: ${e.message}`);
      }
    }
  } catch (e) {
    console.log(`ERROR accessing spreadsheet: ${e.message}`);
    results[sp.id] = { label: sp.label, error: e.message };
  }
}

// Write summary JSON for plan creation
const outPath = path.resolve(__dirname, '../scripts/sheet-schema.json');
fs.writeFileSync(outPath, JSON.stringify(results, null, 2));
console.log(`\n\nSchema written to ${outPath}`);
