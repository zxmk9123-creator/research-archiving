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

test('extractMetadata reads a PDF response through the text layer', async () => {
  const safeUrl = require('../server/lib/safeUrl');
  const pdfExtract = require('../server/lib/pdfExtract');
  const origFetch = safeUrl.safeFetch;
  const origExtract = pdfExtract.extractPdfText;
  safeUrl.safeFetch = async () => new Response(Buffer.from('%PDF-1.4 x'), { headers: { 'content-type': 'application/pdf' } });
  pdfExtract.extractPdfText = async () => ({ text: 'Palm Oil Outlook 2026\nProduction rises in Indonesia this year.' });
  delete require.cache[require.resolve('../server/lib/extractMetadata')];
  try {
    const meta = await require('../server/lib/extractMetadata').extractMetadata('https://example.org/a.pdf');
    assert.strictEqual(meta.title, 'Palm Oil Outlook 2026');
    assert.match(meta.body_text, /Indonesia/);
  } finally { safeUrl.safeFetch = origFetch; pdfExtract.extractPdfText = origExtract; delete require.cache[require.resolve('../server/lib/extractMetadata')]; }
});

test('classifyFailure buckets common acquisition errors', () => {
  const { classifyFailure } = require('../server/lib/failureReason');
  assert.strictEqual(classifyFailure('fetch failed: 403'), 'blocked_403');
  assert.strictEqual(classifyFailure('fetch failed: 404'), 'not_found');
  assert.strictEqual(classifyFailure('bot-block interstitial detected: "x"'), 'bot_block');
  assert.strictEqual(classifyFailure('The operation was aborted due to timeout'), 'timeout');
  assert.strictEqual(classifyFailure('PDF text extraction produced no text'), 'pdf_unreadable');
  assert.strictEqual(classifyFailure('weird'), 'other');
});
