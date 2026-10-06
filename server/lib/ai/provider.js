// LLM provider abstraction. No SDK dependency — uses the same global
// `fetch` already used by extractMetadata.js/collector.js.
//
// Replaced the former multi-provider fallback chain (Groq/Gemini/NVIDIA/
// DeepSeek/OpenRouter) with a single call to a self-hosted FreeLLMAPI
// router (https://github.com/tashfeenahmed/freellmapi), which exposes an
// OpenAI-compatible /v1/chat/completions endpoint and handles provider
// fallback/rotation on its own side. One configured endpoint, one bearer
// token.

function markFallback(err, failureType) {
  err.transient = true; // kept for back-compat with existing call sites/tests
  err.failureType = failureType;
  return err;
}

function requireNonEmptyText(text, providerLabel) {
  if (text) return text;
  console.error(`${providerLabel} returned HTTP 200 with empty/null content`);
  throw markFallback(new Error('AI provider returned an empty response'), 'empty_response');
}

// Wraps a provider's fetch call and classifies the failure:
//   429            -> 'rate_limit'   (transient)
//   5xx            -> 'server_error' (transient)
//   401/403        -> 'auth'         (misconfigured, non-retryable)
//   other non-ok   -> unmarked (application/contract-ish)
//   network/DNS/refused connection, or our own AbortSignal timeout firing
//                  -> 'timeout' / 'network' (transient)
async function fetchProvider(providerLabel, url, init, timeoutMs = 20000) {
  let res;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    const failureType = err.name === 'TimeoutError' || err.name === 'AbortError' ? 'timeout' : 'network';
    console.error(`${providerLabel} request failed: ${failureType} (${err.message})`);
    throw markFallback(new Error(`AI provider unavailable (${failureType})`), failureType);
  }
  if (!res.ok) {
    const bodyText = await res.text().catch(() => '');
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
async function callFreeLLMAPI({ system, user }) {
  const apiKey = process.env.FREELLMAPI_API_KEY;
  if (!apiKey) throw new Error('FREELLMAPI_API_KEY is not configured');
  const baseUrl = process.env.FREELLMAPI_BASE_URL;
  if (!baseUrl) throw new Error('FREELLMAPI_BASE_URL is not configured');
  const model = process.env.FREELLMAPI_MODEL || 'auto';

  // FreeLLMAPI itself cascades through several free-tier upstream models on
  // failure (Groq -> OpenRouter -> Google -> ...) before answering, which
  // routinely takes longer than the 20s budget other single-hop providers
  // need — a 20s client-side abort was cutting FreeLLMAPI off mid-fallback
  // ("client disconnected mid-attempt" in its logs), not a hang on our end.
  const res = await fetchProvider('freellmapi', `${baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      max_tokens: 2000,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    }),
  }, 60000);

  const data = await res.json();
  const text = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  requireNonEmptyText(text, 'freellmapi');
  return text;
}

async function callProvider(promptMessages) {
  return callFreeLLMAPI(promptMessages);
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
function buildProviderChain(promptMessages) {
  const chain = [];
  if (process.env.FREELLMAPI_API_KEY) chain.push({ name: 'freellmapi', run: () => callFreeLLMAPI(promptMessages) });
  return chain;
}

// The entry point aiDraft.js uses in place of callProvider: same prompt
// shape in, same raw text contract out (plus which provider produced it).
async function callProviderWithFallback(promptMessages) {
  return runProviderChain(buildProviderChain(promptMessages));
}

module.exports = {
  callProvider,
  callProviderWithFallback,
  callFreeLLMAPI,
  runProviderChain,
  buildProviderChain,
  requireNonEmptyText,
};
