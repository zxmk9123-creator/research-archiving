// Dependency check for the hosted app: one tiny real call per external service, reported without ever returning a key, a full URL
// or a response body beyond a short scrubbed snippet. Run through the CRON_SECRET-guarded route /api/cron/diagnose.
const pool = require('../db/pool');

const EXPECTED_ENV = [
  ['DATABASE_URL', true], ['ADMIN_PASSWORD', true], ['CRON_SECRET', true], ['FREELLMAPI_BASE_URL', true],
  ['FREELLMAPI key (FREELLMAPI_API_KEY | FreeLLMAPIKEY)', true],
  ['search key (BRAVE_SEARCH_API_KEY* | TAVILY_API_KEY* | FIRECRAWL_API_KEY* | SERPAPI_API_KEY*)', true],
  ['FREELLMAPI_CHAT_API_KEY', false], ['FREELLMAPI_MODEL', false], ['BARCHART_ONDEMAND_API_KEY', false],
];

const timed = async (fn) => { const t = Date.now(); try { return { ok: true, ms: 0, ...(await fn()), ms: Date.now() - t }; } catch (err) { return { ok: false, error: String(err && err.message).slice(0, 200), ms: Date.now() - t }; } };
const scrub = (s) => String(s || '').replace(/\s+/g, ' ').replace(/(sk|tvly|fc|key)[-_A-Za-z0-9]{12,}/gi, '[redacted]').slice(0, 140);

async function checkFreeLLM() {
  const base = process.env.FREELLMAPI_BASE_URL;
  const key = (process.env.FREELLMAPI_CHAT_API_KEY || process.env.FREELLMAPI_API_KEY || process.env.FreeLLMAPIKEY || '').trim();
  if (!base) throw new Error('FREELLMAPI_BASE_URL is not set');
  if (!key) throw new Error('no FreeLLMAPI key is set');
  let host = '(unparseable URL)'; let path = '';
  try { const u = new URL(base); host = u.host; path = u.pathname; } catch (_) { /* reported below */ }
  const res = await fetch(`${base.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({ model: process.env.FREELLMAPI_MODEL || 'auto', max_tokens: 16, messages: [{ role: 'user', content: 'Reply with the single word: ok' }] }),
    signal: AbortSignal.timeout(60000),
  });
  const text = await res.text();
  let content = null;
  try { const j = JSON.parse(text); content = j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content; } catch (_) { /* not JSON */ }
  const type = res.headers.get('content-type') || '';
  const ok = res.ok && Boolean(content);
  const hint = ok ? undefined
    : /html/i.test(type) || /^\s*</.test(text) ? 'the address answers with an HTML page, not the API: check FREELLMAPI_BASE_URL (is the /v1 path included? does the host require a login, or is it asleep/offline?)'
    : res.status === 401 || res.status === 403 ? 'the key was refused'
    : res.ok ? 'HTTP 200 but the model returned no text' : `HTTP ${res.status}`;
  if (!ok) throw new Error(JSON.stringify({ host, path, status: res.status, contentType: type.slice(0, 40), snippet: scrub(text), hint }));
  return { host, path, status: res.status, reply: scrub(content) };
}

async function searchTier(name, mod, envPrefix) {
  const { collectKeys } = require('./adapters/envKeys');
  const keys = collectKeys(envPrefix).length;
  if (!keys) return { ok: false, configured: 0, error: 'no key set' };
  const r = await timed(async () => ({ results: (await mod.searchWeb('palm oil price', {})).length }));
  return { ...r, configured: keys, keyStatus: mod.getKeyStatus ? mod.getKeyStatus() : undefined };
}

async function runDiagnostics() {
  const out = { checkedAt: new Date().toISOString(), region: process.env.VERCEL_REGION || null, env: [] };
  for (const [name, required] of EXPECTED_ENV) {
    let present;
    if (name.startsWith('FREELLMAPI key')) present = Boolean(process.env.FREELLMAPI_API_KEY || process.env.FreeLLMAPIKEY);
    else if (name.startsWith('search key')) present = ['BRAVE_SEARCH_API_KEY', 'TAVILY_API_KEY', 'FIRECRAWL_API_KEY', 'SERPAPI_API_KEY'].some((p) => require('./adapters/envKeys').collectKeys(p).length);
    else present = Boolean(process.env[name]);
    out.env.push({ name, required, present });
  }
  out.database = await timed(async () => ({ items: Number((await pool.query('SELECT COUNT(*) AS n FROM items')).rows[0].n) }));
  out.freellmapi = await timed(checkFreeLLM);
  out.search = {
    brave: await searchTier('brave', require('./adapters/webSearch'), 'BRAVE_SEARCH_API_KEY'),
    tavily: await searchTier('tavily', require('./adapters/tavilySearch'), 'TAVILY_API_KEY'),
    firecrawl: await searchTier('firecrawl', require('./adapters/firecrawlSearch'), 'FIRECRAWL_API_KEY'),
    serpapi: await searchTier('serpapi', require('./adapters/serpApiSearch'), 'SERPAPI_API_KEY'),
  };
  out.rssEgress = await timed(async () => { const r = await fetch('https://www.fao.org/feeds/fao-newsroom-rss', { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ResearchArchivingBot/1.0)' }, signal: AbortSignal.timeout(15000) }); if (!r.ok) throw new Error(`HTTP ${r.status}`); return { status: r.status }; });
  out.guardedFetch = await timed(async () => { const r = await require('./safeUrl').safeFetch('https://www.fao.org/feeds/fao-newsroom-rss', { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ResearchArchivingBot/1.0)' }, signal: AbortSignal.timeout(15000) }); if (!r.ok) throw new Error(`HTTP ${r.status}`); return { status: r.status, note: 'SSRF-guarded fetch used by the collector' }; });
  out.pdfParser = await timed(async () => { require('pdf-parse'); return {}; });
  out.marketData = { enabled: Boolean(process.env.BARCHART_ONDEMAND_API_KEY) && process.env.BARCHART_DATA_DISPLAY_ENABLED === 'true' };
  return out;
}

module.exports = { runDiagnostics };
