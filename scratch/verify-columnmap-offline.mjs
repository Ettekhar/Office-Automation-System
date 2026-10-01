// PURE offline unit test for the canonical column resolvers (no I/O).
// Locks the paths the live sheet masked: sparse and EMPTY tabs, where the
// data-detection threshold cannot fire and the header/documented fallbacks must.
// This is the regression guard for the `header` vs `headers` call-site bug.
import {
  resolveUserTabUrlColumn, resolveUserTabAccountColumn, looksLikeDomain,
  getUserTabFallbackUrlColumn, findUrlColumn,
} from '../src/columnMap.js';

let pass = 0, fail = 0;
const t = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  ' + JSON.stringify(extra) : '')); }
};

const H_SABBIR = [' ', 'Website', 'Maintenance', 'Maintenance Report Sent', 'Booking / Reservstion Link'];
const H_TAION = [' ', '', 'Maintenance', 'Maintenance Report Sent', 'Booking / Reservstion Link'];
const H_MEDUL = ['-', 'Website URL', 'Website', 'Maintenance', 'Maintenance Report Sent'];
const H_TOUFIQ = [' Website URL', 'Company', 'Maintenance', 'Maintenance Report Sent', 'ClickUp Link'];
const H_BARE = ['URL'];
const H_NONE = [' ', '', 'Maintenance'];

console.log('== 1. EMPTY tab (header only) — header fallback must work ==');
for (const [name, h, want] of [['Sabbir', H_SABBIR, 0], ['Taion', H_TAION, 0], ['Medul', H_MEDUL, 1], ['Toufiq', H_TOUFIQ, 0], ['bare-URL', H_BARE, 0]]) {
  const r = resolveUserTabUrlColumn({ headers: h, rows: [], fallbackIndex: getUserTabFallbackUrlColumn(name) });
  t(`${name}: empty tab resolves to col ${want} (via ${r.via})`, r.col === want, r);
}
t('an unnamed tab with no default is left unresolved (never guesses)',
  resolveUserTabUrlColumn({ headers: H_NONE, rows: [] }).col === null);

console.log('\n== 2. SPARSE tab (2 rows, below the detection threshold) ==');
const sparseMedul = resolveUserTabUrlColumn({
  headers: H_MEDUL,
  rows: [['1', 'governorsinnnd.com', 'CW', 'To Do', 'No'], ['2', 'diamondconf.com', 'CW', 'To Do', 'No']],
});
t('Medul sparse -> col 1 via header', sparseMedul.col === 1 && sparseMedul.via === 'header', sparseMedul);
const sparseSabbir = resolveUserTabUrlColumn({
  headers: H_SABBIR,
  rows: [['https://a.com', 'CW', 'To Do', 'No', ''], ['https://b.com', 'CW', 'To Do', 'No', 'https://resy.com/x']],
  fallbackIndex: getUserTabFallbackUrlColumn('Sabbir'),
});
t('Sabbir sparse -> col 0 via documented default (header would be wrong)',
  sparseSabbir.col === 0 && sparseSabbir.via === 'documented-default', sparseSabbir);

console.log('\n== 3. POPULATED tab — data detection wins over header ==');
const url = (i) => `https://site-${i}.example.com/`;
// Tab-accurate synthetic rows (verified against the live sheet 2026-09-25):
//   Sabbir/Taion : [domain, "CW", ...]            (col 0 header is blank)
//   Medul        : [rowNumber, domain, "CW", ...] (col 0 is a counter, col 1 "Website URL")
//   Toufiq       : [domain, "CW", ...]
const manyFor = (kind) => Array.from({ length: 12 }, (_, i) => (
  kind === 'medul'
    ? [String(i + 1), url(i), 'CW', 'To Do', 'No']
    : [url(i), 'CW', 'To Do', 'No', i % 2 ? 'https://resy.com/x' : '']
));
for (const [name, h, kind, want] of [
  ['Sabbir', H_SABBIR, 'std', 0], ['Taion', H_TAION, 'std', 0],
  ['Medul', H_MEDUL, 'medul', 1], ['Toufiq', H_TOUFIQ, 'std', 0],
]) {
  const r = resolveUserTabUrlColumn({ headers: h, rows: manyFor(kind), fallbackIndex: getUserTabFallbackUrlColumn(name) });
  t(`${name}: populated -> col ${want} via data`, r.col === want && r.via === 'data', r);
}

console.log('\n== 4. ambiguity is refused, not guessed ==');
// Two columns with the same domain density -> no unique winner.
const tie = resolveUserTabUrlColumn({
  headers: ['A', 'B', 'Maintenance'],
  rows: [['https://one.com', 'https://two.com', 'To Do'], ['https://three.com', 'https://four.com', 'To Do'], ['https://five.com', 'https://six.com', 'To Do']],
});
t('a density tie falls through instead of picking arbitrarily', tie.col === null || tie.via !== 'data', tie);
t('a tie with no header match and no default stays unresolved',
  resolveUserTabUrlColumn({ headers: ['A', 'B', 'Maintenance'], rows: [] }).col === null);

console.log('\n== 5. override always wins ==');
const ov = resolveUserTabUrlColumn({ headers: H_SABBIR, rows: manyFor('std'), override: 2 });
t('credential override beats data detection', ov.col === 2 && ov.via === 'override', ov);

console.log('\n== 6. account column ==');
t('account detected from CW/RM values in a blank-header column',
  resolveUserTabAccountColumn({ headers: H_TAION, rows: manyFor('std'), urlCol: 0 }).col === 1);
t('Medul account is col 2 ("Website"), not the URL column',
  resolveUserTabAccountColumn({ headers: H_MEDUL, rows: manyFor('medul'), urlCol: 1 }).col === 2);
t('no account column anywhere -> unresolved (falls back to a row scan)',
  resolveUserTabAccountColumn({ headers: ['Website URL', 'Newsletter Mail'], rows: [], urlCol: 0 }).col === null);
// If the only CW column IS the URL column, the resolver must refuse rather than
// report the website column as the account column.
const onlyCisUrl = resolveUserTabAccountColumn({ headers: H_SABBIR, rows: manyFor('std'), urlCol: 1 });
t('an account label living in the URL column is never reported as the account column',
  onlyCisUrl.col !== 1, onlyCisUrl);

console.log('\n== 7. domain detection hygiene ==');
t('"CW" / "RM" / "To Do" / "" / null are not domains',
  !['CW', 'RM', 'To Do', '', null, 'No', 'MailChimp'].some(looksLikeDomain));
t('real URLs and bare domains are domains',
  ['https://a.com/', 'www.b.com', 'c.co', 'sub.domain.org'].every(looksLikeDomain));
t('a URL embedded in prose is not a domain', !looksLikeDomain('book at https://resy.com/x or call'));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
