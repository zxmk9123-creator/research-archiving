// Two-country trade (exporter -> importer, or one country against all countries) from UN Comtrade, as a retrieval-first store:
//   1. READ: everything the page shows comes from the cache tables (trade_bilateral). A request that is fully cached never calls the API.
//   2. FILL: what is missing is fetched per year, several years at once and several items in one call, newest years first. A cold request answers after
//      a couple of years (fast mode) and the rest continues in the background; the page asks again until nothing is pending.
//   3. WARM: a scheduled job (tradeWarm.js) fills the common series ahead of time so most first views are already cached.
// A coverage row per (reporter, partner, flow, item, year) remembers that the year was fetched, even when it was empty, so empty years are not asked again.
const pool = require('../db/pool');
const { callComtrade } = require('./comtradeApi');
const Q = require('./tradeQuery');

const TABLES = [
  `CREATE TABLE IF NOT EXISTS trade_bilateral (
    reporter INTEGER NOT NULL, partner INTEGER NOT NULL, flow CHAR(1) NOT NULL, cmd TEXT NOT NULL, period CHAR(6) NOT NULL,
    net_wgt NUMERIC, value NUMERIC, fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY (reporter, partner, flow, cmd, period))`,
  `CREATE TABLE IF NOT EXISTS trade_bilateral_cov (
    reporter INTEGER NOT NULL, partner INTEGER NOT NULL, flow CHAR(1) NOT NULL, cmd TEXT NOT NULL, year INTEGER NOT NULL,
    rows INTEGER NOT NULL DEFAULT 0, fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY (reporter, partner, flow, cmd, year))`,
  // years whose fetch failed: retried with backoff when later requests arrive (drainRetries) and by the daily warm-up
  `CREATE TABLE IF NOT EXISTS trade_bilateral_retry (
    reporter INTEGER NOT NULL, partner INTEGER NOT NULL, flow CHAR(1) NOT NULL, cmd TEXT NOT NULL, year INTEGER NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 1, next_at TIMESTAMPTZ NOT NULL DEFAULT now(), last_error TEXT, PRIMARY KEY (reporter, partner, flow, cmd, year))`,
];
const ensured = new WeakMap();
function ensureTables(db = pool) {
  if (!ensured.has(db)) ensured.set(db, (async () => { for (const sql of TABLES) await db.query(sql); })().catch((err) => { ensured.delete(db); throw err; }));
  return ensured.get(db);
}

const DAY = 86400000;
const LIMITS = { maxCalls: 12, budgetMs: 40000, concurrency: 2, quickTasks: 2, backgroundCalls: 40 };
// the newest month the API can plausibly have is two months back; older years never change once fetched, the open years refresh
const latestMonth = (now) => Q.addMonths(`${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, '0')}`, -2);
const isStale = (year, fetchedAt, now) => now.getTime() - new Date(fetchedAt).getTime() > (year >= now.getUTCFullYear() - 1 ? 20 * DAY : 400 * DAY);

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); } }));
  return out;
}
// the same fetch asked twice at once (two people, or a poll while the background fill runs) is one call
const inflight = new Map();
function once(key, fn) {
  if (inflight.has(key)) return inflight.get(key);
  const p = Promise.resolve().then(fn).finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

// Which (year, items) still need a fetch? One query for the whole plan. Newest year first.
async function planYears(db, now, base, cmds, years) {
  const { rows } = await db.query(
    'SELECT cmd, year, fetched_at FROM trade_bilateral_cov WHERE reporter=$1 AND partner=$2 AND flow=$3 AND cmd = ANY($4::text[]) AND year = ANY($5::int[])',
    [base.reporter, base.partner, base.flow, cmds, years]);
  const fresh = new Set(rows.filter((r) => !isStale(Number(r.year), r.fetched_at, now)).map((r) => `${r.cmd}|${r.year}`));
  const last = latestMonth(now);
  return years.map((year) => ({ year, cmds: cmds.filter((c) => !fresh.has(`${c}|${year}`)) }))
    .filter((t) => t.cmds.length && `${t.year}01` <= last);
}

// Fetch the given items of one year in one call and store them. Returns { ok, calls, error }; stores nothing on failure.
async function storeYear(db, call, now, base, year, cmds, timeoutMs) {
  const last = latestMonth(now);
  const periods = Array.from({ length: 12 }, (_, i) => `${year}${String(i + 1).padStart(2, '0')}`).filter((p) => p <= last);
  const r = await call({ freq: 'M', reporter: base.reporter, partner: base.partner, flow: base.flow, cmd: cmds.join(','), periods, ...(timeoutMs ? { timeoutMs } : {}) });
  if (!r.ok) return { ok: false, calls: Math.max(1, r.calls || 1), error: { code: r.code, message: r.message } };
  const counts = new Map(cmds.map((c) => [c, 0]));
  for (const x of r.rows) {
    if (!counts.has(x.cmd)) continue;
    counts.set(x.cmd, counts.get(x.cmd) + 1);
    await db.query(
      `INSERT INTO trade_bilateral (reporter, partner, flow, cmd, period, net_wgt, value) VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (reporter, partner, flow, cmd, period) DO UPDATE SET net_wgt = EXCLUDED.net_wgt, value = EXCLUDED.value, fetched_at = now()`,
      [base.reporter, base.partner, base.flow, x.cmd, x.period, x.wgtKg, x.usd]);
  }
  for (const [cmd, rows] of counts) {
    await db.query(
      `INSERT INTO trade_bilateral_cov (reporter, partner, flow, cmd, year, rows) VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (reporter, partner, flow, cmd, year) DO UPDATE SET rows = EXCLUDED.rows, fetched_at = now()`, [base.reporter, base.partner, base.flow, cmd, year, rows]);
  }
  await db.query('DELETE FROM trade_bilateral_retry WHERE reporter=$1 AND partner=$2 AND flow=$3 AND year=$4 AND cmd = ANY($5::text[])',
    [base.reporter, base.partner, base.flow, year, cmds]).catch(() => {});
  return { ok: true, calls: Math.max(1, r.calls || 1) };
}

// Fetch one year for several items in one call and store it. Never throws; an API failure records nothing so the year is asked again next time.
// split (background and retry runs only): a combined call that timed out (error 'network', the same request would just time out again) is retried one item
// at a time with a longer timeout, so a heavy reporter/year is fetched in smaller pieces instead of failing the same way every time.
function fetchTask(db, call, now, base, task, { split = false } = {}) {
  const key = `${base.reporter}|${base.partner}|${base.flow}|${task.cmds.join(',')}|${task.year}`;
  return once(key, async () => {
    let r = await storeYear(db, call, now, base, task.year, task.cmds);
    let failedCmds = r.ok ? [] : task.cmds; let calls = r.calls; let error = r.error;
    if (!r.ok && split && r.error && r.error.code === 'network') {
      failedCmds = [];
      for (const cmd of task.cmds) {
        const one = await storeYear(db, call, now, base, task.year, [cmd], 55000);
        calls += one.calls;
        if (!one.ok) { failedCmds.push(cmd); error = one.error; if (one.error && one.error.code === 'rate_limited') break; }
      }
    }
    if (failedCmds.length) {
      // remember the failure so the year is retried later (backoff 2, 4, 8 ... up to 360 minutes); best effort, never blocks the answer
      for (const cmd of failedCmds) {
        await db.query(
          `INSERT INTO trade_bilateral_retry (reporter, partner, flow, cmd, year, last_error, next_at) VALUES ($1,$2,$3,$4,$5,$6, now() + interval '2 minutes')
           ON CONFLICT (reporter, partner, flow, cmd, year) DO UPDATE SET attempts = trade_bilateral_retry.attempts + 1, last_error = EXCLUDED.last_error,
             next_at = now() + make_interval(mins => LEAST(360, power(2, LEAST(trade_bilateral_retry.attempts + 1, 9))::int))`,
          [base.reporter, base.partner, base.flow, cmd, task.year, String(error && error.code).slice(0, 40)]).catch(() => {});
      }
      return { ok: false, calls, error: { code: error && error.code, message: error && error.message } };
    }
    return { ok: true, calls };
  });
}

// Retry failed years that are due. Called after a request is answered (so traffic itself drives the retries; at most once a minute per process)
// and at the start of the daily warm-up. Stops at the first rate limit. Returns { tasks, calls, left }.
let lastDrain = 0;
async function drainRetries({ db = pool, call = (p) => callComtrade(p), now = new Date(), limit = 2, force = false } = {}) {
  if (!force && Date.now() - lastDrain < 60000) return { tasks: 0, calls: 0, left: 0, skipped: true };
  lastDrain = Date.now();
  await ensureTables(db);
  const { rows } = await db.query('SELECT reporter, partner, flow, cmd, year FROM trade_bilateral_retry WHERE next_at <= now() ORDER BY next_at LIMIT 40');
  const groups = new Map();
  for (const x of rows) {
    const k = `${x.reporter}|${x.partner}|${x.flow}|${x.year}`;
    const g = groups.get(k) || { base: { reporter: Number(x.reporter), partner: Number(x.partner), flow: x.flow }, task: { year: Number(x.year), cmds: [] } };
    g.task.cmds.push(x.cmd); groups.set(k, g);
  }
  const ctx = { calls: 0, deadline: Date.now() + 120000, error: null, failed: false, split: true };
  const picked = [...groups.values()].slice(0, limit);
  for (const g of picked) { if (ctx.limited) break; await runTasks(db, call, ctx, now, g.base, [g.task], { maxCalls: 1000 }); }
  return { tasks: picked.length, calls: ctx.calls, left: groups.size - picked.length, failed: ctx.failed };
}

// Run tasks in parallel within a call budget. Returns { done, left } (left = tasks not started because of the budget or the deadline).
async function runTasks(db, call, ctx, now, base, tasks, { maxCalls = LIMITS.maxCalls } = {}) {
  const take = Math.max(0, maxCalls - ctx.calls);
  const now_ = tasks.slice(0, take); const left = tasks.slice(take);
  await mapLimit(now_, LIMITS.concurrency, async (t) => {
    if (Date.now() > ctx.deadline || ctx.limited) { left.push(t); return; } // rate limited: stop asking, the rest stays uncovered and is retried later
    const r = await fetchTask(db, call, now, base, t, { split: Boolean(ctx.split) });
    ctx.calls += r.calls;
    if (!r.ok) { ctx.error = r.error; ctx.failed = true; if (r.error && r.error.code === 'rate_limited') ctx.limited = true; }
  });
  return { left };
}

function sumRows(lists) {
  const by = new Map();
  for (const rows of lists) for (const r of rows) {
    const cur = by.get(r.period) || { period: r.period, wgt: null, amt: null };
    if (r.wgt != null) cur.wgt = (cur.wgt || 0) + r.wgt;
    if (r.amt != null) cur.amt = (cur.amt || 0) + r.amt;
    by.set(r.period, cur);
  }
  return [...by.values()].sort((a, b) => a.period.localeCompare(b.period));
}
async function readRows(db, { reporter, partner, flow }, cmds, from, to) {
  const lists = [];
  for (const cmd of cmds) {
    const { rows } = await db.query(
      'SELECT period, net_wgt, value FROM trade_bilateral WHERE reporter=$1 AND partner=$2 AND flow=$3 AND cmd=$4 AND period BETWEEN $5 AND $6 ORDER BY period',
      [reporter, partner, flow, cmd, from, to]);
    lists.push(rows.map((r) => ({ period: String(r.period), wgt: r.net_wgt == null ? null : Number(r.net_wgt), amt: r.value == null ? null : Number(r.value) })));
  }
  return sumRows(lists);
}

// Pure. Exporter's own report wins; the importer's mirror report is used only when the exporter has nothing in the range (one source per view,
// never mixed month by month: the two sides differ in valuation (FOB/CIF), timing and coverage).
const pickSource = (exporterRows, importerRows) => (exporterRows.length ? 'exporter_report' : importerRows.length ? 'importer_report' : 'none');

// q = { ex, im, hs, cmds?, from, to } already validated; ex or im may be 0 (all countries = Comtrade's World partner) but not both.
// fast: answer after the first few years and leave the rest to `continueLoading()` (call it in the background; `pending` says whether to).
async function loadPair(q, { call = (p) => callComtrade(p), db = pool, now = new Date(), fast = false } = {}) {
  await ensureTables(db);
  const cmds = q.cmds && q.cmds.length ? q.cmds : [q.hs.length > 6 ? q.hs.slice(0, 6) : q.hs];
  const ctx = { calls: 0, deadline: Date.now() + LIMITS.budgetMs, error: null, failed: false };
  const y0 = Number(Q.addMonths(q.from, -12).slice(0, 4)); const y1 = Number(q.to.slice(0, 4));
  const years = []; for (let y = y1; y >= y0; y--) years.push(y); // newest first: they matter most if the budget runs out
  const scope = q.ex && q.im ? 'pair' : q.ex ? 'exporter_total' : 'importer_total';
  // a country's total is that country's own report against the World partner; there is no mirror to fall back on (it would be the sum of every other country's report)
  const xKey = scope === 'importer_total' ? null : { reporter: q.ex, partner: q.im, flow: 'X' };
  const mKey = scope === 'exporter_total' ? null : { reporter: q.im, partner: q.ex, flow: 'M' };
  const lo = Q.addMonths(q.from, -12);
  const deferred = []; // [{ base, tasks }]
  let incomplete = false;

  const fill = async (base, quick) => {
    const tasks = await planYears(db, now, base, cmds, years);
    if (!tasks.length) return { pendingTasks: 0 };
    const head = quick ? tasks.slice(0, LIMITS.quickTasks) : tasks;
    const rest = quick ? tasks.slice(LIMITS.quickTasks) : [];
    const { left } = await runTasks(db, call, ctx, now, base, head);
    const leftover = [...left, ...rest];
    if (leftover.length) { deferred.push({ base, tasks: leftover }); incomplete = true; }
    return { pendingTasks: leftover.length };
  };

  let xRows = [];
  let primaryPending = 0;
  if (xKey) { primaryPending = (await fill(xKey, fast)).pendingTasks; xRows = await readRows(db, xKey, cmds, lo, q.to); }
  let mRows = []; let mirrorWanted = false;
  if (mKey && (scope === 'importer_total' || !xRows.length)) {
    if (scope === 'importer_total' || !primaryPending) { await fill(mKey, fast); mRows = await readRows(db, mKey, cmds, lo, q.to); } else mirrorWanted = true;
  }
  const source = pickSource(xRows, mRows);
  const rows = source === 'importer_report' ? mRows : xRows;

  // the rest of the fill, to run after the response; it also decides the mirror once the exporter's years are all in
  const continueLoading = async () => {
    const bg = { calls: 0, deadline: Date.now() + 250000, error: null, failed: false, split: true };
    for (const d of deferred.splice(0)) await runTasks(db, call, bg, now, d.base, d.tasks, { maxCalls: LIMITS.backgroundCalls });
    if (mirrorWanted || (scope === 'pair' && xKey && !(await readRows(db, xKey, cmds, lo, q.to)).length)) {
      const t = await planYears(db, now, mKey, cmds, years);
      await runTasks(db, call, bg, now, mKey, t, { maxCalls: LIMITS.backgroundCalls });
    }
  };
  return {
    // a failed call leaves the answer unfinished, but not pending (the page must not poll forever)
    source, scope, rows, cmds, incomplete: incomplete || mirrorWanted || ctx.failed, pending: (deferred.length > 0 || mirrorWanted) && !ctx.failed, error: ctx.error, calls: ctx.calls, continueLoading,
    series: Q.buildSeries(rows, q.from, q.to), kpis: Q.buildKpis(rows, q.from, q.to),
  };
}

module.exports = { drainRetries, loadPair, pickSource, ensureTables, latestMonth, planYears, runTasks, fetchTask, mapLimit, LIMITS };
