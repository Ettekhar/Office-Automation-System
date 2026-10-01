/**
 * Mutation harness for scratch/verify-worker-api.mjs
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Same contract as mutation-worker-parity.mjs: every mutation is a plausible
 * mistake in the Worker's ledger and report layer, every anchor must land
 * exactly once, and the target must come back byte-identical afterwards.
 *
 * These target the parts the planner suite cannot see — authentication, the
 * claim/record state machine, and the shape of the report the operator reads.
 */

import { spawnSync } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const TARGET = path.join(REPO, 'cloudflare-worker', 'mailer-worker.js');
const SUITE = path.join(REPO, 'scratch', 'verify-worker-api.mjs');

const original = fs.readFileSync(TARGET, 'utf8');
const eol = original.includes('\r\n') ? '\r\n' : '\n';
const sha = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');
const ORIGINAL_SHA = sha(original);
const norm = (s) => s.replace(/\r\n/g, '\n');

const MUTATIONS = [
  {
    id: 'A1',
    name: 'safeJson hands back null where the caller expects an array',
    // Both halves of safeJson's null handling have to go for this to be
    // observable: the `text == null` early return and the `v == null` check after
    // the parse each independently cover the same case, so breaking one alone is an
    // equivalent mutant that no test can catch. This anchor spans the pair.
    from: [
      '  if (text == null) return fallback;',
      '  try {',
      '    const v = JSON.parse(text);',
      '    return v == null ? fallback : v;',
      '  } catch {',
    ].join('\n'),
    to: [
      '  try {',
      '    const v = JSON.parse(text);',
      '    return v;',
      '  } catch {',
    ].join('\n'),
  },
  {
    id: 'A2',
    name: 'over-long email bodies silently stored in full',
    from: "if (typeof html === 'string' && html.length > maxHtml) {",
    to: 'if (false) {',
  },
  {
    id: 'A3',
    name: 'the no-tab skip reason reworded (dashboard buckets would shift)',
    from: "reason: 'no matching report tab', recipients",
    to: "reason: 'no tab', recipients",
  },
  {
    // The guard that stops a half-finished deploy from reading a spreadsheet
    // literally named REPLACE_WITH_CW_SPREADSHEET_ID.
    id: 'A11',
    name: 'an unpasted REPLACE_WITH_ spreadsheet id counts as configured',
    from: '  return UNPASTED.test(id) ? \'\' : id;',
    to: '  return id;',
  },
  {
    id: 'A12',
    name: 'a whitespace-only spreadsheet id counts as configured',
    from: '  const id = typeof value === \'string\' ? value.trim() : \'\';',
    to: '  const id = typeof value === \'string\' ? value : \'\';',
  },
  {
    // The single most consequential line in the Worker: get this wrong and a
    // rehearsal against the real sheets arms a queue of real client mail.
    id: 'A13',
    name: 'a dry run queues claimable jobs (real mail one drain away)',
    from: "  const queuedStatus = dryRun ? 'dry-run' : 'pending';",
    to: "  const queuedStatus = 'pending';",
  },
  {
    id: 'A14',
    name: 'the report lumps dry-run jobs back in with pending work',
    from: "      dryRun: byStatus['dry-run'] || 0,",
    to: '      dryRun: 0,',
  },
  {
    id: 'A4',
    name: '"did not get mail" lists everybody, sent or not',
    from: "const notSent = shaped.filter((s) => s.mail.status !== 'sent')",
    to: 'const notSent = shaped.filter(() => true)',
  },
  {
    id: 'A5',
    name: 'claiming a job does not move it out of the pending pool',
    from: "UPDATE jobs SET status='claimed', claimed_at=?, claimed_by=? WHERE id=? AND status='pending'",
    to: "UPDATE jobs SET status='pending', claimed_at=?, claimed_by=? WHERE id=? AND status='pending'",
  },
  {
    id: 'A6',
    name: 'the ClickUp outcome is dropped instead of recorded',
    from: 'clickup_status=?, clickup_detail=?',
    to: 'clickup_status=NULL, clickup_detail=?',
  },
  {
    id: 'A7',
    name: 'the admin gate always lets requests through',
    from: 'if (!env.ADMIN_TOKEN) return true;',
    to: 'if (true) return true;',
  },
  {
    id: 'A8',
    name: 'the claim batch size is ignored',
    from: "const limit = Math.min(Number(url.searchParams.get('limit') || 1), 20);",
    to: 'const limit = 20;',
  },
  {
    id: 'A9',
    name: 'the report stops resolving recipients',
    from: 'recipients: safeJson(j.recipients, []),',
    to: 'recipients: [],',
  },
  {
    id: 'A10',
    name: 'the markdown report omits the not-sent table rows',
    from: "for (const d of report.didNotGetMail) L.push(`| ${d.websiteUrl} | ${d.account} | ${d.status} | ${String(d.reason).replace(/\\|/g, '/')} |`);",
    to: "for (const d of report.didNotGetMail) L.push('');",
  },
];

let pass = 0;
const problems = [];

console.log('\n── mutation harness: worker ledger + report ──\n');

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
