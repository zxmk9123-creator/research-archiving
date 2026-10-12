// SerpApi adapter — third search tier for Web Research Discovery, used
// only when both Brave (tier 1, adapters/webSearch.js) and Firecrawl
// (tier 2, adapters/firecrawlSearch.js) fail. Kept as its own module/env
// vars, same convention as the other two tiers — see searchTiers.js, the
// only module that calls all three.
const SERPAPI_SEARCH_ENDPOINT = 'https://serpapi.com/search';
const MAX_RESULTS = 10;

// Same multi-key convention as the other two tiers: read fresh on every
// call, not cached at module load.
function getConfiguredKeys() {
  const multi = process.env.SERPAPI_API_KEYS;
  if (multi && multi.trim()) return multi.split(',').map((k) => k.trim()).filter(Boolean);
  const single = (process.env.SERPAPI_API_KEY || '').trim();
  return single ? [single] : [];
}

async function searchWeb(query, options = {}) {
  const keys = getConfiguredKeys();
  if (!keys.length) throw new Error('no SERPAPI_API_KEY(S) configured');

  // SerpApi has no Brave-style freshness code; map the one value any
  // existing caller actually passes (Daily Discovery's past-week bias) to
  // Google's own time-based search qualifier (`tbs=qdr:w`), same mapping
  // firecrawlSearch.js uses.
  const freshnessParam = options.freshness === 'pw' ? '&tbs=qdr:w' : '';

  let lastError;
  for (const apiKey of keys) {
    const url = `${SERPAPI_SEARCH_ENDPOINT}?engine=google&q=${encodeURIComponent(query)}&num=${MAX_RESULTS}${freshnessParam}&api_key=${encodeURIComponent(apiKey)}`;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
      if (!res.ok) {
        const bodyText = await res.text().catch(() => '');
        console.error(`serpapi search failed: status ${res.status} body=${bodyText.slice(0, 300)}`);
        lastError = new Error(`search failed: ${res.status}`);
        continue;
      }
      const data = await res.json();
      const rawResults = Array.isArray(data && data.organic_results) ? data.organic_results : [];
      return rawResults
        .map((r) => ({ title: (r.title || '').trim(), link: (r.link || '').trim() }))
        .filter((c) => c.title && c.link)
        .slice(0, MAX_RESULTS);
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError || new Error('search failed: all configured SerpApi API keys failed');
}

module.exports = { searchWeb, MAX_RESULTS };
