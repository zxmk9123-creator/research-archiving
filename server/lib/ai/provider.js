// Minimal LLM provider abstraction. No SDK dependency — uses the same global
// `fetch` already used by extractMetadata.js/collector.js. Provider and model
// are environment-configured; nothing is hardcoded, no API key is logged.

// Marks an error as "transient" — the kind of failure (rate limit, server
// overload, timeout, network unavailable) that justifies trying the next
// provider in the fallback chain. Anything NOT marked transient (bad
// request, auth failure, empty/invalid response) is an application-level
// problem the next provider can't fix either, so it propagates immediately
// instead of triggering a pointless rotation through the rest of the chain.
function markTransient(err) {
  err.transient = true;
  return err;
}

// Wraps a provider's fetch call: HTTP 429/5xx become transient errors,
// other non-ok statuses (400/401/403/404 — bad request, bad key, wrong
// model id) stay non-transient, and a network-level failure (DNS, refused
// connection, or our own AbortSignal timeout firing) is transient too,
// since "provider unavailable" is explicitly in scope for fallback.
async function fetchProvider(providerLabel, url, init) {
  let res;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(20000) });
  } catch (err) {
    const reason = err.name === 'TimeoutError' || err.name === 'AbortError' ? 'timeout' : 'network error';
    console.error(`${providerLabel} request failed: ${reason} (${err.message})`);
    throw markTransient(new Error(`AI provider unavailable (${reason})`));
  }
  if (!res.ok) {
    const bodyText = await res.text().catch(() => '');
    console.error(`${providerLabel} request failed: status ${res.status} body=${bodyText.slice(0, 300)}`);
    const err = new Error(`AI provider request failed (${res.status})`);
    err.status = res.status;
    if (res.status === 429 || res.status >= 500) markTransient(err);
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
  if (!text) throw new Error('AI provider returned an empty response');
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
  if (!text) throw new Error('AI provider returned an empty response');
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
  if (!text) throw new Error('AI provider returned an empty response');
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
  if (!text) throw new Error('AI provider returned an empty response');
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
  if (!text) throw new Error('AI provider returned an empty response');
  return text;
}

// NVIDIA's hosted NIM endpoint (build.nvidia.com), also OpenAI-compatible.
async function callNvidia({ system, user }) {
  const apiKey = process.env.NVIDIA_API_KEY;
  if (!apiKey) throw new Error('NVIDIA_API_KEY is not configured');
  const model = process.env.NVIDIA_MODEL || 'meta/llama-3.1-70b-instruct';

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
  if (!text) throw new Error('AI provider returned an empty response');
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
  for (const p of providers) {
    try {
      const text = await p.run();
      return { text, provider: p.name };
    } catch (err) {
      lastErr = err;
      if (!err.transient) throw err;
      console.error(`AI provider ${p.name} failed transiently, trying next provider: ${err.message}`);
    }
  }
  throw lastErr;
}

// Builds the real fallback chain: Groq -> Gemini -> OpenRouter free model,
// skipping any provider whose API key isn't configured (so an unconfigured
// provider is simply absent from the chain, not a failure to work around).
function buildProviderChain(promptMessages) {
  const chain = [];
  if (process.env.GROQ_API_KEY) chain.push({ name: 'groq', run: () => callGroq(promptMessages) });
  if (process.env.GEMINI_API_KEY) chain.push({ name: 'gemini', run: () => callGemini(promptMessages) });
  if (process.env.OPENROUTER_API_KEY) chain.push({ name: 'openrouter', run: () => callOpenRouter(promptMessages) });
  if (process.env.LLAMA_API_KEY) chain.push({ name: 'llama', run: () => callLlama(promptMessages) });
  if (process.env.NVIDIA_API_KEY) chain.push({ name: 'nvidia', run: () => callNvidia(promptMessages) });
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
  runProviderChain,
  buildProviderChain,
};
