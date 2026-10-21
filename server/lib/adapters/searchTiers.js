// Tiered web search for Web Research Discovery (order: Brave, Tavily, Firecrawl, SerpApi): Brave Search (tier 1,
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
const tavilyAdapter = require('./tavilySearch');

const TIERS = [
  ['brave', braveAdapter],
  ['tavily', tavilyAdapter],
  ['firecrawl', firecrawlAdapter],
  ['serpapi', serpApiAdapter],
];

// Each tier has a request-per-minute ceiling (Firecrawl's plan: 60/min). Daily Discovery fires its queries back to back, and with
// Brave failing instantly the whole burst lands on the next tier, so calls to one tier are spaced out instead of bursting.
const MIN_GAP_MS = { brave: 0, tavily: Number(process.env.TAVILY_MIN_GAP_MS) || 700, firecrawl: Number(process.env.FIRECRAWL_MIN_GAP_MS) || 1100, serpapi: Number(process.env.SERPAPI_MIN_GAP_MS) || 400 };
const nextSlot = {};
async function pace(name) {
  const gap = MIN_GAP_MS[name] || 0;
  if (!gap) return;
  const now = Date.now();
  const at = Math.max(now, nextSlot[name] || 0);
  nextSlot[name] = at + gap;
  if (at > now) await new Promise((r) => setTimeout(r, at - now));
}

async function searchWeb(query, options = {}) {
  let firstError;
  const errors = [];
  for (const [name, adapter] of TIERS) {
    try {
      await pace(name);
      const results = await adapter.searchWeb(query, options);
      if (firstError) console.log(`search_tier_fallback tier=${name} query=${query.slice(0, 80)} first_error=${firstError.message}`);
      return results;
    } catch (err) {
      if (!firstError) firstError = err;
      errors.push(`${name}: ${String(err && err.message).slice(0, 80)}`);
    }
  }
  // the first (Brave) error stays the thrown one; the later tiers' reasons ride along so a failed source shows why they did not answer
  if (errors.length > 1) firstError.message = `${firstError.message} [${errors.slice(1).join('; ')}]`;
  throw firstError;
}

module.exports = { searchWeb, MAX_RESULTS: braveAdapter.MAX_RESULTS };
