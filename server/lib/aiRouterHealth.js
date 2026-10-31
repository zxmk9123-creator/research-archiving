// AI router early warning. The AI features (headline, AI search, chat) all depend on the FreeLLMAPI router and the free-tier models behind it,
// which fail in slow, silent ways: a model is retired (HTTP 410), a free quota runs out (402/429), or one provider hangs until the retry budget
// is spent and the answer comes back as a 502. This reads two things the user would otherwise discover by hitting the error:
//   1. what real searches did in the last 24 h (ai_search_logs, already recorded: outcome, latency, time-to-first-token, failure type), and
//   2. a tiny live probe (one 8-token completion), so a quiet night is not mistaken for a healthy router.
// aiRouterCheck() is pure; collectAiRouterInput() is the only part that touches the database / the network and it never writes.
const WINDOW_HOURS = 24;
const MIN_SAMPLE = 5;               // below this many answered searches a rate means nothing
const ERROR_RATE_WARN = 0.2;
const ERROR_RATE_FAIL = 0.5;
const SLOW_P95_MS = 60000;          // the whole answer
const SLOW_TTFT_MS = 20000;         // time to the first visible token
const STALE_SUCCESS_MS = 6 * 3600000;
const PROBE_TIMEOUT_MS = 30000;

const check = (id, status, detail) => ({ id, status, detail });
const sec = (n) => `${Math.round(n / 100) / 10}s`;
const pct = (n) => `${Math.round(n * 100)}%`;

// Pure. input = { searches: {...}|null, probe: {...}|null|undefined } (undefined = not collected -> no row at all).
function aiRouterCheck(input, now = Date.now()) {
  if (!input || input === undefined || input.searches === undefined) return [];
  const s = input.searches;
  const probe = input.probe;
  if (s === null && !probe) return [check('ai_router', 'unknown', 'AI router telemetry could not be read (ai_search_logs) and no probe was made')];

  const success = s ? Number(s.success) || 0 : 0;
  const errors = s ? Number(s.providerError) || 0 : 0;
  const answered = success + errors;
  const errorRate = answered ? errors / answered : 0;
  const lastSuccessAge = s && s.lastSuccessAt ? now - new Date(s.lastSuccessAt).getTime() : null;
  const probeFailed = Boolean(probe) && probe.ok === false;
  const types = s && s.failureTypes ? Object.entries(s.failureTypes).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, n]) => `${k}×${n}`).join(', ') : '';

  const facts = [];
  if (answered) facts.push(`${success}/${answered} searches answered in ${WINDOW_HOURS} h (${pct(1 - errorRate)})`);
  else facts.push(`no AI searches in ${WINDOW_HOURS} h`);
  if (s && Number.isFinite(s.p95Ms) && success) facts.push(`median ${sec(s.p50Ms)}, p95 ${sec(s.p95Ms)}`);
  if (s && Number.isFinite(s.ttftP50Ms)) facts.push(`first token median ${sec(s.ttftP50Ms)}`);
  if (types) facts.push(`failures: ${types}`);
  if (probe) facts.push(probe.ok ? `probe ok ${sec(probe.ms)}` : `probe FAILED (${probe.error || `HTTP ${probe.status}`}${probe.hint ? `; ${probe.hint}` : ''})`);
  const detail = facts.join('; ');

  // FAIL: users are being failed right now (most searches fail), or the live probe fails and nothing has worked for hours
  if (answered >= MIN_SAMPLE && errorRate >= ERROR_RATE_FAIL) return [check('ai_router', 'fail', `most AI answers are failing: ${detail}`)];
  if (probeFailed && answered >= 1 && (lastSuccessAge === null || lastSuccessAge > STALE_SUCCESS_MS)) return [check('ai_router', 'fail', `the router does not answer and no search succeeded recently: ${detail}`)];
  // WARN: degrading but still serving, or a single failed probe (could be a cold start / one slow hop)
  if (probeFailed) return [check('ai_router', 'warn', `live probe failed: ${detail}`)];
  if (answered >= MIN_SAMPLE && errorRate >= ERROR_RATE_WARN) return [check('ai_router', 'warn', `AI answers are failing more than usual: ${detail}`)];
  if (answered >= MIN_SAMPLE && s.p95Ms > SLOW_P95_MS) return [check('ai_router', 'warn', `AI answers are slow: ${detail}`)];
  if (s && Number.isFinite(s.ttftP50Ms) && success >= MIN_SAMPLE && s.ttftP50Ms > SLOW_TTFT_MS) return [check('ai_router', 'warn', `first token is slow: ${detail}`)];
  if (!answered && !probe) return [check('ai_router', 'unknown', `${detail}; no probe, so nothing shows the router works`)];
  return [check('ai_router', 'pass', detail)];
}

const scrub = (text) => String(text || '').replace(/\s+/g, ' ').replace(/(sk|tvly|fc|gsk|key)[-_A-Za-z0-9]{12,}/gi, '[redacted]').slice(0, 160);

// One tiny completion through the same endpoint the app uses. Never throws; the result says what happened.
async function probeRouter({ fetchImpl = fetch, env = process.env, timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  const base = env.FREELLMAPI_BASE_URL;
  const key = (env.FREELLMAPI_API_KEY || env.FreeLLMAPIKEY || '').trim();
  if (!base || !key) return { ok: false, status: 0, ms: 0, error: !base ? 'FREELLMAPI_BASE_URL is not set' : 'no router key is set' };
  const started = Date.now();
  try {
    const res = await fetchImpl(`${base.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: env.FREELLMAPI_MODEL || 'auto', max_tokens: 8, messages: [{ role: 'user', content: 'Reply with the single word: ok' }] }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    let content = null;
    try { const j = JSON.parse(text); content = j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content; } catch (_) { /* not JSON */ }
    const ms = Date.now() - started;
    if (res.ok && content) return { ok: true, status: res.status, ms };
    return { ok: false, status: res.status, ms, error: res.ok ? 'HTTP 200 but no text came back' : scrub(text), hint: res.status === 401 || res.status === 403 ? 'the router refused the key' : undefined };
  } catch (err) {
    return { ok: false, status: 0, ms: Date.now() - started, error: err && err.name === 'TimeoutError' ? `no answer within ${Math.round(timeoutMs / 1000)}s` : scrub(err && err.message) };
  }
}

async function readSearchStats(pool) {
  const w = `created_at > now() - interval '${WINDOW_HOURS} hours'`;
  const { rows } = await pool.query(
    `SELECT count(*) FILTER (WHERE outcome = 'success')::int AS success,
            count(*) FILTER (WHERE outcome = 'provider_error')::int AS provider_error,
            count(*) FILTER (WHERE outcome = 'insufficient_evidence')::int AS insufficient,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY latency_ms) FILTER (WHERE outcome = 'success') AS p50_ms,
            percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms) FILTER (WHERE outcome = 'success') AS p95_ms,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY ttft_ms) FILTER (WHERE outcome = 'success' AND ttft_ms IS NOT NULL) AS ttft_p50_ms,
            max(created_at) FILTER (WHERE outcome = 'success') AS last_success_at,
            max(created_at) FILTER (WHERE outcome = 'provider_error') AS last_error_at
       FROM ai_search_logs WHERE ${w}`);
  const types = await pool.query(`SELECT coalesce(failure_type, 'unknown') AS t, count(*)::int AS n FROM ai_search_logs WHERE outcome = 'provider_error' AND ${w} GROUP BY 1 ORDER BY 2 DESC LIMIT 5`);
  const r = rows[0] || {};
  const num = (v) => (v == null ? null : Number(v));
  return {
    success: r.success || 0, providerError: r.provider_error || 0, insufficient: r.insufficient || 0,
    p50Ms: num(r.p50_ms), p95Ms: num(r.p95_ms), ttftP50Ms: num(r.ttft_p50_ms), lastSuccessAt: r.last_success_at || null, lastErrorAt: r.last_error_at || null,
    failureTypes: Object.fromEntries(types.rows.map((x) => [x.t, x.n])),
  };
}

// withProbe=false for the full pipeline health (which must stay cheap and deterministic); the dedicated early-warning endpoint probes.
async function collectAiRouterInput({ withProbe = false, pool = require('../db/pool'), probe = probeRouter } = {}) {
  let searches = null;
  try { searches = await readSearchStats(pool); } catch (err) { console.error('ai router health read failed:', err.message); }
  const input = { searches };
  if (withProbe) input.probe = await probe();
  return input;
}

async function runAiRouterCheck({ now = Date.now(), ...opts } = {}) {
  const input = await collectAiRouterInput({ withProbe: true, ...opts });
  const [c] = aiRouterCheck(input, now);
  return { status: c.status, check: c, checkedAt: new Date(now).toISOString() };
}

module.exports = { aiRouterCheck, collectAiRouterInput, probeRouter, runAiRouterCheck, MIN_SAMPLE };
