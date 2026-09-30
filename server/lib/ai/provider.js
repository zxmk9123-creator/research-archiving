// Minimal LLM provider abstraction. No SDK dependency — uses the same global
// `fetch` already used by extractMetadata.js/collector.js. Provider and model
// are environment-configured; nothing is hardcoded, no API key is logged.

// Marks an error with a failureType so the router (runProviderChain) knows
// to advance to the next provider and can log *why*. Two distinct
// fallback-worthy categories, both non-terminal for the chain:
//   - transient (429/5xx/timeout/network): the provider is temporarily
//     unavailable/overloaded — the same provider might work again later.
//   - auth (401/403/missing or invalid credential): THIS provider is
//     misconfigured and will never succeed on its own, but that says
//     nothing about the other configured providers, so it must not take
//     the whole chain down with it — skip straight to the next one
//     (never retry the same provider).
// Anything left unmarked (400/404/other non-ok status, or an error thrown
// by our own prompt construction/JSON parsing/Zod validation/DB code) is
// an application/contract problem no other provider can fix either, so it
// propagates immediately and stops the chain, preserving the existing
// ai_status=failed behavior.
function markFallback(err, failureType) {
  err.transient = true; // kept for back-compat with existing call sites/tests
  err.failureType = failureType;
  return err;
}

// ROOT CAUSE (fixed here): every provider function threw a plain
// `new Error('AI provider returned an empty response')` with no
// `.transient` flag when the provider returned HTTP 200 with empty/null
// content. runProviderChain only advances to the next provider on
// err.transient === true, so an empty-content response was silently
// treated as a non-transient "application" failure and stopped the whole
// chain right there — this is why fallback appeared to "stop at Groq"
// even though 429/5xx/timeout fallback worked fine. An empty response
// from the provider is unambiguously a provider-side failure (the model
// didn't answer), not anything our prompt/parsing did, so it must be
// transient. This single helper is now used by every provider instead of
// each one throwing its own untagged error.
function requireNonEmptyText(text, providerLabel) {
  if (text) return text;
  console.error(`${providerLabel} returned HTTP 200 with empty/null content`);
  throw markFallback(new Error('AI provider returned an empty response'), 'empty_response');
}

// Wraps a provider's fetch call and classifies the failure:
//   429            -> 'rate_limit'   (transient)
//   5xx            -> 'server_error' (transient)
//   401/403        -> 'auth'         (this provider misconfigured, skip it)
//   other non-ok   -> unmarked (application/contract-ish — e.g. 400 bad
//                     request, 404 unknown model id — stops the chain)
//   network/DNS/refused connection, or our own AbortSignal timeout firing
//                  -> 'timeout' / 'network' (transient)
async function fetchProvider(providerLabel, url, init) {
  let res;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(20000) });
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

async function callAnthropic({ system, user }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not configured');
  const model = process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001';

  const res = await fetchProvider('anthropic', 'https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: 600,
      system,
      messages: [{ role: 'user', content: user }],
    }),
  });

  const data = await res.json();
  const text = data && data.content && data.content[0] && data.content[0].text;
  // Empty-response is an application/content-quality issue, not provider
  // capacity — deliberately NOT marked transient (see runProviderChain).
  requireNonEmptyText(text, 'anthropic');
  return text;
}

async function callGeminiOnce(model, apiKey, system, user) {
  const res = await fetchProvider(
    'gemini',
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts: [{ text: user }] }],
        generationConfig: { maxOutputTokens: 600 },
      }),
    }
  );

  const data = await res.json();
  const text = data && data.candidates && data.candidates[0] && data.candidates[0].content
    && data.candidates[0].content.parts && data.candidates[0].content.parts[0]
    && data.candidates[0].content.parts[0].text;
  requireNonEmptyText(text, 'gemini');
  return text;
}

// 503 from Gemini means transient server-side overload ("try again later"),
// not a config problem — one short retry smooths that over without turning
// into the kind of aggressive auto-retry loop the product rules warn
// against. If that retry also fails, the error (already marked transient
// by fetchProvider for 429/5xx) propagates to the fallback chain as usual.
async function callGemini({ system, user }) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY is not configured');
  const model = process.env.GEMINI_MODEL || 'gemini-3.8-flash';

  try {
    return await callGeminiOnce(model, apiKey, system, user);
  } catch (err) {
    if (err.status !== 503) throw err;
    await new Promise((resolve) => setTimeout(resolve, 1500));
    return callGeminiOnce(model, apiKey, system, user);
  }
}

// Groq: OpenAI-compatible chat completions API.
async function callGroq({ system, user }) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error('GROQ_API_KEY is not configured');
  const model = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';

  const res = await fetchProvider('groq', 'https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      // Some Groq models (e.g. openai/gpt-oss-20b) are reasoning models that
      // spend part of the token budget on internal reasoning before writing
      // the final answer. The JSON contract grew (eligibility + 5W1H facts +
      // summary), and 600 was getting fully consumed by reasoning, leaving
      // an empty final message. Raised well above the expanded response's
      // actual size to leave headroom for reasoning overhead.
      max_tokens: 2000,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    }),
  }).catch(async (err) => {
    // One-off diagnostic on 404 only: list this account's actual available
    // model ids so a stale/renamed default can be corrected without
    // guessing. Never changes transient/non-transient classification.
    if (err.status === 404) {
      try {
        const modelsRes = await fetch('https://api.groq.com/openai/v1/models', {
          headers: { authorization: `Bearer ${apiKey}` },
        });
        const modelsData = await modelsRes.json();
        const ids = (modelsData.data || []).map((m) => m.id).join(', ');
        console.error(`groq available models: ${ids}`);
      } catch (listErr) {
        console.error(`groq model list lookup failed: ${listErr.message}`);
      }
    }
    throw err;
  });

  const data = await res.json();
  const text = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  requireNonEmptyText(text, 'groq');
  return text;
}

// OpenRouter: OpenAI-compatible chat completions API, used with a free-tier
// model as the last fallback so RSS AI processing has a third independent
// quota to fall through to. Model id is env-configured like the others —
// OPENROUTER_MODEL defaults to a commonly available free model, but the
// account owner should confirm the exact free model id still active on
// OpenRouter, since free-tier model availability changes over time.
async function callOpenRouter({ system, user }) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error('OPENROUTER_API_KEY is not configured');
  const model = process.env.OPENROUTER_MODEL || 'meta-llama/llama-3.1-8b-instruct:free';

  const res = await fetchProvider('openrouter', 'https://openrouter.ai/api/v1/chat/completions', {
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
  });

  const data = await res.json();
  const text = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  requireNonEmptyText(text, 'openrouter');
  return text;
}

// DeepSeek: OpenAI-compatible chat completions API.
async function callDeepSeek({ system, user }) {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) throw new Error('DEEPSEEK_API_KEY is not configured');
  const model = process.env.DEEPSEEK_MODEL || 'deepseek-flash';

  const res = await fetchProvider('deepseek', 'https://api.deepseek.com/chat/completions', {
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
  });

  const data = await res.json();
  const text = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  requireNonEmptyText(text, 'deepseek');
  return text;
}

// Meta's Llama API (OpenAI-compatible chat completions).
async function callLlama({ system, user }) {
  const apiKey = process.env.LLAMA_API_KEY;
  if (!apiKey) throw new Error('LLAMA_API_KEY is not configured');
  const model = process.env.LLAMA_MODEL || 'Llama-3.3-70B-Instruct';

  const res = await fetchProvider('llama', 'https://api.llama.com/v1/chat/completions', {
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
  });

  const data = await res.json();
  const text = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  requireNonEmptyText(text, 'llama');
  return text;
}

// NVIDIA's hosted NIM endpoint (build.nvidia.com), also OpenAI-compatible.
// meta/llama-3.3-70b-instruct's hosted route on this endpoint was retired
// 2026-08-26 (returns HTTP 410 in production despite still appearing on
// NVIDIA's static catalog pages); nvidia/nemotron-3-super-120b-a12b is
// confirmed currently served on this same integrate.api.nvidia.com/v1
// endpoint via its own docs.api.nvidia.com reference and NGC listing.
async function callNvidia({ system, user }) {
  const apiKey = process.env.NVIDIA_API_KEY;
  if (!apiKey) throw new Error('NVIDIA_API_KEY is not configured');
  const model = process.env.NVIDIA_MODEL || 'nvidia/nemotron-3-super-120b-a12b';

  const res = await fetchProvider('nvidia', 'https://integrate.api.nvidia.com/v1/chat/completions', {
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
  });

  const data = await res.json();
  const text = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  requireNonEmptyText(text, 'nvidia');
  return text;
}

// Dispatches on AI_PROVIDER to call exactly one named provider — kept as-is
// for explicit single-provider use (e.g. tests, or forcing one provider).
async function callProvider(promptMessages) {
  const providerName = process.env.AI_PROVIDER || 'anthropic';
  if (providerName === 'anthropic') return callAnthropic(promptMessages);
  if (providerName === 'gemini') return callGemini(promptMessages);
  if (providerName === 'groq') return callGroq(promptMessages);
  if (providerName === 'openrouter') return callOpenRouter(promptMessages);
  if (providerName === 'llama') return callLlama(promptMessages);
  if (providerName === 'nvidia') return callNvidia(promptMessages);
  if (providerName === 'deepseek') return callDeepSeek(promptMessages);
  throw new Error(`Unsupported AI_PROVIDER: ${providerName}`);
}

// Pure orchestration, no network calls of its own — testable in isolation
// with fake providers. Tries each provider in order; only advances to the
// next on a transient failure (err.transient === true). A non-transient
// failure (invalid prompt/contract/application error, bad auth, empty
// response) is rethrown immediately without trying further providers, so
// those are never misclassified as "provider capacity" issues.
async function runProviderChain(providers) {
  if (!providers.length) throw new Error('No AI provider configured');
  let lastErr;
  for (let i = 0; i < providers.length; i++) {
    const p = providers[i];
    // Structured, greppable log lines (provider name/status only — never
    // API keys or prompt/response content) to verify failover behavior
    // directly from production logs.
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

// Builds the real fallback chain: Groq -> Gemini -> NVIDIA -> DeepSeek ->
// OpenRouter free model, skipping any provider whose API key isn't
// configured (so an unconfigured provider is simply absent from the
// chain, not a failure to work around).
function buildProviderChain(promptMessages) {
  const chain = [];
  if (process.env.GROQ_API_KEY) chain.push({ name: 'groq', run: () => callGroq(promptMessages) });
  if (process.env.GEMINI_API_KEY) chain.push({ name: 'gemini', run: () => callGemini(promptMessages) });
  if (process.env.NVIDIA_API_KEY) chain.push({ name: 'nvidia', run: () => callNvidia(promptMessages) });
  if (process.env.DEEPSEEK_API_KEY) chain.push({ name: 'deepseek', run: () => callDeepSeek(promptMessages) });
  if (process.env.OPENROUTER_API_KEY) chain.push({ name: 'openrouter', run: () => callOpenRouter(promptMessages) });
  return chain;
}

// The entry point aiDraft.js uses in place of callProvider: same prompt
// shape in, same raw text contract out (plus which provider produced it,
// for operational visibility), with automatic fallback through the chain
// above on transient failures only.
async function callProviderWithFallback(promptMessages) {
  return runProviderChain(buildProviderChain(promptMessages));
}

module.exports = {
  callProvider,
  callProviderWithFallback,
  callAnthropic,
  callGemini,
  callGroq,
  callOpenRouter,
  callLlama,
  callNvidia,
  callDeepSeek,
  runProviderChain,
  buildProviderChain,
  requireNonEmptyText,
};
