const test = require('node:test');
const assert = require('node:assert');
const { extractArticleLinks } = require('../server/lib/referenceCollect');

test('extractArticleLinks keeps same-site articles and pdfs, drops nav and offsite', () => {
  const html = `
    <a href="/news/2026/palm-oil-exports-rise-sharply-in-october">Palm oil exports rise sharply in October</a>
    <a href="/about/team">Meet the whole leadership team here</a>
    <a href="https://other.com/news/a/long-article-title-here">Some long offsite article title here</a>
    <a href="/files/report.pdf">Annual vegetable oil market outlook report</a>
    <a href="/news">News</a>`;
  const out = extractArticleLinks(html, 'https://example.org/news');
  assert.deepStrictEqual(out.map((c) => c.link), [
    'https://example.org/news/2026/palm-oil-exports-rise-sharply-in-october',
    'https://example.org/files/report.pdf',
  ]);
});
