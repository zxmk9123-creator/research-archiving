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
    // Log a short, sanitized diagnostic server-side only; never include
    // provider response bodies (could echo request content) in the thrown
    // message that eventually surfaces to the UI.
    console.error(`anthropic request failed: status ${res.status}`);
    throw new Error(`AI provider request failed (${res.status})`);
  }

  const data = await res.json();
  const text = data && data.content && data.content[0] && data.content[0].text;
  if (!text) throw new Error('AI provider returned an empty response');
  return text;
}

// Dispatches on AI_PROVIDER so a different provider can be added later
// without touching aiDraft.js's orchestration logic.
async function callProvider(promptMessages) {
  const providerName = process.env.AI_PROVIDER || 'anthropic';
  if (providerName === 'anthropic') return callAnthropic(promptMessages);
  throw new Error(`Unsupported AI_PROVIDER: ${providerName}`);
}

module.exports = { callProvider, callAnthropic };
