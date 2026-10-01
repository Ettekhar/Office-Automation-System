/**
 * reportAutomation.js — Daily Report Feed bridge
 *
 * Lets OfficeOS read the Report Automation Worker's report log so the chat can
 * answer daily-report questions ("who hasn't submitted today", "what did X
 * report on <date>", "reports for yesterday", …).
 *
 * Design notes
 *  - Read-only by design: OfficeOS only calls the Worker's public GET
 *    /api/report-log endpoint, authenticated with the service token stored in
 *    data/assistant-config.json (git-ignored, masked in the dashboard).
 *  - The log is mirrored to data/daily-reports.json so chat questions don't
 *    hammer the Worker and the RAG index can embed report chunks.
 *  - Deterministic answers mirror the Dev Assistant's builtin engine shape so
 *    chat stays honest when no report exists for a date/user.
 *  - No ClickUp token is ever copied here; this module never touches ClickUp.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getUsers } from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, '../data');
const MIRROR_PATH = path.join(DATA_DIR, 'daily-reports.json');
const TEAM_TIMEZONE = 'Asia/Dhaka';

// ─── Date helpers (report dates are YYYY-MM-DD in the team timezone) ────────

function dateInTZ(date = new Date()) {
  // en-CA format yields YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', { timeZone: TEAM_TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

export function todayInTeamTZ() { return dateInTZ(); }

export function shiftDate(isoDate, days) {
  const [y, m, d] = String(isoDate).split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return dt.toISOString().slice(0, 10);
}

const DAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

/** Most recent date matching a weekday name like "friday"/"Friday". */
function weekdayDate(name) {
  const idx = DAY_NAMES.indexOf(String(name || '').trim().toLowerCase());
  if (idx < 0) return null;
  const today = todayInTeamTZ();
  const todayDow = new Date(today + 'T00:00:00Z').getUTCDay();
  const diff = (todayDow - idx + 7) % 7;
  return shiftDate(today, -diff);
}

// ─── Report log API ─────────────────────────────────────────────────────────

const cleanBaseUrl = (baseUrl) => String(baseUrl || '').trim().replace(/\/+$/, '');

export async function fetchReportLog({ baseUrl, apiKey, limit = 500, offset = 0 } = {}) {
  const base = cleanBaseUrl(baseUrl);
  if (!base) throw new Error('Report Automation base URL is not configured');
  if (!apiKey) throw new Error('Report Automation API key is not configured');
  const url = `${base}/api/report-log?limit=${limit}&offset=${offset}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` } });
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) throw new Error('Report Automation API rejected the key (401/403) — check the service token');
    throw new Error(`Report Automation API error ${res.status}`);
  }
  const body = await res.json();
  return { items: Array.isArray(body.items) ? body.items : [], meta: body.meta || {} };
}

// ─── Mirror (data/daily-reports.json) ───────────────────────────────────────

export function loadReportMirror() {
  try { return JSON.parse(fs.readFileSync(MIRROR_PATH, 'utf8')); }
  catch { return { items: [], updatedAt: null }; }
}

export function saveReportMirror(items) {
  const data = { items, updatedAt: new Date().toISOString() };
  fs.writeFileSync(MIRROR_PATH, JSON.stringify(data, null, 2), 'utf8');
  return data;
}

export function reportMirrorSummary() {
  const mirror = loadReportMirror();
  const dates = [...new Set((mirror.items || []).map((item) => item.reportDate).filter(Boolean))].sort();
  return {
    count: (mirror.items || []).length,
    updatedAt: mirror.updatedAt,
    latestDate: dates[dates.length - 1] || null,
    authors: [...new Set((mirror.items || []).map((item) => item.user?.name).filter(Boolean))],
  };
}

// Mirrors that are missing reports, more than this old, or more than a day
// behind the worker log are considered stale and get re-fetched — so
// admin/superadmin report status and chat answers never lag the submissions.
const MIRROR_MAX_AGE_MS = 6 * 60 * 60 * 1000;

/** True when the mirror is empty, stale by age, or a day behind the log. */
export function isReportMirrorStale(mirror = loadReportMirror()) {
  const items = (mirror.items || []).filter((i) => i.reportDate && i.user?.name);
  if (!items.length) return true;
  const latest = [...new Set(items.map((i) => i.reportDate))].sort().pop();
  if (latest && latest < shiftDate(todayInTeamTZ(), -1)) return true;
  if (mirror.updatedAt) {
    const age = Date.now() - new Date(mirror.updatedAt).getTime();
    if (Number.isFinite(age) && age > MIRROR_MAX_AGE_MS) return true;
  }
  return false;
}

/** Fetch fresh when `refresh` is true or the mirror is stale; else use cache. */
export async function syncReportMirror({ config = {}, refresh = false } = {}) {
  const existing = loadReportMirror();
  if (!refresh && !isReportMirrorStale(existing)) return existing;
  if (config.enabled === false) return existing;
  const { items } = await fetchReportLog(config);
  return saveReportMirror(items);
}

export async function testReportFeed(config = {}) {
  try {
    const { items, meta } = await fetchReportLog({ ...config, limit: Math.min(50, Number(config.limit) || 50) });
    const dates = [...new Set((items || []).map((i) => i.reportDate).filter(Boolean))];
    const latest = (items || [])[0]?.reportDate || null;
    return {
      ok: true,
      message: `Connected — ${meta.total ?? items.length} report(s) in the log${latest ? `, latest ${latest}` : ''}`,
      total: meta.total ?? items.length,
      count: (items || []).length,
      latestDate: latest,
      sampleDates: dates.slice(0, 5),
      scope: meta.scope || 'unknown',
    };
  } catch (e) {
    return { ok: false, message: e.message || 'Connection failed', count: 0 };
  }
}

// ─── RAG chunks ─────────────────────────────────────────────────────────────

function clip(text, max = 900) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** Build daily_report chunks in the same metadata shape as sheet/doc chunks. */
export function reportChunks(items, baseUrl = '') {
  const base = cleanBaseUrl(baseUrl);
  const chunks = [];
  for (const item of items || []) {
    const name = item.user?.name || 'Unknown';
    const counts = item.answer?.counts || {};
    const whatsapp = clip(reportWhatsappText(item), 450);
    const body = whatsapp || clip(item.answer?.finalReport, 700);
    const countsLine = `assigned ${counts.totalAssigned ?? 0} · done ${counts.tasksDone ?? 0} · in review ${counts.inReview ?? 0} · in progress ${counts.inProgress ?? 0} · overdue ${counts.overdueTasks ?? 0}`;
    chunks.push({
      text: `Daily report ${item.reportDate} — ${name}: ${countsLine}. ${body}`,
      metadata: {
        source_type: 'daily_report',
        file_name: `Daily Report — ${item.reportDate}`,
        section_heading: `${name} — ${item.reportDate}`,
        source_url: `${base}/api/report-log?date=${item.reportDate}`,
        last_modified: item.createdAt || item.edits?.editedAt || '',
        author_name: name,
        report_date: item.reportDate,
      },
    });
  }
  return chunks;
}

// ─── Question intent + deterministic answers ───────────────────────────────

const compact = (value) => String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');

/** True when two display names plausibly refer to the same reporter
 * ("Taion" ↔ "Md. Ettekhar Rahman Taion"). Used to dedupe the roster. */
function samePerson(a, b) {
  const ca = compact(a), cb = compact(b);
  if (ca === cb || ca.includes(cb) || cb.includes(ca)) return true;
  const ta = String(a).toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 3);
  const tb = String(b).toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 3);
  return ta.length > 0 && tb.length > 0 && (ta.every((t) => tb.includes(t)) || tb.every((t) => ta.includes(t)));
}

const REPORT_NOUN = /\b(report(s|ed|ing)?|submissions?|submitted|submit)\b/i;
const REPORT_TIME = /\b(yesterday|today|tonight|last night|this week|last week|now|currently)\b|\b(?:on|for)\s+\d{4}-\d{2}-\d{2}\b|\b(?:on|for)\s+(?:sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b|\b\d{4}-\d{2}-\d{2}\b/i;
const REPORT_PEOPLE = /\b(who|everyone|anyone|team|all|anybody|everybody|any)\b/i;
const REPORT_MISSING = /\b(missing|missed|didn'?t (submit|report|send)|hasn'?t (submitted|reported|sent)|not submitted|skip|no report|short)\b/i;
const REPORT_PERSON_PHRASE = /\b(what did .* report|did .* (submit|report)|'s report (of|for|on)|report of|report by)\b/i;
// Questions about these OfficeOS domains are answered by the sheets/Dev Tracker
// (or maintenance builtin), never by the daily report log — even when they
// mention a person + a day ("what did the maintenance team do yesterday").
const REPORT_DOMAIN_EXCLUDE = /\b(mainten\w*|maintain\w*|backup|back up|website|domain|hosting|invoice|payroll|client|sop|handbook|policy|email|mail|prospect|lead|campaign)\b/i;
// "what did <person> do today" style action phrases (no report noun needed).
const REPORT_ACTION = /\b(what did|what has|what is|what was|what are|did|doing|working on|work|do|done|status|update)\b/i;

/** True when a question token plausibly names a known reporter/user. */
function personTokenInQuestion(name, q) {
  const cq = compact(q);
  const tokens = String(name || '').toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 3);
  const full = compact(name);
  if (full.length >= 6 && cq.includes(full)) return true;
  for (const t of tokens) {
    const ct = compact(t);
    if (ct.length >= 4 && cq.includes(ct)) return true;
  }
  return false;
}

/** Roster of people the report log can talk about: mirror authors + active
 * OfficeOS users, deduped with the same token rules the answers use. */
function knownReporterNames() {
  const names = [];
  const add = (n) => { if (n && !names.some((existing) => samePerson(existing, n))) names.push(n); };
  for (const item of loadReportMirror().items || []) {
    add(item.user?.name);
    for (const d of parseWhatsappLines(reportWhatsappText(item))) if (d.sender) add(d.sender);
  }
  try { for (const u of getUsers()) if (u.active !== false && u.name) add(u.name); } catch { /* users file may be missing */ }
  return names;
}

/**
 * Per-user daily report status for the admin/superadmin dashboard.
 * Groups the report-log items by person (same dedupe rules the chat uses),
 * keeps the most recent report per person, and returns each person's latest
 * Done · In Review · In Progress · Overdue counts plus whether they have any
 * submission at all. Rows are ordered by latest report date, then name.
 */
export function perUserReportStatus(items = [], roster = []) {
  const rosterNames = (roster || []).filter(Boolean);
  const byPerson = new Map(); // canonical name -> latest item
  const canonical = new Map(); // raw name -> canonical name
  const canon = (name) => {
    if (!name) return null;
    if (canonical.has(name)) return canonical.get(name);
    // Prefer an active OfficeOS roster name for the display label when the
    // author matches one ("Ettekhar Taion" → "Taion").
    const rosterMatch = rosterNames.find((n) => samePerson(n, name));
    const target = rosterMatch || name;
    let match = null;
    for (const key of byPerson.keys()) if (samePerson(key, target)) { match = key; break; }
    const c = match || target;
    canonical.set(name, c);
    return c;
  };
  for (const item of items || []) {
    const name = item.user?.name;
    if (!name || !item.reportDate) continue;
    const c = canon(name);
    const prev = byPerson.get(c);
    if (!prev || item.reportDate > prev.reportDate) byPerson.set(c, item);
  }
  const withRoster = new Set([...rosterNames, ...byPerson.keys()]);
  const rows = [...withRoster].map((name) => {
    const item = byPerson.get(name);
    const counts = item?.answer?.counts || {};
    return {
      user: name,
      reportDate: item?.reportDate || null,
      submitted: Boolean(item),
      tasksDone: counts.tasksDone ?? 0,
      inReview: counts.inReview ?? 0,
      inProgress: counts.inProgress ?? 0,
      overdueTasks: counts.overdueTasks ?? 0,
      overdueDependencies: counts.overdueDependencies ?? 0,
      maintenanceEnabled: counts.maintenanceEnabled === true,
      maintenanceTotal: counts.maintenanceTotal ?? 0,
    };
  });
  rows.sort((a, b) =>
    (b.reportDate || '').localeCompare(a.reportDate || '') || a.user.localeCompare(b.user)
  );
  const dates = [...new Set((items || []).map((i) => i.reportDate).filter(Boolean))].sort();
  return { rows, latestDate: dates[dates.length - 1] || null, count: (items || []).length };
}

export function isReportQuestion(question) {
  const q = String(question || '');
  if (REPORT_NOUN.test(q)) {
    if (REPORT_MISSING.test(q)) return true;
    if (/\b(daily report|report log)\b/i.test(q)) return true;
    if (REPORT_PEOPLE.test(q) && REPORT_TIME.test(q)) return true;
    if (REPORT_PERSON_PHRASE.test(q) || /\bwhat did\b/i.test(q)) return true;
    if (REPORT_TIME.test(q) && /\b(reports?)\b/i.test(q)) return true;
    if (/\b(report|submitted|submit)\b.*\b(who|everyone|anyone)\b|\b(who|everyone|anyone)\b.*\b(report|submitted|submit)\b/i.test(q)) return true;
  }
  // No report noun but a person/team + a day + action: "what did taion do
  // yesterday", "tell me what taion did today", "what did the team work on
  // this week". Exclude OfficeOS operational domains so maintenance / site /
  // client questions still route to their sheets instead of the report log.
  if (REPORT_TIME.test(q) && !REPORT_DOMAIN_EXCLUDE.test(q) && REPORT_ACTION.test(q)) {
    if (knownReporterNames().some((n) => personTokenInQuestion(n, q))) return true;
    if (/\b(everyone|everybody|anyone|anybody|team|all)\b/i.test(q)) return true;
  }
  return false;
}

/** Resolve the date a question refers to; falls back to null when unclear. */
function resolveDate(question) {
  const q = String(question || '');
  const explicit = q.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  if (explicit) return { date: explicit[1], label: explicit[1] };
  if (/\byesterday\b/.test(q)) { const d = shiftDate(todayInTeamTZ(), -1); return { date: d, label: d }; }
  if (/\btoday\b/.test(q) || /\btonight\b/.test(q)) { const d = todayInTeamTZ(); return { date: d, label: d }; }
  const weekday = q.match(/\b(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/i);
  if (weekday) { const d = weekdayDate(weekday[1]); if (d) return { date: d, label: d }; }
  return null;
}

/** Pick the best-matching reporter name from the question (token fuzzy match). */
function resolvePerson(question, names) {
  const q = compact(question);
  const unique = [...new Set((names || []).filter(Boolean))];
  let best = null;
  let bestLen = 0;
  for (const name of unique) {
    const tokens = String(name).toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 3);
    for (const token of tokens) {
      const t = compact(token);
      if (t.length >= 4 && q.includes(t) && t.length > bestLen) { best = name; bestLen = t.length; }
    }
    const full = compact(name);
    if (full.length >= 8 && q.includes(full) && full.length > bestLen) { best = name; bestLen = full.length; }
  }
  return best;
}

/** Everyone named in the daily logs: submission users + WhatsApp senders
 * (Sezan, Medul, phone numbers, …) so "what did <anyone> do" can resolve. */
function reportSenders(reports) {
  const names = [];
  const add = (n) => { if (n && !names.some((existing) => samePerson(existing, n))) names.push(n); };
  for (const item of reports || []) {
    add(item.user?.name);
    for (const d of parseWhatsappLines(reportWhatsappText(item))) if (d.sender) add(d.sender);
  }
  return names;
}

function reportLine(item) {
  const counts = item.answer?.counts || {};
  const bits = [];
  if (counts.tasksDone) bits.push(`done **${counts.tasksDone}**`);
  if (counts.inReview) bits.push(`in review **${counts.inReview}**`);
  if (counts.inProgress) bits.push(`in progress **${counts.inProgress}**`);
  if (counts.overdueTasks) bits.push(`overdue **${counts.overdueTasks}**`);
  return bits.length ? bits.join(' · ') : 'no task counts';
}

/** The raw daily log a report was generated from — the "what they did" data.
 * Lives on the QUESTION side of the submission, not in the generated answer:
 * answer.finalReport is only a template of counts, question.whatsapp /
 * input.rawWhatsappText is the actual per-person work log. */
function reportWhatsappText(item) {
  return item.question?.whatsapp || item.question?.input?.rawWhatsappText || '';
}

/** Parse daily WhatsApp log lines into { sender, text } entries, glueing
 * sender-less continuation lines onto the preceding sender's message.
 * Format: "[h:mm am/pm, dd/mm/yyyy] Sender: content". */
function parseWhatsappLines(text) {
  const out = [];
  let last = null;
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const m = line.match(/^(?:\[[^\]]*\]\s*)?(.+?):\s*(.*)$/);
    if (m && m[1].length >= 2 && m[1].length <= 40 && /[a-z0-9]/i.test(m[1])) {
      last = { sender: m[1].trim(), text: (m[2] || m[1]).trim() };
      out.push(last);
    } else if (last) {
      last.text = `${last.text}\n${line}`;
    } else {
      out.push({ sender: '', text: line });
    }
  }
  return out;
}

/** "What they did" detail lines for a report, optionally filtered to one
 * person (sender token match). Max `max` lines; falls back to the generated
 * overview when the raw log is missing. */
function reportDetail(item, person, max = 3) {
  const parsed = parseWhatsappLines(reportWhatsappText(item));
  const match = person && person.trim() ? parsed.filter((d) => d.sender && samePerson(d.sender, person)) : parsed;
  const few = (match.length ? match : parsed).slice(0, Math.max(1, max));
  if (few.length) return few;
  return [{ sender: '', text: String(item.answer?.finalReport || '').trim() }];
}

/** Markdown bullets for a set of detail lines (sender tags only when they
 * belong to someone other than the asked person). */
function detailBullets(detail, person, maxClip = 220) {
  const bullets = [];
  for (const d of detail) {
    const senderTag = d.sender && !(person && samePerson(d.sender, person)) ? `**${d.sender}** — ` : '';
    bullets.push(`• ${senderTag}${clip(d.text, maxClip)}`);
  }
  return bullets;
}

/**
 * Deterministic report-log answers. Returns the builtin answer object when the
 * question is a clear report-log question, otherwise null (so the normal
 * Dev Assistant flow continues untouched).
 *
 * options: { users = [], baseUrl = '' }
 */
export function answerReportQuestion(question, reports, options = {}) {
  const q = String(question || '');
  const items = Array.isArray(reports) ? reports : [];
  if (!items.length) return null;

  const resolved = resolveDate(q);
  const person = resolvePerson(q, reportSenders(items));
  const byDate = new Map();
  for (const item of items) {
    const d = item.reportDate;
    if (!d) continue;
    if (!byDate.has(d)) byDate.set(d, []);
    byDate.get(d).push(item);
  }
  const allDates = [...byDate.keys()].sort();
  const target = resolved ? resolved.date : (person ? null : allDates[allDates.length - 1]);

  const named = person ? items.filter((i) => i.user?.name === person) : [];
  const personLatest = named.length ? named[0] : null; // items are already date-desc
  // Person appears in the WhatsApp daily log but has no submission of their
  // own (Sezan Ahmed, Medul, …) — their "what they did" lines live in the raw
  // log that the submission was generated from.
  const inLog = person
    ? items.filter((item) => reportWhatsappText(item) && parseWhatsappLines(reportWhatsappText(item)).some((d) => d.sender && samePerson(d.sender, person)))
    : [];

  const suggestions = ['Who hasn’t submitted today?', 'What did the team report today?', `Reports for ${allDates[allDates.length - 1] || 'yesterday'}`];

  // 0) person found only in the WhatsApp logs, not as a submitter — "what did
  // sezan do yesterday" answers from their own daily log lines.
  if (person && !named.length && inLog.length) {
    const lines = [`**${person}** hasn’t submitted a daily report in the log yet.`];
    const seen = new Set();
    for (const item of inLog.slice(0, 4)) {
      const detail = reportDetail(item, person, 2);
      if (!detail.length || seen.has(item.reportDate)) continue;
      seen.add(item.reportDate);
      lines.push('', `In the **${item.reportDate}** daily log they sent:`);
      lines.push(...detailBullets(detail, person));
    }
    return {
      answer: lines.join('\n'),
      intent: 'daily-report-person-log', project: null,
      data: { person, foundIn: inLog.map((i) => i.reportDate), present: false },
      suggestions, engine: 'builtin',
    };
  }

  // 1) "what did <person> report on <date>" / "<person>'s report" / "what did
  // <person> do today" (person token + activity/day).
  if (person && (
    /\bwhat\b[^?\n]{0,60}\b(did|do|doing|working on|work)\b/i.test(q) ||
    /\b(did|doing|working on)\b/i.test(q) ||
    /'s (report|day|work|update|status)\b/i.test(q) ||
    /\breport (of|on|for|by)\b/i.test(q) ||
    /\b(report|submitted|submit|reported)\b/i.test(q)
  )) {
    const onTarget = target && named.find((i) => i.reportDate === target);
    const latestDate = personLatest?.reportDate || null;
    if (target && !onTarget) {
      const lines = [`**No report logged from ${person} for ${target}.**`];
      if (latestDate && personLatest) {
        lines.push('', `Their most recent report in the log is from **${latestDate}**:`);
        const detail = reportDetail(personLatest, person);
        if (detail.length) {
          lines.push('', '**What they did:**');
          lines.push(...detailBullets(detail, person));
        }
        lines.push('', reportLine(personLatest));
      } else {
        lines.push('', 'They have no reports in the log yet.');
      }
      lines.push('', `Ask “who hasn’t submitted ${target}?” to see the full picture.`);
      return {
        answer: lines.join('\n'),
        intent: 'daily-report-no-answer', project: null,
        data: { person, date: target, present: false, latestDate },
        suggestions, engine: 'builtin',
      };
    }
    const item = onTarget || personLatest;
    if (!item) {
      return {
        answer: `**No report logged from ${person}** in the Report Automation log yet.`,
        intent: 'daily-report-no-answer', project: null,
        data: { person, date: target || null, present: false },
        suggestions, engine: 'builtin',
      };
    }
    const counts = item.answer?.counts || {};
    const detail = reportDetail(item, person);
    const lines = [`**${person}’s daily report — ${item.reportDate}**`, ''];
    if (detail.length) {
      lines.push('**What they did:**');
      lines.push(...detailBullets(detail, person));
      lines.push('');
    }
    lines.push(reportLine(item));
    if (counts.tasksDoneLink) lines.push(`Done link: ${counts.tasksDoneLink}`);
    if (counts.overdueTasks && counts.overdueDependencies) lines.push(`Overdue dependencies: **${counts.overdueDependencies}**${counts.overdueDepNote ? ` — ${counts.overdueDepNote}` : ''}`);
    if (counts.tomorrowCount) lines.push(`Planned for tomorrow: **${counts.tomorrowCount}**`);
    return {
      answer: lines.join('\n'),
      intent: 'daily-report-person', project: null,
      data: { person, date: item.reportDate, item },
      suggestions, engine: 'builtin',
    };
  }

  // 2) status / missing reports — "who hasn't submitted (yesterday|today|on
  // <date>)", "did everyone submit their report?", "who reported on <date>"
  if (!person && (
    /who|missing|missed|didn'?t|hasn'?t|not submitted|skip|short/i.test(q) ||
    (/\b(everyone|everybody|anyone|anybody|all|team)\b/i.test(q) && /\b(submit|submitted|report)\b/i.test(q))
  )) {
    const d = target || todayInTeamTZ();
    const submitters = (byDate.get(d) || []).map((i) => i.user?.name).filter(Boolean);
    const roster = []; // deduped display names
    const addRoster = (name) => {
      if (!name) return;
      if (!roster.some((existing) => samePerson(existing, name))) roster.push(name);
    };
    for (const item of items) addRoster(item.user?.name);
    for (const u of options.users || []) if (u.active !== false && u.name) addRoster(u.name);
    const missing = roster.filter((name) => !submitters.some((s) => samePerson(s, name)));
    const lines = [`**Daily report status — ${d}**`, ''];
    if (!submitters.length) {
      lines.push('No one has submitted a report for that day yet.');
      lines.push('', 'People I track: ' + (roster.join(', ') || 'none recorded so far.'));
    } else {
      lines.push(`Submitted (${submitters.length}): ${[...new Set(submitters)].join(', ')}`);
      if (missing.length) lines.push('', `**Not submitted yet (${missing.length}):** ${missing.join(', ')}`);
      else lines.push('', 'Everyone in the log has submitted. 🎉');
    }
    return {
      answer: lines.join('\n'),
      intent: 'daily-report-missing', project: null,
      data: { date: d, submitted: [...new Set(submitters)], missing },
      suggestions, engine: 'builtin',
    };
  }

  // 3) reports for a date — "reports for yesterday", "what happened on <date>"
  if (REPORT_TIME.test(q) || !person) {
    const d = target || allDates[allDates.length - 1];
    const dayItems = byDate.get(d) || [];
    if (!dayItems.length) {
      return {
        answer: `**No reports logged for ${d}.**\n\nThe most recent date in the log is ${allDates[allDates.length - 1] || '—'}.`,
        intent: 'daily-report-no-answers', project: null,
        data: { date: d, items: [] },
        suggestions, engine: 'builtin',
      };
    }
    const lines = [`**Daily reports — ${d}**`, ''];
    for (const item of dayItems) {
      const name = item.user?.name || 'Unknown';
      lines.push(`• **${name}** — ${reportLine(item)}`);
      for (const b of detailBullets(reportDetail(item, null, 3), null, 150)) {
        lines.push(`    ${b}`);
      }
    }
    return {
      answer: lines.join('\n'),
      intent: 'daily-report-date', project: null,
      data: { date: d, items: dayItems },
      suggestions, engine: 'builtin',
    };
  }

  return null;
}