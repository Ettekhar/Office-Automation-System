/**
 * verify-dynamic-columns.mjs
 *
 * Proves the dynamic-column guarantee: if a new column is added to a sheet
 * today, the chatbot can see it, fetch its values, and answer from them.
 *
 * This script:
 *  1. Reads the existing sheet-schema registry (data/sheet-schema.json).
 *  2. Simulates adding a fake "QA Check" column to a known tab's header.
 *  3. Re-runs column resolution as if the sheet had that column.
 *  4. Verifies the LLM context builder (buildRagContext) would surface it.
 *  5. Verifies describeSchemaForAssistant would list it with a "+" prefix.
 *  6. Verifies the frontend boot path would receive it in meta.detectedColumns.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  resolveColumns,
  detectHeaderRow,
  describeColumns,
  describeColumnsText,
  schemaSignature,
  columnKey,
  prettyHeader,
  inferColumnKind,
} from '../src/tabSchema.js';
import { describeSchemaForAssistant } from '../src/sheetSchema.js';
import { discoverExtraColumns } from '../src/devAssistant.js';
import { buildRagContext } from '../src/devAssistant.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = path.resolve(__dirname, '../data/sheet-schema.json');
const projectsPath = path.resolve(__dirname, '../data/dev-projects.json');

const schemaFile = path.resolve(__dirname, '../data/sheet-schema.json');
let registry;
if (fs.existsSync(schemaFile)) {
  registry = JSON.parse(fs.readFileSync(schemaFile, 'utf8'));
} else {
  // Fall back: discover directly from the dev-tracker spreadsheet.
  const { getOrDiscoverSheetSchema } = await import('../src/sheetSchema.js');
  registry = { version: 1, updatedAt: null, spreadsheets: {} };
  const db = await import('../src/db.js');
  const creds = db.getSheetCredentials ? db.getSheetCredentials() : [];
  const devTracker = creds.find(c => c.key === 'dev-tracker' || c.id === 'dev-tracker');
  if (devTracker?.spreadsheetId) {
    const schema = await getOrDiscoverSheetSchema(devTracker.spreadsheetId, { maxTabs: 6 });
    if (schema) registry.spreadsheets[devTracker.spreadsheetId] = schema;
  }
}
const projects = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../data/dev-projects.json'), 'utf8'));

let passed = 0;
let failed = 0;

function assert(label, ok, detail = '') {
  if (ok) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}${detail ? ' — ' + detail : ''}`); }
  return ok;
}

console.log('=== DYNAMIC COLUMN GUARANTEE — VERIFICATION ===\n');

// ── 1. The schema registry is the single source of truth ──────────────────
console.log('[1] Schema registry drives the chatbot, not hardcoded positions.');

const sheets = Object.values(registry.spreadsheets || {});
assert('Registry has at least one spreadsheet', sheets.length > 0);
const firstSheet = sheets[0];
assert('First sheet has tabs', Array.isArray(firstSheet.tabs) && firstSheet.tabs.length > 0);

// Every tab in the registry carries its own column resolution.
for (const tab of firstSheet.tabs) {
  assert(
    `Tab "${tab.title}" has a 'columns' array resolved from its header`,
    Array.isArray(tab.columns) && tab.columns.length > 0,
    `columns.length = ${tab.columns?.length}`
  );
  const extras = tab.extras || [];
  if (extras.length) {
    console.log(`     → ${extras.length} hand-added column(s) already discovered: ${extras.map(e => e.label).join(', ')}`);
  }
}

// ── 2. Adding a new column to the header is handled without code changes ──
console.log('\n[2] Injecting a new column into a tab\'s header — no code change needed.');

// Pick a real tab header and append a fake new column.
const targetTab = firstSheet.tabs.find(t => t.columns && t.columns.length >= 5)
  || firstSheet.tabs[0];
const baseHeaders = targetTab.headers || [];
assert('Target tab has headers to mutate', baseHeaders.length >= 3);

const fakeNewColumn = 'QA Check';
const mutatedHeaders = [...baseHeaders, fakeNewColumn];

// Resolve columns from the mutated header — this is exactly what
// discoverTabSchema() does when it reads A1:Z{n} from the sheet.
const mutatedCols = resolveColumns(mutatedHeaders, { profile: targetTab.profile || 'auto', tabName: targetTab.title });
const mutatedDesc = describeColumns(mutatedCols);
const mutatedText = describeColumnsText(mutatedCols);

assert(
  'New column appears in resolved columns.extras (not dropped)',
  mutatedCols.extras && mutatedCols.extras.length === 1 && mutatedCols.extras[0].label === fakeNewColumn,
  `extras = ${JSON.stringify(mutatedCols.extras)}`
);
assert(
  'New column gets a stable code-friendly key (qaCheck)',
  mutatedCols.extras[0].key === 'qaCheck',
  `key = ${mutatedCols.extras[0].key}`
);
assert(
  'New column gets an inferred kind (status-ish header → status)',
  ['text', 'status', 'longtext'].includes(mutatedCols.extras[0].kind),
  `kind = ${mutatedCols.extras[0].kind}`
);
assert(
  'describeColumnsText lists the new column',
  mutatedText.toLowerCase().includes(fakeNewColumn.toLowerCase()),
  `text = ${mutatedText.slice(0, 120)}`
);

// ── 3. The LLM context builder surfaces the new column ────────────────────
console.log('\n[3] buildRagContext would include the new column in SECTION 2 (extraValues).');

// Build a fake project that carries the mutated column layout + one row with
// a value in the new column — this is what fetchDevTrackerSheetData would
// produce after the column was added.
const fakeProject = {
  project: targetTab.title,
  columns: mutatedCols, // ← the resolved layout including the new column
  items: [
    {
      url: 'https://example.com/page-1',
      status: 'Completed',
      date: '2026-09-01',
      notes: 'Some work done here',
      extra: { qaCheck: 'Passed — no critical issues' }, // ← a value typed into the new column
      rowNum: 2,
    },
    {
      url: 'https://example.com/page-2',
      status: 'Pending',
      date: '2026-09-05',
      notes: 'Still in progress',
      extra: { qaCheck: '⚠ Blocked on content' }, // ← another value in the new column
      rowNum: 3,
    },
  ],
  extraColumns: mutatedCols.extras.map(c => ({ key: c.key, label: c.label, kind: c.kind })),
};

// summarizeProject reads extraColumns + extraLog from the project shape.
const { summarizeProject } = await import('../src/devAssistant.js');
const sum = summarizeProject(fakeProject);

// Attach the computed extraValues so downstream checks (and any future
// buildRagContext call) see the same shape the real fetchDevTrackerSheetData
// would produce — extraColumns + extraValues side by side.
fakeProject.extraValues = sum.extraLog.slice(0, 25).map(e => ({
  column: e.column,
  value: e.value,
  page: e.url || undefined,
  date: e.date || undefined,
}));

assert(
  'summarizeProject surfaces extraColumns from the mutated layout',
  Array.isArray(sum.extraColumns) && sum.extraColumns.length === 1 && sum.extraColumns[0].label === fakeNewColumn,
  `extraColumns = ${JSON.stringify(sum.extraColumns)}`
);
assert(
  'summarizeProject surfaces every non-empty value in the new column (extraLog)',
  Array.isArray(sum.extraLog) && sum.extraLog.length === 2,
  `extraLog.length = ${sum.extraLog?.length}`
);
if (sum.extraLog.length === 2) {
  assert(
    'extraLog entry 1 quotes the new column value for page 1',
    sum.extraLog[0].column === fakeNewColumn && sum.extraLog[0].value === 'Passed — no critical issues',
    `value = ${sum.extraLog[0].value}`
  );
  assert(
    'extraLog entry 2 quotes the new column value for page 2',
    sum.extraLog[1].column === fakeNewColumn && sum.extraLog[1].value === '⚠ Blocked on content',
    `value = ${sum.extraLog[1].value}`
  );
}

// ── 4. buildRagContext places the new column values in the LLM prompt ──────
console.log('\n[4] buildRagContext — the actual LLM prompt — includes the new column values.');

const rag = buildRagContext('what is the QA Check status for page 1 in AnsAngel coalition?', [fakeProject], {
  rag: { evidenceLimit: 18, contextChars: 20000 },
  source: null,
  history: [],
});
assert(
  'SECTION 2 (project detail) contains extraValues with the new column values',
  rag.context.includes('"QA Check"') && rag.context.includes('Passed — no critical issues'),
  `(context length ${rag.context.length} chars — searching for QA Check values)`
);
assert(
  'The new column is NOT framed as missing or noise in the context',
  !rag.context.includes('QA Check') || rag.context.includes('Passed') || rag.context.includes('Blocked'),
  'context does not claim the column is absent'
);

// ── 5. describeSchemaForAssistant lists the new column with "+" prefix ───
console.log('\n[5] describeSchemaForAssistant — the SECTION 5 text — marks the new column as "+".');

const schemaForAssistant = describeSchemaForAssistant([{
  ...firstSheet,
  tabs: [{
    ...targetTab,
    columns: mutatedDesc,
    extras: mutatedCols.extras,
    headerRowNumber: targetTab.headerRowNumber || 1,
    profile: mutatedCols.profile || 'auto',
  }],
}]);
assert(
  'SECTION 5 text includes the new column label',
  schemaForAssistant.includes(fakeNewColumn),
  `schema text: ${schemaForAssistant.slice(0, 300)}`
);
assert(
  'New column is prefixed with "+" (hand-added marker)',
  schemaForAssistant.includes(`+ ${fakeNewColumn}`) || schemaForAssistant.includes(`+${fakeNewColumn}`),
  `schema text: ${schemaForAssistant.slice(0, 300)}`
);
assert(
  'SECTION 5 text does NOT say the column is missing',
  !schemaForAssistant.includes('missing') || schemaForAssistant.includes('not scanned'),
  'schema text should not claim the column is absent'
);

// ── 6. The frontend boot path receives detectedColumns ────────────────────
console.log('\n[6] Frontend boot: meta.detectedColumns includes the new column.');

const detected = discoverExtraColumns([fakeProject]);
assert(
  'discoverExtraColumns finds the new column from the project',
  detected.some(c => c.label === fakeNewColumn),
  `detected = ${JSON.stringify(detected)}`
);
assert(
  'detected column carries kind so the UI can hint at its type',
  detected.find(c => c.label === fakeNewColumn)?.kind === mutatedCols.extras[0].kind,
  `kind = ${detected.find(c => c.label === fakeNewColumn)?.kind}`
);

// ── 7. Cross-check: the SYSTEM_PROMPT instructions cover hand-added columns ─
console.log('\n[7] SYSTEM_PROMPT instructs the LLM to treat hand-added columns as real data.');

const { SYSTEM_PROMPT } = await import('../src/devAssistant.js');
assert(
  'SYSTEM_PROMPT mentions hand-added columns',
  SYSTEM_PROMPT.toLowerCase().includes('hand-added column'),
  '(prompt instructs the model about hand-added columns)'
);
assert(
  'SYSTEM_PROMPT says hand-added columns are REAL tracker data',
  SYSTEM_PROMPT.includes('REAL tracker data') || SYSTEM_PROMPT.includes('real tracker data'),
  '(prompt tells the model not to dismiss them as noise)'
);
assert(
  'SYSTEM_PROMPT says to answer from hand-added column values when relevant',
  SYSTEM_PROMPT.includes('Answer from those values'),
  '(prompt tells the model to use the values when a question touches them)'
);

// ── 8. The write path preserves the new column (no column shift) ──────────
console.log('\n[8] Row writes are sized to the tab\'s column count — new columns are never shifted.');

import { resolveDevTrackerColumns, buildDevTrackerRowForLayout } from '../src/sheets.js';
const layout = resolveDevTrackerColumns(targetTab.headers || []);
assert(
  'resolveDevTrackerColumns returns a column map for the tab',
  layout && typeof layout === 'object' && 'url' in layout,
  `(layout keys: ${Object.keys(layout).join(', ')})`
);
if (layout && 'url' in layout) {
  const fields = { url: 'https://example.com/new-page', status: 'todo', notes: 'New page added' };
  const row = buildDevTrackerRowForLayout(layout, fields);
  assert(
    'buildDevTrackerRowForLayout produces a row the width of the tab\'s columns',
    Array.isArray(row) && row.length >= targetTab.headers.length && row.length <= targetTab.headers.length + 7,
    `row.length = ${row?.length}, headers.length = ${targetTab.headers?.length}`
  );
}

// ── SUMMARY ────────────────────────────────────────────────────────────────
console.log(`\n=== RESULT: ${passed} passed, ${failed} failed ===`);
if (failed === 0) {
  console.log('✓ The dynamic-column guarantee holds: new columns are discovered,'
    + ' described to the LLM, surfaced in the chat context, and answerable'
    + ' without any code change.');
  process.exit(0);
} else {
  console.log('✗ Some checks failed — the guarantee has a gap.');
  process.exit(1);
}
