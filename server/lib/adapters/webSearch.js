// Web Research Discovery adapter — a bounded, scope-anchored search-API
// lookup for exactly ONE fixed, hand-written query string. This is
// deliberately NOT a crawler: it never follows a result's links, never
// explores site structure, never discovers a sitemap, and never
// generates its own queries — it only ever asks the one query it was
// given and returns a capped list of candidates, the same {title, link}
// shape institutionPdf.js's discoverReports() already produces.
//
// Uses the Brave Search API directly via native fetch — no new npm
// dependency, same convention as every other adapter in this codebase.
const BRAVE_SEARCH_ENDPOINT = 'https://api.search.brave.com/res/v1/web/search';
const MAX_RESULTS = 10;

// options.freshness maps directly to Brave's `freshness` param (e.g. 'pd'
// past day, 'pw' past week, 'pm' past month, or an explicit
// 'YYYY-MM-DDtoYYYY-MM-DD' range) — optional, omitted entirely by default
// so every existing caller (the hourly scheduler, the daily Discovery job)
// keeps searching with no date constraint, unchanged.
async function searchWeb(query, options = {}) {
  const apiKey = process.env.BRAVE_SEARCH_API_KEY;
  if (!apiKey) throw new Error('no BRAVE_SEARCH_API_KEY configured');

  const freshnessParam = options.freshness ? `&freshness=${encodeURIComponent(options.freshness)}` : '';
  const url = `${BRAVE_SEARCH_ENDPOINT}?q=${encodeURIComponent(query)}&count=${MAX_RESULTS}${freshnessParam}`;
  const res = await fetch(url, {
    headers: {
      Accept: 'application/json',
      'X-Subscription-Token': apiKey,
    },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`search failed: ${res.status}`);
  const data = await res.json();

  const rawResults = (data && data.web && Array.isArray(data.web.results)) ? data.web.results : [];
  return rawResults
    .map((r) => ({ title: (r.title || '').trim(), link: (r.url || '').trim() }))
    .filter((c) => c.title && c.link)
    .slice(0, MAX_RESULTS);
}

module.exports = { searchWeb, MAX_RESULTS };
