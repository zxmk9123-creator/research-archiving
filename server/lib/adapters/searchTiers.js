// Tiered web search for Web Research Discovery: Brave Search (tier 1,
// adapters/webSearch.js) is tried first; Firecrawl (tier 2, adapters/
// firecrawlSearch.js) is tried only if Brave itself throws (e.g. every
// configured Brave key 402-exhausted). The two tiers are never merged
// into one key pool — each stays independently configured — so a caller
// never loses visibility into which provider actually answered. If both
// tiers fail, the original Brave error is what's thrown (Firecrawl is
// strictly a fallback, not a replacement).
//
// Required as module objects (not destructured) — same convention
// webSearch.js itself documents — so tests can swap either adapter's
// searchWeb for a synthetic result/throw without a real network call.
const braveAdapter = require('./webSearch');
const firecrawlAdapter = require('./firecrawlSearch');

async function searchWeb(query, options = {}) {
  try {
    return await braveAdapter.searchWeb(query, options);
  } catch (braveErr) {
    try {
      const results = await firecrawlAdapter.searchWeb(query, options);
      console.log(`search_tier_fallback query=${query.slice(0, 80)} brave_error=${braveErr.message}`);
      return results;
    } catch {
      throw braveErr;
    }
  }
}

module.exports = { searchWeb, MAX_RESULTS: braveAdapter.MAX_RESULTS };
