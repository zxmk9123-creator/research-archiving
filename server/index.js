const path = require('path');
const express = require('express');
const { runDueCollections } = require('./lib/collector');
const { maybeRunDailyDiscovery } = require('./lib/dailyDiscovery');

const app = express();
app.use(express.json());

app.use('/api/auth', require('./routes/auth'));
app.use('/api/sources', require('./routes/sources'));
app.use('/api/companies', require('./routes/companies'));
app.use('/api/items', require('./routes/items'));
app.use('/api/search', require('./routes/search'));
app.use('/api/picks', require('./routes/picks'));
app.use('/api', require('./routes/taxonomy'));

// Root cause of several "the deploy went out but the browser still shows
// the old UI" reports this session: index.html/app.js/style.css are
// served under fixed filenames with no cache-busting query/hash, and
// express.static's default (no maxAge, no explicit Cache-Control) leaves
// a returning browser free to serve its own cached copy without even
// revalidating — a real redeploy can sit invisible behind a stale tab
// indefinitely. `no-cache` forces revalidation (an If-None-Match round
// trip) on every load instead, so a changed file is always served fresh
// while an unchanged one still gets a cheap 304.
app.use(express.static(path.join(__dirname, '..', 'public'), {
  setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache'),
}));
app.get('*', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`listening on ${port}`));

// Scheduled auto-collection: check hourly for RSS sources due per their frequency_days.
const COLLECTION_CHECK_INTERVAL_MS = 60 * 60 * 1000;
setInterval(() => {
  runDueCollections().catch((err) => console.error('collection run failed', err));
}, COLLECTION_CHECK_INTERVAL_MS);

// Separate Daily Discovery job: checked on the same hourly cadence (so the
// 08:00 KST window is never missed regardless of container timezone), but
// entirely independent of the Research Sources scheduler above — it never
// changes what that scheduler runs or when.
setInterval(() => {
  maybeRunDailyDiscovery().catch((err) => console.error('daily discovery run failed', err));
}, COLLECTION_CHECK_INTERVAL_MS);
