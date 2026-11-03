// Pre-fills the UN Comtrade cache with the series people open most, so a first view is already stored. Each combination is one reporter/partner/flow
// and every item of a batch in ONE call per year (the API takes several items), over the last four years (the newest three plus the year needed for
// year-over-year). Idempotent: years already cached (and not stale) cost nothing, so it can run weekly and resume after an interruption.
const pool = require('../db/pool');
const { callComtrade } = require('./comtradeApi');
const { ensureTables, planYears, runTasks, drainRetries, LIMITS } = require('./tradePair');

// 4-digit headings for the main views, and the 6-digit codes behind the item groups (유채유 / 해바라기유 / 면실유)
const BATCHES = [['1511', '1507', '1514', '1512', '1513', '1201', '1205'], ['151411', '151419', '151211', '151219', '151221', '151229']];
const EXPORTERS = [360, 458, 32, 76, 842, 804, 643, 124, 528, 276, 764, 608];           // 총 수출을 보는 나라
const IMPORTERS = [699, 156, 410, 586, 50, 792, 818, 704, 392, 724, 380, 364, 682, 842]; // 총 수입을 보는 나라
const PAIRS = [[360, 699], [360, 156], [360, 586], [458, 699], [458, 156], [458, 528], [32, 699], [32, 156], [76, 156], [842, 156], [804, 699], [643, 699]];

const COMBOS = [
  ...EXPORTERS.map((r) => ({ reporter: r, partner: 0, flow: 'X' })),
  ...IMPORTERS.map((r) => ({ reporter: r, partner: 0, flow: 'M' })),
  ...PAIRS.map(([ex, im]) => ({ reporter: ex, partner: im, flow: 'X' })),
];

// offset/limit walk COMBOS; returns { done, next, calls, errors }.
async function runWarm({ offset = 0, limit = 6, now = new Date(), call = (p) => callComtrade(p), db = pool, years = 4 } = {}) {
  await ensureTables(db);
  const y1 = now.getUTCFullYear(); const list = Array.from({ length: years }, (_, i) => y1 - i);
  const ctx = { calls: 0, deadline: Date.now() + 240000, error: null, failed: false, split: true };
  const errors = [];
  let retry = null;
  if (offset === 0) retry = await drainRetries({ db, call, now, limit: 30, force: true, ignoreBackoff: true }).catch((e) => { errors.push(`retry queue: ${String(e && e.message).slice(0, 60)}`); return null; }); // failed years first
  for (const base of COMBOS.slice(offset, offset + limit)) {
    for (const cmds of BATCHES) {
      const tasks = await planYears(db, now, base, cmds, list);
      if (tasks.length) await runTasks(db, call, ctx, now, base, tasks, { maxCalls: 1000 });
      if (ctx.failed) { errors.push(`${base.reporter}>${base.partner}:${base.flow} ${ctx.error && ctx.error.code}`); ctx.failed = false; }
    }
  }
  const next = offset + limit < COMBOS.length ? offset + limit : null;
  return { offset, next, done: next === null, calls: ctx.calls, combos: COMBOS.length, errors, ok: errors.length === 0, ...(retry ? { retry } : {}) };
}

module.exports = { runWarm, COMBOS, BATCHES, LIMITS };
