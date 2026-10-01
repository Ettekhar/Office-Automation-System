// READ-ONLY: real header + domain-density shape of all 8 daily-review tabs.
// Purpose: design a data-grounded URL-column fallback for tabs whose header
// does not name the website column (Taion: header is just " ").
import * as sheets from '../src/sheets.js';
import { findUrlColumn } from '../src/columnMap.js';

const id = '1QqDY9q7mRj4QPsuRnFEfFmegFvJoywfDmwanCFtZY6I';
const tabs = ['Toufiq', 'Sabbir', 'Taion', 'Medul', 'Saiful', 'Tarikul', 'Roeich', 'Asif'];

const isDomainish = v => {
  const s = String(v || '').trim();
  if (!s) return false;
  const t = s.replace(/^https?:\/\//i, '').replace(/^www\./i, '').split(/[\/?#]/)[0];
  return /^[\w-]+(\.[\w-]+)+$/i.test(t) && /\.[a-z]{2,}$/i.test(t);
};

for (const name of tabs) {
  const hdr = (await sheets.getTabValues(name, 'A1:ZZ1', id))?.[0] || [];
  const rows = (await sheets.getTabValues(name, 'A2:ZZ2000', id)) || [];
  const dataRows = rows.filter(r => (r || []).some(v => v !== undefined && v !== null && v !== ''));
  const resolved = findUrlColumn(hdr);
  const width = Math.max(hdr.length, ...rows.map(r => (r || []).length), 0);

  // domain density per column
  const density = [];
  for (let c = 0; c < width; c++) {
    const vals = dataRows.map(r => (r || [])[c]);
    const filled = vals.filter(v => v !== undefined && v !== null && String(v).trim() !== '');
    const dom = filled.filter(isDomainish);
    density.push({ c, hdr: hdr[c], filled: filled.length, dom: dom.length, ex: dom[0] || filled[0] });
  }
  const maxDom = Math.max(0, ...density.map(d => d.dom));
  const winners = density.filter(d => d.dom === maxDom && maxDom > 0).map(d => d.c);

  console.log(`\n=== ${name} === dataRows=${dataRows.length} findUrlColumn=${resolved}`);
  console.log('  header:', JSON.stringify(hdr));
  console.log('  domain-density (col / header / filled / domainish):');
  for (const d of density) {
    if (d.filled) console.log(`    col ${d.c} ${JSON.stringify(d.hdr)} filled=${d.filled} dom=${d.dom} ex=${JSON.stringify(String(d.ex).slice(0, 46))}`);
  }
  console.log(`  max-domain column(s) = [${winners.join(',')}] (unique=${winners.length === 1})`);
}
