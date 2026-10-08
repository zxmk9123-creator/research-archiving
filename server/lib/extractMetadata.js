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
// to work from. No HTML-parser dependency, same convention as the rest of
// this file: strip script/style blocks, then concatenate <p> text content.
const MAX_BODY_TEXT_CHARS = 6000;

function stripTags(fragment) {
  return decodeEntities(fragment.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
}

function extractBodyText(html) {
  const cleaned = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ');
  const paragraphs = [...cleaned.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)]
    .map((m) => stripTags(m[1]))
    .filter((text) => text.length > 40); // drop nav/caption/boilerplate fragments
  if (!paragraphs.length) return null;
  const joined = paragraphs.join('\n\n');
  return joined.slice(0, MAX_BODY_TEXT_CHARS);
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
  if (isBotBlockPage(title)) throw new Error(`bot-block interstitial detected: "${title}"`);
  const summary = decodeEntities(matchMeta(html, 'og:description') || matchMeta(html, 'description'));
  const thumbnail_url = matchMeta(html, 'og:image');
  const published_at = (
    matchMeta(html, 'article:published_time') ||
    matchMeta(html, 'og:published_time') ||
    matchMeta(html, 'date')
  );
  const body_text = extractBodyText(html);

  return {
    title: title || null,
    summary: summary || null,
    thumbnail_url: thumbnail_url || null,
    published_at: published_at ? published_at.slice(0, 10) : null,
    body_text,
  };
}

module.exports = { extractMetadata, isBotBlockPage, extractBodyText };
