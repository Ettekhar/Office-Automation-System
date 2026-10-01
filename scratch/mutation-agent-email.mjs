/**
 * Mutation harness for scratch/verify-agent-email.mjs
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The claim under test is "the agent does not change the email". These mutations
 * are the ways that claim could become false in practice: a month object built
 * with the wrong field name, a narrower report range, recipients dropped in the
 * handoff, a workspace hardcoded, a ClickUp dry run reported as a real close, and
 * the resolved notes left out of the template.
 *
 * Same contract as the other harnesses: anchors must land exactly once, every
 * mutant must turn the suite red, and the target must come back byte-identical.
 */

import { spawnSync } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const TARGET = path.join(REPO, 'src', 'localMailAgent.js');
const SUITE = path.join(REPO, 'scratch', 'verify-agent-email.mjs');

const original = fs.readFileSync(TARGET, 'utf8');
const eol = original.includes('\r\n') ? '\r\n' : '\n';
const sha = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');
const ORIGINAL_SHA = sha(original);
const norm = (s) => s.replace(/\r\n/g, '\n');

const MUTATIONS = [
  {
    id: 'M1',
    name: 'the month object is built with the wrong field name (subject reads "undefined")',
    from: 'const reportMonth = { monthName: job.month, monthLower: job.monthLower, year: Number(job.year) };',
    to: 'const reportMonth = { month: job.month, monthLower: job.monthLower, year: Number(job.year) };',
  },
  {
    id: 'M2',
    name: 'the report range is narrowed, quietly shortening the client\'s table',
    from: "getTabValues(job.matchedTab, 'A1:D200', job.spreadsheetId)",
    to: "getTabValues(job.matchedTab, 'A1:D100', job.spreadsheetId)",
  },
  {
    id: 'M3',
    name: 'recipients dropped in the handoff to the mailer',
    from: 'to: job.recipients,',
    to: 'to: [],',
  },
  {
    id: 'M4',
    name: 'the workspace account is hardcoded, so RM mail goes out signed as CW',
    from: 'dryRun: false,\n      accountKey: job.account,',
    to: "dryRun: false,\n      accountKey: 'CW',",
  },
  {
    id: 'M5',
    name: 'a ClickUp dry run is recorded as a real task close',
    from: "else if (cu && cu.dryRun) record.clickupStatus = 'dry-run';",
    to: "else if (false) record.clickupStatus = 'dry-run';",
  },
  {
    id: 'M6',
    name: 'the report body is emptied before templating',
    // `reportHtml,` also appears in the destructuring above, so the anchor is
    // pinned to the buildEmail() call by the argument that follows it.
    from: 'reportHtml,\n      hasAdditionalIssues,',
    to: "reportHtml: '',\n      hasAdditionalIssues,",
  },
  {
    id: 'M7',
    name: "the transport's message id is thrown away",
    from: 'record.messageId = info && (info.messageId || info.messageID) ? (info.messageId || info.messageID) : null;',
    to: 'record.messageId = null;',
  },
  {
    id: 'M8',
    name: 'the resolved conditional notes never reach the template',
    from: 'conditionalNotes,\n      accountKey: job.account,',
    to: 'accountKey: job.account,',
  },
  {
    // The guard that stops this machine mailing real clients from a job that
    // only looked sendable - e.g. one queued by a dry run.
    id: 'M9',
    name: 'the agent no longer refuses a non-pending job',
    from: "if (job && job.status && job.status !== 'pending' && job.status !== 'claimed') {",
    to: 'if (false) {',
  },
  {
    id: 'M10',
    name: 'the refusal quietly reports success instead of a skip',
    from: "messageId: null, error: null,\n      skipReason: `refused: job status is \"${job.status}\", not pending`,\n      clickupStatus: 'none', clickupDetail: null,",
    to: "messageId: 'fake-id', error: null, skipReason: null,\n      clickupStatus: 'none', clickupDetail: null,",
  },
];

let pass = 0;
const problems = [];

console.log('\n── mutation harness: src/localMailAgent.js ──\n');

for (const m of MUTATIONS) {
  if (typeof m.from !== 'string' || typeof m.to !== 'string') {
    problems.push(`${m.id} HARNESS ERROR: from/to must be strings`);
    console.log(`  ? ${m.id}  non-string anchor — HARNESS ERROR, not counted`);
    continue;
  }

  const hay = norm(original);
  const occurrences = hay.split(norm(m.from)).length - 1;
  if (occurrences !== 1) {
    problems.push(`${m.id} HARNESS ERROR: anchor matched ${occurrences} times (must be exactly 1) — ${m.name}`);
    console.log(`  ? ${m.id}  anchor matched ${occurrences}x — HARNESS ERROR, not counted`);
    continue;
  }

  fs.writeFileSync(TARGET, hay.replace(norm(m.from), norm(m.to)).replace(/\n/g, eol), 'utf8');
  const res = spawnSync(process.execPath, [SUITE], { cwd: REPO, encoding: 'utf8' });
  const out = `${res.stdout || ''}${res.stderr || ''}`;
  fs.writeFileSync(TARGET, original, 'utf8');

  if (res.status !== 0) {
    pass++;
    const tally = (out.match(/(\d+)\/(\d+)\s*$/m) || [])[0] || '(no tally)';
    console.log(`  ok  ${m.id}  caught — suite went red (${tally.trim()})  ${m.name}`);
  } else {
    problems.push(`${m.id} SURVIVED: the suite still passed — ${m.name}`);
    console.log(`  XX  ${m.id}  SURVIVED  ${m.name}`);
  }
}

if (sha(fs.readFileSync(TARGET, 'utf8')) !== ORIGINAL_SHA) {
  problems.push('TARGET NOT RESTORED: localMailAgent.js differs from its original bytes');
  console.log('\n  XX  localMailAgent.js was NOT restored byte-for-byte');
} else {
  console.log(`\n  target restored, sha256 ${ORIGINAL_SHA.slice(0, 16)}…`);
}

if (problems.length) {
  console.log('\nPROBLEMS');
  for (const p of problems) console.log(`  x ${p}`);
}
console.log(`\n${pass}/${MUTATIONS.length} mutations caught`);
process.exit(problems.length ? 1 : 0);
