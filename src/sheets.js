import { google } from 'googleapis';
import { JWT } from 'google-auth-library';
import fs from 'fs';
import { config } from './config.js';
import {
  cacheGet,
  cacheSet,
  tabTitlesCacheKey,
  tabValuesCacheKey,
} from './sheetsCache.js';

let sheetsClient = null;

export async function getSheetsClient() {
  if (sheetsClient) return sheetsClient;

  // Local dev: reads a JSON key file from disk (GOOGLE_SERVICE_ACCOUNT_KEY_PATH).
  // Vercel/serverless: set GOOGLE_SERVICE_ACCOUNT_KEY_JSON to the *contents* of that
  // file instead (as a single env var), since you can't upload a file to Vercel env vars.
  const keyFile = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_JSON
    ? JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY_JSON)
    : JSON.parse(fs.readFileSync(config.serviceAccountKeyPath, 'utf8'));
  const auth = new JWT({
    email: keyFile.client_email,
    key: keyFile.private_key,
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
  await auth.authorize();

  sheetsClient = google.sheets({ version: 'v4', auth });
  return sheetsClient;
}

/** Returns an array of every tab (sheet) title in the spreadsheet. */
export async function listTabTitles(spreadsheetId = null) {
  const targetId = spreadsheetId || config.spreadsheetId;

  // --- Cache check ---
  const cacheKey = tabTitlesCacheKey(targetId);
  const cached = cacheGet(cacheKey);
  if (cached !== undefined) {
    return cached;
  }

  // --- API call ---
  const sheets = await getSheetsClient();
  const meta = await sheets.spreadsheets.get({ spreadsheetId: targetId });
  const titles = meta.data.sheets.map((s) => s.properties.title);

  cacheSet(cacheKey, titles);
  return titles;
}

/** Returns the full 2D array of values for a given tab (raw strings). */
export async function getTabValues(tabName, range = 'A1:ZZ2000', spreadsheetId = null) {
  const targetId = spreadsheetId || config.spreadsheetId;

  // --- Cache check ---
  const cacheKey = tabValuesCacheKey(targetId, tabName, range);
  const cached = cacheGet(cacheKey);
  if (cached !== undefined) {
    return cached;
  }

  // --- API call ---
  const sheets = await getSheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: targetId,
    range: `'${tabName}'!${range}`,
    valueRenderOption: 'FORMATTED_VALUE',
  });
  const values = res.data.values || [];

  cacheSet(cacheKey, values);
  return values;
}
