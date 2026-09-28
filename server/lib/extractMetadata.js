// Lightweight metadata extraction (og:*, <title>, meta description) — no HTML parser dependency.
function matchMeta(html, prop) {
  const re = new RegExp(
    `<meta[^>]+(?:property|name)=["']${prop}["'][^>]+content=["']([^"']*)["']`,
    'i'
  );
  const m = html.match(re) || html.match(
    new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+(?:property|name)=["']${prop}["']`, 'i')
  );
  return m ? m[1].trim() : null;
}

function decodeEntities(str) {
  if (!str) return str;
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

async function extractMetadata(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ResearchArchivingBot/1.0)' },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`fetch failed: ${res.status}`);
  const html = await res.text();

  const titleTag = html.match(/<title[^>]*>([^<]*)<\/title>/i);
  const title = decodeEntities(matchMeta(html, 'og:title') || (titleTag ? titleTag[1].trim() : null));
  const summary = decodeEntities(matchMeta(html, 'og:description') || matchMeta(html, 'description'));
  const thumbnail_url = matchMeta(html, 'og:image');
  const published_at = (
    matchMeta(html, 'article:published_time') ||
    matchMeta(html, 'og:published_time') ||
    matchMeta(html, 'date')
  );

  return {
    title: title || null,
    summary: summary || null,
    thumbnail_url: thumbnail_url || null,
    published_at: published_at ? published_at.slice(0, 10) : null,
  };
}

module.exports = { extractMetadata };
