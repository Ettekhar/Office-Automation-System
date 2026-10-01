// READ-ONLY: what do Taion's columns 0 and 7 actually contain?
import * as sheets from '../src/sheets.js';
import { findUrlColumn } from '../src/columnMap.js';

const id = '1QqDY9q7mRj4QPsuRnFEfFmegFvJoywfDmwanCFtZY6I';
const hdr = (await sheets.getTabValues('Taion', 'A1:ZZ1', id))?.[0] || [];
const resolved = findUrlColumn(hdr);

console.log('Taion full header row:');
hdr.forEach((h, i) => console.log(`  col ${i} = ${JSON.stringify(h)}`));
console.log('\nfindUrlColumn(Taion header) =', resolved, '->', JSON.stringify(hdr[resolved]));

const rows = (await sheets.getTabValues('Taion', 'A2:ZZ12', id)) || [];
console.log(`\nTaion data rows (${rows.length}):`);
rows.slice(0, 10).forEach((r, i) => {
  const col0 = JSON.stringify((r || [])[0]);
  const col7 = JSON.stringify((r || [])[7]);
  console.log(`  row ${i + 2}: col0=${col0}  col7=${col7}`);
});

// Where do real domain-like values live?
console.log('\nDomain-like values per column (first 10 rows):');
for (let c = 0; c < Math.max(1, hdr.length); c++) {
  const vals = rows.map(r => (r || [])[c]).filter(v => v && /\w+\.\w{2,}/.test(String(v)));
  if (vals.length) console.log(`  col ${c} (${JSON.stringify(hdr[c])}) -> ${vals.length} domain-like, e.g. ${JSON.stringify(vals[0])}`);
}
