/**
 * Eligibility parity: cloudflare-worker/mailer-worker.js vs src/index.js
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The Worker re-implements exactly one thing that src/index.js already does: the
 * walk down the master rows that decides who is due a report. Every rule it uses
 * is imported from src/reportUtils.js, but the ORDER of the guards is local to
 * each file, and a guard in the wrong order produces a different recipient list
 * with no error anywhere.
 *
 * So this suite does not compare the two planners to each other and call it a
 * day — two wrong planners can agree. It pins BOTH of them against a declared
 * truth table in the fixture, which lists what must happen to every row:
 *
 *   1. the Worker's planAccount() is checked against that table, row by row
 *   2. the real src/index.js is executed as a child process against the same
 *      fixture, and its own output is checked against the same table
 *
 * If someone reorders a guard in either file, one of the two halves fails.
 *
 * Nothing is stubbed inside src/. src/sheets.js is swapped for a fixture through
 * Node's own module resolution hook, so the real index.js, reportUtils,
 * mailer, clickup and db all execute unmodified. Dry run is the default mode, so
 * no email can leave the machine.
 */

import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

import { findHeaderRow, detectColumns, resolveMonthColumn } from '../src/reportUtils.js';
import { planAccount } from '../cloudflare-worker/mailer-worker.js';
import { FIXTURE, EXPECTED, MONTH_COL } from './fixture-sheets-parity.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');

let pass = 0;
const failures = [];
function check(ok, label, detail) {
  if (ok) { pass++; return true; }
  failures.push(detail ? `${label}\n        ${detail}` : label);
  return false;
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const sorted = (a) => [...a].sort();

/** Work out, from the truth table alone, what a correct run must print. */
function expectedFromTable(account) {
  const rows = EXPECTED[account];
  return {
    queued: rows.filter((r) => r.outcome === 'queued')
      .map((r) => ({ websiteUrl: r.url, recipients: r.recipients, tab: r.tab })),
    noContact: rows.filter((r) => r.outcome === 'no contact email').map((r) => r.url),
    noTab: rows.filter((r) => r.outcome === 'no matching report tab').map((r) => r.url),
    // Everything dropped with a reason the CLI does not announce per-row.
    countedSkips: rows.filter((r) => r.outcome !== 'queued' && r.outcome !== 'silent').length,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. The Worker's planner, against the truth table
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n── Worker planner vs truth table ──');

for (const account of Object.keys(FIXTURE)) {
  const { rows, tabs } = FIXTURE[account];
  const { headerRow, headerRowIndex } = findHeaderRow(rows);
  const cols = detectColumns(headerRow);
  const reportMonth = resolveMonthColumn(headerRow, cols.FIRST_MONTH_COL, null);

  check(!!reportMonth, `${account}: fixture has a resolvable month column`,
    `resolveMonthColumn returned ${reportMonth}`);

  // The fixture writes its DONE marker into MONTH_COL[account]. If the header
  // ever gains or loses a column and that index stops being the one the product
  // would pick, every row flips to "not done" and the suite would pass for the
  // wrong reason. Pin it.
  check(reportMonth && reportMonth.columnIndex === MONTH_COL[account],
    `${account}: fixture month column matches the product's choice`,
    `fixture writes MONTH at ${MONTH_COL[account]}, resolveMonthColumn chose ${reportMonth && reportMonth.columnIndex}`);

  const acct = { key: account, name: `${account} Maintenance`, masterTabName: 'Website List' };
  const plan = planAccount({
    acct, masterRows: rows, tabTitles: tabs,
    monthCol: reportMonth.columnIndex,
    cols: { ...cols, headerRowIndex },
  });

  const want = expectedFromTable(account);

  // 1a. exactly the right sites queued
  const gotQueued = plan.queued.map((j) => ({ websiteUrl: j.website_url, recipients: j.recipients, tab: j.matched_tab }));
  check(eq(sorted(gotQueued.map((q) => q.websiteUrl)), sorted(want.queued.map((q) => q.websiteUrl))),
    `${account}: queued set`, `want ${sorted(want.queued.map((q) => q.websiteUrl))}\n        got  ${sorted(gotQueued.map((q) => q.websiteUrl))}`);

  // 1b. recipients and matched tab for each queued site
  for (const w of want.queued) {
    const g = gotQueued.find((x) => x.websiteUrl === w.websiteUrl);
    if (!check(!!g, `${account}: ${w.websiteUrl} was queued`)) continue;
    check(eq(g.recipients, w.recipients), `${account}: ${w.websiteUrl} recipients`, `want ${JSON.stringify(w.recipients)} got ${JSON.stringify(g.recipients)}`);
    check(g.tab === w.tab, `${account}: ${w.websiteUrl} matched tab`, `want "${w.tab}" got "${g.tab}"`);
  }

  // 1c. every non-queued row carries the right skip reason
  for (const r of EXPECTED[account]) {
    if (r.outcome === 'queued' || r.outcome === 'silent') continue;
    const g = plan.skipped.find((s) => s.websiteUrl === r.url);
    if (!check(!!g, `${account}: ${r.url} was skipped`)) continue;
    check(g.reason === r.outcome, `${account}: ${r.url} skip reason`, `want "${r.outcome}" got "${g.reason}"`);
  }

  // 1d. nothing dropped for a reason the table does not sanction
  const sanctioned = new Set(EXPECTED[account].filter((r) => r.outcome !== 'queued' && r.outcome !== 'silent').map((r) => r.url));
  for (const s of plan.skipped) {
    check(sanctioned.has(s.websiteUrl), `${account}: unexpected skip of "${s.websiteUrl}" (${s.reason})`);
  }

  // 1e. the time-track column is read by name, so it must not be RM's Task link
  for (const j of plan.queued) {
    const row = rows.find((r) => String(r[cols.WEBSITE_URL] ?? '').trim() === j.website_url);
    const ttCell = String(row?.[cols.TIME_TRACK_URL] ?? '').trim();
    const taskCell = String(row?.[cols.TIME_TRACK_URL + 1] ?? '').trim();
    check(j.time_track_url === ttCell,
      `${account}: ${j.website_url} time-track URL`, `want "${ttCell}" got "${j.time_track_url}" (next column holds "${taskCell}")`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 2. The real src/index.js, executed as a child process
// ═══════════════════════════════════════════════════════════════════════════

console.log('── src/index.js (real, dry run) vs truth table ──');

const hook = pathToFileURL(path.join(REPO, 'scratch', 'register-sheets-redirect.mjs')).href;
const fake = pathToFileURL(path.join(REPO, 'scratch', 'fixture-sheets-parity.mjs')).href;

// The child runs the real product in dry-run mode, which writes one preview file
// per queued site. Those are gitignored artifacts, but a suite that leaves them
// behind poisons the next suite that counts them — so the directory is snapshotted
// and only this run's own output is removed at the end. Nothing pre-existing is
// ever deleted.
const PREVIEWS = path.join(REPO, 'dry-run-previews');
const previewsBefore = new Set(fs.existsSync(PREVIEWS) ? fs.readdirSync(PREVIEWS) : []);

for (const account of Object.keys(FIXTURE)) {
  // cwd is the repo, not a scratch dir: src/db.js reads service-account.json
  // relative to cwd at import time and the whole child dies without it. The
  // dry-run previews that result land in dry-run-previews/, which is gitignored.
  // ClickUp is switched off explicitly so the suite cannot reach the network even
  // though a fixture row carries a time-track URL.
  const res = spawnSync(
    process.execPath,
    ['--import', hook, path.join(REPO, 'src', 'index.js'), `--account=${account}`],
    {
      cwd: REPO,
      encoding: 'utf8',
      env: {
        ...process.env,
        MM_FAKE_SHEETS: fake,
        MAX_EMAILS_PER_RUN: '0',
        CLICKUP_API_TOKEN: '',
        CLICKUP_AUTO_CLOSE_ENABLED: 'false',
      },
    },
  );
  const out = `${res.stdout || ''}${res.stderr || ''}`;

  check(res.status === 0, `${account}: src/index.js exited cleanly`, out.trim().split('\n').slice(-6).join('\n        '));
  check(/DRY RUN/.test(out), `${account}: src/index.js ran in dry-run mode`,
    'refusing to trust output from a run that was not in dry-run mode');
  check(!/✅ Sent/.test(out), `${account}: no live send occurred during the suite`);

  // THE most important assertion in this file.
  //
  // If the redirect does not take effect, src/index.js does not crash — it reads
  // the real Google Sheets and prints real client hostnames. The suite would then
  // "fail" on set mismatches, but it would already have talked to live data, and
  // a future edit could make it pass while reading production. src/sheets.js logs
  // "[sheets] fetched ..." on every real call and the fixture never does, so the
  // absence of that marker is a direct proof the fake served the rows.
  check(!/\[sheets\]/.test(out), `${account}: real src/sheets.js never ran`,
    'the child reached the live Google Sheets — the redirect hook did not register');
  check(new RegExp(`${account.toLowerCase()}-ok\\.test`).test(out),
    `${account}: the transcript came from the fixture`,
    'no fixture host appears in the child output, so this is not the fixture\'s data');

  const want = expectedFromTable(account);

  // 2a. who the CLI said it would mail, with recipients and tab
  const cliQueued = [];
  for (const m of out.matchAll(/Would send \[(\w+)\]: (.+?) -> (.+?) \(tab: "(.+?)"\)/g)) {
    cliQueued.push({
      account: m[1],
      websiteUrl: m[2].trim(),
      recipients: m[3].split(',').map((s) => s.trim()),
      tab: m[4],
    });
  }
  check(eq(sorted(cliQueued.map((q) => q.websiteUrl)), sorted(want.queued.map((q) => q.websiteUrl))),
    `${account}: CLI queued set`, `want ${sorted(want.queued.map((q) => q.websiteUrl))}\n        got  ${sorted(cliQueued.map((q) => q.websiteUrl))}`);
  for (const w of want.queued) {
    const g = cliQueued.find((x) => x.websiteUrl === w.websiteUrl);
    if (!check(!!g, `${account}: CLI queued ${w.websiteUrl}`)) continue;
    check(eq(g.recipients, w.recipients), `${account}: CLI recipients for ${w.websiteUrl}`, `want ${JSON.stringify(w.recipients)} got ${JSON.stringify(g.recipients)}`);
    check(g.tab === w.tab, `${account}: CLI tab for ${w.websiteUrl}`, `want "${w.tab}" got "${g.tab}"`);
  }

  // 2b. the two skips the CLI announces per row
  const cliNoContact = [...out.matchAll(/⚠ Skipping (.+?) — no valid contact email\./g)].map((m) => m[1].trim());
  const cliNoTab = [...out.matchAll(/⚠ Skipping (.+?) — no matching report tab found\./g)].map((m) => m[1].trim());
  check(eq(sorted(cliNoContact), sorted(want.noContact)), `${account}: CLI no-contact set`,
    `want ${JSON.stringify(sorted(want.noContact))} got ${JSON.stringify(sorted(cliNoContact))}`);
  check(eq(sorted(cliNoTab), sorted(want.noTab)), `${account}: CLI no-tab set`,
    `want ${JSON.stringify(sorted(want.noTab))} got ${JSON.stringify(sorted(cliNoTab))}`);

  // 2c. and the totals, which is the only place inactive / not-done surface
  const cliSent = Number((out.match(/^Would send: (\d+)$/m) || [])[1]);
  const cliSkipped = Number((out.match(/^Skipped: (\d+)$/m) || [])[1]);
  check(cliSent === want.queued.length, `${account}: CLI send count`, `want ${want.queued.length} got ${cliSent}`);
  check(cliSkipped === want.countedSkips, `${account}: CLI skip count`, `want ${want.countedSkips} got ${cliSkipped}`);
}

// ═══════════════════════════════════════════════════════════════════════════
// 3. And the two sides, compared directly
// ═══════════════════════════════════════════════════════════════════════════

console.log('── cross-check ──');

for (const account of Object.keys(FIXTURE)) {
  const { rows, tabs } = FIXTURE[account];
  const { headerRow, headerRowIndex } = findHeaderRow(rows);
  const cols = detectColumns(headerRow);
  const reportMonth = resolveMonthColumn(headerRow, cols.FIRST_MONTH_COL, null);
  const plan = planAccount({
    acct: { key: account, name: account, masterTabName: 'Website List' },
    masterRows: rows, tabTitles: tabs,
    monthCol: reportMonth.columnIndex,
    cols: { ...cols, headerRowIndex },
  });
  const workerQueued = sorted(plan.queued.map((j) => j.website_url));

  // Re-derive the CLI answer from the child's own transcript for the same account.
  const res = spawnSync(
    process.execPath,
    ['--import', hook, path.join(REPO, 'src', 'index.js'), `--account=${account}`],
    {
      cwd: REPO,
      encoding: 'utf8',
      env: {
        ...process.env,
        MM_FAKE_SHEETS: fake,
        MAX_EMAILS_PER_RUN: '0',
        CLICKUP_API_TOKEN: '',
        CLICKUP_AUTO_CLOSE_ENABLED: 'false',
      },
    },
  );
  const out = `${res.stdout || ''}${res.stderr || ''}`;
  const cliQueued = sorted([...out.matchAll(/Would send \[\w+\]: (.+?) ->/g)].map((m) => m[1].trim()));

  check(eq(workerQueued, cliQueued), `${account}: Worker and CLI queue the identical set`,
    `worker ${JSON.stringify(workerQueued)}\n        cli    ${JSON.stringify(cliQueued)}`);
}

// ═══════════════════════════════════════════════════════════════════════════

// Leave dry-run-previews/ exactly as we found it: remove only what this run added.
if (fs.existsSync(PREVIEWS)) {
  for (const f of fs.readdirSync(PREVIEWS)) {
    if (!previewsBefore.has(f)) fs.rmSync(path.join(PREVIEWS, f), { force: true });
  }
  check(fs.readdirSync(PREVIEWS).length === previewsBefore.size,
    'the suite removed exactly the previews it created',
    `before ${previewsBefore.size}, after ${fs.readdirSync(PREVIEWS).length}`);
}

if (failures.length) {
  console.log('\nFAILURES');
  for (const f of failures) console.log(`  x ${f}`);
}
console.log(`\n${pass}/${pass + failures.length}`);
process.exit(failures.length ? 1 : 0);
