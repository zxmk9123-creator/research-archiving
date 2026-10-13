const test = require('node:test');
const assert = require('node:assert/strict');
const extractMetadataModule = require('../server/lib/extractMetadata');
const { isBotBlockPage, extractBodyText, extractMetadata } = extractMetadataModule;

function mockFetchHtml(html) {
  const original = global.fetch;
  global.fetch = async () => ({ ok: true, status: 200, text: async () => html });
  return () => { global.fetch = original; };
}

// Regression for the production finding: a bot-block/CAPTCHA interstitial
// (Radware, Akamai "Client Challenge", Cloudflare) returns HTTP 200 with a
// real <title>, so res.ok alone can't catch it — several Archive
// Discovery items were archived with exactly these titles before this check.

test('isBotBlockPage: recognizes known bot-block/CAPTCHA interstitial titles', () => {
  assert.equal(isBotBlockPage('Client Challenge'), true);
  assert.equal(isBotBlockPage('Radware Bot Manager Captcha'), true);
  assert.equal(isBotBlockPage('Just a moment...'), true);
  assert.equal(isBotBlockPage('Attention Required! | Cloudflare'), true);
  assert.equal(isBotBlockPage('Access Denied'), true);
  assert.equal(isBotBlockPage('Pardon Our Interruption'), true);
});

test('isBotBlockPage: is case-insensitive and tolerates surrounding whitespace', () => {
  assert.equal(isBotBlockPage('  client challenge  '), true);
  assert.equal(isBotBlockPage('CLIENT CHALLENGE'), true);
});

test('isBotBlockPage: does not flag a real article title, even one that mentions captcha/verification in passing', () => {
  assert.equal(isBotBlockPage('Palm Oil Market to Hit USD 105.15 Billion by 2032'), false);
  assert.equal(isBotBlockPage('How CAPTCHA verification works on e-commerce sites'), false);
  assert.equal(isBotBlockPage(null), false);
  assert.equal(isBotBlockPage(undefined), false);
  assert.equal(isBotBlockPage(''), false);
});

// og:description alone is often a thin one-line teaser, which starved the AI
// draft prompt of real material (the reported weak title/summary/insight
// output). extractBodyText() pulls the actual <p> paragraph text instead so
// there's substance to summarize/infer from.

test('extractBodyText: concatenates paragraph text, stripping tags and boilerplate-length fragments', () => {
  const html = `<html><body>
    <nav><p>Home</p></nav>
    <article>
      <p>Palm oil exports from Indonesia rose 12% in September as demand from India strengthened ahead of the festival season.</p>
      <p>Hi</p>
      <p>Analysts at a major trading house said the increase reflects both higher production and a weaker rupiah making Indonesian palm oil more competitive against Malaysian supply.</p>
    </article>
  </body></html>`;
  const text = extractBodyText(html);
  assert.ok(text.includes('Palm oil exports from Indonesia rose 12%'));
  assert.ok(text.includes('Analysts at a major trading house'));
  assert.ok(!text.includes('Hi'), 'short boilerplate-length fragments (e.g. nav labels) should be dropped');
});

test('extractBodyText: strips script/style content and HTML tags from paragraph text', () => {
  const html = `<html><head><style>.x{color:red}</style></head><body>
    <script>var x = 1;</script>
    <p>Soybean crush margins <b>widened</b> this week as the USDA raised its export forecast for the 2026/27 marketing year.</p>
  </body></html>`;
  const text = extractBodyText(html);
  assert.ok(text.includes('Soybean crush margins widened this week'));
  assert.ok(!text.includes('<b>'));
  assert.ok(!text.includes('color:red'));
});

test('extractBodyText: returns null when there is no usable paragraph content', () => {
  assert.equal(extractBodyText('<html><body><div>no p tags here</div></body></html>'), null);
});

// Production incident: a g-enews.com article's only <p> tag was its
// footer copyright/address notice (327 chars, long enough to pass the
// length filter on its own) — generateAiDraftForItem() then correctly
// judged the "article" had no real content, because that's genuinely all
// it was given. The real article text existed on the page but was never
// captured. Must be filtered out even when it's the only long paragraph.
test('extractBodyText: a long copyright/address footer paragraph is filtered out, not treated as article content', () => {
  const html = `<html><body>
    <p>(우)04004 서울특별시 마포구 월드컵로62 서교동 한림빌딩 2층 | 법인명 : (주)그린미디어 | 제호 : 글로벌이코노믹. Copyright © 2011 글로벌이코노믹. All rights reserved.</p>
  </body></html>`;
  assert.equal(extractBodyText(html), null);
});

// Same production incident: the real article body on g-enews.com was
// rendered as a single <div itemprop="articleBody"> with <br> line breaks,
// no <p> tags at all — <p>-based extraction found nothing but the footer
// above, so this generic (not site-specific) fallback is what actually
// recovers the article.
test('extractBodyText: falls back to <br>-separated text when <p> extraction is too thin (common Korean news CMS pattern)', () => {
  const html = `<html><body>
    <div itemprop="articleBody">
      GS칼텍스는 지난 8일 DHL 익스프레스와 협약을 맺고 국내에서 급유하는 항공기에 향후 1년간 순수 SAF 기준 2000t을 공급하기로 했다.<br />
      HD현대오일뱅크는 2024년 6월 일본 마루베니상사를 통해 전일본공수(ANA)에 SAF를 공급하며 국내 첫 SAF 수출 실적을 냈다.<br />
    </div>
    <p>Copyright © 2011 글로벌이코노믹. All rights reserved.</p>
  </body></html>`;
  const text = extractBodyText(html);
  assert.ok(text.includes('GS칼텍스는 지난 8일 DHL 익스프레스와 협약을 맺고'));
  assert.ok(text.includes('HD현대오일뱅크는 2024년 6월 일본 마루베니상사를 통해'));
  assert.ok(!text.includes('Copyright'));
});

test('extractBodyText: a substantial <p>-based article is kept as-is, never replaced by the <br> fallback', () => {
  const html = `<html><body><article>
    <p>Palm oil exports from Indonesia rose 12% in September as demand from India strengthened ahead of the festival season, trade data showed on Monday.</p>
    <p>Analysts at a major trading house said the increase reflects both higher production and a weaker rupiah making Indonesian palm oil more competitive against Malaysian supply this quarter.</p>
  </article></body></html>`;
  const text = extractBodyText(html);
  assert.ok(text.includes('Palm oil exports from Indonesia rose 12%'));
  assert.ok(text.includes('Analysts at a major trading house'));
});

// Production finding (2026-10-12, after switching extraction to cheerio):
// a site's own masthead tagline and an author-bio blurb both slipped into
// body_text as its very first paragraph, ahead of the real article, on two
// different real sites — neither matched BOILERPLATE_PARAGRAPH_RE (which
// only ever targeted copyright/legal-notice phrasing), so these needed a
// structural exclusion instead: drop known non-article containers from
// the DOM before <p> collection, something only possible once real HTML
// parsing (cheerio) replaced the old regex-based extraction.

test('extractBodyText: drops a site masthead/tagline inside <header>, keeps the real article', () => {
  const html = `<html><body>
    <header><p>Essential news coupled with the finest maritime content sourced from across the globe.</p></header>
    <article>
      <p>Two more tankers have been struck in the Strait of Hormuz as U.S. forces disable a cargo vessel in the Gulf of Oman, extending a sharp escalation in attacks on commercial shipping.</p>
    </article>
  </body></html>`;
  const text = extractBodyText(html);
  assert.ok(text.includes('Two more tankers have been struck'));
  assert.ok(!text.includes('Essential news coupled'));
});

test('extractBodyText: drops an author-bio blurb by class name, keeps the real article', () => {
  const html = `<html><body>
    <div class="author-bio"><p>My focus spans the global energy landscape and the technologies reshaping it, specifically oil and gas markets.</p></div>
    <article>
      <p>The U.S. Strategic Petroleum Reserve held just 283 million barrels of oil at the end of September, the lowest level since October 1982.</p>
    </article>
  </body></html>`;
  const text = extractBodyText(html);
  assert.ok(text.includes('The U.S. Strategic Petroleum Reserve held'));
  assert.ok(!text.includes('My focus spans'));
});

// Production bug: a title/description containing an apostrophe (common in
// possessives, e.g. "Indonesia's exports...") was truncated right at that
// apostrophe — [^"']* treated ' and " as interchangeable terminators
// regardless of which quote character the attribute actually used.

test('extractMetadata: og:title content is not truncated by an apostrophe inside a double-quoted attribute', async () => {
  const restore = mockFetchHtml(`<html><head>
    <meta property="og:title" content="Indonesia's palm oil exports rise 12% in September">
  </head><body><p>${'x'.repeat(50)}</p></body></html>`);
  try {
    const meta = await extractMetadata('https://example.org/a');
    assert.equal(meta.title, "Indonesia's palm oil exports rise 12% in September");
  } finally {
    restore();
  }
});

test('extractMetadata: og:description content is not truncated by a double quote inside a single-quoted attribute', async () => {
  const restore = mockFetchHtml(`<html><head>
    <meta property='og:description' content='Analysts called it a "record" month for exports'>
  </head><body><p>${'x'.repeat(50)}</p></body></html>`);
  try {
    const meta = await extractMetadata('https://example.org/b');
    assert.equal(meta.summary, 'Analysts called it a "record" month for exports');
  } finally {
    restore();
  }
});

test('extractMetadata: falls back to <title> tag when og:title is absent, apostrophe included', async () => {
  const restore = mockFetchHtml(`<html><head>
    <title>Cargill's Q3 earnings beat expectations</title>
  </head><body><p>${'x'.repeat(50)}</p></body></html>`);
  try {
    const meta = await extractMetadata('https://example.org/c');
    assert.equal(meta.title, "Cargill's Q3 earnings beat expectations");
  } finally {
    restore();
  }
});

// Production incident: an unbounded-size/malformed page froze the whole
// Node process for minutes (GET / itself, a static file with no DB query,
// took 4+ minutes to respond) while extractMetadata()'s regexes scanned a
// huge real-world HTML document during a collection run. Truncating the
// HTML before any regex touches it bounds the worst case regardless of
// page size or adversarial structure.

test('extractMetadata: a very large page (well past the truncation cap) still extracts quickly instead of hanging', async () => {
  const filler = '<div>' + 'x'.repeat(2_000_000) + '</div>'; // ~2MB, past MAX_HTML_CHARS
  const html = `<html><head><meta property="og:title" content="Large page title"></head><body><p>${'A'.repeat(100)}</p>${filler}</body></html>`;
  const restore = mockFetchHtml(html);
  try {
    const start = Date.now();
    const meta = await extractMetadata('https://example.org/huge');
    const elapsedMs = Date.now() - start;
    assert.equal(meta.title, 'Large page title');
    assert.ok(elapsedMs < 2000, `expected fast extraction on a large page, took ${elapsedMs}ms`);
  } finally {
    restore();
  }
});

// Production gap: a Draft's AI draft quality depended on whichever single
// extraction attempt happened to run first — RSS collection time, or a
// manual "AI 초안 작성" click — succeeding. A transient fetch timeout/bot-
// block there silently fell back to the bare feed description, while a
// LATER "다시 생성" against the exact same URL often succeeded cleanly on
// a fresh attempt, purely by getting a second try.
function mockExtractMetadataSequence(results) {
  const original = extractMetadataModule.extractMetadata;
  let call = 0;
  extractMetadataModule.extractMetadata = async () => {
    const next = results[Math.min(call, results.length - 1)];
    call++;
    if (next instanceof Error) throw next;
    return next;
  };
  return { restore: () => { extractMetadataModule.extractMetadata = original; }, callCount: () => call };
}

test('extractMetadataWithRetry: retries once on a thrown error and returns the retry success, instead of failing on a one-off transient failure', async () => {
  const { restore, callCount } = mockExtractMetadataSequence([
    new Error('fetch failed: 503'),
    { title: 't', summary: 's', body_text: 'the real article body' },
  ]);
  try {
    const meta = await extractMetadataModule.extractMetadataWithRetry('https://example.org/a', { delayMs: 1 });
    assert.equal(meta.body_text, 'the real article body');
    assert.equal(callCount(), 2);
  } finally {
    restore();
  }
});

test('extractMetadataWithRetry: exhausting every attempt re-throws the last error', async () => {
  const { restore } = mockExtractMetadataSequence([
    new Error('fetch failed: 503'),
    new Error('fetch failed: 503'),
  ]);
  try {
    await assert.rejects(
      () => extractMetadataModule.extractMetadataWithRetry('https://example.org/a', { delayMs: 1 }),
      /fetch failed: 503/
    );
  } finally {
    restore();
  }
});

test('extractMetadataWithRetry: a successful first attempt never retries, even when body_text is short — re-fetching identical static HTML can\'t change a deterministic result', async () => {
  const { restore, callCount } = mockExtractMetadataSequence([
    { title: 't', summary: 's', body_text: '' },
  ]);
  try {
    const meta = await extractMetadataModule.extractMetadataWithRetry('https://example.org/a', { delayMs: 1 });
    assert.equal(meta.body_text, '');
    assert.equal(callCount(), 1);
  } finally {
    restore();
  }
});
