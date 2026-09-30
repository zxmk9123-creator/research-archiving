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

// A CGSpace-style listing page (e.g. IFPRI's publications page, itself
// backed by CGIAR's shared CGSpace/DSpace repository) puts the download
// link's anchor text as a generic "Download" button label — the real
// title lives in a separate <h4> heading elsewhere in the same card,
// joined to the download button only by a shared data-identifier
// attribute. This is a genuinely different page shape from World Bank's
// (title IS the anchor text there), so it gets its own small, targeted
// extraction below rather than stretching discoverFromHtml()'s
// anchor-text assumption to cover it.
const CGSPACE_DOWNLOAD_LINK_PATTERN = /cgspace\.cgiar\.org\/server\/api\/core\/bitstreams\/[^/"']+\/content/i;

// Generic button/placeholder labels that are never a real report title —
// a last-line-of-defense guard against ever persisting an item titled
// "Download" (or an equivalent placeholder), in either discovery path.
const GENERIC_TITLE_PATTERN = /^(download|다운로드|pdf|file|report|full text|view|read more)$/i;

function decodeEntities(str) {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    // CGSpace's title markup uses the zero-padded numeric form (&#039;)
    // rather than &#39; — match either.
    .replace(/&#0*39;/g, "'");
}

function isGenericTitle(text) {
  return !text || GENERIC_TITLE_PATTERN.test(text.trim());
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
    if (!text || isGenericTitle(text)) continue;
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

// CGSpace listing pages (IFPRI and other CGIAR-affiliated publishers)
// render each publication as a card containing a <h4 class="...Title...">
// heading and a separate download <a>, both tagged with the same
// data-identifier attribute — the only reliable link between "this is the
// real title" and "this is its download URL" on this page shape. Titles
// are read only from the heading, never from the download button's own
// anchor text, so a generic "Download" label can never become an item
// title here.
const CGSPACE_TITLE_PATTERN = /<h4[^>]*class="[^"]*ifResourcesTitle[^"]*"[^>]*data-identifier\s*=\s*["']([^"']+)["'][^>]*>([^<]*)<\/h4>/gi;
const CGSPACE_LINK_PATTERN = /<a[^>]+href=["'](https:\/\/cgspace\.cgiar\.org\/server\/api\/core\/bitstreams\/[^"']+\/content)["'][^>]*data-identifier\s*=\s*["']([^"']+)["'][^>]*>/gi;

function discoverFromCgspaceHtml(html) {
  const titleByIdentifier = new Map();
  for (const m of html.matchAll(CGSPACE_TITLE_PATTERN)) {
    const [, identifier, rawTitle] = m;
    const title = decodeEntities(rawTitle).replace(/\s+/g, ' ').trim();
    if (title) titleByIdentifier.set(identifier, title);
  }

  const candidates = [];
  const seen = new Set();
  for (const m of html.matchAll(CGSPACE_LINK_PATTERN)) {
    const [, link, identifier] = m;
    const title = titleByIdentifier.get(identifier);
    if (!title || isGenericTitle(title)) continue;
    if (seen.has(link)) continue;
    seen.add(link);
    candidates.push({ title, link });
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
  // CGSpace-backed pages (detected by their distinctive download-endpoint
  // shape) need the title/link join above; every other institutional page
  // — World Bank's included — keeps using the original anchor-text scan,
  // completely unchanged.
  return CGSPACE_DOWNLOAD_LINK_PATTERN.test(html)
    ? discoverFromCgspaceHtml(html)
    : discoverFromHtml(html, source.url);
}

module.exports = { discoverReports, discoverFromHtml, discoverFromCgspaceHtml };
