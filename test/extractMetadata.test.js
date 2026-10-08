const test = require('node:test');
const assert = require('node:assert/strict');
const { isBotBlockPage, extractBodyText } = require('../server/lib/extractMetadata');

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
