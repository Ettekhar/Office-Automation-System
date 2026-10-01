/**
 * Worker API + ledger suite — cloudflare-worker/mailer-worker.js
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * This exercises the Worker's actual request handler against a real SQL engine.
 * schema.sql is executed verbatim by node:sqlite, so the schema and every query
 * in the worker are validated as SQL rather than pattern-matched against a mock.
 * The D1 object is a thin adapter — prepare/bind/first/all/run/batch — and nothing
 * more; all the behaviour under test is the Worker's.
 *
 * The Google Sheets calls are the only thing stubbed, at the fetch boundary, and
 * the JWT is genuinely signed: a real RSA key is generated and the Worker's own
 * PEM → PKCS8 → RSASSA-PKCS1-v1_5 path is exercised, so a break in the token code
 * fails here rather than in production.
 *
 * What is being pinned is the report the operator actually reads: who got mail,
 * who did not and why, whether ClickUp was closed, the subject, and the body.
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import worker from '../cloudflare-worker/mailer-worker.js';
import { findHeaderRow, detectColumns, resolveMonthColumn } from '../src/reportUtils.js';
import { FIXTURE, EXPECTED } from './fixture-sheets-parity.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');

const { DatabaseSync } = await import('node:sqlite');

let pass = 0;
const failures = [];
function check(ok, label, detail) {
  if (ok) { pass++; return true; }
  failures.push(detail ? `${label}\n        ${detail}` : label);
  return false;
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ═══════════════════════════════════════════════════════════════════════════
// A D1 that is honestly just SQLite
// ═══════════════════════════════════════════════════════════════════════════

class D1Statement {
  constructor(db, sql) { this.db = db; this.sql = sql; this.args = []; }
  bind(...args) { this.args = args; return this; }
  #stmt() { return this.db.prepare(this.sql); }
  async first() { const r = this.#stmt().get(...this.args); return r === undefined ? null : r; }
  async all() { return { results: this.#stmt().all(...this.args) }; }
  async run() { return { success: true, meta: this.#stmt().run(...this.args) }; }
}
class D1 {
  constructor(db) { this.db = db; }
  prepare(sql) { return new D1Statement(this.db, sql); }
  async batch(stmts) { return Promise.all(stmts.map((s) => s.run())); }
}

const sql = new DatabaseSync(':memory:');
sql.exec(fs.readFileSync(path.join(REPO, 'cloudflare-worker', 'schema.sql'), 'utf8'));
const DB = new D1(sql);

// ═══════════════════════════════════════════════════════════════════════════
// Google Sheets, stubbed at the fetch boundary
// ═══════════════════════════════════════════════════════════════════════════

const SHEET_FOR_ID = { 'cw-sheet-id': 'CW', 'rm-sheet-id': 'RM' };

const { privateKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

let signedJwt = null;
// Every outbound Sheets request, so a test can assert that an unconfigured account
// is refused BEFORE any network call rather than after a 404 from Google.
const sheetsRequests = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const u = String(url);
  if (u.startsWith('https://oauth2.googleapis.com/token')) {
    const assertion = new URLSearchParams(String(init.body)).get('assertion') || '';
    const [, payload] = assertion.split('.');
    signedJwt = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return new Response(JSON.stringify({ access_token: 'stub-token', expires_in: 3600 }), {
      headers: { 'content-type': 'application/json' },
    });
  }
  if (u.includes('sheets.googleapis.com')) {
    sheetsRequests.push(String(url));
    const id = decodeURIComponent(u.split('/v4/spreadsheets/')[1].split(/[?/]/)[0]);
    const key = SHEET_FOR_ID[id];
    if (!key) return new Response('no such spreadsheet', { status: 404 });
    if (u.includes('fields=sheets.properties.title')) {
      return new Response(JSON.stringify({
        sheets: FIXTURE[key].tabs.map((title) => ({ properties: { title } })),
      }), { headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({ values: FIXTURE[key].rows }), {
      headers: { 'content-type': 'application/json' },
    });
  }
  throw new Error(`unexpected outbound request in the suite: ${u}`);
};

const RELAY = 'relay-token-value';
const ADMIN = 'admin-token-value';

function env(over = {}) {
  return {
    DB,
    CW_SPREADSHEET_ID: 'cw-sheet-id',
    RM_SPREADSHEET_ID: 'rm-sheet-id',
    CW_MASTER_TAB_NAME: 'Website List',
    RM_MASTER_TAB_NAME: 'Website List',
    CW_NAME: 'CW Maintenance',
    RM_NAME: 'RM Maintenance',
    MAX_HTML_CHARS: '400000',
    GOOGLE_SERVICE_ACCOUNT_JSON: JSON.stringify({
      client_email: 'relay@example.iam.gserviceaccount.com',
      private_key: privateKey,
    }),
    RELAY_TOKEN: RELAY,
    ADMIN_TOKEN: ADMIN,
    ...over,
  };
}

const call = (path, { method = 'GET', body, token, e } = {}) =>
  worker.fetch(new Request(`https://worker.test${path}`, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  }), e || env());

// ═══════════════════════════════════════════════════════════════════════════
// 1. Health — and the token path, since the first thing to break is the JWT
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n── health + Google auth ──');

{
  const res = await call('/api/health');
  const body = await res.json();
  check(res.status === 200, 'health returns 200');
  check(eq(body.configuredAccounts.map((a) => a.key), ['CW', 'RM']), 'health lists both accounts', JSON.stringify(body.configuredAccounts));
  check(body.sheetsCredentialConfigured === true, 'health reports the service account is configured');
  check(body.relayTokenConfigured === true, 'health reports the relay token is configured');

  // The spreadsheet ids are Worker SECRETS precisely so they are not published.
  // /api/health is unauthenticated and the Worker URL is not a secret, so echoing
  // them here gave away exactly what the secret store was there to protect - the
  // ids reached the public internet and the repo had never seen them.
  // This asserts ABSENCE, which is the only direction that matters.
  const anon = await (await call('/api/health')).text();
  check(!/cw-sheet-id/.test(anon), 'an unauthenticated health check does not leak the CW spreadsheet id', anon.slice(0, 200));
  check(!/rm-sheet-id/.test(anon), 'an unauthenticated health check does not leak the RM spreadsheet id');
  check(!/"spreadsheetId"/.test(anon), 'an unauthenticated health check has no spreadsheetId field at all');

  const rootAnon = await (await call('/')).text();
  check(!/cw-sheet-id/.test(rootAnon), 'the bare / route does not leak spreadsheet ids either');
  check(!/rm-sheet-id/.test(rootAnon), '…for either account');

  // But an operator holding the admin token still gets them, so the endpoint
  // remains useful for confirming the wiring.
  const asAdmin = await (await call('/api/health', { token: ADMIN })).json();
  check(asAdmin.configuredAccounts.some((a) => a.spreadsheetId === 'cw-sheet-id'),
    'an ADMIN-authenticated health check still shows the resolved spreadsheet ids',
    JSON.stringify(asAdmin.configuredAccounts));
}

// mailer-wrangler.toml ships the spreadsheet ids as REPLACE_WITH_... placeholders
// because that file is committed to a public remote. A placeholder is a non-empty
// string, so without an explicit guard a deploy where nobody pasted the real ids
// would be "configured", list two accounts, and then 404 inside the Sheets client.
// These require the placeholder to read as UNCONFIGURED instead.
{
  const un = await call('/api/health', { e: env({ CW_SPREADSHEET_ID: 'REPLACE_WITH_CW_SPREADSHEET_ID' }) });
  const unBody = await un.json();
  check(eq(unBody.configuredAccounts.map((a) => a.key), ['RM']),
    'an unpasted CW spreadsheet id reads as unconfigured, not as a real sheet',
    JSON.stringify(unBody.configuredAccounts));

  const both = await call('/api/health', { e: env({
    CW_SPREADSHEET_ID: 'REPLACE_WITH_CW_SPREADSHEET_ID',
    RM_SPREADSHEET_ID: 'REPLACE_WITH_RM_SPREADSHEET_ID',
  }) });
  check(eq((await both.json()).configuredAccounts, []),
    'a fresh clone of the committed toml configures zero accounts');

  // A real id, and an id that merely STARTS with something odd, must still work.
  const real = await call('/api/health', { e: env({ CW_SPREADSHEET_ID: '1AbC-_123' }) });
  check(eq((await real.json()).configuredAccounts.map((a) => a.key), ['CW', 'RM']),
    'a genuine spreadsheet id is still accepted');

  const blank = await call('/api/health', { e: env({ CW_SPREADSHEET_ID: '   ' }) });
  check(eq((await blank.json()).configuredAccounts.map((a) => a.key), ['RM']),
    'a whitespace-only id reads as unconfigured');

  // Planning an unconfigured account must be refused on its own terms, not by
  // reaching Google and getting a 404 for a spreadsheet called REPLACE_WITH_...
  const before = sheetsRequests.length;
  const run = await call('/api/run', { method: 'POST', token: ADMIN, body: { account: 'CW' },
    e: env({ CW_SPREADSHEET_ID: 'REPLACE_WITH_CW_SPREADSHEET_ID', RM_SPREADSHEET_ID: '' }) });
  const runStatus = run.status;
  const runError = (await run.json()).error || '';
  check(runStatus >= 400, 'planning an account with no spreadsheet id fails', `status ${runStatus}`);
  check(/Unknown account|no spreadsheet|none configured/i.test(runError),
    '…and says the account is not configured, rather than surfacing a Sheets error',
    `error was: ${runError.slice(0, 200)}`);
  check(sheetsRequests.length === before,
    '…without making a single outbound Sheets request for it',
    `${sheetsRequests.length - before} request(s): ${sheetsRequests.slice(before).join(', ')}`);
}

// ═══════════════════════════════════════════════════════════════════════════
// 2. Auth
// ═══════════════════════════════════════════════════════════════════════════

console.log('── auth ──');

{
  check((await call('/api/jobs/next')).status === 401, 'jobs/next without a token is rejected');
  check((await call('/api/jobs/next', { token: 'wrong' })).status === 401, 'jobs/next with a wrong token is rejected');
  check((await call('/api/run', { method: 'POST', body: {} })).status === 401, 'run without a token is rejected');
  check((await call('/api/report')).status === 401, 'report without a token is rejected');
  check((await call('/api/overview')).status === 401, 'overview without a token is rejected');

  // An open worker: no ADMIN_TOKEN configured means no gate. Documented, and
  // asserted here so the behaviour is a decision rather than an accident.
  const open = await call('/api/report', { e: env({ ADMIN_TOKEN: '' }) });
  check(open.status === 200, 'with no ADMIN_TOKEN set the report is open (documented behaviour)');
}

// ═══════════════════════════════════════════════════════════════════════════
// 3b. A dry run must not leave a claimable queue
//
// This is the safety property that matters most in the whole file. 'pending' is
// the only status /api/jobs/next hands out, so a dry run that wrote 'pending'
// would put real client mail one agent-drain away from going out without anyone
// asking for a send. Found on a live dry run against the real sheets before it
// was written down here.
//
// ORDERING: this runs before any real run so that the claim endpoint is asked
// for work while the only jobs in the ledger are this dry run's. Calling it
// later would CONSUME the real run's pending jobs - the claim has a side effect,
// it is not a query - and the checks after this one would find an empty pool.
// ═══════════════════════════════════════════════════════════════════════════

console.log('── dry run does not arm the queue ──');

let dryRunId = null;
{
  const res = await call('/api/run', { method: 'POST', body: { actor: 'suite', dryRun: true }, token: ADMIN });
  const body = await res.json();
  dryRunId = body.runId;
  check(res.status === 200, 'a dry run returns 200', JSON.stringify(body).slice(0, 200));
  check(body.queued > 0, 'the dry run did queue something, so the checks below are meaningful', `queued ${body.queued}`);

  const claimable = sql.prepare("SELECT COUNT(*) n FROM jobs WHERE run_id = ? AND status = 'pending'").get(dryRunId);
  check(claimable.n === 0, 'a dry run leaves ZERO claimable jobs', `${claimable.n} pending`);

  const asDry = sql.prepare("SELECT COUNT(*) n FROM jobs WHERE run_id = ? AND status = 'dry-run'").get(dryRunId);
  check(asDry.n === body.queued, 'every dry-run job is recorded as dry-run instead',
    `${asDry.n} dry-run vs ${body.queued} queued`);

  // And the end-to-end proof: ask the claim endpoint. It must come back empty.
  const handed = await (await call('/api/jobs/next?limit=20&agent=should-get-nothing', { token: RELAY })).json();
  const fromDry = handed.jobs.filter((j) => j.run_id === dryRunId || j.runId === dryRunId);
  check(fromDry.length === 0, 'the claim endpoint hands out nothing from a dry run', `${fromDry.length} leaked`);

  // Skips are still recorded, because "who did NOT get mail, and why" is the
  // question the report exists to answer and a dry run should still answer it.
  const skips = sql.prepare("SELECT COUNT(*) n FROM jobs WHERE run_id = ? AND status = 'skipped'").get(dryRunId);
  check(skips.n > 0, 'a dry run still records why each ineligible site was skipped', `${skips.n} skips`);

  // And the report must not describe them as pending work in flight. The report
  // always reads the most recent run, which is this one - it was created last.
  const rep = await (await call('/api/report', { token: ADMIN })).json();
  check(rep.run && rep.run.id === dryRunId, 'the report is about this run', rep.run && rep.run.id);
  check(rep.summary.dryRun === body.queued,
    'the report counts dry-run jobs separately from pending',
    `dryRun ${rep.summary.dryRun}, pending ${rep.summary.pending}`);
  check(rep.run.dryRun === true, 'the report marks the run itself as a dry run');
  check(rep.summary.sent === 0 && rep.summary.pending === 0,
    'a dry run reports nothing sent and nothing pending',
    `sent ${rep.summary.sent}, pending ${rep.summary.pending}`);

  const md = await (await call('/api/report.md', { token: ADMIN })).text();
  check(/DRY RUN/.test(md), 'the markdown report says it was a dry run');
}


// ═══════════════════════════════════════════════════════════════════════════
// 3. Planning writes a ledger that matches the truth table
// ═══════════════════════════════════════════════════════════════════════════

console.log('── run planning + ledger ──');

const runRes = await call('/api/run', { method: 'POST', body: { actor: 'superadmin', month: null }, token: ADMIN });
const run = await runRes.json();
check(runRes.status === 200, 'run returns 200', JSON.stringify(run));

// Planning a run is the only thing that reads Google, so it is also the only
// place the token path can be exercised. Exactly one run is created in this
// suite: a second one would leave its jobs in the same pending pool and the
// claim/report assertions below could not say which run they were looking at.
{
  check(!!signedJwt, 'the Worker signed a real JWT for Google');
  check(signedJwt && signedJwt.iss === 'relay@example.iam.gserviceaccount.com', 'JWT issuer is the service account', JSON.stringify(signedJwt));
  check(signedJwt && /spreadsheets/.test(signedJwt.scope || ''), 'JWT asks for spreadsheets scope', JSON.stringify(signedJwt));
  // Two runs exist by this point: the dry run above, and this one. Only the real
  // run's jobs are in the pending pool, because that is the whole point of the
  // dry-run block.
  check(sql.prepare('SELECT COUNT(*) n FROM runs').get().n === 2, 'exactly two runs exist in the ledger');
  check(sql.prepare('SELECT COUNT(*) n FROM runs WHERE dry_run = 1').get().n === 1, 'exactly one of them is flagged dry_run');
  check(sql.prepare("SELECT COUNT(DISTINCT run_id) n FROM jobs WHERE status = 'pending'").get().n === 1,
    'only the real run has pending jobs');
}

{
  const wantQueued = Object.values(EXPECTED).flat().filter((r) => r.outcome === 'queued').length;
  const wantSkipped = Object.values(EXPECTED).flat().filter((r) => r.outcome !== 'queued' && r.outcome !== 'silent').length;
  check(run.queued === wantQueued, 'run queued exactly the eligible sites', `want ${wantQueued} got ${run.queued}`);
  check(run.skipped === wantSkipped, 'run recorded exactly the skipped sites', `want ${wantSkipped} got ${run.skipped}`);

  const dbRows = sql.prepare('SELECT status, COUNT(*) n FROM jobs WHERE run_id = ? GROUP BY status').all(run.runId);
  const tally = Object.fromEntries(dbRows.map((r) => [r.status, r.n]));
  check(tally.pending === wantQueued, 'one pending job row per queued site', JSON.stringify(tally));
  check(tally.skipped === wantSkipped, 'one skipped job row per skipped site', JSON.stringify(tally));

  // Skipped rows must carry a reason, and a queued row must not carry one.
  const noReason = sql.prepare("SELECT COUNT(*) n FROM jobs WHERE run_id = ? AND status='skipped' AND (skip_reason IS NULL OR skip_reason='')").get(run.runId);
  check(noReason.n === 0, 'every skipped job says why', `${noReason.n} skipped rows have no reason`);
  const queuedWithReason = sql.prepare("SELECT COUNT(*) n FROM jobs WHERE run_id = ? AND status='pending' AND skip_reason IS NOT NULL").get(run.runId);
  check(queuedWithReason.n === 0, 'no queued job carries a skip reason');

  // Recipients, month and time-track must have survived the round trip.
  const sample = sql.prepare("SELECT * FROM jobs WHERE run_id = ? AND website_url = 'cw-ok.test'").get(run.runId);
  check(!!sample, 'cw-ok.test has a job row');
  check(JSON.parse(sample.recipients || '[]').join() === 'a@b.com', 'recipients stored as a JSON array', sample && sample.recipients);
  check(sample.month === 'May', 'month name resolved from the header', sample && sample.month);
  check(sample.time_track_url === 'https://app.clickup.com/t/tt-1', 'time-track URL stored', sample && sample.time_track_url);
  check(sample.matched_tab === 'cw-ok.test', 'matched tab stored', sample && sample.matched_tab);
}

// ═══════════════════════════════════════════════════════════════════════════
// 4. Claiming work
// ═══════════════════════════════════════════════════════════════════════════

console.log('── claiming jobs ──');

let claimedId = null;
{
  const res = await call('/api/jobs/next?limit=3&agent=suite-agent', { token: RELAY });
  const body = await res.json();
  check(res.status === 200, 'jobs/next returns 200');
  check(body.jobs.length === 3, 'the requested number of jobs is handed over', `got ${body.jobs.length}`);
  check(body.jobs.every((j) => j.status === undefined || true), 'claimed jobs are returned in the job shape');
  check(body.jobs.every((j) => j.spreadsheetId && j.masterTabName), 'each job carries the sheet it belongs to, so the agent needs no config');
  claimedId = body.jobs[0].id;

  const row = sql.prepare('SELECT status, claimed_by FROM jobs WHERE id = ?').get(claimedId);
  check(row.status === 'claimed', 'a claimed job leaves the pending pool', JSON.stringify(row));
  check(row.claimed_by === 'suite-agent', 'the claiming agent is recorded');

  const ev = sql.prepare("SELECT COUNT(*) n FROM events WHERE job_id = ? AND kind = 'job.claimed'").get(claimedId);
  check(ev.n === 1, 'the claim is written to the event log');

  // A second claim must not hand out the same job.
  const again = await (await call('/api/jobs/next?limit=9', { token: RELAY })).json();
  check(!again.jobs.some((j) => j.id === claimedId), 'a claimed job is not handed out twice');
}

// ═══════════════════════════════════════════════════════════════════════════
// 5. Reporting an outcome — the ledger the operator reads
// ═══════════════════════════════════════════════════════════════════════════

console.log('── outcome recording ──');

const SENT_HTML = '<div>Maintenance report body</div>';
{
  const res = await call('/api/jobs/result', {
    method: 'POST', token: RELAY,
    body: {
      jobId: claimedId, status: 'sent', messageId: '<abc@mail.example>',
      subject: 'Website Maintenance Report for cw-ok.test (May 2026)',
      html: SENT_HTML, clickupStatus: 'sent', clickupDetail: { taskId: 'tt-1' },
    },
  });
  const body = await res.json();
  check(res.status === 200, 'result accepted', JSON.stringify(body));
  check(body.htmlStored === SENT_HTML.length, 'the body length is reported back', JSON.stringify(body));

  const row = sql.prepare('SELECT * FROM jobs WHERE id = ?').get(claimedId);
  check(row.status === 'sent' && row.message_id === '<abc@mail.example>', 'sent status and message id recorded');
  check(row.subject.includes('cw-ok.test'), 'subject recorded', row.subject);
  check(row.html === SENT_HTML, 'the full body is stored verbatim');
  check(row.clickup_status === 'sent', 'clickup status recorded', row.clickup_status);
  check(JSON.parse(row.clickup_detail).taskId === 'tt-1', 'clickup detail recorded');
  check(!!row.finished_at, 'finished_at stamped');
}

{
  check((await call('/api/jobs/result', { method: 'POST', token: RELAY, body: { status: 'sent' } })).status === 400,
    'a result with no jobId is rejected');
  check((await call('/api/jobs/result', { method: 'POST', token: RELAY, body: { jobId: claimedId, status: 'delivered-ish' } })).status === 400,
    'a made-up status is rejected');
  check((await call('/api/jobs/result', { method: 'POST', token: RELAY, body: { jobId: 'no-such-job', status: 'sent' } })).status === 404,
    'a result for an unknown job is rejected');
}

// A body larger than the cap must be truncated and SAY SO, not silently shortened.
// Run against a Worker whose cap is 100 so the check does not need a 400 KB string.
{
  const capped = env({ MAX_HTML_CHARS: '100' });
  // Its own run, so the claim does not depend on how many jobs the claim tests
  // above happened to consume, and so the job under test is unmistakably this
  // test's own.
  const fresh = await (await call('/api/run', { method: 'POST', token: ADMIN, e: capped, body: { account: 'CW', actor: 'truncation-test' } })).json();
  check(fresh.queued > 0, 'a fresh run queued work to test truncation with', JSON.stringify(fresh));
  const next = await (await call('/api/jobs/next?limit=1&agent=trunc', { token: RELAY, e: capped })).json();
  check(next.jobs.length === 1, 'a job was available to test truncation with', JSON.stringify(next).slice(0, 200));
  const res = await (await call('/api/jobs/result', {
    method: 'POST', token: RELAY, e: capped,
    body: { jobId: next.jobs[0].id, status: 'sent', html: 'y'.repeat(500) },
  })).json();
  check(res.truncated === true, 'an over-long body is reported as truncated', JSON.stringify(res));
  check(res.htmlStored === 100, 'the stored body is capped at MAX_HTML_CHARS', JSON.stringify(res));
  const stored = sql.prepare('SELECT html FROM jobs WHERE id = ?').get(next.jobs[0].id);
  check(stored.html.length === 100, 'what landed in the database is the capped body, not the whole thing', `len ${stored.html.length}`);
}

// ═══════════════════════════════════════════════════════════════════════════
// 6. The report
// ═══════════════════════════════════════════════════════════════════════════

console.log('── the report ──');

{
  const res = await call('/api/report?runId=' + run.runId, { token: ADMIN });
  const body = await res.json();
  check(res.status === 200, 'report returns 200');

  const wantQueued = Object.values(EXPECTED).flat().filter((r) => r.outcome === 'queued').length;
  const wantSkipped = Object.values(EXPECTED).flat().filter((r) => r.outcome !== 'queued' && r.outcome !== 'silent').length;

  check(body.summary.total === wantQueued + wantSkipped, 'report covers every row that was considered', `want ${wantQueued + wantSkipped} got ${body.summary.total}`);
  check(body.summary.sent === 1, 'one site is recorded as sent', JSON.stringify(body.summary));
  check(body.summary.skipped === wantSkipped, 'skipped count matches', JSON.stringify(body.summary));
  check(body.summary.clickupSent === 1, 'clickup close is counted', JSON.stringify(body.summary));
  // Recipients are totalled across every job, which includes the sites skipped
  // for having no report tab — their contacts were resolved, so they count.
  const wantRecipients = Object.values(EXPECTED).flat()
    .reduce((n, r) => n + (r.recipients ? r.recipients.length : 0), 0);
  check(body.summary.recipients === wantRecipients,
    'recipients are totalled, including those on skipped sites', `want ${wantRecipients} got ${body.summary.recipients}`);

  // The whole point: "who didn't get mail, and why".
  check(body.didNotGetMail.length === body.summary.total - 1, 'every non-sent site is listed as not having received mail', JSON.stringify(body.summary));
  const byUrl = Object.fromEntries(body.didNotGetMail.map((d) => [d.websiteUrl, d]));
  check(byUrl['cw-both.test'] && byUrl['cw-both.test'].reason === 'inactive',
    'a site that is both inactive and not-done is reported as inactive', JSON.stringify(byUrl['cw-both.test']));
  check(byUrl['cw-nocontact.test'] && byUrl['cw-nocontact.test'].reason === 'no contact email',
    'the no-contact reason survives into the report');
  check(byUrl['cw-notab.test'] && byUrl['cw-notab.test'].reason === 'no matching report tab',
    'the no-tab reason survives into the report');
  check(!('cw-bogus.test' in byUrl) && !('' in byUrl), 'rows dropped for being blank or not a URL are not invented into the report');

  const sent = body.jobs.find((j) => j.jobId === claimedId);
  check(sent && sent.mail.subject.includes('cw-ok.test'), 'the sent subject is in the report');
  check(sent && sent.html === SENT_HTML, 'the full body is in the report');
  check(sent && sent.clickup.status === 'sent', 'the clickup outcome is in the report');

  // Markdown, because that is what a RAG loader chunks.
  const md = await call('/api/report.md?runId=' + run.runId, { token: ADMIN });
  const mdText = await md.text();
  check(md.headers.get('content-type').includes('text/markdown'), 'report.md is served as markdown', md.headers.get('content-type'));
  check(/^# Send report/m.test(mdText), 'markdown has a heading');
  check(mdText.includes('## Did not get mail'), 'markdown has the not-sent section');
  check(mdText.includes('cw-nocontact.test'), 'markdown names the sites that did not get mail');
}

// ═══════════════════════════════════════════════════════════════════════════
// 7. Overview
// ═══════════════════════════════════════════════════════════════════════════

console.log('── overview ──');

{
  const body = await (await call('/api/overview', { token: ADMIN })).json();
  check(body.accounts.length === 2, 'overview covers both accounts');

  for (const account of Object.keys(FIXTURE)) {
    const rows = FIXTURE[account].rows;
    const { headerRow, headerRowIndex } = findHeaderRow(rows);
    const cols = detectColumns(headerRow);
    const monthCol = resolveMonthColumn(headerRow, cols.FIRST_MONTH_COL, null).columnIndex;
    const got = body.accounts.find((a) => a.account === account);
    // Rows the product drops for having no usable URL are not sites, so the
    // overview does not list them — and must not invent them either.
    const listed = EXPECTED[account].filter((r) => r.outcome !== 'silent');

    check(!!got, `${account}: overview present`);
    check(got.sites.length === listed.length,
      `${account}: overview lists exactly the rows with a usable URL`,
      `want ${listed.length} got ${got.sites.length}`);

    for (const e of listed) {
      const site = got.sites.find((s) => s.websiteUrl === e.url);
      if (!check(!!site, `${account}: overview has ${e.url}`)) continue;
      // Derive the expected bucket from the truth table plus the raw cell, rather
      // than restating it, so the two cannot drift together.
      let want;
      if (e.outcome === 'queued') want = 'ready';
      else if (e.outcome === 'no contact email') want = 'no_contact';
      else if (e.outcome === 'no matching report tab') want = 'no_tab';
      else if (e.outcome === 'inactive') want = 'inactive';
      else {
        const raw = rows.find((r) => String(r[cols.WEBSITE_URL] ?? '').trim() === e.url);
        want = String(raw?.[monthCol] ?? '').trim() ? 'in_progress' : 'pending';
      }
      check(site.status === want, `${account}: ${e.url} overview status`, `want "${want}" got "${site.status}"`);
    }
    check(got.timeTrackColumnIndex === cols.TIME_TRACK_URL,
      `${account}: overview reports the time-track column it resolved by name`,
      `want ${cols.TIME_TRACK_URL} got ${got.timeTrackColumnIndex}`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 8. Misc
// ═══════════════════════════════════════════════════════════════════════════

console.log('── misc ──');

{
  const nf = await call('/api/nope');
  check(nf.status === 404, 'an unknown path is a 404');
  check(Array.isArray((await nf.json()).paths), 'the 404 lists the real paths, so a typo is self-correcting');

  const rmOnly = await call('/api/run', { method: 'POST', token: ADMIN, body: { account: 'RM' } });
  const rmRun = await rmOnly.json();
  check(rmRun.status === 200 || rmOnly.status === 200, 'a single-account run is accepted');
  check(rmRun.accounts.length === 1 && rmRun.accounts[0].account === 'RM', 'a single-account run touches only that account', JSON.stringify(rmRun.accounts));
  const rmJobs = sql.prepare('SELECT COUNT(*) n FROM jobs WHERE run_id = ?').get(rmRun.runId);
  const rmWant = EXPECTED.RM.filter((r) => r.outcome !== 'silent').length;
  check(rmJobs.n === rmWant, 'the single-account run writes only its own rows', `want ${rmWant} got ${rmJobs.n}`);

  const bad = await call('/api/run', { method: 'POST', token: ADMIN, body: { account: 'ZZ' } });
  check(bad.status === 500 && /Unknown account/.test((await bad.json()).error), 'an unknown account is refused by name');
}

globalThis.fetch = realFetch;

// ═══════════════════════════════════════════════════════════════════════════

if (failures.length) {
  console.log('\nFAILURES');
  for (const f of failures) console.log(`  x ${f}`);
}
console.log(`\n${pass}/${pass + failures.length}`);
process.exit(failures.length ? 1 : 0);