// Korea Customs trade-statistics open APIs (data.go.kr). Read-only client: builds the request, parses the XML answer tolerantly and reports
// errors by name. The key is only ever sent to apis.data.go.kr and never appears in a result or a log line.
const { keyFor } = require('./tradeApiConfig');

const BASE = 'https://apis.data.go.kr/1220000';
const ENDPOINTS = {
  trade_item: `${BASE}/Itemtrade/getItemtradeList`,            // 품목별 수출입실적
  trade_country: `${BASE}/nationtrade/getNationtradeList`,      // 국가별 수출입실적
  trade_item_country: `${BASE}/nitemtrade/getNitemtradeList`,   // 품목별 국가별 수출입실적
};
const TIMEOUT_MS = 20000;
const RETRIES = 2;

const tag = (xml, name) => { const m = xml.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`)); return m ? m[1].trim() : null; };
const num = (v) => { if (v == null) return null; const n = Number(String(v).replace(/,/g, '')); return Number.isFinite(n) ? n : null; };

// Pure. Returns { ok, code, message, rows:[{period, hsCode, name, countryCode, countryName, expWgt, expAmt, impWgt, impAmt}], fields }.
// The year field is "2024.01"-style for a month; a total row ("총계") has no month and is skipped.
function parseTradeXml(xml) {
  const text = String(xml || '');
  const errMsg = tag(text, 'errMsg') || tag(text, 'returnAuthMsg');
  const resultCode = tag(text, 'resultCode');
  const resultMsg = tag(text, 'resultMsg');
  if (errMsg && !resultCode) return { ok: false, code: tag(text, 'returnReasonCode') || 'auth', message: errMsg, rows: [], fields: [] };
  if (resultCode && resultCode !== '00') return { ok: false, code: resultCode, message: resultMsg || 'error', rows: [], fields: [] };
  if (!resultCode && !/<response|<items|<item>/.test(text)) return { ok: false, code: 'bad_response', message: 'not an API answer', rows: [], fields: [] };
  const items = [...text.matchAll(/<item>([\s\S]*?)<\/item>/g)].map((m) => m[1]);
  const fields = items.length ? [...new Set([...items[0].matchAll(/<([A-Za-z0-9_]+)>/g)].map((m) => m[1]))] : [];
  const rows = [];
  for (const it of items) {
    const year = tag(it, 'year') || '';
    const m = year.match(/^(\d{4})[.\-/]?(\d{2})$/);
    if (!m) continue; // 총계 / unrecognised
    rows.push({
      period: `${m[1]}${m[2]}`,
      hsCode: tag(it, 'hsCode') || tag(it, 'hsCd') || '',
      name: tag(it, 'statKor') || null,
      countryCode: tag(it, 'statCd') || tag(it, 'cntyCd') || '',
      countryName: tag(it, 'statCdCntnKor1') || tag(it, 'cntyNm') || null,
      expWgt: num(tag(it, 'expWgt')), expAmt: num(tag(it, 'expDlr')),
      impWgt: num(tag(it, 'impWgt')), impAmt: num(tag(it, 'impDlr')),
    });
  }
  return { ok: true, code: resultCode || '00', message: resultMsg || 'OK', rows, fields };
}

// One call. api = trade_item | trade_country | trade_item_country; params = { from:'YYYYMM', to:'YYYYMM', hs?, country? }.
async function callTradeApi(api, params, { fetchImpl = fetch, env = process.env } = {}) {
  const url0 = ENDPOINTS[api];
  const key = keyFor(api, env);
  if (!url0) return { ok: false, code: 'unknown_api', message: api, rows: [], fields: [] };
  if (!key) return { ok: false, code: 'no_key', message: `no key for ${api}`, rows: [], fields: [] };
  const q = new URLSearchParams({ serviceKey: key, strtYymm: params.from, endYymm: params.to });
  if (params.hs) q.set('hsSgn', params.hs);
  if (params.country) q.set('cntyCd', params.country);
  let last = { ok: false, code: 'network', message: 'no attempt', rows: [], fields: [] };
  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    try {
      const res = await fetchImpl(`${url0}?${q}`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      const body = await res.text();
      const parsed = parseTradeXml(body);
      if (parsed.ok || res.status < 500) return { ...parsed, status: res.status };
      last = { ...parsed, status: res.status };
    } catch (err) {
      last = { ok: false, code: 'network', message: String(err && err.message).replace(key, '[key]').slice(0, 100), rows: [], fields: [] };
    }
  }
  return last;
}

module.exports = { ENDPOINTS, parseTradeXml, callTradeApi };
