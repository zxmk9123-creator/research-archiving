// Identity of a page for duplicate checks: scheme, "www.", trailing slash, #fragment and tracking/session params
// (srsltid, utm_*, fbclid, ...) are ignored, so the same article under http/https, with/without "/" or with a
// tracking suffix is one page. Exact-string matching missed those and archived the same article several times.
const TRACKING = /^(utm_|fbclid$|gclid$|mc_|ref$|source$|srsltid$|f$|igshid$|si$|share$)/i;

function urlKey(link) {
  try {
    const u = new URL(link);
    const params = [...u.searchParams.entries()].filter(([k]) => !TRACKING.test(k)).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const qs = params.map(([k, v]) => `${k}=${v}`).join('&');
    return `${u.hostname.replace(/^www\./i, '').toLowerCase()}${u.pathname.replace(/\/+$/, '')}${qs ? `?${qs}` : ''}`;
  } catch (_) { return String(link || ''); }
}

// Keys of archived items whose URL could equal one of `links` (cheap host+path LIKE, then compared by urlKey).
async function existingUrlKeys(pool, links) {
  const keys = new Set();
  const likes = [...new Set(links.map((l) => urlKey(l).split('?')[0]).filter(Boolean))];
  if (!likes.length) return keys;
  const { rows } = await pool.query(
    'SELECT source_url FROM items WHERE lower(source_url) LIKE ANY($1)',
    [likes.map((k) => `%${k.replace(/[\\%_]/g, '\\$&')}%`)]
  );
  for (const r of rows) keys.add(urlKey(r.source_url));
  return keys;
}

module.exports = { urlKey, existingUrlKeys };
