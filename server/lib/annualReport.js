// ANNUAL REPORT TRIAL: picks the few pages of a 200-400 page report that state capacity / output /
// planted-area figures, locally and without any AI call, so only those pages are sent to extraction.
const PAGE_TERMS = [
  [/\bplanted\s+area|hectares?|\bha\b/gi, 3], [/\bFFB\b|fresh fruit bunch/gi, 3], [/\bCPO\b|crude palm oil/gi, 2], [/\bPK\b|palm kernel/gi, 2],
  [/\bmills?\b|refiner(?:y|ies)|oleochemical|kernel crushing|crushing plant/gi, 2], [/capacity/gi, 2], [/tonnes?|\bMT\b|metric tonnes?/gi, 1],
  [/production|yield|OER|\bKER\b/gi, 1], [/statistics|operational review|plantation (?:review|statistics)|manufacturing/gi, 3],
];
// Pages whose HEADING names facilities/capacities are kept even when they are mostly graphics (few digits).
const HEADING = /(PRODUCTION FACILITIES|FACILITIES\s*&\s*CAPACIT|CAPACITIES|PLANTATION STATISTICS|\bPOMs?\b|FFB\s*mt\/hr|CPO\s*mt\/day|PK\s*mt\/day|REFINER(?:Y|IES)\s*&|OLEOCHEMICAL\s+(?:PLANTS?|FACILITIES))/g;
const NUMBER = /\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+\.\d+/g;

function scorePage(text) {
  let s = 0;
  for (const [re, w] of PAGE_TERMS) s += Math.min((String(text).match(re) || []).length, 12) * w;
  const nums = (String(text).match(NUMBER) || []).length;
  const headings = (String(text).match(HEADING) || []).length;
  return headings ? s + 25 * Math.min(headings, 4) : s * Math.min(1, nums / 40); // keyword-rich pages without a real table of figures score low
}

// Top `max` pages by score (plus each page's neighbour when it scores well, as tables continue), in page order.
function selectPages(pages, { max = 14, minScore = 25 } = {}) {
  const all = pages.map((p) => ({ ...p, score: scorePage(p.text) })).sort((a, b) => b.score - a.score);
  let scored = all.filter((p) => p.score >= minScore);
  // a report that states few figures (graphics-heavy, or a trading/refining group) still gets its best pages examined
  if (scored.length < 3) scored = all.filter((p) => p.score >= 5).slice(0, 8);
  return scored.slice(0, max).sort((a, b) => a.n - b.n);
}

module.exports = { scorePage, selectPages };

// Extraction: only the selected pages' text goes to the model; every returned figure must literally
// occur on the page it cites, otherwise it is discarded.
const EXTRACTION_SYSTEM = `You extract operating facts of a plantation/palm-oil group from annual-report pages. Respond with ONLY a JSON array.
Each element: {"segment": "plantation"|"mill"|"refinery"|"oleochemical"|"kernel_crushing"|"group", "scope": "group"|"country"|"site", "location": string|null, "metric": string, "value": number, "value_max": number|null, "unit": string, "fiscal_year": number|null, "definition": string|null, "page": number}
Rules: a RANGE printed as "20 to 120" or "20-120" is ONE element with value=20 and value_max=120 (never two elements); otherwise value_max is null. "definition" = the exact words on the page that define the figure's basis (for example "Weighted Average Hectarage", "as at 30 September 2025", "Mature", "Landbank"); two different area definitions of the same metric are different elements, each with its own definition; null only if the page gives none. One element per distinct figure stated on a page; copy value and unit EXACTLY as printed (no conversion, no rounding); keep FFB, CPO, PK (palm kernel), planted area (mature/immature/total) and capacities (per hour/day/year) as DIFFERENT metrics; "fiscal_year" is the year the figure refers to (a 5-year table gives one element per year, or at least the latest year); "page" is the page number given in the [page N] header. Never invent a figure.`;

// Pages grouped into batches of at most `maxChars`, so one extraction call never has to produce a huge answer.
function chunkPages(pages, maxChars = 9000) {
  const chunks = [];
  let cur = [];
  let size = 0;
  for (const p of pages) {
    if (cur.length && size + p.text.length > maxChars) { chunks.push(cur); cur = []; size = 0; }
    cur.push(p);
    size += p.text.length;
  }
  if (cur.length) chunks.push(cur);
  return chunks;
}

// JSON array of objects, tolerant of a truncated tail: every complete {...} element is kept.
function parseRecordsLoose(raw) {
  const text = String(raw || '').replace(/^```(?:json)?/i, '').replace(/```\s*$/, '');
  const start = text.indexOf('[');
  if (start < 0) return [];
  try { const whole = JSON.parse(text.slice(start, text.lastIndexOf(']') + 1)); if (Array.isArray(whole)) return whole; } catch (_) { /* salvage below */ }
  const out = [];
  let depth = 0;
  let objStart = -1;
  let inStr = false;
  for (let i = start + 1; i < text.length; i++) {
    const c = text[i];
    if (inStr) { if (c === '\\') i++; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === '{') { if (depth === 0) objStart = i; depth++; }
    else if (c === '}') { depth--; if (depth === 0 && objStart >= 0) { try { out.push(JSON.parse(text.slice(objStart, i + 1))); } catch (_) { /* skip */ } objStart = -1; } }
  }
  return out;
}

function verifyAgainstPages(records, pages) {
  const byN = new Map(pages.map((p) => [p.n, String(p.text).replace(/\s+/g, ' ')]));
  const kept = [];
  let dropped = 0;
  for (const r of records) {
    const text = byN.get(Number(r && r.page));
    const v = Number(r && r.value);
    if (!text || !(v > 0)) { dropped++; continue; }
    const forms = (x) => [Number(x).toLocaleString('en-US'), String(x), Number(x).toFixed(2), Number(x).toFixed(1)];
    const lower = text.toLowerCase();
    const has = (x) => forms(x).some((f) => text.includes(f));
    const max = Number(r.value_max);
    const rangeOk = !(max > 0) || (has(max) && max > v);
    // a definition the page does not literally contain is discarded (the figure itself may still be right)
    const definitionOk = !r.definition || lower.includes(String(r.definition).toLowerCase().replace(/\s+/g, ' ').trim());
    if (has(v) && rangeOk) kept.push(definitionOk ? r : { ...r, definition: null }); else dropped++;
  }
  return { kept, dropped };
}

// Area figures without an explicit definition inherit the basis their own page states
// ("Weighted Average Hectarage", or an "as at <date>" year-end basis) — decided from the page text, not by the model.
function fillAreaDefinitions(records, pages) {
  const byN = new Map(pages.map((p) => [p.n, String(p.text).replace(/\s+/g, ' ')]));
  return records.map((r) => {
    if (r.definition || !/^(ha|hectares?)$/i.test(String(r.unit || '').trim())) return r;
    const text = byN.get(Number(r.page)) || '';
    if (/weighted average hectarage/i.test(text)) return { ...r, definition: 'Weighted Average Hectarage' };
    const asAt = text.match(/as at \d{1,2} [A-Za-z]+ \d{4}/i);
    return asAt ? { ...r, definition: asAt[0] } : r;
  });
}

module.exports.fillAreaDefinitions = fillAreaDefinitions;
module.exports.chunkPages = chunkPages;
module.exports.parseRecordsLoose = parseRecordsLoose;
module.exports.EXTRACTION_SYSTEM = EXTRACTION_SYSTEM;
module.exports.verifyAgainstPages = verifyAgainstPages;
