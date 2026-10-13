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
    const buffer = Buffer.from(await response.arrayBuffer());
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

module.exports = { readResponseBuffer, readResponseText };
