// Minimal in-process concurrency+rate limiter — no queue/Redis/worker, just a
// counter, an array, and a timestamp. Bounding *concurrency* alone (how many
// calls run at once) doesn't bound *rate*: with fast calls, a burst of N
// queued tasks still dispatches back-to-back as slots free up, so all of
// their tokens land inside the same provider per-minute window. minIntervalMs
// additionally spaces out when each task is allowed to *start*, spreading a
// burst across the provider's rate window instead of front-loading it.
function createLimiter(maxConcurrent, minIntervalMs = 0) {
  let active = 0;
  let lastStart = 0;
  const queue = [];
  let scheduled = false;

  function next() {
    if (active >= maxConcurrent || queue.length === 0) return;

    const elapsed = Date.now() - lastStart;
    if (minIntervalMs > 0 && lastStart !== 0 && elapsed < minIntervalMs) {
      if (!scheduled) {
        scheduled = true;
        setTimeout(() => { scheduled = false; next(); }, minIntervalMs - elapsed);
      }
      return;
    }

    active++;
    lastStart = Date.now();
    const { fn, resolve, reject } = queue.shift();
    fn().then(
      (value) => { active--; resolve(value); next(); },
      (err) => { active--; reject(err); next(); }
    );
    next(); // may still have a free concurrency slot to fill after spacing
  }

  return function run(fn) {
    return new Promise((resolve, reject) => {
      queue.push({ fn, resolve, reject });
      next();
    });
  };
}

module.exports = { createLimiter };
