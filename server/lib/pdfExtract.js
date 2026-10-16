const { PDFParse } = require('pdf-parse');
const { safeFetch } = require('./safeUrl');
const { readResponseBuffer } = require('./boundedResponse');

// Fetches a PDF as a raw buffer — separate from extraction so a fetch
// failure (network/404) and an extraction failure (corrupt/scanned PDF)
// are distinguishable errors for the caller to record separately.
async function fetchPdfBuffer(url, maxBytes = 25 * 1024 * 1024, timeoutMs = 30000) {
  const res = await safeFetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ResearchArchivingBot/1.0)' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`pdf fetch failed: ${res.status}`);
  return readResponseBuffer(res, maxBytes, 'PDF');
}

// PDF is a first-class material: text-based PDFs go through the normal AI
// pipeline like any other acquired text. No OCR/vision — a scanned/
// image-only PDF (no extractable text layer) throws a clear error instead
// of silently producing an empty/garbage summary, so the caller can record
// a clean failure state rather than corrupting or partially publishing it.
async function extractPdfText(buffer) {
  const parser = new PDFParse({ data: buffer });
  try {
    const result = await parser.getText();
    const text = (result.text || '').trim();
    if (!text) {
      throw new Error('PDF text extraction produced no text (likely a scanned/image-only PDF — OCR is out of scope for this milestone)');
    }
    return { text, pageCount: result.pages ? result.pages.length : (result.total || null) };
  } finally {
    await parser.destroy();
  }
}

// Per-page text (page numbers as printed in the PDF's own page index, 1-based) for page selection.
async function extractPdfPages(buffer) {
  const parser = new PDFParse({ data: buffer });
  try {
    const result = await parser.getText();
    return (result.pages || []).map((p, i) => ({ n: p.num || i + 1, text: p.text || '' }));
  } finally {
    await parser.destroy();
  }
}

module.exports = { fetchPdfBuffer, extractPdfText, extractPdfPages };
