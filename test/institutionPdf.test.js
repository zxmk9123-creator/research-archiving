const test = require('node:test');
const assert = require('node:assert/strict');
const { discoverFromHtml } = require('../server/lib/adapters/institutionPdf');

test('discoverFromHtml: finds a direct .pdf link with its anchor text as title', () => {
  const html = `<a href="/reports/CMO-October-2026.pdf">Commodity Markets Outlook, October 2026</a>`;
  const candidates = discoverFromHtml(html, 'https://example.org/research/');
  assert.deepEqual(candidates, [
    { title: 'Commodity Markets Outlook, October 2026', link: 'https://example.org/reports/CMO-October-2026.pdf' },
  ]);
});

test('discoverFromHtml: finds a repository "bitstream download" link even without a .pdf extension', () => {
  const html = `<a href="https://openknowledge.example.org/bitstreams/abc-123/download">Full report</a>`;
  const candidates = discoverFromHtml(html, 'https://example.org/');
  assert.deepEqual(candidates, [
    { title: 'Full report', link: 'https://openknowledge.example.org/bitstreams/abc-123/download' },
  ]);
});

test('discoverFromHtml: ignores non-report links (nav, unrelated pages)', () => {
  const html = `
    <a href="/about">About Us</a>
    <a href="/research/commodity-markets/report-archive">Report Archive</a>
    <a href="/image.png">A picture</a>
  `;
  assert.deepEqual(discoverFromHtml(html, 'https://example.org/'), []);
});

test('discoverFromHtml: decodes HTML entities in anchor text', () => {
  const html = `<a href="/x.pdf">Prices &amp; Trends, Q3&#39;26</a>`;
  const candidates = discoverFromHtml(html, 'https://example.org/');
  assert.equal(candidates[0].title, "Prices & Trends, Q3'26");
});

test('discoverFromHtml: dedupes the same href linked twice on the page', () => {
  const html = `
    <a href="/x.pdf">Report (image link)</a>
    <a href="/x.pdf">Report (text link)</a>
  `;
  const candidates = discoverFromHtml(html, 'https://example.org/');
  assert.equal(candidates.length, 1);
});

test('discoverFromHtml: skips a PDF link with only trivial/whitespace anchor text', () => {
  const html = `<a href="/x.pdf">  </a>`;
  assert.deepEqual(discoverFromHtml(html, 'https://example.org/'), []);
});

test('discoverFromHtml: resolves a relative href against the listing page URL', () => {
  const html = `<a href="../reports/x.pdf">A Report</a>`;
  const candidates = discoverFromHtml(html, 'https://example.org/research/commodity-markets');
  assert.equal(candidates[0].link, 'https://example.org/reports/x.pdf');
});
