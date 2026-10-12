// Metadata extraction (og:*, <title>, meta description, article body) via
// cheerio — replaces the previous hand-rolled regex parser. Regex HTML
// parsing is fragile against real-world page structure: this file
// previously needed a backreference hack just to stop an apostrophe
// inside a double-quoted attribute from truncating og:title/og:description
// (quote characters aren't interchangeable, but [^"']* treated them as
// equivalent terminators), and a full <br>-fallback path because a
// production site (g-enews.com) rendered its article body as <br>-
// separated text with no <p> tags at all, which the <p>-only regex simply
// couldn't see. cheerio parses real HTML (lenient, same tolerance a
// browser has for malformed markup) instead of pattern-matching it, so an
// attribute's quote type, tag order, and self-closing style all just work
// without special-casing.
const cheerio = require('cheerio');
const { decodeHTML } = require('entities');

// Bot-block/CAPTCHA interstitials (Radware, Akamai, Cloudflare, generic
// "verify you are human" pages) return HTTP 200 with a real <title> —
// res.ok is true and extraction "succeeds", so without this check a
// candidate like "Client Challenge" or "Radware Bot Manager Captcha" was
// archived as if it were the article itself (confirmed in production:
// several Archive Discovery items were exactly this). Matched against the
// title only, not the full body, to stay narrow and avoid false-positives
// on a real article that merely mentions "captcha" or "verification".
const BOT_BLOCK_TITLE_RE = /^(client challenge|just a moment\.{0,3}|attention required!?|access denied|radware bot manager captcha|checking your browser|are you a human|pardon our interruption)\s*(\||$)/i;
function isBotBlockPage(title) {
  return BOT_BLOCK_TITLE_RE.test((title || '').trim());
}

// og:description is often a one-sentence teaser (or absent entirely), which
// starves the AI draft prompt of real material — the weak-summary/insight
// complaint traces back to this, not to the AI prompt itself. Pulling the
// actual <p> body text gives generateAiDraftForItem() something substantive
// to work from.
const MAX_BODY_TEXT_CHARS = 6000;
// Hard cap on how much raw HTML cheerio ever parses — see the comment at
// its use site in extractMetadata() for why.
const MAX_HTML_CHARS = 500_000;
// Below this, the <p>-based pool isn't the real article — try the <br>
// fallback instead of accepting a thin/empty result.
const MIN_SUBSTANTIAL_BODY_CHARS = 200;

// A footer/legal-notice paragraph (copyright line, publisher address,
// "무단전재 금지") is itself often a real <p>...</p> long enough to pass the
// length filter below — production incident: a g-enews.com article's
// extracted "body text" turned out to be nothing but this, 327 characters
// of copyright notice, with the actual article (confirmed present in the
// page) never captured at all. Worse than finding no content, because it
// silently reads as real article text to generateAiDraftForItem(), so the
// model correctly judged it had no substance — on the wrong input.
const BOILERPLATE_PARAGRAPH_RE = /copyright\s*©|무단\s*(전재|사용|복사|배포)|all rights reserved|저작권법에\s*저촉|^\(우\)\d{5}/i;

function filterParagraphs(texts) {
  return texts
    .map((t) => t.trim())
    .filter((text) => text.length > 40 && !BOILERPLATE_PARAGRAPH_RE.test(text)); // drop nav/caption/boilerplate fragments
}

// The <br>-fallback's segments are raw (still-tagged) HTML substrings from
// a plain string split — never parsed by cheerio, so unlike $(...).text()
// they're never auto-decoded. Uses `entities` (cheerio/htmlparser2's own
// entity decoder, added as a direct dependency) for the full HTML5 entity
// set rather than a hand-picked list — a hand-rolled version of this
// function covering only &amp;/&lt;/&gt;/&quot;/&#39; needed patching
// twice in production for entities it didn't know (&#039; the zero-padded
// numeric apostrophe, then &#8217; the curly right-single-quote), and
// there was no reason to expect either patch was the last one needed.
function stripTags(fragment) {
  return decodeHTML(fragment.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
}

// Shared by extractBodyText(html) (the standalone/tested entry point) and
// extractMetadata() (which parses the page once and reuses the same
// cheerio instance for both metadata and body text, rather than parsing
// twice).
// Structural, not text-pattern, boilerplate exclusion — one of the things
// cheerio actually makes possible that the old regex parser couldn't:
// these containers can now be dropped from the DOM entirely before <p>
// collection ever runs, instead of trying to recognize their text content
// after the fact. Confirmed live (2026-10-12): a site's own tagline
// ("Essential news coupled with the finest maritime content sourced from
// across the globe.") and an author-bio blurb ("What I Cover / My focus
// spans the global energy landscape...") both slipped into body_text as
// its very first paragraph on two different real sites, ahead of the
// actual article — BOILERPLATE_PARAGRAPH_RE only ever matched copyright/
// legal-notice phrasing, nothing generic enough to catch either of these,
// and never could without risking false positives on real article prose
// that happens to share a word with site chrome.
const BOILERPLATE_CONTAINER_SELECTOR = [
  'header', 'nav', 'footer', 'aside',
  '[class*="author"]', '[class*="byline"]', '[class*="bio"]',
  '[class*="tagline"]', '[class*="subtitle"]', '[class*="masthead"]',
  '[class*="site-desc"]', '[class*="related"]', '[class*="share"]',
  '[class*="social"]', '[class*="newsletter"]', '[class*="advert"]',
  '[class*="widget"]', '[class*="promo"]', '[class*="disclaimer"]',
].join(', ');

function extractBodyTextFrom($) {
  $('script, style').remove();
  $(BOILERPLATE_CONTAINER_SELECTOR).remove();
  let paragraphs = filterParagraphs($('p').map((i, el) => $(el).text()).get());

  // Some Korean news CMS templates render the article body as a single
  // container with <br> line breaks instead of separate <p> tags — <p>
  // extraction then finds nothing but nav/footer paragraphs (confirmed in
  // production on g-enews.com: the real article sat in <br>-separated
  // lines inside one <div itemprop="articleBody">, with no <p> tags at
  // all). Generic fallback, not site-specific: whenever the <p> pool is
  // too thin to plausibly be the article, also try text runs separated by
  // <br>, and keep whichever pool is actually bigger. This is the one part
  // cheerio's DOM model doesn't give a direct equivalent for (a <br> isn't
  // a container with its own text), so it still works off the serialized
  // HTML string, same as before.
  if (paragraphs.join('').length < MIN_SUBSTANTIAL_BODY_CHARS) {
    const bodyHtml = $('body').html() || $.html();
    const brParagraphs = filterParagraphs(bodyHtml.split(/<br\s*\/?>/gi).map(stripTags));
    if (brParagraphs.join('').length > paragraphs.join('').length) paragraphs = brParagraphs;
  }

  if (!paragraphs.length) return null;
  return paragraphs.join('\n\n').slice(0, MAX_BODY_TEXT_CHARS);
}

function extractBodyText(html) {
  return extractBodyTextFrom(cheerio.load(html.slice(0, MAX_HTML_CHARS)));
}

async function extractMetadata(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ResearchArchivingBot/1.0)' },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`fetch failed: ${res.status}`);
  const rawHtml = await res.text();
  // Production incident: an unbounded-size page fed into the previous
  // regex parser froze the whole Node process for minutes — GET / (a
  // static file, no DB query) took 4+ minutes to respond while a
  // collection run was fetching real-world pages, some apparently large or
  // malformed enough to blow up backtracking across the full document.
  // og:meta tags and the first article paragraphs always appear near the
  // top of a real page, so truncating well before cheerio ever parses it
  // bounds the worst case without losing anything it would have found
  // anyway — still needed with cheerio, which has to walk the whole
  // document regardless of how lenient its parser is.
  const html = rawHtml.slice(0, MAX_HTML_CHARS);
  const $ = cheerio.load(html);

  // Matches whichever of property="X"/name="X" the page actually used, in
  // either attribute order — a CSS attribute selector doesn't care which,
  // unlike the previous two-regex-with-a-fallback approach this replaces.
  const metaContent = (prop) => {
    const value = $(`meta[property="${prop}"], meta[name="${prop}"]`).attr('content');
    return value ? value.trim() : null;
  };

  const title = metaContent('og:title') || $('title').first().text().trim() || null;
  if (isBotBlockPage(title)) throw new Error(`bot-block interstitial detected: "${title}"`);
  const summary = metaContent('og:description') || metaContent('description');
  const thumbnail_url = metaContent('og:image');
  const publishedRaw = metaContent('article:published_time') || metaContent('og:published_time') || metaContent('date');
  const body_text = extractBodyTextFrom($);

  return {
    title,
    summary,
    thumbnail_url,
    published_at: publishedRaw ? publishedRaw.slice(0, 10) : null,
    body_text,
  };
}

module.exports = { extractMetadata, isBotBlockPage, extractBodyText };
