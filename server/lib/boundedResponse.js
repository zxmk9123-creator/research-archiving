// Read an upstream response incrementally and stop before buffering an
// unexpectedly large body. Content-Length is only an early hint; the streamed
// byte count is authoritative because servers may omit or misreport it.
async function readResponseBuffer(response, maxBytes, label = 'upstream response') {
  const declaredLength = Number(response.headers && response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    await response.body?.cancel?.().catch(() => {});
    throw new Error(`${label} exceeds ${maxBytes} byte limit`);
  }

  if (!response.body || typeof response.body.getReader !== 'function') {
    // Real fetch() Responses always expose arrayBuffer(); this falls back
    // to text()/json() only for duck-typed mocks (test doubles) that don't
    // bother implementing it.
    let buffer;
    if (typeof response.arrayBuffer === 'function') {
      buffer = Buffer.from(await response.arrayBuffer());
    } else if (typeof response.json === 'function') {
      // Mocks in this codebase that stub both json() and text() use json()
      // for the real payload and text() as an unused error-body placeholder
      // (e.g. `text: async () => ''`) — json() must win when both exist.
      buffer = Buffer.from(JSON.stringify(await response.json()), 'utf8');
    } else if (typeof response.text === 'function') {
      buffer = Buffer.from(await response.text(), 'utf8');
    } else {
      throw new Error(`${label}: response exposes no arrayBuffer/text/json method`);
    }
    if (buffer.length > maxBytes) throw new Error(`${label} exceeds ${maxBytes} byte limit`);
    return buffer;
  }

  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new Error(`${label} exceeds ${maxBytes} byte limit`);
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock?.();
  }
  return Buffer.concat(chunks, total);
}

async function readResponseText(response, maxBytes, label) {
  return (await readResponseBuffer(response, maxBytes, label)).toString('utf8');
}

// First maxBytes of a body, without failing when the page is larger: for HTML only the head / first paragraphs matter, so a huge page
// is read up to the cap and the rest is dropped instead of the whole article being rejected.
async function readResponsePrefixText(response, maxBytes) {
  if (!response.body || typeof response.body.getReader !== 'function') {
    return (await readResponseBuffer(response, Number.MAX_SAFE_INTEGER, 'prefix')).subarray(0, maxBytes).toString('utf8');
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (total < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(Buffer.from(value));
      total += value.byteLength;
    }
    if (total >= maxBytes) await reader.cancel().catch(() => {});
  } finally {
    reader.releaseLock?.();
  }
  return Buffer.concat(chunks, total).subarray(0, maxBytes).toString('utf8');
}

module.exports = { readResponseBuffer, readResponseText, readResponsePrefixText };
