const pool = require('../db/pool');
const { parseFeed, toDateOnly } = require('./feedParser');
const { matchCompanies } = require('./companyMatch');

const MAX_ITEMS_PER_RUN = 20;

async function fetchFeedItems(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ResearchArchivingBot/1.0)' },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`fetch failed: ${res.status}`);
  const xml = await res.text();
  return parseFeed(xml).slice(0, MAX_ITEMS_PER_RUN);
}

// Collect one source: fetch its feed, skip URLs already archived (dedup),
// insert the rest as Draft items, then record success/failure on the source.
async function collectSource(source) {
  try {
    const feedItems = await fetchFeedItems(source.url);
    for (const fi of feedItems) {
      const { rows: existing } = await pool.query('SELECT id FROM items WHERE source_url = $1', [fi.link]);
      if (existing.length) continue;

      const { rows } = await pool.query(
        `INSERT INTO items (title, source_url, published_at, source_id, type, summary)
         VALUES ($1,$2,$3,$4,'뉴스',$5) RETURNING id`,
        [fi.title, fi.link, toDateOnly(fi.pubDate), source.id, fi.description]
      );
      await matchCompanies(rows[0].id, `${fi.title} ${fi.description || ''}`);
    }
    await pool.query(
      'UPDATE sources SET last_collected_at = now(), last_error = NULL, last_error_at = NULL WHERE id = $1',
      [source.id]
    );
    return { sourceId: source.id, ok: true, count: feedItems.length };
  } catch (err) {
    await pool.query(
      'UPDATE sources SET last_error = $1, last_error_at = now() WHERE id = $2',
      [err.message, source.id]
    );
    return { sourceId: source.id, ok: false, error: err.message };
  }
}

// Sources due for collection: RSS sources past their frequency window.
async function getDueSources() {
  const { rows } = await pool.query(`
    SELECT * FROM sources
    WHERE method = 'rss' AND url IS NOT NULL
      AND (last_collected_at IS NULL OR last_collected_at < now() - (frequency_days || ' days')::interval)
  `);
  return rows;
}

async function runDueCollections() {
  const sources = await getDueSources();
  const results = [];
  for (const source of sources) {
    results.push(await collectSource(source));
  }
  return results;
}

module.exports = { collectSource, getDueSources, runDueCollections };
