// Minimal RSS 2.0 / Atom parser — regex-based, no XML dependency.
//
// Entity decoding used to be a hand-rolled list of five replace() calls
// covering only &amp;/&lt;/&gt;/&quot;/&#39; — every entity outside that
// list reached the chatbot/UI verbatim. Confirmed in production twice:
// first &#039; (the zero-padded numeric apostrophe some feeds use instead
// of &#39;, e.g. "Indonesia&#039;s Palm Oil Export Overhaul"), then
// &#8217; (the curly right-single-quote entity, e.g. "Iran&#8217;s IRGC
// hit 7 '‘violating'’ oilers"). Patching the list one entity at a time
// after each report is exactly the failure mode to stop: there are
// hundreds of named/numeric HTML entities, and hand-picking which ones
// matter is guaranteed to miss the next one some other feed happens to
// use. `entities` (the HTML entity decoder cheerio/htmlparser2 already
// depend on — added here as a direct dependency rather than relying on
// it staying available transitively) decodes the full HTML5 entity set
// correctly, so there's no list left to maintain.
const { decodeHTML } = require('entities');
function decodeEntities(str) {
  if (!str) return str;
  return decodeHTML(str.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')).trim();
}

function stripTags(str) {
  return str ? decodeEntities(str.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')).trim() : null;
}

function tag(block, name) {
  const m = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)<\\/${name}>`, 'i'));
  return m ? decodeEntities(m[1]) : null;
}

function parseFeed(xml) {
  const items = [];

  for (const m of xml.matchAll(/<item[^>]*>([\s\S]*?)<\/item>/gi)) {
    const block = m[1];
    items.push({
      title: stripTags(tag(block, 'title')),
      link: (tag(block, 'link') || '').trim(),
      pubDate: tag(block, 'pubDate') || tag(block, 'dc:date'),
      description: stripTags(tag(block, 'description')),
    });
  }

  if (items.length === 0) {
    for (const m of xml.matchAll(/<entry[^>]*>([\s\S]*?)<\/entry>/gi)) {
      const block = m[1];
      const linkMatch = block.match(/<link[^>]*href=["']([^"']+)["'][^>]*\/?>(?!<\/link>)/i);
      items.push({
        title: stripTags(tag(block, 'title')),
        link: linkMatch ? linkMatch[1] : (tag(block, 'link') || '').trim(),
        pubDate: tag(block, 'updated') || tag(block, 'published'),
        description: stripTags(tag(block, 'summary') || tag(block, 'content')),
      });
    }
  }

  return items.filter((i) => i.title && i.link);
}

function toDateOnly(pubDate) {
  if (!pubDate) return null;
  const d = new Date(pubDate);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

module.exports = { parseFeed, toDateOnly };
