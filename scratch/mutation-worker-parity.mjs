/**
 * Mutation harness for scratch/verify-worker-parity.mjs
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A parity suite that agrees with a broken planner proves nothing. Each mutation
 * below is a realistic mistake someone could make to the Worker's planner — a
 * guard deleted, a column index nudged, two guards swapped — and every one of
 * them must make the suite FAIL.
 *
 * Rules this harness holds itself to:
 *   - an anchor must appear EXACTLY ONCE in the target, otherwise the mutation
 *     is reported as a harness error rather than silently skipped
 *   - the target is restored and its SHA-256 compared afterwards, so a failed run
 *     cannot leave a mutated worker behind
 *   - the CLI half of the suite is never mutated: src/index.js is the product,
 *     and this harness has no business editing it
 */

import { spawnSync } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const TARGET = path.join(REPO, 'cloudflare-worker', 'mailer-worker.js');
const SUITE = path.join(REPO, 'scratch', 'verify-worker-parity.mjs');

const original = fs.readFileSync(TARGET, 'utf8');
const eol = original.includes('\r\n') ? '\r\n' : '\n';
const sha = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');
const ORIGINAL_SHA = sha(original);

const MUTATIONS = [
  {
    id: 'M1',
    name: 'time-track column read one to the right (the Task link)',
    from: "time_track_url: String(row[cols.TIME_TRACK_URL] ?? '').trim(),",
    to: "time_track_url: String(row[cols.TIME_TRACK_URL + 1] ?? '').trim(),",
  },
  {
    id: 'M2',
    name: 'the "no matching report tab" guard deleted',
    from: 'if (!matchedTab) {',
    to: 'if (false) {',
  },
  {
    id: 'M3',
    name: 'the "no contact email" guard deleted',
    from: 'if (recipients.length === 0) {',
    to: 'if (false) {',
  },
  {
    id: 'M4',
    name: 'URL validity check reduced to a blank check',
    // Anchored with the following guard: the same one-line check also appears in
    // buildOverview(), and a two-occurrence anchor is a harness bug, not a test.
    from: [
      'if (!websiteUrl || !isValidWebsiteUrl(websiteUrl)) continue;',
      '',
      '    if (!isActive(row[cols.STATUS])) {',
    ].join('\n'),
    to: [
      'if (!websiteUrl) continue;',
      '',
      '    if (!isActive(row[cols.STATUS])) {',
    ].join('\n'),
  },
  {
    id: 'M5',
    name: '"is this month done" loosened to "is the cell non-empty"',
    from: 'if (!isMarkedDone(row[monthCol], DONE_MARKER)) {',
    to: 'if (!String(row[monthCol] ?? "").trim()) {',
  },
  {
    id: 'M6',
    name: 'recipients read from the A/C Manager column',
    // Also present in buildOverview(); anchored on the guard that follows it here.
    from: [
      'const recipients = parseContacts(row[cols.CONTACT]);',
      '    if (recipients.length === 0) {',
    ].join('\n'),
    to: [
      'const recipients = parseContacts(row[cols.AM]);',
      '    if (recipients.length === 0) {',
    ].join('\n'),
  },
  {
    id: 'M7',
    name: 'the "inactive" guard deleted',
    from: 'if (!isActive(row[cols.STATUS])) {',
    to: 'if (false) {',
  },
  {
    id: 'M8',
    name: 'status and month guards swapped in order',
    from: [
      '    if (!isActive(row[cols.STATUS])) {',
      "      skipped.push({ websiteUrl, reason: 'inactive' });",
      '      continue;',
      '    }',
      '    if (!isMarkedDone(row[monthCol], DONE_MARKER)) {',
      "      skipped.push({ websiteUrl, reason: 'month cell not marked done' });",
      '      continue;',
      '    }',
    ].join('\n'),
    to: [
      '    if (!isMarkedDone(row[monthCol], DONE_MARKER)) {',
      "      skipped.push({ websiteUrl, reason: 'month cell not marked done' });",
      '      continue;',
      '    }',
      '    if (!isActive(row[cols.STATUS])) {',
      "      skipped.push({ websiteUrl, reason: 'inactive' });",
      '      continue;',
      '    }',
    ].join('\n'),
  },
];

// The file is written with whatever EOL it already has; normalise the anchors so a
// CRLF file cannot produce a silent no-op mutation.
const norm = (s) => s.replace(/\r\n/g, '\n');

let pass = 0;
const problems = [];

console.log('\n── mutation harness: cloudflare-worker/mailer-worker.js ──\n');

for (const m of MUTATIONS) {
  // An array here would be coerced by String.prototype.split into a comma-joined
  // string, matching nothing and looking exactly like a surviving mutant. Refuse
  // it outright rather than let it pass as a result.
  if (typeof m.from !== 'string' || typeof m.to !== 'string') {
    problems.push(`${m.id} HARNESS ERROR: from/to must be strings, got ${typeof m.from}/${typeof m.to}`);
    console.log(`  ? ${m.id}  non-string anchor — HARNESS ERROR, not counted`);
    continue;
  }

  const hay = norm(original);
  const from = norm(m.from);
  const to = norm(m.to);

  const occurrences = hay.split(from).length - 1;
  if (occurrences !== 1) {
    problems.push(`${m.id} HARNESS ERROR: anchor matched ${occurrences} times (must be exactly 1) — ${m.name}`);
    console.log(`  ? ${m.id}  anchor matched ${occurrences}x — HARNESS ERROR, not counted`);
    continue;
  }

  const mutated = hay.replace(from, to).replace(/\n/g, eol);
  fs.writeFileSync(TARGET, mutated, 'utf8');

  const res = spawnSync(process.execPath, [SUITE], { cwd: REPO, encoding: 'utf8' });
  const out = `${res.stdout || ''}${res.stderr || ''}`;
  const failed = res.status !== 0;

  // Restore before deciding anything, so a crash cannot leave a mutant behind.
  fs.writeFileSync(TARGET, original, 'utf8');

  if (failed) {
    pass++;
    const tally = (out.match(/(\d+)\/(\d+)\s*$/m) || [])[0] || '(no tally)';
    console.log(`  ok  ${m.id}  caught — suite went red (${tally.trim()})  ${m.name}`);
  } else {
    problems.push(`${m.id} SURVIVED: the suite still passed with this mutation — ${m.name}`);
    console.log(`  XX  ${m.id}  SURVIVED — the suite cannot see this bug  ${m.name}`);
  }
}

// The tree must be exactly as we found it.
const now = fs.readFileSync(TARGET, 'utf8');
if (sha(now) !== ORIGINAL_SHA) {
  problems.push('TARGET NOT RESTORED: mailer-worker.js differs from its original bytes');
  console.log('\n  XX  mailer-worker.js was NOT restored byte-for-byte');
} else {
  console.log(`\n  target restored, sha256 ${ORIGINAL_SHA.slice(0, 16)}…`);
}

if (problems.length) {
  console.log('\nPROBLEMS');
  for (const p of problems) console.log(`  x ${p}`);
}
console.log(`\n${pass}/${MUTATIONS.length} mutations caught`);
process.exit(problems.length ? 1 : 0);
