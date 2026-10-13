// Minimal in-process concurrency+rate limiter. Queue bounds prevent an
// overload from turning into unbounded waiting work. A queued task can be
// removed when its client disconnects; active work receives the same signal.
function createLimiter(maxConcurrent, minIntervalMs = 0, maxPending = Infinity) {
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
    const task = queue.shift();
    if (task.signal?.aborted) {
      task.cleanup();
      task.reject(task.signal.reason || Object.assign(new Error('request cancelled'), { name: 'AbortError' }));
      next();
      return;
    }
    active++;
    lastStart = Date.now();
    task.cleanup();
    Promise.resolve().then(() => task.fn(task.signal)).then(
      (value) => { active--; task.resolve(value); next(); },
      (err) => { active--; task.reject(err); next(); }
    );
    next();
  }
  return function run(fn, signal) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(signal.reason || Object.assign(new Error('request cancelled'), { name: 'AbortError' }));
      if (queue.length >= maxPending) {
        const err = new Error('request capacity reached');
        err.code = 'LIMITER_QUEUE_FULL';
        return reject(err);
      }
      const task = { fn, signal, resolve, reject, cleanup: () => {} };
      if (signal) {
        const onAbort = () => {
          const index = queue.indexOf(task);
          if (index !== -1) {
            queue.splice(index, 1);
            task.cleanup();
            reject(signal.reason || Object.assign(new Error('request cancelled'), { name: 'AbortError' }));
          }
        };
        signal.addEventListener('abort', onAbort, { once: true });
        task.cleanup = () => signal.removeEventListener('abort', onAbort);
      }
      queue.push(task);
      next();
    });
  };
}
module.exports = { createLimiter };
