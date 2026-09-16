/**
 * test-rag-accuracy.mjs — proves the RAG layer: retrieval, ground-truth numbers,
 * and the numeric verification guard. Runs fully offline (no LLM needed).
 *
 * Run:  node scripts/test-rag-accuracy.mjs
 */
import fs from 'node:fs';
import {
  buildRagContext,
  retrieveEvidence,
  verifyGrounded,
  getLlmPrompts,
  buildDevOverview,
} from '../src/devAssistant.js';

const projects = JSON.parse(fs.readFileSync(new URL('../data/dev-projects.json', import.meta.url), 'utf8'));
const rag = { evidenceLimit: 8, contextChars: 20000, verifyNumbers: true, strictGrounding: true };
const source = { spreadsheetId: '14PXRHUkFG-gf0DwbGVqeyPA7aQ4LyhDMjAeTVatOI78', tabs: [] };

const ov = buildDevOverview(projects);
console.log('GROUND TRUTH (independent recompute):', JSON.stringify(ov.totals));
console.log('projects:', ov.projects.map((p) => `${p.name}=${p.completed}/${p.pages}`).join(' | '));
console.log('');

const CASES = [
  'what is the update of Reitz Union?',
  'how many pages does Nines Hotel have?',
  'compare progress on AnsAngel coalition and Reitz Union',
  'what is pending across all projects',
];
for (const q of CASES) {
  const built = buildRagContext(q, projects, { rag, source });
  console.log('Q: ' + q);
  console.log('  matched project : ' + (built.matchedProject || '(none)'));
  console.log('  evidence rows   : ' + built.evidenceCount);
  console.log('  context chars   : ' + built.context.length + '  (old blind cap was 14000)');
  console.log('  ground-truth    : ' + JSON.stringify(built.groundTruth.totals));
  // Show which project each top evidence row belongs to
  const rows = retrieveEvidence(q, projects, null, 4);
  rows.forEach((r, i) => console.log(`  evidence[${i + 1}]    : ${r.text.slice(0, 96)}…`));
  console.log('');
}

// Prompt identity: the shared never-invent rules reach every provider.
const prompts = getLlmPrompts('reitz union update', projects, { rag, source });
console.log('PROMPT CHECK: sections in context =', ['SECTION 1 — GROUND TRUTH', 'SECTION 4 — SOURCE'].map((s) => prompts.user.includes(s)).join(' / '));
console.log('PROMPT CHECK: "NEVER invent" rule present =', prompts.system.includes('NEVER invent, guess, or extrapolate'));
console.log('');

// ── Numeric guard: a fabricated count MUST be caught.
const built = buildRagContext('how many pages does Reitz Union have?', projects, { rag, source });
const reitz = ov.projects.find((p) => /reitz/i.test(p.name));
const truthful = `**Reitz Union** has ${reitz.completed} of ${reitz.pages} pages completed (${reitz.readiness}%).`;
const fabricated = '**Reitz Union** has 19 of 21 pages completed (91%).';
const datey = 'Updated 2026-08-28 — https://thereitzunion.cogwheelmarketing.com/page-3 is complete.';
for (const [label, text] of [['truthful', truthful], ['fabricated', fabricated], ['date/url numbers', datey]]) {
  const res = verifyGrounded(text, built.context);
  console.log(`GUARD ${label.padEnd(16)} ok=${String(res.ok).padEnd(5)} checked=${res.checked} ungrounded=${JSON.stringify(res.ungrounded)}`);
}