const { readResponseText } = require('../boundedResponse');

// LLM provider abstraction. No SDK dependency — uses the same global
// `fetch` already used by extractMetadata.js/collector.js.
//
// Replaced the former multi-provider fallback chain (Groq/Gemini/NVIDIA/
// DeepSeek/OpenRouter) with a single call to a self-hosted FreeLLMAPI
// router (https://github.com/tashfeenahmed/freellmapi), which exposes an
// OpenAI-compatible /v1/chat/completions endpoint and handles provider
// fallback/rotation on its own side. One configured endpoint, one bearer
// token.

// See callFreeLLMAPI() below for how this value is derived from
// FreeLLMAPI's own documented retry budget (FALLBACK_TIME_BUDGET_MS=45s
// default, widened up to 3x = 135s worst case) plus a 15s safety margin.
const FREELLMAPI_TIMEOUT_MS = 150000;

function markFallback(err, failureType) {
  err.transient = true; // kept for back-compat with existing call sites/tests
  err.failureType = failureType;
  return err;
}

// Production incident: an AI search answer about SAF feedstock constraints
// cut off mid-sentence ("...폐식용유는") with no error — the model simply
// hit max_tokens and the OpenAI-compatible response's finish_reason
// ('length' instead of 'stop') was never read anywhere in this file, so a
// token-budget truncation was indistinguishable from a clean completion:
// the truncated text got citation-verified, source-linked, and shown to
// the user as if it were the whole answer. Rather than silently serving a
// cut-off answer (or discarding it outright — a long, mostly-good answer
// is still useful), this appends a visible Korean notice so the truncation
// is never mistaken for a complete response.
function appendTruncationNoticeIfNeeded(text, finishReason) {
  if (finishReason !== 'length') return text;
  console.error('freellmapi response truncated by max_tokens (finish_reason=length)');
  return `${text}\n\n⚠ 답변이 길이 제한으로 인해 중간에 잘렸습니다. 더 좁은 질문으로 다시 물어보시면 전체 답변을 받을 수 있습니다.`;
}

function requireNonEmptyText(text, providerLabel) {
  if (text) return text;
  console.error(`${providerLabel} returned HTTP 200 with empty/null content`);
  throw markFallback(new Error('AI provider returned an empty response'), 'empty_response');
}

// Production incident: an AI search answer came back as the same ~40-char
// chunk ("Indices: palm oil, soybean oil, sunflower oil.") repeated
// hundreds of times until max_tokens cut it off — a known failure mode of
// the smaller/weaker free-tier models FreeLLMAPI's rotation can land on,
// with no repetition penalty configured on our side to guard against it.
// requireNonEmptyText doesn't catch this (the text is very much
// non-empty), so this scans for a long substring repeating immediately,
// several times in a row — something a well-formed answer never does —
// and treats it the same as any other provider failure rather than
// letting the garbage reach the user.
// The repeating unit's length isn't known in advance (it's whatever
// sentence/phrase the model got stuck on), so this tries a range of
// candidate unit lengths rather than assuming one fixed window — a fixed
// window only catches a repeat whose actual length happens to be a
// multiple of it. Scoped to the first part of the text (where a
// degenerating response starts going wrong) and to a bounded min/max unit
// length, to keep this cheap enough to run on every provider response.
const REPETITION_MIN_UNIT_CHARS = 15;
const REPETITION_MAX_UNIT_CHARS = 150;
const REPETITION_MIN_REPEATS = 3;
const REPETITION_SCAN_CHARS = 300;
function hasDegenerateRepetition(text) {
  const scanLimit = Math.min(REPETITION_SCAN_CHARS, text.length);
  for (let i = 0; i < scanLimit; i++) {
    for (let period = REPETITION_MIN_UNIT_CHARS; period <= REPETITION_MAX_UNIT_CHARS; period++) {
      if (i + period * REPETITION_MIN_REPEATS > text.length) break;
      const unit = text.slice(i, i + period);
      let matched = true;
      for (let r = 1; r < REPETITION_MIN_REPEATS; r++) {
        if (text.slice(i + period * r, i + period * (r + 1)) !== unit) { matched = false; break; }
      }
      if (matched) return true;
    }
  }
  return false;
}

function requireNonDegenerateText(text, providerLabel) {
  if (!hasDegenerateRepetition(text)) return text;
  console.error(`${providerLabel} returned degenerate repeated output (length=${text.length})`);
  throw markFallback(new Error('AI provider returned degenerate repeated output'), 'degenerate_output');
}

// Wraps a provider's fetch call and classifies the failure:
//   429            -> 'rate_limit'   (transient)
//   5xx            -> 'server_error' (transient)
//   401/403        -> 'auth'         (misconfigured, non-retryable)
//   other non-ok   -> unmarked (application/contract-ish)
//   network/DNS/refused connection, or our own AbortSignal timeout firing
//                  -> 'timeout' / 'network' (transient)
async function fetchProvider(providerLabel, url, init, timeoutMs = 20000, externalSignal) {
  let res;
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = externalSignal ? AbortSignal.any([timeoutSignal, externalSignal]) : timeoutSignal;
  try {
    res = await fetch(url, { ...init, signal });
  } catch (err) {
    const failureType = err.name === 'TimeoutError' || err.name === 'AbortError' ? 'timeout' : 'network';
    console.error(`${providerLabel} request failed: ${failureType} (${err.message})`);
    throw markFallback(new Error(`AI provider unavailable (${failureType})`), failureType);
  }
  if (!res.ok) {
    const bodyText = await readResponseText(res, 64 * 1024, 'AI provider error body').catch(() => '');
    console.error(`${providerLabel} request failed: status ${res.status} body=${bodyText.slice(0, 300)}`);
    const err = new Error(`AI provider request failed (${res.status})`);
    err.status = res.status;
    if (res.status === 429) markFallback(err, 'rate_limit');
    else if (res.status >= 500) markFallback(err, 'server_error');
    else if (res.status === 401 || res.status === 403) markFallback(err, 'auth');
    throw err;
  }
  return res;
}

// FreeLLMAPI: self-hosted OpenAI-compatible chat completions router.
// Client lanes: FreeLLMAPI client profiles decide WHICH models a key may route to. The
// interactive chatbot uses its own key (FREELLMAPI_CHAT_API_KEY -> a profile with only
// fast, reliable models); everything else — collection, drafts, headlines, scope
// analysis — keeps FREELLMAPI_API_KEY (the batch profile). With no chat key set, chat
// falls back to the shared key, i.e. the previous behaviour.
function apiKeyFor(lane) {
  return (lane === 'chat' && (process.env.FREELLMAPI_CHAT_API_KEY || '').trim()) || (process.env.FREELLMAPI_API_KEY || process.env.FreeLLMAPIKEY || "").trim();
}
function laneLabel(lane) {
  return lane === 'chat' && (process.env.FREELLMAPI_CHAT_API_KEY || '').trim() ? 'chat' : 'shared';
}

async function callFreeLLMAPI({ system, user }, { signal, lane } = {}) {
  const apiKey = apiKeyFor(lane);
  if (!apiKey) throw new Error('FREELLMAPI_API_KEY is not configured');
  const baseUrl = process.env.FREELLMAPI_BASE_URL;
  if (!baseUrl) throw new Error('FREELLMAPI_BASE_URL is not configured');
  const model = process.env.FREELLMAPI_MODEL || 'auto';

  // FreeLLMAPI itself cascades through several free-tier upstream models on
  // failure (Groq -> OpenRouter -> Google -> ...) before answering, which
  // routinely takes longer than the budget a single-hop provider needs. A
  // prior 20s client-side abort was already raised to 60s for exactly this
  // reason, but 60s still isn't enough: production logs (Daily Discovery,
  // 2026-10-07) showed FreeLLMAPI's own "client disconnected mid-attempt"
  // on cascades that were still healthy and progressing, plus several
  // successful completions that themselves took 40-52s — leaving almost no
  // margin inside a 60s cap.
  //
  // FREELLMAPI_TIMEOUT_MS is sized off FreeLLMAPI's own documented retry
  // budget, not a guess: FALLBACK_TIME_BUDGET_MS defaults to 45_000ms
  // (attempt 0 and the first failover hop are always allowed regardless of
  // budget; FreeLLMAPI's ttfb-budget.ts widens that per-endpoint for a
  // historically-slow-but-successful endpoint, capped at
  // MAX_BUDGET_MULTIPLIER = 3x). So FreeLLMAPI's own worst case before IT
  // gives up and returns a clean exhaustion response is
  // 45_000 * 3 = 135_000ms. This caller timeout must safely exceed that so
  // a healthy cascade is never killed out from under FreeLLMAPI — hence
  // 135_000 + a 15_000ms margin (DNS/TLS/queueing/response transmission
  // overhead on top of FreeLLMAPI's own internal budget) = 150_000ms.
  // If FreeLLMAPI's FALLBACK_TIME_BUDGET_MS is ever reconfigured away from
  // its 45s default, this value should be re-derived the same way
  // (new_budget * 3 + 15_000). See the module-level FREELLMAPI_TIMEOUT_MS
  // declaration above for the exported constant.
  const res = await fetchProvider('freellmapi', `${baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      // Production incident: a legitimately long, multi-section answer
      // (multiple candidates, each with its own paragraph/table) hit this
      // cap mid-sentence — see appendTruncationNoticeIfNeeded's own
      // comment for how that went undetected. Raised from 4000; still
      // bounded, not unlimited.
      max_tokens: 6000,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    }),
  }, FREELLMAPI_TIMEOUT_MS, signal);

  const data = JSON.parse(await readResponseText(res, 4 * 1024 * 1024, 'AI provider response'));
  const choice = data && data.choices && data.choices[0];
  const text = choice && choice.message && choice.message.content;
  requireNonEmptyText(text, 'freellmapi');
  requireNonDegenerateText(text, 'freellmapi');
  return appendTruncationNoticeIfNeeded(text, choice && choice.finish_reason);
}

async function callProvider(promptMessages, { signal } = {}) {
  return callFreeLLMAPI(promptMessages, signal ? { signal } : undefined);
}

// --- Streaming path (AI Research Search's perceived-latency fix) ---
//
// FreeLLMAPI's total latency varies wildly (confirmed in production:
// anywhere from a few seconds to 135s+ depending on which upstream its
// own cascade lands on) — not because our side calls different providers,
// but because that single router's internal fallback chain does. Waiting
// for the complete answer before showing anything means every request
// feels as slow as the worst case. Streaming the model's own token-by-
// token output (stream:true, same OpenAI-compatible wire format) lets the
// browser start rendering as soon as the FIRST chunk arrives — the total
// time to finish is unchanged, but the user sees progress immediately
// instead of a blank wait.
//
// Two-tier model attempt, both optional and off-by-default (unset env ->
// identical single-call behavior to today): if FREELLMAPI_FAST_MODEL is
// configured, it's tried first with a short first-token timeout
// (FREELLMAPI_FAST_MODEL_TIMEOUT_MS, default 8s) — a stall there aborts
// and falls through to the normal model with no first-token timeout of
// its own (that one must be allowed FreeLLMAPI's full cascade budget, or
// a legitimately-slow-but-correct answer would be killed early for
// nothing). The fast tier is deliberately bounded only by "did a token
// show up in time", never by total completion time — a fast model that
// starts responding but takes a while to finish is still a perceived-
// latency win and is never aborted mid-stream for being slow overall.
function buildStreamingAttempts() {
  const attempts = [];
  const fastModel = (process.env.FREELLMAPI_FAST_MODEL || '').trim();
  if (fastModel) {
    const firstTokenTimeoutMs = Number(process.env.FREELLMAPI_FAST_MODEL_TIMEOUT_MS) || 8000;
    attempts.push({ model: fastModel, firstTokenTimeoutMs });
  }
  const mainModel = process.env.FREELLMAPI_MODEL || 'auto';
  // Stall retry: the router's "auto" can land on an upstream that never produces a first
  // token (production logs: "empty completion" after 60-590 s). Instead of waiting out
  // the full 150 s cap on one such route, an attempt with no first token inside the
  // window is abandoned and "auto" is asked again (a different route is usually picked);
  // the last attempt keeps the full cascade budget. FREELLMAPI_STALL_RETRY=off disables.
  if ((process.env.FREELLMAPI_STALL_RETRY || '').toLowerCase() !== 'off') {
    attempts.push({ model: mainModel, firstTokenTimeoutMs: Number(process.env.FREELLMAPI_STALL_FIRST_MS) || 25000 });
    attempts.push({ model: mainModel, firstTokenTimeoutMs: Number(process.env.FREELLMAPI_STALL_SECOND_MS) || 35000 });
  }
  attempts.push({ model: mainModel, firstTokenTimeoutMs: null });
  return attempts;
}

// Parses one or more complete SSE "data: ..." lines out of a running text
// buffer (chunks from the network don't align with SSE event boundaries),
// returning the parsed delta content strings and whatever incomplete tail
// is left to prepend to the next chunk.
function extractSseDeltas(buffer) {
  const deltas = [];
  let done = false;
  // The chunk carrying finish_reason (e.g. 'length' when max_tokens cuts
  // the answer off, vs 'stop' on a clean finish) has no delta.content of
  // its own, so it's only ever visible here, never in streamFreeLLMAPIAttempt's
  // per-delta loop — surfaced separately rather than folded into `deltas`.
  let finishReason = null;
  const lines = buffer.split('\n');
  const remainder = lines.pop(); // last element may be an incomplete line
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) continue;
    const payload = trimmed.slice(5).trim();
    if (payload === '[DONE]') { done = true; continue; }
    try {
      const parsed = JSON.parse(payload);
      const choice = parsed && parsed.choices && parsed.choices[0];
      const delta = choice && choice.delta && choice.delta.content;
      if (delta) deltas.push(delta);
      if (choice && choice.finish_reason) finishReason = choice.finish_reason;
    } catch {
      // A line split exactly on a chunk boundary can be invalid JSON even
      // though it belongs to a complete SSE "line" — rare, and silently
      // dropping one delta is far better than aborting the whole stream.
    }
  }
  return { deltas, remainder, done, finishReason };
}

// Streams one model attempt. onToken(delta) fires for every chunk of
// text as it arrives; the call resolves with the full accumulated text
// and ttftMs (time from this function's own start to the first token),
// or rejects — classified with markFallback exactly like the
// non-streaming path — on a transport failure, a first-token stall past
// firstTokenTimeoutMs (failureType 'first_token_timeout', always
// transient so the caller's chain can move to its next attempt), or the
// same empty/degenerate-output checks requireNonEmptyText/
// requireNonDegenerateText already apply to a full response.
async function streamFreeLLMAPIAttempt({ system, user }, { model, firstTokenTimeoutMs }, onToken, { signal: externalSignal, lane } = {}) {
  const apiKey = apiKeyFor(lane);
  if (!apiKey) throw new Error('FREELLMAPI_API_KEY is not configured');
  const baseUrl = process.env.FREELLMAPI_BASE_URL;
  if (!baseUrl) throw new Error('FREELLMAPI_BASE_URL is not configured');

  const controller = new AbortController();
  if (externalSignal?.aborted) throw externalSignal.reason || Object.assign(new Error('request cancelled'), { name: 'AbortError' });
  const abortFromCaller = () => controller.abort(externalSignal.reason);
  externalSignal?.addEventListener('abort', abortFromCaller, { once: true });
  const overallTimeout = setTimeout(() => controller.abort(), FREELLMAPI_TIMEOUT_MS);
  let firstTokenTimer = null;
  if (firstTokenTimeoutMs) {
    firstTokenTimer = setTimeout(() => controller.abort(), firstTokenTimeoutMs);
  }

  const startedAt = Date.now();
  let res;
  try {
    res = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model, max_tokens: 6000, stream: true,
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      }),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(overallTimeout);
    if (firstTokenTimer) clearTimeout(firstTokenTimer);
    externalSignal?.removeEventListener('abort', abortFromCaller);
    if (externalSignal?.aborted) throw externalSignal.reason || Object.assign(new Error('request cancelled'), { name: 'AbortError' });
    // An abort before any byte of the response arrived is indistinguishable
    // from a first-token stall here (both fire controller.abort()) — both
    // are transient and both should let the caller try its next attempt,
    // so there's no need to tell them apart by which timer fired.
    const failureType = err.name === 'TimeoutError' || err.name === 'AbortError' ? 'first_token_timeout' : 'network';
    throw markFallback(new Error(`AI provider unavailable (${failureType})`), failureType);
  }
  if (!res.ok) {
    clearTimeout(overallTimeout);
    if (firstTokenTimer) clearTimeout(firstTokenTimer);
    externalSignal?.removeEventListener('abort', abortFromCaller);
    const bodyText = await readResponseText(res, 64 * 1024, 'AI provider error body').catch(() => '');
    console.error(`freellmapi stream request failed: status ${res.status} body=${bodyText.slice(0, 300)}`);
    const err = new Error(`AI provider request failed (${res.status})`);
    err.status = res.status;
    if (res.status === 429) markFallback(err, 'rate_limit');
    else if (res.status >= 500) markFallback(err, 'server_error');
    else if (res.status === 401 || res.status === 403) markFallback(err, 'auth');
    throw err;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let fullText = '';
  let ttftMs = null;
  let finishReason = null;
  try {
    while (true) {
      const { value, done: streamDone } = await reader.read();
      if (streamDone) break;
      buffer += decoder.decode(value, { stream: true });
      const { deltas, remainder, done, finishReason: chunkFinishReason } = extractSseDeltas(buffer);
      buffer = remainder;
      if (chunkFinishReason) finishReason = chunkFinishReason;
      for (const delta of deltas) {
        if (ttftMs === null) {
          ttftMs = Date.now() - startedAt;
          if (firstTokenTimer) { clearTimeout(firstTokenTimer); firstTokenTimer = null; }
        }
        fullText += delta;
        onToken(delta);
      }
      if (done) break;
    }
  } catch (err) {
    const failureType = err.name === 'TimeoutError' || err.name === 'AbortError'
      ? (ttftMs === null ? 'first_token_timeout' : 'timeout')
      : 'network';
    throw markFallback(new Error(`AI provider unavailable (${failureType})`), failureType);
  } finally {
    clearTimeout(overallTimeout);
    if (firstTokenTimer) clearTimeout(firstTokenTimer);
    externalSignal?.removeEventListener('abort', abortFromCaller);
  }

  requireNonEmptyText(fullText, 'freellmapi');
  requireNonDegenerateText(fullText, 'freellmapi');
  return { text: appendTruncationNoticeIfNeeded(fullText, finishReason), ttftMs };
}

// Orchestrates buildStreamingAttempts() the same way runProviderChain()
// orchestrates the non-streaming provider list: try each in order, move
// to the next only on a transient failure (markFallback'd err.transient),
// otherwise throw immediately. onToken is only ever wired up to the
// attempt that's actually running — a fast-model stream that gets
// aborted mid-token never leaks partial text into the caller, since
// onToken simply stops being called once that attempt's promise rejects.
async function callProviderWithFallbackStreaming({ system, user }, onToken, { signal, lane } = {}) {
  const attempts = buildStreamingAttempts();
  let lastErr;
  for (let i = 0; i < attempts.length; i++) {
    const attempt = attempts[i];
    console.log(`ai_provider stream_request_started model=${attempt.model} lane=${laneLabel(lane)}`);
    try {
      const { text, ttftMs } = await streamFreeLLMAPIAttempt({ system, user }, attempt, onToken, { signal, lane });
      console.log(`ai_provider stream_request_succeeded model=${attempt.model} lane=${laneLabel(lane)} ttft_ms=${ttftMs}`);
      return { text, ttftMs, model: attempt.model };
    } catch (err) {
      lastErr = err;
      const failureType = err.failureType || 'application_error';
      console.error(`ai_provider stream_request_failed model=${attempt.model} lane=${laneLabel(lane)} failure_type=${failureType} reason=${err.message}`);
      if (!err.transient) throw err;
      const next = attempts[i + 1];
      if (next) console.log(`ai_provider stream_fallback from=${attempt.model} to=${next.model}`);
    }
  }
  throw lastErr;
}

// Pure orchestration, no network calls of its own — testable in isolation
// with fake providers.
async function runProviderChain(providers) {
  if (!providers.length) throw new Error('No AI provider configured');
  let lastErr;
  for (let i = 0; i < providers.length; i++) {
    const p = providers[i];
    console.log(`ai_provider request_started provider=${p.name}`);
    try {
      const text = await p.run();
      console.log(`ai_provider request_succeeded provider=${p.name}`);
      return { text, provider: p.name };
    } catch (err) {
      lastErr = err;
      const status = err.status ? ` status=${err.status}` : '';
      const failureType = err.failureType || 'application_error';
      console.error(`ai_provider provider_failed provider=${p.name}${status} failure_type=${failureType} reason=${err.message}`);
      if (!err.transient) throw err;
      const next = providers[i + 1];
      if (next) console.log(`ai_provider fallback from=${p.name} to=${next.name}`);
    }
  }
  throw lastErr;
}

// Single-entry chain: just FreeLLMAPI, when configured.
function buildProviderChain(promptMessages, { signal, lane } = {}) {
  const chain = [];
  if (apiKeyFor(lane)) chain.push({ name: 'freellmapi', run: () => callFreeLLMAPI(promptMessages, { signal, lane }) });
  return chain;
}

// The entry point aiDraft.js uses in place of callProvider: same prompt
// shape in, same raw text contract out (plus which provider produced it).
async function callProviderWithFallback(promptMessages, options = {}) {
  return runProviderChain(buildProviderChain(promptMessages, options));
}

module.exports = {
  apiKeyFor,
  callProvider,
  callProviderWithFallback,
  callFreeLLMAPI,
  runProviderChain,
  buildProviderChain,
  requireNonEmptyText,
  hasDegenerateRepetition,
  requireNonDegenerateText,
  FREELLMAPI_TIMEOUT_MS,
  callProviderWithFallbackStreaming,
  buildStreamingAttempts,
  extractSseDeltas,
  streamFreeLLMAPIAttempt,
};
