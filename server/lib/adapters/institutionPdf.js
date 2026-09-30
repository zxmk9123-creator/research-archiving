// Institutional PDF report adapter — discovers downloadable report links
// from an institution's publication/report listing page. Regex-based, no
// HTML parser dependency, same convention already used by
// feedParser.js (RSS) and extractMetadata.js (og:* meta tags): this
// project has no DOM library, so every acquisition method reads raw HTML
// with a targeted regex rather than adding one.
//
// This is deliberately the ONE general-purpose adapter for "an institution
// publishes reports on a listing page" rather than a bespoke scraper per
// institution — adding another institutional source later is a matter of
// registering a new `sources` row with method='institution' and a listing
// page URL, not writing new pipeline code, as long as that page links its
// reports as direct .pdf hrefs or repository "download" links (the two
// patterns below). A source whose page needs different discovery logic
// would get its own adapter file later, selected by source.method — not a
// reason to complicate this one.

const PDF_LINK_PATTERN = /\.pdf(?:[?#]|$)/i;
// Institutional repositories (e.g. World Bank Open Knowledge Repository)
// often serve the actual PDF via a "bitstream download" URL that doesn't
// end in .pdf but is unambiguously a document download link.
const DOWNLOAD_LINK_PATTERN = /\/bitstreams\/[^/]+\/download/i;

function decodeEntities(str) {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

// Scans <a href="...">text</a> anchors on the listing page and keeps only
// ones that look like a downloadable report: a direct PDF link or a
// repository download link, with non-trivial anchor text to use as the
// candidate's title. Relative hrefs are resolved against the listing
// page's own URL.
function discoverFromHtml(html, baseUrl) {
  const candidates = [];
  const seen = new Set();
  for (const m of html.matchAll(/<a[^>]+href=["']([^"']+)["'][^>]*>([^<]{4,200})<\/a>/gi)) {
    const href = m[1];
    if (!PDF_LINK_PATTERN.test(href) && !DOWNLOAD_LINK_PATTERN.test(href)) continue;
    const text = decodeEntities(m[2]).replace(/\s+/g, ' ').trim();
    if (!text) continue;
    let link;
    try {
      link = new URL(href, baseUrl).toString();
    } catch {
      continue;
    }
    if (seen.has(link)) continue;
    seen.add(link);
    candidates.push({ title: text, link });
  }
  return candidates;
}

async function discoverReports(source) {
  const res = await fetch(source.url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ResearchArchivingBot/1.0)' },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`fetch failed: ${res.status}`);
  const html = await res.text();
  return discoverFromHtml(html, source.url);
}

module.exports = { discoverReports, discoverFromHtml };
