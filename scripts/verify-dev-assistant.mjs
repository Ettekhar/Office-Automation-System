/**
 * verify-dev-assistant.mjs — accuracy verification with literal outputs.
 * Run: node scripts/verify-dev-assistant.mjs
 */
import fs from 'node:fs';
import { answerDevQuestionBuiltin, rankProjects, summarizeProject } from '../src/devAssistant.js';

const projects = JSON.parse(fs.readFileSync(new URL('../data/dev-projects.json', import.meta.url), 'utf8'));

// Independent recount logic (deliberately written from scratch, NOT reusing the engine)
function manualRecount(p) {
  const items = Array.isArray(p.items) ? p.items : [];
  const normSt = (s) => String(s || '').trim().toLowerCase().replace(/[_-]+/g, ' ');
  const rows = items.filter((it) => it && it.isHeader !== true
    && normSt(it.status) !== 'header' && it.url && String(it.url).trim());
  const completed = rows.filter((it) => ['completed', 'done', 'live'].includes(normSt(it.status))).length;
  const inProgress = rows.filter((it) => { const s = normSt(it.status); return s.includes('progress') || s === 'working'; }).length;
  const rounds = new Set(items.map((it) => (it && it.feedbackGroup) || 'General')).size;
  return { pages: rows.length, completed, inProgress, pending: rows.length - completed - inProgress, rounds };
}

console.log('================ PART 1 · TEST 4 — manual recount vs engine ================');
let allMatch = true;
for (const p of projects) {
  const manual = manualRecount(p);
  const engine = summarizeProject(p);
  const dist = {};
  (p.items || []).forEach((it) => { const k = (it.status || '(blank)') + (it.isHeader === true ? ' [header]' : ''); dist[k] = (dist[k] || 0) + 1; });
  console.log('\n── ' + p.project);
  console.log('  raw statuses   : ' + JSON.stringify(dist));
  console.log(`  manual recount : pages=${manual.pages} completed=${manual.completed} inProgress=${manual.inProgress} pending=${manual.pending} rounds=${manual.rounds}`);
  console.log(`  engine summary : pages=${engine.pages} completed=${engine.completed} inProgress=${engine.inProgress} pending=${engine.pending} rounds=${engine.rounds.length}`);
  const ok = manual.pages === engine.pages && manual.completed === engine.completed
    && manual.inProgress === engine.inProgress && manual.pending === engine.pending
    && manual.rounds === engine.rounds.length;
  if (!ok) allMatch = false;
  console.log('  VERDICT: ' + (ok ? 'MATCH' : 'MISMATCH'));
}
console.log('\nRESULT: ' + (allMatch ? 'MATCH — all ' + projects.length + ' projects identical' : 'MISMATCH FOUND'));

const tests = [
  { label: 'TEST 1a · AMBIGUOUS partial name (2 close candidates → clarify)', q: 'update on the hotel construction project', showRanking: true },
  { label: 'TEST 1b · MISSPELLED but unambiguous (confident, typo-tolerant)', q: 'what is the update of Reitz Unoin?', showRanking: true },
  { label: 'TEST 1c · SHORT TYPO "reiz union" (answers immediately, no re-prompt)', q: 'what is the update of reiz union?', showRanking: true },
  { label: 'TEST 1d · SHORT TYPO "riz union" (fuzzy, answers immediately)', q: 'update on riz union', showRanking: true },
  { label: 'TEST 1e · TRUNCATED "reit union" (prefix match)', q: 'reit union status', showRanking: true },
  { label: 'TEST 2 · NONEXISTENT project (must say not-found)', q: 'What is the update on the Atlantis Grand Resort website?', showRanking: true },
  { label: 'TEST 2b · unknown name + known word (answers + "closest match" note)', q: 'update on Mars Hotel', showRanking: true },
  { label: 'TEST 3a · COMPOUND compare (both parts answered)', q: 'compare progress on AnsAngel coalition and Reitz Union' },
  { label: 'TEST 3b · COMPOUND pending across all projects', q: "what's pending across all projects" },
  { label: 'INTENT help', q: 'hi' },
  { label: 'INTENT project-overview', q: 'what is the update of Reitz Union?' },
  { label: 'INTENT pending (per project)', q: 'what is still pending on Bunting Murray?' },
  { label: 'INTENT feedback rounds', q: 'feedback rounds for Nines Hotel' },
  { label: 'INTENT counts', q: 'how many pages does AnsAngel coalition have' },
  { label: 'INTENT latest updates', q: 'latest updates' },
  { label: 'INTENT overall overview', q: 'overall progress' },
  { label: 'INTENT fallback', q: 'what is the airspeed velocity of an unladen swallow?' },
  { label: 'INTENT empty (no tracker data)', q: 'overall progress', emptyProjects: true },
];

console.log('\n================ PART 1 · TESTS 1,2,3,6 — literal Q/A ================');
for (const t of tests) {
  const data = t.emptyProjects ? [] : projects;
  console.log('\n──────────────────────────────────────────────');
  console.log('[' + t.label + ']');
  console.log('  INPUT Q : ' + JSON.stringify(t.q) + (t.emptyProjects ? '   (projects = [])' : ''));
  if (t.showRanking) {
    const rows = rankProjects(t.q, data).filter((r) => r.score > 0);
    console.log('  matcher : ' + (rows.length
      ? rows.map((r) => r.name + ' score=' + r.score.toFixed(2) + ' margin=' + (r.margin ?? 0).toFixed(2) + ' kinds=[' + r.kinds.join(',') + '] confident=' + r.confident + (r.assumed ? ' assumed=true' : '')).join(' | ')
      : 'NO candidate above 0'));
  }
  const r = answerDevQuestionBuiltin(t.q, data);
  console.log('  intent=' + r.intent + '  project=' + ((r.project && r.project.name) || 'none') + '  engine=' + r.engine);
  if (r.data && r.data.candidates) console.log('  candidates payload: ' + JSON.stringify(r.data.candidates));
  console.log('  OUTPUT:');
  console.log(r.answer.split('\n').map((l) => '    ' + l).join('\n'));
}
