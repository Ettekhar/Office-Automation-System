/**
 * officeos-mailer — Cloudflare Worker
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * THE SPLIT, and why it is drawn here:
 *
 *   This Worker does everything a browser or a cron can do — it reads the CW and
 *   RM Google Sheets, decides who is due a report and who is not, queues the work,
 *   keeps the ledger, and serves the after-action report that feeds the RAG system.
 *
 *   It does NOT send email, and it never will. Cloudflare cannot open an outbound
 *   SMTP session on the free plan, and that is fine: the operator's own machine is
 *   the sender. It runs `src/localMailAgent.js`, which claims jobs from this Worker
 *   and hands them to the project's own UNMODIFIED `sendReportEmail()`.
 *
 * WHY NO EMAIL IS BUILT HERE:
 *
 *   `buildEmail()` lives in `src/mailer.js`, next to the CW and RM signatures and
 *   the CID image specs. It is the only place the email template exists. Importing
 *   it into a Worker is not possible (it pulls in nodemailer and fs), and copying
 *   the template would create a second copy that drifts — and that copy would be
 *   the one mailing real clients. So the Worker sends only the *decision* and the
 *   data needed to build; the machine that owns the mail owns the mail. One
 *   template, unchanged, and this file cannot alter how a client email looks.
 *
 * THE DECISION LOGIC IS NOT REWRITTEN EITHER:
 *
 *   Eligibility is computed with the project's own `src/reportUtils.js` —
 *   findHeaderRow, detectColumns, resolveMonthColumn, isActive, isMarkedDone,
 *   isValidWebsiteUrl, parseContacts, findMatchingTab. Those are the rules; they
 *   are imported, not cloned. Only the ~25-line walk down the rows is local to this
 *   file, and `scratch/verify-worker-eligibility.mjs` runs this file's planner and
 *   `src/index.js`'s loop over the same fixtures and asserts identical decisions,
 *   so a change to one without the other is a failing test rather than a surprise.
 *
 * Bindings:
 *   DB (D1)                    — the ledger (see schema.sql)
 *   vars  CW_SPREADSHEET_ID / RM_SPREADSHEET_ID / CW_MASTER_TAB_NAME /
 *         RM_MASTER_TAB_NAME / MAX_HTML_CHARS
 *   secret GOOGLE_SERVICE_ACCOUNT_JSON  — service account, spreadsheets.readonly
 *   secret RELAY_TOKEN                  — the local agent's bearer token
 *   secret ADMIN_TOKEN                  — optional extra gate on report/overview
 */

import {
  findHeaderRow,
  detectColumns,
  findMatchingTab,
  resolveMonthColumn,
  isActive,
  isMarkedDone,
  isValidWebsiteUrl,
  parseContacts,
} from '../src/reportUtils.js';

const DONE_MARKER = 'updated & backup';
const TOKEN_SCOPE = 'https://www.googleapis.com/auth/spreadsheets.readonly';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

const enc = new TextEncoder();

// ═══════════════════════════════════════════════════════════════════════════
// Small helpers
// ═══════════════════════════════════════════════════════════════════════════

const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : fallbackId());
function fallbackId() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}
const nowIso = () => new Date().toISOString();

function b64url(bytes) {
  let bin = '';
  const arr = new Uint8Array(bytes);
  for (let i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
const b64urlJson = (obj) => b64url(enc.encode(JSON.stringify(obj)));

function pemToDer(pem) {
  const body = String(pem).replace(/-----BEGIN [A-Z ]+-----/, '').replace(/-----END [A-Z ]+-----/, '').replace(/\s+/g, '');
  const bin = atob(body);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Constant-time-ish compare so a wrong token leaks no length/prefix signal. */
function safeEqual(a, b) {
  const x = String(a || '');
  const y = String(b || '');
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}

function bearer(req) {
  const h = req.headers.get('authorization') || '';
  return h.startsWith('Bearer ') ? h.slice(7) : '';
}

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// Google Sheets access — plain REST + a hand-signed JWT.
//
// `src/sheets.js` cannot come here: it imports googleapis, which is a Node
// library. The request itself is trivial, so the token dance is done with WebCrypto.
// ═══════════════════════════════════════════════════════════════════════════

let cachedToken = null; // { token, expiresAt }

async function googleAccessToken(env) {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) return cachedToken.token;

  const raw = env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON secret is not set');
  const sa = typeof raw === 'string' ? JSON.parse(raw) : raw;

  const issued = Math.floor(Date.now() / 1000);
  const header = b64urlJson({ alg: 'RS256', typ: 'JWT' });
  const claims = b64urlJson({
    iss: sa.client_email,
    scope: TOKEN_SCOPE,
    aud: TOKEN_URL,
    iat: issued,
    exp: issued + 3600,
  });

  const key = await crypto.subtle.importKey(
    'pkcs8',
    pemToDer(sa.private_key),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    key,
    enc.encode(`${header}.${claims}`),
  );
  const assertion = `${header}.${claims}.${b64url(sig)}`;

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }).toString(),
  });
  if (!res.ok) throw new Error(`Google token exchange failed: ${res.status} ${await res.text()}`);
  const body = await res.json();
  cachedToken = { token: body.access_token, expiresAt: Date.now() + (body.expires_in || 3600) * 1000 };
  return cachedToken.token;
}

async function sheetsGet(env, url) {
  const token = await googleAccessToken(env);
  const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Sheets API ${res.status} for ${url}: ${await res.text()}`);
  return res.json();
}

/** Tab titles, matching src/sheets.js listTabTitles(): an array of plain strings. */
async function listTabTitles(env, spreadsheetId) {
  const meta = await sheetsGet(
    env,
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}?fields=sheets.properties.title`,
  );
  return (meta.sheets || []).map((s) => s.properties.title);
}

/** Values for an A1 range, matching src/sheets.js getTabValues(): array of arrays. */
async function getTabValues(env, spreadsheetId, range) {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}`;
  const body = await sheetsGet(env, url);
  return body.values || [];
}

// ═══════════════════════════════════════════════════════════════════════════
// Account resolution
// ═══════════════════════════════════════════════════════════════════════════

/**
 * mailer-wrangler.toml ships with the spreadsheet ids as "REPLACE_WITH_..."
 * placeholders, because that file is committed and the GitHub remote is public.
 * A placeholder is a non-empty string, so a bare truthiness filter would accept
 * it and the first real call would fail deep inside the Sheets client with a 404
 * for a spreadsheet that does not exist. Treating the placeholder as unset turns
 * that into an immediate, honest answer from /api/health instead.
 */
const UNPASTED = /^REPLACE_WITH_|^CHANGE_?ME|^$/;

function usableSpreadsheetId(value) {
  const id = typeof value === 'string' ? value.trim() : '';
  return UNPASTED.test(id) ? '' : id;
}

/**
 * Mirrors `getAllAccountConfigs()` in src/config.js, but from Worker vars because
 * a Worker has no .env file. The env var names are the same ones src/config.js
 * reads, so there is one vocabulary for the same fact.
 */
function accountsFor(env) {
  return [
    { key: 'CW', name: env.CW_NAME || 'CW Maintenance', spreadsheetId: usableSpreadsheetId(env.CW_SPREADSHEET_ID), masterTabName: env.CW_MASTER_TAB_NAME || 'Website List' },
    { key: 'RM', name: env.RM_NAME || 'RM Maintenance', spreadsheetId: usableSpreadsheetId(env.RM_SPREADSHEET_ID), masterTabName: env.RM_MASTER_TAB_NAME || 'Website List' },
  ].filter((a) => a.spreadsheetId);
}

function pickAccounts(env, requested) {
  const all = accountsFor(env);
  if (!requested || requested === 'all' || requested === 'both') return all;
  const key = String(requested).toUpperCase();
  const found = all.filter((a) => a.key === key);
  if (!found.length) throw new Error(`Unknown account "${requested}". Known: ${all.map((a) => a.key).join(', ') || '(none configured)'}`);
  return found;
}

// ═══════════════════════════════════════════════════════════════════════════
// Planning — the only duplicated logic in this file, and it is pinned by a test.
//
// The order of the guards, and their wording, are copied from src/index.js
// processAccount() so that a site is queued in exactly the circumstances the CLI
// would have mailed it. Eligibility is the shared helpers; only this walk is local.
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Decide, for one account, who gets mail. Pure: takes rows, returns decisions.
 * Split out from the I/O so scratch/verify-worker-eligibility.mjs can drive it
 * with fixtures and compare against src/index.js.
 */
export function planAccount({ acct, masterRows, tabTitles, requestedMonth, monthCol, cols }) {
  const queued = [];
  const skipped = [];
  const dataRows = masterRows.slice(cols.headerRowIndex + 1);

  for (let i = 0; i < dataRows.length; i++) {
    const row = dataRows[i];
    const websiteUrl = String(row[cols.WEBSITE_URL] ?? '').trim();

    if (!websiteUrl || !isValidWebsiteUrl(websiteUrl)) continue;

    if (!isActive(row[cols.STATUS])) {
      skipped.push({ websiteUrl, reason: 'inactive' });
      continue;
    }
    if (!isMarkedDone(row[monthCol], DONE_MARKER)) {
      skipped.push({ websiteUrl, reason: 'month cell not marked done' });
      continue;
    }

    const recipients = parseContacts(row[cols.CONTACT]);
    if (recipients.length === 0) {
      skipped.push({ websiteUrl, reason: 'no contact email' });
      continue;
    }

    const matchedTab = findMatchingTab(tabTitles, websiteUrl, acct.masterTabName);
    if (!matchedTab) {
      // The recipients are known at this point, so they are carried through: the
      // report can then say not just that this site was skipped, but who would
      // have received the mail had a tab existed.
      skipped.push({ websiteUrl, reason: 'no matching report tab', recipients });
      continue;
    }

    queued.push({
      seq: i,
      account: acct.key,
      account_name: acct.name,
      website_url: websiteUrl,
      matched_tab: matchedTab,
      recipients: recipients,
      time_track_url: String(row[cols.TIME_TRACK_URL] ?? '').trim(),
      account_manager: String(row[cols.AM] ?? '').trim(),
    });
  }

  return { queued, skipped };
}

/** Read one account's sheet and produce the queue. */
async function planRun(env, { account, month, dryRun, actor, trigger }) {
  const accts = pickAccounts(env, account);
  const runId = uuid();
  const at = nowIso();
  const perAccount = [];
  const allSkipped = [];
  const jobRows = [];

  for (const acct of accts) {
    const [tabTitles, masterRows] = await Promise.all([
      listTabTitles(env, acct.spreadsheetId),
      getTabValues(env, acct.spreadsheetId, 'A1:ZZ2000'),
    ]);
    if (!masterRows || masterRows.length === 0) {
      perAccount.push({ account: acct.key, error: `no rows on "${acct.masterTabName}"` });
      continue;
    }

    const { headerRow, headerRowIndex } = findHeaderRow(masterRows);
    const cols = detectColumns(headerRow);
    const reportMonth = resolveMonthColumn(headerRow, cols.FIRST_MONTH_COL, month || null);
    if (!reportMonth) {
      perAccount.push({
        account: acct.key,
        error: month ? `month column "${month}" not found` : 'no month column found',
      });
      continue;
    }

    const plan = planAccount({
      acct,
      masterRows,
      tabTitles,
      monthCol: reportMonth.columnIndex,
      cols: { ...cols, headerRowIndex },
    });

    for (const j of plan.queued) {
      j.month = reportMonth.monthName;
      j.month_lower = reportMonth.monthLower;
      j.year = reportMonth.year;
    }
    for (const s of plan.skipped) s.account = acct.key;

    perAccount.push({
      account: acct.key,
      spreadsheetId: acct.spreadsheetId,
      month: reportMonth.monthName,
      monthLower: reportMonth.monthLower,
      year: reportMonth.year,
      queued: plan.queued.length,
      skipped: plan.skipped.length,
      columns: cols,
    });
    jobRows.push(...plan.queued);
    allSkipped.push(...plan.skipped);
  }

  // Persist the run, its jobs and its events in one atomic batch.
  const runStmt = env.DB.prepare(
    `INSERT INTO runs (id, created_at, created_by, account, month, dry_run, trigger, stats)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const stmts = [
    runStmt.bind(
      runId, at, actor || 'api', account || 'all',
      perAccount.map((a) => a.month).filter(Boolean).join(', ') || null,
      dryRun ? 1 : 0, trigger || 'api',
      JSON.stringify({ accounts: perAccount, skipped: allSkipped }),
    ),
    env.DB.prepare(
      `INSERT INTO events (id, at, run_id, job_id, kind, detail) VALUES (?, ?, ?, NULL, ?, ?)`,
    ).bind(uuid(), at, runId, 'run.created', JSON.stringify({ accounts: perAccount })),
  ];

  // Skipped sites become first-class job rows, not just a count: the report has to
  // be able to answer "why did this site not get mail", and a count cannot. They
  // carry seq 9999 so they sort after the real queue.
  for (const s of allSkipped) {
    stmts.push(
      env.DB.prepare(
        `INSERT INTO jobs (id, run_id, seq, account, website_url, recipients, status, skip_reason, queued_at, finished_at)
         VALUES (?, ?, ?, ?, ?, ?, 'skipped', ?, ?, ?)`,
      ).bind(
        uuid(), runId, 9999, s.account, s.websiteUrl,
        s.recipients ? JSON.stringify(s.recipients) : null,
        s.reason, at, at,
      ),
      env.DB.prepare(
        `INSERT INTO events (id, at, run_id, job_id, kind, detail) VALUES (?, ?, ?, NULL, 'job.skipped', ?)`,
      ).bind(uuid(), at, runId, JSON.stringify(s)),
    );
  }

  for (const j of jobRows) {
    stmts.push(
      env.DB.prepare(
        `INSERT INTO jobs (id, run_id, seq, account, account_name, website_url, matched_tab,
                           recipients, month, month_lower, year, time_track_url, account_manager,
                           status, queued_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
      ).bind(
        uuid(), runId, j.seq, j.account, j.account_name, j.website_url, j.matched_tab,
        JSON.stringify(j.recipients), j.month, j.month_lower, String(j.year),
        j.time_track_url || null, j.account_manager || null, at,
      ),
    );
  }

  await env.DB.batch(stmts);

  const queuedTotal = perAccount.reduce((n, a) => n + (a.queued || 0), 0);
  const skippedTotal = allSkipped.length;

  // Freeze a summary on the run so the report is cheap and stable.
  await env.DB.prepare(`UPDATE runs SET stats = ? WHERE id = ?`).bind(
    JSON.stringify({
      accounts: perAccount.map((a) => ({ account: a.account, spreadsheetId: a.spreadsheetId, month: a.month, queued: a.queued, skipped: a.skipped, error: a.error })),
      queued: queuedTotal,
      skipped: skippedTotal,
      skippedDetail: allSkipped,
    }),
    runId,
  ).run();

  return { runId, queued: queuedTotal, skipped: skippedTotal, accounts: perAccount };
}

// ═══════════════════════════════════════════════════════════════════════════
// Router
// ═══════════════════════════════════════════════════════════════════════════

async function readBody(req) {
  try { return await req.json(); } catch { return {}; }
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const p = url.pathname.replace(/\/+$/, '') || '/';
    const method = req.method.toUpperCase();

    try {
      // ---- public -------------------------------------------------------
      if (p === '/' || p === '/api/health') {
        return json({
          service: 'officeos-mailer',
          role: 'planner + ledger + report (SMTP is local, by design)',
          configuredAccounts: accountsFor(env).map((a) => ({ key: a.key, spreadsheetId: a.spreadsheetId, masterTab: a.masterTabName })),
          sheetsCredentialConfigured: !!env.GOOGLE_SERVICE_ACCOUNT_JSON,
          relayTokenConfigured: !!env.RELAY_TOKEN,
          d1Bound: !!env.DB,
        });
      }

      // ---- agent-only: claim work --------------------------------------
      if (p === '/api/jobs/next') {
        if (!env.RELAY_TOKEN || !safeEqual(bearer(req), env.RELAY_TOKEN)) return json({ error: 'unauthorized' }, 401);
        const limit = Math.min(Number(url.searchParams.get('limit') || 1), 20);
        const agent = url.searchParams.get('agent') || 'local-agent';
        const at = nowIso();
        const { results } = await env.DB.prepare(
          `SELECT * FROM jobs WHERE status = 'pending' ORDER BY queued_at, seq LIMIT ?`,
        ).bind(limit).all();

        const jobs = results || [];
        if (!jobs.length) return json({ jobs: [] });

        const stmts = jobs.map((j) => [
          env.DB.prepare(`UPDATE jobs SET status='claimed', claimed_at=?, claimed_by=? WHERE id=? AND status='pending'`).bind(at, agent, j.id),
          env.DB.prepare(`INSERT INTO events (id, at, run_id, job_id, kind, detail) VALUES (?,?,?,?,'job.claimed',?)`).bind(uuid(), at, j.run_id, j.id, JSON.stringify({ agent })),
        ]).flat();

        await env.DB.batch(stmts);

        return json({
          jobs: jobs.map((j) => ({
            id: j.id,
            runId: j.run_id,
            account: j.account,
            websiteUrl: j.website_url,
            matchedTab: j.matched_tab,
            recipients: JSON.parse(j.recipients || '[]'),
            month: j.month,
            monthLower: j.month_lower,
            year: j.year,
            timeTrackUrl: j.time_track_url,
            accountManager: j.account_manager,
            spreadsheetId: (accountsFor(env).find((a) => a.key === j.account) || {}).spreadsheetId,
            masterTabName: (accountsFor(env).find((a) => a.key === j.account) || {}).masterTabName,
          })),
        });
      }

      // ---- agent-only: report an outcome -------------------------------
      if (p === '/api/jobs/result') {
        if (!env.RELAY_TOKEN || !safeEqual(bearer(req), env.RELAY_TOKEN)) return json({ error: 'unauthorized' }, 401);
        return handleResult(env, req);
      }

      // ---- admin: plan a run -------------------------------------------
      if (p === '/api/run' && method === 'POST') {
        if (!requireAdmin(req, env)) return json({ error: 'unauthorized' }, 401);
        const body = await readBody(req);
        return json(await planRun(env, {
          account: body.account || null,
          month: body.month || null,
          dryRun: !!body.dryRun,
          actor: body.actor || 'superadmin',
          trigger: body.trigger || 'api',
        }));
      }

      // ---- admin: the RAG report ---------------------------------------
      if (p === '/api/report' || p === '/api/report.md') {
        if (!requireAdmin(req, env)) return json({ error: 'unauthorized' }, 401);
        const report = await buildReport(env, url.searchParams);
        if (p === '/api/report.md') {
          return new Response(toMarkdown(report), {
            headers: { 'content-type': 'text/markdown; charset=utf-8' },
          });
        }
        return json(report);
      }

      // ---- admin: overview --------------------------------------------
      if (p === '/api/overview') {
        if (!requireAdmin(req, env)) return json({ error: 'unauthorized' }, 401);
        return json(await buildOverview(env, url.searchParams.get('account')));
      }

      // ---- admin: runs list -------------------------------------------
      if (p === '/api/runs') {
        if (!requireAdmin(req, env)) return json({ error: 'unauthorized' }, 401);
        const { results } = await env.DB.prepare(
          `SELECT id, created_at, created_by, account, month, dry_run, trigger FROM runs ORDER BY created_at DESC LIMIT 50`,
        ).all();
        return json({ runs: results || [] });
      }

      // ---- admin: a single run's full detail, for RAG ingestion --------
      if (p.startsWith('/api/run/')) {
        if (!requireAdmin(req, env)) return json({ error: 'unauthorized' }, 401);
        const runId = p.slice('/api/run/'.length);
        return json(await buildReport(env, new URLSearchParams({ runId })));
      }

      return json({ error: 'not found', paths: ['/', '/api/health', '/api/run', '/api/runs', '/api/report', '/api/report.md', '/api/overview', '/api/jobs/next', '/api/jobs/result'] }, 404);
    } catch (err) {
      return json({ error: String(err && err.message || err) }, 500);
    }
  },
};

function requireAdmin(req, env) {
  // ADMIN_TOKEN is optional: if it is not set, the endpoints are open, which is
  // acceptable only for a Worker whose URL is itself the secret. Setting it is
  // strongly recommended and is called out in the runbook.
  if (!env.ADMIN_TOKEN) return true;
  return safeEqual(bearer(req), env.ADMIN_TOKEN);
}

async function handleResult(env, req) {
  const body = await readBody(req);
  const {
    jobId, status, messageId = null, error = null, skipReason = null,
    subject = null, html = null, clickupStatus = null, clickupDetail = null,
    agent = 'local-agent', htmlTruncated = false,
  } = body;

  if (!jobId || !status) return json({ error: 'jobId and status are required' }, 400);

  const allowed = ['sent', 'failed', 'skipped', 'pending', 'claimed'];
  if (!allowed.includes(status)) return json({ error: `status must be one of ${allowed.join(', ')}` }, 400);

  const existing = await env.DB.prepare(`SELECT id, run_id, claimed_by FROM jobs WHERE id = ?`).bind(jobId).first();
  if (!existing) return json({ error: 'unknown jobId' }, 404);

  const maxHtml = Number(env.MAX_HTML_CHARS || 400000);
  let storedHtml = html;
  let truncated = htmlTruncated;
  if (typeof html === 'string' && html.length > maxHtml) {
    storedHtml = html.slice(0, maxHtml);
    truncated = true;
  }

  const at = nowIso();
  const stmts = [
    env.DB.prepare(
      `UPDATE jobs SET status=?, message_id=?, error=?, skip_reason=?, subject=?, html=?,
                      clickup_status=?, clickup_detail=?, finished_at=?, claimed_by=COALESCE(?, claimed_by)
       WHERE id=?`,
    ).bind(
      status, messageId, error, skipReason, subject, storedHtml,
      clickupStatus, clickupDetail ? JSON.stringify(clickupDetail) : null, at, agent, jobId,
    ),
    env.DB.prepare(
      `INSERT INTO events (id, at, run_id, job_id, kind, detail) VALUES (?,?,?,?,?,?)`,
    ).bind(uuid(), at, existing.run_id, jobId, `job.${status}`, JSON.stringify({
      messageId, error, skipReason, clickupStatus, truncated: !!truncated,
    })),
  ];

  if (clickupStatus && clickupStatus !== 'none') {
    stmts.push(env.DB.prepare(
      `INSERT INTO events (id, at, run_id, job_id, kind, detail) VALUES (?,?,?,?,?,?)`,
    ).bind(uuid(), at, existing.run_id, jobId, `clickup.${clickupStatus}`, JSON.stringify(clickupDetail || {})));
  }

  await env.DB.batch(stmts);
  return json({ ok: true, jobId, status, htmlStored: storedHtml ? storedHtml.length : 0, truncated: !!truncated });
}

/**
 * The after-action report. This is the artefact the RAG system consumes: for
 * every site in every run it states who received mail, who did not and why,
 * whether the ClickUp task was closed, the exact subject, and the exact body.
 */
async function buildReport(env, params) {
  const runId = params.get('runId');
  const limit = Math.min(Number(params.get('limit') || 200), 1000);
  const includeHtml = params.get('html') !== '0';

  const run = runId
    ? await env.DB.prepare(`SELECT * FROM runs WHERE id = ?`).bind(runId).first()
    : await env.DB.prepare(`SELECT * FROM runs ORDER BY created_at DESC LIMIT 1`).first();

  if (!run) return { runs: [], jobs: [], summary: null, note: 'no runs recorded yet' };

  const { results: jobs } = await env.DB.prepare(
    `SELECT * FROM jobs WHERE run_id = ? ORDER BY seq, website_url LIMIT ?`,
  ).bind(run.id, limit).all();

  const shaped = (jobs || []).map((j) => ({
    jobId: j.id,
    account: j.account,
    accountName: j.account_name,
    websiteUrl: j.website_url,
    matchedTab: j.matched_tab,
    recipients: safeJson(j.recipients, []),
    month: j.month,
    year: j.year,
    mail: {
      status: j.status,
      skipReason: j.skip_reason,
      messageId: j.message_id,
      error: j.error,
      subject: j.subject,
      sentAt: j.finished_at,
    },
    clickup: {
      status: j.clickup_status || 'none',
      detail: safeJson(j.clickup_detail, null),
      timeTrackUrl: j.time_track_url,
    },
    html: includeHtml ? j.html : undefined,
    htmlTruncated: j.html ? j.html.length >= Number(env.MAX_HTML_CHARS || 400000) : false,
  }));

  const byStatus = tally(shaped.map((s) => s.mail.status));
  const byClickup = tally(shaped.map((s) => s.clickup.status));
  const notSent = shaped.filter((s) => s.mail.status !== 'sent').map((s) => ({
    websiteUrl: s.websiteUrl, account: s.account, status: s.mail.status,
    reason: s.mail.skipReason || s.mail.error || '(none recorded)',
  }));

  return {
    generatedAt: nowIso(),
    run: {
      id: run.id, createdAt: run.created_at, createdBy: run.created_by,
      account: run.account, month: run.month, dryRun: !!run.dry_run, trigger: run.trigger,
    },
    summary: {
      total: shaped.length,
      sent: byStatus.sent || 0,
      failed: byStatus.failed || 0,
      skipped: byStatus.skipped || 0,
      pending: (byStatus.pending || 0) + (byStatus.claimed || 0),
      clickupSent: byClickup.sent || 0,
      clickupSkipped: byClickup.skipped || 0,
      clickupDryRun: byClickup['dry-run'] || 0,
      clickupFailed: byClickup.failed || 0,
      recipients: shaped.reduce((n, s) => n + s.recipients.length, 0),
    },
    didNotGetMail: notSent,
    jobs: shaped,
  };
}

async function buildOverview(env, account) {
  const accts = pickAccounts(env, account);
  const out = [];
  for (const acct of accts) {
    const [tabTitles, masterRows] = await Promise.all([
      listTabTitles(env, acct.spreadsheetId),
      getTabValues(env, acct.spreadsheetId, 'A1:ZZ2000'),
    ]);
    if (!masterRows?.length) { out.push({ account: acct.key, error: 'no rows' }); continue; }

    const { headerRow, headerRowIndex } = findHeaderRow(masterRows);
    const cols = detectColumns(headerRow);
    const reportMonth = resolveMonthColumn(headerRow, cols.FIRST_MONTH_COL, null);
    const monthCol = reportMonth?.columnIndex;
    const rows = masterRows.slice(headerRowIndex + 1);
    const sites = [];

    for (const row of rows) {
      const websiteUrl = String(row[cols.WEBSITE_URL] ?? '').trim();
      if (!websiteUrl || !isValidWebsiteUrl(websiteUrl)) continue;
      const active = isActive(row[cols.STATUS]);
      const ready = monthCol != null && isMarkedDone(row[monthCol], DONE_MARKER);
      const recipients = parseContacts(row[cols.CONTACT]);
      const matchedTab = findMatchingTab(tabTitles, websiteUrl, acct.masterTabName);
      let status = 'inactive';
      if (active) {
        if (!ready) status = String(row[monthCol] ?? '').trim() ? 'in_progress' : 'pending';
        else if (!recipients.length) status = 'no_contact';
        else if (!matchedTab) status = 'no_tab';
        else status = 'ready';
      }
      sites.push({
        websiteUrl, status, recipients, matchedTab,
        accountManager: String(row[cols.AM] ?? '').trim(),
        clientNote: String(row[cols.NOTE] ?? '').trim(),
        timeTrackUrl: String(row[cols.TIME_TRACK_URL] ?? '').trim(),
      });
    }
    out.push({
      account: acct.key, spreadsheetId: acct.spreadsheetId,
      month: reportMonth?.monthName || null, year: reportMonth?.year || null,
      timeTrackColumnIndex: cols.TIME_TRACK_URL,
      counts: tally(sites.map((s) => s.status)),
      sites,
    });
  }
  return { generatedAt: nowIso(), accounts: out };
}

function tally(list) {
  const out = {};
  for (const v of list) out[v] = (out[v] || 0) + 1;
  return out;
}

function safeJson(text, fallback) {
  // JSON.parse(null) does not throw — it coerces to "null" and returns null — so a
  // try/catch alone silently hands back null where a caller expects an array, and
  // the crash then surfaces far away from the column that was empty.
  if (text == null) return fallback;
  try {
    const v = JSON.parse(text);
    return v == null ? fallback : v;
  } catch {
    return fallback;
  }
}

/** Flat markdown, because that is what most RAG loaders want to chunk. */
function toMarkdown(report) {
  if (!report.run) return '# officeos-mailer\n\nNo runs recorded yet.\n';
  const L = [];
  L.push(`# Send report — ${report.run.account} ${report.run.month || ''}`.trim());
  L.push('');
  L.push(`- run: \`${report.run.id}\``);
  L.push(`- created: ${report.run.createdAt} by ${report.run.createdBy} (${report.run.trigger}${report.run.dryRun ? ', DRY RUN' : ''})`);
  L.push(`- generated: ${report.generatedAt}`);
  const s = report.summary;
  L.push(`- mail sent: **${s.sent}**, failed: **${s.failed}**, skipped: **${s.skipped}**, still pending: **${s.pending}**`);
  L.push(`- clickup closed: **${s.clickupSent}**, skipped: **${s.clickupSkipped}**, would-have (dry run): **${s.clickupDryRun}**, failed: **${s.clickupFailed}**`);
  L.push(`- recipients: ${s.recipients}`);
  L.push('');
  L.push('## Did not get mail');
  L.push('');
  if (!report.didNotGetMail.length) L.push('_Everyone eligible received mail._');
  else {
    L.push('| site | account | status | reason |');
    L.push('|---|---|---|---|');
    for (const d of report.didNotGetMail) L.push(`| ${d.websiteUrl} | ${d.account} | ${d.status} | ${String(d.reason).replace(/\|/g, '/')} |`);
  }
  L.push('');
  L.push('## Messages');
  L.push('');
  for (const j of report.jobs) {
    if (j.mail.status !== 'sent') continue;
    L.push(`### ${j.websiteUrl} → ${j.recipients.join(', ')}`);
    L.push('');
    L.push(`- subject: ${j.mail.subject}`);
    L.push(`- message id: \`${j.mail.messageId}\``);
    L.push(`- clickup: ${j.clickup.status}${j.clickup.timeTrackUrl ? ` (${j.clickup.timeTrackUrl})` : ''}`);
    L.push('');
  }
  return L.join('\n');
}