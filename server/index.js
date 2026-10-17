const path = require('path');
const express = require('express');
const { runDueCollections } = require('./lib/collector');
const { maybeRunDailyDiscovery } = require('./lib/dailyDiscovery');
const { refreshScopeTerms, maybeRunWeeklyScopeAnalysis } = require('./lib/scopeAnalysis');
const { requeueStalledPendingDrafts } = require('./lib/aiDraft');

const asyncSafety = require('./lib/asyncSafety');
asyncSafety.patchAsyncRoutes();
asyncSafety.installProcessGuards();

const app = express();
app.use(express.json());

app.use('/api/auth', require('./routes/auth'));
app.use('/api/sources', require('./routes/sources'));
app.use('/api/companies', require('./routes/companies'));
app.use('/api/items', require('./routes/items'));
app.use('/api/search', require('./routes/search'));
app.use('/api/picks', require('./routes/picks'));
app.use('/api/stats', require('./routes/stats'));
app.use('/api/headlines', require('./routes/headlines'));
app.use('/api/market-data', require('./routes/marketData'));
app.use('/api/scope-proposals', require('./routes/scopeProposals'));
app.use('/api', require('./routes/taxonomy'));

// Root cause of several "the deploy went out but the browser still shows
// the old UI" reports earlier this session: index.html/app.js/style.css
// are served under fixed filenames with no cache-busting query/hash, and
// express.static's default (no maxAge, no explicit Cache-Control) leaves
// a returning browser free to serve its own cached copy without even
// revalidating — a real redeploy can sit invisible behind a stale tab
// indefinitely.
//
// Blanket `no-cache` on every static file fixed that, but traded it for
// a different, milder symptom reported after: a slight load delay on
// every single page view, since no-cache forces an If-None-Match round
// trip to the server for EVERY asset (app.js, style.css, and the five
// small helper scripts in index.html) on every load, even when nothing
// changed — 7-8 extra round trips that a plain disk-cache hit would have
// skipped entirely. index.html itself still needs no-cache (it's the one
// file whose freshness actually matters — it's what points the browser
// at the current app.js/style.css), but the other files only need to
// catch up within some bounded window, not instantly on every load.
// `max-age=60, must-revalidate` lets a browser reuse its own cached copy
// for up to 60s with zero network round trip, then forces a real
// revalidation after that — bounding staleness to at most a minute after
// a deploy (this platform's redeploys are infrequent relative to that)
// instead of either extreme (indefinite staleness, or a round trip on
// every load).
app.use(express.static(path.join(__dirname, '..', 'public'), {
  setHeaders: (res, filePath) => {
    const cacheControl = path.basename(filePath) === 'index.html'
      ? 'no-cache'
      : 'public, max-age=60, must-revalidate';
    res.setHeader('Cache-Control', cacheControl);
  },
}));
app.get('*', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

app.use(asyncSafety.errorHandler);

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`listening on ${port}`));

// Scheduled auto-collection: check hourly for RSS sources due per their frequency_days.
const COLLECTION_CHECK_INTERVAL_MS = 60 * 60 * 1000;
setInterval(() => {
  runDueCollections().catch((err) => console.error('collection run failed', err));
}, COLLECTION_CHECK_INTERVAL_MS);

// Separate Daily Discovery job: intended to be checked on the same hourly
// cadence so the 08:00 KST window is never missed regardless of container
// timezone — but setInterval alone only ticks at container-boot-time
// offsets (e.g. a 19:20 KST boot ticks at 20:20, 21:20, ...), never
// wall-clock-aligned. A redeploy (routine on this platform — happens on
// every push) resets that offset, so a boot that never lands its hourly
// tick inside 08:00-08:59 KST skips that day's run entirely until the
// next boot's offset happens to land there (confirmed in production:
// scheduler_jobs showed daily_discovery hadn't run in over a day because
// of exactly this). Calling it once immediately on startup — in addition
// to the interval — closes that gap: any redeploy that happens to land
// during or after that day's window catches it up right away instead of
// waiting on an arbitrary future tick.
maybeRunDailyDiscovery().catch((err) => console.error('daily discovery run failed', err));
setInterval(() => {
  maybeRunDailyDiscovery().catch((err) => console.error('daily discovery run failed', err));
}, COLLECTION_CHECK_INTERVAL_MS);

// Operator-approved scope terms (scope_terms) feed the synchronous relevance
// filter through an in-memory cache — load it at boot, and run the weekly
// scope analysis on the same hourly tick (it self-gates to Mondays from
// 10:00 KST and claims the week atomically, so restarts can't double-run it).
refreshScopeTerms().catch((err) => console.error('scope terms load failed', err));
maybeRunWeeklyScopeAnalysis().catch((err) => console.error('scope analysis run failed', err));
setInterval(() => {
  maybeRunWeeklyScopeAnalysis().catch((err) => console.error('scope analysis run failed', err));
}, COLLECTION_CHECK_INTERVAL_MS);

// Uncertainty-triggered verification: entities an answer had to set aside (undated / old figures) are queued by the
// search route; this routine collects fresh sources for a few of them per tick (VERIFICATION_ROUTINE=off disables).
const verificationRoutine = require('./lib/verificationRoutine');
const VERIFICATION_TICK_MS = 30 * 60 * 1000;
setTimeout(() => verificationRoutine.runQueue().catch((err) => console.error('verification routine failed', err)), 5 * 60 * 1000);
setInterval(() => {
  verificationRoutine.runQueue().catch((err) => console.error('verification routine failed', err));
}, VERIFICATION_TICK_MS);

// Recovers Review-tab items stuck forever at ai_status='pending' — see
// requeueStalledPendingDrafts()'s own comment for the full root cause
// (a redeploy killing the process mid-generateAiDraftForItem call, with
// nothing else ever revisiting a 'pending' row afterward). Startup-only
// is enough: a process this early in its own lifecycle can't be the one
// that orphaned any 'pending' row it finds, so there's no risk of racing
// a call still genuinely in flight.
requeueStalledPendingDrafts().catch((err) => console.error('ai draft requeue failed', err));
