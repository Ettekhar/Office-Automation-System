// READ-ONLY: prove the syncFromSheets refactor is behavior-preserving.
// The meaningful invariant is not "same column index" but "same imported value":
// for every data row in every tab, old and new logic must yield the identical
// website cell and the identical company/account value.
import { getTabValues } from '../src/sheets.js';
import { findUrlColumn, resolveUserTabUrlColumn, resolveUserTabAccountColumn, getUserTabFallbackUrlColumn } from '../src/columnMap.js';

const id = '1QqDY9q7mRj4QPsuRnFEfFmegFvJoywfDmwanCFtZY6I';
const TABS = ['Toufiq', 'Sabbir', 'Taion', 'Medul', 'Saiful', 'Tarikul', 'Roeich', 'Asif'];

let pass = 0, fail = 0;
const t = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  ' + JSON.stringify(extra) : '')); }
};

// Verbatim from syncFromSheets.js — the effective value actually imported.
const effectiveCompany = (r, coCol) =>
  (coCol >= 0 && r[coCol]) ? r[coCol].trim()
    : (r.find((c) => typeof c === 'string' && (c.trim() === 'CW' || c.trim() === 'RM')) || '');

console.log('  tab       urlCol coCol(via)        rows  urlSame  companySame');
let totalRows = 0;
for (const tab of TABS) {
  const rows = (await getTabValues(tab, 'A1:ZZ2000', id)) || [];
  const h = rows[0] || [];
  const data = rows.slice(1);
  const uLower = tab.toLowerCase();

  // ── OLD logic (verbatim, pre-refactor) ──
  let oldUrl, oldCo;
  if (uLower === 'medul') { oldUrl = 1; oldCo = 2; }
  else if (uLower === 'sabbir' || uLower === 'taion') { oldUrl = 0; oldCo = 1; }
  else {
    oldUrl = findUrlColumn(h);
    oldCo = h.findIndex((x, i) => i !== oldUrl && x && (x.toLowerCase().includes('company') || x.toLowerCase().includes('website')));
  }

  // ── NEW logic (verbatim, refactored) ──
  // NOTE: the parameter is `headers` (plural), per the signature at
  // columnMap.js:120. This test used to pass `header:`, which the destructuring
  // default silently turned into `headers = []` — so the "new" side was resolving
  // with NO header text at all and surviving only on the data-grounded path plus
  // the documented fallback. That fallback exists for Sabbir and Taion only
  // (USER_TAB_DOCUMENTED_URL_COLUMNS = { sabbir: 0, taion: 0 }), which is why
  // Toufiq fell through to -1 while the other six tabs happened to agree. A
  // parity test whose new side is blind is worse than none: it reports parity it
  // never measured.
  const r = resolveUserTabUrlColumn({ headers: h, rows: data, fallbackIndex: getUserTabFallbackUrlColumn(tab) });
  const newUrl = r.col == null ? -1 : r.col;
  const a = resolveUserTabAccountColumn({ headers: h, rows: data, urlCol: newUrl });
  const newCo = a.col == null ? -1 : a.col;

  let urlDiff = 0, coDiff = 0, firstDiff = null;
  for (const row of data) {
    if (!Array.isArray(row)) continue;
    if ((row[oldUrl] || '') !== (row[newUrl] || '')) { urlDiff++; if (!firstDiff) firstDiff = { row, oldUrl, newUrl }; }
    if (effectiveCompany(row, oldCo) !== effectiveCompany(row, newCo)) {
      coDiff++;
      if (!firstDiff) firstDiff = { old: effectiveCompany(row, oldCo), neu: effectiveCompany(row, newCo), oldCo, newCo };
    }
  }
  totalRows += data.length;
  const ok = urlDiff === 0 && coDiff === 0;
  console.log(`  ${tab.padEnd(9)} ${String(newUrl).padEnd(6)} ${String(newCo).padEnd(5)}(${String(a.via).padEnd(10)}) ${String(data.length).padEnd(5)} ${urlDiff === 0 ? 'YES' : 'NO'}      ${coDiff === 0 ? 'YES' : 'NO'}`);
  t(`${tab}: every row imports the same website cell`, urlDiff === 0, firstDiff);
  t(`${tab}: every row imports the same company value`, coDiff === 0, firstDiff);
}

console.log(`\n  (${totalRows} live rows compared across 8 tabs)`);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
