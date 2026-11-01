// Public-data (data.go.kr / Korea Customs) API keys for the trade-statistics tab. Keys come ONLY from environment variables (never the browser,
// never the database, never logs). Each API may have its own key; DATA_GO_KR_KEY is the shared fallback when one key serves all five.
const APIS = {
  hs_navigation: { env: 'DATA_GO_KR_HS_NAVI_KEY', label: 'HS CODE 내비게이션' },
  hs_search: { env: 'DATA_GO_KR_HS_SEARCH_KEY', label: 'HS부호검색' },
  trade_item_country: { env: 'DATA_GO_KR_TRADE_ITEM_COUNTRY_KEY', label: '품목별 국가별 수출입실적' },
  trade_country: { env: 'DATA_GO_KR_TRADE_COUNTRY_KEY', label: '국가별 수출입실적' },
  trade_item: { env: 'DATA_GO_KR_TRADE_ITEM_KEY', label: '품목별 수출입실적' },
};
const SHARED_ENV = 'DATA_GO_KR_KEY';

// data.go.kr shows an "Encoding" (percent-escaped) and a "Decoding" key. Store either: an escaped one is decoded once so it is never double-encoded.
function normalizeKey(raw) {
  const k = String(raw || '').trim();
  if (!k) return '';
  if (/%[0-9A-Fa-f]{2}/.test(k)) { try { return decodeURIComponent(k); } catch (_) { return k; } }
  return k;
}

function keyFor(api, env = process.env) {
  const def = APIS[api];
  if (!def) return '';
  return normalizeKey(env[def.env]) || normalizeKey(env[SHARED_ENV]);
}

// Which APIs can be called. Booleans only: a key value is never returned.
function tradeKeysStatus(env = process.env) {
  return Object.fromEntries(Object.entries(APIS).map(([id, def]) => [id, {
    label: def.label,
    env: def.env,
    configured: Boolean(keyFor(id, env)),
    source: normalizeKey(env[def.env]) ? 'own' : normalizeKey(env[SHARED_ENV]) ? 'shared' : 'none',
  }]));
}

module.exports = { APIS, SHARED_ENV, keyFor, tradeKeysStatus, normalizeKey };
