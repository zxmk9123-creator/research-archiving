// Minimal in-process concurrency limiter — no queue/Redis/worker, just a
// counter and an array. Bounds how many async tasks run at once; the rest
// wait in insertion order and start as a slot frees up. Used to keep a bulk
// RSS collection from firing dozens of AI provider calls simultaneously and
// blowing through the provider's per-minute token budget.
function createLimiter(maxConcurrent) {
  let active = 0;
  const queue = [];

  function next() {
    if (active >= maxConcurrent || queue.length === 0) return;
    active++;
    const { fn, resolve, reject } = queue.shift();
    fn().then(
      (value) => { active--; resolve(value); next(); },
      (err) => { active--; reject(err); next(); }
    );
  }

  return function run(fn) {
    return new Promise((resolve, reject) => {
      queue.push({ fn, resolve, reject });
      next();
    });
  };
}

module.exports = { createLimiter };
