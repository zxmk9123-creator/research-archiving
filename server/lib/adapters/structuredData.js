// Structured statistical/data-series adapter — parses the World Bank
// Commodity Markets "Pink Sheet" (CMO Historical Data, Monthly) XLSX and
// extracts the latest-vs-previous-month snapshot for the oil/fats-relevant
// series. Unlike institutionPdf.js (which discovers a document to later
// hand to a prose-oriented AI screen) this source IS the data — there is no
// separate discovery step, just download + parse the one known file.
//
// Uses exceljs rather than the more commonly reached-for 'xlsx' (SheetJS)
// package: the npm-published 'xlsx' has an unpatched high-severity
// prototype-pollution/ReDoS advisory with no fix available, which matters
// here specifically because this adapter parses an externally-fetched
// file — exactly the untrusted-input path those advisories are about.
const ExcelJS = require('exceljs');

const SHEET_NAME = 'Monthly Prices';
// 1-indexed row numbers (exceljs convention) — row 5 holds commodity
// names, row 6 holds units, data rows start at row 7. Fixed layout of the
// published Pink Sheet workbook, confirmed against the live file.
const HEADER_ROW_NUMBER = 5;
const UNITS_ROW_NUMBER = 6;
const DATA_START_ROW_NUMBER = 7;

// The sheet marks a missing monthly observation as a literal ellipsis
// string ("…" or "...") rather than leaving the cell blank.
const MISSING_VALUE_PATTERN = /^(\.{2,3}|…)$/;

// The minimal crude-oil + oils/fats series this platform's scope covers —
// matched by exact header text so a future column reorder in the source
// file fails loudly (column not found) instead of silently reading the
// wrong series.
const TRACKED_COMMODITIES = [
  { key: 'crude_oil', label: 'Crude oil, average' },
  { key: 'coconut_oil', label: 'Coconut oil' },
  { key: 'groundnut_oil', label: 'Groundnut oil **' },
  { key: 'palm_oil', label: 'Palm oil' },
  { key: 'soybean_oil', label: 'Soybean oil' },
  { key: 'sunflower_oil', label: 'Sunflower oil' },
];

function isMissing(value) {
  return value === null || value === undefined
    || (typeof value === 'string' && MISSING_VALUE_PATTERN.test(value.trim()));
}

// "2025M12" -> "2025-12"; null for anything else (title rows, blank rows).
function parsePeriod(raw) {
  const m = /^(\d{4})M(\d{2})$/.exec(String(raw ?? '').trim());
  return m ? `${m[1]}-${m[2]}` : null;
}

// exceljs Row#values is a sparse array with index 0 unused and index N
// holding column N's value (1-indexed, matching spreadsheet columns
// directly) — plain values here (no rich text/formula cells in this
// sheet), so no further unwrapping is needed.
function rowValues(sheet, rowNumber) {
  return sheet.getRow(rowNumber).values;
}

// Pure parsing/normalization apart from the exceljs load call — easy to
// unit-test with a synthetic workbook built the same way the real Pink
// Sheet is laid out.
async function parseWorkbook(buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const sheet = wb.getWorksheet(SHEET_NAME);
  if (!sheet) throw new Error(`sheet "${SHEET_NAME}" not found`);

  const headerRow = rowValues(sheet, HEADER_ROW_NUMBER);
  const unitsRow = rowValues(sheet, UNITS_ROW_NUMBER);
  if (!headerRow) throw new Error('header row not found');

  const columnIndex = {};
  for (const { key, label } of TRACKED_COMMODITIES) {
    const idx = headerRow.findIndex((h) => typeof h === 'string' && h.trim() === label);
    if (idx === -1) throw new Error(`column "${label}" not found in Monthly Prices header`);
    columnIndex[key] = idx;
  }

  const dataRows = [];
  for (let r = DATA_START_ROW_NUMBER; r <= sheet.rowCount; r++) {
    const values = rowValues(sheet, r);
    if (values && parsePeriod(values[1])) dataRows.push(values);
  }
  if (dataRows.length < 2) throw new Error('not enough monthly data rows to compare latest vs previous');

  const latestRow = dataRows[dataRows.length - 1];
  const previousRow = dataRows[dataRows.length - 2];
  const latestPeriod = parsePeriod(latestRow[1]);
  const previousPeriod = parsePeriod(previousRow[1]);

  const series = TRACKED_COMMODITIES.map(({ key, label }) => {
    const idx = columnIndex[key];
    const unit = (unitsRow && unitsRow[idx]) || '';
    const latestRaw = latestRow[idx];
    const previousRaw = previousRow[idx];
    const latest = isMissing(latestRaw) ? null : Number(latestRaw);
    const previous = isMissing(previousRaw) ? null : Number(previousRaw);
    const deltaPct = latest !== null && previous !== null && previous !== 0
      ? ((latest - previous) / previous) * 100
      : null;
    return { key, label, unit, latest, previous, deltaPct };
  });

  return { latestPeriod, previousPeriod, series };
}

async function fetchAndParse(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ResearchArchivingBot/1.0)' },
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`fetch failed: ${res.status}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  return parseWorkbook(buffer);
}

module.exports = { fetchAndParse, parseWorkbook, TRACKED_COMMODITIES };
