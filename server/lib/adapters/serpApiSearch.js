const { readResponseText } = require('../boundedResponse');
// SerpApi adapter — third search tier for Web Research Discovery, used
// only when both Brave (tier 1, adapters/webSearch.js) and Firecrawl
// (tier 2, adapters/firecrawlSearch.js) fail. Kept as its own module/env
// vars, same convention as the other two tiers — see searchTiers.js, the
// only module that calls all three.
const SERPAPI_SEARCH_ENDPOINT = 'https://serpapi.com/search';
const MAX_RESULTS = 10;

// Same multi-key convention as the other two tiers: both SERPAPI_API_KEY
// (singular) and SERPAPI_API_KEYS (plural) are merged rather than one
// overriding the other — read fresh on every call, not cached at module
// load, and deduped so a key listed in both isn't tried twice.
function getConfiguredKeys() {
  return require('./envKeys').collectKeys('SERPAPI_API_KEY');
}

// EXHAUSTED-KEY HANDLING. Keys are used in order (the first is the primary); a key that SerpApi reports as out of searches
// (429 / 402, or an error saying so) is parked for EXHAUSTED_COOLDOWN_MS and the next key takes over WITHOUT spending a request on the
// parked one every time; an invalid key (401 / 403) is parked longer. A parked key is probed again after its cooldown (a quota
// resets with the billing period). When every key is parked the call fails at once so the next search tier (searchTiers.js) answers.
// Network errors and 5xx are not quota signals: the next key is tried but nothing is parked.
const EXHAUSTED_COOLDOWN_MS = 3 * 60 * 60 * 1000;
const INVALID_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const RATE_COOLDOWN_MS = 2 * 60 * 1000; // 429 is the per-hour / per-second throughput limit: a short pause, not a spent plan
const parked = new Map(); // api key -> { until, reason }
const EXHAUSTED_TEXT = /(run out of searches|out of searches|searches? (limit|quota)|plan.*(limit|exceeded)|exceeded|monthly.*limit|rate limit|too many requests)/i;
const INVALID_TEXT = /(invalid api key|api key.*(invalid|missing|revoked)|unauthorized)/i;
const tag = (k) => `…${String(k).slice(-4)}`; // log a key only by its last 4 characters

function parkReason(status, text) {
  if (status === 402) return 'exhausted';
  if (status === 429) return /(run out of searches|out of searches|plan.*(limit|exceeded)|monthly)/i.test(text) ? 'exhausted' : 'rate';
  if (status === 401 || status === 403) return INVALID_TEXT.test(text) || status === 401 ? 'invalid' : (EXHAUSTED_TEXT.test(text) ? 'exhausted' : 'invalid');
  if (EXHAUSTED_TEXT.test(text)) return 'exhausted';
  if (INVALID_TEXT.test(text)) return 'invalid';
  return null;
}
function park(apiKey, reason, now = Date.now()) {
  parked.set(apiKey, { until: now + (reason === 'invalid' ? INVALID_COOLDOWN_MS : reason === 'rate' ? RATE_COOLDOWN_MS : EXHAUSTED_COOLDOWN_MS), reason });
  console.error(`serpapi key ${tag(apiKey)} parked (${reason}); next key takes over`);
}
const isParked = (apiKey, now = Date.now()) => {
  const p = parked.get(apiKey);
  if (!p) return false;
  if (p.until <= now) { parked.delete(apiKey); return false; }
  return true;
};

// For the ops view / tests: how many keys are configured and how many are parked right now (never the keys themselves).
function getKeyStatus(now = Date.now()) {
  const keys = getConfiguredKeys();
  const parkedNow = keys.filter((k) => isParked(k, now));
  return { configured: keys.length, parked: parkedNow.length, available: keys.length - parkedNow.length, reasons: parkedNow.map((k) => ({ key: tag(k), reason: parked.get(k).reason })) };
}

async function searchWeb(query, options = {}) {
  const keys = getConfiguredKeys();
  if (!keys.length) throw new Error('no SERPAPI_API_KEY(S) configured');
  const usable = keys.filter((k) => !isParked(k));
  if (!usable.length) throw new Error('search failed: all configured SerpApi API keys are exhausted or invalid (cooling down)');

  // SerpApi has no Brave-style freshness code; map the one value any
  // existing caller actually passes (Daily Discovery's past-week bias) to
  // Google's own time-based search qualifier (`tbs=qdr:w`), same mapping
  // firecrawlSearch.js uses.
  const freshnessParam = options.freshness === 'pw' ? '&tbs=qdr:w' : '';

  let lastError;
  for (const apiKey of usable) {
    const url = `${SERPAPI_SEARCH_ENDPOINT}?engine=google&q=${encodeURIComponent(query)}&num=${MAX_RESULTS}${freshnessParam}&api_key=${encodeURIComponent(apiKey)}`;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
      if (!res.ok) {
        const bodyText = await readResponseText(res, 64 * 1024, 'search API error body').catch(() => '');
        console.error(`serpapi search failed: status ${res.status} key=${tag(apiKey)} body=${bodyText.slice(0, 300)}`);
        const reason = parkReason(res.status, bodyText);
        if (reason) park(apiKey, reason);
        lastError = new Error(`search failed: ${res.status}`);
        continue;
      }
      const data = JSON.parse(await readResponseText(res, 1024 * 1024, 'search API response'));
      if (data && typeof data.error === 'string') {
        // SerpApi can answer 200 with {"error": "..."}: an out-of-searches / invalid-key message is a key problem (next key),
        // "Google hasn't returned any results" is simply an empty result
        const reason = parkReason(200, data.error);
        if (reason) { park(apiKey, reason); lastError = new Error(`search failed: ${data.error.slice(0, 80)}`); continue; }
      }
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

module.exports = { searchWeb, MAX_RESULTS, getKeyStatus, _resetKeyState: () => parked.clear(), EXHAUSTED_COOLDOWN_MS };
