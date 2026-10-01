/**
 * http-shim.js  -  stands in for node:http so src/server.js can be imported
 * inside a Worker without being modified.
 *
 * src/server.js ends with:
 *     const server = http.createServer(async (req, res) => { ...153 routes... });
 *     ...
 *     startServer(DEFAULT_PORT);        // line 3439
 *
 * In Node that opens a listening socket. In a Worker there is no socket to
 * open, and more importantly THE HANDLER IS THE THING WE WANT. So this shim
 * captures the handler that server.js passes to createServer() and makes
 * listen() a no-op. dashboard-worker.js then feeds it Worker Requests.
 *
 * The alternative - editing server.js to export the handler - would mean
 * touching a file that the email and ClickUp path depends on. This way
 * server.js stays byte-for-byte identical.
 */

let capturedHandler = null;
let capturedPort = null;

export function createServer(handler) {
  capturedHandler = handler;
  // The returned object needs the handful of methods startServer() calls, so
  // that the retry-on-EADDRINUSE logic runs harmlessly instead of crashing.
  const server = {
    listen(port, cb) {
      capturedPort = port;
      if (typeof cb === 'function') cb();
      return server;
    },
    on() { return server; },
    once() { return server; },
    removeAllListeners() { return server; },
    close(cb) { if (typeof cb === 'function') cb(); return server; },
    emit() { return false; },
    unref() { return server; },
  };
  return server;
}

export function getHandler() { return capturedHandler; }
export function getListenPort() { return capturedPort; }

export default { createServer, getHandler, getListenPort };
