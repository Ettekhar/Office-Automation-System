import { answerMaintenanceQuestionBuiltin, answerDevQuestionBuiltin, answerSiteQuestionBuiltin } from '../src/devAssistant.js';
import { getSites, getDevProjects } from '../src/db.js';

const maintenance = answerMaintenanceQuestionBuiltin('how many maintenance happened', getSites());
const feedback = answerDevQuestionBuiltin('what is the most recent feedback', getDevProjects());
const site = answerSiteQuestionBuiltin('what happened for governorsinnnd.com', getSites());
const typoMaintenance = answerMaintenanceQuestionBuiltin('how many maintenace was done this month', getSites());
const spacedDomain = answerSiteQuestionBuiltin('hotel perla maintenace', getSites());
const tests = [
  ['maintenance route selected', maintenance?.intent === 'maintenance'],
  ['uses a non-empty completion month', maintenance?.data?.completed > 0],
  ['feedback route selected', feedback?.intent === 'feedback'],
  ['feedback excludes development update', !feedback.answer.includes('All the pages are completed')],
  ['exact website route selected', site?.intent === 'site-status' && site?.data?.site === 'governorsinnnd.com'],
  ['common maintenance typo still routes to maintenance data', typoMaintenance?.intent === 'maintenance' && typoMaintenance?.data?.completed > 0],
  ['spaced website name resolves to maintenance site, not Dev Tracker project', spacedDomain?.intent === 'site-status' && spacedDomain?.data?.site === 'hotelperla.com'],
];
let passed = 0;
for (const [label, ok] of tests) { if (ok) passed++; console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`); }
console.log(`\n${passed}/${tests.length} routing checks passed`);
if (passed !== tests.length) process.exitCode = 1;
