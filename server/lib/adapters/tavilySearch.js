const { readResponseText } = require('../boundedResponse');
// Tavily adapter — a search tier of Web Research Discovery (see searchTiers.js, the only module that calls every tier).
// Own module / env vars like the other tiers: TAVILY_API_KEY (singular) and TAVILY_API_KEYS (comma list) are merged, read on every call.
const TAVILY_SEARCH_ENDPOINT = 'https://api.tavily.com/search';
const MAX_RESULTS = 10;

function getConfiguredKeys() {
  const multi = (process.env.TAVILY_API_KEYS || '').split(',').map((k) => k.trim()).filter(Boolean);
  const single = (process.env.TAVILY_API_KEY || '').trim();
  return [...new Set(single ? [single, ...multi] : multi)];
}

// Same key handling as the SerpApi tier: 429 is a per-minute limit (short pause); 432 / 433 are Tavily's plan / pay-as-you-go
// limits (parked for hours); 401 is an invalid key (parked a day). A parked key is skipped without spending a request; when every
// key is parked the call fails at once so the next tier answers.
const RATE_COOLDOWN_MS = 2 * 60 * 1000;
const EXHAUSTED_COOLDOWN_MS = 3 * 60 * 60 * 1000;
const INVALID_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const parked = new Map();
const tag = (k) => `…${String(k).slice(-4)}`;
const reasonFor = (status) => (status === 429 ? 'rate' : status === 432 || status === 433 || status === 402 ? 'exhausted' : status === 401 || status === 403 ? 'invalid' : null);
function park(apiKey, reason, now = Date.now()) {
  parked.set(apiKey, { until: now + (reason === 'invalid' ? INVALID_COOLDOWN_MS : reason === 'rate' ? RATE_COOLDOWN_MS : EXHAUSTED_COOLDOWN_MS), reason });
  console.error(`tavily key ${tag(apiKey)} parked (${reason}); next key takes over`);
}
const isParked = (apiKey, now = Date.now()) => {
  const p = parked.get(apiKey);
  if (!p) return false;
  if (p.until <= now) { parked.delete(apiKey); return false; }
  return true;
};
function getKeyStatus(now = Date.now()) {
  const keys = getConfiguredKeys();
  const parkedNow = keys.filter((k) => isParked(k, now));
  return { configured: keys.length, parked: parkedNow.length, available: keys.length - parkedNow.length, reasons: parkedNow.map((k) => ({ key: tag(k), reason: parked.get(k).reason })) };
}

async function searchWeb(query, options = {}) {
  const keys = getConfiguredKeys();
  if (!keys.length) throw new Error('no TAVILY_API_KEY(S) configured');
  const usable = keys.filter((k) => !isParked(k));
  if (!usable.length) throw new Error('search failed: all configured Tavily API keys are exhausted or invalid (cooling down)');

  const body = { query, max_results: MAX_RESULTS, search_depth: 'basic' };
  if (options.freshness === 'pw') body.time_range = 'week'; // Daily Discovery's past-week bias, same meaning as Brave's 'pw'

  let lastError;
  for (const apiKey of usable) {
    try {
      const res = await fetch(TAVILY_SEARCH_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) {
        const bodyText = await readResponseText(res, 64 * 1024, 'search API error body').catch(() => '');
        console.error(`tavily search failed: status ${res.status} key=${tag(apiKey)} body=${bodyText.slice(0, 300)}`);
        const reason = reasonFor(res.status);
        if (reason) park(apiKey, reason);
        lastError = new Error(`search failed: ${res.status}`);
        continue;
      }
      const data = JSON.parse(await readResponseText(res, 1024 * 1024, 'search API response'));
      return (Array.isArray(data && data.results) ? data.results : [])
        .map((r) => ({ title: (r.title || '').trim(), link: (r.url || '').trim() }))
        .filter((c) => c.title && c.link)
        .slice(0, MAX_RESULTS);
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError || new Error('search failed: all configured Tavily API keys failed');
}

module.exports = { searchWeb, MAX_RESULTS, getKeyStatus, _resetKeyState: () => parked.clear(), EXHAUSTED_COOLDOWN_MS };
