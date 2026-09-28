// Minimal RSS 2.0 / Atom parser — regex-based, no XML dependency.
function decodeEntities(str) {
  if (!str) return str;
  return str
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
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
