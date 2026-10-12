// Tiered web search for Web Research Discovery: Brave Search (tier 1,
// adapters/webSearch.js) is tried first; Firecrawl (tier 2, adapters/
// firecrawlSearch.js) and then SerpApi (tier 3, adapters/serpApiSearch.js)
// are tried in order only when every earlier tier itself throws (e.g.
// every configured Brave key 402-exhausted). The tiers are never merged
// into one key pool — each stays independently configured — so a caller
// never loses visibility into which provider actually answered. If every
// tier fails, the original (tier 1/Brave) error is what's thrown — the
// later tiers are strictly fallbacks, never a replacement.
//
// Required as module objects (not destructured) — same convention
// webSearch.js itself documents — so tests can swap any adapter's
// searchWeb for a synthetic result/throw without a real network call.
const braveAdapter = require('./webSearch');
const firecrawlAdapter = require('./firecrawlSearch');
const serpApiAdapter = require('./serpApiSearch');

const TIERS = [
  ['brave', braveAdapter],
  ['firecrawl', firecrawlAdapter],
  ['serpapi', serpApiAdapter],
];

async function searchWeb(query, options = {}) {
  let firstError;
  for (const [name, adapter] of TIERS) {
    try {
      const results = await adapter.searchWeb(query, options);
      if (firstError) console.log(`search_tier_fallback tier=${name} query=${query.slice(0, 80)} first_error=${firstError.message}`);
      return results;
    } catch (err) {
      if (!firstError) firstError = err;
    }
  }
  throw firstError;
}

module.exports = { searchWeb, MAX_RESULTS: braveAdapter.MAX_RESULTS };
