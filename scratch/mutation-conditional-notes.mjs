/**
 * Mutation harness for scratch/verify-conditional-notes.mjs.
 *
 * A suite that only ever passes is decoration. This deliberately breaks the
 * product in many ways that each correspond to a stated requirement, and asserts
 * the suite FAILS for each one. Every mutation is reverted and the file verified
 * byte-identical afterwards, so the working tree is left exactly as found.
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SUITE = path.join(ROOT, 'scratch', 'verify-conditional-notes.mjs');

// [label, file, exact-from, exact-to]
const MUTATIONS = [
  {
    label: 'paragraph moves to AFTER the sign-off instead of before it',
    file: 'src/mailer.js',
    from: `\${conditionalNoteParagraphs}\n      <p>Best Regards,</p>`,
    to: `<p>Best Regards,</p>\n\${conditionalNoteParagraphs}`,
  },
  {
    label: 'the bare-key lone-cell guard is removed (plugin named "a11y" / "Update" false-positives)',
    file: 'src/reportUtils.js',
    from: 'if (m[1] === undefined && filledInRow > 1) continue; // bare, but not alone',
    to: '// guard removed',
  },
  {
    label: 'the http(s) allowlist is removed (javascript: URL accepted)',
    file: 'src/reportUtils.js',
    from: 'if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "";',
    to: '// allowlist removed',
  },
  {
    label: 'the FIRST "here" is linked instead of the last',
    file: 'src/mailer.js',
    from: 'const last = [...escaped.matchAll(hereRe)].pop();',
    to: 'const last = [...escaped.matchAll(hereRe)][0];',
  },
  {
    label: 'the enabled check is dropped from the resolver',
    file: 'src/reportUtils.js',
    from: '      && n.enabled !== false\n',
    to: '',
  },
  {
    label: 'detection becomes prefix-only, so ordinary prose matches',
    file: 'src/reportUtils.js',
    from: 'new RegExp(`^${escapeRegExp(key)}(?:\\\\s*:\\\\s*(.*))?$`, "i")',
    to: 'new RegExp(`^${escapeRegExp(key)}`, "i")',
  },
  {
    label: 'the link is taken from the cell prefix instead of after the colon',
    file: 'src/reportUtils.js',
    from: 'url: m[1] === undefined ? "" : safeExternalUrl(m[1]),',
    to: 'url: safeExternalUrl(cell),',
  },
  {
    label: 'mutations are not audited (appendAuditLog dropped on update)',
    file: 'src/db.js',
    from: "  const changed = ['condition', 'message', 'account', 'enabled']",
    to: '  const changed = []; const _unused = [\'condition\', \'message\', \'account\', \'enabled\']',
  },

  // ── link placement anywhere in the message ───────────────────────────────────
  {
    label: "the {{link:…}} marker is ignored (link position is not the operator's choice)",
    file: 'src/mailer.js',
    from: 'const LINK_MARKER = /\\{\\{\\s*link\\s*(?::\\s*([^}]*?)\\s*)?\\}\\}/gi;',
    to: 'const LINK_MARKER = /(?!)/g;',
  },
  {
    label: "the marker's own label is ignored, always \"here\"",
    file: 'src/mailer.js',
    from: "const text = String(label ?? '').replace(/\\s+/g, ' ').trim() || 'here';",
    to: "const text = 'here';",
  },
  {
    label: 'only the FIRST marker is honoured instead of every marker',
    file: 'src/mailer.js',
    from: 'const LINK_MARKER = /\\{\\{\\s*link\\s*(?::\\s*([^}]*?)\\s*)?\\}\\}/gi;',
    to: 'const LINK_MARKER = /\\{\\{\\s*link\\s*(?::\\s*([^}]*?)\\s*)?\\}\\}/i;',
  },
  {
    label: 'a marker with no link renders as a dead href',
    file: 'src/mailer.js',
    from: "return url ? anchor(text, escapeHtml(url)) : text;",
    to: 'return anchor(text, escapeHtml(url || "https://dead.invalid"));',
  },
  {
    label: 'a blank line no longer starts a new paragraph (message fixed to one <p>)',
    file: 'src/mailer.js',
    from: 'for (const block of linked.split(/\\n{2,}/)) {',
    to: 'for (const block of [linked]) {',
  },
  {
    label: 'a single newline no longer becomes <br/>',
    file: 'src/mailer.js',
    from: "paragraphs.push(\`\\n      <p>\${para.replace(/\\n/g, '<br/>')}</p>\`);",
    to: 'paragraphs.push(\`\\n      <p>\${para}</p>\`);',
  },
  {
    label: 'link placement is decided per paragraph, so unmarked paragraphs get a second link',
    file: 'src/mailer.js',
    from: '    const linked = placeLinks(escaped, url);',
    to: '    const linked = escaped.split(/\\n{2,}/).map((b) => placeLinks(b, url)).join("\\n\\n");',
  },
  {
    label: 'a marker label is not collapsed, so it can tear the anchor across paragraphs',
    file: 'src/mailer.js',
    from: "const text = String(label ?? '').replace(/\\s+/g, ' ').trim() || 'here';",
    to: "const text = String(label ?? '').trim() || 'here';",
  },
  {
    label: 'the href is no longer validated where it is written (javascript: URL accepted)',
    file: 'src/mailer.js',
    from: "const url = safeExternalUrl(note?.url ?? '');",
    to: "const url = String(note?.url ?? '').trim();",
  },

  // ── any condition keyword ────────────────────────────────────────────────────
  {
    label: 'a trailing colon is no longer stripped from the condition',
    file: 'src/db.js',
    from: "return String(condition ?? '').trim().replace(/\\s*:+\\s*$/, '').toLowerCase();",
    to: "return String(condition ?? '').trim().toLowerCase();",
  },
  {
    label: 'a condition containing a full URL is accepted (stores a key that can never match)',
    file: 'src/db.js',
    from: "  if (key.includes('://')) {",
    to: '  if (false) {',
  },
  {
    label: 'the condition is no longer lowercased (matching is case-insensitive)',
    file: 'src/db.js',
    from: "return String(condition ?? '').trim().replace(/\\s*:+\\s*$/, '').toLowerCase();",
    to: "return String(condition ?? '').trim().replace(/\\s*:+\\s*$/, '');",
  },

  // ── an arbitrary keyword of any shape ───────────────────────────────────────
  {
    label: 'regex metacharacters in a keyword are no longer escaped, so "a.b" also matches "axb"',
    file: 'src/reportUtils.js',
    from: 'new RegExp(\`^\${escapeRegExp(key)}(?:\\\\s*:\\\\s*(.*))?$\`, "i")',
    to: 'new RegExp(\`^\${key}(?:\\\\s*:\\\\s*(.*))?$\`, "i")',
  },
  {
    label: 'the match becomes case-sensitive, so a cell typed in another case is missed',
    file: 'src/reportUtils.js',
    from: 'new RegExp(\`^\${escapeRegExp(key)}(?:\\\\s*:\\\\s*(.*))?$\`, "i")',
    to: 'new RegExp(\`^\${escapeRegExp(key)}(?:\\\\s*:\\\\s*(.*))?$\`)',
  },
  {
    label: 'the resolver no longer strips a trailing colon, so "G112:" matches nothing',
    file: 'src/reportUtils.js',
    from: "return String(condition ?? '').trim().replace(/\\s*:+\\s*$/, '').toLowerCase();",
    to: "return String(condition ?? '').trim().toLowerCase();",
  },
  // ── the <variable>:<link> pattern is read from the cell, dynamically ────────
  {
    label: 'whitespace around the colon is no longer tolerated, so "a11y: <link>" matches nothing',
    file: 'src/reportUtils.js',
    from: 'new RegExp(\`^\${escapeRegExp(key)}(?:\\\\s*:\\\\s*(.*))?$\`, "i")',
    to: 'new RegExp(\`^\${escapeRegExp(key)}:(.*)?$\`, "i")',
  },
  {
    label: 'the link is taken as part of the variable name, so "a11y: <link>" matches nothing',
    file: 'src/reportUtils.js',
    from: 'new RegExp(\`^\${escapeRegExp(key)}(?:\\\\s*:\\\\s*(.*))?$\`, "i")',
    to: 'new RegExp(\`^\${escapeRegExp(key)}\\\\s*:\\\\s*(.*)\`, "i")',
  },
  {
    label: 'the variable is no longer required at the start, so any cell merely CONTAINING it fires',
    file: 'src/reportUtils.js',
    from: 'new RegExp(\`^\${escapeRegExp(key)}(?:\\\\s*:\\\\s*(.*))?$\`, "i")',
    to: 'new RegExp(\`\${escapeRegExp(key)}(?:\\\\s*:\\\\s*(.*))?$\`, "i")',
  },
  // ── one note across both sheets ──────────────────────────────────────────────
  {
    label: 'the sheet list is no longer de-duplicated, so ticking CW twice is rejected',
    file: 'src/db.js',
    from: 'const keys = [...new Set((Array.isArray(accounts) ? accounts : [accounts])',
    to: 'const keys = [...(Array.isArray(accounts) ? accounts : [accounts])',
  },
  {
    label: 'sheet names are no longer upper-cased, so "cw" is stored as a different sheet',
    file: 'src/db.js',
    from: `.map((a) => String(a ?? '').trim().toUpperCase())`,
    to: `.map((a) => String(a ?? '').trim())`,
  },
  {
    label: 'the "choose at least one sheet" guard is gone, so an empty selection silently succeeds',
    file: 'src/db.js',
    from: "if (!keys.length) throw new Error('Choose at least one sheet.');",
    to: "if (false) throw new Error('Choose at least one sheet.');",
  },
  {
    label: 'a sheet that already has the condition gets a duplicate instead of an update',
    file: 'src/db.js',
    from: 'if (existing) {',
    to: 'if (false && existing) {',
  },
  {
    label: 'an existing sheet is skipped instead of updated, so an edit never reaches the second sheet',
    file: 'src/db.js',
    from: 'updated.push(updateConditionalNote(existing.id, { message: text, enabled: enabled !== false }, { actor, actorId }));',
    to: 'updated.push(existing);',
  },
  {
    label: 'the trailing-colon strip is widened to any colon, so a condition containing one is truncated',
    file: 'src/db.js',
    from: "return String(condition ?? '').trim().replace(/\\s*:+\\s*$/, '').toLowerCase();",
    to: "return String(condition ?? '').trim().replace(/:/g, '').toLowerCase();",
  },
  {
    label: 'the resolver trims only one side, so " G112" matches nothing',
    file: 'src/reportUtils.js',
    from: "return String(condition ?? '').trim().replace(/\\s*:+\\s*$/, '').toLowerCase();",
    to: "return String(condition ?? '').trimStart().replace(/\\s*:+\\s*$/, '').toLowerCase();",
  },
];

function hash(rel) {
  return crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, rel))).digest('hex');
}

// These files are CRLF, so a multi-line anchor written with bare \n never
// matches. Match the file's own line ending rather than reformatting it.
function eolAware(text, sample) {
  return sample.includes('\r\n') ? text.replace(/\r?\n/g, '\r\n') : text;
}

function runSuite() {
  try {
    const out = execFileSync(process.execPath, [SUITE], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status === undefined ? -1 : e.status, out: `${e.stdout || ''}${e.stderr || ''}` };
  }
}

const originals = new Map();
for (const m of MUTATIONS) {
  if (!originals.has(m.file)) originals.set(m.file, fs.readFileSync(path.join(ROOT, m.file), 'utf8'));
}

console.log('Baseline (unmutated):');
const base = runSuite();
console.log(`  exit ${base.code} — ${(base.out.match(/(\d+) passed, (\d+) failed/) || [])[0]}`);
if (base.code !== 0) {
  console.log('  ABORT: the suite does not pass before mutating, so it cannot judge anything.');
  process.exit(1);
}
console.log('');

let survived = 0;
const beforeHashes = new Map([...originals.keys()].map((f) => [f, hash(f)]));

for (const m of MUTATIONS) {
  const p = path.join(ROOT, m.file);
  const src = originals.get(m.file);
  const from = eolAware(m.from, src);
  const to = eolAware(m.to, src);
  const count = src.split(from).length - 1;
  if (count !== 1) {
    console.log(`  SKIP  ${m.label}`);
    console.log(`        anchor matched ${count} times in ${m.file} — fix the anchor, do not weaken the test`);
    survived++;
    continue;
  }

  fs.writeFileSync(p, src.replace(from, to), 'utf8');
  let res;
  try {
    res = runSuite();
  } finally {
    fs.writeFileSync(p, src, 'utf8');
  }

  const caught = res.code !== 0;
  const detail = (res.out.match(/(\d+) passed, (\d+) failed/) || [])[0];
  console.log(`  ${caught ? 'caught' : 'SURVIVED'}  ${m.label}`);
  console.log(`        ${m.file} → exit ${res.code} ${detail || ''}`);
  if (!caught) survived++;
}

// The working tree must be exactly as we found it.
console.log('');
for (const [f, h] of beforeHashes) {
  const now = hash(f);
  console.log(`  ${now === h ? 'identical' : 'CHANGED !!'}  ${f}`);
  if (now !== h) {
    fs.writeFileSync(path.join(ROOT, f), originals.get(f), 'utf8');
    console.log(`        reverted`);
  }
}

console.log('');
if (survived) {
  console.log(`  ${survived} mutation(s) not judged — fix the anchors above.`);
  process.exit(1);
}
console.log(`  all ${MUTATIONS.length} mutations caught; tree restored`);
