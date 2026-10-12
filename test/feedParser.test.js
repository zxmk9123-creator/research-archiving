const test = require('node:test');
const assert = require('node:assert/strict');
const { parseFeed } = require('../server/lib/feedParser');

// Production incident: RSS titles reached the AI search chatbot with a
// literal "&#039;" still in them (e.g. "Indonesia&#039;s Palm Oil Export
// Overhaul"), because decodeEntities() only matched the non-zero-padded
// numeric apostrophe entity &#39;, not the zero-padded form &#039; some
// feeds actually use — both represent the same character (U+0027). Same
// bug already found and fixed in adapters/institutionPdf.js; this is the
// same fix applied to the RSS/Atom parser.

test('parseFeed: decodes the zero-padded numeric apostrophe entity (&#039;) in RSS item titles', () => {
  const xml = `<rss><channel><item>
    <title>Indonesia&#039;s Palm Oil Export Overhaul: What It Means for Indian Edible Oil Stocks</title>
    <link>https://example.org/a</link>
  </item></channel></rss>`;
  const items = parseFeed(xml);
  assert.equal(items.length, 1);
  assert.equal(items[0].title, "Indonesia's Palm Oil Export Overhaul: What It Means for Indian Edible Oil Stocks");
});

test('parseFeed: still decodes the non-padded numeric apostrophe entity (&#39;)', () => {
  const xml = `<rss><channel><item>
    <title>YPF&#39;s future biorefinery in Argentina already has a buyer</title>
    <link>https://example.org/b</link>
  </item></channel></rss>`;
  const items = parseFeed(xml);
  assert.equal(items[0].title, "YPF's future biorefinery in Argentina already has a buyer");
});

test('parseFeed: decodes the zero-padded apostrophe entity in Atom <entry> titles too', () => {
  const xml = `<feed><entry>
    <title>Cargill&#039;s Q3 earnings beat expectations</title>
    <link href="https://example.org/c"/>
  </entry></feed>`;
  const items = parseFeed(xml);
  assert.equal(items[0].title, "Cargill's Q3 earnings beat expectations");
});

// Second production incident after the &#039; fix above, from switching
// decodeEntities() to `entities`'s decodeHTML(): "Iran&#8217;s IRGC hit 7
// '‘violating'’ oilers" reached the chatbot verbatim — &#8217; (curly
// right-single-quote) and &#8216;/&#8220;/&#8221; (curly left-single-quote,
// curly double-quotes) were never in the hand-picked entity list at all.
// This is exactly the class of bug decodeHTML() closes structurally,
// rather than needing yet another one-off regex patch.

test('parseFeed: decodes curly-quote entities (&#8217; etc.), not just straight-quote ones', () => {
  const xml = `<rss><channel><item>
    <title>Iran&#8217;s IRGC hit 7 &#8216;violating&#8217; oilers</title>
    <link>https://example.org/d</link>
  </item></channel></rss>`;
  const items = parseFeed(xml);
  assert.equal(items[0].title, 'Iran’s IRGC hit 7 ‘violating’ oilers');
});
