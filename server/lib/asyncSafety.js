// Express 4 does not catch a rejected promise from an `async` route handler: on Node >= 15 that is an
// unhandled rejection and the WHOLE process exits — taking every in-memory background job (backfills,
// collections) and every other request with it. There are ~50 async routes, so one DB hiccup anywhere was
// enough. This keeps the code of every route unchanged:
//   1) a rejected handler promise is forwarded to Express' error pipeline (-> the JSON 500 below);
//   2) a last-resort process guard logs a stray rejection/exception from background work instead of exiting.
const Layer = require('express/lib/router/layer');

let patched = false;
function patchAsyncRoutes() {
  if (patched) return;
  patched = true;
  const original = Layer.prototype.handle_request;
  Layer.prototype.handle_request = function handleRequest(req, res, next) {
    const fn = this.handle;
    if (fn.length > 3) return next(); // error-handling middleware keeps Express' own behaviour
    try {
      const result = fn(req, res, next);
      if (result && typeof result.catch === 'function') result.catch(next);
    } catch (err) {
      next(err);
    }
    return undefined;
  };
  patchAsyncRoutes.original = original;
}

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  console.error(`request failed ${req.method} ${req.originalUrl}: ${err && err.message}`);
  if (res.headersSent) return res.end();
  return res.status(500).json({ error: '서버 오류가 발생했습니다.' });
}

function installProcessGuards() {
  process.on('unhandledRejection', (reason) => console.error('unhandled rejection (kept running):', reason && reason.message ? reason.message : reason));
  process.on('uncaughtException', (err) => console.error('uncaught exception (kept running):', err && err.message ? err.message : err));
}

module.exports = { patchAsyncRoutes, errorHandler, installProcessGuards };
