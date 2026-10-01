/**
 * E22 — the browser-side href rule.
 *
 * The value comes from a sheet cell, and a cell is data, not code. `escapeHtml`
 * does NOT make a value safe in an href: "javascript:alert(1)" is perfectly
 * escapable and still executes on click. The rule under test is the SAME one the
 * server already uses in safeExternalUrl() — http/https or nothing.
 *
 * app.js cannot be imported (it touches document/window at load), so the function
 * is read out of the shipped file and evaluated here. If someone changes the
 * function, this picks up the change rather than testing a copy of it.
 */
import fs from 'fs';
import assert from 'assert';

const SRC = fs.readFileSync('public/app.js', 'utf8');

// Pull the real function out of the served file rather than restating it.
const start = SRC.indexOf('function safeExternalUrl');
if (start === -1) throw new Error('public/app.js no longer defines safeExternalUrl');
const open = SRC.indexOf('{', start);
let depth = 0, end = open;
for (let i = open; i < SRC.length; i++) {
  if (SRC[i] === '{') depth++;
  else if (SRC[i] === '}') { depth--; if (!depth) { end = i; break; } }
}
const source = SRC.slice(start, end + 1);
// eslint-disable-next-line no-new-func
const safeExternalUrl = new Function(`return (${source})`)();

let pass = 0, fail = 0;
const eq = (label, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; console.log(`  ok     ${label}`); }
  else { fail++; console.log(`  FAIL   ${label}\n           got  ${g}\n           want ${w}`); }
};
const check = (label, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ok     ${label}`); }
  else { fail++; console.log(`  FAIL   ${label}${extra ? `\n           ${extra}` : ''}`); }
};

console.log('the real function was extracted from public/app.js');
eq('it is a function', typeof safeExternalUrl, 'function');

// The href is written in a template literal in app.js, not in the function, so
// assert that markup too. A bare target="_blank" lets the opened page reach back
// through window.opener, which is why rel="noopener" is not optional.
console.log('the rendered anchor markup');
const anchorTemplate = SRC.match(/<a href="\$\{escapeHtml\(timeTrackHref\)\}"[^`]*`/);
eq('an anchor was found in app.js', Boolean(anchorTemplate), true);
const anchorSrc = anchorTemplate ? anchorTemplate[0] : '';
check('it only opens a new tab, it does not navigate the dashboard away',
  /target="_blank"/.test(anchorSrc), anchorSrc);
check('rel="noopener" is present', /rel="noopener/.test(anchorSrc), anchorSrc);
check('noreferrer is present too', /noreferrer/.test(anchorSrc), anchorSrc);
check('the href goes through escapeHtml, never raw',
  /href="\$\{escapeHtml\(timeTrackHref\)\}"/.test(anchorSrc), anchorSrc);
check('the title is escaped as well', /title="\$\{escapeHtml\(timeTrackHref\)\}"/.test(anchorSrc), anchorSrc);

console.log('a real ClickUp link survives');
eq('plain https', safeExternalUrl('https://app.clickup.com/t/10554421/868b8tgd5'),
  'https://app.clickup.com/t/10554421/868b8tgd5');
eq('with surrounding spaces', safeExternalUrl('  https://app.clickup.com/t/868b8tgd5  '),
  'https://app.clickup.com/t/868b8tgd5');
eq('http as well as https', safeExternalUrl('http://example.com/a'), 'http://example.com/a');
eq('a long docs link', safeExternalUrl('https://docs.google.com/document/d/ABC/edit?tab=t.0#heading=h.x'),
  'https://docs.google.com/document/d/ABC/edit?tab=t.0#heading=h.x');

console.log('a script URL is not a link, however it is spelled');
for (const bad of [
  'javascript:alert(1)',
  'JaVaScRiPt:alert(1)',
  '  javascript:alert(1)  ',
  // Leading control characters are stripped by the URL parser, so a rule that
  // pattern-matches the raw text would wave these through.
  '\tjavascript:alert(1)',
  '\njavascript:alert(1)',
  ' javascript:alert(1)',
  '\u0000javascript:alert(1)',
  'javascript:void(0)',
  'data:text/html,<script>alert(1)</script>',
  'data:text/html;base64,PHNjcmlwdD4=',
  'vbscript:msgbox(1)',
]) {
  eq(`refused: ${JSON.stringify(bad)}`, safeExternalUrl(bad), '');
}

console.log('other local schemes are refused too');
for (const bad of ['file:///etc/passwd', 'file:///C:/Windows/System32/drivers/etc/hosts']) {
  eq(`refused: ${bad}`, safeExternalUrl(bad), '');
}

console.log('a blank or unusable cell is blank, not a guess');
for (const bad of ['', '   ', null, undefined, 'not a url at all', 'app.clickup.com/t/868b8tgd5', '//app.clickup.com/x']) {
  eq(`blank: ${JSON.stringify(bad)}`, safeExternalUrl(bad), '');
}

console.log('the browser URL parser is the one that decides, not a regex');
// A regex allowlist is the usual mistake here. These inputs show why the
// parser's own verdict is the one that has to be returned: the regex and the
// parser disagree about the scheme, and the parser is the one the browser obeys.
eq('a bare host gets the scheme the parser adds',
  safeExternalUrl('https://app.clickup.com'), 'https://app.clickup.com/');
eq('the returned value is the parser-normalised form, not the raw text',
  safeExternalUrl('https://app.clickup.com/a/../b'), 'https://app.clickup.com/b');
eq('  …and it is the text a hand-typed regex would get wrong',
  safeExternalUrl('HTTPS://ok.test').startsWith('https://'), true);
eq('the protocol check admits http as well as https',
  safeExternalUrl('http://ok.test/p').startsWith('http://'), true);
// "/../evil.com" keeps the string "evil.com" but stays on the original host —
// the origin, not the substring, is what matters.
const traversal = safeExternalUrl('https://app.clickup.com/../evil.com');
eq('  …and a traversal cannot change the origin',
  new URL(traversal).origin, 'https://app.clickup.com');
eq('  …even though the path still reads "evil.com"', traversal.includes('evil.com'), true);

console.log('\n' + (fail ? 'FAILED' : 'passed') + ` ${pass} passed, ${fail} failed`);
assert.equal(fail, 0, `${fail} failing`);
