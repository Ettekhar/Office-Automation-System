import { getAssistantConfig } from '../src/db.js';
import { syncRagIndex } from '../src/enterpriseRag.js';
const { reportAutomation } = getAssistantConfig();
const result = await syncRagIndex({ refresh: true, sources: { documents: getAssistantConfig().documents, reportAutomation } });
console.log(JSON.stringify({ updatedAt: result.updatedAt, chunkCount: result.chunkCount, sources: result.sources, embeddingModel: result.embeddingModel, errors: result.errors }, null, 2));
