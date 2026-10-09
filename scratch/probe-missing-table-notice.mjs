/**
 * probe-missing-table-notice.mjs
 *
 * Renders the operator notice so a human can see it WITHOUT touching a live
 * sheet. Everything is derived from the real code:
 *   - the reducer is the real missingSectionInfo()
 *   - the console badge markup is extracted from public/app.js and evaluated
 *   - the modal tag markup is extracted from public/index.html
 *   - the terminal banner text follows src/index.js
 *
 * Output: scratch/notice-demo.html  (+ the terminal banner on stdout)
 */
import fs from 'node:fs';
import {
  findUnsectionedRows,
  missingSectionInfo,
} from 'file:///C:/Users/toufi_qicjadj/Downloads/maintenance-mailer/src/reportUtils.js';

const REPO = 'C:/Users/toufi_qicjadj/Downloads/maintenance-mailer';

const PLUGIN_ROWS = [
  ['1', 'All-in-One WP Migration and Backup', 'To Version', '7.111'],
  ['2', 'CookieYes | GDPR Cookie Consent', 'To Version', '3.5.6'],
  ['3', 'FluentSMTP', 'To Version', '2.4.1'],
  ['4', 'Post Types Order', 'To Version', '2.5.6'],
  ['5', 'Redirection', 'To Version', '5.10.1'],
  ['6', 'Redirection for Contact Form 7', 'To Version', '3.2.13'],
  ['7', 'Simple History', 'To Version', '5.34.0'],
  ['8', 'WP Ghost Lite', 'To Version', '7.0.12'],
  ['9', 'WPvivid Backup Plugin', 'To Version', '0.9.136'],
  ['10', 'Yoast SEO', 'To Version', '28.6'],
];
const blankedBand = [[' ', '', '', ''], ...PLUGIN_ROWS, ['Other'], ['Backup', 'Created Backup on  10-03-26']];

const info = missingSectionInfo(findUnsectionedRows(blankedBand)); // { count: 10, first: '...' }
const site = 'https://woodcliffhotelspa.com';

// ── pull the real badge expression out of app.js and run it ──────────────────
const appSrc = fs.readFileSync(`${REPO}/public/app.js`, 'utf8');
const badgeStart = appSrc.indexOf('const noTableBadge =');
const badgeEnd = appSrc.indexOf('\n\n', badgeStart);
const badgeExpr = appSrc.slice(badgeStart + 'const noTableBadge ='.length, badgeEnd).trim().replace(/;$/, '');
const escapeHtml = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
// eslint-disable-next-line no-new-func
const badgeHtml = new Function('noTableInfo', 'escapeHtml', `return (${badgeExpr});`)(info, escapeHtml);

// ── pull the real modal tag out of index.html ────────────────────────────────
const htmlSrc = fs.readFileSync(`${REPO}/public/index.html`, 'utf8');
const tagMatch = htmlSrc.match(/<span id="modalNoTableTag"[^>]*>.*?<\/span>/);
let tagHtml = tagMatch ? tagMatch[0] : '<span>(modalNoTableTag not found)</span>';
// With a real payload the modal sets textContent + un-hides it:
tagHtml = tagHtml
  .replace(/\bclass="tag hidden"/, 'class="tag"')
  .replace(/>[^<]*<\/span>/, `>⚠ Missing Table (${info.count} rows dropped)</span>`)
  .replace(/title="[^"]*"/, `title="No section band on this tab. First dropped row: &quot;${escapeHtml(info.first)}&quot;"`);

// ── the terminal banner, exactly as src/index.js prints it ───────────────────
const banner = [
  '========================================',
  `⚠ 1 report(s) are MISSING THEIR TABLE (no section band on the tab):`,
  `   - [CW] ${site} (${info.count} row(s) dropped, first: "${info.first}")`,
  '========================================',
].join('\n');
console.log('\n' + banner + '\n');

const demo = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>Missing-table notice — operator-only</title>
<style>
  body{background:#0f1420;color:#e6edf7;font-family:system-ui,Segoe UI,Roboto,sans-serif;margin:0;padding:28px 32px;}
  h1{font-size:19px;margin:0 0 4px;} .sub{color:#8b9bb4;font-size:13px;margin-bottom:22px;}
  h2{font-size:14px;margin:26px 0 10px;color:#cdd9ea;}
  .card{background:#141b2b;border:1px solid #243049;border-radius:10px;padding:16px 18px;}
  pre{margin:0;background:#0b101a;border:1px solid #243049;border-radius:8px;padding:14px 16px;
      font-family:Consolas,monospace;font-size:12.5px;line-height:1.55;color:#f0d090;white-space:pre-wrap;}
  .warn{color:#ffb454;} .red{color:#ff7b72;}
  table{border-collapse:collapse;width:100%;font-size:13px;}
  th,td{text-align:left;padding:10px 12px;border-bottom:1px solid #243049;vertical-align:top;}
  th{color:#8b9bb4;font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:.04em;}
  .tag{display:inline-block;font-size:11px;padding:2px 8px;border-radius:999px;margin-right:6px;}
  .tag-tab{background:#1e2a44;color:#9fc0ff;} .tag-edited{background:#2a3a1e;color:#bfe08a;}
  .tag-missing{background:#b91c1c;color:#fff;}
  .tags{display:flex;align-items:center;gap:8px;background:#0b101a;border:1px solid #243049;border-radius:8px;padding:12px 14px;}
  .tags strong{font-size:14px;margin-right:8px;}
  .note{color:#8b9bb4;font-size:12px;margin-top:10px;}
</style></head><body>
<h1>Missing-table notice — operator-only</h1>
<div class="sub">Shown to us only. Never in an email body, never to a client. Every report is healthy today, so in normal use none of this is visible.</div>

<h2>1 · End of a local run (terminal) — <code>node src/index.js</code></h2>
<div class="card"><pre>${escapeHtml(banner)}</pre>
<div class="note">The same run also prints a per-render line on stderr the moment a report is built:</div>
<pre style="margin-top:10px">${escapeHtml('⚠ [report] 10 row(s) sit above the first section band and will NOT appear in the email — is a band row blank on this tab? (e.g. "Plugin Updated" in A1; first dropped: "' + info.first + '")')}</pre></div>

<h2>2 · Mailer console — sites list (per-site badge)</h2>
<div class="card"><table>
<tr><th>Site</th><th>Status</th><th>Report Tab</th><th>Website Sheet</th></tr>
<tr>
  <td><div style="font-weight:600;display:flex;align-items:center;gap:6px;flex-wrap:wrap;">
    <span>${escapeHtml(site)}</span>
    <span class="tag tag-edited">✏️ Edited</span>
    ${badgeHtml}
  </div><div style="color:#8b9bb4;font-size:11px;">Woodcliff Hotel &amp; Spa</div></td>
  <td><span class="tag tag-tab">Ready to Send</span></td>
  <td><span class="tag tag-tab" title="https://woodcliffhotelspa.com">https://woodcliffhot…</span></td>
  <td><span class="tag tag-tab">Sheet ↗</span></td>
</tr>
</table><div class="note">The badge appears once a preview has been generated for that site (same trigger as the existing “Edited” badge).</div></div>

<h2>3 · Mailer console — preview modal header</h2>
<div class="card"><div class="tags">
  <strong>Report: ${escapeHtml(site)}</strong>
  <span class="tag tag-tab">CW (info@…)</span>
  <span class="tag tag-tab">Tab: "${escapeHtml(site)}"</span>
  <span class="tag tag-edited">✏️ Custom Edited</span>
  ${tagHtml}
</div><div class="note">Clicking the badge or opening the preview shows the count and the first dropped row (hover the tag for details).</div></div>
</body></html>`;

fs.writeFileSync(`${REPO}/scratch/notice-demo.html`, demo);
console.log(`wrote ${REPO}/scratch/notice-demo.html`);
