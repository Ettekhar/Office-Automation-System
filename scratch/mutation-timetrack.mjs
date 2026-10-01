/**
 * E22 mutation harness — the new Time Track suites must actually bite.
 *
 * Three files are mutated: the column resolver in src/reportUtils.js, the read in
 * src/dashboardApi.js, and the href rule in public/app.js. Each target keeps its own
 * pristine source and its own EOL style (the sources disagree: reportUtils.js and
 * dashboardApi.js are CRLF, app.js is LF) and is restored after EVERY mutant, so a
 * throw on one cannot leave the tree dirty for the next.
 */
import fs from 'fs';
import { execFileSync } from 'child_process';

const DASH = 'src/dashboardApi.js';
const APP = 'public/app.js';

// Each mutated file is a target with its own pristine source, restored after
// every single mutant rather than only at the end. Each also records its own EOL
// style: dashboardApi.js and reportUtils.js are CRLF, app.js is LF, so a single
// shared line-ending would make every anchor in one of them miss.
const TARGETS = {};
for (const f of [DASH, APP, 'src/reportUtils.js']) {
  const src = fs.readFileSync(f, 'utf8');
  TARGETS[f] = { src, crlf: src.includes('\r\n') };
}
const orig = TARGETS[DASH].src;

// A no-op at splice time; the real EOL fix happens per mutant below.
const L = (s) => s;
const eol = (file) => (TARGETS[file].crlf ? '\r\n' : '\n');
const fit = (file, s) => s.replace(/\n/g, eol(file));

const MUTANTS = [
  // ── public/app.js: the browser-side href rule ──────────────────────────────
  {
    file: 'public/app.js',
    // The real mistake this guards against: a pure regex allowlist, with the
    // parser's verdict discarded. "javascript:alert(1)" cannot slip past /^https?:/
    // either, but "HTTPS://ok" cannot slip past a case-SENSITIVE /^https?:/ — and
    // neither can a value the parser rejects for a reason no regex knows about.
    label: 'the href rule becomes a case-sensitive regex allowlist, parser ignored',
    from: L(`  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';`),
    to: L(`  if (!/^https?:/.test(text)) return '';`),
  },
  {
    file: 'public/app.js',
    label: 'the protocol check only allows https, dropping http',
    from: L(`  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';`),
    to: L(`  if (parsed.protocol !== 'https:') return '';`),
  },
  {
    file: 'public/app.js',
    label: 'the href rule accepts anything the URL parser can read',
    from: L(`  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';`),
    to: L(`  if (!parsed.protocol) return '';`),
  },
  {
    file: 'public/app.js',
    label: 'a parse failure returns the raw value instead of nothing',
    from: L(`  } catch {
    return '';
  }
  if (parsed.protocol !== 'http:'`),
    to: L(`  } catch {
    return text;
  }
  if (parsed.protocol !== 'http:'`),
  },
  {
    file: 'public/app.js',
    // NB: removing the .trim() on its own is a NO-OP — the URL parser strips
    // surrounding whitespace itself — so that is not a mutation worth testing.
    // This one is detectable: the raw text is returned instead of the parser's
    // normalised form.
    label: 'the raw text is returned instead of the parser-normalised URL',
    from: L(`  return parsed.toString();`),
    to: L(`  return text;`),
  },
  {
    file: 'public/app.js',
    label: 'target="_blank" loses rel="noopener" (reverse tabnabbing)',
    from: L(`rel="noopener noreferrer"`),
    to: L(`rel=""`),
  },

  // ── src/reportUtils.js: the resolver this column depends on ────────────────
  {
    file: 'src/reportUtils.js',
    label: 'detectColumns stops mapping the time-track column (always -1)',
    from: L(`    TIME_TRACK_URL: at('clickupTimeTrackUrl', -1),`),
    to: L(`    TIME_TRACK_URL: -1,`),
  },
  {
    file: 'src/reportUtils.js',
    label: 'the time-track column is hardcoded to 7 in the resolver',
    from: L(`    TIME_TRACK_URL: at('clickupTimeTrackUrl', -1),`),
    to: L(`    TIME_TRACK_URL: 7,`),
  },
  {
    file: 'src/reportUtils.js',
    label: 'at() ignores the resolved index and returns the fallback',
    from: L(`    return typeof idx === 'number' && idx >= 0 ? idx : fallback;`),
    to: L(`    return fallback;`),
  },

  // ── src/dashboardApi.js: where the value is read and put on the site ───────
  {
    label: 'the resolved index is replaced by a hardcoded 7',
    from: L(`row[cols.TIME_TRACK_URL]`),
    to: L(`row[7]`),
  },
  {
    label: 'the value is not trimmed, so a padded cell renders a broken link',
    from: L(`    const timeTrackUrl = String(row[cols.TIME_TRACK_URL] ?? '').trim();`),
    to: L(`    const timeTrackUrl = String(row[cols.TIME_TRACK_URL] ?? '');`),
  },
  {
    label: 'the field is no longer on the site object',
    from: L(`      clientNote,
      timeTrackUrl,`),
    to: L(`      clientNote,`),
  },
  {
    label: 'the resolved index reads the NEXT column (off-by-one)',
    from: L(`row[cols.TIME_TRACK_URL]`),
    to: L(`row[cols.TIME_TRACK_URL + 1]`),
  },
  {
    label: 'the wrong column key is used (report url, not time track)',
    from: L(`row[cols.TIME_TRACK_URL]`),
    to: L(`row[cols.REPORT_URL]`),
  },
];

const SUITES = [
  'scratch/verify-timetrack-column.mjs',
  'scratch/verify-timetrack-live.mjs',
  'scratch/verify-timetrack-href.mjs',
];

const run = (suite) => {
  try {
    execFileSync('node', [suite], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return true;   // exited 0 => suite did not notice
  } catch {
    return false;  // non-zero => suite noticed
  }
};

// Caught means AT LEAST ONE suite failed. A mutant that only one of the two
// suites notices is still caught — the "still green in" list is reported so a
// suite that is too weak to see it on its own is visible, not hidden.
let survived = 0, judged = 0;
for (const m of MUTANTS) {
  const file = m.file || DASH;
  const target = TARGETS[file];
  if (!target) { console.log(`  NO-TARGET  ${file}`); survived++; continue; }
  // Fit the anchor to this file's own line endings before looking for it.
  const from = fit(file, m.from);
  const to = fit(file, m.to);
  if (!target.src.includes(from)) {
    console.log(`  ANCHOR-MISS  ${m.label}  (${file}, crlf=${target.crlf})`);
    survived++;
    continue;
  }
  const before = target.src;
  fs.writeFileSync(file, before.replace(from, to));
  judged++;
  const green = SUITES.filter(run);
  if (green.length === SUITES.length) {
    console.log(`  SURVIVED  ${m.label}   (green in all suites)`);
    survived++;
  } else if (green.length) {
    console.log(`  caught  ${m.label}   (only by: ${SUITES.filter((s) => !green.includes(s)).map((s) => s.split('/').pop()).join(', ')})`);
  } else {
    console.log(`  caught  ${m.label}`);
  }
  fs.writeFileSync(file, before);   // restore this target after every mutant
}

for (const [file, t] of Object.entries(TARGETS)) {
  fs.writeFileSync(file, t.src);
  console.log(`  ${fs.readFileSync(file, 'utf8') === t.src ? 'restored' : 'RESTORE FAILED'}  ${file}`);
}
console.log(survived ? `\n${survived} mutation(s) not judged` : '\nall mutations caught');
