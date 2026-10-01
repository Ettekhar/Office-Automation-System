/**
 * The agent must not change what a client receives, and must not quietly drop
 * work on the way to the mailer.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The whole design rests on one claim: an email sent by src/localMailAgent.js is
 * the same email `npm run send` sends. This suite tries to falsify that claim.
 *
 * It does not compare two calls into the same function, which would prove
 * nothing. It runs the REAL src/index.js in a child process against a fixture,
 * lets the product write its own dry-run preview, and then requires the agent's
 * independently-built message to match that file — subject line, subject in the
 * <title>, and the whole body — for both CW and RM, since a per-account signature
 * is exactly where a regression would hide.
 *
 * Separately it intercepts the agent's SMTP call, so the handoff itself is
 * observed rather than assumed: who the mail is addressed to, which workspace it
 * was built for, that it happens exactly once, and that a ClickUp failure is
 * recorded as a ClickUp failure while the mail stays "sent".
 *
 * The one thing a fixture cannot prove is the conditional-note paragraph, because
 * that needs a live note in the database. Rather than write one, the agent and
 * the CLI are required to contain the same call, verbatim — a structural check,
 * and labelled as one.
 *
 * Nothing is stubbed inside src/. Only src/sheets.js is swapped, at Node's module
 * resolution boundary, and the agent's mailer is swapped in-process only. ClickUp
 * is switched off so the suite cannot reach the network. The product's preview
 * writer inlines the signature logo as a data: URI so the file opens offline;
 * that is the only difference permitted, and image sources are normalised and
 * nothing else.
 */

import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { register } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'url';

import { findHeaderRow, detectColumns, resolveMonthColumn } from '../src/reportUtils.js';
import { planAccount } from '../cloudflare-worker/mailer-worker.js';
import { FIXTURE, EXPECTED } from './fixture-sheets-parity.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const PREVIEWS = path.join(REPO, 'dry-run-previews');

let pass = 0;
const failures = [];
function check(ok, label, detail) {
  if (ok) { pass++; return true; }
  failures.push(detail ? `${label}\n        ${detail}` : label);
  return false;
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const slug = (s) => s.replace(/[^a-z0-9]+/gi, '_').slice(0, 80);
const withoutImageSrc = (s) => s.replace(/src="[^"]*"/g, 'src="@"');

// No ClickUp, and no real token: the ClickUp branch must still run and must
// report honestly rather than pretend it succeeded.
process.env.CLICKUP_API_TOKEN = '';
process.env.CLICKUP_AUTO_CLOSE_ENABLED = 'false';

const fake = pathToFileURL(path.join(HERE, 'fixture-sheets-parity.mjs')).href;
process.env.MM_FAKE_SHEETS = fake;
process.env.MM_FAKE_MAILER = pathToFileURL(path.join(HERE, 'agent-mailer-double.mjs')).href;

register(pathToFileURL(path.join(HERE, 'redirect-sheets-module.mjs')).href);
register(pathToFileURL(path.join(HERE, 'redirect-mailer-module.mjs')).href);

const { runJob } = await import('../src/localMailAgent.js');
const double = await import('./agent-mailer-double.mjs');
check(typeof runJob === 'function', 'the agent exposes runJob without starting a poll loop');
check(typeof double.sendReportEmail === 'function', 'the recording double replaced the agent mailer');
check(double.CALLS.length === 0, 'nothing has been sent yet');

// ═══════════════════════════════════════════════════════════════════════════
// Jobs, built the way the Worker builds them
// ═══════════════════════════════════════════════════════════════════════════

const plans = {};
for (const account of Object.keys(FIXTURE)) {
  const { rows, tabs } = FIXTURE[account];
  const { headerRow, headerRowIndex } = findHeaderRow(rows);
  const cols = detectColumns(headerRow);
  const reportMonth = resolveMonthColumn(headerRow, cols.FIRST_MONTH_COL, null);
  const plan = planAccount({
    acct: { key: account, name: `${account} Maintenance`, masterTabName: 'Website List' },
    masterRows: rows, tabTitles: tabs,
    monthCol: reportMonth.columnIndex,
    cols: { ...cols, headerRowIndex },
  });
  for (const j of plan.queued) {
    j.month = reportMonth.monthName;
    j.month_lower = reportMonth.monthLower;
    j.year = reportMonth.year;
  }
  plans[account] = plan;
  check(plan.queued.length === EXPECTED[account].filter((r) => r.outcome === 'queued').length,
    `${account}: the fixture produces jobs to send`, `got ${plan.queued.length}`);
}

// ═══════════════════════════════════════════════════════════════════════════
// What the product itself writes
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n── the product, unmodified ──');

const cliOutput = {};
// NOTE: this suite does NOT clear dry-run-previews/. An earlier version did, and
// it quietly destroyed two preview files left behind by earlier manual work. The
// product names each file after the subject, so it is enough to record what was
// there before and remove only what this run added.
const previewsBefore = new Set(fs.existsSync(PREVIEWS) ? fs.readdirSync(PREVIEWS) : []);
for (const account of Object.keys(FIXTURE)) {
  const res = spawnSync(
    process.execPath,
    ['--import', pathToFileURL(path.join(HERE, 'register-sheets-redirect.mjs')).href,
      path.join(REPO, 'src', 'index.js'), `--account=${account}`],
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
  cliOutput[account] = out;
  check(res.status === 0, `${account}: src/index.js ran`, out.trim().split('\n').slice(-5).join('\n        '));
  check(!/\[sheets\]/.test(out), `${account}: the real src/sheets.js never ran`);
  check(!/✅ Sent/.test(out), `${account}: no live send occurred`);
}
check(fs.existsSync(PREVIEWS), 'the product wrote its dry-run previews');

// ═══════════════════════════════════════════════════════════════════════════
// And what the agent builds and hands over for the same sites
// ═══════════════════════════════════════════════════════════════════════════

console.log('── the agent ──');

for (const account of Object.keys(FIXTURE)) {
  for (const j of plans[account].queued) {
    const label = `${account}/${j.website_url}`;
    double.reset();

    const job = {
      id: `job-${account}-${j.website_url}`,
      runId: 'run-fixture',
      account,
      websiteUrl: j.website_url,
      matchedTab: j.matched_tab,
      recipients: j.recipients,
      month: j.month,
      monthLower: j.month_lower,
      year: j.year,
      timeTrackUrl: j.time_track_url,
      accountManager: j.account_manager,
      // The Worker attaches these to every job it hands out, so the agent needs
      // no local configuration to know which sheet a site belongs to.
      spreadsheetId: `${account.toLowerCase()}-sheet-id`,
      masterTabName: 'Website List',
    };

    const record = await runJob(job);

    // ── the message itself ──
    check(record.subject && !record.subject.includes('undefined'),
      `${label}: the subject is well formed`, JSON.stringify(record.subject));
    check(record.subject === `Website Maintenance Report for ${j.website_url.replace(/^https?:\/\//i, '').replace(/\/+$/, '')} (${j.month} ${j.year})`,
      `${label}: the subject is the product's own format`, `got "${record.subject}"`);

    // ── the handoff, observed rather than assumed ──
    check(double.CALLS.length === 1, `${label}: exactly one message was handed to the mailer`, `got ${double.CALLS.length}`);
    const sent = double.CALLS[0];
    if (sent) {
      check(eq(sent.to, j.recipients), `${label}: addressed to the recipients the Worker chose`,
        `want ${JSON.stringify(j.recipients)} got ${JSON.stringify(sent.to)}`);
      check(sent.subject === record.subject, `${label}: the subject sent is the subject recorded`);
      check(sent.accountKey === account, `${label}: sent through the right workspace account`,
        `want ${account} got ${sent.accountKey}`);
      check(sent.dryRun === false, `${label}: the agent did not silently dry-run`);
    }

    // ── and the outcome it reports ──
    check(record.status === 'sent', `${label}: recorded as sent`, JSON.stringify({ s: record.status, e: record.error }));
    check(/^test-message-/.test(record.messageId || ''), `${label}: the transport's message id was captured`, JSON.stringify(record.messageId));
    check(record.error === null, `${label}: no error recorded on a successful send`);
    check(record.skipReason === null, `${label}: no skip reason on a sent message`);

    // ── ClickUp, run after the send exactly as the CLI orders it ──
    if (j.time_track_url) {
      check(record.clickupStatus === 'dry-run',
        `${label}: ClickUp was attempted but nothing was changed, and the record says so`,
        JSON.stringify(record.clickupStatus));
      check(record.clickupDetail && /not enabled|dryRun flag/i.test(String(record.clickupDetail.reason)),
        `${label}: the ClickUp outcome carries its reason`, JSON.stringify(record.clickupDetail));
    } else {
      check(record.clickupStatus === 'none', `${label}: a site with no time-track URL does not touch ClickUp`, JSON.stringify(record.clickupStatus));
    }

    // ── the actual claim: identical to the product's own output ──
    const previewPath = path.join(PREVIEWS, `${slug(record.subject)}.html`);
    if (!check(fs.existsSync(previewPath), `${label}: the product wrote a preview for this exact subject`,
      `looked for ${path.basename(previewPath)}`)) {
      continue;
    }
    const preview = fs.readFileSync(previewPath, 'utf8');
    const shellStart = preview.indexOf('</div>') + 6;
    const previewBody = preview.slice(shellStart, preview.lastIndexOf('</body></html>')).trim();

    check(withoutImageSrc(((sent && sent.html) || '').trim()) === withoutImageSrc(previewBody),
      `${label}: the agent's body is identical to the product's own output`);
    check(!/src="data:image/.test(record.html),
      `${label}: the agent's message is not preview-inlined — a real send carries the attachment, not a data: URI`);
    check(preview.includes(job.recipients.join(', ')),
      `${label}: the product was addressed to the same recipients`,
      `expected "${job.recipients.join(', ')}" in the preview header`);
  }
}

// Every preview the product wrote must correspond to a message the agent also
// built, so a site the agent silently dropped cannot hide behind a matching subset.
{
  const all = fs.readdirSync(PREVIEWS).filter((f) => f.endsWith('.html'));
  const written = all.filter((f) => !previewsBefore.has(f));
  const planned = Object.values(plans).reduce((n, p) => n + p.queued.length, 0);
  check(written.length === planned,
    'the product and the agent agree on how many messages there are',
    `product wrote ${written.length}, agent planned ${planned}`);

  // Leave the directory as we found it: remove only this run's output.
  for (const f of written) fs.rmSync(path.join(PREVIEWS, f), { force: true });
  const left = fs.readdirSync(PREVIEWS);
  check(left.length === previewsBefore.size,
    'the suite cleaned up exactly what it created and left pre-existing previews alone',
    `before ${previewsBefore.size}, after ${left.length}`);
}

// ═══════════════════════════════════════════════════════════════════════════
// The one thing a fixture cannot reach: the conditional-note paragraph.
//
// No note fires against this fixture, so a behaviour test would pass whether or
// not the agent forwarded notes. Rather than write a note into the live database
// to find out, the agent is required to contain the CLI's call verbatim. This is a
// structural check, not a behavioural one, and it is stated as such.
// ═══════════════════════════════════════════════════════════════════════════

console.log('── the one gap a fixture cannot cover ──');

{
  const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');
  const agent = read('src/localMailAgent.js');
  const cli = read('src/index.js');

  // The report range must be the same string in both. buildEmail turns whatever
  // rows it is given straight into the client's table, so a narrower range is a
  // quietly shorter report and nothing else would notice.
  const range = /'A1:D200'/;
  check(range.test(agent), 'the agent reads the report range A1:D200');
  check(range.test(cli), 'the CLI reads the report range A1:D200');

  // The account must be threaded into the note lookup, and enabledOnly must be
  // set, in both. The expressions differ legitimately — the agent has a job
  // object, the CLI has a local — so the shape is what is compared.
  const notesShape = /getConditionalNotes\(\{\s*account:\s*[A-Za-z_$][\w$.]*,\s*enabledOnly:\s*true\s*\}\)/;
  check(notesShape.test(agent), 'the agent passes an account and enabledOnly:true to getConditionalNotes',
    (agent.match(/getConditionalNotes\([^)]*\)/) || ['(no call found)'])[0]);
  check(notesShape.test(cli), 'the CLI passes an account and enabledOnly:true to getConditionalNotes',
    (cli.match(/getConditionalNotes\([^)]*\)/) || ['(no call found)'])[0]);

  // And the resolved notes must actually reach buildEmail in both.
  const passesNotes = /conditionalNotes,?\s*\n?\s*accountKey/;
  check(passesNotes.test(agent), 'the agent passes the resolved notes into buildEmail');
  check(passesNotes.test(cli), 'the CLI passes the resolved notes into buildEmail');
}

// ═══════════════════════════════════════════════════════════════════════════

if (failures.length) {
  console.log('\nFAILURES');
  for (const f of failures) console.log(`  x ${f}`);
}
console.log(`\n${pass}/${pass + failures.length}`);
process.exit(failures.length ? 1 : 0);
