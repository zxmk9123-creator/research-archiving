const test = require('node:test');
const assert = require('node:assert/strict');
const dns = require('dns').promises;
const { assertSafeUrl, safeFetch, isPrivateIp, MAX_REDIRECTS } = require('../server/lib/safeUrl');

function mockDns(addresses) {
  const original = dns.lookup;
  dns.lookup = async () => addresses;
  return () => { dns.lookup = original; };
}

function mockFetch(handler) {
  const original = global.fetch;
  global.fetch = handler;
  return () => { global.fetch = original; };
}

// --- isPrivateIp ---

test('isPrivateIp: flags every RFC1918 private IPv4 range', () => {
  assert.equal(isPrivateIp('10.0.0.1'), true);
  assert.equal(isPrivateIp('172.16.0.1'), true);
  assert.equal(isPrivateIp('172.31.255.255'), true);
  assert.equal(isPrivateIp('192.168.1.1'), true);
});

test('isPrivateIp: flags loopback, link-local, cloud metadata, and 0.0.0.0/8', () => {
  assert.equal(isPrivateIp('127.0.0.1'), true);
  assert.equal(isPrivateIp('169.254.169.254'), true); // AWS/GCP/Azure metadata endpoint
  assert.equal(isPrivateIp('0.0.0.0'), true);
});

test('isPrivateIp: does not flag an ordinary public IPv4 address', () => {
  assert.equal(isPrivateIp('93.184.216.34'), false);
  assert.equal(isPrivateIp('8.8.8.8'), false);
});

test('isPrivateIp: 172.x is only private within .16-.31, not the whole /8', () => {
  assert.equal(isPrivateIp('172.15.0.1'), false);
  assert.equal(isPrivateIp('172.32.0.1'), false);
});

test('isPrivateIp: flags IPv6 loopback, unique-local, and link-local', () => {
  assert.equal(isPrivateIp('::1'), true);
  assert.equal(isPrivateIp('fc00::1'), true);
  assert.equal(isPrivateIp('fd12:3456::1'), true);
  assert.equal(isPrivateIp('fe80::1'), true);
});

test('isPrivateIp: does not flag an ordinary public IPv6 address', () => {
  assert.equal(isPrivateIp('2606:2800:220:1:248:1893:25c8:1946'), false);
});

test('isPrivateIp: a non-IP string is not flagged (caller resolves it separately)', () => {
  assert.equal(isPrivateIp('example.org'), false);
});

// --- assertSafeUrl ---

test('assertSafeUrl: rejects a non-http(s) scheme', async () => {
  await assert.rejects(() => assertSafeUrl('file:///etc/passwd'), /unsupported protocol/);
  await assert.rejects(() => assertSafeUrl('ftp://example.org/x'), /unsupported protocol/);
});

test('assertSafeUrl: rejects an unparseable URL', async () => {
  await assert.rejects(() => assertSafeUrl('not a url'), /not a valid URL/);
});

test('assertSafeUrl: rejects a literal private IPv4 address with no DNS lookup needed', async () => {
  await assert.rejects(() => assertSafeUrl('http://169.254.169.254/latest/meta-data/'), /private\/internal IP/);
});

test('assertSafeUrl: rejects localhost and internal-looking hostnames outright', async () => {
  await assert.rejects(() => assertSafeUrl('http://localhost:8080/'), /blocked hostname/);
  await assert.rejects(() => assertSafeUrl('http://research-archiving.railway.internal:8080/api/sources'), /blocked hostname/);
  await assert.rejects(() => assertSafeUrl('http://printer.local/'), /blocked hostname/);
});

test('assertSafeUrl: rejects a hostname that resolves to a private address', () => {
  const restore = mockDns([{ address: '10.0.0.5', family: 4 }]);
  return assert.rejects(() => assertSafeUrl('https://attacker-controlled.example/'), /resolves to a private\/internal address/)
    .finally(restore);
});

test('assertSafeUrl: allows an ordinary public hostname', () => {
  const restore = mockDns([{ address: '93.184.216.34', family: 4 }]);
  return assertSafeUrl('https://example.org/article').finally(restore);
});

test('assertSafeUrl: checks every resolved address, not just the first', () => {
  const restore = mockDns([{ address: '93.184.216.34', family: 4 }, { address: '127.0.0.1', family: 4 }]);
  return assert.rejects(() => assertSafeUrl('https://multi-homed.example/'), /resolves to a private\/internal address/)
    .finally(restore);
});

// --- safeFetch ---

test('safeFetch: follows a safe redirect and validates the new target too', async () => {
  const restoreDns = mockDns([{ address: '93.184.216.34', family: 4 }]);
  let calls = 0;
  const restoreFetch = mockFetch(async (url) => {
    calls++;
    if (url === 'https://example.org/old') {
      return { status: 301, headers: { get: (k) => (k === 'location' ? 'https://example.org/new' : null) } };
    }
    return { ok: true, status: 200, headers: { get: () => null }, text: async () => 'ok' };
  });
  try {
    const res = await safeFetch('https://example.org/old');
    assert.equal(await res.text(), 'ok');
    assert.equal(calls, 2);
  } finally {
    restoreFetch();
    restoreDns();
  }
});

test('safeFetch: a redirect to a private address is rejected before the second hop is fetched', async () => {
  const restoreDns = mockDns([{ address: '93.184.216.34', family: 4 }]);
  const restoreFetch = mockFetch(async (url) => {
    if (url === 'https://example.org/old') {
      return { status: 302, headers: { get: (k) => (k === 'location' ? 'http://127.0.0.1:8080/admin' : null) } };
    }
    throw new Error('must not reach the redirect target');
  });
  try {
    await assert.rejects(() => safeFetch('https://example.org/old'), /private\/internal IP/);
  } finally {
    restoreFetch();
    restoreDns();
  }
});

test('safeFetch: gives up after MAX_REDIRECTS hops', async () => {
  const restoreDns = mockDns([{ address: '93.184.216.34', family: 4 }]);
  let hops = 0;
  const restoreFetch = mockFetch(async () => {
    hops++;
    return { status: 302, headers: { get: (k) => (k === 'location' ? 'https://example.org/next' : null) } };
  });
  try {
    await assert.rejects(() => safeFetch('https://example.org/start'), /too many redirects/);
    assert.equal(hops, MAX_REDIRECTS + 1);
  } finally {
    restoreFetch();
    restoreDns();
  }
});

test('safeFetch: a plain 200 response (no headers object, as every test mock returns) passes through untouched', async () => {
  const restoreDns = mockDns([{ address: '93.184.216.34', family: 4 }]);
  const restoreFetch = mockFetch(async () => ({ ok: true, status: 200, text: async () => 'body' }));
  try {
    const res = await safeFetch('https://example.org/');
    assert.equal(await res.text(), 'body');
  } finally {
    restoreFetch();
    restoreDns();
  }
});
