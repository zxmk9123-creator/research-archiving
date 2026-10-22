// UNDATED items: pages collected without a publication date (profile collection, institutional pages) cannot be judged
// by the freshness rules and drop to "시점 불명". Many carry the date in their own URL (/2025/03/12/..., 20250312,
// /2025/03/): that is the page's own evidence, used only for items that have no date at all.
const pool = require('../db/pool');

const MIN_YEAR = 2015;
function valid(y, m, d, now = new Date()) {
  if (y < MIN_YEAR || y > now.getFullYear()) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d || dt.getTime() > now.getTime()) return null;
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

// -> 'YYYY-MM-DD' (month-only dates take the 1st) or null
function dateFromUrl(url, now = new Date()) {
  const u = String(url || '');
  let m = u.match(/(?<![0-9])(20[12]\d)[\/_.-](0[1-9]|1[0-2])[\/_.-](0[1-9]|[12]\d|3[01])(?![0-9])/);
  if (m) return valid(+m[1], +m[2], +m[3], now);
  m = u.match(/(?<![0-9])(20[12]\d)(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])(?![0-9])/);
  if (m) return valid(+m[1], +m[2], +m[3], now);
  m = u.match(/\/(20[12]\d)\/(0[1-9]|1[0-2])(?:\/|$|\?)/);
  if (m) return valid(+m[1], +m[2], 1, now);
  return null;
}

async function backfillPublishedDates() {
  const { rows } = await pool.query("SELECT id, source_url FROM items WHERE published_at IS NULL AND source_url IS NOT NULL");
  let updated = 0;
  for (const r of rows) {
    const d = dateFromUrl(r.source_url);
    if (!d) continue;
    await pool.query('UPDATE items SET published_at = $2 WHERE id = $1 AND published_at IS NULL', [r.id, d]);
    updated++;
  }
  return { undated: rows.length, updated };
}

// Publication date from the page's own metadata (what the article itself declares): article:published_time, JSON-LD datePublished,
// itemprop / name="date" meta tags, <time datetime>. Returns 'YYYY-MM-DD' or null. Never guesses from the fetch time.
function dateFromHtml(html, now = new Date()) {
  return dateFromCheerio(require('cheerio').load(String(html || '').slice(0, 600000)), now);
}

// Any date string a page may hold -> 'YYYY-MM-DD' or null: ISO first, then "Oct 18th, 2025" / "18 October 2025" style text.
function normalizeDateString(raw, now = new Date()) {
  const s = String(raw || '').trim();
  if (!s) return null;
  const iso = s.match(/(20[12]\d)-(\d{2})-(\d{2})/);
  if (iso) return valid(+iso[1], +iso[2], +iso[3], now);
  const t = Date.parse(s.replace(/(\d)(st|nd|rd|th)\b/gi, '$1'));
  if (Number.isNaN(t)) return null;
  const d = new Date(t);
  return valid(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), now);
}

function dateFromCheerio($, now = new Date()) {
  const cands = [];
  const meta = ['article:published_time', 'og:article:published_time', 'og:published_time', 'datePublished', 'pubdate', 'publishdate', 'date', 'dc.date', 'dc.date.issued', 'parsely-pub-date', 'sailthru.date'];
  $('meta').each((_, el) => {
    const key = String($(el).attr('property') || $(el).attr('name') || $(el).attr('itemprop') || '').toLowerCase();
    if (meta.includes(key)) cands.push($(el).attr('content'));
  });
  $('script[type="application/ld+json"]').each((_, el) => {
    const txt = $(el).contents().text();
    for (const m of txt.matchAll(/"datePublished"\s*:\s*"([^"]+)"/g)) cands.push(m[1]);
  });
  $('[itemprop="datePublished"]').each((_, el) => { cands.push($(el).attr('content') || $(el).attr('datetime') || $(el).text()); });
  $('time[datetime]').slice(0, 3).each((_, el) => cands.push($(el).attr('datetime')));
  for (const c of cands) {
    const v = normalizeDateString(c, now);
    if (v) return v;
  }
  return null;
}

const SOCIAL_HOSTS = /(^|\.)(linkedin|facebook|instagram|x|twitter|tiktok|youtube)\.com$/i;

// Slice of undated PUBLISHED items whose page can be read; fills published_at only when the page declares a valid date.
async function backfillFromPages({ limit = 40, afterId = 0, budgetMs = 200000 } = {}) {
  const { safeFetch } = require('./safeUrl');
  const { readResponseText } = require('./boundedResponse');
  const { rows } = await pool.query(
    "SELECT id, source_url FROM items WHERE status = 'Published' AND published_at IS NULL AND source_url IS NOT NULL AND id > $1 ORDER BY id LIMIT $2",
    [afterId, limit]
  );
  const started = Date.now();
  let updated = 0; let skipped = 0; let failed = 0; let lastId = afterId;
  const queue = [...rows];
  const worker = async () => {
    while (queue.length && Date.now() - started < budgetMs) {
      const r = queue.shift();
      lastId = Math.max(lastId, r.id);
      let host = '';
      try { host = new URL(r.source_url).hostname; } catch (_) { failed++; continue; }
      if (SOCIAL_HOSTS.test(host) || /\.pdf($|\?)/i.test(r.source_url)) { skipped++; continue; }
      try {
        const res = await safeFetch(r.source_url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ResearchArchivingBot/1.0)' }, signal: AbortSignal.timeout(8000) });
        if (!res.ok) { failed++; continue; }
        const d = dateFromHtml(await readResponseText(res, 800000, 'page'));
        if (!d) { skipped++; continue; }
        await pool.query('UPDATE items SET published_at = $2 WHERE id = $1 AND published_at IS NULL', [r.id, d]);
        updated++;
      } catch (_) { failed++; }
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  const { rows: left } = await pool.query("SELECT COUNT(*) AS n FROM items WHERE status = 'Published' AND published_at IS NULL AND id > $1", [lastId]);
  return { checked: rows.length - queue.length, updated, skipped, failed, nextAfterId: queue.length ? Math.min(...queue.map((q) => q.id)) - 1 : lastId, remainingAfter: Number(left[0].n) };
}

module.exports = { dateFromUrl, dateFromHtml, dateFromCheerio, normalizeDateString, backfillPublishedDates, backfillFromPages };
