/**
 * localMailAgent.js — the SMTP half
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Cloudflare cannot open an outbound SMTP connection on the free plan, so this
 * runs on the operator's machine. It claims jobs the Worker has planned, sends
 * them, and reports the outcome back so the after-action report is complete.
 *
 * WHAT IT CALLS, AND WHY THAT MATTERS:
 *
 *   buildEmail()                    src/mailer.js      ← unchanged
 *   sendReportEmail()               src/mailer.js      ← unchanged
 *   completeClickUpMaintenanceTask() src/clickup.js    ← unchanged
 *   rowsToHtmlTable()               src/reportUtils.js ← unchanged
 *   resolveConditionalNotes()       src/reportUtils.js ← unchanged
 *   getTabValues()                  src/sheets.js      ← unchanged
 *   getConditionalNotes()           src/db.js          ← unchanged
 *
 * Not one of those files is edited, stubbed, wrapped or re-implemented. This
 * process is an ORCHESTRATOR around the existing code, not a second
 * implementation of it. That is the whole point: an email produced by the agent
 * is byte-for-byte the email `npm run send` produces, because it is the same
 * function producing it, with the same per-account signature, the same CID
 * image inlining and the same conditional-note paragraphs.
 *
 * It also does NOT build a run. Planning lives in the Worker, which is what
 * lets a superadmin queue work from anywhere and have this machine pick it up.
 *
 * USAGE
 *   npm run relay              poll until stopped
 *   npm run relay -- --once    drain what is pending, then exit
 *   npm run relay -- --once --dry-run   build everything, send nothing
 *
 * CONFIG (env or .env)
 *   MAILER_WORKER_URL   required  e.g. https://officeos-mailer.<sub>.workers.dev
 *   RELAY_TOKEN         required  must match the Worker's secret of the same name
 *   AGENT_NAME          optional  label recorded in the ledger (default hostname)
 */

import { getTabValues } from './sheets.js';
import { rowsToHtmlTable, resolveConditionalNotes } from './reportUtils.js';
import { buildEmail, sendReportEmail } from './mailer.js';
import { completeClickUpMaintenanceTask } from './clickup.js';
import { getConditionalNotes } from './db.js';
import { pathToFileURL } from 'url';

// ESM imports are hoisted, so the config check has to live in a function that
// runs after them. It still fails before anything is sent.
const WORKER_URL = String(process.env.MAILER_WORKER_URL || '').replace(/\/+$/, '');
const RELAY_TOKEN = String(process.env.RELAY_TOKEN || '');
const AGENT_NAME = String(process.env.AGENT_NAME || process.env.COMPUTERNAME || 'local-agent');
const DRY_RUN = process.argv.includes('--dry-run');
const ONCE = process.argv.includes('--once');
const IDLE_SLEEP_MS = Number(process.env.RELAY_IDLE_SLEEP_MS || 20000);
const ERROR_BACKOFF_MS = Number(process.env.RELAY_ERROR_BACKOFF_MS || 60000);
const MAX_JOBS = Number(process.env.RELAY_MAX_JOBS || 50);

function requireConfig() {
  const missing = [];
  if (!WORKER_URL) missing.push('MAILER_WORKER_URL');
  if (!RELAY_TOKEN) missing.push('RELAY_TOKEN');
  if (missing.length) {
    console.error(`\nCannot start. Missing: ${missing.join(', ')}\n`);
    console.error('  MAILER_WORKER_URL  the deployed Worker URL, e.g. https://officeos-mailer.x.workers.dev');
    console.error('  RELAY_TOKEN        must equal the Worker secret RELAY_TOKEN\n');
    process.exit(1);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(`${WORKER_URL}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${RELAY_TOKEN}`,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${data.error || text.slice(0, 200)}`);
  return data;
}

/**
 * Send exactly one job and describe what happened.
 *
 * Returns the record the Worker stores. Nothing here decides policy — the
 * Worker already decided who should get mail; this only executes and observes.
 *
 * Exported so scratch/verify-agent-email.mjs can drive it directly and compare
 * the result against what `npm run send` produces for the same site.
 */
export async function runJob(job) {
  // Defence in depth. /api/jobs/next only ever hands out status='pending', and a
  // run created with dryRun queues as 'dry-run', so this should be unreachable.
  // It is checked anyway because the failure it prevents is real mail to real
  // clients from a rehearsal, and the cost of the check is one comparison.
  if (job && job.status && job.status !== 'pending' && job.status !== 'claimed') {
    return {
      jobId: job.id, agent: AGENT_NAME, status: 'skipped', subject: null, html: null,
      messageId: null, error: null,
      skipReason: `refused: job status is "${job.status}", not pending`,
      clickupStatus: 'none', clickupDetail: null,
    };
  }

  const record = {
    jobId: job.id,
    agent: AGENT_NAME,
    status: 'pending',
    subject: null,
    html: null,
    messageId: null,
    error: null,
    skipReason: null,
    clickupStatus: 'none',
    clickupDetail: null,
  };

  try {
    // 1. The report tab is read here, not in the Worker, so the report content
    //    comes from exactly the same call the CLI makes.
    const reportRows = await getTabValues(job.matchedTab, 'A1:D200', job.spreadsheetId);
    const { reportHtml, hasAdditionalIssues, hasPremiumPlugins } = rowsToHtmlTable(reportRows);

    // 2. Conditional notes are resolved locally too: they live in this repo's
    //    database, and resolving them here keeps the paragraph identical to the
    //    one the CLI would have produced.
    const conditionalNotes = resolveConditionalNotes(
      reportRows,
      getConditionalNotes({ account: job.account, enabledOnly: true }),
    );

    // buildEmail() reads exactly two fields off this object — reportMonth.monthName
    // and reportMonth.year — and those decide the subject line. They are the names
    // resolveMonthColumn() uses; handing it any other shape silently produces a
    // subject reading "(undefined 2026)".
    const reportMonth = { monthName: job.month, monthLower: job.monthLower, year: Number(job.year) };

    const { subject, html } = buildEmail({
      websiteUrl: job.websiteUrl,
      reportMonth,
      reportHtml,
      hasAdditionalIssues,
      hasPremiumPlugins,
      conditionalNotes,
      accountKey: job.account,
    });
    record.subject = subject;
    record.html = html;

    if (DRY_RUN) {
      record.status = 'skipped';
      record.skipReason = 'agent running with --dry-run';
      return record;
    }

    // 3. The send. Untouched.
    const info = await sendReportEmail({
      to: job.recipients,
      subject,
      html,
      dryRun: false,
      accountKey: job.account,
    });
    record.status = 'sent';
    record.messageId = info && (info.messageId || info.messageID) ? (info.messageId || info.messageID) : null;

    // 4. ClickUp, exactly where src/index.js puts it — after a successful send,
    //    and only when the row carried a time-track URL.
    if (job.timeTrackUrl) {
      try {
        const cu = await completeClickUpMaintenanceTask({
          timeTrackUrl: job.timeTrackUrl,
          websiteUrl: job.websiteUrl,
          accountManager: job.accountManager,
          monthName: job.month ? `${job.month} ${job.year}` : null,
          dryRun: false,
        });
        record.clickupDetail = cu;
        // completeClickUpMaintenanceTask has three outcomes and they are not
        // interchangeable: `skipped` (no task id to act on), `dryRun` (it declined
        // to make a live change — usually because CLICKUP_AUTO_CLOSE_ENABLED is
        // off), and a real result. Only the last one means a task was actually
        // closed. Folding the first two into "sent" would put a false tick in the
        // one report whose entire job is to say who did NOT get theirs.
        if (cu && cu.skipped) record.clickupStatus = 'skipped';
        else if (cu && cu.dryRun) record.clickupStatus = 'dry-run';
        else record.clickupStatus = 'sent';
      } catch (cuErr) {
        // A ClickUp failure is NOT an email failure. The client already has the
        // report; saying the mail failed would be a lie, and saying nothing
        // would hide it. So it is recorded separately and the mail stays 'sent'.
        record.clickupStatus = 'failed';
        record.clickupDetail = { error: String(cuErr && cuErr.message || cuErr) };
      }
    } else {
      record.clickupStatus = 'none';
    }
  } catch (err) {
    record.status = 'failed';
    record.error = String(err && err.message || err);
    if (record.clickupStatus === 'none') record.clickupStatus = 'none';
  }

  return record;
}

async function drain() {
  let claimed = 0;
  let sent = 0;
  let failed = 0;

  for (let i = 0; i < MAX_JOBS; i++) {
    const { jobs } = await api(`/api/jobs/next?limit=1&agent=${encodeURIComponent(AGENT_NAME)}`);
    if (!jobs || !jobs.length) break;

    const job = jobs[0];
    claimed++;
    const tag = `[${job.account}] ${job.websiteUrl} → ${job.recipients.join(', ')}`;
    console.log(`  ${DRY_RUN ? 'dry ' : ''}${tag}`);

    const record = await runJob(job);
    await api('/api/jobs/result', { method: 'POST', body: record });

    if (record.status === 'sent') sent++;
    else failed++;
    const cu = record.clickupStatus && record.clickupStatus !== 'none' ? `  clickup=${record.clickupStatus}` : '';
    console.log(`      ${record.status}${record.messageId ? ` (${record.messageId})` : ''}${record.error ? ` — ${record.error}` : ''}${cu}`);

    await sleep(Number(process.env.RELAY_SEND_GAP_MS || 300));
  }

  return { claimed, sent, failed };
}

async function main() {
  requireConfig();
  console.log(`\nlocalMailAgent — ${WORKER_URL}`);
  console.log(`  agent=${AGENT_NAME}  dryRun=${DRY_RUN}  once=${ONCE}\n`);

  if (ONCE) {
    const r = await drain();
    console.log(`\n  claimed=${r.claimed} sent=${r.sent} failedOrSkipped=${r.failed}\n`);
    process.exit(r.failed ? 1 : 0);
  }

  console.log(`  polling every ${Math.round(IDLE_SLEEP_MS / 1000)}s — Ctrl+C to stop\n`);
  for (;;) {
    try {
      const r = await drain();
      if (r.claimed) console.log(`  -- ${r.claimed} claimed, ${r.sent} sent, ${r.failed} failed/skipped\n`);
    } catch (err) {
      // A worker that is down, or a token that is wrong, must not spin hot and
      // must not look like a successful no-op run.
      console.error(`  relay error: ${err.message}`);
      console.error(`  backing off ${Math.round(ERROR_BACKOFF_MS / 1000)}s\n`);
      await sleep(ERROR_BACKOFF_MS);
      continue;
    }
    await sleep(IDLE_SLEEP_MS);
  }
}

// Only take over the process when this file IS the process. Importing it — as the
// email-equality suite does, to call runJob() against a fixture — must not start
// polling a Worker that may not exist.
const isEntryPoint = process.argv[1]
  && pathToFileURL(process.argv[1]).href === import.meta.url;

if (isEntryPoint) {
  main().catch((err) => {
    console.error('Fatal:', err);
    process.exit(1);
  });
}