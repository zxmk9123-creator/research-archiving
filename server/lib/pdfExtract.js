const { PDFParse } = require('pdf-parse');

// Fetches a PDF as a raw buffer — separate from extraction so a fetch
// failure (network/404) and an extraction failure (corrupt/scanned PDF)
// are distinguishable errors for the caller to record separately.
async function fetchPdfBuffer(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ResearchArchivingBot/1.0)' },
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`pdf fetch failed: ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
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

module.exports = { fetchPdfBuffer, extractPdfText };
