const test = require('node:test');
const assert = require('node:assert/strict');
const ExcelJS = require('exceljs');
const { parseWorkbook, TRACKED_COMMODITIES } = require('../server/lib/adapters/structuredData');

// Builds a synthetic workbook laid out exactly like the real World Bank
// Pink Sheet "Monthly Prices" sheet: 4 title rows, a header row (commodity
// names), a units row, then monthly data rows — so parseWorkbook() is
// tested against the real structure without a network fetch.
async function buildWorkbook(dataRows) {
  const wb = new ExcelJS.Workbook();
  const sheet = wb.addWorksheet('Monthly Prices');
  sheet.addRow(['World Bank Commodity Price Data (The Pink Sheet)']);
  sheet.addRow(['monthly prices in nominal US dollars, 1960 to present']);
  sheet.addRow(['(monthly series are available only in nominal US dollars)']);
  sheet.addRow(['Updated on January 06, 2025']);
  sheet.addRow([
    null, 'Crude oil, average', 'Cocoa', 'Coconut oil', 'Groundnuts', 'Groundnut oil **',
    'Palm oil', 'Soybean oil', 'Rapeseed oil', 'Sunflower oil',
  ]);
  sheet.addRow([
    null, '($/bbl)', '($/kg)', '($/mt)', '($/mt)', '($/mt)',
    '($/mt)', '($/mt)', '($/mt)', '($/mt)',
  ]);
  for (const row of dataRows) sheet.addRow(row);
  const buffer = await wb.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

test('parseWorkbook: extracts the latest and previous month for every tracked commodity', async () => {
  const buffer = await buildWorkbook([
    ['2025M11', 62.3, 10.4, 2439.5, 1200, 1678.2, 983.4, 1128.4, 1878, 1256.5],
    ['2025M12', 60.9, 9.5, 2323.0, 1200, 1621.0, 980.5, 1119.4, 1854, 1258.9],
  ]);
  const { latestPeriod, previousPeriod, series } = await parseWorkbook(buffer);

  assert.equal(latestPeriod, '2025-12');
  assert.equal(previousPeriod, '2025-11');
  assert.equal(series.length, TRACKED_COMMODITIES.length);

  const crude = series.find((s) => s.key === 'crude_oil');
  assert.equal(crude.latest, 60.9);
  assert.equal(crude.previous, 62.3);
  assert.equal(crude.unit, '($/bbl)');
  assert.ok(Math.abs(crude.deltaPct - ((60.9 - 62.3) / 62.3) * 100) < 1e-9);

  const palm = series.find((s) => s.key === 'palm_oil');
  assert.equal(palm.latest, 980.5);
  assert.equal(palm.previous, 983.4);
});

test('parseWorkbook: only uses the last two data rows even with a long history', async () => {
  const rows = [];
  for (let i = 1; i <= 20; i++) {
    rows.push([`2024M${String(i).padStart(2, '0')}`, 50 + i, 9, 2000 + i, 1100, 1500, 900, 1000, 1700, 1200]);
  }
  rows.push(['2025M09', 58, 9, 2100, 1150, 1550, 950, 1050, 1750, 1250]);
  rows.push(['2025M10', 59, 9, 2150, 1160, 1560, 960, 1060, 1760, 1260]);
  const buffer = await buildWorkbook(rows);
  const { latestPeriod, previousPeriod } = await parseWorkbook(buffer);
  assert.equal(latestPeriod, '2025-10');
  assert.equal(previousPeriod, '2025-09');
});

test('parseWorkbook: an ellipsis missing-value marker becomes null, not NaN or a stray string', async () => {
  const buffer = await buildWorkbook([
    ['2025M11', 62.3, 10.4, '…', 1200, '...', 983.4, 1128.4, 1878, 1256.5],
    ['2025M12', 60.9, 9.5, '…', 1200, '...', 980.5, 1119.4, 1854, 1258.9],
  ]);
  const { series } = await parseWorkbook(buffer);
  const coconut = series.find((s) => s.key === 'coconut_oil');
  const groundnutOil = series.find((s) => s.key === 'groundnut_oil');
  assert.equal(coconut.latest, null);
  assert.equal(coconut.previous, null);
  assert.equal(coconut.deltaPct, null);
  assert.equal(groundnutOil.latest, null);
});

test('parseWorkbook: a missing previous-month value still reports the latest value, with deltaPct null', async () => {
  const buffer = await buildWorkbook([
    ['2025M11', 62.3, 10.4, '…', 1200, 1600, 983.4, 1128.4, 1878, 1256.5],
    ['2025M12', 60.9, 9.5, 2323.0, 1200, 1621.0, 980.5, 1119.4, 1854, 1258.9],
  ]);
  const { series } = await parseWorkbook(buffer);
  const coconut = series.find((s) => s.key === 'coconut_oil');
  assert.equal(coconut.latest, 2323.0);
  assert.equal(coconut.previous, null);
  assert.equal(coconut.deltaPct, null);
});

test('parseWorkbook: throws a clear error when the Monthly Prices sheet is missing', async () => {
  const wb = new ExcelJS.Workbook();
  wb.addWorksheet('Some Other Sheet');
  const buffer = Buffer.from(await wb.xlsx.writeBuffer());
  await assert.rejects(() => parseWorkbook(buffer), /Monthly Prices.*not found/);
});

test('parseWorkbook: throws a clear error when a tracked commodity column is missing from the header', async () => {
  const wb = new ExcelJS.Workbook();
  const sheet = wb.addWorksheet('Monthly Prices');
  sheet.addRow(['title']);
  sheet.addRow(['subtitle']);
  sheet.addRow(['note']);
  sheet.addRow(['updated']);
  sheet.addRow([null, 'Crude oil, average']); // missing every oils/fats column
  sheet.addRow([null, '($/bbl)']);
  sheet.addRow(['2025M11', 62.3]);
  sheet.addRow(['2025M12', 60.9]);
  const buffer = Buffer.from(await wb.xlsx.writeBuffer());
  // "Crude oil, average" is present, so the first missing tracked column
  // (checked in TRACKED_COMMODITIES order) is "Coconut oil".
  await assert.rejects(() => parseWorkbook(buffer), /Coconut oil.*not found/);
});

test('parseWorkbook: throws when fewer than two monthly data rows are present', async () => {
  const buffer = await buildWorkbook([
    ['2025M12', 60.9, 9.5, 2323.0, 1200, 1621.0, 980.5, 1119.4, 1854, 1258.9],
  ]);
  await assert.rejects(() => parseWorkbook(buffer), /not enough monthly data rows/);
});
