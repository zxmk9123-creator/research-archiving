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

app.use(express.static(path.join(__dirname, '..', 'public')));
app.get('*', (req, res) => {
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
