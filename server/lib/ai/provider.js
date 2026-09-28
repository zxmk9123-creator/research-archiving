// Minimal LLM provider abstraction. No SDK dependency — uses the same global
// `fetch` already used by extractMetadata.js/collector.js. Provider and model
// are environment-configured; nothing is hardcoded, no API key is logged.

async function callAnthropic({ system, user }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not configured');
  const model = process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001';

  const res = await fetch('https://api.anthropic.com/v1/messages', {
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
    signal: AbortSignal.timeout(20000),
  });

  if (!res.ok) {
    // Log a short, sanitized diagnostic server-side only (truncated provider
    // error body — describes the request schema issue, not our content);
    // never include it in the thrown message that surfaces to the UI.
    const bodyText = await res.text().catch(() => '');
    console.error(`anthropic request failed: status ${res.status} body=${bodyText.slice(0, 300)}`);
    throw new Error(`AI provider request failed (${res.status})`);
  }

  const data = await res.json();
  const text = data && data.content && data.content[0] && data.content[0].text;
  if (!text) throw new Error('AI provider returned an empty response');
  return text;
}

async function callGeminiOnce(model, apiKey, system, user) {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts: [{ text: user }] }],
        generationConfig: { maxOutputTokens: 600 },
      }),
      signal: AbortSignal.timeout(20000),
    }
  );

  if (!res.ok) {
    const bodyText = await res.text().catch(() => '');
    console.error(`gemini request failed: status ${res.status} body=${bodyText.slice(0, 300)}`);
    const err = new Error(`AI provider request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }

  const data = await res.json();
  const text = data && data.candidates && data.candidates[0] && data.candidates[0].content
    && data.candidates[0].content.parts && data.candidates[0].content.parts[0]
    && data.candidates[0].content.parts[0].text;
  if (!text) throw new Error('AI provider returned an empty response');
  return text;
}

// 503 from Gemini means transient server-side overload ("try again later"),
// not a config problem — one short retry smooths that over without turning
// into the kind of aggressive auto-retry loop the product rules warn against.
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

// Dispatches on AI_PROVIDER so a different provider can be added later
// without touching aiDraft.js's orchestration logic.
async function callProvider(promptMessages) {
  const providerName = process.env.AI_PROVIDER || 'anthropic';
  if (providerName === 'anthropic') return callAnthropic(promptMessages);
  if (providerName === 'gemini') return callGemini(promptMessages);
  throw new Error(`Unsupported AI_PROVIDER: ${providerName}`);
}

module.exports = { callProvider, callAnthropic, callGemini };
