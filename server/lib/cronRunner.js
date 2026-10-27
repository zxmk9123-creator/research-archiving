// The cron entry (/api/cron/daily) and what it runs, kept out of server/index.js so the orchestration is testable on its own.
const crypto = require('crypto');
const { runDueCollections } = require('./collector');
const { refreshScopeTerms, maybeRunWeeklyScopeAnalysis } = require('./scopeAnalysis');
const { requeueStalledPendingDrafts } = require('./aiDraft');
const background = require('./background');
const guard = require('./cronGuard');

// "Authorization: Bearer $CRON_SECRET", compared in constant time. No secret configured means nobody is authorized.
function isCronAuthorized(req, env = process.env) {
  const secret = env.CRON_SECRET;
  if (!secret) return false;
  const given = Buffer.from(String((req.get ? req.get('authorization') : req.headers && req.headers.authorization) || ''));
  const expected = Buffer.from(`Bearer ${secret}`);
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

// How one step's return value is reported in the response.
function summarize(out) {
  if (Array.isArray(out)) {
    return { sources: out.length, ok: out.filter((r) => r && r.ok).length, failed: out.filter((r) => r && !r.ok).length, newItems: out.reduce((n, r) => n + ((r && r.count) || 0), 0) };
  }
  if (out && typeof out === 'object') {
    return { ran: out.ran, reason: out.reason, totals: out.totals, requeued: out.requeued, processed: out.processed, done: out.done, progress: out.progress, rounds: out.rounds, archived: out.archived, published: out.published, retry: out.retry, human: out.human };
  }
  return 'done';
}

// Runs [name, fn] steps in order. A throwing step is reported as "error: ..." (never aborts the rest); past the time budget steps are
// skipped, except the watchdog, which must always get to report. In a chained hop only chainSteps run.
async function runSteps(steps, { started, budgetMs, isChain = false, chainSteps = new Set(), now = () => Date.now() }) {
  const results = {};
  for (const [name, run] of steps) {
    if (isChain && !chainSteps.has(name)) continue;
    if (now() - started > budgetMs && name !== 'pipeline_watchdog') { results[name] = 'skipped_budget'; continue; }
    try {
      results[name] = summarize(await run());
    } catch (err) {
      results[name] = `error: ${String(err && err.message).slice(0, 120)}`;
    }
  }
  return results;
}

async function runDailyCron(chainDepth) {
  const started = Date.now();
  const dailyDiscovery = require('./dailyDiscovery');
  const dailyBrief = require('./dailyBrief');
  const BUDGET_MS = Number(process.env.CRON_BUDGET_MS) || 240000;
  const steps = [
    // FIRST, so it gets the whole time budget. Sliced: one call cannot run all sources (the function time limit), so each call advances a persisted cursor
    ['daily_discovery', () => dailyDiscovery.runDailyDiscoverySliced({ budgetMs: Math.max(20000, Math.min(200000, 250000 - (Date.now() - started))) })],
    // collection happens once a day, in the morning pass: these only run until today's discovery has completed
    ['collections', async () => ((await dailyDiscovery.getDailyDiscoveryStatus()).completedToday ? { ran: false, reason: 'collected_today' } : runDueCollections())],
    ['reference_collections', async () => ((await dailyDiscovery.getDailyDiscoveryStatus()).completedToday ? { ran: false, reason: 'collected_today' } : require('./referenceCollect').runReferenceCollections())],
    ['stalled_drafts', () => requeueStalledPendingDrafts({ olderThanMinutes: 20 })],
    // news held for lack of a publication date: read the page, set the date, publish (see aiDraft.js date gate)
    ['undated_news_dates', () => require('./publishedDates').fillHeldNewsDates()],
    // the long-lived server ran this every ten minutes with a small AI budget; one hourly call needs the same throughput, so it works in rounds
    ['review_autopilot', async () => {
      const autopilot = require('./reviewAutopilot');
      const total = { rounds: 0, archived: 0, published: 0, retry: 0, human: 0 };
      for (let i = 0; i < 6 && Date.now() - started < Math.min(BUDGET_MS, 170000); i++) {
        const r = await autopilot.runAutopilot({ aiBudget: 8 });
        if (!r || r.skipped) break;
        total.rounds++;
        for (const k of ['archived', 'published', 'retry', 'human']) total[k] += r[k] || 0;
        if (!(r.archived || r.published || r.retry || r.human)) break;
      }
      return total;
    }],
    // the headline is guaranteed: generated once, when collection is done (or at the 10:00 KST deadline); never refreshed
    ['ensure_daily_brief', async () => dailyBrief.ensureDailyBrief(new Date(), { discoveryDone: (await dailyDiscovery.getDailyDiscoveryStatus()).completedToday })],
    ['scope_analysis', () => maybeRunWeeklyScopeAnalysis()],
    ['entity_maintenance', () => require('./entityMaintenance').maybeRunEntityMaintenance()],
    ['verification', () => require('./verificationRoutine').runQueue()],
    // a stalled morning pipeline turns this response into an error, which fails the GitHub Actions run (email notification)
    ['pipeline_watchdog', async () => {
      const [status, brief] = await Promise.all([dailyDiscovery.getDailyDiscoveryStatus(), dailyBrief.getBriefState()]);
      const hourKst = dailyDiscovery.kstPartsOf(new Date()).hour;
      const incident = guard.pipelineIncident(status, brief, { hourKst });
      if (incident) throw new Error(incident);
      return { ran: true, reason: `${status.state}/${brief.state}` };
    }],
  ];
  // the scope-term cache that feeds the relevance filter is loaded at boot on a long-lived server; a fresh function instance starts empty
  await refreshScopeTerms().catch((err) => console.error('scope terms load failed', err));
  const results = await runSteps(steps, { started, budgetMs: BUDGET_MS, isChain: chainDepth > 0, chainSteps: new Set(['daily_discovery', 'ensure_daily_brief', 'pipeline_watchdog']) });
  // discovery is not finished: call the next hop now instead of waiting for the next external trigger
  if (guard.shouldChain(results.daily_discovery, chainDepth)) results.chained = await guard.chainNext(chainDepth + 1);
  // AI drafts / fact and relation extraction started by the steps above run in the background: wait for them before answering
  results.background_unfinished = await background.drain(Math.max(5000, 280000 - (Date.now() - started)));
  return { ok: true, elapsedMs: Date.now() - started, chain: chainDepth, results };
}

// Express handler for GET /api/cron/daily. A chained hop (x-cron-chain header, see cronGuard.js) answers 202 at once and keeps working
// in the background of its own invocation; a normal call answers with the full report.
function dailyHandler({ run = runDailyCron, track = background.track } = {}) {
  return async (req, res) => {
    if (!isCronAuthorized(req)) return res.status(401).json({ error: 'unauthorized' });
    const chainDepth = Number(req.get('x-cron-chain')) || 0;
    if (chainDepth > 0) {
      track(run(chainDepth).catch((err) => console.error('cron chain hop failed:', err.message)));
      return res.status(202).json({ chained: true, depth: chainDepth });
    }
    res.json(await run(0));
  };
}

module.exports = { isCronAuthorized, summarize, runSteps, runDailyCron, dailyHandler };
