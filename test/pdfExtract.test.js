// pdf-parse and the network are stubbed (before pdfExtract loads): this tests our handling, not the parser.
const test = require('node:test');
const assert = require('node:assert/strict');

let parserResult = { text: 'hello', pages: [{ num: 1, text: 'p1' }, { text: 'p2' }] };
let destroyed = 0;
require.cache[require.resolve('pdf-parse')] = { id: 'pdf-parse', filename: 'pdf-parse', loaded: true, exports: {
  PDFParse: class { constructor() {} async getText() { return parserResult; } async destroy() { destroyed += 1; } },
} };
const safeUrl = require('../server/lib/safeUrl');
let fetchReply = { ok: true, status: 200 };
safeUrl.safeFetch = async () => fetchReply;
const bounded = require('../server/lib/boundedResponse');
bounded.readResponseBuffer = async (res, max, label) => Buffer.from(`${label}:${max}`);
const { fetchPdfBuffer, extractPdfText, extractPdfPages } = require('../server/lib/pdfExtract');

test('extractPdfText: returns trimmed text and page count, and always destroys the parser', async () => {
  parserResult = { text: '  본문  ', pages: [{}, {}, {}] };
  destroyed = 0;
  assert.deepEqual(await extractPdfText(Buffer.from('x')), { text: '본문', pageCount: 3 });
  parserResult = { text: 'x', total: 7 };
  assert.equal((await extractPdfText(Buffer.from('x'))).pageCount, 7);
  assert.equal(destroyed, 2);
});

test('extractPdfText: a scanned/empty PDF is a clear error (not an empty summary) and the parser is still destroyed', async () => {
  parserResult = { text: '   ', pages: [] };
  destroyed = 0;
  await assert.rejects(() => extractPdfText(Buffer.from('x')), /no text/);
  assert.equal(destroyed, 1);
});

test('extractPdfPages: 1-based numbering falls back to the index; missing text becomes ""', async () => {
  parserResult = { pages: [{ num: 5, text: 'a' }, { text: 'b' }, {}] };
  assert.deepEqual(await extractPdfPages(Buffer.from('x')), [{ n: 5, text: 'a' }, { n: 2, text: 'b' }, { n: 3, text: '' }]);
  parserResult = {};
  assert.deepEqual(await extractPdfPages(Buffer.from('x')), []);
});

test('fetchPdfBuffer: a non-OK response is a fetch error; OK is read through the bounded reader with the 25 MB default', async () => {
  fetchReply = { ok: false, status: 404 };
  await assert.rejects(() => fetchPdfBuffer('https://x.example/a.pdf'), /pdf fetch failed: 404/);
  fetchReply = { ok: true, status: 200 };
  assert.equal((await fetchPdfBuffer('https://x.example/a.pdf')).toString(), `PDF:${25 * 1024 * 1024}`);
  assert.equal((await fetchPdfBuffer('https://x.example/a.pdf', 1000)).toString(), 'PDF:1000');
});
