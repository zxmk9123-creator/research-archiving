// The cron entry (/api/cron/daily) and what it runs, kept out of server/index.js so the orchestration is testable on its own.
const crypto = require('crypto');
const { runDueCollections } = require('./collector');
const { refreshScopeTerms, maybeRunWeeklyScopeAnalysis } = require('./scopeAnalysis');
const { requeueStalledPendingDrafts } = require('./aiDraft');
const background = require('./background');
const guard = require('./cronGuard');
const pool = require('../db/pool');
const { recordPipelineEvent } = require('./pipelineTrace');

// "Authorization: Bearer $CRON_SECRET", compared in constant time. No secret configured means nobody is authorized.
function isCronAuthorized(req, env = process.env) {
  const secret = env.CRON_SECRET;
  if (!secret) return false;
  const given = Buffer.from(String((req.get ? req.get('authorization') : req.headers && req.headers.authorization) || ''));
  const expected = Buffer.from(`Bearer ${secret}`);
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

// Steps a chained hop runs. stalled_drafts is cheap and is what recovers the AI draft a killed hop left at 'pending' (the normal call that
// would run it is budget-skipped while discovery is using the time).
// A review that starts before this takes ~70-150 s on a slow router; the headline step needs ~130 s after it, inside the ~300 s invocation.
const AUTOPILOT_CUTOFF_MS = 90000;
const CHAIN_STEPS = new Set(['daily_discovery', 'stalled_drafts', 'ensure_daily_brief', 'pipeline_watchdog']);

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
    ['daily_discovery', () => dailyDiscovery.runDailyDiscoverySliced({ budgetMs: Math.max(20000, Math.min(130000, 250000 - (Date.now() - started))) })],
    // collection happens once a day, in the morning pass: these only run until today's discovery has completed
    ['collections', async () => ((await dailyDiscovery.getDailyDiscoveryStatus()).completedToday ? { ran: false, reason: 'collected_today' } : runDueCollections())],
    ['reference_collections', async () => ((await dailyDiscovery.getDailyDiscoveryStatus()).completedToday ? { ran: false, reason: 'collected_today' } : require('./referenceCollect').runReferenceCollections())],
    ['stalled_drafts', () => requeueStalledPendingDrafts({ olderThanMinutes: 20 })],
    // news held for lack of a publication date: read the page, set the date, publish (see aiDraft.js date gate)
    ['undated_news_dates', () => require('./publishedDates').fillHeldNewsDates({ budgetMs: Math.max(0, Math.min(60000, 265000 - (Date.now() - started))) })],
    // the long-lived server ran this every ten minutes with a small AI budget; one hourly call needs the same throughput, so it works in rounds
    ['review_autopilot', async () => {
      const autopilot = require('./reviewAutopilot');
      const total = { rounds: 0, archived: 0, published: 0, retry: 0, human: 0 };
      // no new AI review after AUTOPILOT_CUTOFF_MS: the headline step below needs the rest of this invocation
      const cutoff = started + AUTOPILOT_CUTOFF_MS;
      for (let i = 0; i < 6 && Date.now() < Math.min(started + BUDGET_MS, cutoff); i++) {
        const r = await autopilot.runAutopilot({ aiBudget: 8, deadlineAt: cutoff });
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
      let warnings = [];
      let alerts = { configured: false, sent: 0, failed: 0, skipped: 0 };
      try {
        const [{ rows: tr }, { rows: ph }, { rows: hb }] = await Promise.all([
          pool.query("SELECT last_totals FROM scheduler_jobs WHERE job_name = 'pipeline_trace'"),
          pool.query("SELECT last_totals FROM scheduler_jobs WHERE job_name = 'provider_health'"),
          pool.query("SELECT last_totals FROM scheduler_jobs WHERE job_name = 'trigger_heartbeat'"),
        ]);
        warnings = guard.opsWarnings((tr[0] && tr[0].last_totals && tr[0].last_totals.events) || [], (ph[0] && ph[0].last_totals) || {}, { expectMetrics: status.completedToday });
        // scheduler-trigger health is judged on its own evidence, apart from collection/briefing completion above
        const incidents = require('./triggerHeartbeat').triggerIncidents((hb[0] && hb[0].last_totals) || null);
        const { dispatchAlerts, keyOf } = require('./opsAlerts');
        const day = new Date().toISOString().slice(0, 10);
        alerts = await dispatchAlerts([
          ...incidents.filter((i) => i.kind === 'missed').map((i) => ({ key: i.key, text: i.text })),
          ...warnings.map((w) => ({ key: keyOf(w, day), text: w })),
        ]);
        warnings = [...warnings, ...incidents.map((i) => `${i.kind === 'telemetry' ? 'telemetry: ' : ''}${i.text}`)];
      } catch (err) { console.error('ops warnings failed:', err.message); warnings = [`ops warnings unavailable: ${String(err.message).slice(0, 80)}`]; }
      return { ran: true, reason: `${status.state}/${brief.state}`, warnings, alerts };
    }],
  ];
  // the scope-term cache that feeds the relevance filter is loaded at boot on a long-lived server; a fresh function instance starts empty
  await refreshScopeTerms().catch((err) => console.error('scope terms load failed', err));
  const results = await runSteps(steps, { started, budgetMs: BUDGET_MS, isChain: chainDepth > 0, chainSteps: CHAIN_STEPS });
  // discovery is not finished: call the next hop now instead of waiting for the next external trigger
  if (guard.shouldChain(results.daily_discovery, chainDepth)) results.chained = await guard.chainNext(chainDepth + 1);
  else if (chainDepth >= guard.MAX_CHAIN_DEPTH && results.daily_discovery && results.daily_discovery.done === false) results.chained = 'depth_limit_reached';
  // what this call did, kept for the next day (Vercel keeps runtime logs for one hour only)
  await recordPipelineEvent('cron_call', { depth: chainDepth, discovery: results.daily_discovery && (results.daily_discovery.progress || results.daily_discovery.reason || results.daily_discovery), chained: results.chained || null });
  await require('./providerHealth').flush(); // PDF / provider counters recorded by the steps above
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
    // everything this invocation starts (headline generation included) is cut off by the host ~300 s after now
    const runBounded = (depth) => require('./dailyBrief').runWithDeadline(Date.now() + 285000, () => run(depth));
    if (chainDepth === 0) await require('./triggerHeartbeat').recordTrigger(req.get('user-agent') || '', req.get('x-trigger-source') || '').catch(() => {}); // external callers only
    if (chainDepth > 0) {
      track(runBounded(chainDepth).catch((err) => console.error('cron chain hop failed:', err.message)));
      return res.status(202).json({ chained: true, depth: chainDepth });
    }
    res.json(await runBounded(0));
  };
}

// GET /api/cron/health: read-only diagnosis of today's pipeline (same bearer-secret auth as the cron). Always answers 200 with the verdict in
// the body, so a caller (the pipeline-health workflow) decides what to do with it; it changes nothing.
function healthHandler({ check = () => require('./pipelineHealth').runHealthCheck() } = {}) {
  return async (req, res) => {
    if (!isCronAuthorized(req)) return res.status(401).json({ error: 'unauthorized' });
    try {
      res.json(await check());
    } catch (err) {
      res.status(500).json({ status: 'unknown', error: String(err && err.message).slice(0, 160) });
    }
  };
}

// GET /api/cron/doctor?mode=diagnose|recover (same bearer-secret auth). Default is diagnose: read-only analysis. mode=recover additionally needs
// DOCTOR_RECOVERY=on in the environment; without it the answer says recovery is not permitted and nothing is executed.
function doctorHandler({ run = (opts) => require('./pipelineDoctor').runDoctor(opts) } = {}) {
  return async (req, res) => {
    if (!isCronAuthorized(req)) return res.status(401).json({ error: 'unauthorized' });
    const mode = String((req.query && req.query.mode) || 'diagnose') === 'recover' ? 'recover' : 'diagnose';
    try {
      res.json(await run({ mode }));
    } catch (err) {
      res.status(500).json({ outcome: 'error', humanNeeded: true, error: String(err && err.message).slice(0, 160) });
    }
  };
}

module.exports = { doctorHandler, healthHandler, isCronAuthorized, summarize, runSteps, runDailyCron, dailyHandler, CHAIN_STEPS };
