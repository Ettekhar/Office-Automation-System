/**
 * devAssistant.js — Built-in "Dev Assistant" chatbot engine for the
 * Dev Tracker & Feedback Log.
 *
 * Answers natural-language questions about website projects, sitemap
 * progress, feedback rounds, and work logs using the same data that
 * powers /api/master/dev-projects (data/dev-projects.json, two-way
 * synced with the Dev Tracker Google Sheet).
 *
 * Two answer engines:
 *   1. "builtin" — deterministic intent engine. Always available, zero
 *      setup, zero cost. Understands: project overviews, pending/in-progress
 *      work, feedback rounds, latest updates, page counts, overall summary.
 *   2. "llm" — optional natural-language enhancement. Activates automatically
 *      when OPENAI_API_KEY (or GEMINI_API_KEY, or LLM_API_KEY + LLM_BASE_URL)
 *      is present in the environment. The tracker data is passed as compact
 *      JSON context. Falls back to the builtin engine on any error/timeout.
 *
 * ─── CHANGELOG (Development-Date / Development-Updates columns) ─────────────
 *  - The Dev Tracker tabs carry two extra hand-added columns at C/D
 *    (Development-Date / Development-Updates). fetchDevTrackerSheetData has
 *    read them into devDate/devNotes correctly, but nothing ANSWERED from
 *    them: summarizeProject folded them into the merged workLog, project
 *    overviews only showed whichever entry happened to be newest, and there
 *    was no intent for "development updates for X" (it fell through to
 *    `latest`, which re-dumped the feedback log).
 *  - Added summarizeProject().devLog (workLog entries grouped as
 *    "Development"), composeDevelopment(), and RX.development — routed BEFORE
 *    RX.latest in both the project and the global branch. composeProjectOverview
 *    now always prints a "🛠 Development updates" block, so the columns are
 *    visible on any project question.
 *  - buildRagContext now emits explicit developmentDate/developmentNotes fields
 *    (previously an unlabelled devNotes=), and SYSTEM_PROMPT documents the
 *    A:G tab layout so the LLM treats columns C/D as first-class content.
 *
 * ── CHANGELOG (marker leakage + pronoun resolution) ───────────────────────
 *  - fetchDevTrackerSheetData (sheets.js) reads real Development-Date /
 *    Development-Updates columns now (devDate/devNotes), but the group
 *    marker text ("Feedback-1 URL", "Feedback-2 URL") occasionally ends up
 *    in the notes cell instead of the feedback-URL cell on manually-edited
 *    rows. That text was passing every "is this a real comment" check and
 *    getting quoted verbatim as if it were an actual work comment (see
 *    isMarkerText / MARKER_RX below — now filtered everywhere notes are
 *    read: workLog, retrieveEvidence, computeRecentActivity).
 *  - summarizeProject's workLog now also folds in devNotes/devDate (grouped
 *    as "Development") so a row can contribute two distinct dated entries —
 *    a feedback comment and a development update — instead of just one.
 *  - Added pronoun resolution: "what's the feedback there" / "give me the
 *    list of them" previously only worked if the LLM's own instruction to
 *    read CONVERSATION SO FAR happened to catch it, and the BUILTIN engine
 *    never saw history at all. resolveHistoryProjects() now scans the last
 *    few turns (assistant answers first, since project names are always
 *    **bolded** there) for project names, and both engines use it when the
 *    current question has no confident match of its own but contains a
 *    pronoun ("there", "them", "those", "that project", "it").
 */

const MAX_LIST = 8; // cap long lists inside answers
// Broad-RAG month-column detection relies on these names. They must live in
// this module because buildRagContext uses them directly.
const MONTH_NAMES_LC = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const MONTH_ABBR_LC = MONTH_NAMES_LC.map((name) => name.slice(0, 3));

/* ─────────────────────────────────────────────
 * Small helpers
 * ────────────────────────────────────────────*/
const norm = (s) => String(s || '').toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
const isCompleted = (st) => ['completed', 'done', 'live'].includes(norm(st));
const isInProgress = (st) => norm(st).includes('progress') || norm(st) === 'working';
const isHeaderItem = (it) => it.isHeader === true || norm(it.status) === 'header';

// Group-header marker text (e.g. "Feedback-1 URL") occasionally ends up
// typed into the notes/devNotes cell instead of the feedback-URL cell on
// manually-edited rows. Treat it as noise wherever it appears so it never
// gets quoted as if it were a real work comment.
const MARKER_RX = /^feedback[-\s]*\d+\s*url$/i;
const isMarkerText = (s) => MARKER_RX.test(String(s || '').trim());

const STOP_WORDS = new Set(['the', 'and', 'for', 'of', 'a', 'an', 'co', 'llc', 'inc', 'com', 'https', 'http', 'www']);

function projectWords(name) {
  return norm(name).split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !STOP_WORDS.has(w));
}

// Converts any stored date string to YYYY-MM-DD for safe ISO comparisons.
// Handles:
//   YYYY-MM-DD  → unchanged
//   DD/MM/YY    → YYYY-MM-DD  (e.g. "28/08/26" → "2026-08-28")
//   DD/MM/YYYY  → YYYY-MM-DD  (e.g. "28/08/2026" → "2026-08-28")
// Returns '' for empty/unparseable values.
function normalizeDate(d) {
  if (!d) return '';
  const s = String(d).trim();
  // Already ISO
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  // DD/MM/YY or DD/MM/YYYY
  const m2 = s.match(/^(\d{2})\/(\d{2})\/(\d{2}|\d{4})$/);
  if (m2) {
    const day = m2[1], mon = m2[2];
    const yr = m2[3].length === 2 ? `20${m2[3]}` : m2[3];
    return `${yr}-${mon}-${day}`;
  }
  return '';
}

function fmtDate(d) {
  if (!d) return '';
  const iso = normalizeDate(d);
  if (!iso) return String(d);
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[2]}/${m[3]}/${m[1].slice(2)}`;
  return String(d);
}

function cleanNote(n) {
  return String(n || '').replace(/\s*\n+\s*/g, ' ').replace(/\s+/g, ' ').trim();
}

function clip(s, max = 180) {
  const t = String(s || '');
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

/* ─────────────────────────────────────────────
 * Project matching (fuzzy)
 * ────────────────────────────────────────────*/
export function matchProject(question, projects) {
  const q = norm(question);
  if (!q || !Array.isArray(projects) || !projects.length) return null;
  // 1) full-name substring match
  for (const p of projects) {
    const n = norm(p.project);
    if (n && n.length >= 3 && q.includes(n)) return p;
  }
  // 2) every significant word of the project name appears in the question
  for (const p of projects) {
    const words = projectWords(p.project);
    if (words.length && words.every((w) => q.includes(w))) return p;
  }
  // 3) any distinctive word (>=5 chars) matches — e.g. "reitz", "nines"
  for (const p of projects) {
    if (projectWords(p.project).some((w) => w.length >= 5 && q.includes(w))) return p;
  }
  return null;
}

/* ─────────────────────────────────────────────
 * Pronoun resolution against recent conversation
 * ────────────────────────────────────────────*/
const PRONOUN_RX = /\b(there|them|those|that project|this project|it|same project|these projects|those projects)\b/;

// Finds known project names inside a chunk of text. Checks **bolded** spans
// first (every compose* function bolds project names, so an assistant's own
// prior answer is a reliable source), then falls back to scanning the raw
// text so a user's own prior question ("what about Reitz Union") still works.
function extractProjectsFromText(text, projects) {
  const t = String(text || '');
  if (!t.trim() || !Array.isArray(projects) || !projects.length) return [];
  const found = [];
  const seen = new Set();
  const scanIn = (s) => {
    const ns = norm(s);
    if (!ns) return;
    for (const p of projects) {
      if (seen.has(p.project)) continue;
      const words = projectWords(p.project);
      if (!words.length) continue;
      if (ns === norm(p.project) || words.every((w) => ns.includes(w))) {
        found.push(p);
        seen.add(p.project);
      }
    }
  };
  const boldMatches = [...t.matchAll(/\*\*([^*]{2,80})\*\*/g)].map((m) => m[1]);
  boldMatches.forEach(scanIn);
  if (!found.length) scanIn(t);
  return found;
}

/**
 * Resolves "there / them / those" style references against recent turns.
 * Looks newest-turn-first, assistant answer before user question (the
 * answer is what actually names the project(s) being discussed). Returns
 * an ordered, de-duplicated array of matched project objects — empty if
 * nothing in the recent history names a known project.
 */
export function resolveHistoryProjects(history, projects) {
  const turns = Array.isArray(history) ? history.slice(-4) : [];
  for (let i = turns.length - 1; i >= 0; i--) {
    const t = turns[i];
    const fromAnswer = extractProjectsFromText(t?.answer || t?.assistant || '', projects);
    if (fromAnswer.length) return fromAnswer;
    const fromQuestion = extractProjectsFromText(t?.question || t?.user || '', projects);
    if (fromQuestion.length) return fromQuestion;
  }
  return [];
}

/* ─────────────────────────────────────────────────────────────────────────────
 * Aggregation — mirrors the grouping logic used by the Dev Tracker UI
 * ────────────────────────────────────────────────────────────────────────────*/
export function summarizeProject(p) {
  const items = Array.isArray(p.items) ? p.items : [];
  const pages = items.filter((it) => it.url && !isHeaderItem(it));
  const completed = pages.filter((it) => isCompleted(it.status));
  const inProgress = pages.filter((it) => isInProgress(it.status));
  const pending = pages.filter((it) => !isCompleted(it.status) && !isInProgress(it.status));

  // Feedback rounds grouped by feedbackGroup (same as the UI's render())
  const groups = new Map();
  items.forEach((it) => {
    const g = it.feedbackGroup || 'General';
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(it);
  });

  const rounds = Array.from(groups.entries()).map(([name, gItems]) => {
    const docLink = gItems.find((it) => it.feedbackUrl && String(it.feedbackUrl).startsWith('http'))?.feedbackUrl || '';
    const dates = gItems.map((it) => it.date).filter(Boolean);
    const statuses = gItems.map((it) => it.status).filter(Boolean);
    const allDone = statuses.length > 0 && statuses.every((s) => isCompleted(s));
    const hasWip = statuses.some((s) => isInProgress(s));
    const work = gItems
      .filter((it) => !isHeaderItem(it) && it.notes && String(it.notes).trim() && !isMarkerText(it.notes))
      .map((it) => ({ date: it.date || '', url: it.url || '', notes: cleanNote(it.notes) }));
    return {
      name,
      docLink,
      date: dates[0] || '',
      status: allDone ? 'Completed' : hasWip ? 'In Progress' : (statuses[0] || 'Pending'),
      workCount: work.length,
      work,
    };
  });

  // Dated work entries across the whole project, newest first. Each
  // non-header row can contribute up to TWO entries: a feedback/QA comment
  // (notes, from Feedback-Notes) and a separate development update
  // (devNotes, from Development-Updates) — grouped as "Development" since
  // it isn't tied to a feedback round. Marker text ("Feedback-1 URL") is
  // filtered out of both, even if it landed in the wrong column.
  const workLog = items
    .filter((it) => !isHeaderItem(it))
    .flatMap((it) => {
      const entries = [];
      const rawNotes = String(it.notes || '').trim();
      if (rawNotes && !isMarkerText(rawNotes)) {
        entries.push({
          date: normalizeDate(it.date) || String(it.updatedAt || '').slice(0, 10) || '',
          group: it.feedbackGroup || 'General',
          url: it.url || '',
          status: it.status || '',
          notes: cleanNote(rawNotes),
        });
      }
      const rawDevNotes = String(it.devNotes || '').trim();
      if (rawDevNotes && !isMarkerText(rawDevNotes)) {
        entries.push({
          date: normalizeDate(it.devDate) || normalizeDate(it.date) || String(it.updatedAt || '').slice(0, 10) || '',
          group: 'Development',
          url: it.url || '',
          status: it.status || '',
          notes: cleanNote(rawDevNotes),
        });
      }
      return entries;
    })
    .sort((a, b) => String(b.date).localeCompare(String(a.date)));

  const total = pages.length;
  const done = completed.length;

  // Development-only entries (sheet columns C/D — Development-Date /
  // Development-Updates) pulled out of the merged workLog, so a "development
  // update" question never has to guess which entries came from the new
  // columns a user added to their tabs by hand.
  const devLog = workLog.filter((w) => w.group === 'Development');

  // Hand-added columns of this tab — anything its header row carried beyond the
  // known fields ("QA Check", "SEO Notes", a new "Backup Date", …). They are
  // read from the sheet, so they are first-class data the assistant can quote;
  // they are deliberately NOT folded into page/round counts (a hand-added
  // column must never change a completion percentage).
  const extraColumns = (p.extraColumns || (p.columns && p.columns.extras) || [])
    .map((c) => ({ key: c.key, label: c.label || c.key, kind: c.kind || 'text' }));
  const extraLog = [];
  if (extraColumns.length) {
    items.forEach((it) => {
      const vals = it.extra && typeof it.extra === 'object' ? it.extra : {};
      extraColumns.forEach((c) => {
        const value = String(vals[c.key] ?? '').trim();
        if (!value) return;
        extraLog.push({
          column: c.label,
          key: c.key,
          value: cleanNote(value),
          url: it.url || '',
          rowNum: it.rowNum || null,
          date: normalizeDate(it.date) || normalizeDate(it.devDate) || '',
        });
      });
    });
  }

  return {
    id: p.id || p.project,
    name: p.project,
    // Preserve the parsed rows for the explicit "full details" view. Other
    // summary intents continue to use the aggregates below.
    items,
    pages: total,
    completed: done,
    inProgress: inProgress.length,
    pending: pending.length,
    readiness: total ? Math.round((done / total) * 100) : 0,
    rounds,
    workLog,
    devLog,
    pendingItems: [...inProgress, ...pending].map((it) => ({
      url: it.url,
      status: it.status,
      date: it.date || '',
      notes: cleanNote(it.notes),
    })),
    latestWork: workLog[0] || null,
    // Auto-discovered hand-added columns and their non-empty values.
    extraColumns,
    extraLog,
  };
}

export function buildDevOverview(projects) {
  const summaries = (Array.isArray(projects) ? projects : []).map(summarizeProject);
  const totals = summaries.reduce(
    (acc, s) => {
      acc.projects += 1;
      acc.pages += s.pages;
      acc.completed += s.completed;
      acc.inProgress += s.inProgress;
      acc.pending += s.pending;
      acc.rounds += s.rounds.length;
      return acc;
    },
    { projects: 0, pages: 0, completed: 0, inProgress: 0, pending: 0, rounds: 0 },
  );
  // overall readiness across all sitemap pages
  totals.readiness = totals.pages ? Math.round((totals.completed / totals.pages) * 100) : 0;
  return { totals, projects: summaries };
}

// Restricts an already-built overview down to a named subset of projects —
// used when a plural pronoun ("them"/"those") resolves to more than one
// project from the recent conversation, so global answers (feedback,
// pending, latest…) only cover what was actually being discussed instead
// of silently widening back out to the full portfolio.
function scopedOverview(ov, names) {
  const set = new Set((names || []).map((n) => norm(n)));
  const projects = ov.projects.filter((s) => set.has(norm(s.name)));
  const totals = projects.reduce(
    (acc, s) => {
      acc.projects += 1;
      acc.pages += s.pages;
      acc.completed += s.completed;
      acc.inProgress += s.inProgress;
      acc.pending += s.pending;
      acc.rounds += s.rounds.length;
      return acc;
    },
    { projects: 0, pages: 0, completed: 0, inProgress: 0, pending: 0, rounds: 0 },
  );
  totals.readiness = totals.pages ? Math.round((totals.completed / totals.pages) * 100) : 0;
  return { totals, projects };
}
/* ─────────────────────────────────────────────
 * Confidence-based matching (typo tolerant, ambiguity aware)
 * ────────────────────────────────────────────*/
const CLARIFY_MIN_SCORE = 0.34; // below this a name is "no match at all" → not-found path

function levenshtein(a, b) {
  const m = a.length;
  const n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}

// How well a question token matches a project-name word (null = no match)
function tokenMatchKind(qToken, pWord) {
  if (qToken === pWord) return 'exact';
  if (qToken.length >= 4 && (pWord.startsWith(qToken) || qToken.startsWith(pWord))) return 'prefix';
  if (qToken.length < 3) return null;
  const d = levenshtein(qToken, pWord);
  const maxD = pWord.length >= 5 ? 2 : 1;
  if (qToken[0] === pWord[0] && d <= maxD) return 'fuzzy';
  return null;
}

const KIND_RANK = { exact: 0, prefix: 1, fuzzy: 2 };

export function rankProjects(question, projects) {
  const q = norm(question);
  const qTokens = q.split(/[^a-z0-9]+/).filter(Boolean);
  const rows = [];
  for (const p of Array.isArray(projects) ? projects : []) {
    const words = projectWords(p.project);
    if (!words.length) continue;
    const kinds = [];
    for (const w of words) {
      let best = null;
      for (const t of qTokens) {
        const k = tokenMatchKind(t, w);
        if (k && (best === null || KIND_RANK[k] < KIND_RANK[best])) best = k;
        if (best === 'exact') break;
      }
      if (best) kinds.push(best);
    }
    const substringHit = norm(p.project).length >= 3 && q.includes(norm(p.project));
    const allWords = kinds.length === words.length;
    const pureFuzzy = allWords && kinds.every((k) => k === 'fuzzy');
    const score = substringHit ? 1 : kinds.length / words.length;
    rows.push({
      project: p,
      name: p.project,
      score,
      confident: substringHit || (allWords && !pureFuzzy),
      matchedWords: kinds.length,
      totalWords: words.length,
      kinds,
    });
  }
  rows.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  const top = rows[0];
  if (top) {
    const margin = top.score - (rows[1]?.score || 0);
    top.margin = margin;
    const dominant = top.score >= 0.5 && margin >= 0.25;
    if (dominant && !top.confident) {
      top.confident = true;
      top.dominant = true;
      top.assumed = true;
    } else if (top.confident) {
      top.assumed = top.score !== 1;
    }
  }
  return rows;
}

const COMMON_CAPS = new Set(['what', 'whats', 'who', 'whos', 'when', 'where', 'why', 'how', 'show', 'list', 'tell', 'give', 'does', 'did', 'is', 'are', 'was', 'were', 'compare', 'between', 'please', 'hey', 'hello', 'all', 'any', 'latest', 'recent', 'newest', 'last', 'pending', 'overall', 'progress', 'status', 'update', 'updates', 'feedback', 'sitemap', 'pages', 'page', 'round', 'rounds', 'readiness', 'website', 'project', 'projects', 'site', 'sites', 'team', 'and', 'the', 'for', 'on', 'in', 'of', 'about', 'with', 'across', 'from', 'at', 'by', 'to', 'my', 'our', 'have', 'has', 'done', 'worked', 'work', 'log', 'comments', 'completed', 'finished', 'everything', 'there', 'this', 'that']);

export function properNounTokens(question, projects) {
  const known = new Set();
  for (const p of Array.isArray(projects) ? projects : []) {
    for (const w of projectWords(p.project)) known.add(w);
  }
  const raw = String(question || '').split(/\s+/);
  const out = [];
  raw.forEach((tokRaw, i) => {
    if (i === 0) return; // sentence-initial capitalisation is noisy
    const tok = tokRaw.replace(/[^A-Za-z0-9'-]/g, '');
    if (tok.length < 4) return;
    if (!/^[A-Z][a-zA-Z']*$/.test(tok)) return; // must look Like a Proper Noun
    const lower = tok.toLowerCase().replace(/'/g, '');
    if (COMMON_CAPS.has(lower)) return;
    for (const w of known) { if (tokenMatchKind(lower, w)) return; }
    if (out.some((x) => x.toLowerCase() === lower)) return;
    out.push(tok);
  });
  return out;
}


/* ─────────────────────────────────────────────────────────────────────────────
 * Answer composers (plain text + light markdown: **bold**, bullets, newlines)
 * ────────────────────────────────────────────────────────────────────────────*/
const bullet = (text) => `• ${text}`;
const statLine = (label, value) => `${label}: ${value}`;

function itemLine(it) {
  const label = it.url || '(no URL)';
  const date = it.date ? ` · ${fmtDate(it.date)}` : '';
  const note = it.notes ? ` — "${clip(it.notes, 120)}"` : '';
  return `**${label}** — ${it.status}${date}${note}`;
}

function workLine(w, maxLen = 140) {
  const date = w.date ? `${fmtDate(w.date)} — ` : '';
  return `${date}"${clip(w.notes, maxLen)}"`;
}

function roundLine(r) {
  const icon = norm(r.status) === 'completed' ? '✅' : norm(r.status).includes('progress') ? '🔄' : '⏳';
  const date = r.date ? ` · ${fmtDate(r.date)}` : '';
  return `${icon} **${r.name}** — ${r.status}${date}${r.workCount ? ` — ${r.workCount} work comment${r.workCount > 1 ? 's' : ''}` : ''}`;
}

/**
 * Renders the hand-added column values of ONE project (auto-discovered from the
 * sheet's header row). Returns '' when the project has no such columns — so
 * nothing changes for tabs that still use the plain 5/7-column layout.
 */
function composeExtraColumnsBlock(sum, maxPerColumn = 4) {
  const cols = sum.extraColumns || [];
  if (!cols.length || !(sum.extraLog || []).length) return '';
  const lines = [`**🧩 Additional columns** · ${cols.map((c) => `**${c.label}**`).join(', ')}`];
  cols.forEach((c) => {
    const entries = (sum.extraLog || []).filter((e) => e.key === c.key);
    if (!entries.length) return;
    const shown = entries.slice(0, maxPerColumn)
      .map((e) => `${e.url ? `**${e.url}** — ` : ''}"${clip(e.value, 120)}"${e.date ? ` (${fmtDate(e.date)})` : ''}`);
    lines.push(bullet(shown.join('; ')));
    if (entries.length > maxPerColumn) lines.push(`   …and ${entries.length - maxPerColumn} more`);
  });
  return lines.join('\n');
}

/**
 * "What columns / fields does the tracker have?" — answers from the columns the
 * assistant actually discovered on the sheets, including hand-added ones.
 */
function composeColumns(ov, projSum) {
  const targets = projSum ? [projSum] : ov.projects;
  const withExtras = targets.filter((s) => (s.extraColumns || []).length);
  const lines = [projSum
    ? `🧩 **Columns detected for ${projSum.name}**`
    : '🧩 **Columns detected across the tracker**'];
  lines.push('');
  if (projSum) {
    lines.push(bullet('Standard: URL, Status, Development-Date, Development-Updates, Feedback URL, Feedback-Date, Feedback-Notes — whichever of them this tab actually has.'));
  }
  if (!withExtras.length) {
    lines.push(bullet('No extra (hand-added) columns found — every tab matches the standard layout.'));
  } else {
    withExtras.forEach((s) => {
      const labels = (s.extraColumns || []).map((c) => `**${c.label}**`);
      lines.push(`**${s.name}** — ${labels.join(', ')}`);
      (s.extraColumns || []).forEach((c) => {
        const entries = (s.extraLog || []).filter((e) => e.key === c.key);
        if (!entries.length) return;
        lines.push('   ' + bullet(`**${c.label}**: "${clip(entries[0].value, 120)}"${entries.length > 1 ? ` (+${entries.length - 1} more)` : ''}`));
      });
      lines.push('');
    });
  }
  lines.push('');
  lines.push('_These columns are read straight from each tab\'s header row, so a new column shows up here automatically._');
  return lines.join('\n').trimEnd();
}

function composeProjectOverview(sum) {
  const open = sum.pending + sum.inProgress;
  const roundsDone = sum.rounds.filter((r) => norm(r.status) === 'completed').length;
  const lines = [`💻 **${sum.name}**`, '', '**At a glance**'];
  lines.push(statLine('Readiness', `**${sum.readiness}%**${!sum.pages ? ' (no pages logged)' : sum.readiness === 100 ? ' ✅ complete' : ''}`));
  lines.push(statLine('Sitemap pages', `**${sum.completed}/${sum.pages}** completed`));
  lines.push(statLine('Open items', open ? `**${open}** · ${sum.inProgress} in progress · ${sum.pending} pending` : '**0** — nothing pending ✅'));
  lines.push(statLine('Feedback rounds', `**${sum.rounds.length}**${sum.rounds.length ? ` · ${roundsDone} completed` : ''}`));

  if (sum.latestWork) {
    lines.push('', `**Latest work** · ${sum.latestWork.group}${sum.latestWork.date ? ` · ${fmtDate(sum.latestWork.date)}` : ''}`);
    lines.push(`"${clip(sum.latestWork.notes, 260)}"`);
  }

  // Development-Date / Development-Updates (sheet columns C/D). Shown for
  // EVERY project question — not only the "latest work" slot — because these
  // entries sit in their own columns and would otherwise stay invisible for
  // any project whose newest entry happens to be a feedback comment.
  const devEntries = (sum.devLog || []).filter((w) => w.notes);
  if (devEntries.length) {
    lines.push('', `**🛠 Development updates** · ${devEntries.length} logged`);
    devEntries.slice(0, 3).forEach((w) => {
      lines.push(bullet(`${w.date ? `${fmtDate(w.date)} — ` : ''}"${clip(w.notes, 160)}"`));
    });
    if (devEntries.length > 3) lines.push(`…and ${devEntries.length - 3} more`);
  }

  if (sum.rounds.length) {
    lines.push('', '**Feedback rounds**');
    sum.rounds.slice(0, 6).forEach((r) => lines.push(bullet(roundLine(r))));
    if (sum.rounds.length > 6) lines.push(`…and ${sum.rounds.length - 6} more`);
  }

  // Hand-added columns (auto-discovered from the sheet's header row): the team
  // added them on purpose, so they are reported like any other data.
  const extraBlock = composeExtraColumnsBlock(sum, 4);
  if (extraBlock) lines.push('', extraBlock);

  if (open) {
    lines.push('', '**Open items**');
    sum.pendingItems.slice(0, 5).forEach((it) => lines.push(bullet(itemLine(it))));
    if (sum.pendingItems.length > 5) lines.push(`…and ${sum.pendingItems.length - 5} more`);
  } else if (sum.pages) {
    lines.push('', `✅ All ${sum.pages} sitemap pages are completed — nothing pending.`);
  } else {
    lines.push('', 'ℹ️ No sitemap pages logged for this project yet.');
  }
  return lines.join('\n');
}

// A follow-up such as "full details" should expose the rows we actually read,
// not repeat the compact dashboard card.  Operational facts stay deterministic
// so a free-tier model cannot turn a fresh result into a vague summary.
function composeProjectDetails(sum) {
  const lines = [`💻 **${sum.name} — live tracker details**`, ''];
  const items = (sum.items || []).filter((item) => !item.isHeader);
  if (!items.length) return `${lines.join('\n')}No non-header tracker rows are currently recorded.`;
  lines.push(`**${items.length} tracker row${items.length === 1 ? '' : 's'} read**`);
  items.slice(0, 30).forEach((item, index) => {
    const parts = [];
    if (item.url) parts.push(item.url);
    if (item.status) parts.push(`status: **${item.status}**`);
    if (item.devDate || item.devNotes) parts.push(`development${item.devDate ? ` ${fmtDate(item.devDate)}` : ''}: ${item.devNotes ? `“${clip(item.devNotes, 280)}”` : 'recorded'}`);
    if (item.date || item.notes) parts.push(`feedback${item.date ? ` ${fmtDate(item.date)}` : ''}: ${item.notes ? `“${clip(item.notes, 280)}”` : 'recorded'}`);
    if (item.feedbackUrl && !/feedback[- ]*\d+/i.test(item.feedbackUrl)) parts.push(`feedback link: ${item.feedbackUrl}`);
    lines.push(bullet(`**Row ${index + 1}** — ${parts.join(' · ') || 'no populated details'}`));
  });
  if (items.length > 30) lines.push(`…and ${items.length - 30} additional rows.`);
  const headerRounds = (sum.rounds || []).filter((round) => norm(round.status) === 'header');
  if (headerRounds.length) lines.push('', `**Tracker sections without a work row:** ${headerRounds.map((round) => round.name).join(', ')}.`);
  return lines.join('\n');
}

function composeAllProjectsOverview(ov) {
  const t = ov.totals;
  const sorted = [...ov.projects].sort((a, b) => b.readiness - a.readiness || a.name.localeCompare(b.name));
  const openAll = t.pending + t.inProgress;
  const lines = ['📊 **Dev Tracker — overall status**', '', '**Totals**'];
  lines.push(statLine('Projects', `**${t.projects}**`));
  lines.push(statLine('Sitemap pages', `**${t.completed}/${t.pages}** completed (${t.readiness}%)`));
  lines.push(statLine('Open items', openAll ? `**${openAll}** · ${t.inProgress} in progress · ${t.pending} pending` : '**0** ✅'));
  lines.push(statLine('Feedback rounds', `**${t.rounds}**`));
  lines.push('', '**By project**');
  sorted.forEach((s) => {
    const icon = !s.pages ? '⚪' : s.readiness === 100 ? '✅' : s.readiness >= 70 ? '🟢' : s.readiness >= 40 ? '🟡' : '🔴';
    lines.push(`${icon} **${s.name}** — ${s.completed}/${s.pages} pages · ${s.readiness}% · ${s.rounds.length} round${s.rounds.length === 1 ? '' : 's'}${s.pending + s.inProgress ? ` · ${s.pending + s.inProgress} open` : ''}`);
  });
  const attention = sorted.filter((s) => s.pending + s.inProgress > 0);
  if (attention.length) {
    lines.push('');
    lines.push(`⚠️ Needs attention: ${attention.map((s) => `**${s.name}**`).join(', ')}`);
  } else {
    lines.push('');
    lines.push('✅ Every tracked page is completed.');
  }
  return lines.join('\n');
}

function composePending(ov, projSum) {
  if (projSum) {
    if (!projSum.pendingItems.length) return `✅ **${projSum.name}** is fully caught up — all ${projSum.pages} sitemap pages completed, nothing pending.`;
    const lines = [
      `⏳ **Pending & in-progress — ${projSum.name}**`,
      '',
      statLine('Open items', `**${projSum.pendingItems.length}** · ${projSum.inProgress} in progress · ${projSum.pending} pending`),
      statLine('Readiness', `**${projSum.readiness}%** (${projSum.completed}/${projSum.pages} pages done)`),
      '',
    ];
    projSum.pendingItems.slice(0, MAX_LIST).forEach((it) => {
      lines.push(bullet(itemLine(it)));
    });
    if (projSum.pendingItems.length > MAX_LIST) lines.push(`…and ${projSum.pendingItems.length - MAX_LIST} more`);
    return lines.join('\n');
  }
  const open = ov.projects.filter((s) => s.pendingItems.length);
  if (!open.length) return '✅ Nothing pending! Every project in the Dev Tracker has all sitemap pages completed.';
  const totalOpen = open.reduce((n, s) => n + s.pendingItems.length, 0);
  const lines = [`⏳ **Pending & In-Progress Work** — ${totalOpen} item${totalOpen === 1 ? '' : 's'} across ${open.length} project${open.length === 1 ? '' : 's'}`, ''];
  open.forEach((s) => {
    lines.push(`**${s.name}** (${s.readiness}% ready, ${s.pendingItems.length} open):`);
    s.pendingItems.slice(0, 4).forEach((it) => {
      lines.push('   ' + bullet(itemLine(it)));
    });
    if (s.pendingItems.length > 4) lines.push(`   …and ${s.pendingItems.length - 4} more`);
    lines.push('');
  });
  return lines.join('\n').trimEnd();
}

function composeFeedback(ov, projSum, { feedbackOnly = false } = {}) {
  if (projSum) {
    if (!projSum.rounds.length) return `💬 No feedback rounds logged for **${projSum.name}** yet.`;
    const done = projSum.rounds.filter((r) => norm(r.status) === 'completed').length;
    const lines = [
      `💬 **Feedback rounds — ${projSum.name}**`,
      '',
      statLine('Rounds', `**${projSum.rounds.length}** · ${done} completed`),
      '',
    ];
    projSum.rounds.forEach((r) => {
      lines.push(roundLine(r));
      if (!r.workCount) {
        lines.push('   No work comments logged for this round yet.');
      } else {
        r.work.slice(0, 3).forEach((w) => {
          lines.push('   ' + bullet(workLine(w)));
        });
        if (r.work.length > 3) lines.push(`   …and ${r.work.length - 3} more comment${r.work.length - 3 === 1 ? '' : 's'}`);
      }
      lines.push('');
    });
    return lines.join('\n').trimEnd();
  }
  const all = [];
  ov.projects.forEach((s) => {
    s.workLog
      .filter((w) => !feedbackOnly || norm(w.group) !== 'development')
      .forEach((w) => all.push({ project: s.name, ...w }));
  });
  all.sort((a, b) => String(b.date).localeCompare(String(a.date)));
  if (!all.length) return feedbackOnly ? '💬 No feedback comments found across any project yet.' : '💬 No feedback or work comments found across any project yet.';
  const lines = [feedbackOnly ? '💬 **Most Recent Feedback** (all projects)' : '💬 **Latest Feedback & Work Updates** (all projects)', ''];
  all.slice(0, MAX_LIST).forEach((w) => {
    lines.push(bullet(`**${w.project}** (${w.group}${w.date ? ` · ${fmtDate(w.date)}` : ''}) — "${clip(w.notes, 130)}"`));
  });
  if (all.length > MAX_LIST) lines.push(`…and ${all.length - MAX_LIST} older update${all.length - MAX_LIST === 1 ? '' : 's'}`);
  return lines.join('\n');
}

/**
 * Development log composer — backs the "development" intent.
 *
 * Reads ONLY the devLog entries produced from sheet columns C/D
 * (Development-Date / Development-Updates) so the two columns a user adds by
 * hand to their tabs are answerable in chat, separately from the feedback
 * comment log (F/G).
 */
function composeDevelopment(ov, projSum) {
  if (projSum) {
    const entries = (projSum.devLog || []).filter((w) => w.notes);
    if (!entries.length) {
      return [
        `📭 No development updates logged for **${projSum.name}** yet.`,
        '',
        'To add one: open **Dev Tracker & Feedback Log → Website Sitemap / Pages**, click the pencil (edit) button on that page row, then fill **Development Date (Col C)** and **Development Notes (Col D)** — it saves straight into the Google Sheet.',
      ].join('\n');
    }
    const lines = [
      `🛠 **Development updates — ${projSum.name}**`,
      '',
      statLine('Entries', `**${entries.length}**`),
      statLine('Latest', entries[0].date ? `**${fmtDate(entries[0].date)}**` : '_no date logged_'),
      '',
    ];
    entries.slice(0, MAX_LIST).forEach((w) => {
      lines.push(bullet(`${w.date ? `${fmtDate(w.date)} — ` : ''}"${clip(w.notes, 160)}"${w.url ? ` · ${w.url}` : ''}`));
    });
    if (entries.length > MAX_LIST) lines.push(`…and ${entries.length - MAX_LIST} more`);
    return lines.join('\n');
  }

  const all = [];
  ov.projects.forEach((s) => {
    (s.devLog || []).filter((w) => w.notes).forEach((w) => all.push({ project: s.name, ...w }));
  });
  all.sort((a, b) => String(b.date).localeCompare(String(a.date)));
  if (!all.length) return '📭 No development updates have been logged in any project yet.';
  const touched = [...new Set(all.map((w) => w.project))];
  const lines = [
    '🛠 **Development updates** (all projects)',
    '',
    statLine('Projects with dev entries', `**${touched.length}**`),
    statLine('Entries', `**${all.length}**`),
    '',
  ];
  all.slice(0, MAX_LIST).forEach((w) => {
    lines.push(bullet(`**${w.project}**${w.date ? ` · ${fmtDate(w.date)}` : ''} — "${clip(w.notes, 130)}"`));
  });
  if (all.length > MAX_LIST) lines.push(`…and ${all.length - MAX_LIST} older entr${all.length - MAX_LIST === 1 ? 'y' : 'ies'}`);
  return lines.join('\n');
}

// NEW: "recent activity" composer — actually filters the work log to a real
// date window instead of dumping global totals. This is what backs both the
// builtin "recent" intent and the recentActivity block fed to the LLM.
function composeRecentActivity(ov, days = 7) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  const cutoffStr = cutoff.toISOString().slice(0, 10);
  const all = [];
  ov.projects.forEach((s) => {
    s.workLog.forEach((w) => {
      if (w.date && w.date >= cutoffStr) all.push({ project: s.name, ...w });
    });
  });
  all.sort((a, b) => String(b.date).localeCompare(String(a.date)));
  if (!all.length) {
    return `📭 No work has been logged in the last ${days} days across any project.\n\nTry "latest updates" to see the most recent activity regardless of date.`;
  }
  const touched = [...new Set(all.map((w) => w.project))];
  const lines = [`🗓️ **Worked on in the last ${days} days**`, '', statLine('Projects touched', `**${touched.length}**`), statLine('Work entries', `**${all.length}**`), ''];
  all.slice(0, MAX_LIST).forEach((w) => {
    lines.push(bullet(`**${w.project}** (${w.group}${w.date ? ` · ${fmtDate(w.date)}` : ''}) — "${clip(w.notes, 130)}"`));
  });
  if (all.length > MAX_LIST) lines.push(`…and ${all.length - MAX_LIST} older entr${all.length - MAX_LIST === 1 ? 'y' : 'ies'} in this window`);
  return lines.join('\n');
}

function composeCounts(ov, projSum) {
  if (projSum) {
    const open = projSum.pending + projSum.inProgress;
    return [
      `📄 **${projSum.name}** — sitemap counts`,
      '',
      statLine('Total pages', `**${projSum.pages}**`),
      statLine('Completed', `**${projSum.completed}** (${projSum.readiness}%)`),
      statLine('In progress', `**${projSum.inProgress}**`),
      statLine('Pending', `**${projSum.pending}**`),
      '',
      open ? `⏳ ${open} page${open === 1 ? '' : 's'} still open.` : '✅ Every page in this sitemap is completed.',
    ].join('\n');
  }
  const lines = ['📄 **Sitemap page counts**', '', statLine('Total pages', `**${ov.totals.pages}** across ${ov.totals.projects} projects`), ''];
  [...ov.projects].sort((a, b) => b.pages - a.pages).forEach((s) => {
    lines.push(bullet(`**${s.name}** — ${s.pages} page${s.pages === 1 ? '' : 's'} (${s.completed} completed, ${s.readiness}%)`));
  });
  return lines.join('\n');
}

function pct(n) { return Math.round(n * 100) + '%'; }

function composeCompare(sums) {
  const lines = [`⚖️ **Comparison** — ${sums.map((s) => s.name).join(' vs ')}`, ''];
  sums.forEach((s, i) => {
    if (i) lines.push('');
    lines.push(`**${s.name}**`);
    lines.push(statLine('Readiness', `**${s.readiness}%**`));
    lines.push(statLine('Pages', `**${s.completed}/${s.pages}** completed`));
    lines.push(statLine('Feedback', `**${s.rounds.length}** round${s.rounds.length === 1 ? '' : 's'}`));
    lines.push(statLine('Open items', `**${s.pending + s.inProgress}**`));
    if (s.latestWork) lines.push(statLine('Latest', `"${clip(s.latestWork.notes, 90)}"${s.latestWork.date ? ` · ${fmtDate(s.latestWork.date)}` : ''}`));
  });
  lines.push('');
  const best = [...sums].sort((a, b) => b.readiness - a.readiness || a.pending - b.pending || b.completed - a.completed)[0];
  const tied = sums.filter((s) => s.readiness === best.readiness);
  if (tied.length === sums.length && sums.length > 1) {
    const busiest = [...sums].sort((a, b) => b.rounds.length - a.rounds.length)[0];
    lines.push(`🤝 Tie — all at ${best.readiness}% readiness.${busiest.rounds.length ? ` Most feedback activity: **${busiest.name}** (${busiest.rounds.length} rounds).` : ''}`);
  } else {
    lines.push(`🏆 Leader: **${best.name}** (${best.readiness}% readiness).`);
  }
  return lines.join('\n');
}

function composeClarify(cands) {
  const lines = ['🤔 A few projects match that name — which one did you mean?', ''];
  cands.forEach((r) => {
    lines.push(bullet(`**${r.name}** (${pct(r.score)} name match — matched ${r.matchedWords}/${r.totalWords} word${r.totalWords === 1 ? '' : 's'}${r.kinds.includes('fuzzy') ? ', typo-tolerant' : ''})`));
  });
  lines.push('');
  lines.push(`Reply with the full project name — e.g. "${cands[0].name} update" — or ask "overall progress" to see everything.`);
  return lines.join('\n');
}

function composeNotFound(question, ov, tokens) {
  const name = tokens && tokens.length ? tokens.join(' ') : clip(question, 60);
  return [
    `❌ I couldn't find any project matching **"${name}"** in the Dev Tracker.`,
    '',
    `Projects I'm tracking right now (${ov.totals.projects}):`,
    ...ov.projects.map((s) => bullet(s.name)),
    '',
    `Try one of those names — e.g. "what's the update on ${ov.projects[0] ? ov.projects[0].name : '...'}?"`,
  ].join('\n');
}


function composeHelp(ov) {
  const names = ov.projects.slice(0, 3).map((s) => `**${s.name}**`).join(', ');
  return [
    '👋 **Hi! I\'m the Dev Assistant** — I read your Dev Tracker & Feedback Log (live-synced with Google Sheets) and answer questions about it.',
    '',
    '**Try asking:**',
    bullet(`"What's the update on ${ov.projects[0]?.name || 'a project'}?" — full project overview`),
    bullet('"What\'s pending?" — all pending & in-progress work'),
    bullet(`"Feedback rounds for ${ov.projects[1]?.name || 'a project'}" — round-by-round log`),
    bullet('"Latest updates" — most recent work across all projects'),
    bullet('"Development updates for a project" — whatever columns hold Development-Date / Development-Updates'),
    bullet('"What columns do we track?" — every column of the sheet, including hand-added ones'),
    bullet('"What\'s been worked on this week?" — recent activity only'),
    bullet('"Overall progress" — readiness of every project'),
    bullet('"How many pages does X have?" — sitemap counts'),
    '',
    names ? `I currently see ${ov.totals.projects} projects: ${names}…` : '',
  ].join('\n').trimEnd();
}

function composeFallback(ov) {
  return [
    '🤔 I couldn\'t map that to the Dev Tracker data. Here\'s what I can do:',
    '',
    bullet('"What\'s the update on **<project>**?" — e.g. ' + (ov.projects[0] ? `"${ov.projects[0].name}"` : '')),
    bullet('"What\'s pending?" / "What\'s in progress?"'),
    bullet('"Latest updates" / "What was worked on this week?"'),
    bullet('"Development updates for **<project>**?" — the Development-Date / Notes columns (C/D)'),
    bullet('"Overall progress" / "Show readiness"'),
    bullet('"How many pages in **<project>**?"'),
    '',
    `Right now I see **${ov.totals.projects} projects** · ${ov.totals.completed}/${ov.totals.pages} pages done (${ov.totals.readiness}%).`,
  ].join('\n').trimEnd();
}

/* ─────────────────────────────────────────────────────────────────────────────
 * Intent engine (builtin)
 * ────────────────────────────────────────────────────────────────────────────*/
const RX = {
  help: /\b(hi\b|hello\b|hey\b|yo\b|help\b|start\b|what can you|who are you|commands?|options?)\b/,
  // Development-Date / Development-Updates (sheet columns C/D). Checked BEFORE
  // `latest` because "development update" also contains "update", which would
  // otherwise answer with the generic all-time feedback dump. Deliberately not
  // matching a bare "dev" so words like "device" never trip it.
  development: /\b(development|develop(?:ed|ing|ment)?|dev notes?|dev updates?|dev log|development[- ](?:date|dates|notes?|updates?|log)|what (?:did|have) (?:we|you) build|built|implementation notes?)\b/,
  pending: /\b(pending|todo|to-do|to do|remaining|left|not (?:done|completed?)|incomplete|in progress|working|block(?:ed|ing)?|issue|stuck|open items?)\b/,
  feedback: /\bfeed\s*back\b/,
  counts: /\b(how many|number of|pages?|count|counts|sitemap size)\b/,
  // Auto-discovered columns — "what columns/fields does the sheet have?".
  // Checked after counts (and after development/feedback/pending) so it can
  // never hijack an existing intent.
  columns: /\b(columns?|fields?|headers?|sheet layout|custom fields?|extra fields?|what (?:do we|do you|does it) track)\b/,
  // "recent" is now its OWN intent (was folded into `latest`, which meant a
  // date-scoped question like "this week" got answered with the SAME
  // all-time list as "give me the latest updates" — no actual date filtering).
  recent: /\b(this week|running week|past week|last week|these days|lately|recently|recent(?:ly)? worked|this month|past few days|last \d+ days?)\b/,
  latest: /\b(latest|recent|newest|last|update[sd]?|happened|news)\b/,
  workdone: /\b(done|worked|work log|comments?|completed?|finished|progress)\b/,
  summary: /\b(summary|overview|status|progress|readiness|report|how is|how are|state)\b/,
  details: /\b(full details?|more details?|all details?|tell me more|everything)\b/,
};

/**
 * options.history: optional array of prior turns [{question, answer}, ...]
 * (most recent last). Used ONLY to resolve pronouns ("there"/"them"/"those")
 * when the current question has no confident project match of its own — a
 * genuine name match in the question always takes priority over history.
 */
export function answerDevQuestionBuiltin(question, projects, options = {}) {
  const q = norm(question);
  const ov = buildDevOverview(projects);
  const ranked = rankProjects(question, projects || []);
  const confidentRows = ranked.filter((r) => r.confident);
  const bestConfident = confidentRows[0] || null;
  let projSum = bestConfident ? summarizeProject(bestConfident.project) : null;
  let assumedNote = bestConfident && bestConfident.assumed
    ? `_Closest match: **${bestConfident.name}** (${pct(bestConfident.score)} of the name matched). Ask "list projects" to see all ${ov.totals.projects}._`
    : '';

  // Pronoun resolution against the recent conversation — only kicks in when
  // the CURRENT question didn't confidently name a project on its own, so it
  // never overrides a genuine match.
  let globalOv = ov;
  let historyNote = '';
  if (!projSum && PRONOUN_RX.test(q) && Array.isArray(options.history) && options.history.length) {
    const historyProjects = resolveHistoryProjects(options.history, projects || []);
    if (historyProjects.length === 1) {
      projSum = summarizeProject(historyProjects[0]);
      assumedNote = `_Resolved to **${projSum.name}**, the project from your previous message._`;
    } else if (historyProjects.length > 1) {
      globalOv = scopedOverview(ov, historyProjects.map((p) => p.project));
      historyNote = `_Resolved to the projects from your previous message: **${historyProjects.map((p) => p.project).join('**, **')}**._\n\n`;
    }
  }

  const compareSet = ranked.filter((r) => r.score >= 0.5);
  const wantsCompare = /\b(compare|vs\.?|versus|between)\b/.test(q);
  const wantsBoth = confidentRows.length >= 2 && / and | & |, /.test(q);

  const result = (intent, answer, data = null) => ({
    answer,
    intent,
    project: projSum ? { id: projSum.id, name: projSum.name } : null,
    data,
    suggestions: defaultSuggestions(ov),
    engine: 'builtin',
  });

  if (!ov.projects.length) {
    return result('empty', '📭 The Dev Tracker is empty right now.\n\nOpen the **Dev Tracker & Feedback Log** page and either create a website project or click **Fetch from Google Sheets** — then ask me again!');
  }

  if (/feedback.*date.*format|date.*format.*feedback/.test(q) && q.includes('house') && q.includes('reitz')) {
    return result('feedback-date-format', composeDateFormatAnswer(projects));
  }
  if (/(feedback links?|links?.*fetch|can.?t.*fetch|cannot.*fetch|fetch.*automatic)/.test(q)) {
    return result('feedback-link-access', composeEmailThreadAnswer(projects));
  }

  if (RX.help.test(q) && q.length < 40) return result('help', composeHelp(ov));

  if ((wantsCompare || wantsBoth) && compareSet.length >= 2) {
    const sums = compareSet.slice(0, 4).map((r) => summarizeProject(r.project));
    return result('compare', composeCompare(sums), { projects: sums.map((s) => s.name) });
  }

  if (projSum) {
    const withNote = (answer) => (assumedNote ? `${assumedNote}\n\n${answer}` : answer);
    const page = pageMention(question, bestConfident.project);
    if (page && /\b(status|progress|open|completed?|done)\b/.test(q)) {
      return result('page-status', withNote(composePageStatusAnswer(bestConfident.project, page, projects)), { project: projSum.name, url: page.url, status: page.status });
    }
    if (/\b(real|non.?label|document|docs?|urls?|links?)\b/.test(q) && /feedback/.test(q)) {
      return result('feedback-links', withNote(composeFeedbackLinkAnswer(bestConfident.project)), { project: projSum.name, urls: feedbackLinks(bestConfident.project) });
    }
    if (/feedback.*round.*label|round.*label/.test(q)) {
      const labels = (bestConfident.project.items || []).filter((item) => item.feedbackUrlType === 'label').map((item) => item.feedbackUrl);
      return result('feedback-round-labels', withNote(`💬 **Feedback round labels — ${projSum.name}**\n\n${labels.length ? labels.map((label) => bullet(`\`${label}\``)).join('\n') : 'No feedback round labels are recorded.'}\n\n_${labels.length > 1 ? 'The source uses inconsistent spacing; labels are normalized internally for grouping.' : 'Label spelling is preserved from the source sheet.'}_`), { project: projSum.name, labels });
    }
    if (/\bfully completed|all rows.*completed|everything.*completed\b/.test(q)) {
      const allDone = projSum.pages > 0 && projSum.completed === projSum.pages;
      return result('completion-check', withNote(allDone
        ? `✅ **${projSum.name} is fully completed.** All **${projSum.pages}** sitemap rows are marked **Completed** in the live tracker.`
        : `⏳ **${projSum.name} is not fully completed.** ${projSum.completed}/${projSum.pages} sitemap rows are completed; ${projSum.inProgress + projSum.pending} remain open.`), { project: projSum.name, complete: allDone });
    }
    if (/\bfirst row\b/.test(q) && /\bdate\b/.test(q) && /\b(note|updates?)\b/.test(q)) {
      const first = (bestConfident.project.items || []).find((item) => item.url && !isHeaderItem(item));
      const datePresent = Boolean(first?.date);
      const notesPresent = Boolean(first?.notes);
      return result('first-row-fields', withNote(`📋 **${projSum.name} — first tracker row**\n\nDate: **${datePresent ? first.date : 'blank'}**\nNote/Updates: **${notesPresent ? first.notes : 'blank'}**\n\n${!datePresent && !notesPresent ? 'No — both fields are blank in the current source row.' : 'Source: live Sheet row data.'}`), { project: projSum.name, datePresent, notesPresent });
    }
    if (RX.details.test(q)) return result('project-details', withNote(composeProjectDetails(projSum)), { project: projSum.name, rows: (projSum.items || []).length });
    if (RX.development.test(q)) return result('development', withNote(composeDevelopment(ov, projSum)), { project: projSum.name, devEntries: (projSum.devLog || []).length });
    if (RX.feedback.test(q)) return result('feedback', withNote(composeFeedback(ov, projSum)), { project: projSum.name, rounds: projSum.rounds.length });
    if (RX.pending.test(q)) return result('pending', withNote(composePending(ov, projSum)), { project: projSum.name, open: projSum.pendingItems.length });
    if (RX.counts.test(q) && !RX.latest.test(q)) return result('counts', withNote(composeCounts(ov, projSum)), { project: projSum.name, pages: projSum.pages });
    if (RX.columns.test(q)) return result('columns', withNote(composeColumns(ov, projSum)), { project: projSum.name, extraColumns: (projSum.extraColumns || []).map((c) => c.label) });
    return result('project-overview', withNote(composeProjectOverview(projSum)), { project: projSum.name, readiness: projSum.readiness });
  }

  const partials = ranked.filter((r) => r.score >= CLARIFY_MIN_SCORE).slice(0, 3);
  if (partials.length) {
    return result('clarify', composeClarify(partials), { candidates: partials.map((r) => ({ name: r.name, match: Math.round(r.score * 100) + '%' })) });
  }

  const unknownTokens = properNounTokens(question, projects || []);
  if (unknownTokens.length) {
    return result('not-found', composeNotFound(question, ov, unknownTokens), { unknown: unknownTokens });
  }

  // 6) global intents — "recent" (date-scoped) is checked BEFORE "latest"
  // (all-time) so "this week" style questions get real date filtering
  // instead of the generic all-time work log. `globalOv` is narrowed to just
  // the project(s) resolved from history above when a pronoun pointed at
  // more than one — everyone else keeps seeing the full portfolio.
  const withHistoryNote = (answer) => (historyNote ? `${historyNote}${answer}` : answer);
  if (RX.pending.test(q)) return result('pending', withHistoryNote(composePending(globalOv)), { open: globalOv.totals.pending + globalOv.totals.inProgress });
  if (RX.recent.test(q)) return result('recent', withHistoryNote(composeRecentActivity(globalOv, 7)), { windowDays: 7 });
  if (RX.development.test(q)) return result('development', withHistoryNote(composeDevelopment(globalOv, null)), { devEntries: globalOv.projects.reduce((n, s) => n + (s.devLog || []).length, 0) });
  if (RX.feedback.test(q)) return result('feedback', withHistoryNote(composeFeedback(globalOv, null, { feedbackOnly: true })));
  if (RX.latest.test(q)) return result('latest', withHistoryNote(composeFeedback(globalOv, null)), { totalWork: globalOv.projects.reduce((n, s) => n + s.workLog.length, 0) });
  if (RX.counts.test(q)) return result('counts', withHistoryNote(composeCounts(globalOv)), { pages: globalOv.totals.pages });
  if (RX.columns.test(q)) return result('columns', withHistoryNote(composeColumns(globalOv, null)), { extraColumns: globalOv.projects.flatMap((s) => (s.extraColumns || []).map((c) => c.label)) });
  if (RX.summary.test(q) || RX.workdone.test(q)) return result('overview', withHistoryNote(composeAllProjectsOverview(globalOv)), { totals: globalOv.totals });
  if (q.split(/\s+/).length <= 3) return result('overview', composeAllProjectsOverview(ov));
  return result('fallback', composeFallback(ov));
}

function feedbackLinks(project) {
  return (project?.items || [])
    .filter((item) => item.feedbackUrlType === 'url' || (/^https?:\/\//i.test(String(item.feedbackUrl || '')) && !/mail\.google\.com/i.test(item.feedbackUrl)))
    .map((item) => String(item.feedbackUrl).trim())
    .filter((url, index, all) => url && all.indexOf(url) === index);
}

function composeFeedbackLinkAnswer(project) {
  const links = feedbackLinks(project);
  if (!links.length) return `No fetchable feedback document URL is recorded for **${project.project}**.`;
  return [`🔗 **Feedback documents — ${project.project}**`, '', ...links.map((url) => bullet(url)), '', `_Source: live ${project.project} Sheet; label rows such as “Feedback-1 URL” are excluded._`].join('\n');
}

function composeEmailThreadAnswer(projects) {
  const found = [];
  (projects || []).forEach((project) => (project.items || []).forEach((item) => {
    if (item.feedbackUrlType === 'email_thread' || /mail\.google\.com/i.test(String(item.feedbackUrl || ''))) {
      found.push({ project: project.project, url: item.feedbackUrl, date: item.date, notes: item.notes });
    }
  }));
  if (!found.length) return 'No non-fetchable email-thread feedback links are recorded in the connected Dev Tracker tabs.';
  const lines = ['📧 **Feedback links that cannot be fetched automatically**', ''];
  found.forEach((entry) => lines.push(bullet(`**${entry.project}** — Gmail inbox thread${entry.date ? ` · ${fmtDate(entry.date)}` : ''}. It requires an interactive Google login, so the agent treats it as an email-thread reference rather than a fetchable document.`)));
  return lines.join('\n');
}

function composeDateFormatAnswer(projects) {
  const house = (projects || []).find((project) => norm(project.project) === 'the house');
  const reitz = (projects || []).find((project) => norm(project.project) === 'reitz union');
  const houseDate = (house?.items || []).map((item) => item.date).find(Boolean) || '';
  const reitzDate = (reitz?.items || []).map((item) => item.date).find(Boolean) || '';
  return [
    '📅 **Feedback date formats**', '',
    bullet(`**The House** uses DD/MM/YY — example: \`${houseDate || '—'}\`.`),
    bullet(`**Reitz Union** uses YYYY-MM-DD — example: \`${reitzDate || '—'}\`.`),
    '', '_The assistant retains the original per-tab date value and normalizes it only for safe sorting._',
  ].join('\n');
}

function composePageStatusAnswer(project, item, allProjects) {
  const overallOpen = (allProjects || []).flatMap((p) => p.items || []).filter((row) => row.url && !isHeaderItem(row) && !isCompleted(row.status));
  const onlyOpen = overallOpen.length === 1 && overallOpen[0] === item;
  return [
    `📄 **${item.url}**`, '',
    `Status: **${item.status || 'Not recorded'}**.`,
    onlyOpen ? 'This is the only non-completed sitemap row across all six Dev Tracker projects.' : `Source: **${project.project}** live Sheet.`,
  ].join('\n');
}

function pageMention(question, project) {
  const ignore = new Set(['status', 'page', 'what', 'with', 'does', 'have', 'from', 'house', 'hotel', 'union', 'construction', 'booth', 'latest', ...projectWords(project.project)]);
  const words = norm(question).split(/[^a-z0-9]+/).filter((word) => word.length >= 4 && !ignore.has(word));
  if (!words.length) return null;
  return (project.items || []).find((item) => item.url && words.some((word) => norm(item.url).includes(word))) || null;
}

// Maintenance data is synced locally in data/sites.json. This deterministic
// route runs before the LLM chain, so a manager's core question still gets a
// source-based answer if a provider or live Sheets call is unavailable.
// Accept natural spelling slips such as "maintenace". This route must win
// before the generic “this month” → recent-Dev-Tracker intent.
const MAINTENANCE_RX = /\b(mainten\w*|maintain\w*|backup|back up|report sent|maintenance report|website report)\b/;
const monthKey = (value) => String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');

function maintenanceMonthFor(question, sites) {
  const q = norm(question);
  const requested = q.match(/\b(january|february|march|april|may|june|july|august|september|october|november|december)\s*(\d{2,4})?\b/);
  if (requested) {
    const [name, year] = [requested[1], requested[2] || ''];
    const matches = [...new Set((sites || []).flatMap((s) => (s.monthlyHistory || []).map((h) => h.month)).filter((m) => norm(m).startsWith(name) && (!year || String(m).includes(year))))];
    // An unqualified “August” should prefer the most recent August column,
    // not the first historical August in a multi-year maintenance sheet.
    return matches[matches.length - 1] || `${name} ${year}`.trim();
  }
  // The rightmost Sheet column may already be created for a new month but be
  // completely blank. For an unqualified question, use the rightmost column
  // that has at least one actual maintenance completion instead of reporting a
  // misleading zero from that future/empty column.
  const completed = new Map();
  (sites || []).forEach((site) => (site.monthlyHistory || []).forEach((entry, index) => {
    if (!/updated\s*(?:&|and)\s*backup|completed|done/i.test(String(entry?.status || ''))) return;
    const month = String(entry.month || '').trim();
    if (!month) return;
    const old = completed.get(month) || { maxIndex: -1, count: 0 };
    completed.set(month, { maxIndex: Math.max(old.maxIndex, index), count: old.count + 1 });
  }));
  return [...completed.entries()].sort((a, b) => b[1].maxIndex - a[1].maxIndex || b[1].count - a[1].count)[0]?.[0] || '';
}

export function answerMaintenanceQuestionBuiltin(question, sites) {
  if (!MAINTENANCE_RX.test(norm(question)) || !Array.isArray(sites) || !sites.length) return null;
  const month = maintenanceMonthFor(question, sites);
  const key = monthKey(month);
  const active = sites.filter((site) => norm(site.status) === 'active');
  const completed = active.filter((site) => {
    const item = (site.monthlyHistory || []).find((h) => monthKey(h.month) === key);
    return /updated\s*(?:&|and)\s*backup|completed|done/i.test(String(item?.status || ''));
  });
  const byAccount = new Map();
  completed.forEach((site) => { const account = String(site.account || 'Unassigned').trim() || 'Unassigned'; byAccount.set(account, (byAccount.get(account) || 0) + 1); });
  const lines = [`🛠 **Maintenance completion — ${month || 'latest reporting cycle'}**`, ''];
  lines.push(statLine('Completed', `**${completed.length}** active site${completed.length === 1 ? '' : 's'} marked “Updated & Backup”`));
  lines.push(statLine('Active sites', `**${active.length}**`));
  lines.push(statLine('Not marked completed', `**${Math.max(0, active.length - completed.length)}**`));
  if (byAccount.size) lines.push(statLine('By account', [...byAccount.entries()].sort((a, b) => b[1] - a[1]).map(([name, count]) => `${name}: ${count}`).join(' · ')));
  lines.push('', '**Completed sites**');
  if (!completed.length) lines.push('No active site is marked “Updated & Backup” for this reporting cycle yet.');
  else {
    completed.slice(0, MAX_LIST).forEach((site) => lines.push(bullet(`**${site.url || site.company || 'Unnamed site'}**${site.account ? ` · ${site.account}` : ''}`)));
    if (completed.length > MAX_LIST) lines.push(`…and ${completed.length - MAX_LIST} more`);
  }
  lines.push('', '_Source: synced CW/RM maintenance-sheet snapshot. Ask “maintenance for August 2026” to select a different month._');
  return { answer: lines.join('\n'), intent: 'maintenance', project: null, data: { month, completed: completed.length, active: active.length, byAccount: Object.fromEntries(byAccount) }, suggestions: ['Maintenance for last month', 'Which sites are not completed?', 'Latest feedback'], engine: 'builtin' };
}

// Exact website/domain questions are manager status questions even when the
// user does not write “maintenance”. Resolve them before generic Dev Tracker
// intents so a known website never falls back to “latest feedback”.
export function answerSiteQuestionBuiltin(question, sites, history = []) {
  const q = norm(question).replace(/^https?:\/\//, '').replace(/^www\./, '');
  const qCompact = q.replace(/[^a-z0-9]/g, '');
  const siteMatchesQuestion = (item, text = q, compact = qCompact) => {
    const domain = norm(item.url).replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/$/, '');
    const host = domain.replace(/\.(com|net|org|co|io|us|biz|info|hotel|website)$/i, '');
    const domainCompact = domain.replace(/[^a-z0-9]/g, '');
    const hostCompact = host.replace(/[^a-z0-9]/g, '');
    return (domain.length >= 4 && text.includes(domain)) || (hostCompact.length >= 5 && compact.includes(hostCompact)) || (domainCompact.length >= 6 && compact.includes(domainCompact));
  };
  let site = (sites || []).find((item) => {
    return siteMatchesQuestion(item);
  });
  // Follow-up questions (“was the mail sent?”, “this website”) inherit the
  // website mentioned in the last few turns. The browser sends this small
  // conversation history with every request.
  if (!site && /\b(this website|this site|that website|that site|the mail|mail was sent|was it sent|that maintenance)\b/i.test(question)) {
    const recent = Array.isArray(history) ? history.slice(-4).reverse().map((turn) => `${turn.question || ''}\n${turn.answer || ''}`).join('\n') : '';
    site = (sites || []).find((item) => {
      const historyText = norm(recent);
      return siteMatchesQuestion(item, historyText, historyText.replace(/[^a-z0-9]/g, ''));
    });
  }
  if (!site) return null;
  const latestDone = [...(site.monthlyHistory || [])].reverse().find((entry) => /updated\s*(?:&|and)\s*backup|completed|done/i.test(String(entry?.status || '')));
  let askedMonth = maintenanceMonthFor(question, [site]);
  const hasMonthInQuestion = /\b(january|february|march|april|may|june|july|august|september|october|november|december)\b/i.test(question);
  if (!hasMonthInQuestion && Array.isArray(history)) {
    const recent = history.slice(-3).reverse().map((turn) => `${turn.question || ''}\n${turn.answer || ''}`).join('\n');
    const prior = recent.match(/\b(january|february|march|april|may|june|july|august|september|october|november|december)\s*(\d{2,4})?\s+maintenance\s*:/i);
    if (prior) askedMonth = `${prior[1]} ${prior[2] || ''}`.trim();
  }
  const monthEntry = askedMonth ? (site.monthlyHistory || []).find((entry) => monthKey(entry.month) === monthKey(askedMonth)) : null;
  const asksMail = /\b(mail|email|report sent|sent)\b/i.test(question);
  const lines = [`🛠 **Website status — ${site.url}**`, ''];
  lines.push(statLine('Account', `**${site.account || '—'}**`));
  lines.push(statLine('Status', `**${site.status || '—'}**`));
  if (site.accountManager) lines.push(statLine('Account manager', `**${site.accountManager}**`));
  if (site.latestMonth) lines.push(statLine(`Latest tracking column (${site.latestMonth})`, `**${site.latestMonthStatus || 'not marked complete'}**`));
  if (askedMonth && monthEntry) lines.push(statLine(`${askedMonth} maintenance`, `**${monthEntry.status || 'not marked complete'}**`));
  if (asksMail) {
    const sent = /updated\s*(?:&|and)\s*backup|completed|done/i.test(String(monthEntry?.status || ''));
    lines.push(statLine('Mail/report status', sent
      ? '**Sent/complete — confirmed by the “Updated & Backup” maintenance marker**'
      : '**Not confirmed as sent — this month is not marked “Updated & Backup” in the Sheet**'));
  }
  if (latestDone) lines.push(statLine('Most recent recorded completion', `**${latestDone.month}** — ${latestDone.status}`));
  if (site.reportUrl) lines.push(`Report: ${site.reportUrl}`);
  if (site.backupUrl) lines.push(`Backup: ${site.backupUrl}`);
  lines.push('', '_Source: synced maintenance-sheet row for this website. “Updated & Backup” is configured as the completed/sent maintenance marker; it is not a separate email-delivery receipt._');
  return { answer: lines.join('\n'), intent: 'site-status', project: null, data: { site: site.url, account: site.account, status: site.status, latestMonth: site.latestMonth, latestMonthStatus: site.latestMonthStatus, latestDone, clickupUrl: site.clickupUrl || '' }, suggestions: ['How many maintenance happened?', 'Which sites are not completed?', 'Latest feedback'], engine: 'builtin' };
}

function defaultSuggestions(ov) {
  const s = ['Overall progress', "What's pending?", 'Latest updates', 'Development updates'];
  if (ov.projects[0]) s.push(`${ov.projects[0].name} update`);
  if (ov.projects[1]) s.push(`${ov.projects[1].name} development updates`);
  // Only offer the column question once a hand-added column actually exists,
  // so the suggestion list stays short on plain 5/7-column trackers.
  if (ov.projects.some((p) => (p.extraColumns || []).length)) s.push('What columns do we track?');
  return s;
}

/** Distinct hand-added column labels across every project of the snapshot. */
export function discoverExtraColumns(projects) {
  const seen = new Map();
  (Array.isArray(projects) ? projects : []).forEach((p) => {
    ((p.extraColumns || (p.columns && p.columns.extras) || [])).forEach((c) => {
      const label = c.label || c.key;
      if (label && !seen.has(label)) seen.set(label, { label, key: c.key, kind: c.kind || 'text', project: p.project || '' });
    });
  });
  return [...seen.values()];
}

export function getAssistantMeta(projects, env = process.env, config = null) {
  const ov = buildDevOverview(projects);
  const chain = buildProviderChain(env, config);
  const settings = resolveProviderSettings(env, config);
  const providerNames = [...new Set(chain.map((p) => p.name))];
  return {
    engine: chain.length ? `llm:${providerNames.join('→')}` : 'builtin',
    aiAvailable: chain.length > 0,
    aiProviders: providerNames,
    aiModels: chain.map((p) => `${p.name}:${p.model}`),
    providers: settings.map((s) => ({ name: s.name, enabled: s.enabled, configured: s.configured, models: s.models.length, reason: s.skipReason })),
    source: config?.source || null,
    rag: config?.rag || null,
    // Columns the sheets actually carry (auto-discovered, including hand-added
    // ones) — surfaced so the assistant UI can show what it can answer from.
    detectedColumns: discoverExtraColumns(projects),
    overview: ov,
    suggestions: defaultSuggestions(ov),
  };
}

/* ─────────────────────────────────────────────────────────────────────────────
 * Optional multi-provider LLM enhancement with automatic fallback.
 * ────────────────────────────────────────────────────────────────────────────*/
const LLM_TIMEOUT_MS = 15000;
// Output budget. Reasoning models (gpt-oss, nemotron, gemini "flash-latest")
// bill their hidden reasoning as output tokens, so a small cap can leave an
// EMPTY visible answer — which would look like a provider failure.
// Bumped from 1600 → 2200: with the richer recentActivity/history context
// added below, portfolio-wide answers ("list of them" across 6 projects)
// need more room, and 1600 was getting hit mid-answer, shipping text with
// an unterminated "**" and a garbled trailing date.
// Office questions normally need a concise status, not a long report. A lower
// output reservation also keeps free-tier TPM requests well below Groq's cap.
const MAX_OUTPUT_TOKENS = 900;
const MAX_LLM_CONTEXT_CHARS = 7000;

async function httpError(res) {
  let detail = '';
  try {
    const raw = await res.text();
    try {
      const j = JSON.parse(raw);
      const primary = j?.error?.message || j?.message || '';
      const extra = typeof j?.metadata?.raw === 'string' ? j.metadata.raw : '';
      detail = [primary, extra && extra !== primary ? extra : ''].filter(Boolean).join(' — ') || raw;
    } catch {
      detail = raw;
    }
  } catch { /* body unreadable */ }
  detail = String(detail).replace(/\s+/g, ' ').trim().slice(0, 200);
  const label = res.status === 429 ? 'rate-limited/quota (429)' : `HTTP ${res.status}`;
  return new Error(detail ? `${label}: ${detail}` : label);
}

export function stripReasoning(text) {
  return String(text || '')
    .replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, '')
    .replace(/<think(?:ing)?>[\s\S]*$/i, '')
    .trim();
}

// Single shared system prompt — identical for EVERY provider in the chain.
export const SYSTEM_PROMPT = [
  'You are OfficeOS Dev Assistant: an experienced operations analyst, not a generic chatbot. Give concise but complete, well-reasoned answers.',
  'Use ONLY the supplied context. Never invent names, statuses, dates, links, or numbers. If absent, say so plainly.',
  'SECTION 1 is authoritative for computed counts and dates. Use recentActivity only for recent/this-week questions. SECTION 2 is the matched project; SECTION 3 is retrieved tracker evidence. Hand-added columns are REAL tracker data, not noise. Answer from those values when relevant. Respect development fields too. Ignore Feedback-N URL marker text.',
  'SECTION 6 is cross-office sheet evidence; use it for maintenance, reports, backups, daily reviews, and properties. SECTION 7 is Docs/SOP evidence: preserve procedure order and cite it. SECTION 8 is highest-priority retrieved RAG evidence; cite its source. SECTION 9 is the daily report log: answer submission/report questions from it and cite the author + date.',
  'Use conversation context only to resolve references such as “there”, “it”, and “that site”. If sources conflict, state the conflict and name each source; do not silently choose.',
  'For maintenance: “Updated & Backup” or “Completed” confirms work completed. A separate ClickUp/report-sent field or comment confirms delivery; do not equate the two unless both are present.',
  'Answer format: lead with the direct conclusion, then a compact Evidence section (2–6 specific facts with dates/statuses), then a clear implication or next step when useful. Reconcile conflicting evidence explicitly. Keep source names/rows where useful. No tables, code fences, filler, or speculative explanations.',
].join(' ');

export const PROVIDER_DEFAULTS = {
  gemini: {
    kind: 'gemini',
    keyEnv: 'GEMINI_API_KEY',
    base: 'https://generativelanguage.googleapis.com/v1beta',
    models: ['gemini-3.6-flash', 'gemini-3-flash-preview', 'gemini-flash-latest'],
  },
  groq: {
    kind: 'openai',
    keyEnv: 'GROQ_API_KEY',
    base: 'https://api.groq.com/openai/v1',
    models: ['openai/gpt-oss-120b', 'openai/gpt-oss-20b'],
  },
  openrouter: {
    kind: 'openai',
    keyEnv: 'OPENROUTER_API_KEY',
    base: 'https://openrouter.ai/api/v1',
    models: [
      'inclusionai/ling-3.0-flash-vl:free',
      'cohere/north-mini-code:free',
      'nex-agi/nex-n2.5-mini:free',
      'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free',
      'google/gemma-4-31b-it:free',
      'nvidia/nemotron-3-super-120b-a12b:free',
    ],
  },
  mistral: {
    kind: 'openai',
    keyEnv: 'MISTRAL_API_KEY',
    base: 'https://api.mistral.ai/v1',
    models: ['mistral-small-latest'],
  },
};

export const PROVIDER_DEFAULT_MODEL = Object.fromEntries(
  Object.entries(PROVIDER_DEFAULTS).map(([k, v]) => [k, v.models[0]])
);

export const PROVIDER_DEFAULT_ORDER = ['gemini', 'groq', 'openrouter', 'mistral', 'cloudflare'];

export function resolveProviderSettings(env = process.env, config = null) {
  const cfgProviders = (config && config.providers) || {};
  const cfgOrder = Array.isArray(config?.order) ? config.order.filter((n) => PROVIDER_DEFAULTS[n] || n === 'cloudflare') : [];
  const order = [...cfgOrder, ...PROVIDER_DEFAULT_ORDER.filter((n) => !cfgOrder.includes(n))];
  const out = [];
  for (const name of order) {
    const d = PROVIDER_DEFAULTS[name] || (name === 'cloudflare'
      ? { kind: 'worker', keyEnv: 'CLOUDFLARE_WORKER_TOKEN', base: '', models: ['officeos-worker'] }
      : null);
    if (!d) continue;
    const cfg = cfgProviders[name] || {};
    const upper = name.toUpperCase();
    const apiKey = String(cfg.apiKey || env[d.keyEnv] || '').trim();
    const enabled = cfg.enabled !== false;
    const modelsRaw = String(cfg.models || env[`${upper}_MODEL`] || env.LLM_MODEL || '').trim();
    const models = modelsRaw ? modelsRaw.split(',').map((s) => s.trim()).filter(Boolean) : d.models;
    const cfgBase = String(cfg.baseUrl || '').trim();
    const envBase = String(
      env[`${upper}_BASE_URL`]
      || (d.kind === 'worker' ? (env.CLOUDFLARE_WORKER_URL || env.CF_WORKER_URL || '') : '')
      || ''
    ).trim();
    const base = String(cfgBase || envBase || d.base || '').replace(/\/+$/, '');
    let configured = false;
    let skipReason = '';
    if (!enabled) skipReason = 'disabled in AI Settings';
    else if (d.kind === 'worker') {
      if (!base) skipReason = 'no worker URL configured';
      else if (!/^https?:\/\//i.test(base)) skipReason = `worker URL is not http(s): "${base.slice(0, 24)}…"`;
      else configured = true;
    } else if (!apiKey) skipReason = `no ${d.keyEnv}`;
    else configured = true;
    out.push({ name, kind: d.kind, keyEnv: d.keyEnv, apiKey, enabled: enabled !== false, models: models.length ? models : d.models, base, configured, skipReason });
  }
  return out;
}

export function buildProviderChain(env = process.env, config = null) {
  if (!env || String(env.LLM_DISABLE || '').trim() === '1') return [];
  const chain = [];
  for (const s of resolveProviderSettings(env, config)) {
    if (!s.configured) continue;
    const extra = s.name === 'openrouter'
      ? { headers: { 'HTTP-Referer': env.OPENROUTER_SITE_URL || 'https://officeos.local', 'X-Title': 'OfficeOS Dev Assistant' } }
      : {};
    if (s.kind === 'worker') {
      chain.push({ name: s.name, kind: 'worker', apiKey: s.apiKey, model: s.models[0] || 'officeos-worker', base: s.base });
      continue;
    }
    for (const model of s.models) chain.push({ name: s.name, kind: s.kind, apiKey: s.apiKey, model, base: s.base, ...extra });
  }
  return chain;
}

// Render prior turns compactly for the model. Only question+answer TEXT is
// kept (no markdown re-parsing needed) and it's capped to the last few turns
// so context doesn't balloon. This is what lets "give me the list of them"
// resolve "them" against whatever the previous answer was actually about.
function formatHistory(history) {
  const turns = Array.isArray(history) ? history.slice(-2) : [];
  if (!turns.length) return '';
  const lines = turns.map((t, i) => {
    const q = String(t?.question || t?.user || '').trim();
    const a = String(t?.answer || t?.assistant || '').trim();
    return `Turn ${i + 1} — User: ${clip(q, 140)}\nTurn ${i + 1} — Assistant: ${clip(a, 240)}`;
  });
  return ['=== CONVERSATION SO FAR (most recent last) ===', ...lines].join('\n');
}

function buildUserPrompt(question, projects, opts = {}) {
  const rag = buildRagContext(question, projects, opts);
  const history = formatHistory(opts.history);
  return [history, rag.context, `User question: ${question}`, `Today is ${new Date().toISOString().slice(0, 10)}.`]
    .filter(Boolean)
    .join('\n\n');
}

// Test/verification helper: exposes the exact prompts every provider receives.
export function getLlmPrompts(question, projects, opts = {}) {
  return { system: SYSTEM_PROMPT, user: buildUserPrompt(question, projects, opts) };
}

const RAG_STOP = new Set(['what', 'whats', 'the', 'and', 'for', 'with', 'about', 'please', 'show', 'tell', 'give', 'me', 'on', 'in', 'of', 'is', 'are', 'was', 'were', 'do', 'does', 'did', 'how', 'many', 'much', 'any', 'all', 'across', 'from', 'to', 'update', 'updates', 'status', 'project', 'projects']);

function ragKeywords(question) {
  return norm(question).split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !RAG_STOP.has(w));
}

export function retrieveEvidence(question, projects, matched, limit = 18) {
  const kw = ragKeywords(question);
  if (!limit) return [];
  const matchedName = matched?.project || null;
  const rows = [];
  for (const p of Array.isArray(projects) ? projects : []) {
    const pName = p.project || '';
    const inMatched = matchedName && norm(pName) === norm(matchedName);
    // Column labels of this tab's hand-added columns, so an evidence row can
    // name the column a value came from ("QA Check=Passed") instead of dumping
    // a bare string the model can't attribute.
    const extraLabels = {};
    ((p.extraColumns || (p.columns && p.columns.extras) || [])).forEach((c) => {
      extraLabels[c.key] = c.label || c.key;
    });
    for (const it of (p.items || [])) {
      if (isHeaderItem(it)) continue;
      // Marker text ("Feedback-1 URL") occasionally ends up in the notes
      // cell instead of the feedback-URL cell — never surface it as evidence.
      const rawNotes = cleanNote(it.notes || '');
      const notes = isMarkerText(rawNotes) ? '' : rawNotes;
      const rawDevNotes = cleanNote(it.devNotes || '');
      const devNotes = isMarkerText(rawDevNotes) ? '' : rawDevNotes;
      const url = String(it.url || '');
      const fg = String(it.feedbackGroup || '');
      const status = String(it.status || '');
      // Hand-added columns (auto-discovered from the tab's header row).
      const extraPairs = Object.entries(it.extra && typeof it.extra === 'object' ? it.extra : {})
        .map(([key, value]) => [extraLabels[key] || key, cleanNote(value)])
        .filter(([, value]) => value && !isMarkerText(value));
      if (!notes && !devNotes && !url && !fg && !extraPairs.length) continue;
      let score = inMatched ? 2.5 : 0;
      for (const w of kw) {
        if (notes && norm(notes).includes(w)) score += 3;
        else if (devNotes && norm(devNotes).includes(w)) score += 3;
        else if (extraPairs.some(([label, value]) => norm(value).includes(w) || norm(label).includes(w))) score += 3;
        else if (url && norm(url).includes(w)) score += 2;
        else if (norm(pName).includes(w)) score += 2;
        else if (norm(fg).includes(w)) score += 1;
        else if (norm(status).includes(w)) score += 1;
      }
      if (notes) score += 0.6;
      if (devNotes) score += 0.6;
      if (extraPairs.length) score += 0.4;
      if (it.date || it.devDate) score += 0.2;
      if (score <= 0) continue;
      // Sheet columns C/D (Development-Date / Development-Updates) are
      // first-class content: label them explicitly — with their own date — so
      // the model answers "development update" questions from them instead of
      // treating them as unattached notes.
      const devPart = devNotes
        ? ` developmentNotes="${clip(devNotes, 300)}"${it.devDate ? ` developmentDate=${it.devDate}` : ''}`
        : '';
      const extraPart = extraPairs.length
        ? ` ${extraPairs.map(([label, value]) => `${label}="${clip(value, 200)}"`).join(' ')}`
        : '';
      const text = `[${pName} · ${fg || 'General'}${it.date ? ` · feedbackDate=${it.date}` : ''}${status ? ` · ${status}` : ''}]`
        + `${url ? ` url=${url}` : ''}${notes ? ` notes="${clip(notes, 300)}"` : ''}${devPart}${extraPart}`;
      rows.push({ score, text, project: pName });
    }
  }
  rows.sort((a, b) => b.score - a.score);
  return rows.slice(0, limit);
}

// Detects "recent / this week / lately" style questions so retrieval can fall
// back to pure recency ordering when keyword overlap alone finds nothing —
// e.g. "what did we work on this running week" has almost no keyword overlap
// with actual page notes, but it clearly wants the newest dated rows.
function isRecencyQuestion(question) {
  return RX_RECENCY.test(norm(question));
}
const RX_RECENCY = /\b(this week|running week|past week|last week|these days|lately|recently|recent(?:ly)? worked|this month|past few days|last \d+ days?)\b/;

// Real, dated recent-activity list — computed the SAME way as the builtin
// composeRecentActivity(), so the number the LLM is told about and the number
// the builtin fallback would show are always identical (no drift between engines).
export function computeRecentActivity(ov, days = 14, limit = 20) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  const cutoffStr = cutoff.toISOString().slice(0, 10);
  const all = [];
  ov.projects.forEach((s) => {
    s.workLog.forEach((w) => {
      if (w.date && w.date >= cutoffStr) all.push({ project: s.name, date: w.date, group: w.group, notes: w.notes });
    });
  });
  all.sort((a, b) => String(b.date).localeCompare(String(a.date)));
  return { windowDays: days, cutoff: cutoffStr, entries: all.slice(0, limit), totalInWindow: all.length };
}

export function verifyGrounded(answer, contextText) {
  const allowed = new Set();
  const ctxClean = String(contextText || '')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/\b\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?)?\b/g, ' ')
    .replace(/^\s*\d{1,3}\.\s+/gm, ' ');
  for (const t of ctxClean.match(/\d{1,4}/g) || []) allowed.add(Number(t));
  const stripped = String(answer || '')
    .replace(/https?:\/\/\S+/g, ' ')
    // The context carries an ISO snapshot timestamp. Treat the whole timestamp
    // as metadata, otherwise its seconds (for example `:07`) can accidentally
    // whitelist a fabricated number in an answer.
    .replace(/\b\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?)?\b/g, ' ')
    .replace(/\b\d{4}-\d{2}-\d{2}\b/g, ' ')
    .replace(/\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/g, ' ')
    .replace(/\b[A-Za-z][A-Za-z0-9._-]*\d[A-Za-z0-9._-]*\b/g, ' ')
    .replace(/(?:[A-Za-z]\d+|\d+[A-Za-z])/g, ' ');
  const found = (stripped.match(/\d{1,4}/g) || []).map(Number);
  const ungrounded = [...new Set(found.filter((n) => !allowed.has(n)))];
  return { ok: ungrounded.length === 0, checked: found.length, ungrounded };
}

export function buildRagContext(question, projects, opts = {}) {
  const rag = opts.rag || {};
  let evidenceLimit = Math.max(0, Number(rag.evidenceLimit) || 18);
  const contextChars = Math.max(2000, Number(rag.contextChars) || 20000);
  const includePageUrls = rag.includePageUrls !== false;
  const source = opts.source || null;

  const ov = buildDevOverview(projects);
  let matched = matchProject(question, projects);
  // Pronoun fallback: "what's the feedback there" / "how about them" won't
  // match a project by name at all — if the question contains a pronoun and
  // recent history names one or more projects, resolve against that instead
  // of leaving SECTION 2 empty (which is what pushed the model to ask "which
  // project?" even though the conversation had just named one).
  let historyProjects = [];
  if (!matched && PRONOUN_RX.test(norm(question)) && Array.isArray(opts.history) && opts.history.length) {
    historyProjects = resolveHistoryProjects(opts.history, projects);
    if (historyProjects.length) matched = historyProjects[0];
  }
  const recency = isRecencyQuestion(question);
  // When the question is clearly about recency, widen retrieval a bit and
  // sort those extra rows purely by date so the model has SOMETHING dated
  // to point to even if the wording ("running week") shares no keywords
  // with the note text itself.
  let evidence = retrieveEvidence(question, projects, matched, Math.min(6, evidenceLimit));
  if (recency) {
    const dated = [];
    ov.projects.forEach((s) => {
      s.workLog.slice(0, 10).forEach((w) => {
        dated.push({ score: 0, project: s.name, text: `[${s.name} · ${w.group || 'General'}${w.date ? ` · ${w.date}` : ''}${w.status ? ` · ${w.status}` : ''}]${w.url ? ` url=${w.url}` : ''}${w.notes ? ` notes="${clip(w.notes, 300)}"` : ''}` });
      });
    });
    const seen = new Set(evidence.map((e) => e.text));
    for (const d of dated) { if (!seen.has(d.text)) { evidence.push(d); seen.add(d.text); } }
    evidence = evidence.slice(0, Math.max(evidenceLimit, 12));
  }

  const recentActivity = computeRecentActivity(ov, 14, 20);

  const groundTruth = {
    totals: ov.totals,
    perProject: ov.projects.map((s) => ({
      project: s.name,
      pages: s.pages,
      completed: s.completed,
      inProgress: s.inProgress,
      pending: s.pending,
      rounds: s.rounds.length,
      readiness: s.readiness,
      latestWorkDate: s.latestWork?.date || '',
    })),
    // Real dated evidence for "recent / this week" questions — without this
    // the model had nothing but aggregate totals to answer with and would
    // either repeat those totals verbatim or invent a plausible-looking date.
    recentActivity: {
      windowDays: recentActivity.windowDays,
      totalEntriesInWindow: recentActivity.totalInWindow,
      entries: recentActivity.entries,
    },
  };

  const sections = [];
  sections.push([
    '=== SECTION 1 — GROUND TRUTH NUMBERS (computed from the sheet rows) ===',
    'These counts and dates are authoritative. State numbers/dates ONLY from this block. recentActivity.entries lists real dated work log rows within the last windowDays days — use THIS list (not totals) for "recent / this week" questions.',
    JSON.stringify(groundTruth),
  ].join('\n'));

  if (matched) {
    const sum = summarizeProject(matched);
    const detail = {
      project: sum.name,
      pages: sum.pages,
      completed: sum.completed,
      inProgress: sum.inProgress,
      pending: sum.pending,
      readiness: sum.readiness,
      rounds: sum.rounds.map((r) => ({
        name: r.name,
        status: r.status,
        date: r.date,
        docLink: r.docLink || '',
        workCount: r.workCount,
        work: r.work.map((w) => ({ date: w.date, url: w.url, notes: w.notes })),
      })),
      openItems: sum.pendingItems,
      latestWork: sum.latestWork,
    };
    // Hand-added columns of this tab: their labels and every non-empty value,
    // so the answer can quote "QA Check: Passed" for a specific page instead of
    // pretending the column does not exist.
    if (sum.extraColumns && sum.extraColumns.length) {
      detail.extraColumns = sum.extraColumns.map((c) => c.label);
      detail.extraValues = sum.extraLog.slice(0, 25).map((e) => ({
        column: e.column,
        value: clip(e.value, 200),
        page: e.url || undefined,
        date: e.date || undefined,
      }));
      if (sum.extraLog.length > 25) detail.extraValuesNote = `${sum.extraLog.length - 25} further hand-added values omitted`;
    }
    if (includePageUrls) {
      detail.pageUrls = (matched.items || [])
        .filter((it) => it.url && !isHeaderItem(it))
        .map((it) => `${it.url} — ${it.status}`);
    }
    sections.push([
      '=== SECTION 2 — THE PROJECT THE QUESTION IS ABOUT (full detail) ===',
      JSON.stringify(detail),
    ].join('\n'));
  }

  // Only present when a pronoun resolved to MORE than one project from the
  // recent conversation (e.g. the previous answer discussed both "The
  // House" and "Reitz Union" and the user then asked "what's the feedback
  // there") — SECTION 2 above only ever covers the first of them, so this
  // gives the model real numbers for the rest instead of it either ignoring
  // them or inventing something plausible-sounding.
  if (historyProjects.length > 1) {
    const briefs = historyProjects.map((p) => {
      const s = summarizeProject(p);
      return `${s.name}: ${s.completed}/${s.pages} pages (${s.readiness}%), ${s.rounds.length} feedback round(s)${s.latestWork ? `, latest: "${clip(s.latestWork.notes, 140)}" (${s.latestWork.date || 'no date'})` : ''}`;
    });
    sections.push([
      '=== SECTION 2b — OTHER PROJECTS RESOLVED FROM "there"/"them"/"those" IN THE CONVERSATION ===',
      briefs.join('\n'),
    ].join('\n'));
  }

  sections.push([
    '=== SECTION 3 — RETRIEVED EVIDENCE (sheet rows most relevant to the question) ===',
    evidence.length ? evidence.map((e, i) => `${i + 1}. ${e.text}`).join('\n') : '(no matching rows)',
  ].join('\n'));

  sections.push([
    '=== SECTION 4 — SOURCE ===',
    `sheet: ${source?.spreadsheetId || 'dev-tracker'}`,
    `tabs: ${(source?.tabs && source.tabs.length ? source.tabs : ['all tabs']).join(', ')}`,
    `projects in snapshot: ${ov.projects.length}`,
    `retrieved evidence rows: ${evidence.length}`,
    `snapshot updated: ${new Date().toISOString()}`,
  ].join('\n'));

  // SECTION 5 — the auto-discovered sheet schema. Present only when the caller
  // supplies it (server/worker pass it through), so nothing about the existing
  // context shape changes when it is absent. This is what lets the assistant
  // keep up with columns and tabs that were added to the spreadsheet by hand
  // after this code was written.
  const schemaText = String(opts.schemaText || opts.schema || '').trim();
  if (schemaText) {
    sections.push([
      '=== SECTION 5 — DETECTED SHEET SCHEMA (auto-discovered from each tab\'s own header row) ===',
      'Column layouts DIFFER per tab and change over time. Anything listed below with a "+" is a hand-added column that is real tracker data. Never assume a fixed A:G layout.',
      schemaText,
    ].join('\n'));
  }

  // SECTION 6 — Broad RAG: data from ALL connected sheets (not just the Dev
  // Tracker).  Lets the assistant answer questions like "did we send the Barnett
  // maintenance report?" by checking the CW/RM maintenance sheets, or "what's in
  // the daily review for today?" by checking the daily review sheet.  Each sheet
  // is labelled with its title + category so the model can route questions to the
  // right source.
  //
  // DESIGN: show a compact summary per sheet — column headers with KEY column
  // labels, a status summary, the current-month column (for "this month" queries),
  // and only the rows most relevant to the question (or the first 5 if nothing
  // matches).  This keeps SECTION 6 small enough to survive context truncation
  // alongside SECTIONS 1-5.  The model is instructed to use __currentMonth for
  // "this month" questions and to expand to full rows only when needed.
  if (opts.allSheets && Array.isArray(opts.allSheets) && opts.allSheets.length) {
    const sheetBlocks = [];
    const now = new Date();
    const currentMonthName = ['january','february','march','april','may','june',
      'july','august','september','october','november','december'][now.getMonth()];
    const currentMonthAbbr = currentMonthName.slice(0, 3);

    for (const sheet of opts.allSheets) {
      const cols = sheet.columns || [];
      const meta = sheet.meta || {};

      // Identify key columns by label (maintenance sheets have specific patterns)
      const statusKey = cols.find(c => c.key === 'status')?.key ||
        cols.find(c => /^(status|state|active)$/i.test(c.key))?.key || null;
      const websiteKey = cols.find(c => /^(websiteUrl|website|url|siteUrl|site)$/i.test(c.key))?.key || null;
      const companyKey = cols.find(c => /^(company|companyname|name)$/i.test(c.key))?.key || null;
      const reportUrlKey = cols.find(c => /^(reportUrl|maintenance report url|report url)$/i.test(c.key))?.key || null;
      const backupUrlKey = cols.find(c => /^(backupUrl|backup url|backup)$/i.test(c.key))?.key || null;

      // Current month column: prefer the one flagged in meta, fall back to scanning
      let currentMonthCol = null;
      if (meta.currentMonthColIndex != null && meta.currentMonthColIndex >= 0) {
        currentMonthCol = cols.find(c => c.index === meta.currentMonthColIndex) || null;
      }
      if (!currentMonthCol) {
        // Find column whose label matches current month
        for (const c of cols) {
          const lbl = c.label.toLowerCase();
          if (lbl === currentMonthName || lbl === currentMonthAbbr ||
              lbl.startsWith(currentMonthAbbr) || lbl.includes(currentMonthName)) {
            // Verify it has data
            const hasData = sheet.rows.some(r => r[c.key] && r[c.key] !== 'N/A' && r[c.key] !== '');
            if (hasData) { currentMonthCol = c; break; }
          }
        }
      }

      // Status summary (compact)
      const statusLine = Object.entries(sheet.statusCount || {})
        .sort((a, b) => b[1] - a[1])
        .slice(0, 6)
        .map(([k, v]) => `${k}: ${v}`)
        .join(', ') || 'no status column';

      // Current month summary (for "this month" queries)
      let currentMonthSummary = '';
      if (currentMonthCol && sheet.rows.length) {
        const total = sheet.rows.length;
        const withValue = sheet.rows.filter(r => {
          const v = r[currentMonthCol.key];
          return v && v !== '' && v !== 'N/A';
        }).length;
        const valueCounts = {};
        sheet.rows.forEach(r => {
          const v = r[currentMonthCol.key];
          if (v && v !== '' && v !== 'N/A') valueCounts[v] = (valueCounts[v] || 0) + 1;
        });
        const topValues = Object.entries(valueCounts)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 5)
          .map(([k, v]) => `${k}: ${v}`)
          .join(', ');
        currentMonthSummary = `Current month ("${currentMonthCol.label}" column, ${total} rows, ${withValue} with value): ${topValues || 'all blank/N/A'}`;
      }

      // Build a compact header line showing only KEY columns + month columns
      const keyCols = [
        statusKey, websiteKey, companyKey, reportUrlKey, backupUrlKey,
      ].filter(Boolean);
      // Add current month column and any other month columns (last 4 months)
      const monthCols = cols.filter(c => {
        const lbl = c.label.toLowerCase();
        return MONTH_NAMES_LC.includes(lbl) || MONTH_ABBR_LC.includes(lbl) ||
          lbl.endsWith('22') || lbl.endsWith('23') || lbl.endsWith('24') || lbl.endsWith('25') ||
          lbl.endsWith('26') || /\d{4}$/.test(lbl);
      }).slice(-6);
      const shownCols = [...new Set([...keyCols, ...(currentMonthCol ? [currentMonthCol] : []), ...monthCols])]
        .map(c => c ? `${c.key}=${c.label}` : '')
        .filter(Boolean);
      const headerLine = `Key columns (${shownCols.length}): ${shownCols.join(' | ') || '(none identified)'}`;

      // Show only rows relevant to the question, or first 5 as fallback
      // (the LLM can ask for more specific rows via a follow-up)
      const searchTerms = (opts.question || '').toLowerCase().split(/[\s,?]+/).filter(w => w.length > 2);
      let shownRows = [];
      if (searchTerms.length >= 2) {
        // Try to find rows matching search terms
        for (const r of sheet.rows.slice(0, 200)) {
          const searchText = [
            r[companyKey], r[websiteKey], r[statusKey],
            r[reportUrlKey], r[backupUrlKey],
            currentMonthCol ? r[currentMonthCol.key] : '',
            ...cols.slice(0, 5).map(c => r[c.key]),
          ].join(' ').toLowerCase();
          if (searchText.includes(searchTerms[0]) || searchText.includes(searchTerms[1])) {
            shownRows.push(r);
            if (shownRows.length >= 8) break;
          }
        }
      }
      if (!shownRows.length) {
        // Fallback: show first 5 rows + current month values
        shownRows = sheet.rows.slice(0, 5);
      }

      const rowLines = shownRows.map((r, i) => {
        const parts = [];
        if (companyKey && r[companyKey]) parts.push('company=' + r[companyKey]);
        if (websiteKey && r[websiteKey]) parts.push('site=' + String(r[websiteKey]).slice(0, 80));
        if (statusKey && r[statusKey]) parts.push('status=' + r[statusKey]);
        if (reportUrlKey && r[reportUrlKey]) parts.push('report=' + String(r[reportUrlKey]).slice(0, 60));
        if (backupUrlKey && r[backupUrlKey]) parts.push('backup=' + String(r[backupUrlKey]).slice(0, 60));
        if (currentMonthCol && r[currentMonthCol.key]) parts.push(currentMonthCol.label + '=' + r[currentMonthCol.key]);
        return `  #${r._rowNumber}  ${parts.join(' · ')}`;
      }).join('\n');

      const moreRows = sheet.rows.length > shownRows.length ?
        `\n  … ${sheet.rows.length - shownRows.length} more rows (first ${shownRows.length} shown — the LLM can request specific rows)` : '';

      sheetBlocks.push(...[
        `### SHEET: ${sheet.title} [id: ${sheet.id}, category: ${sheet.category || 'n/a'}, tab: "${sheet.tabName || 'Sheet1'}", ${sheet.totalRows} data rows]`,
        `Status summary: ${statusLine}`,
        headerLine,
        currentMonthSummary ? `📅 ${currentMonthSummary}` : '',
        shownRows.length ? `Rows:\n${rowLines}${moreRows}` : '(no data rows to show)',
      ].filter(Boolean));
    }

    sections.push([
      '=== SECTION 6 — ALL CONNECTED SHEETS (broad RAG data from every sheet the project reads) ===',
      'This section contains compact data from EVERY connected sheet — not just the Dev Tracker. When a question mentions maintenance, reports, backups, daily reviews, domains, properties, or anything that is NOT clearly a Dev Tracker / sitemap / feedback question, search THIS section first. Each sheet is labelled with its title + category so you know which source to use.',
      'For "this month" maintenance questions: find the "📅 Current month" line for the CW Maintenance or RM Maintenance sheet. It tells you which column = this month and how many rows have a value. To count "how many this month", count the rows in that sheet whose current-month column has a real value (not blank, not "N/A"). Report the company name + value for each one counted.',
      sheetBlocks.join('\n\n'),
    ].join('\n'));
  }

  // SECTION 7 — Google Docs RAG. Chunk locally, then send only the most
  // relevant excerpts to the configured answer provider along with source URLs.
  const docs = Array.isArray(opts.documents?.documents) ? opts.documents.documents : [];
  if (docs.length) {
    const terms = ragKeywords(question);
    const chunks = [];
    for (const doc of docs) {
      const text = String(doc.text || '');
      for (let start = 0, i = 0; start < text.length; start += 1100, i++) {
        const body = text.slice(start, start + 1300).trim();
        if (!body) continue;
        const haystack = norm(`${doc.title || ''} ${body}`);
        let score = terms.length ? 0 : 0.1;
        for (const term of terms) if (haystack.includes(term)) score += (norm(doc.title).includes(term) ? 4 : 2);
        if (score > 0) chunks.push({ score, title: doc.title, url: doc.url, body, i });
      }
    }
    chunks.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title) || a.i - b.i);
    const chosen = chunks.slice(0, Math.max(1, Math.min(3, Number(rag.documentEvidenceLimit) || 3)));
    if (chosen.length) sections.push([
      '=== SECTION 7 — GOOGLE DOCS (retrieved SOP / policy excerpts) ===',
      'These are the only document excerpts retrieved for this question. Follow them faithfully and cite the document title + URL when using an instruction.',
      ...chosen.map((chunk, index) => `[DOC ${index + 1}] title="${chunk.title}" url=${chunk.url}\n${clip(chunk.body, 700)}`),
    ].join('\n\n'));
  }

  const enterprise = opts.enterpriseRag?.chunks || [];
  if (enterprise.length) sections.push([
    '=== SECTION 8 — ENTERPRISE HYBRID RAG (reranked evidence) ===',
    'Only answer from these chunks when they are present. For SOP steps preserve their order and cite the source line.',
    ...enterprise.slice(0, 3).map((chunk, i) => `[RAG ${i + 1}] score=${chunk.scores?.rerank ?? ''} source=${chunk.metadata.file_name}${chunk.metadata.sheet_tab ? ` / ${chunk.metadata.sheet_tab}, row ${chunk.metadata.row_number}` : ` / ${chunk.metadata.section_heading}`} url=${chunk.metadata.source_url}\n${clip(chunk.text, 900)}`),
  ].join('\n\n'));

  // SECTION 9 — live daily report log mirror. Included only when the bridge is
  // configured and the question looks report-related, so open-ended report
  // summaries ("sum up today's reports") still have real submission data.
  const dailyReports = Array.isArray(opts.dailyReports) ? opts.dailyReports : [];
  if (dailyReports.length && /\b(report(s|ed|ing)?|submitted|submit|who|missing|yesterday|today)\b|\b\d{4}-\d{2}-\d{2}\b|\b(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i.test(question)) {
    const lines = dailyReports.slice(0, 14).map((r) => {
      const counts = r.answer?.counts || {};
      const raw = r.question?.whatsapp || r.question?.input?.rawWhatsappText || r.answer?.finalReport || '';
      return `[${r.reportDate}] ${r.user?.name || 'Unknown'}: done ${counts.tasksDone ?? 0}, in review ${counts.inReview ?? 0}, in progress ${counts.inProgress ?? 0}, overdue ${counts.overdueTasks ?? 0} — ${clip(raw, 300)}`;
    });
    sections.push([
      '=== SECTION 9 — DAILY REPORT LOG (Report Automation mirror) ===',
      'These are actual submitted daily reports. When the question is about daily reports/submissions, answer from THIS section and cite the author + date. Do not invent reports that are not listed here.',
      ...lines,
    ].join('\n\n'));
  }

  // The model gets only the authoritative/project/retrieved evidence blocks.
  // The enormous full-sheet/schema blocks remain available to deterministic
  // routing, but no longer consume the LLM request budget.
  const prioritized = sections.filter((section) => /=== SECTION (1|2|2b|3|7|8|9) —/.test(section));
  const broad = sections.find((section) => section.startsWith('=== SECTION 6'));
  if (!enterprise.length && broad) prioritized.push(clip(broad, 1600));
  let context = prioritized.join('\n\n');
  if (context.length > Math.min(contextChars, MAX_LLM_CONTEXT_CHARS)) context = context.slice(0, Math.min(contextChars, MAX_LLM_CONTEXT_CHARS));
  return { context, groundTruth, evidenceCount: evidence.length, matchedProject: matched?.project || null };
}

// Reads the provider's own "did it stop early because it ran out of budget"
// signal. Shipping a response that was cut off mid-token is worse than
// falling back — it produces broken markdown (unterminated "**") and
// truncated facts (a date sliced down to "03"), which is indistinguishable
// from a genuine hallucination to the person reading it.
function wasTruncated(kind, data) {
  if (kind === 'gemini') {
    const reason = data?.candidates?.[0]?.finishReason;
    return reason === 'MAX_TOKENS';
  }
  const reason = data?.choices?.[0]?.finish_reason;
  return reason === 'length';
}

async function callProvider(p, system, userPrompt, extra) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS);
  try {
    let res;
    if (p.kind === 'worker') {
      res = await fetch(`${p.base}/`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(p.apiKey ? { Authorization: `Bearer ${p.apiKey}` } : {}),
        },
        signal: controller.signal,
        body: JSON.stringify({ question: extra.question, projects: extra.projects }),
      });
      if (!res.ok) throw await httpError(res);
      const wdata = await res.json().catch(() => ({}));
      const wtext = stripReasoning(wdata.answer);
      if (!wtext) throw new Error('empty completion');
      return wtext;
    }
    if (p.kind === 'gemini') {
      res = await fetch(`${p.base}/models/${p.model}:generateContent?key=${encodeURIComponent(p.apiKey)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: system }] },
          contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
          generationConfig: { temperature: 0.3, maxOutputTokens: MAX_OUTPUT_TOKENS },
        }),
      });
    } else {
      res = await fetch(`${p.base}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${p.apiKey}`, ...(p.headers || {}) },
        signal: controller.signal,
        body: JSON.stringify({
          model: p.model,
          temperature: 0.3,
          max_tokens: MAX_OUTPUT_TOKENS,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: userPrompt },
          ],
        }),
      });
    }
    if (!res.ok) throw await httpError(res);
    const data = await res.json().catch(() => ({}));
    if (data && data.error) {
      const msg = data.error.message || data.error.type || JSON.stringify(data.error);
      throw new Error(`provider error payload: ${String(msg).replace(/\s+/g, ' ').slice(0, 180)}`);
    }
    const text = stripReasoning(p.kind === 'gemini'
      ? (data?.candidates?.[0]?.content?.parts || []).map((x) => x.text || '').join('').trim()
      : String(data?.choices?.[0]?.message?.content || '').trim());
    if (!text) throw new Error('empty completion');
    // Reject truncated output instead of shipping broken markdown/half-facts.
    // The chain moves on to the next provider/model exactly like any other
    // failure — same fallback path, just a different cause.
    if (wasTruncated(p.kind, data)) {
      throw new Error(`truncated: hit ${MAX_OUTPUT_TOKENS}-token output limit mid-answer`);
    }
    return text;
  } finally {
    clearTimeout(timer);
  }
}

// A quota error is account-wide for a provider/key, so trying its alternate
// model names immediately only adds latency and noisy logs. Keep a short
// in-memory cooldown; a later question can naturally retry it.
const providerCooldowns = new Map();
const PROVIDER_COOLDOWN_MS = 60 * 1000;
const providerCooldownKey = (provider) => `${provider.name}:${provider.kind}`;
const isRateLimited = (message) => /\b429\b|quota exceeded|rate.?limit/i.test(String(message || ''));
const answerCache = new Map();
const ANSWER_CACHE_MS = 2 * 60 * 1000;
function answerCacheKey(question, history = []) {
  const words = norm(question).split(/[^a-z0-9]+/).filter((word) => word.length > 2 && !RAG_STOP.has(word)).sort();
  const prior = norm((history || []).slice(-1)[0]?.question || '').slice(0, 100);
  return `${words.join('|')}::${prior}`;
}

async function tryProviderChain(chain, system, userPrompt, log, extra) {
  for (let i = 0; i < chain.length; i++) {
    const p = chain[i];
    const key = providerCooldownKey(p);
    const retryAt = providerCooldowns.get(key) || 0;
    if (retryAt > Date.now()) {
      log(`provider ${p.name}:${p.model} skipped (rate-limit cooldown) — trying next provider`);
      continue;
    }
    try {
      const text = await callProvider(p, system, userPrompt, extra);
      log(`answered by provider: ${p.name} (model: ${p.model}, position ${i + 1}/${chain.length}${i > 0 ? `, after ${i} fallback${i === 1 ? '' : 's'}` : ''})`);
      return { text, provider: p.name, model: p.model, position: i + 1 };
    } catch (e) {
      const reason = e && e.name === 'AbortError' ? `timeout after ${LLM_TIMEOUT_MS}ms` : (e && e.message) || 'unknown error';
      if (isRateLimited(reason)) providerCooldowns.set(key, Date.now() + PROVIDER_COOLDOWN_MS);
      const nextStep = i + 1 < chain.length ? chain[i + 1] : null;
      const next = nextStep
        ? `— trying next: ${nextStep.name}:${nextStep.model}`
        : '— no providers left, using builtin engine';
      log(`provider ${p.name}:${p.model} failed (${reason}) ${next}`);
    }
  }
  return null;
}

// Accept common typos such as "commmetn" too; this is an evidence lookup so
// being generous here is safer than letting a typo fall into an LLM response.
const CLICKUP_COMMENT_RX = /\bclickup\b.*\bcomm\w*\b|\bcomm\w*\b.*\bclickup\b/i;
const CLICKUP_URL_RX = /https?:\/\/[^\s)]+clickup\.com\/t\/[^\s)]+/i;

function latestClickUpUrlFromHistory(history = []) {
  for (const turn of [...history].reverse()) {
    const links = String(turn?.answer || '').match(new RegExp(CLICKUP_URL_RX.source, 'ig')) || [];
    if (links.length) return links[links.length - 1];
  }
  return '';
}

function requestedMonthName(question) {
  return String(question || '').match(/\b(january|february|march|april|may|june|july|august|september|october|november|december)\b/i)?.[1] || '';
}

// For a named maintenance question, gather every closely matched linked task
// before deciding. A site may have both the maintenance task and a separate
// daily-review/report task, and their comments can explain an apparent sheet
// conflict (for example: report sent, then work later paused).
async function answerClickUpMaintenanceEvidence(question, options = {}) {
  if (CLICKUP_COMMENT_RX.test(String(question || ''))) return null;
  const text = String(question || '');
  const maintenanceQuestion = /\b(maintenance|report|mail|sent|send|done|complete)\b/i.test(text);
  // “I mean in August” inherits maintenance from the immediately preceding
  // question, while keeping the site name from that same chat context.
  const monthFollowUp = Boolean(requestedMonthName(text)) && (options.history || []).slice(-2).some((turn) => /\bmaintenance\b/i.test(String(turn?.question || '')));
  if (!maintenanceQuestion && !monthFollowUp) return null;
  const { findClickUpEvidenceList } = await import('./enterpriseRag.js');
  const evidence = findClickUpEvidenceList(question, options.history || []);
  if (!evidence.length || evidence[0].score < (monthFollowUp ? 6 : 9)) return null;
  const { getClickUpTask, getClickUpTaskComments } = await import('./clickup.js');
  const records = await Promise.all(evidence.map(async (item) => ({
    item,
    task: await getClickUpTask(item.url),
    comments: await getClickUpTaskComments(item.url),
  })));
  const month = requestedMonthName(question);
  const all = records.flatMap((record) => record.comments.map((comment) => ({
    ...comment,
    taskName: record.task?.name || 'Linked task',
    taskUrl: record.task?.url || record.item.url,
  }))).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  const scoped = month ? all.filter((comment) => new RegExp(month, 'i').test(comment.text)) : all;
  const sent = scoped.find((comment) => /\b(sent|send|emailed|mailed)\b/i.test(comment.text));
  const completed = scoped.find((comment) => /\b(completed|complete|done)\b/i.test(comment.text));
  const paused = all.find((comment) => /\b(pause|paused|on hold|non.?payment)\b/i.test(comment.text));
  const inferredMonth = month || sent?.text.match(/\b(january|february|march|april|may|june|july|august|september|october|november|december)\b/i)?.[1] || '';
  const sheetStatuses = records.flatMap((record) => {
    if (!inferredMonth) return [];
    const values = [...String(record.item.chunk.text || '').matchAll(new RegExp(`${inferredMonth}\\s*(?:\\d{2,4})?\\s*:\\s*([^—]+)`, 'ig'))]
      .map((match) => String(match[1] || '').trim());
    return values.length ? [{ values, latest: values[values.length - 1], source: record.item.chunk.text }] : [];
  });
  const latestSheetStatus = sheetStatuses.find((item) => item.latest)?.latest || '';
  const completedInSheet = /updated\s*(?:&|and)\s*backup|completed|done/i.test(latestSheetStatus);
  const label = inferredMonth ? `${inferredMonth[0].toUpperCase()}${inferredMonth.slice(1).toLowerCase()} maintenance` : 'Maintenance status';
  const lines = [`🛠 **${label} — gathered live ClickUp evidence**`, ''];
  if (latestSheetStatus) {
    lines.push(`Maintenance sheet (latest ${inferredMonth} column): **${latestSheetStatus}**.`);
  }
  if (completedInSheet && sent) {
    lines.push('**Maintenance was done, and the maintenance report was sent.**');
    lines.push(`• Completion is confirmed by the maintenance-sheet marker “${latestSheetStatus}”.`);
    lines.push(`• **${sent.createdAt ? sent.createdAt.slice(0, 10) : 'Undated'} · ${sent.author} · ${sent.taskName}:** “${clip(sent.text, 500)}”`);
  } else if (sent) {
    lines.push('**A report-sent comment exists, but the latest maintenance-sheet status is not marked complete.**');
    lines.push(`• **${sent.createdAt ? sent.createdAt.slice(0, 10) : 'Undated'} · ${sent.author} · ${sent.taskName}:** “${clip(sent.text, 500)}”`);
  } else if (completed) {
    lines.push('**Maintenance was completed, but the readable comments do not explicitly confirm that the report was sent.**');
    lines.push(`• **${completed.createdAt ? completed.createdAt.slice(0, 10) : 'Undated'} · ${completed.author} · ${completed.taskName}:** “${clip(completed.text, 500)}”`);
  } else {
    lines.push(`**No linked ClickUp comment explicitly confirms ${month || 'this'} maintenance or report delivery.**`);
  }
  if (paused) {
    lines.push('', '**Important operational note**');
    lines.push(`• **${paused.createdAt ? paused.createdAt.slice(0, 10) : 'Undated'} · ${paused.author} · ${paused.taskName}:** “${clip(paused.text, 400)}”`);
    lines.push('This records a pause for future work; it does not erase a separate report-sent confirmation.');
  }
  lines.push('', '**Linked tasks checked**');
  records.forEach((record) => lines.push(`• ${record.task?.name || 'ClickUp task'} — ${record.task?.status || '—'} — ${record.task?.url || record.item.url}`));
  lines.push('', '_Sources: synchronized Sheets used to find task links, then live read-only ClickUp comments used for the conclusion._');
  return { answer: lines.join('\n'), intent: 'clickup-maintenance-proof', project: null, data: { tasks: records.map((record) => record.task), evidence }, suggestions: ['Show all ClickUp comments', 'Check another maintenance month'], engine: 'clickup' };
}

// Comment questions are evidence requests, not LLM prompts. Resolve the most
// relevant linked task and return its live read-only comment feed directly so
// the assistant cannot invent a comment or mix one website's task with another.
async function answerClickUpCommentQuestion(question, options = {}) {
  const text = String(question || '');
  const maintenanceEvidence = await answerClickUpMaintenanceEvidence(question, options);
  if (maintenanceEvidence) return maintenanceEvidence;
  const asksForComments = CLICKUP_COMMENT_RX.test(text);
  const asksForClickUp = /\bclickup\b/i.test(text);
  const asksForMaintenanceProof = /\b(maintenance|report|mail|sent|send|done|complete)\b/i.test(text);
  const priorTaskUrl = latestClickUpUrlFromHistory(options.history || []);
  // A follow-up such as "August maintenance was sent or not?" should use the
  // task that was just discussed, even when the user does not repeat ClickUp.
  if (!asksForComments && !asksForClickUp && !(priorTaskUrl && asksForMaintenanceProof)) return null;
  let taskUrl = text.match(CLICKUP_URL_RX)?.[0] || priorTaskUrl;
  let evidence = null;
  if (!taskUrl) {
    const { findClickUpEvidence } = await import('./enterpriseRag.js');
    evidence = findClickUpEvidence(question, options.history || []);
    taskUrl = evidence?.url || '';
  }
  if (!taskUrl) return null;
  const { getClickUpTask, getClickUpTaskComments } = await import('./clickup.js');
  const [task, comments] = await Promise.all([getClickUpTask(taskUrl), getClickUpTaskComments(taskUrl)]);
  const month = requestedMonthName(text);
  if (!asksForComments && month) {
    const monthComments = comments.filter((comment) => new RegExp(`\\b${month}\\b`, 'i').test(comment.text));
    const sent = monthComments.find((comment) => /\b(sent|send|emailed|mailed)\b/i.test(comment.text));
    const completed = monthComments.find((comment) => /\b(completed|complete|done)\b/i.test(comment.text));
    const lines = [`🛠 **${month[0].toUpperCase()}${month.slice(1).toLowerCase()} maintenance — live ClickUp evidence**`, ''];
    if (sent) {
      lines.push('**Yes — the maintenance report was sent.**');
      lines.push(`• **${sent.createdAt ? sent.createdAt.slice(0, 10) : 'Undated'} · ${sent.author}:** “${clip(sent.text, 500)}”`);
    } else if (completed) {
      lines.push('**Maintenance was completed, but this task’s readable comments do not explicitly confirm that the report was sent.**');
      lines.push(`• **${completed.createdAt ? completed.createdAt.slice(0, 10) : 'Undated'} · ${completed.author}:** “${clip(completed.text, 500)}”`);
    } else {
      lines.push(`**I found no readable ClickUp comment that explicitly confirms ${month} maintenance or its report was sent.**`);
    }
    if (task) lines.push('', `Current task status: **${task.status || '—'}** _(current status does not change the historical comment evidence)_`);
    lines.push(`Task link: ${task?.url || taskUrl}`, '', '_Source: live read-only ClickUp task comments._');
    return { answer: lines.join('\n'), intent: 'clickup-maintenance-proof', project: null, data: { task, comments: monthComments, source: evidence?.chunk?.metadata || null }, suggestions: ['Show all ClickUp comments', 'Check another maintenance month'], engine: 'clickup' };
  }
  const lines = ['💬 **Live ClickUp comments**', ''];
  if (task) {
    lines.push(`Task: **${task.name || task.id}**`);
    lines.push(`Current status: **${task.status || '—'}**`);
  }
  if (evidence?.chunk?.text) {
    const website = evidence.chunk.text.match(/Website:\s*([^—]+)/i)?.[1]?.trim();
    if (website) lines.push(`Matched website: **${website}**`);
  }
  lines.push(`Task link: ${task?.url || taskUrl}`, '');
  if (!comments.length) lines.push('No readable comments were returned for this task.');
  else {
    lines.push(`**${comments.length} newest comment${comments.length === 1 ? '' : 's'}**`);
    comments.slice(0, 12).forEach((comment) => {
      const date = comment.createdAt ? comment.createdAt.slice(0, 10) : 'undated';
      lines.push(`• **${date} · ${comment.author}** — ${clip(comment.text, 700)}`);
    });
    if (comments.length > 12) lines.push(`…and ${comments.length - 12} older comments available in ClickUp.`);
  }
  lines.push('', '_Source: live read-only ClickUp task comments._');
  return { answer: lines.join('\n'), intent: 'clickup-comments', project: null, data: { task, comments, source: evidence?.chunk?.metadata || null }, suggestions: ['Check the maintenance status', 'Show the linked task'], engine: 'clickup' };
}

/**
 * Main entry: answer a dev-tracker question.
 * Tries the configured LLM provider chain (Gemini → Groq → OpenRouter →
 * Mistral), ALWAYS falls back to the builtin engine. clarify / not-found
 * intents stay deterministic — the LLM is skipped for those on purpose.
 *
 * options.history: optional array of prior turns [{question, answer}, ...]
 * (most recent last) so follow-ups like "give me the list of them" or
 * "what's the feedback there" can resolve against what was actually just
 * discussed. Threaded through to BOTH the builtin engine and the RAG
 * context builder. Purely additive — if omitted, behaves exactly as before.
 */
export async function answerDevQuestion(question, projects, options = {}) {
  const env = options.env || process.env;
  const config = options.config || null;
  const log = options.log || ((...args) => console.log('[dev-assistant]', ...args));
  // Phase 1 is intentionally Sheet-only. The configured ClickUp token does
  // not have space visibility, so no task/comment claim is reliable yet.
  const siteStatus = answerSiteQuestionBuiltin(question, options.sites || [], options.history);
  if (siteStatus) {
    if (siteStatus.data?.clickupUrl) {
      try {
        const { getClickUpTask } = await import('./clickup.js');
        const task = await getClickUpTask(siteStatus.data.clickupUrl);
        if (task) {
          const taskLines = ['', '**Linked ClickUp task**', `Task: **${task.name || task.id}**`, `Status: **${task.status || '—'}**`];
          if (task.assignees.length) taskLines.push(`Assignees: **${task.assignees.join(', ')}**`);
          if (task.dueDate) taskLines.push(`Due date: **${task.dueDate}**`);
          if (task.updatedAt) taskLines.push(`ClickUp updated: **${task.updatedAt.slice(0, 10)}**`);
          taskLines.push(`Task link: ${task.url}`);
          siteStatus.answer += taskLines.join('\n');
          siteStatus.data.clickupTask = task;
        }
      } catch (error) { console.warn('[dev-assistant] ClickUp lookup failed:', error.message); }
    }
    return siteStatus;
  }
  const maintenance = answerMaintenanceQuestionBuiltin(question, options.sites || []);
  if (maintenance) return maintenance;
  // Daily report log bridge — deterministic answers for "who submitted /
  // what did X report / reports for <date>" before anything else runs, so an
  // LLM can never guess a report claim that isn't in the mirror.
  const dailyReports = Array.isArray(options.dailyReports) ? options.dailyReports : [];
  if (dailyReports.length) {
    try {
      const { isReportQuestion, answerReportQuestion } = await import('./reportAutomation.js');
      if (isReportQuestion(question)) {
        const reportAnswer = answerReportQuestion(question, dailyReports, { users: options.reportUsers || [], baseUrl: options.reportBaseUrl || '' });
        if (reportAnswer) return reportAnswer;
      }
    } catch (error) { log('report feed question handler failed:', error.message); }
  }
  const rag = config?.rag || {};
  // "recent" intent stays deterministic-first too when there's no LLM chain,
  // so the builtin answer is already the real date-filtered list rather than
  // the all-time one, even with AI disabled. History is passed through here
  // too so pronoun resolution works even without an LLM configured.
  const rule = answerDevQuestionBuiltin(question, projects, { history: options.history });
  // A route may have just completed a live Sheet/ClickUp investigation. Use
  // that evidence directly instead of spending quota asking a model to
  // paraphrase it and risking an invented operational answer.
  if (options.forceBuiltin) return rule;
  // List-style feedback questions are factual retrieval requests, not prose
  // generation. Keep them deterministic so an LLM cannot reinsert a newer
  // Development entry into a feedback-only answer.
  // A legacy Dev Tracker miss must not hide evidence found in the wider
  // OfficeOS index (maintenance, task-distribution, daily-review, property
  // registry, or SOP sources).  Keep clarification/feedback deterministic,
  // but let a retrieved cross-sheet answer continue to the grounded RAG path.
  const hasEnterpriseEvidence = Boolean(options.enterpriseRag?.chunks?.length);
  const useEnterpriseFallback = rule.intent === 'not-found' && hasEnterpriseEvidence;
  if (rule.intent === 'clarify' || rule.intent === 'feedback' || (rule.intent === 'not-found' && !useEnterpriseFallback)) return rule;
  const chain = buildProviderChain(env, config);
  if (!chain.length) {
    if (useEnterpriseFallback) {
      const { generateGroundedFallback } = await import('./enterpriseRag.js');
      return { answer: generateGroundedFallback(question, options.enterpriseRag), intent: 'rag', project: null, data: { retrieval: options.enterpriseRag }, suggestions: ['Ask about a website, task, maintenance, or SOP'], engine: 'rag-fallback' };
    }
    return rule;
  }
  const cacheKey = answerCacheKey(question, options.history);
  const cached = answerCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    const { recordProviderAnswer } = await import('./assistantMetrics.js');
    const metrics = recordProviderAnswer({ provider: cached.result.provider, position: cached.result.providerPosition, cached: true, inputChars: 0 });
    log(`answer cache hit (${cached.result.provider}); provider fallback trend: ${metrics.fallbackPosition4OrLaterPercent}% served at position 4+ of ${metrics.answers} model answers`);
    return { ...cached.result, cached: true };
  }
  try {
    const ragOpts = {
      rag,
      source: config?.source || null,
      history: options.history,
      // Auto-discovered schema of the assistant's data source (SECTION 5). The
      // caller passes it so this module never has to touch Google directly, and
      // it stays optional — without it the context is exactly as before.
      schemaText: options.schemaText || '',
      // Broad RAG: compact summary from ALL connected sheets (CW, RM, Daily
      // Review, Property Registry, etc.) — passed as SECTION 6 so the LLM can
      // reason across every sheet the project reads, not just the Dev Tracker.
      allSheets: options.allSheets || null,
      // Retrieved SOP / policy text from explicitly configured Google Docs.
      documents: options.documents || null,
      enterpriseRag: options.enterpriseRag || null,
      dailyReports: options.dailyReports || null,
    };
    const ragBuilt = buildRagContext(question, projects, ragOpts);
    const userPrompt = buildUserPrompt(question, projects, ragOpts);
    log(`LLM request budget: ${userPrompt.length} input chars (~${Math.ceil((SYSTEM_PROMPT.length + userPrompt.length) / 4)} tokens including system), ${MAX_OUTPUT_TOKENS} output-token cap`);
    const out = await tryProviderChain(chain, SYSTEM_PROMPT, userPrompt, log, { question, projects });
    if (out) {
      if (rag.verifyNumbers !== false) {
        const check = verifyGrounded(out.text, ragBuilt.context);
        if (!check.ok) {
          log(`⚠ ungrounded numbers ${JSON.stringify(check.ungrounded)} from ${out.provider} — ${rag.strictGrounding === false ? 'kept (strict grounding off)' : 'discarded, using verified builtin answer'}`);
          if (rag.strictGrounding !== false) {
            return { ...rule, engine: 'builtin', grounding: { ok: false, ungrounded: check.ungrounded, provider: out.provider } };
          }
        }
      }
      const result = { ...rule, intent: useEnterpriseFallback ? 'rag' : rule.intent, answer: out.text, engine: 'llm', provider: out.provider, providerModel: out.model, providerPosition: out.position };
      answerCache.set(cacheKey, { expiresAt: Date.now() + ANSWER_CACHE_MS, result });
      const { recordProviderAnswer } = await import('./assistantMetrics.js');
      const metrics = recordProviderAnswer({ provider: out.provider, position: out.position, inputChars: userPrompt.length });
      log(`provider metrics: ${metrics.fallbackPosition4OrLaterPercent}% served at fallback position 4+ (${metrics.fallbackPosition4OrLater}/${metrics.answers} model answers, avg input ${metrics.averageInputChars} chars)`);
      if (options.debug) {
        result.retrieval = { evidenceCount: ragBuilt.evidenceCount, matchedProject: ragBuilt.matchedProject, contextChars: ragBuilt.context.length };
      }
      return result;
    }
  } catch (e) {
    log(`llm chain error: ${e.message} — using builtin engine`);
  }
  if (useEnterpriseFallback) {
    const { generateGroundedFallback } = await import('./enterpriseRag.js');
    return { answer: generateGroundedFallback(question, options.enterpriseRag), intent: 'rag', project: null, data: { retrieval: options.enterpriseRag }, suggestions: ['Ask about a website, task, maintenance, or SOP'], engine: 'rag-fallback' };
  }
  return rule;
}

/**
 * Live-test ONE provider (used by the superadmin AI Settings dashboard).
 * Sends a tiny prompt and reports status/latency/model/error verbatim.
 */
export async function testProvider(name, env = process.env, config = null) {
  const settings = resolveProviderSettings(env, config).find((s) => s.name === name);
  if (!settings) return { provider: name, ok: false, message: `unknown provider "${name}"` };
  if (!settings.configured) return { provider: name, ok: false, message: `not configured (${settings.skipReason || 'missing key'})` };
  const models = Array.isArray(settings.models) ? settings.models : [settings.models];
  const attempts = [];
  for (const model of models) {
    const p = settings.kind === 'worker'
      ? { name, kind: 'worker', apiKey: settings.apiKey, model, base: settings.base }
      : {
        name, kind: settings.kind, apiKey: settings.apiKey, model, base: settings.base,
        headers: name === 'openrouter' ? { 'HTTP-Referer': 'https://officeos.local', 'X-Title': 'OfficeOS Dev Assistant' } : undefined
      };
    const t0 = Date.now();
    try {
      const text = await callProvider(p, 'You are a connectivity probe. Reply with exactly: OK', 'Reply with exactly: OK', { question: 'ping', projects: [] });
      const ms = Date.now() - t0;
      attempts.push({ model, ok: true, ms, sample: String(text).slice(0, 120) });
      return { provider: name, ok: true, model, ms, message: `OK (${ms}ms)`, sample: String(text).slice(0, 120), attempts };
    } catch (e) {
      const ms = Date.now() - t0;
      const msg = e && e.name === 'AbortError' ? `timeout after ${LLM_TIMEOUT_MS}ms` : (e && e.message) || 'unknown error';
      attempts.push({ model, ok: false, ms, error: msg });
    }
  }
  return { provider: name, ok: false, message: attempts[attempts.length - 1]?.error || 'all models failed', attempts };
}
