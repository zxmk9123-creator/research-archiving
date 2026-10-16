const test = require('node:test');
const assert = require('node:assert/strict');
const ar = require('../server/lib/annualReport');

test('selectPages keeps a facilities/capacity page and a statistics table, skips prose', () => {
  const stats = { n: 36, text: '5-YEAR PLANTATION STATISTICS FFB Production (mt) 5,616,809 5,473,196 5,253,723 Total planted area (ha) 293,427 291,353 286,208 CPO PK mill' };
  const cap = { n: 31, text: 'PRODUCTION FACILITIES & CAPACITIES Palm Oil Mills 34 POMs 20 to 120 FFB mt/hr 7,700 CPO mt/day' };
  const prose = { n: 5, text: 'Chairman statement about governance and community programmes. '.repeat(20) };
  assert.deepEqual(ar.selectPages([prose, cap, stats]).map((p) => p.n), [31, 36]);
});

test('verifyAgainstPages drops figures that are not printed on the cited page', () => {
  const pages = [{ n: 36, text: 'FFB Production 5,616,809 mt Total planted area 293,427 ha' }];
  const { kept, dropped } = ar.verifyAgainstPages([
    { page: 36, value: 5616809, unit: 'mt' }, { page: 36, value: 293427, unit: 'ha' }, { page: 36, value: 561681, unit: 'mt' }, { page: 7, value: 293427, unit: 'ha' },
  ], pages);
  assert.equal(kept.length, 2);
  assert.equal(dropped, 2);
});

test('verifyAgainstPages: ranges need both ends on the page; unverified definition is dropped, figure kept', () => {
  const pages = [{ n: 31, text: 'Palm Oil Mills 34 POMs From 20 to 120 FFB mt/hr Weighted Average Hectarage Total planted area 293,427 ha' }];
  const { kept } = ar.verifyAgainstPages([
    { page: 31, value: 20, value_max: 120, unit: 'FFB mt/hr', definition: null },
    { page: 31, value: 20, value_max: 999, unit: 'FFB mt/hr' },
    { page: 31, value: 293427, unit: 'ha', definition: 'Weighted Average Hectarage' },
    { page: 31, value: 293427, unit: 'ha', definition: 'Made up basis' },
  ], pages);
  assert.equal(kept.length, 3);
  assert.equal(kept[1].definition, 'Weighted Average Hectarage');
  assert.equal(kept[2].definition, null);
});

test('buildReportText states ranges, definitions and pages', () => {
  const { buildReportText } = require('../server/lib/annualReportIngest');
  const t = buildReportText('KLK', 2025, [
    { segment: 'mill', metric: 'capacity', value: 20, value_max: 120, unit: 'FFB mt/hr', page: 31 },
    { segment: 'plantation', metric: 'total planted area', value: 293427, unit: 'ha', definition: 'Weighted Average Hectarage', page: 36 },
  ], 'https://x/ar.pdf');
  assert.match(t, /20~120 FFB mt\/hr/);
  assert.match(t, /293,427 ha \(기준: Weighted Average Hectarage\) — 보고서 p\.36/);
});

test('fillAreaDefinitions: area without a definition inherits its page basis; other units untouched', () => {
  const pages = [{ n: 36, text: 'Weighted Average Hectarage - Mature (ha) 265,983' }, { n: 30, text: 'Planted area as at 30 September 2025 301,090 hectares' }];
  const out = ar.fillAreaDefinitions([
    { page: 36, unit: 'ha', metric: 'total planted area' },
    { page: 30, unit: 'hectares', metric: 'planted area' },
    { page: 36, unit: 'mt', metric: 'FFB' },
    { page: 36, unit: 'ha', definition: 'Mature' },
  ], pages);
  assert.equal(out[0].definition, 'Weighted Average Hectarage');
  assert.equal(out[1].definition, 'as at 30 September 2025');
  assert.equal(out[2].definition, undefined);
  assert.equal(out[3].definition, 'Mature');
});

test('cleanUrl drops tracking params and converts Google Drive view links', () => {
  const { cleanUrl } = require('../server/lib/annualReportIngest');
  assert.equal(cleanUrl('https://a.com/x.pdf?utm_source=chatgpt.com'), 'https://a.com/x.pdf');
  assert.equal(cleanUrl('https://a.com/?wpfb_dl=291&utm_source=chatgpt.com'), 'https://a.com/?wpfb_dl=291');
  assert.equal(cleanUrl('https://drive.google.com/file/d/ABC123/view?utm_source=chatgpt.com'), 'https://drive.google.com/uc?export=download&id=ABC123');
});

test('chunkPages batches pages; parseRecordsLoose keeps complete objects of a truncated array', () => {
  const pages = [{ n: 1, text: 'a'.repeat(6000) }, { n: 2, text: 'b'.repeat(6000) }, { n: 3, text: 'c'.repeat(100) }];
  assert.deepEqual(ar.chunkPages(pages, 9000).map((c) => c.map((p) => p.n)), [[1], [2, 3]]);
  const recs = ar.parseRecordsLoose('```json\n[{"metric":"a","value":1},{"metric":"b, {x}","value":2},{"metric":"c","val');
  assert.deepEqual(recs.map((r) => r.metric), ['a', 'b, {x}']);
  assert.equal(ar.parseRecordsLoose('no json').length, 0);
});

test('selectPages relaxes the threshold when a report states few figures', () => {
  const mk = (n) => ({ n, text: `mills refinery capacity ha tonnes ${'1,000 '.repeat(40)}` });
  const sel = ar.selectPages([mk(1), mk(2), { n: 3, text: 'nothing relevant' }]);
  assert.ok(sel.length >= 1 && sel.every((p) => p.score >= 5));
});
