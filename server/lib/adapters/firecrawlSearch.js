const { readResponseText } = require('../boundedResponse');
// Firecrawl Search adapter — second search tier for Web Research
// Discovery, used only as a fallback when Brave Search (adapters/
// webSearch.js, the primary tier) fails outright (all configured keys
// exhausted/erroring). Kept as its own module/env vars rather than merged
// into Brave's key rotation, so each tier stays independently
// configurable and distinguishable in logs — see searchTiers.js, the only
// module that calls both.
const FIRECRAWL_SEARCH_ENDPOINT = 'https://api.firecrawl.dev/v1/search';
const MAX_RESULTS = 10;

// Same multi-key convention as webSearch.js's getConfiguredKeys(): both
// FIRECRAWL_API_KEY (singular) and FIRECRAWL_API_KEYS (plural) are merged
// rather than one overriding the other — read fresh on every call, not
// cached at module load, and deduped so a key listed in both isn't tried
// twice.
function getConfiguredKeys() {
  const multi = (process.env.FIRECRAWL_API_KEYS || '').split(',').map((k) => k.trim()).filter(Boolean);
  const single = (process.env.FIRECRAWL_API_KEY || '').trim();
  // Numbered keys (FIRECRAWL_API_KEY_2, _3, ...) let a new key be ADDED as its
  // own variable without having to read back and rewrite the plural list.
  const numbered = Object.keys(process.env)
    .filter((k) => /^FIRECRAWL_API_KEY_\d+$/.test(k))
    .sort((a, b) => Number(a.split('_').pop()) - Number(b.split('_').pop()))
    .map((k) => (process.env[k] || '').trim())
    .filter(Boolean);
  const all = [...(single ? [single] : []), ...numbered, ...multi];
  return [...new Set(all)];
}

async function searchWeb(query, options = {}) {
  const keys = getConfiguredKeys();
  if (!keys.length) throw new Error('no FIRECRAWL_API_KEY(S) configured');

  const body = { query, limit: MAX_RESULTS };
  // Firecrawl has no Brave-style freshness code; map the one value any
  // existing caller actually passes (Daily Discovery's past-week bias) to
  // Firecrawl's own time-based search operator.
  if (options.freshness === 'pw') body.tbs = 'qdr:w';

  let lastError;
  for (const apiKey of keys) {
    try {
      const res = await fetch(FIRECRAWL_SEARCH_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) {
        const bodyText = await readResponseText(res, 64 * 1024, 'search API error body').catch(() => '');
        console.error(`firecrawl search failed: status ${res.status} body=${bodyText.slice(0, 300)}`);
        lastError = new Error(`search failed: ${res.status}`);
        continue;
      }
      const data = JSON.parse(await readResponseText(res, 1024 * 1024, 'search API response'));
      const rawResults = (data && Array.isArray(data.data)) ? data.data : [];
      return rawResults
        .map((r) => ({ title: (r.title || '').trim(), link: (r.url || '').trim() }))
        .filter((c) => c.title && c.link)
        .slice(0, MAX_RESULTS);
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError || new Error('search failed: all configured Firecrawl API keys failed');
}

module.exports = { searchWeb, MAX_RESULTS, _getConfiguredKeysForTests: getConfiguredKeys };
