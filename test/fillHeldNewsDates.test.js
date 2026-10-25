const test = require('node:test');
const assert = require('node:assert/strict');
const safeUrl = require('../server/lib/safeUrl');
const bounded = require('../server/lib/boundedResponse');
const ai = require('../server/lib/aiDraft');
const pool = require('../server/db/pool');
const { fillHeldNewsDates } = require('../server/lib/publishedDates');

const pages = {};
let applied = [];
ai.applyAiDraftIfEligible = async (id) => { applied.push(id); return { archived: id !== 4 }; };

function run(rows, pageMap) {
  const original = pool.query;
  const calls = [];
  for (const k of Object.keys(pages)) delete pages[k];
  Object.assign(pages, pageMap);
  // the response object carries its own body, so the three concurrent workers cannot see each other's page
  safeUrl.safeFetch = async (url) => ({ ok: pages[url] !== undefined, status: 200, body: pages[url] });
  bounded.readResponseText = async (res) => res.body;
  pool.query = async (text, params) => { calls.push({ text, params }); return /SELECT id, source_url FROM items/.test(text) ? { rows } : { rows: [] }; };
  applied = [];
  return fillHeldNewsDates({ limit: 10 }).then((out) => ({ out, calls })).finally(() => { pool.query = original; });
}
const meta = (d) => `<html><head><meta property="article:published_time" content="${d}T08:00:00Z"></head></html>`;

test('held news: a page that declares a date gets it and the publish step runs again; undated pages are marked checked, not retried', async () => {
  const { out, calls } = await run(
    [{ id: 1, source_url: 'https://news.example/a' }, { id: 2, source_url: 'https://news.example/nodate' }, { id: 3, source_url: 'https://www.linkedin.com/posts/x' }],
    { 'https://news.example/a': meta('2026-10-24'), 'https://news.example/nodate': '<html></html>' },
  );
  assert.deepEqual(out, { held: 3, dated: 1, published: 1, unresolved: 2 });
  assert.deepEqual(applied, [1]);
  assert.ok(calls.some((c) => /UPDATE items SET published_at/.test(c.text) && c.params[0] === 1 && c.params[1] === '2026-10-24'));
  const checked = calls.filter((c) => /undated_news_checked/.test(c.text)).map((c) => c.params[0]).sort();
  assert.deepEqual(checked, [2, 3]);
});

test('held news: a date in the URL is used without fetching the page; a publish that does not go through is not counted', async () => {
  const { out } = await run([{ id: 4, source_url: 'https://news.example/2026/10/23/palm' }], {});
  assert.deepEqual(out, { held: 1, dated: 1, published: 0, unresolved: 0 });
  assert.deepEqual(applied, [4]);
});
