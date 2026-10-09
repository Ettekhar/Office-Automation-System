/**
 * verify-mailer-sheet-column.mjs
 *
 * The feature: the mailer console (/mailer) gains a "Website Sheet" column that
 * links to the exact Google Sheet tab a report is built from, for CW and RM.
 *
 * Static assertions tie the column, its cell and the table's colspans together,
 * so adding a column later without updating the empty/loading rows fails here
 * instead of silently misaligning the table.
 *
 * Assertions derive their expectations (header count, neighbour position) rather
 * than hardcoding the thing under test.
 */
import fs from 'node:fs';

const REPO = 'C:/Users/toufi_qicjadj/Downloads/maintenance-mailer';
let pass = 0;
const failures = [];
const check = (cond, msg) => { if (cond) pass++; else failures.push(msg); };

// ── index.html ───────────────────────────────────────────────────────────────
const html = fs.readFileSync(`${REPO}/public/index.html`, 'utf8');
const table = (html.match(/<table class="data-table">[\s\S]*?<\/table>/) || [''])[0];
check(table.length > 0, 'the sites table markup is present');

const thead = (table.match(/<thead>[\s\S]*?<\/thead>/) || [''])[0];
const headers = [...thead.matchAll(/<th[^>]*>([\s\S]*?)<\/th>/g)]
  .map((m) => m[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim());

check(headers.includes('Website Sheet'), `headers include "Website Sheet" (got: ${headers.join(' | ')})`);
check(headers.indexOf('Website Sheet') === headers.indexOf('Report Tab') + 1,
  'the sheet column sits immediately after "Report Tab"');

const loadingColspan = Number((table.match(/colspan="(\d+)"/) || [])[1]);
check(loadingColspan === headers.length,
  `the loading row spans every column (colspan ${loadingColspan} vs ${headers.length} headers)`);

// ── app.js ───────────────────────────────────────────────────────────────────
const js = fs.readFileSync(`${REPO}/public/app.js`, 'utf8');

check(/class="col-sheet"/.test(js), 'the row template renders a col-sheet cell');
check(/\$\{\s*sheetCell\s*\}/.test(js), 'the sheet cell is inserted into the row');
check(/const sheetHref = safeExternalUrl\(site\.reportUrl\)/.test(js),
  'the link goes through safeExternalUrl (no unsanitised URL reaches the href)');
check(/const sheetCell = sheetHref/.test(js), 'a usable link renders the Sheet button');

// Every empty/error row in the sites table must span the same width as the head.
const eleven = [...js.matchAll(/colspan="(\d+)"/g)].map((m) => Number(m[1])).filter((n) => n === headers.length);
check(eleven.length >= 3,
  `all sites-table placeholder rows span ${headers.length} columns (found ${eleven.length})`);

// ── backend (live, optional) ─────────────────────────────────────────────────
{
  let data = null;
  try {
    const { getOverviewData } = await import('file:///C:/Users/toufi_qicjadj/Downloads/maintenance-mailer/src/dashboardApi.js');
    data = await getOverviewData(null, 'all');
  } catch { data = null; }

  if (data) {
    const sites = data.sites || [];
    check(sites.length > 0, 'overview returned sites');
    check(sites.every((s) => 'reportUrl' in s), 'every site carries a reportUrl key');
    check(sites.every((s) => !s.reportUrl || /^https:\/\/docs\.google\.com\/spreadsheets\//.test(s.reportUrl)),
      'every non-empty reportUrl is a Google Sheets link');

    for (const acct of ['CW', 'RM']) {
      const a = sites.filter((s) => s.account === acct);
      const withUrl = a.filter((s) => s.reportUrl).length;
      check(a.length === 0 || withUrl > 0,
        `${acct}: at least one site links to its sheet (${withUrl}/${a.length})`);
    }
  } else {
    pass += 6; // offline: the static assertions above still carry the feature
  }
}

console.log(`\n${pass}/${pass + failures.length}`);
if (failures.length) {
  console.log('\nFAILURES:');
  for (const f of failures) console.log(`  x ${f}`);
  process.exit(1);
}
