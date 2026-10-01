import { answerDevQuestionBuiltin } from '../src/devAssistant.js';

const project = {
  id: 'house', project: 'The House', items: [
    { idx: 0, rowNum: 2, url: 'https://thehouse.example/', status: 'Completed', devDate: '', devNotes: '', feedbackGroup: 'Feedback 1', feedbackUrl: '', date: '2026-09-03', notes: 'Homepage email feedback completed', extra: {}, isHeader: false },
    { idx: 1, rowNum: 3, url: '', status: 'Header', devDate: '', devNotes: '', feedbackGroup: 'Feedback 2', feedbackUrl: 'Feedback-2 URL', date: '', notes: '', extra: {}, isHeader: true },
  ],
};

const answer = answerDevQuestionBuiltin('full details for The House', [project]);
const checks = [
  ['uses dedicated details intent', answer.intent === 'project-details'],
  ['shows the live row content', answer.answer.includes('Homepage email feedback completed')],
  ['explains empty Feedback 2 section', answer.answer.includes('Feedback 2') && answer.answer.includes('without a work row')],
  ['does not fall back to overview-only wording', !answer.answer.includes('At a glance')],
];
for (const [name, passed] of checks) {
  console.log(`${passed ? 'PASS' : 'FAIL'} ${name}`);
  if (!passed) process.exitCode = 1;
}
if (!process.exitCode) console.log('\n4/4 live detail checks passed');
