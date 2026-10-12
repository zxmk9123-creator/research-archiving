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
