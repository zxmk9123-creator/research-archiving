// loaded on first use: pdf-parse needs canvas globals (DOMMatrix) the moment it is imported, which would stop the whole app from
// booting wherever the optional canvas binary is missing (e.g. a serverless function) even though only PDF routes need it
const loadPdfParse = () => require('pdf-parse').PDFParse;
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
  if (!res.ok) { pdfOutcome('download_failed', String(res.status)); throw new Error(`pdf fetch failed: ${res.status}`); }
  return readResponseBuffer(res, maxBytes, 'PDF');
}

// PDF is a first-class material: text-based PDFs go through the normal AI
// pipeline like any other acquired text. No OCR/vision — a scanned/
// image-only PDF (no extractable text layer) throws a clear error instead
// of silently producing an empty/garbage summary, so the caller can record
// a clean failure state rather than corrupting or partially publishing it.
// Parse-stage failures get a stable prefix so they are told apart downstream (failureReason.js): a missing worker asset is a deployment
// problem, an invalid PDF is a bad document, anything else is a parser failure. Never silently treated as success.
const pdfOutcome = (outcome, note) => { try { require('./providerHealth').record('pdf', outcome, { note }); } catch (e) { /* metrics are best-effort */ } };

function describePdfError(err) {
  const m = String((err && err.message) || err);
  if (/^PDF (worker asset missing|invalid|parse failed|text extraction produced no text)/.test(m)) return err;
  let prefix = 'PDF parse failed';
  if (/pdf\.worker|Cannot find module|ERR_MODULE_NOT_FOUND|setting up fake worker|worker.*(fail|not found)/i.test(m)) prefix = 'PDF worker asset missing';
  else if (/Invalid PDF|InvalidPDF|Missing PDF|header not found|password|FormatError|XRef/i.test(m)) prefix = 'PDF invalid';
  const out = new Error(`${prefix}: ${m.slice(0, 200)}`);
  out.pdfStage = prefix === 'PDF worker asset missing' ? 'worker' : prefix === 'PDF invalid' ? 'invalid' : 'parse';
  pdfOutcome(out.pdfStage === 'worker' ? 'worker_missing' : out.pdfStage === 'invalid' ? 'invalid' : 'parse_failed', out.message);
  return out;
}

async function extractPdfText(buffer) {
  let parser;
  try { parser = new (loadPdfParse())({ data: buffer }); } catch (err) { throw describePdfError(err); }
  try {
    let result;
    try { result = await parser.getText(); } catch (err) { throw describePdfError(err); }
    const text = (result.text || '').trim();
    if (!text) {
      pdfOutcome('no_text', 'scanned/image-only');
      throw new Error('PDF text extraction produced no text (likely a scanned/image-only PDF — OCR is out of scope for this milestone)');
    }
    pdfOutcome('success');
    return { text, pageCount: result.pages ? result.pages.length : (result.total || null) };
  } finally {
    await parser.destroy();
  }
}

// Per-page text (page numbers as printed in the PDF's own page index, 1-based) for page selection.
async function extractPdfPages(buffer) {
  let parser;
  try { parser = new (loadPdfParse())({ data: buffer }); } catch (err) { throw describePdfError(err); }
  try {
    let result;
    try { result = await parser.getText(); } catch (err) { throw describePdfError(err); }
    return (result.pages || []).map((p, i) => ({ n: p.num || i + 1, text: p.text || '' }));
  } finally {
    await parser.destroy();
  }
}

module.exports = { fetchPdfBuffer, extractPdfText, extractPdfPages, describePdfError };
