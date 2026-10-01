// READ-ONLY: before adding a column, measure the TRUE used extent of every
// daily-review tab (header row AND all data rows) versus the sheet's grid width.
// appendSheetColumn() uses headers.length, which the Sheets API trims - so it
// can target a column that already holds data. This shows exactly where that
// would land and which column is genuinely the first safe slot.
import { getTabValues, listTabMeta } from '../src/sheets.js';

const id = '1QqDY9q7mRj4QPsuRnFEfFmegFvJoywfDmwanCFtZY6I';
const TABS = ['Toufiq', 'Sabbir', 'Taion', 'Medul', 'Saiful', 'Tarikul', 'Roeich', 'Asif'];

const meta = await listTabMeta(id);
const gridOf = new Map(
  (Array.isArray(meta) ? meta : []).map((t) => [t?.properties?.title, t?.properties?.gridProperties?.columnCount])
);

console.log('  tab       headerLen  maxDataLen  lastUsedCol  firstFreeCol  gridCols  RISK of appendSheetColumn');
for (const tab of TABS) {
  const rows = (await getTabValues(tab, 'A1:ZZ2000', id)) || [];
  const headerLen = (rows[0] || []).length;
  // "Used" = the last column index that holds anything in ANY row.
  let lastUsed = -1;
  for (const r of rows) {
    if (!Array.isArray(r)) continue;
    for (let c = r.length - 1; c > lastUsed; c--) {
      const v = r[c];
      if (v !== undefined && v !== null && String(v).trim() !== '') { lastUsed = c; break; }
    }
  }
  const maxDataLen = Math.max(0, ...rows.map((r) => (Array.isArray(r) ? r.length : 0)), 0);
  const firstFree = lastUsed + 1;
  const grid = gridOf.get(tab) ?? '?';
  // appendSheetColumn would write at index headerLen.
  const risk = headerLen <= lastUsed
    ? `YES - would write into col ${headerLen} which HOLDS DATA`
    : (headerLen === firstFree ? 'no (coincides with first free col)' : 'no');
  console.log(
    `  ${tab.padEnd(9)} ${String(headerLen).padEnd(10)} ${String(maxDataLen).padEnd(11)} ` +
    `${String(lastUsed).padEnd(12)} ${String(firstFree).padEnd(13)} ${String(grid).padEnd(9)} ${risk}`
  );
  if (risk.startsWith('YES')) {
    const danger = [];
    for (const r of rows) {
      const v = (r || [])[headerLen];
      if (v !== undefined && v !== null && String(v).trim() !== '') danger.push(String(v).slice(0, 40));
    }
    if (danger.length) console.log(`             data that would be OVERWRITTEN: ${JSON.stringify(danger.slice(0, 5))}`);
  }
}
