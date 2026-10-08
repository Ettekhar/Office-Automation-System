import { getSectionHeaderType, parseReportSections, rowsToHtmlTable } from
  'file:///C:/Users/toufi_qicjadj/Downloads/maintenance-mailer/src/reportUtils.js';

const pad = (r, n) => { const c = r.slice(); while (c.length < n) c.push(''); return c; };

// The SAME sheet row, as seen through the two ranges.
const headerAsD = pad(['Plugin Updated'], 4);            // A1:D  -> 4 cells
const headerAsZ = pad(['Plugin Updated'], 6);            // A1:Z, stray note sits in col F
headerAsZ[5] = 'leftover note';

console.log('--- getSectionHeaderType ---');
console.log('  A1:D200 view :', getSectionHeaderType(headerAsD));
console.log('  A1:Z300 view :', getSectionHeaderType(headerAsZ), ' <- stray cell in E..Z');

// Full grid: Plugin Updated (first section) + its 14 rows + Other + Backup
const plugins = [
  'All-in-One WP Migration and Backup', 'CookieYes | GDPR Cookie Consent',
  'Easy Accordion', 'Elementor', 'Elementor Pro', 'ElementsKit Lite',
  'FluentSMTP', 'Head & Footer Code', 'LiteSpeed Cache', 'Simple History',
  'Wordfence Security', 'WP Ghost Lite', 'WPvivid Backup Plugin', 'Yoast SEO',
].map((n, i) => [String(i + 1), n, 'To Version', `${7 + i}`]);

const grid = (hdr) => [
  hdr,
  ...plugins,
  [],
  ['Other'],
  ['Update', 'Theme', 'To Version', '4.13.10'],
  [],
  ['Premium Plugin'],
  ['1', 'Unlimited Elements for Elementor (Premium)'],
];

for (const [label, hdr, cols] of [
  ['A1:D200 (old)', pad(['Plugin Updated'], 4), 4],
  ['A1:Z300 (new)', (() => { const r = pad(['Plugin Updated'], 6); r[5] = 'leftover note'; return r; })(), 6],
]) {
  const g = grid(hdr).map((r) => pad(r, cols));
  const { reportHtml } = rowsToHtmlTable(g);
  const hasPluginRows = reportHtml.includes('Wordfence Security');
  const hasBand = /Plugin Updated/i.test(reportHtml);
  console.log(`\n--- ${label} ---`);
  console.log('  "Plugin Updated" band rendered :', hasBand);
  console.log('  plugin rows rendered           :', hasPluginRows, '(14 present)');
  console.log('  html length                    :', reportHtml.length);
}
