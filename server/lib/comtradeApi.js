// UN Comtrade data API (comtradeapi.un.org): bilateral trade between any two reporting countries. Read-only client; the key goes only into the
// subscription header and never into a result, a log line or an error message. Periods are batched, and when the API names a smaller
// maximum ("Maximum number of periods ... is N") the batch size adapts and the call is repeated.
const BASE = 'https://comtradeapi.un.org/data/v1/get/C';
const TIMEOUT_MS = 25000;
const KEY_ENVS = ['UN_CONTRADE', 'UN_COMTRADE', 'COMTRADE_API_KEY']; // UN_CONTRADE is the name already set in Vercel (sic)

function comtradeKey(env = process.env) {
  for (const k of KEY_ENVS) { const v = String(env[k] || '').trim(); if (v) return v; }
  return '';
}

// Pure. rows: the API's data array -> [{ period, reporter, partner, flow, cmd, wgtKg, usd }], only the all-modes / all-customs / no second-partner
// aggregate (what the headline numbers mean). Weight prefers netWgt; when it is missing the quantity counts only if its unit is kg (code 8).
function parseComtrade(body) {
  const data = body && Array.isArray(body.data) ? body.data : [];
  const best = new Map();
  for (const r of data) {
    if (r.isAggregate === false) continue;
    if ((r.partner2Code || 0) !== 0 || (r.motCode || 0) !== 0 || (r.customsCode && r.customsCode !== 'C00')) continue;
    let wgt = Number(r.netWgt) > 0 ? Number(r.netWgt) : (Number(r.qtyUnitCode) === 8 && Number(r.qty) > 0 ? Number(r.qty) : null);
    const usd = Number(r.primaryValue) > 0 ? Number(r.primaryValue) : (Number(r.fobvalue) > 0 ? Number(r.fobvalue) : (Number(r.cifvalue) > 0 ? Number(r.cifvalue) : null));
    if (wgt == null && usd == null) continue;
    const row = { period: String(r.period), reporter: Number(r.reporterCode), partner: Number(r.partnerCode), flow: String(r.flowCode), cmd: String(r.cmdCode), wgtKg: wgt, usd };
    best.set(`${row.period}|${row.cmd}`, row);
  }
  return [...best.values()];
}

// One logical request over many periods. params = { freq:'M'|'A', reporter, partner, flow:'X'|'M', cmd, periods:[...] }.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// seconds to wait before retrying: the Retry-After header, else "... in N seconds" from the message, else 2 s
function retryDelayMs(res, msg) {
  const h = Number(res.headers && res.headers.get && res.headers.get('retry-after'));
  const m = Number.isFinite(h) && h > 0 ? h : Number((String(msg).match(/in\s+(\d+)\s+second/i) || [])[1]);
  return (Number.isFinite(m) && m > 0 ? m : 2) * 1000;
}
const MAX_RETRY_WAIT_MS = 6000;

async function callComtrade(params, { fetchImpl = fetch, env = process.env, batch = 12, wait = sleep } = {}) {
  const key = comtradeKey(env);
  if (!key) return { ok: false, code: 'no_key', message: 'UN_CONTRADE is not set', rows: [], calls: 0 };
  const rows = []; let calls = 0; let size = Math.max(1, batch); let retries = 0;
  const todo = [...params.periods];
  while (todo.length) {
    const part = todo.slice(0, size);
    const q = new URLSearchParams({ reporterCode: String(params.reporter), partnerCode: String(params.partner), cmdCode: String(params.cmd), flowCode: params.flow, period: part.join(',') });
    let res; let body; let text = '';
    try {
      calls++;
      res = await fetchImpl(`${BASE}/${params.freq}/HS?${q}`, { headers: { 'Ocp-Apim-Subscription-Key': key, Accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT_MS) });
      text = await res.text();
      try { body = JSON.parse(text); } catch (_) { body = null; }
    } catch (err) {
      return { ok: false, code: 'network', message: String(err && err.message).split(key).join('[key]').slice(0, 100), rows, calls };
    }
    const msg = String((body && (body.error || body.message)) || text || '').split(key).join('[key]').slice(0, 160);
    const max = msg.match(/Maximum number of periods[^0-9]*(\d+)/i);
    if (res.status === 400 && max && Number(max[1]) >= 1 && Number(max[1]) < size) { size = Number(max[1]); calls--; continue; } // smaller batch, same call count basis
    if (res.status === 401 || res.status === 403) return { ok: false, code: 'auth', status: res.status, message: 'the subscription key was refused', rows, calls };
    if (res.status === 429 && retries < 2) {
      const ms = retryDelayMs(res, msg);
      if (ms <= MAX_RETRY_WAIT_MS) { retries++; await wait(ms); continue; } // short limit: wait it out, then ask again
    }
    if (res.status === 429) return { ok: false, code: 'rate_limited', status: 429, message: msg, rows, calls };
    if (!res.ok) return { ok: false, code: 'http_error', status: res.status, message: msg, rows, calls };
    rows.push(...parseComtrade(body));
    todo.splice(0, part.length);
  }
  return { ok: true, code: 'ok', rows, calls };
}

module.exports = { comtradeKey, parseComtrade, callComtrade, KEY_ENVS };
