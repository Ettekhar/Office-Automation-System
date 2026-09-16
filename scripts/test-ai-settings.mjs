/**
 * test-ai-settings.mjs — end-to-end proof of the superadmin AI Settings API.
 *
 * Exercises, against a RUNNING server:
 *   1. GET  /api/master/assistant-config?role=superadmin   (masked keys + shapes)
 *   2. GET  /api/master/assistant-config?role=user         (must NOT leak)
 *   3. PUT  /api/master/assistant-config                   (save order/rag/source)
 *   4. POST /api/master/assistant-config/test              (live provider ping)
 *   5. POST /api/master/assistant-config/test-source       (sheet + tab row counts)
 *   6. POST /api/master/dev-assistant                      (grounded RAG answer)
 *   7. restore the original config
 *
 * Usage: node scripts/test-ai-settings.mjs [baseUrl]
 */
const BASE = process.argv[2] || 'http://localhost:3782';
const j = async (res) => { const t = await res.text(); try { return JSON.parse(t); } catch { return { raw: t.slice(0, 300) }; } };
const get = (p) => fetch(BASE + p).then(j);
const send = (p, body, method = 'POST') =>
  fetch(BASE + p, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(j);

const line = (s) => console.log('\n──────── ' + s);

const original = await get('/api/master/assistant-config?role=superadmin');

line('1 · GET config as superadmin (keys must be MASKED)');
console.log('  engine        : ' + original.engine + ' | aiAvailable: ' + original.aiAvailable);
console.log('  order         : ' + (original.order || []).join(' -> '));
for (const p of original.providers || []) {
  console.log('  provider      : ' + p.name.padEnd(11) +
    ' kind=' + String(p.kind).padEnd(7) +
    ' enabled=' + String(p.enabled).padEnd(5) +
    ' configured=' + String(p.configured).padEnd(5) +
    ' hasKey=' + String(p.hasKey).padEnd(5) +
    ' keySource=' + String(p.keySource).padEnd(10) +
    ' masked=' + (p.keyMasked || '-') +
    (p.skipReason ? ' (' + p.skipReason + ')' : ''));
}
console.log('  source        : credentialId=' + (original.source?.credentialId || '') +
  ' sheetId=' + (original.source?.spreadsheetId || '') +
  ' tabs=' + (original.source?.tabs || []).length + ' freshOnAsk=' + original.source?.freshOnAsk);
console.log('  rag           : strict=' + original.rag?.strictGrounding + ' verify=' + original.rag?.verifyNumbers +
  ' urls=' + original.rag?.includePageUrls + ' evidence=' + original.rag?.evidenceLimit + ' chars=' + original.rag?.contextChars);
console.log('  sheetOptions  : ' + (original.sheetOptions || []).length);
for (const o of original.sheetOptions || []) console.log('     * ' + o.title + ' | ' + o.id + ' | system=' + o.isSystem + ' active=' + o.active);

const leaked = (original.providers || []).filter((p) => p.apiKey || (p.keyMasked && p.keyMasked.length > 24));
console.log('  LEAK CHECK    : ' + (leaked.length ? '! ' + leaked.length + ' raw key(s) exposed!' : 'OK - no raw key in the payload'));

line('2 · GET config as role=user (must be refused)');
try {
  const asUser = await get('/api/master/assistant-config?role=user');
  console.log('  result: ' + JSON.stringify(asUser).slice(0, 160));
} catch (e) { console.log('  result: blocked (' + e.message + ')'); }
line('3 · PUT save - order + RAG source + accuracy flags');
const saved = await send('/api/master/assistant-config', {
  role: 'superadmin',
  order: ['groq', 'gemini', 'openrouter'],
  source: { credentialId: original.source?.credentialId || '', spreadsheetId: original.source?.spreadsheetId || '', tabs: [], freshOnAsk: false },
  rag: { strictGrounding: true, verifyNumbers: true, includePageUrls: true, evidenceLimit: 30, contextChars: 24000 },
}, 'PUT');
console.log('  success : ' + saved.success + ' | updatedAt: ' + saved.updatedAt);
console.log('  source  : ' + JSON.stringify(saved.source));
console.log('  rag     : ' + JSON.stringify(saved.rag));
if (saved.ignored?.length) console.log('  ignored : ' + saved.ignored.join(' / '));

line('4 · POST test - live ping of the first provider in the chain');
const t = await send('/api/master/assistant-config/test', { role: 'superadmin', provider: 'groq' });
console.log('  provider: ' + t.result?.provider + ' | ok=' + t.result?.ok + ' | model=' + t.result?.model + ' | ' + t.result?.message);
for (const a of t.result?.attempts || []) console.log('     attempt: ' + a.model + ' ok=' + a.ok + ' ' + (a.ms || '') + 'ms' + (a.error ? ' error=' + a.error : ' sample=' + JSON.stringify(a.sample)));

line('4b · POST test with a BOGUS draft key (proves error surfacing, no silent pass)');
const bad = await send('/api/master/assistant-config/test', {
  role: 'superadmin', provider: 'groq', draft: { groq: { apiKey: 'gsk_not_a_real_key_000000000000' } },
});
console.log('  ok=' + bad.result?.ok + ' | ' + bad.result?.message);
for (const a of bad.result?.attempts || []) console.log('     attempt: ' + a.model + ' ok=' + a.ok + ' error=' + (a.error || ''));

line('5 · POST test-source - read the selected Google Sheet + row counts per tab');
const src = await send('/api/master/assistant-config/test-source', {
  role: 'superadmin', spreadsheetId: original.source?.spreadsheetId || '', tabs: [],
});
if (src.success) {
  console.log('  spreadsheetId : ' + src.spreadsheetId);
  console.log('  tabs used     : ' + (src.tabsUsed || []).join(', '));
  console.log('  totalRows     : ' + src.totalRows + ' <- rows the assistant would see');
  for (const p of src.perTab || []) console.log('     * ' + String(p.tab).padEnd(28) + ' ' + (p.error ? 'ERROR ' + p.error : p.rows + ' rows'));
} else {
  console.log('  FAILED: ' + JSON.stringify(src).slice(0, 240));
}

line('6 · POST dev-assistant - grounded answer through the saved chain');
const ask = await send('/api/master/dev-assistant', { question: 'how many pages does Reitz Union have and how many feedback rounds?', role: 'superadmin' });
console.log('  engine   : ' + ask.engine + (ask.provider ? ' (provider: ' + ask.provider + ')' : ''));
console.log('  intent   : ' + ask.intent + ' | project: ' + ask.project);
if (ask.grounding) console.log('  grounding: ' + JSON.stringify(ask.grounding));
if (ask.retrieval) console.log('  retrieval: ' + JSON.stringify(ask.retrieval));
console.log('  answer   :\n' + String(ask.answer || '').split('\n').map((l) => '     ' + l).join('\n'));

line('7 · restore the original config');
const restored = await send('/api/master/assistant-config', {
  role: 'superadmin',
  order: original.order,
  source: original.source,
  rag: original.rag,
}, 'PUT');
console.log('  restored: ' + restored.success + ' | order=' + JSON.stringify(original.order) + ' | rag=' + JSON.stringify(restored.rag));

console.log('\nDONE');
