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

// Multiple free-tier Brave accounts' keys, comma-separated, so a key that
// hits its monthly quota (HTTP 402) doesn't take down every Web Discovery
// query until the next billing cycle. BRAVE_SEARCH_API_KEY (singular) keeps
// working unchanged for a single-key setup — read fresh on every call, not
// cached at module load, so a key added via an env var update takes effect
// without a restart.
function getConfiguredKeys() {
  const multi = process.env.BRAVE_SEARCH_API_KEYS;
  if (multi && multi.trim()) return multi.split(',').map((k) => k.trim()).filter(Boolean);
  const single = process.env.BRAVE_SEARCH_API_KEY;
  return single ? [single] : [];
}

// Keys confirmed exhausted (HTTP 402) this process's lifetime. Brave's 402
// is a monthly billing-cycle limit, not a transient fault, so there is no
// point re-trying an exhausted key until the next deploy/restart — which
// clears this Set along with the rest of this module's state.
const exhaustedKeys = new Set();
// The last key that actually worked, so the next call starts there instead
// of re-discovering already-exhausted keys from the front every time.
let lastGoodKeyIndex = 0;

// Test-only: both the exhausted-key set and the round-robin position are
// process-lifetime module state (same convention as freellmapi's
// wake-detect.ts _resetForTests), so a test that simulates exhaustion must
// reset them or it leaks into every test that runs after it.
function _resetKeyStateForTests() {
  exhaustedKeys.clear();
  lastGoodKeyIndex = 0;
}

// options.freshness maps directly to Brave's `freshness` param (e.g. 'pd'
// past day, 'pw' past week, 'pm' past month, or an explicit
// 'YYYY-MM-DDtoYYYY-MM-DD' range) — optional, omitted entirely by default
// so every existing caller (the hourly scheduler, the daily Discovery job)
// keeps searching with no date constraint, unchanged.
async function searchWeb(query, options = {}) {
  const keys = getConfiguredKeys();
  if (!keys.length) throw new Error('no BRAVE_SEARCH_API_KEY(S) configured');

  const freshnessParam = options.freshness ? `&freshness=${encodeURIComponent(options.freshness)}` : '';
  const url = `${BRAVE_SEARCH_ENDPOINT}?q=${encodeURIComponent(query)}&count=${MAX_RESULTS}${freshnessParam}`;

  const availableKeys = keys.filter((k) => !exhaustedKeys.has(k));
  if (!availableKeys.length) {
    throw new Error(`search failed: 402 (all ${keys.length} configured Brave Search API key(s) exhausted)`);
  }

  let lastStatus;
  for (let i = 0; i < availableKeys.length; i++) {
    const apiKey = availableKeys[(lastGoodKeyIndex + i) % availableKeys.length];
    const res = await fetch(url, {
      headers: {
        Accept: 'application/json',
        'X-Subscription-Token': apiKey,
      },
      signal: AbortSignal.timeout(15000),
    });
    if (res.status === 402) {
      exhaustedKeys.add(apiKey);
      lastStatus = 402;
      continue;
    }
    if (!res.ok) throw new Error(`search failed: ${res.status}`);
    lastGoodKeyIndex = keys.indexOf(apiKey);
    const data = await res.json();

    const rawResults = (data && data.web && Array.isArray(data.web.results)) ? data.web.results : [];
    return rawResults
      .map((r) => ({ title: (r.title || '').trim(), link: (r.url || '').trim() }))
      .filter((c) => c.title && c.link)
      .slice(0, MAX_RESULTS);
  }
  throw new Error(`search failed: ${lastStatus} (all configured Brave Search API keys exhausted)`);
}

module.exports = { searchWeb, MAX_RESULTS, _resetKeyStateForTests };
