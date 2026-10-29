// Runs the REAL pdf-parse (no stubs) against a tiny generated PDF, so a missing worker asset or API break fails here, not in production.
const test = require('node:test');
const assert = require('node:assert/strict');
const { extractPdfText } = require('../server/lib/pdfExtract');

function tinyPdf(text) {
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 100] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    null,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  const stream = `BT /F1 12 Tf 20 50 Td (${text}) Tj ET`;
  objs[3] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  let out = '%PDF-1.4\n';
  const offsets = [];
  objs.forEach((o, i) => { offsets.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

test('real pdf-parse: extracts text from a valid PDF', async () => {
  const r = await extractPdfText(tinyPdf('Palm oil outlook'));
  assert.match(r.text, /Palm oil outlook/);
  assert.equal(r.pageCount, 1);
});

test('real pdf-parse: garbage bytes fail with a categorized PDF error, never an empty success', async () => {
  await assert.rejects(() => extractPdfText(Buffer.from('<html>not a pdf</html>')), /^Error: PDF (invalid|parse failed)|PDF (invalid|parse failed)/);
});
