// This module MUST be imported before src/server.js.
//
// ES module imports are evaluated before the importing module's body, so the
// assignment that used to live in dashboard-worker.js after `import
// '../src/server.js'` ran too late: sheetsCache.js had already captured
// `isWorker = false` at module-evaluation time and enabled disk persistence in
// the Worker. Keeping the flag in an imported side-effect module guarantees it
// is set before any of the server's modules evaluate.
globalThis.__OFFICEOS_WORKER__ = true;
