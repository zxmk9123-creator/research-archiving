const path = require('path');
const express = require('express');
const { runDueCollections } = require('./lib/collector');

const app = express();
app.use(express.json());

app.use('/api/sources', require('./routes/sources'));
app.use('/api/companies', require('./routes/companies'));
app.use('/api/items', require('./routes/items'));
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
