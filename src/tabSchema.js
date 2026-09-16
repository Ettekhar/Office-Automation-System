/**
 * tabSchema.js — the single "understand ANY sheet" layer.
 *
 * WHY THIS EXISTS
 * ───────────────
 * Every sheet the project reads has grown columns over time, and the sheets do
 * NOT share one layout:
 *
 *   CW "Website List"   A=status  B=CMS  C=Company  D=Contact  E=A/C Manager
 *                       F=Note  G=Website URL  H=ClickUp  I=Report URL
 *                       J=Backup URL  K…=month columns          (11+ cols)
 *   RM "Website List"   A=status  B=CMS  C=Company  D=Contact  E=A/C Manager
 *                       F=Website URL  G=ClickUp  H…=month columns (8+ cols)
 *   Dev Tracker tabs    TWO layouts coexist: OLD 5-col (A=URL B=Status
 *                       C=Feedbacks URL D=Date E=Note/Updates) and NEW 7-col
 *                       (A=URL B=Status C=Development-Date D=Development-Updates
 *                       E=Feedbacks URL F=Feedback-Date G=Feedback-Notes)
 *
 * Hardcoding positions broke every time a column was inserted, so this module
 * resolves each field from the tab's OWN HEADER ROW instead. Anything it does
 * not recognise is kept as an "extra" column (key + label + kind + index) so a
 * hand-added column — "QA Check", "SEO Notes", a new "Backup Date" — is read,
 * written, displayed and answerable by the chatbot without touching any code.
 *
 * CONTRACT
 * ────────
 *  • resolveColumns(headerRow, { profile }) → { <field>: index, extras: [...] }
 *  • Profiles (`maintenance`, `devTracker`, `generic`) describe the known field
 *    names + aliases; headers are matched with scoring, so a field is claimed
 *    by its best match and no header is ever claimed twice.
 *  • Purely functional, no I/O, no Google API — safe to unit-test offline.
 */

// ── 1. Header normalisation ──────────────────────────────────────────────────

/**
 * Normalise a header cell for comparison: lowercase, every run of
 * non-alphanumerics collapsed to a single space, trimmed.
 *   'A/C Manager'               → 'a c manager'
 *   'Feedbacks -- Note/Updates' → 'feedbacks note updates'
 */
export function headerKey(cell) {
  return String(cell ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Human-friendly label for a raw header (used for extra columns).
 * Keeps existing acronyms, otherwise title-cases each word.
 *   'devDate'           → 'Dev Date'
 *   'development--date' → 'Development Date'
 *   'Export URL'        → 'Export URL'
 */
export function prettyHeader(label) {
  const raw = String(label ?? '')
    .replace(/[\u200B-\u200D\uFEFF]/g, '') // strip zero-width characters
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!raw) return '';
  return raw
    .split(' ')
    .map((w) => (w.length > 1 && w === w.toUpperCase() ? w : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(' ');
}

/**
 * Stable, unique, code-friendly key for a header (used as the object key of an
 * extra column). Space-free camelCase, de-duplicated with a numeric suffix.
 *   columnKey('QA Check', 7)                       → 'qaCheck'
 *   columnKey('QA Check', 9, new Set(['qaCheck'])) → 'qaCheck2'
 */
export function columnKey(header, index = 0, used = null) {
  const words = headerKey(prettyHeader(header) || header).split(' ').filter(Boolean);
  let base = words.length
    ? words[0] + words.slice(1).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join('')
    : `column${index + 1}`;
  if (/^[0-9]/.test(base)) base = `col${base}`;
  if (!used || typeof used.has !== 'function') return base;
  let key = base;
  let n = 2;
  while (used.has(key)) key = `${base}${n++}`;
  used.add(key);
  return key;
}

/** Coarse data type of a column, inferred from its header text (UI hint only). */
export function inferColumnKind(label) {
  const k = headerKey(label);
  if (!k) return 'text';
  if (/(^|\s)(url|link|website|site|domain|href|doc)(\s|$)/.test(k)) return 'url';
  if (/(^|\s)(email|e mail|mail)(\s|$)/.test(k)) return 'email';
  if (/(^|\s)(date|dates|day|deadline|due|expiry|expiration|expire|month|year)\b/.test(k)) return 'date';
  if (/(^|\s)(status|state|stage|priority|progress)\b/.test(k)) return 'status';
  if (/(^|\s)(hours|hour|spend|amount|total|count|qty|quantity|number|no|budget|price|cost|score|percent|percentage)\b/.test(k)) return 'number';
  if (/(^|\s)(note|notes|comment|comments|update|updates|description|details|summary|remarks|blocker|blockers|feedback)\b/.test(k)) return 'longtext';
  return 'text';
}

// ── 2. Month columns ────────────────────────────────────────────────────────
// Master tabs append one column per maintenance month ("March 22", "August",
// "February24", "Augus 23", "octobor" — typos are common in the live sheets).
// A month column is therefore matched by the first three letters of a month
// name, optionally followed by a year.

const MONTH_ABBR = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const MONTH_FULL = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
];

/**
 * Detect a month column header.
 * Returns { monthIndex, monthName, abbr, year } or null.
 * `year` is null when the header carries no year (the caller then infers it
 * from the preceding column — never from the system clock).
 */
export function monthHeaderInfo(label) {
  const k = headerKey(label);
  if (!k) return null;
  const m = /^([a-z]{3,12})[\s.]*(\d{2,4})?$/.exec(k);
  if (!m) return null;
  const word = m[1];
  const mi = MONTH_ABBR.indexOf(word.slice(0, 3));
  if (mi === -1) return null;
  // Reject a longer word that is not actually (a typo of) that month's name,
  // e.g. 'marketing' must never be read as 'mar' + something.
  if (word.length > 3) {
    const keep = Math.min(word.length, 4);
    if (MONTH_FULL[mi].slice(0, keep) !== word.slice(0, keep)) return null;
  }
  let year = m[2] ? Number(m[2]) : null;
  if (year !== null && year < 100) year += 2000;
  return { monthIndex: mi, monthName: MONTH_FULL[mi], abbr: word.slice(0, 3), year };
}

/** True when a header cell is a maintenance month column. */
export function isMonthHeader(label) {
  return monthHeaderInfo(label) !== null;
}

/** Every month column in a header row, left → right, with its resolved info. */
export function monthColumns(headerRow = []) {
  const out = [];
  (Array.isArray(headerRow) ? headerRow : []).forEach((label, index) => {
    const info = monthHeaderInfo(label);
    if (info) out.push({ index, label: String(label ?? '').trim(), ...info });
  });
  return out;
}
// ── 3. Field profiles ───────────────────────────────────────────────────────
// Each field: { key, label, kind, aliases, exactAliases, prefixAliases,
//               fixedIndex, skipIndexes, required, fallback }
//   aliases        substring match on the normalised header (long aliases only)
//   exactAliases   normalised header must EQUAL the alias
//   prefixAliases  normalised header must START WITH the alias (the bare
//                  "Date" / "Note" columns of the OLD dev-tracker layout)
//   fixedIndex     "this field lives in column N of this sheet" convention
//   skipIndexes    columns that must never be claimed by this field
//   required       at least one of the profile's required fields must resolve,
//                  otherwise the profile is considered a poor fit
//   fallback       tried only when no other column could claim the field

export const FIELD_PROFILES = {
  /**
   * CW / RM "Website List" master tab (maintenance tracker).
   * Verified live 2026-09-15:
   *   CW row 2: Note: | CMS | Company | Contact | A/C Manager | Note |
   *             Website URL | Maintenance Task ClickUp URL |
   *             Maintenance Report URL | Backup URL | March 22 | …
   *   RM row 2: (blank) | CMS | Company | Contact | A/C Manager |
   *             Website URL | Maintenance Task ClickUp Link | March 22 | …
   * Column A is the Status/Active column by convention; its header is either
   * blank or mislabelled ("Note:"), hence the fixed index.
   */
  maintenance: {
    label: 'Website List (maintenance tracker)',
    fields: [
      {
        key: 'status', label: 'Status', kind: 'status', fixedIndex: 0, required: true,
        exactAliases: ['status', 'state', 'active', 'activation status', 'active status'],
        aliases: ['status', 'active status'],
      },
      {
        key: 'cms', label: 'CMS', kind: 'text',
        exactAliases: ['cms', 'c m s', 'platform'], aliases: ['cms'],
      },
      {
        key: 'company', label: 'Company', kind: 'text',
        exactAliases: ['company', 'company name', 'client', 'client name', 'business', 'business name'],
        aliases: ['company name'],
      },
      {
        key: 'contact', label: 'Contact', kind: 'email',
        exactAliases: ['contact', 'contacts', 'contact email', 'client email', 'email'],
        aliases: ['contact'],
      },
      {
        key: 'accountManager', label: 'A/C Manager', kind: 'text',
        exactAliases: ['a c manager', 'ac manager', 'account manager', 'am', 'manager'],
        aliases: ['manager'],
      },
      {
        // `skipIndexes: [0]` is deliberate: column A's header is literally
        // "Note:" in the live CW sheet and must never be read as the note.
        key: 'note', label: 'Note', kind: 'longtext', skipIndexes: [0],
        exactAliases: ['note', 'notes', 'remark', 'remarks', 'client note', 'client notes'],
        aliases: ['client note'],
      },
      {
        key: 'websiteUrl', label: 'Website URL', kind: 'url', required: true,
        exactAliases: ['website', 'website url', 'web url', 'site url', 'site'],
        aliases: ['website url', 'website'],
        fallback: { exactAliases: ['url', 'urls', 'domain', 'domain name', 'website domain'] },
      },
      {
        key: 'clickupUrl', label: 'ClickUp URL', kind: 'url',
        exactAliases: ['clickup', 'clickup url', 'clickup link', 'task clickup'],
        aliases: ['clickup'],
      },
      {
        key: 'reportUrl', label: 'Report URL', kind: 'url',
        exactAliases: ['report url', 'report link', 'maintenance report url', 'maintenance report link'],
        aliases: ['report url', 'report link'],
      },
      {
        key: 'backupUrl', label: 'Backup URL', kind: 'url',
        exactAliases: ['backup url', 'backup link', 'backup'],
        aliases: ['backup url', 'backup link'],
      },
      {
        key: 'domainExpiry', label: 'Domain Expiry', kind: 'date',
        exactAliases: ['domain expire date', 'domain expiry date', 'domain expiration date', 'domain expiry'],
        aliases: ['expire date', 'expiry date', 'expiration date'],
      },
      {
        key: 'backupDate', label: 'Backup Date', kind: 'date',
        exactAliases: ['backup date', 'last backup', 'backup last date'],
        aliases: ['backup date'],
      },
    ],
  },

  /**
   * Dev Tracker tab — the OLD 5-column and NEW 7-column layouts both resolve
   * here. The specific "feedback …" aliases are tried BEFORE the generic
   * "Date" / "Note" fallbacks so "Development-Date" can never be mistaken for
   * the feedback date column.
   */
  devTracker: {
    label: 'Dev Tracker (per-project tab)',
    fields: [
      {
        key: 'url', label: 'URL', kind: 'url', required: true,
        exactAliases: ['url', 'page url', 'page', 'website', 'link'],
        aliases: ['url'],
      },
      {
        key: 'status', label: 'Status', kind: 'status', required: true,
        exactAliases: ['status', 'state', 'stage'], aliases: ['status'],
      },
      {
        key: 'devDate', label: 'Development-Date', kind: 'date',
        exactAliases: ['development date', 'dev date', 'development dates', 'dev dates'],
        aliases: ['development date', 'dev date'],
      },
      {
        key: 'devNotes', label: 'Development-Updates', kind: 'longtext',
        exactAliases: ['development updates', 'development update', 'development notes', 'development note',
          'dev updates', 'dev update', 'dev notes', 'dev note'],
        aliases: ['development update', 'development note', 'dev update', 'dev note'],
      },
      {
        key: 'feedbackUrl', label: 'Feedback URL', kind: 'url',
        exactAliases: ['feedback url', 'feedbacks url', 'feedback link', 'feedbacks link', 'feedback doc',
          'feedback file', 'feedbacks doc'],
        aliases: ['feedback url', 'feedbacks url', 'feedback link', 'feedbacks link', 'feedback doc'],
      },
      {
        key: 'date', label: 'Feedback-Date', kind: 'date',
        exactAliases: ['feedback date', 'feedbacks date', 'feedback dates', 'feedbacks dates'],
        aliases: ['feedback date', 'feedbacks date'],
        // OLD layout: the column is simply called "Date".
        fallback: { exactAliases: ['date', 'dates'] },
      },
      {
        key: 'notes', label: 'Feedback-Notes', kind: 'longtext',
        exactAliases: ['feedback note', 'feedbacks note', 'feedback notes', 'feedbacks notes',
          'feedback update', 'feedbacks update', 'feedback updates', 'feedbacks updates'],
        aliases: ['feedback note', 'feedbacks note', 'feedback update', 'feedbacks update'],
        // OLD layout: "Note/Updates" → prefix match, exactly like the previous
        // /^notes?\b/ regex used by resolveDevTrackerColumns().
        fallback: { prefixAliases: ['note', 'notes'] },
      },
    ],
  },

  /**
   * Anything else — a brand-new sheet someone connects tomorrow. Generic field
   * names only (url / status / name / contact / date / notes); every other
   * header stays available as an extra column.
   */
  generic: {
    label: 'Generic sheet',
    fields: [
      { key: 'url', label: 'URL', kind: 'url', exactAliases: ['url', 'link', 'website'], aliases: ['url', 'link', 'website'] },
      { key: 'status', label: 'Status', kind: 'status', exactAliases: ['status', 'state', 'stage'], aliases: ['status'] },
      { key: 'name', label: 'Name', kind: 'text', exactAliases: ['name', 'title', 'project', 'company', 'client'], aliases: ['name', 'title'] },
      { key: 'contact', label: 'Contact', kind: 'email', exactAliases: ['contact', 'email', 'owner', 'assignee'], aliases: ['contact', 'email', 'owner', 'assignee'] },
      { key: 'date', label: 'Date', kind: 'date', exactAliases: ['date', 'dates', 'due date', 'created', 'updated'], aliases: ['date', 'due'] },
      { key: 'notes', label: 'Notes', kind: 'longtext', exactAliases: ['notes', 'note', 'comment', 'comments', 'description', 'details'], aliases: ['note', 'comment', 'description', 'details'] },
    ],
  },
};

/** Profile names in the order they are tried when auto-detecting a sheet. */
export const PROFILE_ORDER = ['maintenance', 'devTracker', 'generic'];

// ─ 4. Resolver engine ─────────────────────────────────────────────────────

const SCORE = { exact: 30, substring: 20, fixed: 10, fallbackExact: 5, fallbackPrefix: 4 };

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Does one alias match one header cell?
 *  - exact     → normalised equality (or raw equality, tolerating punctuation)
 *  - prefix    → normalised header starts with the alias at a word boundary
 *  - otherwise → substring, but short aliases only match a WHOLE WORD so
 *    "am" never matches "camera" while "url" still matches "page url".
 */
function aliasMatches(norm, rawLower, alias, mode) {
  const na = headerKey(alias);
  if (!na) return false;
  if (mode === 'exact') return norm === na || rawLower === String(alias).toLowerCase().trim();
  if (mode === 'prefix') return norm === na || norm.startsWith(`${na} `);
  if (na.length <= 3) return new RegExp(`(^| )${escapeRe(na)}( |$)`).test(norm);
  return norm.includes(na);
}

/**
 * Every match of every field against a header row.
 * `round` is 'primary' (aliases + fixed index) or 'fallback' (the generic
 * "Date" / "Note" columns of the old layouts, used only for fields that no
 * alias could claim).
 */
function collectCandidates(cells, profile, { round = 'primary' } = {}) {
  const out = [];
  profile.fields.forEach((field, fieldOrder) => {
    const skip = new Set(field.skipIndexes || []);
    for (let col = 0; col < cells.length; col++) {
      if (skip.has(col)) continue;
      // A convention column (fixedIndex) is claimable even when its header is
      // blank — the RM master tab has no header at all on column A, yet that
      // column is still the Status/Active column.
      if (round === 'primary' && field.fixedIndex === col) {
        out.push({ fieldKey: field.key, fieldOrder, col, score: SCORE.fixed });
      }
      const norm = headerKey(cells[col]);
      if (!norm) continue;
      const rawLower = String(cells[col] ?? '').toLowerCase();
      const push = (score) => out.push({ fieldKey: field.key, fieldOrder, col, score });

      if (round === 'primary') {
        const exact = (field.exactAliases || []).some((a) => aliasMatches(norm, rawLower, a, 'exact'));
        if (exact) push(SCORE.exact);
        else if ((field.aliases || []).some((a) => aliasMatches(norm, rawLower, a, 'substring'))) push(SCORE.substring);
      } else if (field.fallback) {
        if ((field.fallback.exactAliases || []).some((a) => aliasMatches(norm, rawLower, a, 'exact'))) push(SCORE.fallbackExact);
        else if ((field.fallback.prefixAliases || []).some((a) => aliasMatches(norm, rawLower, a, 'prefix'))) push(SCORE.fallbackPrefix);
      }
    }
  });
  return out;
}

/**
 * Greedy best-match assignment: highest score wins; ties break by field order
 * (profile order = importance) then left-to-right column order. A header column
 * and a field are each claimed at most once, so inserting a column in the middle
 * can never steal another field's index.
 */
function assignIndexes(cells, profile) {
  const indexes = {};
  const matched = {};
  const usedCols = new Set();
  const claimed = new Set();

  const run = (candidates) => {
    candidates
      .sort((a, b) => (b.score - a.score) || (a.fieldOrder - b.fieldOrder) || (a.col - b.col))
      .forEach((c) => {
        if (claimed.has(c.fieldKey) || usedCols.has(c.col)) return;
        claimed.add(c.fieldKey);
        usedCols.add(c.col);
        indexes[c.fieldKey] = c.col;
        matched[c.fieldKey] = { index: c.col, score: c.score, header: String(cells[c.col] ?? '').trim() };
      });
  };

  run(collectCandidates(cells, profile));
  run(collectCandidates(cells, profile, { round: 'fallback' }));

  profile.fields.forEach((f) => {
    if (!(f.key in indexes)) indexes[f.key] = -1;
  });
  return { indexes, matched, usedCols };
}

/** How well a profile fits a header row (used for auto-detection). */
export function scoreProfile(headerRow = [], profileName) {
  const profile = FIELD_PROFILES[profileName];
  if (!profile) return { score: 0, matched: [], required: 0, requiredNeeded: 0 };
  const cells = Array.isArray(headerRow) ? headerRow : [];
  const { indexes, matched } = assignIndexes(cells, profile);
  const matchedFields = Object.keys(matched);
  const requiredFields = profile.fields.filter((f) => f.required);
  // A required field also counts as present when it came from a convention
  // (fixedIndex) rather than from a header label — e.g. the RM master tab has
  // NO header on column A, but column A is still the Status column.
  const required = requiredFields.filter((f) => (indexes[f.key] ?? -1) >= 0).length;
  // An exact-alias hit counts double: it is what makes a sheet identifiable.
  const score = matchedFields.reduce((n, k) => n + (matched[k].score >= SCORE.exact ? 2 : 1), 0);
  return { score, matched: matchedFields, required, requiredNeeded: requiredFields.length };
}

/**
 * Pick the profile that best explains a header row. `tabName` is only a hint
 * (e.g. "Website List" → maintenance). Falls back to 'generic', which still
 * maps url/status/date/notes and keeps everything else as extra columns.
 */
export function resolveProfile(headerRow = [], tabName = '') {
  const name = headerKey(tabName);
  let best = { name: 'generic', score: 0 };
  for (const p of PROFILE_ORDER) {
    const s = scoreProfile(headerRow, p);
    // Viable = explains at least two columns with every required field present.
    if (s.score < 2 || s.required !== s.requiredNeeded) continue;
    let bonus = 0;
    if (p === 'maintenance' && /website list|maintenance|master/.test(name)) bonus = 3;
    if (p === 'devTracker' && /dev|tracker|feedback|project/.test(name)) bonus = 2;
    if (p !== 'generic' && s.score + bonus > best.score) best = { name: p, score: s.score + bonus };
  }
  return best.name;
}

/** Extra-column descriptors for every header the profile did not claim. */
export function buildExtras(cells, usedCols) {
  const usedKeys = new Set();
  const extras = [];
  (Array.isArray(cells) ? cells : []).forEach((label, index) => {
    if (usedCols.has(index)) return;
    const raw = String(label ?? '').trim();
    if (!raw) return;
    extras.push({
      key: columnKey(raw, index, usedKeys),
      label: prettyHeader(raw),
      index,
      kind: inferColumnKind(raw),
    });
  });
  return extras;
}

/**
 * Resolve a header row into field indexes + extra columns.
 *
 * @param {string[]} headerRow
 * @param {{ profile?: string, includeExtras?: boolean, tabName?: string }} opts
 * @returns {{ profile: string, [field: string]: number|any, extras: Array, headers: string[] }}
 */
export function resolveColumns(headerRow = [], opts = {}) {
  const cells = Array.isArray(headerRow) ? headerRow : [];
  const requested = String(opts.profile || 'auto');
  const profileName = requested === 'auto'
    ? resolveProfile(cells, opts.tabName || '')
    : (FIELD_PROFILES[requested] ? requested : 'generic');
  const profile = FIELD_PROFILES[profileName];
  const { indexes, matched, usedCols } = assignIndexes(cells, profile);

  // Month columns of a master tab are a KNOWN, first-class concept (the whole
  // maintenance/month timeline works off them) — never reported as extras.
  const months = opts.detectMonths === false ? [] : monthColumns(cells);
  const extraSkip = new Set(usedCols);
  if (opts.monthsAsExtras !== true) months.forEach((m) => extraSkip.add(m.index));

  const out = {
    profile: profileName,
    headers: cells.map((c) => String(c ?? '').trim()),
    matched,
    months,
    extras: opts.includeExtras === false ? [] : buildExtras(cells, extraSkip),
  };
  for (const [key, index] of Object.entries(indexes)) out[key] = index;
  return out;
}

/** Field descriptors ({key,label,index,kind}) a profile resolved for a tab. */
export function describeColumns(cols, { includeExtras = true } = {}) {
  const profile = FIELD_PROFILES[cols?.profile] || null;
  const fields = [];
  for (const f of profile?.fields || []) {
    const index = cols?.[f.key];
    if (typeof index === 'number' && index >= 0) {
      fields.push({ key: f.key, label: f.label || prettyHeader(f.key), index, kind: f.kind || 'text', extra: false });
    }
  }
  if (includeExtras) {
    for (const e of cols?.extras || []) fields.push({ ...e, extra: true });
  }
  return fields.sort((a, b) => a.index - b.index);
}

/** One-line, human-readable description of a resolved layout (chatbot / logs). */
export function describeColumnsText(cols) {
  const fields = describeColumns(cols);
  if (!fields.length) return '(no columns understood)';
  return fields
    .map((f) => `${f.extra ? '+' : '•'} ${f.label} (col ${f.index + 1}${f.kind ? `, ${f.kind}` : ''})`)
    .join(', ');
}

/** Stable signature of a header row — lets callers detect a layout change. */
export function schemaSignature(headerRow = []) {
  const s = (Array.isArray(headerRow) ? headerRow : []).map(headerKey).join('|');
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return `${h.toString(36)}-${s.length}`;
}

/**
 * Map one sheet row through a resolved layout.
 * Returns { fields: { url, status, … }, extra: { qaCheck: '…' } } so callers
 * never need to know column positions.
 */
export function readFields(cols, row = []) {
  const fields = {};
  for (const f of FIELD_PROFILES[cols?.profile]?.fields || []) {
    const idx = cols?.[f.key];
    fields[f.key] = typeof idx === 'number' && idx >= 0 ? String(row[idx] ?? '').trim() : '';
  }
  const extra = {};
  for (const e of cols?.extras || []) extra[e.key] = String(row[e.index] ?? '').trim();
  return { fields, extra };
}

/** Inverse of readFields: build a row array sized to the layout. */
export function writeFields(cols, { fields = {}, extra = {} } = {}) {
  const width = rowWidth(cols);
  const row = new Array(width).fill('');
  const put = (idx, val) => {
    if (typeof idx === 'number' && idx >= 0 && idx < width) row[idx] = val ?? '';
  };
  for (const f of FIELD_PROFILES[cols?.profile]?.fields || []) {
    if (f.key in fields) put(cols?.[f.key], fields[f.key]);
  }
  for (const e of cols?.extras || []) {
    if (e.key in extra) put(e.index, extra[e.key]);
  }
  return row;
}

/** Widest resolved column + 1 = how many cells a full row of this layout spans. */
export function rowWidth(cols) {
  const known = Object.values(cols || {}).filter((v) => typeof v === 'number' && v >= 0);
  const extraIdx = ((cols && cols.extras) || []).map((c) => c.index).filter((i) => i >= 0);
  const max = Math.max(0, ...known, ...extraIdx);
  return Math.max(max + 1, 2);
}

/**
 * Find the header row of a sheet.
 * Rows are scored by how many profile fields they resolve, so a sheet whose
 * first rows are notes/banners/labels still finds its real header (that is
 * exactly the CW/RM case: row 1 is a note, row 2 is the header). When nothing
 * scores, the first row is returned so callers keep their old behaviour.
 */
export function detectHeaderRow(rows = [], { profile = 'auto', maxScan = 12, minScore = 2 } = {}) {
  const list = (Array.isArray(rows) ? rows : []).slice(0, maxScan);
  let best = { headerRow: list[0] || [], headerRowIndex: 0, profile: 'generic', score: -1 };
  list.forEach((row, index) => {
    const cells = Array.isArray(row) ? row : [];
    if (cells.filter((c) => String(c ?? '').trim() !== '').length < 2) return;
    for (const p of (profile === 'auto' ? PROFILE_ORDER : [profile])) {
      const s = scoreProfile(cells, p);
      if (s.required !== s.requiredNeeded) continue;
      // Later rows win ties: banners/notes sit above the real header.
      if (s.score >= minScore && s.score >= best.score) {
        best = { headerRow: cells, headerRowIndex: index, profile: p, score: s.score };
      }
    }
  });
  if (best.score < 0) return { headerRow: list[0] || [], headerRowIndex: 0, profile: 'generic', score: 0 };
  return best;
}

/** Extra-column labels of a resolved layout (display / prompt helpers). */
export function extraColumnNames(cols) {
  return (cols?.extras || []).map((e) => e.label || e.key);
}