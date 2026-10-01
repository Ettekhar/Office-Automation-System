/** Lightweight, offline proof that SOP excerpts are selected and cited. */
import { buildRagContext } from '../src/devAssistant.js';

const documents = {
  documents: [
    { title: 'Website Launch SOP', url: 'https://docs.google.com/document/d/launch-sop/edit', text: 'Before launch: confirm staging approval. Then take a full backup, clear cache, run responsive QA, and notify the account manager.' },
    { title: 'Domain Renewal SOP', url: 'https://docs.google.com/document/d/domain-sop/edit', text: 'For a domain renewal, verify the expiry date, request approval, renew through the registrar, and record the receipt.' },
  ],
};

const context = buildRagContext('What are the website launch steps?', [], { rag: { contextChars: 20000 }, documents }).context;
const checks = [
  ['has Docs section', context.includes('SECTION 7 — GOOGLE DOCS')],
  ['retrieves matching launch SOP', context.includes('Website Launch SOP') && context.includes('Before launch')],
  ['keeps source URL', context.includes('launch-sop/edit')],
  ['does not include unrelated renewal excerpt', !context.includes('For a domain renewal')],
];
let passed = 0;
for (const [label, ok] of checks) { if (ok) passed++; console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`); }
console.log(`\n${passed}/${checks.length} Docs RAG checks passed`);
if (passed !== checks.length) process.exitCode = 1;
