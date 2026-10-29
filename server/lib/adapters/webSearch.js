const { readResponseText } = require('../boundedResponse');
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
// query until the next billing cycle. BRAVE_SEARCH_API_KEY (singular) is
// merged in alongside BRAVE_SEARCH_API_KEYS (plural) rather than overridden
// by it — both can hold a distinct key at once, and a setup that sets both
// must not have the singular one silently dropped from the rotation. Read
// fresh on every call, not cached at module load, so a key added via an env
// var update takes effect without a restart. Deduped so the same key listed
// in both vars isn't tried twice.
function getConfiguredKeys() {
  return require('./envKeys').collectKeys('BRAVE_SEARCH_API_KEY');
}

// Per-key health (quota 402 / rate 429 / auth 401,403 parks, each with its own recovery time) lives in providerHealth so it is
// shared across serverless instances instead of being re-discovered on every cold start.
// The last key that actually worked, so the next call starts there.
let lastGoodKeyIndex = 0;

function _resetKeyStateForTests() {
  lastGoodKeyIndex = 0;
  require('../providerHealth')._resetForTests();
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

  const health = require('../providerHealth');
  const ids = keys.map(health.keyId);
  const available = [];
  for (let i = 0; i < keys.length; i++) if (!(await health.isParked('brave', ids[i]))) available.push(i);
  if (!available.length) {
    const info = ids.map((id) => health.parkedInfo('brave', id)).filter(Boolean);
    const quotaOnly = info.length && info.every((v) => v.reason === 'quota');
    throw new Error(quotaOnly || !info.length
      ? `search failed: 402 (all ${keys.length} configured Brave Search API key(s) exhausted)`
      : `search failed: all ${keys.length} configured Brave Search API key(s) unavailable (${[...new Set(info.map((v) => v.reason))].join(',')})`);
  }

  const failures = [];
  for (let n = 0; n < available.length; n++) {
    const idx = available[(Math.max(0, available.indexOf(lastGoodKeyIndex)) + n) % available.length];
    const apiKey = keys[idx];
    const kid = ids[idx];
    let res;
    try {
      res = await fetch(url, {
        headers: { Accept: 'application/json', 'X-Subscription-Token': apiKey },
        signal: AbortSignal.timeout(15000),
      });
    } catch (err) {
      health.record('brave', 'server', { kid, note: `network: ${err.message}` });
      failures.push('network');
      continue;
    }
    if (!res.ok) {
      const category = health.classify(res.status);
      const retryAfter = Number(res.headers && res.headers.get && res.headers.get('retry-after'));
      health.record('brave', category, { kid, retryAfterMs: retryAfter > 0 ? retryAfter * 1000 : 0, note: String(res.status) });
      failures.push(res.status);
      if (category === 'other') {
        const bodyText = await readResponseText(res, 64 * 1024, 'search API error body').catch(() => '');
        console.error(`brave search failed: status ${res.status} key=${idx + 1}/${keys.length} body=${bodyText.slice(0, 300)}`);
        throw new Error(`search failed: ${res.status}`);
      }
      continue; // quota/rate/auth/5xx on this key: try the next eligible key
    }
    health.record('brave', 'success', { kid });
    lastGoodKeyIndex = idx;
    const data = JSON.parse(await readResponseText(res, 1024 * 1024, 'search API response'));

    const rawResults = (data && data.web && Array.isArray(data.web.results)) ? data.web.results : [];
    return rawResults
      .map((r) => ({ title: (r.title || '').trim(), link: (r.url || '').trim() }))
      .filter((c) => c.title && c.link)
      .slice(0, MAX_RESULTS);
  }
  const last = failures[failures.length - 1];
  const all402 = failures.every((f) => f === 402);
  throw new Error(all402
    ? `search failed: 402 (all ${keys.length} configured Brave Search API key(s) exhausted)`
    : `search failed: ${last} (${failures.length} Brave key attempt(s) failed: ${failures.join(',')})`);
}

module.exports = { searchWeb, MAX_RESULTS, _resetKeyStateForTests };
