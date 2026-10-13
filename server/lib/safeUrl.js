// SSRF defense for every outbound fetch whose URL this app did not
// itself choose — a Web Discovery search result, a link discovered on an
// institution's listing page, an item's own source_url being
// re-extracted. Rejects: non-http(s) schemes, a literal private/loopback/
// link-local/metadata IP, a hostname that resolves to one, and known
// internal hostnames (localhost, *.internal, *.railway.internal, *.local
// — this app itself is reachable at <service>.railway.internal on
// Railway's private network, so that pattern is not hypothetical here).
//
// Checked again on every redirect hop (safeFetch), not just the URL a
// caller started with — a public URL that later 302s to an internal
// address must be caught too, which is why safeFetch always follows
// redirects manually instead of letting fetch() auto-follow them.
const dns = require('dns').promises;
const net = require('net');

const MAX_REDIRECTS = 5;

function isPrivateIp(ip) {
  const type = net.isIP(ip);
  if (type === 4) {
    const parts = ip.split('.').map(Number);
    const [a, b] = parts;
    if (a === 10) return true; // 10.0.0.0/8
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
    if (a === 192 && b === 168) return true; // 192.168.0.0/16
    if (a === 127) return true; // loopback
    if (a === 169 && b === 254) return true; // link-local, incl. 169.254.169.254 cloud metadata
    if (a === 0) return true; // 0.0.0.0/8
    return false;
  }
  if (type === 6) {
    const lower = ip.toLowerCase();
    if (lower === '::1') return true; // loopback
    if (/^f[cd][0-9a-f]{0,2}:/.test(lower)) return true; // fc00::/7 unique local
    if (lower.startsWith('fe80')) return true; // link-local
    return false;
  }
  return false; // not an IP literal — caller resolves it separately
}

const BLOCKED_HOSTNAME_RE = /(^localhost$)|(\.local$)|(\.internal$)|(\.railway\.internal$)/i;

async function assertHostnameSafe(hostname) {
  if (BLOCKED_HOSTNAME_RE.test(hostname)) {
    throw new Error(`unsafe URL: blocked hostname "${hostname}"`);
  }
  if (net.isIP(hostname)) {
    if (isPrivateIp(hostname)) throw new Error(`unsafe URL: private/internal IP address "${hostname}"`);
    return;
  }
  // A hostname can have multiple A/AAAA records — check every one this
  // lookup returns. This is a floor against a static DNS-based SSRF
  // attempt, not a defense against DNS rebinding timed between this
  // lookup and the TCP connection fetch() makes right after — that would
  // need intercepting the connection itself, out of scope here.
  let addresses;
  try {
    addresses = await dns.lookup(hostname, { all: true });
  } catch {
    throw new Error(`unsafe URL: could not resolve hostname "${hostname}"`);
  }
  for (const { address } of addresses) {
    if (isPrivateIp(address)) throw new Error(`unsafe URL: hostname "${hostname}" resolves to a private/internal address`);
  }
}

async function assertSafeUrl(urlString) {
  let parsed;
  try {
    parsed = new URL(urlString);
  } catch {
    throw new Error('unsafe URL: not a valid URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`unsafe URL: unsupported protocol "${parsed.protocol}"`);
  }
  await assertHostnameSafe(parsed.hostname);
  return parsed;
}

// fetch() with redirect:'manual' plus per-hop re-validation. Drop-in for
// a plain fetch() call: returns the final response the same way fetch()
// with its default redirect:'follow' would, just with every hop checked.
async function safeFetch(urlString, options = {}) {
  let currentUrl = urlString;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await assertSafeUrl(currentUrl);
    const res = await fetch(currentUrl, { ...options, redirect: 'manual' });
    // res.headers is absent on the plain mock response objects every
    // test's fetch() stub returns (no real Headers instance) — treat that
    // the same as "no redirect" rather than throwing, so this only
    // changes behavior for an actual 3xx response.
    const location = res.headers && typeof res.headers.get === 'function' ? res.headers.get('location') : null;
    if (res.status >= 300 && res.status < 400 && location) {
      currentUrl = new URL(location, currentUrl).toString();
      continue;
    }
    return res;
  }
  throw new Error('unsafe URL: too many redirects');
}

module.exports = { assertSafeUrl, safeFetch, isPrivateIp, MAX_REDIRECTS };
