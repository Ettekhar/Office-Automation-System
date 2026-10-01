/**
 * verify-conditional-notes.mjs
 *
 * Tests the conditional-email-note feature against the DEPLOYED product code:
 *   src/reportUtils.js  resolveConditionalNotes()  — detection in the sheet grid
 *   src/mailer.js       buildEmail()               — rendering above the sign-off
 *   src/db.js           conditional-note helpers    — validation + audit trail
 *
 * Nothing here re-implements the logic; every assertion runs the real exported
 * functions. The fixture is the real cell the operator typed, read out of the
 * live ocalaflevents.com report tab (row 24, column B).
 *
 * Live data/ is never clobbered: the two files these tests write to are
 * snapshotted byte-for-byte and restored on the way out, and the restore is
 * itself asserted.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath, pathToFileURL } from 'url';

// Point the DB at a throwaway directory BEFORE importing it, so this suite is
// structurally incapable of writing to the live data/ directory. ESM imports are
// hoisted, hence the dynamic import below rather than a static one.
const LIVE_DATA = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'data');
const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'officeos-cond-notes-'));
process.env.OFFICEOS_DATA_DIR = TMP_DATA;

const { resolveConditionalNotes } = await import('../src/reportUtils.js');
const { buildEmail } = await import('../src/mailer.js');
const db = await import('../src/db.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// Hash every live data file up front. The suite asserts at the end that not one
// byte changed — a stronger guarantee than restoring what it touched.
const liveBefore = new Map();
for (const f of fs.readdirSync(LIVE_DATA)) {
  if (f.endsWith('.json')) liveBefore.set(f, crypto.createHash('sha256').update(fs.readFileSync(path.join(LIVE_DATA, f))).digest('hex'));
}

let pass = 0;
const failures = [];

function check(name, cond, detail = '') {
  if (cond) {
    pass++;
    console.log(`  ok   ${name}`);
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}
function eq(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  check(name, a === e, `got ${a}, want ${e}`);
}
function section(t) {
  console.log(`\n── ${t} ${'─'.repeat(Math.max(0, 62 - t.length))}`);
}

// ── The real fixture ────────────────────────────────────────────────────────
// Exactly as it sits in the live CW report tab "https://ocalaflevents.com":
//   row 1  "Plugin Updated"                     (section band)
//   row 16 "Update" | "Theme" | "To Version"    (ordinary Other-section row)
//   row 20 "Additional Issue Fixed"             (section band)
//   row 21 "Title" | | "Note"                   (sub-header)
//   row 22 blank, row 23 blank                  <- 2 blanks close the section
//   row 24 col B "a11y:https://docs.google…"
const DOC_URL =
  'https://docs.google.com/document/d/1WolHnCP5oDPPvVdAbtRUDLbw6crZ4g7NfcIVHxmHW-g/edit?tab=t.0#heading=h.6fwf6gxl58vz';
const REAL_ROWS = [
  ['Plugin Updated'],
  ['1', '3D FlipBook : DearFlip Lite', 'To Version', '2.4.37'],
  ['9', 'LiteSpeed Cache', '', '7.9.1'],
  ['Other'],
  ['Update', 'Theme', 'To Version', '1.0.149'],
  ['Backup', 'Created Backup on 09-04-26'],
  ['Deactivated'],
  ['Additional Issue Fixed'],
  ['Title', '', 'Note'],
  [],
  [],
  ['', `a11y:${DOC_URL}`],
];
const A11Y_MESSAGE =
  'We reviewed the latest ADA accessibility audit and implemented custom fixes for the related issues identified. The full audit findings and remediation details are available here...';

const REG = [{ condition: 'a11y', message: A11Y_MESSAGE, enabled: true }];

// ══════════════════════════════════════════════════════════════════════════════
section('detection — the real cell fires');

{
  const got = resolveConditionalNotes(REAL_ROWS, REG);
  check('exactly one condition resolves', got.length === 1, `got ${got.length}`);
  eq('condition key', got[0]?.condition, 'a11y');
  eq('link extracted verbatim from the cell', got[0]?.url, DOC_URL);
  eq('message carried through', got[0]?.message, A11Y_MESSAGE);
  eq('source cell reported for the dashboard', got[0]?.sourceCell, 'B12');

  // The whole reason this feature is needed: parseReportSections orphans row 24
  // (two blank rows close the band), so the cell reaches nobody today.
  const { parseReportSections } = await import('../src/reportUtils.js');
  const secs = parseReportSections(REAL_ROWS);
  const issue = secs.find((s) => s.type === 'additional_issue');
  eq('the orphaned cell is invisible to the section parser', issue?.rows.length, 0);
  check('yet detection still sees it', resolveConditionalNotes(REAL_ROWS, REG).length === 1);
}

// ══════════════════════════════════════════════════════════════════════════════
section('detection — matching is narrow (no false alarms)');

{
  eq('no registry → nothing', resolveConditionalNotes(REAL_ROWS, []), []);
  eq('null registry → nothing', resolveConditionalNotes(REAL_ROWS, null), []);

  // A registered condition of "Update" must NOT fire on the ordinary
  // "Update | Theme | To Version" row — there is no colon after the word.
  const regUpdate = [{ condition: 'Update', message: 'm', enabled: true }];
  eq('condition "Update" ignores the real Theme row', resolveConditionalNotes(REAL_ROWS, regUpdate), []);

  eq('mid-cell mention does not fire', resolveConditionalNotes(
    [['we fixed a11y:https://x.test']], REG), []);
  eq('trailing mention does not fire', resolveConditionalNotes(
    [['note about a11y:https://x.test']], REG), []);
  eq('bare word, no colon, does not fire', resolveConditionalNotes(
    [['a11y review done']], REG), []);
  eq('different condition does not fire', resolveConditionalNotes(
    [['security:https://x.test']], REG), []);
  eq('a plugin literally named "a11y" does not fire', resolveConditionalNotes(
    [['7', 'a11y', 'To Version', '1.0']], REG), []);
  eq('unrelated grid yields nothing', resolveConditionalNotes(REAL_ROWS.slice(0, 3), REG), []);
}

// ══════════════════════════════════════════════════════════════════════════════
section('detection — matching is forgiving where it should be');

{
  eq('case-insensitive key', resolveConditionalNotes(
    [[`A11Y:${DOC_URL}`]], REG)[0]?.condition, 'a11y');
  eq('mixed case key', resolveConditionalNotes(
    [[`a11Y:${DOC_URL}`]], REG)[0]?.condition, 'a11y');
  eq('whitespace before the colon', resolveConditionalNotes(
    [[`a11y  :${DOC_URL}`]], REG)[0]?.url, DOC_URL);
  eq('leading whitespace in the cell', resolveConditionalNotes(
    [[`  a11y:${DOC_URL}`]], REG)[0]?.url, DOC_URL);
  eq('trigger in column A', resolveConditionalNotes(
    [[`a11y:${DOC_URL}`]], REG)[0]?.sourceCell, 'A1');
  eq('trigger in column D', resolveConditionalNotes(
    [['x', 'y', 'z', `a11y:${DOC_URL}`]], REG)[0]?.sourceCell, 'D1');
  eq('prefix key is not shadowed by a longer sibling',
    resolveConditionalNotes([[`a11y audit:${DOC_URL}`]],
      [{ condition: 'a11y', message: 'short', enabled: true },
       { condition: 'a11y audit', message: 'long', enabled: true }]).map((n) => n.message),
    ['long']);
}

// ══════════════════════════════════════════════════════════════════════════════
section('detection — missing / unsafe links');

{
  eq('condition with no link → fires, url empty',
    resolveConditionalNotes([['', 'a11y']], REG)[0]?.url, '');
  eq('condition with nothing after the colon → fires, url empty',
    resolveConditionalNotes([['a11y:']], REG)[0]?.url, '');
  eq('whitespace after the colon → still empty',
    resolveConditionalNotes([['a11y:   ']], REG)[0]?.url, '');

  // The bare form has no colon to narrow it, so it is only trusted in a cell that
  // stands alone in its row. These are the collisions that made that rule
  // necessary — both are real sheet content, not hypotheticals.
  eq('bare "a11y" with a sibling cell in the row does NOT fire',
    resolveConditionalNotes([['note', 'a11y']], REG), []);
  eq('the rule counts filled cells, not grid position — padding does not disqualify',
    resolveConditionalNotes([['', 'a11y', '', '']], REG)[0]?.url, '');
  eq('  …but a second filled cell anywhere in the row does',
    resolveConditionalNotes([['a11y', '', 'x', '']], REG), []);
  eq('bare "a11y" alone in its row does fire',
    resolveConditionalNotes([['', 'a11y']], REG)[0]?.url, '');
  eq('colon form is NOT subject to the lone-cell rule',
    resolveConditionalNotes([['title', `a11y:${DOC_URL}`]], REG)[0]?.url, DOC_URL);

  for (const bad of [
    'javascript:alert(1)',
    'JavaScript:alert(1)',
    'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==',
    'ftp://x.test/f',
    'not a url at all',
  ]) {
    eq(`non-http(s) link rejected: ${bad.slice(0, 26)}`,
      resolveConditionalNotes([[`a11y:${bad}`]], REG)[0]?.url, '');
  }
}

// ══════════════════════════════════════════════════════════════════════════════
section('detection — disabled notes and multiple conditions');

{
  eq('enabled:false never fires',
    resolveConditionalNotes(REAL_ROWS, [{ condition: 'a11y', message: A11Y_MESSAGE, enabled: false }]), []);

  const two = resolveConditionalNotes(
    [['a11y:https://a.test', 'security:https://b.test']],
    [{ condition: 'security', message: 'SEC', enabled: true },
     { condition: 'a11y', message: 'A11', enabled: true }],
  );
  eq('registry order, not scan order', two.map((n) => n.message), ['SEC', 'A11']);

  const dup = resolveConditionalNotes(
    [['a11y:https://first.test'], ['a11y:https://second.test']],
    [{ condition: 'a11y', message: 'M', enabled: true }],
  );
  eq('a repeated condition resolves once, first mention wins', dup.length, 1);
  eq('  …and it is the first one', dup[0]?.url, 'https://first.test/');
}

// ══════════════════════════════════════════════════════════════════════════════
section('rendering — placement in the email');

const MONTH = { monthLower: 'september', year: 2026 };
function render(notes, over = {}) {
  return buildEmail({
    websiteUrl: 'ocalaflevents.com',
    reportMonth: MONTH,
    reportHtml: '<table><tr><td>Plugin Updated</td></tr></table>',
    hasAdditionalIssues: false,
    hasPremiumPlugins: false,
    conditionalNotes: notes,
    ...over,
  }).html;
}

// The account signature is part of the finished email and it carries its own
// links (support mailbox, company site, logo, newsletter sign-up). Counting
// "<a href=" across the WHOLE email therefore counts those too, so an absolute
// count says nothing about the note. Every anchor assertion below is relative to
// this baseline, which is what the claim is actually about: how many links the
// NOTE adds. The paragraph baseline below is derived the same way.
const BASE_A = (render([]).match(/<a href=/g) || []).length;

{
  const notes = resolveConditionalNotes(REAL_ROWS, REG);
  const html = render(notes);

  // Compare on the paragraph's TEXT, not on a hand-built search string: strip
  // tags and the rendered paragraph must read back as exactly the stored
  // message. This is what actually matters to the recipient, and it cannot be
  // fooled by how the anchor happens to be spelled.
  const para = html.slice(html.indexOf('<p>', html.indexOf('Everything is running smoothly')));
  const paraText = para.slice(0, para.indexOf('</p>')).replace(/<[^>]*>/g, '');

  const iNote = html.indexOf(para);
  const iSmooth = html.indexOf('Everything is running smoothly');
  const iSign = html.indexOf('Best Regards,');
  check('paragraph is present', iNote > -1);
  eq('the paragraph reads back as exactly the stored message', paraText, A11Y_MESSAGE);
  check('it sits after the closing paragraph', iNote > iSmooth, `note@${iNote} smooth@${iSmooth}`);
  check('it sits immediately before the sign-off', iNote < iSign, `note@${iNote} sign@${iSign}`);
  check('exactly one sign-off', (html.match(/Best Regards,/g) || []).length === 1);
  eq('the extracted link is the href', html.includes(`href="${DOC_URL}"`), true);

  // "here" is the linked word, not the whole message.
  const anchor = html.slice(html.indexOf('<a href='), html.indexOf('</a>'));
  check('the anchor text is exactly "here"', anchor.endsWith('>here'), anchor.slice(-30));
  check('the anchor appears once', (html.match(/<a href=/g) || []).length === BASE_A + 1);
}

// ══════════════════════════════════════════════════════════════════════════════
section('rendering — the "here" rule');

{
  // x.test/doc rather than x.test: a bare origin is rewritten to x.test/ by the
  // URL parser, so a path-bearing URL keeps every href assertion here exact.
  const twoHere = render([{ message: 'available here, and more detail here', url: 'https://x.test/doc' }]);
  eq('last standalone "here" wins, not the first',
    twoHere.match(/<a href="https:\/\/x\.test\/doc"[^>]*>([^<]*)</)[1],
    'here');
  check('only one of the two "here" words is an anchor',
    (twoHere.match(/<a href=/g) || []).length === BASE_A + 1);
  check('the first "here" is left as plain text',
    twoHere.includes('available here, and more detail'), twoHere.slice(0, 260));

  // "here" must be a standalone word. "weather" contains the letters but is a
  // different word, so it must survive intact and must not become the anchor —
  // the anchor should fall through to the append behaviour instead.
  const weather = render([{ message: 'the weather is fine', url: 'https://x.test/doc' }]);
  check('"here" inside "weather" is not linked', !weather.includes('>here</a>'), weather.slice(0, 200));
  check('the word "weather" survives intact', weather.includes('the weather is fine'));
  check('so the link is appended instead of misattached',
    weather.includes('<a href="https://x.test/doc'));

  const standalone = render([{ message: 'read it here', url: 'https://x.test/doc' }]);
  check('a standalone "here" IS the anchor', standalone.includes('>here</a>'));

  const appended = render([{ message: 'See the audit document.', url: 'https://x.test/doc' }]);
  check('no "here" → link appended rather than dropped', appended.includes('https://x.test/doc'));
  check('  …as its own anchor, not bare text', appended.includes('<a href="https://x.test/doc'));
  check('  …and the message text is untouched',
    appended.includes('See the audit document.'));

  const noLink = render([{ message: 'Details are available here.' }]);
  check('no link → message still shown', noLink.includes('Details are available here.'));
  eq('no link → "here" left unlinked, no dead anchor',
    (noLink.match(/<a href=/g) || []).length, BASE_A);

  // The href is validated where it is written, so the renderer now inherits the
  // URL parser's normalisation. That was already true of the real pipeline — the
  // resolver normalises before the renderer ever sees the value — and pinning it
  // here stops the two from silently drifting apart.
  eq('a bare origin is normalised exactly as the resolver would',
    (render([{ message: 'see {{link:here}}', url: 'https://x.test' }]).match(/<a href="([^"]*)"/) || [])[1],
    new URL('https://x.test').toString());
  eq('  …and the real doc link survives normalisation untouched',
    render([{ message: 'see {{link:here}}', url: DOC_URL }]).includes(`<a href="${DOC_URL}"`), true);
}

// ══════════════════════════════════════════════════════════════════════════════
section('rendering — escaping and multiple notes');

{
  const evil = render([{ message: '<script>alert(1)</script> done here', url: 'https://x.test' }]);
  eq('markup in the message is escaped, not injected', evil.includes('<script>'), false);
  check('escaped form is present', evil.includes('&lt;script&gt;'));

  const amp = render([{ message: 'Tom & Jerry & Co — see here', url: 'https://x.test/a?b=1&c=2' }]);
  check('ampersand in the message is escaped', amp.includes('Tom &amp; Jerry'));
  check('ampersand in the href is escaped', amp.includes('b=1&amp;c=2'));
  check('the raw href attribute never carries a bare &', !/<a href="[^"]*&(?!amp;|nbsp;|#)/.test(amp));

  const two = render([
    { condition: 'a11y', message: 'FIRST here', url: 'https://a.test' },
    { condition: 'security', message: 'SECOND here', url: 'https://b.test' },
  ]);
  check('two notes → two paragraphs', (two.match(/FIRST|SECOND/g) || []).length === 2);
  check('both links present', two.includes('https://a.test') && two.includes('https://b.test'));
  check('order preserved', two.indexOf('FIRST') < two.indexOf('SECOND'));

  eq('empty note list → no paragraph at all', render([]).includes('FIRST'), false);
  eq('note with blank message is skipped', render([{ message: '   ', url: 'https://a.test' }]).includes('https://a.test'), false);
  eq('malformed input does not throw', render(null).includes('Best Regards,'), true);
}

// ══════════════════════════════════════════════════════════════════════════════
section('rendering — existing conditional paragraphs still work');

{
  const html = render([], { hasPremiumPlugins: true, hasAdditionalIssues: true });
  check('premium-plugin paragraph still rendered', html.includes('Premium Plugin (Required License)'));
  check('additional-issues paragraph still rendered', html.includes('Additional Issues Fixed:'));
  check('premium plugin still sits before "Functionality Checks"',
    html.indexOf('Premium Plugin (Required License)') < html.indexOf('Functionality Checks'));
  check('additional issues still sit before "Functionality Checks"',
    html.indexOf('Additional Issues Fixed:') < html.indexOf('Functionality Checks'));

  const withNote = render(
    resolveConditionalNotes(REAL_ROWS, REG),
    { hasPremiumPlugins: true, hasAdditionalIssues: true },
  );
  check('note coexists with both existing paragraphs',
    withNote.includes('Premium Plugin (Required License)')
    && withNote.includes('Additional Issues Fixed:')
    && withNote.includes('docs.google.com'));
  check('note still above the sign-off',
    withNote.indexOf('docs.google.com') < withNote.indexOf('Best Regards,'));
  eq('no duplicate sign-off with a note present',
    (withNote.match(/Best Regards,/g) || []).length, 1);

  eq('subject unchanged by the feature',
    buildEmail({
      websiteUrl: 'ocalaflevents.com', reportMonth: MONTH, reportHtml: '<p>x</p>',
      hasAdditionalIssues: false, hasPremiumPlugins: false,
      conditionalNotes: resolveConditionalNotes(REAL_ROWS, REG),
    }).subject,
    'Website Maintenance Report for ocalaflevents.com (september-2026)');
}

// ══════════════════════════════════════════════════════════════════════════════
// DB layer. Runs against a throwaway directory (OFFICEOS_DATA_DIR, set above), so
// these tests cannot reach live data/ even in principle — and the final section
// proves it by hashing every live file.
// ══════════════════════════════════════════════════════════════════════════════
section('rendering — {{link:…}} places the link anywhere in the message');

{
  const URLX = 'https://x.test/doc';
  // Baseline paragraph count comes from the template itself, so the note's own
  // paragraph count is derived rather than guessed.
  const BASE_P = (render([]).match(/<p>/g) || []).length;

  // The whole point: position is the operator's choice, not a hardcoded "here".
  const mid = render([{ message: 'Findings are available {{link:here}} for review.', url: URLX }]);
  check('mid-sentence marker becomes the anchor',
    /available <a href="https:\/\/x\.test\/doc"[^>]*>here<\/a> for review\./.test(mid), mid.slice(0, 400));
  eq('  …and it is one anchor, not two', (mid.match(/<a href=/g) || []).length, BASE_A + 1);

  const label = render([{ message: 'Read more at {{link:the security advisory}} for context.', url: URLX }]);
  check('a custom label is used verbatim as the link text',
    label.includes('>the security advisory</a>'), label.slice(0, 300));
  check('  …and the rest of the sentence is untouched',
    label.includes('Read more at ') && label.includes(' for context.'));

  const bare = render([{ message: 'Click {{link}} to open it.', url: URLX }]);
  check('a bare {{link}} still reads as "here"', bare.includes('>here</a>'), bare.slice(0, 300));

  const start = render([{ message: '{{link:Full audit report}} was published today.', url: URLX }]);
  check('a marker at the very start becomes the anchor',
    new RegExp(`<p><a href="${URLX.replace(/[/.]/g, '\\$&')}"`).test(start), start.slice(0, 300));

  const two = render([{ message: 'See {{link:the report}} or {{link:the appendix}}.', url: URLX }]);
  eq('every marker in the message is honoured', (two.match(/<a href=/g) || []).length, BASE_A + 2);
  check('  …each with its own label',
    two.includes('>the report</a>') && two.includes('>the appendix</a>'));
  eq('  …both pointing at the one cell link',
    (two.match(new RegExp(`href="${URLX}"`, 'g')) || []).length, 2);

  // Stripping tags must give back a sentence the operator would have written.
  const text = (h) => h.slice(h.indexOf('<p>', h.indexOf('running smoothly')), h.indexOf('</p>', h.indexOf('<p>', h.indexOf('running smoothly'))))
    .replace(/<br\/>/g, ' ').replace(/<[^>]*>/g, '').trim();
  eq('the sentence reads back unchanged after linking',
    text(label), 'Read more at the security advisory for context.');

  // No marker anywhere → the legacy wording still works, so the message already
  // registered in data/ is unaffected by any of this.
  const legacy = render([{ message: 'Details are available here.', url: URLX }]);
  check('a markerless message still links its last "here"', legacy.includes('>here</a>'));
  check('  …and does NOT additionally get the marker treatment',
    !legacy.includes('{{link'), legacy.slice(0, 300));
}

// ══════════════════════════════════════════════════════════════════════════════
section('rendering — a marker degrades to plain text when the cell has no link');

{
  const noLink = render([{ message: 'Findings are available {{link:here}} for review.' }]);
  check('the marker never reaches the recipient as "{{link"',
    !noLink.includes('{{link') && !noLink.includes('}}'), noLink.slice(0, 300));
  check('the label remains, so the sentence still reads',
    noLink.includes('Findings are available here for review.'));

  const bare = render([{ message: 'Click {{link}} to open it.' }]);
  check('a bare marker becomes the word "here"', bare.includes('Click here to open it.'), bare.slice(0, 300));
  eq('  …and still produces no dead anchor', (bare.match(/<a href=/g) || []).length, BASE_A);

  const labelled = render([{ message: 'See {{link:the advisory}} today.' }]);
  check('a labelled marker keeps its own words', labelled.includes('See the advisory today.'));
}

// ══════════════════════════════════════════════════════════════════════════════
section('rendering — any message shape: paragraphs, line breaks, emphasis words');

{
  const URLX = 'https://x.test/doc';
  const BASE_P = (render([]).match(/<p>/g) || []).length;

  const two = render([{ message: 'First para line one.\n\nSecond para with {{link:the link}}.', url: URLX }]);
  eq('a blank line starts a second paragraph', (two.match(/<p>/g) || []).length, BASE_P + 2);
  // The regression this guards: deciding "no marker → fall back" per paragraph
  // gave the unmarked first paragraph its own appended link as well.
  eq('  …without also appending a link to the unmarked paragraph',
    (two.match(/<a href=/g) || []).length, BASE_A + 1);
  check('  …the one link is inside the marked paragraph', two.includes('Second para with <a href='));
  check('  …and the unmarked paragraph is plain', two.includes('<p>First para line one.</p>'));

  const lines = render([{ message: 'Line one.\nLine two {{link:here}}.', url: URLX }]);
  check('a single newline becomes <br/>', lines.includes('Line one.<br/>Line two '), lines.slice(0, 320));
  eq('  …and stays a single paragraph', (lines.match(/<p>/g) || []).length, BASE_P + 1);

  // A label typed across a line break must not tear the anchor in half.
  const wrapped = render([{ message: 'See {{link:the long\nwrapped label}} today.', url: URLX }]);
  check('a marker wrapped across lines still yields one intact anchor',
    wrapped.includes('>the long wrapped label</a>'), wrapped.slice(0, 320));
  check('  …no closing tag is orphaned into a later paragraph',
    (wrapped.match(/<\/a>/g) || []).length === (wrapped.match(/<a href=/g) || []).length);

  // A blank line inside a label must not split the anchor across paragraphs.
  const labelBreak = render([{ message: 'See {{link:two\n\nparagraphs}} today.', url: URLX }]);
  check('a label containing a blank line cannot break the anchor',
    !/<a [^>]*>[^<]*<\/p>/.test(labelBreak), labelBreak.slice(0, 400));
  eq('  …the label is collapsed onto one line',
    (labelBreak.match(/<a href=/g) || []).length, (labelBreak.match(/<\/a>/g) || []).length);

  // "here" is a target the operator names, not one the code hunts for: when a
  // marker is used, the fallback must not also fire.
  const twoHereOneMarker = render([{ message: 'It was here and the copy is {{link:over here}}.', url: URLX }]);
  eq('only the marked span is linked when a marker is present',
    (twoHereOneMarker.match(/<a href=/g) || []).length, BASE_A + 1);
  check('  …the unmarked "here" stays plain text',
    twoHereOneMarker.includes('It was here and the copy is '));

  // Malformed input stays visible instead of being silently rewritten.
  const typo = render([{ message: 'See {{link:oops today.', url: URLX }]);
  check('a malformed marker is left as typed, not silently mangled',
    typo.includes('{{link:oops'), typo.slice(0, 320));
}

// ══════════════════════════════════════════════════════════════════════════════
section('rendering — the href is safe even when the note is built by hand');

{
  // resolveConditionalNotes already filters, but the guarantee has to live where
  // the href is actually written, or a future caller can defeat it.
  for (const bad of ['javascript:alert(1)', 'data:text/html,<script>', 'ftp://e.test/x', 'not a url', '']) {
    const html = render([{ message: 'See {{link:here}} now.', url: bad }]);
    eq(`"${bad}" produces no href`, (html.match(/<a href=/g) || []).length, BASE_A);
    check(`  …message still shown for "${bad}"`, html.includes('See here now.'));
  }
  const quoted = render([{ message: 'See {{link:here}} now.', url: 'https://e.test/?a=1&b="><b>x' }]);
  const href = quoted.match(/<a href="([^"]*)"/)?.[1] ?? '';
  check('a quote in the url cannot break out of href="…"', !href.includes('"') && !href.includes('<'), href);
  check('  …the dangerous characters are percent-encoded instead',
    href.includes('%22') && href.includes('%3E'), href);
  eq('  …the anchor is still well formed', (quoted.match(/<\/a>/g) || []).length, BASE_A + 1);
}

// ══════════════════════════════════════════════════════════════════════════════
section('detection — ANY condition keyword works, not just a11y');

{
  // The operator named a11y by accident of history; the mechanism is generic.
  const grid = [
    ['', 'link:https://example.com'],
    ['', 'ADA Review:https://example.com/b'],
    ['', 'sec-fix'],
    ['link', 'x', 'y'],
    ['', 'a11y:https://example.com/c'],
  ];
  const reg = [
    { condition: 'link', message: 'm1', enabled: true },
    { condition: 'ADA Review', message: 'm2', enabled: true },
    { condition: 'sec-fix', message: 'm3', enabled: true },
    { condition: 'a11y', message: 'm4', enabled: true },
  ];
  const got = resolveConditionalNotes(grid, reg);
  const byKey = Object.fromEntries(got.map((n) => [n.condition, n]));

  eq('four different keywords all fire', got.length, 4);
  eq('keyword "link" catches "link:https://example.com"',
    byKey.link?.url, 'https://example.com/');
  eq('  …and reports the cell it came from', byKey.link?.sourceCell, 'B1');
  eq('a multi-word keyword "ADA Review" fires', byKey['ada review']?.url, 'https://example.com/b');
  eq('a hyphenated keyword fires', byKey['sec-fix']?.condition, 'sec-fix');
  eq('"a11y" is unaffected by the others being registered', byKey.a11y?.url, 'https://example.com/c');

  // "link" is an ordinary English word, so the lone-cell rule has to hold for it
  // exactly as it does for "Update": a bare mention beside other content is not a
  // trigger. Tested on its own grid, because in the grid above the earlier
  // keyed mention would mask it.
  const shared = resolveConditionalNotes([['link', 'docs', 'here']], [{ condition: 'link', message: 'm' }]);
  eq('a bare "link" beside other cells is NOT a trigger', shared.length, 0);
  eq('  …but the same word with a colon is', resolveConditionalNotes([['link:https://x.test']], [{ condition: 'link', message: 'm' }]).length, 1);

  // End to end: a keyword the operator invents reaches the email.
  const html = render(resolveConditionalNotes(
    [['link:https://example.com/advisory']],
    [{ condition: 'link', message: 'Please read {{link:the advisory}} before launch.', enabled: true }],
  ));
  check('an invented keyword reaches the finished email',
    html.includes('Please read <a href="https://example.com/advisory"'), html.slice(0, 400));
}

// ══════════════════════════════════════════════════════════════════════════════
section('detection — ANY keyword, of any shape, with no allowlist');

{
  // The operator's own example, asked for explicitly.
  const g112 = [{ condition: 'g112', message: 'm', enabled: true }];
  const g = resolveConditionalNotes([['g112:https://example.com/d']], g112);
  eq('"g112" is detected', g.length, 1);
  eq('  …with the link from the cell', g[0]?.url, 'https://example.com/d');
  eq('  …under its own key', g[0]?.condition, 'g112');

  // Digits, mixed case, punctuation, and pure noise. There is no allowlist, so
  // each of these has to behave identically to "a11y".
  const fires = (k) => resolveConditionalNotes([[`${k}:https://example.com/d`]], [{ condition: k, message: 'm', enabled: true }]).length;
  const KEYS = [
    'alsdjflaksf',            // the operator's gibberish example
    'x', 'Q', 'zzz9', 'a1b2c3', '100', '007', 'g112b',
    'sec-fix', 'ADA Review', 'a11y', 'link', 'g_112', 'v2.0', 'q&a',
    'c++', 'a+b', 'a(b)', 'a|b', 'a$b', 'a^b', 'a[b', 'a{b', 'a?b', 'a*b',
    'a.b', 'a\\b', 'a-b_c.d', '100%', 'C#', 'a/b', 'a!b', '@home', 'a,b', 'a;b',
    'ÜBER', 'नमस्ते', 'a  b', 'tab\tsep',
  ];
  for (const k of KEYS) {
    eq(`"${k}" is detected`, fires(k), 1);
  }

  // Case is irrelevant in both directions, because the key is normalised on the
  // way in and the match is case-insensitive.
  eq('cell in a different case still matches',
    resolveConditionalNotes([['G112:https://example.com/d']], g112).length, 1);
  eq('and an all-caps registration still matches a lower-case cell',
    resolveConditionalNotes([['g112:https://example.com/d']],
      [{ condition: 'G112', message: 'm', enabled: true }]).length, 1);

  // The one real hazard with a free-form key: regex metacharacters must be
  // matched literally, or "a.b" would also fire on "axb".
  const dot = [{ condition: 'a.b', message: 'm', enabled: true }];
  eq('"a.b" matches its own cell', resolveConditionalNotes([['a.b:https://example.com/d']], dot).length, 1);
  eq('  …and NOT "axb", which an unescaped "." would wrongly match',
    resolveConditionalNotes([['axb:https://example.com/d']], dot).length, 0);
  const plus = [{ condition: 'a+b', message: 'm', enabled: true }];
  eq('"a+b" does not fire on "ab"',
    resolveConditionalNotes([['ab:https://example.com/d']], plus).length, 0);
  const paren = [{ condition: 'a(b)c', message: 'm', enabled: true }];
  eq('"a(b)c" does not fire on "abc"',
    resolveConditionalNotes([['abc:https://example.com/d']], paren).length, 0);

  // Arbitrary does NOT mean loose. The same narrow whole-cell rule has to hold
  // for gibberish, or a nonsense key would start firing on real sheet content.
  for (const k of ['alsdjflaksf', 'g112', 'zzz9']) {
    eq(`"${k}" does not fire on the real report grid`,
      resolveConditionalNotes(REAL_ROWS, [{ condition: k, message: 'm', enabled: true }]).length, 0);
    eq(`  …nor mid-cell`, resolveConditionalNotes([[`we did ${k} today`]], [{ condition: k, message: 'm', enabled: true }]).length, 0);
    eq(`  …nor on a bare cell beside other content`,
      resolveConditionalNotes([[k, 'other', 'cells']], [{ condition: k, message: 'm', enabled: true }]).length, 0);
  }

  // The bare form still works for an arbitrary key when the cell stands alone.
  eq('a bare "g112" in a lone cell fires, unlinked',
    resolveConditionalNotes([['g112']], g112)[0]?.url, '');

  // ── the pattern itself: <variable>:<link> ─────────────────────────────────
  // The operator's framing, tested in the exact forms they typed. The variable
  // name is data, not configuration: the cell supplies the name, the registry
  // supplies the message, and the cell supplies the link. Nothing is hardcoded,
  // so there is no list of names that could be out of date.
  const DOC = 'https://docs.google.com/document/d/1WolHnCP5oDPPvVdAbtRUDLbw6crZ4g7NfcIVHxmHW-g/edit?tab=t.0#heading=h.6fwf6gxl58vz';
  const pattern = (cell, variable) =>
    resolveConditionalNotes([['', cell]], [{ condition: variable, message: 'm', enabled: true }]);
  for (const [cell, variable, url] of [
    [`g112:${DOC}`, 'g112', DOC],
    [`hello:${DOC}`, 'hello', DOC],
    [`a11y:${DOC}`, 'a11y', DOC],
    // Spacing the operator actually types. The colon is the separator, so
    // whitespace around it must not become part of the variable name.
    [`a11y: ${DOC}`, 'a11y', DOC],
    [`a11y:  ${DOC}`, 'a11y', DOC],
    [`a11y :${DOC}`, 'a11y', DOC],
    [`  hello:${DOC}  `, 'hello', DOC],
    [`G112:${DOC}`, 'g112', DOC],
    [`A11Y:${DOC}`, 'a11y', DOC],
  ]) {
    const got = pattern(cell, variable);
    eq(`cell ${JSON.stringify(cell)} → variable "${variable}" fires`, got.length, 1);
    eq(`  …and the link is the one in that cell`, got[0]?.url, url);
  }

  // The variable picks WHICH message. Same registry, three different cells.
  const three = [
    { condition: 'g112', message: 'G112 message: read {{link:the brief}}.', enabled: true },
    { condition: 'hello', message: 'Hello message.\nSecond line, see {{link:the advisory}}.', enabled: true },
    { condition: 'a11y', message: 'A11y message, no marker, details are available here.', enabled: true },
  ];
  for (const [variable, expectText, expectUrl] of [
    ['g112', 'the brief', 'https://example.com/g112'],
    ['hello', 'the advisory', 'https://example.com/hello'],
    ['a11y', 'here', 'https://example.com/a11y'],
  ]) {
    const got = resolveConditionalNotes([['', `${variable}:${expectUrl}`]], three);
    eq(`cell "${variable}:…" selects the "${variable}" message`, got.map((n) => n.condition), [variable]);
    const html = render(got);
    check(`  …and "${variable}" gets its own link on its own words`,
      html.includes(`<a href="${expectUrl}"`) && html.includes(`>${expectText}</a>`), html.slice(0, 400));
    check(`  …and only ${variable}'s message is used, not the other two`,
      !html.includes('G112 message') === (variable !== 'g112')
      && !html.includes('Hello message') === (variable !== 'hello'));
  }

  // A variable nobody registered must stay silent, or the pattern would fire on
  // any cell that merely looks like a URL.
  eq('a cell whose variable is not registered fires nothing',
    resolveConditionalNotes([['', `neverregistered:${DOC}`]], three).length, 0);
  eq('a plain URL with no variable is not a trigger',
    resolveConditionalNotes([['', DOC]], three).length, 0);

  // Whitespace and a trailing colon are the operator's typos, not new keywords.
  eq('"  G112:  " is stored as "g112"', db.normaliseNoteCondition('  G112:  '), 'g112');
  eq('  …and that form matches the same cell', resolveConditionalNotes([['g112:https://x.test']], [{ condition: '  G112:  ', message: 'm', enabled: true }]).length, 1);

  // Trailing whitespace with NO colon. Every other case above has a colon, and
  // the colon-strip absorbs trailing spaces anyway — so this is the only input
  // that tells trimming both ends apart from trimming just the front, and it is
  // an ordinary typo (the operator's cursor drifted before they hit Add).
  for (const k of ['G112  ', 'a11y\t', 'alsdjflaksf ']) {
    eq(`${JSON.stringify(k)} normalises to a matchable key`, db.normaliseNoteCondition(k), k.trim().toLowerCase());
    eq(`  …and still matches its own cell`,
      resolveConditionalNotes([[`${k.trim().toLowerCase()}:https://x.test`]],
        [{ condition: k, message: 'm', enabled: true }]).length, 1);
  }

  // The resolver repeats that normalisation so a raw registry entry cannot
  // normalise to a key that matches nothing. Two copies of one rule is only
  // safe while they agree — so pin the agreement rather than trusting it.
  const { normaliseNoteCondition: dbNorm } = db;
  for (const k of ['  G112:  ', 'A11Y', 'a11y:', 'ADA Review :', 'alsdjflaksf', '', '   ', 'a::',
    '  ADA Review', 'G112  ', 'a11y\t', 'g112  :  ', '\tg112\n']) {
    eq(`both normalisers agree on ${JSON.stringify(k)}`,
      resolveConditionalNotes([['x']], [{ condition: k, message: 'm', enabled: true }]),
      resolveConditionalNotes([['x']], [{ condition: dbNorm(k), message: 'm', enabled: true }]));
  }

  // End to end for the exact key the operator named: cell in, paragraph out.
  const e2e = render(resolveConditionalNotes(
    [[`g112:${DOC_URL}`]],
    [{ condition: 'g112', message: 'Please review {{link:the audit findings}} before launch.', enabled: true }],
  ));
  check('"g112" reaches the finished email with the cell link',
    e2e.includes(`Please review <a href="${DOC_URL}"`), e2e.slice(0, 500));
  eq('  …exactly one anchor', (e2e.match(/<a href=/g) || []).length, BASE_A + 1);
}

// ══════════════════════════════════════════════════════════════════════════════
section('db — isolation: the throwaway dir is what is under test');

{
  check('DATA_DIR redirected to the temp dir', db.DATA_DIR === fs.realpathSync(TMP_DATA) || db.DATA_DIR === TMP_DATA, db.DATA_DIR);
  check('DATA_DIR is NOT the live data dir', db.DATA_DIR !== path.resolve(LIVE_DATA), db.DATA_DIR);
  eq('the temp dir starts empty (nothing inherited from live)', fs.readdirSync(TMP_DATA), []);

  // Production must be unaffected: with the variable unset, db.js still points at
  // ./data. Verified in a child process so this module's env cannot lie about it.
  const { execFileSync } = await import('child_process');
  const childEnv = { ...process.env };
  delete childEnv.OFFICEOS_DATA_DIR;
  const dbUrl = pathToFileURL(path.join(ROOT, 'src', 'db.js')).href;
  const out = execFileSync(process.execPath, ['-e',
    `import('${dbUrl}').then(m => console.log(m.DATA_DIR))`,
  ], { env: childEnv, encoding: 'utf8' });
  check('unset → DATA_DIR is still the live ./data (production unchanged)',
    out.trim() === path.resolve(LIVE_DATA), out.trim());
}

section('db — validation, persistence, audit');

{
  // Validation
  let threw = '';
  try { db.createConditionalNote({ account: 'CW', condition: '   ', message: 'm' }); }
  catch (e) { threw = e.message; }
  check('blank condition rejected', /Condition is required/.test(threw), threw);

  threw = '';
  try { db.createConditionalNote({ account: 'CW', condition: 'k', message: '  ' }); }
  catch (e) { threw = e.message; }
  check('blank message rejected', /Message is required/.test(threw), threw);

  // Create + normalisation
  const note = db.createConditionalNote({
    account: 'cw', condition: '  A11Y  ', message: A11Y_MESSAGE, actor: 'Tester',
  });
  eq('condition normalised to lower-case trim', note.condition, 'a11y');
  eq('account normalised to upper-case', note.account, 'CW');
  eq('created with a stable id', typeof note.id, 'string');
  eq('defaults to enabled', note.enabled, true);
  check('timestamps present', Boolean(note.createdAt && note.updatedAt));

  // Read back through the real getter, filtered by account
  const cw = db.getConditionalNotes({ account: 'CW' });
  check('readable via getConditionalNotes', cw.some((n) => n.id === note.id));
  eq('RM does not see the CW note', db.getConditionalNotes({ account: 'RM' }).some((n) => n.id === note.id), false);

  // Duplicate condition in the same account
  threw = '';
  try { db.createConditionalNote({ account: 'CW', condition: 'a11y', message: 'other' }); }
  catch (e) { threw = e.message; }
  check('duplicate condition in the same account rejected', /already exists/.test(threw), threw);
  check('…and a same-named note on the OTHER account is fine',
    Boolean(db.createConditionalNote({ account: 'RM', condition: 'a11y', message: 'RM wording' })));

  // enabledOnly
  db.updateConditionalNote(note.id, { enabled: false }, { actor: 'Tester' });
  eq('enabledOnly filter hides it', db.getConditionalNotes({ account: 'CW', enabledOnly: true }).some((n) => n.id === note.id), false);
  check('unfiltered read still sees it', db.getConditionalNotes({ account: 'CW' }).some((n) => n.id === note.id));
  db.updateConditionalNote(note.id, { enabled: true }, { actor: 'Tester' });

  // Update is audited with before/after
  const before = db.getAuditLog(1000).length;
  db.updateConditionalNote(note.id, { message: 'CHANGED here' }, { actor: 'Tester' });
  eq('message updated', db.getConditionalNoteById(note.id).message, 'CHANGED here');
  const entry = db.getAuditLog(1000)[0];
  eq('latest audit action', entry.action, 'conditional-note:update');
  eq('audit entity', entry.entity, 'email-conditional-note');
  eq('audit entityId', entry.entityId, note.id);
  eq('audit actor', entry.actor, 'Tester');
  check('audit records the old value', String(entry.oldValue).includes('here')
    && !String(entry.oldValue).includes('CHANGED here'), entry.oldValue);
  check('audit records the new value', String(entry.newValue).includes('CHANGED here'), entry.newValue);
  check('audit log grew', db.getAuditLog(1000).length > before);

  // No-op update writes no audit entry
  const lenBefore = db.getAuditLog(1000).length;
  db.updateConditionalNote(note.id, { message: 'CHANGED here' }, { actor: 'Tester' });
  eq('a no-op update writes no audit entry', db.getAuditLog(1000).length, lenBefore);

  // Missing id
  threw = '';
  try { db.updateConditionalNote('does-not-exist', { message: 'x' }); }
  catch (e) { threw = e.message; }
  check('update of a missing id throws', /not found/.test(threw), threw);

  // Delete is audited
  eq('delete returns true', db.deleteConditionalNote(note.id, { actor: 'Tester' }), true);
  eq('delete entry audited', db.getAuditLog(1000)[0].action, 'conditional-note:delete');
  eq('delete of a missing id returns false', db.deleteConditionalNote(note.id, { actor: 'Tester' }), false);
  eq('note is gone', db.getConditionalNoteById(note.id), null);

  // End-to-end: what the DB stores is what the email renders
  const live = db.createConditionalNote({ account: 'CW', condition: 'a11y', message: A11Y_MESSAGE });
  const resolved = resolveConditionalNotes(REAL_ROWS, db.getConditionalNotes({ account: 'CW', enabledOnly: true }));
  eq('stored note resolves from the real grid', resolved.length, 1);
  const finalHtml = render(resolved);
  check('stored note renders the real link', finalHtml.includes(DOC_URL));
  db.deleteConditionalNote(live.id);

  // Idempotence: the whole db section can run repeatedly without accumulating.
  const countNow = db.getConditionalNotes({ account: 'CW' }).length;
  const note2 = db.createConditionalNote({ account: 'CW', condition: 'a11y', message: A11Y_MESSAGE });
  eq('re-creating the same condition works after the previous one was deleted',
    db.getConditionalNotes({ account: 'CW' }).length, countNow + 1);
  db.deleteConditionalNote(note2.id);
}


// ══════════════════════════════════════════════════════════════════════════════
section('db — the condition keyword is normalised, and the two slips are refused');

{
  eq('mixed case and spaces normalise', db.normaliseNoteCondition('  A11Y  '), 'a11y');
  eq('a trailing colon is stripped (the obvious slip)', db.normaliseNoteCondition('a11y:'), 'a11y');
  eq('  …several trailing colons too', db.normaliseNoteCondition('a11y::'), 'a11y');
  eq('  …with a space before the colon', db.normaliseNoteCondition('  ADA Review : '), 'ada review');
  eq('an ordinary keyword is untouched', db.normaliseNoteCondition('Link'), 'link');
  eq('a hyphenated keyword survives', db.normaliseNoteCondition('sec-fix'), 'sec-fix');

  // Pasting the whole cell into the Condition box is the other obvious slip. It
  // would store happily and then never match anything.
  let refused = null;
  const countBefore = db.getConditionalNotes().length;
  try { db.createConditionalNote({ condition: 'a11y:https://example.com', message: 'm' }); }
  catch (e) { refused = e.message; }
  check('a condition containing a full URL is refused', refused !== null);
  check('  …and the error says what to do instead', /keyword only/i.test(refused || ''), refused);
  eq('  …and the refused row was not stored', db.getConditionalNotes().length, countBefore);

  // The stripped-colon form must actually register and match.
  const made = db.createConditionalNote({ condition: '  Ad-hoc-Notice:  ', message: 'See {{link:the doc}}.', account: 'CW' });
  eq('"  Ad-hoc-Notice:  " registers as "ad-hoc-notice"', made.condition, 'ad-hoc-notice');
  eq('  …and matches its own cell',
    resolveConditionalNotes([['ad-hoc-notice:https://example.com']], [made])[0]?.url, 'https://example.com/');
}

// ══════════════════════════════════════════════════════════════════════════════
section('both sheets — one note can cover CW and RM at once');

{
  // The operator's request: an option to put the same message on both sheets,
  // rather than registering it twice and hoping the copies stay in step.
  const BOTH = 'sheets-both';
  const CW_ONLY = 'sheets-cw';
  const RM_ONLY = 'sheets-rm';
  const MSG = 'Shared message for both sheets: see {{link:the notice}}.';
  const cell = (k) => [['', `${k}:https://example.com/doc`]];

  // ── one action, one record per sheet ───────────────────────────────────────
  const made = db.setConditionalNoteForAccounts({ accounts: ['CW', 'RM'], condition: BOTH, message: MSG });
  eq('one action reports both sheets', made.accounts, ['CW', 'RM']);
  eq('  …and created one record per sheet', made.created.length, 2);
  eq('  …nothing needed updating the first time', made.updated.length, 0);
  eq('  …the two records have different ids (stable, per sheet)', made.created[0].id !== made.created[1].id, true);
  eq('  …and identical messages', made.created.map((n) => n.message), [MSG, MSG]);
  eq('CW sees only its own record', db.getConditionalNotes({ account: 'CW' }).map((n) => n.condition).includes(BOTH), true);
  eq('RM sees only its own record', db.getConditionalNotes({ account: 'RM' }).map((n) => n.condition).includes(BOTH), true);
  eq('  …CW is not handed RM\'s record',
    db.getConditionalNotes({ account: 'CW' }).filter((n) => n.condition === BOTH).length, 1);
  eq('  …RM is not handed CW\'s record',
    db.getConditionalNotes({ account: 'RM' }).filter((n) => n.condition === BOTH).length, 1);

  // ── the isolation that actually matters: a sheet only ever fires its own ──
  for (const acct of ['CW', 'RM']) {
    const own = resolveConditionalNotes(cell(BOTH), db.getConditionalNotes({ account: acct, enabledOnly: true }));
    eq(`${acct} fires its own message`, own.map((n) => n.message), [MSG]);
    eq(`  …with the link from its own cell`, own[0]?.url, 'https://example.com/doc');
  }
  const cwHtml = buildEmail({
    websiteUrl: 'cw-site.test', reportMonth: { monthLower: 'september', year: 2026 },
    reportHtml: '<p>r</p>', hasAdditionalIssues: false, hasPremiumPlugins: false,
    conditionalNotes: resolveConditionalNotes(cell(BOTH), db.getConditionalNotes({ account: 'CW', enabledOnly: true })),
  }).html;
  check('the CW email shows the message', cwHtml.includes('Shared message for both sheets'), cwHtml.slice(0, 300));

  // A condition that exists on CW only must not reach an RM email. This is the
  // whole reason the fan-out writes one record per sheet instead of a single
  // "ALL" record.
  db.setConditionalNoteForAccounts({ accounts: ['CW'], condition: CW_ONLY, message: 'CW only message.' });
  const rmSees = resolveConditionalNotes(cell(CW_ONLY), db.getConditionalNotes({ account: 'RM', enabledOnly: true }));
  eq('a CW-only condition does NOT fire for RM', rmSees.length, 0);
  eq('  …but does fire for CW',
    resolveConditionalNotes(cell(CW_ONLY), db.getConditionalNotes({ account: 'CW', enabledOnly: true })).length, 1);

  // ── running it again must not duplicate or throw ───────────────────────────
  const before = db.getConditionalNotes().length;
  const again = db.setConditionalNoteForAccounts({ accounts: ['CW', 'RM'], condition: BOTH, message: MSG });
  eq('re-running the same action updates rather than duplicating', again.created.length, 0);
  eq('  …both records were updated', again.updated.length, 2);
  eq('  …and no record was added', db.getConditionalNotes().length, before);

  // ── one edit reaches every ticked sheet: no drift ──────────────────────────
  const MSG2 = 'Reworded once for both sheets: see {{link:the notice}}.';
  db.setConditionalNoteForAccounts({ accounts: ['CW', 'RM'], condition: BOTH, message: MSG2 });
  const both = db.getConditionalNotes().filter((n) => n.condition === BOTH);
  eq('an edit changed both sheets together', both.map((n) => n.message), [MSG2, MSG2]);
  eq('  …the two records are still distinct rows', new Set(both.map((n) => n.id)).size, 2);

  // ── ticking one sheet must not remove the other ───────────────────────────
  const rmBefore = db.getConditionalNotes({ account: 'RM' }).find((n) => n.condition === BOTH);
  db.setConditionalNoteForAccounts({ accounts: ['CW'], condition: BOTH, message: MSG2 });
  const rmAfter = db.getConditionalNotes({ account: 'RM' }).find((n) => n.condition === BOTH);
  eq('unticking a sheet and saving leaves that sheet untouched', rmAfter?.id, rmBefore?.id);
  eq('  …still with its message', rmAfter?.message, MSG2);

  // ── input handling ─────────────────────────────────────────────────────────
  let threw = null;
  try { db.setConditionalNoteForAccounts({ accounts: [], condition: 'x', message: 'm' }); }
  catch (e) { threw = e.message; }
  check('no sheets ticked is refused', threw !== null, threw);
  threw = null;
  try { db.setConditionalNoteForAccounts({ accounts: ['', '  '], condition: 'x', message: 'm' }); }
  catch (e) { threw = e.message; }
  check('blank sheet names are refused rather than silently defaulting to CW', threw !== null, threw);

  // Lower case and repeats are the obvious way to send the list twice.
  const dupes = db.setConditionalNoteForAccounts({ accounts: ['cw', 'CW', 'rm'], condition: 'sheets-dedupe', message: 'once' });
  eq('a repeated, mixed-case sheet list produces one record per sheet', dupes.created.map((n) => n.account), ['CW', 'RM']);
  // The panel renders the returned sheet list back to the operator, so it has to
  // be the sheets that were actually touched, not the strings as typed. Without
  // this, dropping the upper-casing here looks harmless — the writes still land
  // on CW and RM, because the CRUD below normalises on its own — while the
  // response claims three sheets were changed.
  eq('  …and the reported sheet list is the sheets actually touched', dupes.accounts, ['CW', 'RM']);

  // A bad condition must be refused BEFORE the first sheet is written, or a
  // typo would leave the two sheets in different states.
  const countPre = db.getConditionalNotes().length;
  threw = null;
  try { db.setConditionalNoteForAccounts({ accounts: ['CW', 'RM'], condition: 'bad:https://example.com', message: 'm' }); }
  catch (e) { threw = e.message; }
  check('a bad condition is refused', threw !== null, threw);
  eq('  …and NOT one sheet was written before the refusal', db.getConditionalNotes().length, countPre);

  // ── audit: one truthful entry per record, per action ───────────────────────
  const log = db.getAuditLog ? db.getAuditLog() : JSON.parse(fs.readFileSync(path.join(DATA, 'audit-log.json'), 'utf8'));
  const forNote = log.filter((e) => String(e.action || '').startsWith('conditional-note:'));
  const bothEntries = forNote.filter((e) => e.label === `CW "${BOTH}"` || e.label === `RM "${BOTH}"`);
  check('every change to a both-sheet note is audited per sheet', bothEntries.length >= 4, `${bothEntries.length} entries`);
  check('  …and the labels name the sheet',
    bothEntries.every((e) => /^CW "/.test(e.label) || /^RM "/.test(e.label)),
    JSON.stringify([...new Set(bothEntries.map((e) => e.label))]));
}

// ══════════════════════════════════════════════════════════════════════════════
section('live data/ was never touched');

{
  let changed = [];
  for (const [f, hash] of liveBefore) {
    const p = path.join(LIVE_DATA, f);
    if (!fs.existsSync(p)) { changed.push(`${f} (deleted)`); continue; }
    const now = crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
    if (now !== hash) changed.push(`${f} (modified)`);
  }
  for (const f of fs.readdirSync(LIVE_DATA)) {
    if (f.endsWith('.json') && !liveBefore.has(f)) changed.push(`${f} (created)`);
  }
  eq('every live data file is byte-identical to before the suite ran', changed, []);
  check(`(hashed ${liveBefore.size} live files)`, liveBefore.size > 0, String(liveBefore.size));

  fs.rmSync(TMP_DATA, { recursive: true, force: true });
}

// ══════════════════════════════════════════════════════════════════════════════
section('wiring — both send paths detect and pass the notes');

{
  const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

  const dash = read('src/dashboardApi.js');
  check('dashboardApi imports resolveConditionalNotes', /import\s*\{[^}]*resolveConditionalNotes[^}]*\}\s*from\s*'\.\/reportUtils\.js'/.test(dash));
  check('dashboardApi imports getConditionalNotes', /import\s*\{\s*getConditionalNotes\s*\}\s*from\s*'\.\/db\.js'/.test(dash));
  check('dashboardApi passes conditionalNotes into buildEmail',
    (dash.match(/conditionalNotes,/g) || []).length >= 2);
  check('dashboardApi resolves notes per account',
    /resolveConditionalNotes\(\s*reportRows,\s*getConditionalNotes\(\{\s*account:/.test(dash));
  check('dashboardApi surfaces which conditions fired', /sourceCell: n\.sourceCell/.test(dash));

  const cli = read('src/index.js');
  check('CLI send path imports resolveConditionalNotes', /resolveConditionalNotes/.test(cli));
  check('CLI send path imports getConditionalNotes', /getConditionalNotes/.test(cli));
  check('CLI send path passes conditionalNotes into buildEmail', /conditionalNotes,/.test(cli));

  const srv = read('src/server.js');
  check('server exposes the registry routes',
    srv.includes("'/api/conditional-notes'") && srv.includes("'/api/conditional-notes/update'")
    && srv.includes("'/api/conditional-notes/delete'"));
  check('server routes do not invent an auth helper',
    !/isAdminRole|roleOf\(/.test(srv));
  check('server routes attribute the actor via actorFrom', /actorFrom\(req, body, reqUrl\)/.test(srv));

  const dbSrc = read('src/db.js');
  check('db.js exports the registry helpers',
    ['getConditionalNotes', 'createConditionalNote', 'updateConditionalNote', 'deleteConditionalNote']
      .every((f) => new RegExp(`export function ${f}\\b`).test(dbSrc)));
  check('db.js writes are audited', (dbSrc.match(/conditional-note:(create|update|delete)/g) || []).length >= 3);
}

// ══════════════════════════════════════════════════════════════════════════════
console.log(`\n${'═'.repeat(66)}`);
console.log(`  ${pass} passed, ${failures.length} failed`);
if (failures.length) {
  console.log('\n  FAILURES:');
  for (const f of failures) console.log(`    - ${f}`);
}
process.exit(failures.length ? 1 : 0);
