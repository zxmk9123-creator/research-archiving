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
  const scored = pages.map((p) => ({ ...p, score: scorePage(p.text) })).filter((p) => p.score >= minScore).sort((a, b) => b.score - a.score).slice(0, max);
  return scored.sort((a, b) => a.n - b.n);
}

module.exports = { scorePage, selectPages };

// Extraction: only the selected pages' text goes to the model; every returned figure must literally
// occur on the page it cites, otherwise it is discarded.
const EXTRACTION_SYSTEM = `You extract operating facts of a plantation/palm-oil group from annual-report pages. Respond with ONLY a JSON array.
Each element: {"segment": "plantation"|"mill"|"refinery"|"oleochemical"|"kernel_crushing"|"group", "scope": "group"|"country"|"site", "location": string|null, "metric": string, "value": number, "unit": string, "fiscal_year": number|null, "page": number}
Rules: one element per distinct figure stated on a page; copy value and unit EXACTLY as printed (no conversion, no rounding); keep FFB, CPO, PK (palm kernel), planted area (mature/immature/total) and capacities (per hour/day/year) as DIFFERENT metrics; "fiscal_year" is the year the figure refers to (a 5-year table gives one element per year, or at least the latest year); "page" is the page number given in the [page N] header. Never invent a figure.`;

function verifyAgainstPages(records, pages) {
  const byN = new Map(pages.map((p) => [p.n, String(p.text).replace(/\s+/g, ' ')]));
  const kept = [];
  let dropped = 0;
  for (const r of records) {
    const text = byN.get(Number(r && r.page));
    const v = Number(r && r.value);
    if (!text || !(v > 0)) { dropped++; continue; }
    const forms = [v.toLocaleString('en-US'), String(v), v.toFixed(2), v.toFixed(1)];
    if (forms.some((f) => text.includes(f))) kept.push(r); else dropped++;
  }
  return { kept, dropped };
}

module.exports.EXTRACTION_SYSTEM = EXTRACTION_SYSTEM;
module.exports.verifyAgainstPages = verifyAgainstPages;
