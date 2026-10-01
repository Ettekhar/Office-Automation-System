import assert from 'node:assert/strict';
import { askHandbook, formatHandbookAnswer, handbookWorkerConfig, shouldUseHandbook } from '../src/handbookRag.js';

const config = { handbook: { enabled: true, workerUrl: 'https://razib-operations-rag.example.workers.dev/' } };
assert.equal(handbookWorkerConfig(config).workerUrl, 'https://razib-operations-rag.example.workers.dev');
assert.equal(handbookWorkerConfig({ handbook: { workerUrl: 'https://example.com/admin' } }).configured, false);
assert.equal(shouldUseHandbook('What is the client handover SOP?'), true);
assert.equal(shouldUseHandbook('Operations Handbook'), true);
assert.equal(shouldUseHandbook('What is the monthly maintenance process?'), true);
assert.equal(shouldUseHandbook('Was maintenance done for Hotel Perla?'), false);
const response = await askHandbook('What is the client handover SOP?', config, {
  fetchImpl: async (url, init) => {
    assert.equal(url, 'https://razib-operations-rag.example.workers.dev/chat');
    assert.equal(init.method, 'POST');
    return new Response(JSON.stringify({ answer: 'Follow the checklist.', sources: [{ title: 'Handover', url: 'https://docs.example/handover', section: 'Final steps', excerpt: 'Confirm delivery.' }], next_actions: ['Confirm access'] }), { status: 200, headers: { 'content-type': 'application/json' } });
  },
});
assert.equal(response.ok, true);
assert.match(formatHandbookAnswer(response), /Follow the checklist/);
assert.match(formatHandbookAnswer(response), /Handover/);
console.log('Handbook RAG bridge checks passed.');
