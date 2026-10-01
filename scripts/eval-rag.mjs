import { generateGroundedFallback, loadRagIndex, seedDemoRagIndex, retrieveRag, sourceTypeForQuestion } from '../src/enterpriseRag.js';

if (!loadRagIndex().chunks?.length) {
  await seedDemoRagIndex();
  console.log('Created a minimal offline demo index. Run npm run sync:rag to replace it with live sources.');
}

// Keep this harness after every RAG change. Every case asserts retrieval source,
// a concrete fact, and a citation in the generated fallback answer.
const tests = [
  ['What is the status of Project X?', 'sheet', 'Demo Project Tracker', 'In Progress'],
  ['Who owns Project X?', 'sheet', 'Demo Project Tracker', 'Rahim'],
  ['What is pending for Project X?', 'sheet', 'Demo Project Tracker', 'client approval'],
  ['When was Project X updated?', 'sheet', 'Demo Project Tracker', '12 Sep 2026'],
  ['Which project is in progress?', 'sheet', 'Demo Project Tracker', 'Project X'],
  ['Was maintenance completed for examplehotel.com?', 'sheet', 'Demo Maintenance Sheet', 'Completed'],
  ['Was the maintenance report sent?', 'sheet', 'Demo Maintenance Sheet', 'sent'],
  ['What website has completed maintenance?', 'sheet', 'Demo Maintenance Sheet', 'examplehotel.com'],
  ['How do I launch a website?', 'doc', 'Website Launch SOP', 'Confirm written staging approval'],
  ['What are the launch checklist steps?', 'doc', 'Website Launch SOP', 'Take a full backup'],
  ['How do I clear cache before launch?', 'doc', 'Website Launch SOP', 'Clear all caches'],
  ['Who should be notified after launch?', 'doc', 'Website Launch SOP', 'account manager'],
  ['What is the domain renewal procedure?', 'doc', 'Domain Renewal SOP', 'Verify the expiry date'],
  ['What is the first domain renewal step?', 'doc', 'Domain Renewal SOP', 'Verify the expiry date'],
  ['How do I record a domain renewal?', 'doc', 'Domain Renewal SOP', 'Record the receipt'],
  ['Where do I renew a domain?', 'doc', 'Domain Renewal SOP', 'registrar'],
];

let failures = 0;
for (const [question, expectedType, expectedSource, expectedFact] of tests) {
  const inferred = sourceTypeForQuestion(question);
  const result = await retrieveRag(question, { sourceType: inferred, candidateLimit: 20, limit: 5 });
  const answer = generateGroundedFallback(question, result);
  const top = result.chunks[0];
  const sourceCorrect = top?.metadata.file_name === expectedSource;
  const factPresent = answer.toLowerCase().includes(expectedFact.toLowerCase());
  const cited = answer.includes(`[Source: ${expectedSource}`);
  const pass = sourceCorrect && factPresent && cited;
  if (!pass) failures++;
  console.log(JSON.stringify({ question, expected: { source: expectedSource, fact: expectedFact }, retrievedChunks: result.chunks.map((chunk) => ({ source: chunk.metadata.file_name, tabOrSection: chunk.metadata.sheet_tab || chunk.metadata.section_heading, row: chunk.metadata.row_number || null, scores: chunk.scores })), finalGeneratedAnswer: answer, sourceCorrect, factPresent, cited, pass }, null, 2));
}
console.log(`RAG evaluation complete: ${tests.length - failures}/${tests.length} passed. Run npm run sync:rag before evaluating live sources.`);
if (failures) process.exitCode = 1;
