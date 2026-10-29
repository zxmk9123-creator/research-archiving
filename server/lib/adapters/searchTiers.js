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

// Tiers other than Brave do not record their own health, so it is done here: one outcome per attempt, plus whether a fallback
// (any tier after the first failure) actually answered. Brave records per key inside its adapter.
const failureCategory = (err) => {
  const m = String((err && err.message) || err);
  const code = /(?:status |: )(\d{3})\b/.exec(m);
  if (code) return require('../providerHealth').classify(Number(code[1]));
  if (/no [A-Z_]+\(?S?\)? configured/.test(m)) return 'config';
  if (/exhausted|cooling down/i.test(m)) return 'quota';
  if (/fetch failed|timeout|timed out|aborted|ECONN|ENOTFOUND|EAI_AGAIN/i.test(m)) return 'server';
  return 'other';
};

async function searchWeb(query, options = {}) {
  const health = require('../providerHealth');
  let firstError;
  const errors = [];
  try {
    for (const [name, adapter] of TIERS) {
      try {
        await pace(name);
        const results = await adapter.searchWeb(query, options);
        if (name !== 'brave') health.record(name, 'success');
        if (firstError) {
          health.record(name, 'fallback_ok');
          console.log(`search_tier_fallback tier=${name} query=${query.slice(0, 80)} first_error=${firstError.message}`);
        }
        return results;
      } catch (err) {
        if (!firstError) firstError = err;
        if (name !== 'brave') {
          const category = failureCategory(err);
          health.record(name, category, { note: String(err && err.message).slice(0, 100) });
          if (firstError !== err) health.record(name, 'fallback_fail', { note: `${category}: ${String(err && err.message).slice(0, 80)}` });
        }
        errors.push(`${name}: ${String(err && err.message).slice(0, 80)}`);
      }
    }
  } finally {
    await health.flush();
  }
  // the first (Brave) error stays the thrown one; the later tiers' reasons ride along so a failed source shows why they did not answer
  if (errors.length > 1) firstError.message = `${firstError.message} [${errors.slice(1).join('; ')}]`;
  throw firstError;
}

module.exports = { searchWeb, MAX_RESULTS: braveAdapter.MAX_RESULTS };
