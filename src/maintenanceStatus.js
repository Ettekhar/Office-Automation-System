/**
 * maintenanceStatus.js - the maintenance-state vocabulary, with NO dependencies.
 *
 * WHY A SEPARATE MODULE
 * ---------------------
 * These two functions used to live in sheets.js, which imports `googleapis` and
 * `google-auth-library` at the top. server.js therefore could not import them
 * statically - it reaches sheets.js through a dynamic import, and once a missing
 * import there silently killed every Daily Review write. The rank guard the
 * reconcile path needs is exactly the kind of thing that must not depend on a
 * heavy module loading correctly.
 *
 * So the vocabulary lives here, dependency-free, and sheets.js re-exports it.
 * There is still exactly ONE implementation of each function; sheets.js's
 * exports are aliases, not copies.
 *
 * The vocabulary itself (Completed / In Progress / To Do, "higher wins") was
 * confirmed by the team on 2026-09-26.
 */

const MAINTENANCE_DONE_WORDS = new Set([
  'completed', 'complete', 'done', 'updated & backup', 'updated and backup', 'updated&backup',
]);

/**
 * normalizeMaintenanceStatusText - fold every spelling of a maintenance state
 * onto ONE canonical label, so the tabs stop disagreeing with themselves.
 *
 * "Updated & Backup" and "Completed" mean the same thing (confirmed by the
 * team 2026-09-26), and "Completed" is the wording they prefer, so the
 * account-sheet phrasing is folded onto it. Casing is fixed at the same time
 * ("inprogress" -> "In Progress"), which is what makes two cells that already
 * agree stop looking like a conflict.
 *
 * Unrecognized wording is returned VERBATIM. Normalization must never invent a
 * status for text it does not understand.
 */
export function normalizeMaintenanceStatusText(v) {
  const s = String(v ?? '').trim();
  if (!s) return '';
  const k = s.toLowerCase().replace(/\s+/g, ' ').trim();
  if (MAINTENANCE_DONE_WORDS.has(k)) return 'Completed';
  if (k === 'in_progress' || k === 'in progress' || k === 'inprogress') return 'In Progress';
  if (k === 'to do' || k === 'todo' || k === 'to-do') return 'To Do';
  if (k === 'pending') return 'Pending';
  return s;
}

/**
 * maintenanceStatusRank - how far along a maintenance state is, used to resolve
 * a disagreement WITHOUT ever silently downgrading work. "Higher wins" means a
 * cell that already says Completed is never overwritten with To Do just because
 * the database happens to be behind.
 *
 * Unknown wording ranks 0 (i.e. "no opinion"), so an unrecognized value is
 * preserved rather than replaced by a guess. Blank is also 0, which is what
 * makes "an empty source must not overwrite recorded work" fall out for free.
 */
export function maintenanceStatusRank(v) {
  switch (normalizeMaintenanceStatusText(v)) {
    case 'Completed': return 3;
    case 'In Progress': return 2;
    case 'Pending': return 2;
    case 'To Do': return 1;
    default: return 0;
  }
}

export { MAINTENANCE_DONE_WORDS };

// ═══════════════════════════════════════════════════════════════════════════════
// MONTH MATCHING
//
// The reconcile path asks "what does the CW/RM sheet say about <month>?" and
// pushes that answer into the Daily Review tabs. Getting the MONTH wrong is
// therefore not a display bug, it is a data-loss bug.
//
// The lookup used to be:
//
//   find(h => h.month === m)                       exact
//   || find(h => h.month.includes(m))              label contains query
//   || find(h => m.includes(h.month))              query contains label
//
// Two things go wrong with that:
//
//  1. Query "sep" has no exact match, so `h.month.includes("sep")` matched
//     "September 22" - a 2022 entry whose status is empty. Empty was then read
//     as "not done", and the writer stamped "To Do" over a cell that said
//     "Updated & Backup". Real, measured: rank 3 -> rank 1 on five Taion rows,
//     with 42 rows exposed across short month strings.
//  2. The last fallback is `m.includes(h.month)`, and "anything".includes("")
//     is true, so an entry with a missing month label matched EVERY query.
//
// The matcher below is strict on purpose. When in doubt it returns null, and a
// null result means "leave the row alone" - which is always safe, because not
// reconciling costs nothing whereas reconciling against the wrong month
// overwrites somebody's work.
// ═══════════════════════════════════════════════════════════════════════════════

// Only unambiguous short forms. Deliberately excludes "jun"/"jul"/"mar" and
// friends where a typo like "Januar" could collide; "sept" is included because
// "sep" and "sept" are both common and unambiguous.
const MONTH_ALIASES = new Map(Object.entries({
  jan: 'january', january: 'january',
  feb: 'february', february: 'february',
  mar: 'march', march: 'march',
  apr: 'april', april: 'april',
  may: 'may',
  jun: 'june', june: 'june',
  jul: 'july', july: 'july',
  aug: 'august', august: 'august',
  sep: 'september', sept: 'september', september: 'september',
  oct: 'october', october: 'october',
  nov: 'november', november: 'november',
  dec: 'december', december: 'december',
}));

/**
 * Split a month label into its month name and optional year, so "September 26",
 * "september 2026" and "2026-09" can be compared as the same period.
 *
 * Returns { name, year } with year === null when the label carries no year.
 * Returns null when the label is empty or has no recognisable month name -
 * such a label must never match anything, which is what stops the
 * `includes("")` landmine.
 */
export function parseMonthLabel(label) {
  const raw = String(label ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
  if (!raw) return null;

  // Numeric form: 2026-09, 2026/9, 09-2026
  const num = raw.match(/^(\d{4})[-\/.](\d{1,2})(?:[-\/.]\d{1,2})?$/) || raw.match(/^(\d{1,2})[-\/.](\d{4})$/);
  if (num) {
    const a = Number(num[1]), b = Number(num[2]);
    const year = a > 31 ? a : b;
    const mon = a > 31 ? b : a;
    if (mon >= 1 && mon <= 12) {
      return { name: MONTH_ALIASES.get(['', 'january','february','march','april','may','june','july','august','september','october','november','december'][mon]), year: String(year) };
    }
    return null;
  }

  // Word form, with an optional trailing 2- or 4-digit year:
  // "september", "september 26", "september 2026", "february24" (no space).
  const m = raw.match(/^([a-z]+)\s*['.,-]?\s*(\d{2,4})?$/);
  if (!m) return null;
  const name = MONTH_ALIASES.get(m[1]);
  if (!name) return null;                       // "Augus", "octobor" -> no match
  let year = m[2] || null;
  if (year) {
    if (year.length === 4) year = year;         // "2026"
    else year = `20${year}`;                    // "26" -> "2026"
  }
  return { name, year };
}

/**
 * Find the monthlyHistory entry for `month`, strictly.
 *
 * Preference order, best first:
 *   1. exact label match
 *   2. same month name AND same year
 *   3. same month name, neither side carrying a year ("sep" -> "September")
 *   4. same month name, query carries a year and the entry does not
 *      ("September 26" is satisfied by a bare "September")
 *
 * The exclusion that matters is the one case NOT listed: a year-qualified entry
 * may never satisfy a bare query, because a bare query carries no year and so
 * cannot be known to mean that entry. That single exclusion is what stops "sep"
 * from reaching "September 22" and blanking a completed cell.
 *
 * Returns null when nothing matches, and callers must treat null as "leave the
 * row untouched".
 */
export function findMonthlyHistoryEntry(history, month) {
  const list = Array.isArray(history) ? history : [];
  const wantLabel = String(month ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
  if (!wantLabel) return null;

  const exact = list.find((h) => String((h && h.month) ?? '').trim().toLowerCase().replace(/\s+/g, ' ') === wantLabel);
  if (exact) return exact;

  const want = parseMonthLabel(wantLabel);
  if (!want) return null;                        // unparseable query: touch nothing

  for (const h of list) {
    const got = parseMonthLabel(h && h.month);
    if (!got || got.name !== want.name) continue;
    if (got.year && want.year && got.year === want.year) return h;   // rule 2
  }
  // Both sides carry no year: "sep" is a legitimate short form of a bare
  // "September", and neither side claims to be about a particular year, so
  // they describe the same period. Safe, and necessary - without it every
  // abbreviated query would silently stop resolving.
  if (!want.year) {
    for (const h of list) {
      const got = parseMonthLabel(h && h.month);
      if (got && got.name === want.name && !got.year) return h;
    }
  }
  if (want.year) {
    for (const h of list) {
      const got = parseMonthLabel(h && h.month);
      if (got && got.name === want.name && !got.year) return h;       // rule 3
    }
  }
  return null;
}

/**
 * Decide whether a reconcile value may be written over what a cell already
 * holds. "Higher wins", never a downgrade.
 *
 * Returns { write: true } to proceed, or { write: false, reason } to keep the
 * existing value. Keeping is always the safe outcome: not reconciling costs a
 * stale-looking cell, while reconciling wrongly costs recorded work.
 */
export function shouldWriteReconciledStatus({ incomingRaw, incomingStatus, currentRaw, currentStatus } = {}) {
  const inRaw = String(incomingRaw ?? '').trim();
  const curRaw = String(currentRaw ?? '').trim();
  if (curRaw && inRaw && curRaw.toLowerCase() === inRaw.toLowerCase()) {
    return { write: false, reason: 'already-equal' };
  }
  // An empty source carries no information. It must never be read as "not done".
  if (!inRaw && !incomingStatus) {
    return { write: false, reason: curRaw ? 'empty-source-would-downgrade' : 'empty-source-no-op' };
  }
  const from = maintenanceStatusRank(curRaw || currentStatus);
  const to = maintenanceStatusRank(inRaw || incomingStatus);
  if (to === 0) return { write: false, reason: 'unrecognised-incoming-value' };
  if (to < from) {
    return { write: false, reason: 'downgrade-refused', from, to };
  }
  return { write: true, from, to };
}
