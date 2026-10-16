// STRUCTURED DATASET PIPELINE for quantitative visualization requests
// ("글로벌 SAF 플랜트 Capa를 톤 단위로 … 그래프"). Free-form generation kept
// failing the same ways — items dropped because their unit differed, mixed
// units in one column, a total double-counted next to its parts, a figure
// with a lost zero. So for these requests the numbers never come from the
// writing model:
//   1) an EXTRACTION call turns the materials into records
//      {entity, site, value, unit, period, status, year, source};
//   2) every record is VERIFIED in code: its figure must literally exist in the
//      cited material (unit-aware), and is then CONVERTED to tons exactly
//      (stated factors) — nothing unverifiable survives;
//   3) the table and the chart are BUILT in code from the verified records, one
//      unit, every entity, parts of one company stacked, totals never summed
//      with their parts;
//   4) the writing model only comments on that dataset.
const nc = require('./numberCheck');

const CAPACITY_WORDS = /(capa|capacity|생산\s*능력|생산능력|용량|생산량|설비\s*규모|처리\s*능력)/i;
const STATUS_RANK = { 가동: 3, 건설중: 2, 계획: 1, 목표: 0 };

function isDatasetRequest(req, question) {
  return Boolean(req && req.wantsChart && CAPACITY_WORDS.test(String(question || '')));
}

const EXTRACTION_SYSTEM = `You extract a structured dataset from supplied materials. Respond with ONLY a JSON array — no prose, no code fences.
Each element: {"entity": string, "site": string|null, "value": number, "unit": string, "period": "연간"|"일일"|null, "status": "가동"|"건설중"|"계획"|"목표", "year": number|null, "source": number}
Rules:
- One element per distinct capacity figure that a material STATES for a company's plant/site (or for the company as a whole when no site is given, site=null). Cover EVERY company and EVERY plant the materials give a figure for; do not skip an item because its unit is gallons, barrels or b/d.
- "value" and "unit" must reproduce the material's own figure exactly as written, splitting number from unit: "50만 톤" -> value 50, unit "만 톤"; "1.2 Mt/a" -> value 1.2, unit "Mt"; "340 million gallons" -> value 340, unit "million gallons"; "22,000 b/d" -> value 22000, unit "b/d"; "2만 5,000톤" -> value 25000, unit "톤". Never convert, round or rescale. Never invent a figure.
- "source" is the 자료 number the figure comes from. "status": 가동 (operating/current), 건설중 (under construction), 계획 (planned/expected), 목표 (corporate-wide target). "year": the year the status/figure refers to, if stated.
- "entity" is the company (e.g. "Neste", "Eni", "Chevron"); "site" the plant/location (e.g. "로테르담", "Geismar") or null.
- Capacity means production/processing capacity of fuel (SAF, renewable diesel/fuel, biorefinery throughput as stated). Skip prices, investment amounts and sales volumes.`;

function buildExtractionUser(question, materialsBlock) {
  return `[Question]\n${question}\n\n[Materials]\n${materialsBlock}`;
}

function parseRecords(raw) {
  const text = String(raw || '').replace(/^```(?:json)?/i, '').replace(/```$/, '');
  const a = text.indexOf('[');
  const b = text.lastIndexOf(']');
  if (a < 0 || b <= a) return [];
  try {
    const arr = JSON.parse(text.slice(a, b + 1));
    return Array.isArray(arr) ? arr : [];
  } catch (_) {
    return [];
  }
}

const fmtTons = (t) => Math.round(t).toLocaleString('en-US');
const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();

// Verifies each record against its cited material and converts it to tons/year.
function verifyRecords(records, candidates, materialText) {
  const out = [];
  const seen = new Set();
  for (const r of records) {
    const source = Number(r && r.source);
    const value = Number(r && r.value);
    const unit = clean(r && r.unit);
    const entity = clean(r && r.entity);
    if (!entity || !unit || !(value > 0) || !Number.isInteger(source) || source < 1 || source > candidates.length) continue;
    const q = nc.extractQuantities(`${value} ${unit}`)[0];
    if (!q) continue;
    let cls = q.cls;
    if (cls === 'bbl' && /일일|daily|per day|\/d/i.test(`${r.period || ''} ${unit}`)) cls = 'bpd';
    const direct = nc.extractQuantities(materialText(candidates[source - 1])).filter((m) => m.cls === q.cls);
    // the figure must literally exist in the cited material (same class, within 1.5%)
    if (!direct.some((m) => Math.abs(m.value - q.value) <= Math.max(m.value, q.value) * 0.015)) continue;
    let tons;
    let basis;
    if (cls === 'mass') { tons = q.value; basis = '직접(톤)'; }
    else if (cls === 'bpd') { tons = nc.toTons(q.value, 'bpd'); basis = '환산(b/d×365)'; }
    else if (cls === 'gal' || cls === 'bbl' || cls === 'liter') {
      tons = nc.toTons(q.value, cls);
      basis = `환산(${cls === 'gal' ? '갤런' : cls === 'bbl' ? '배럴' : '리터'})`;
    } else continue;
    if (!(tons > 0)) continue;
    const status = Object.prototype.hasOwnProperty.call(STATUS_RANK, r.status) ? r.status : '목표';
    const site = clean(r.site) || null;
    const year = Number.isInteger(Number(r.year)) && Number(r.year) > 1990 && Number(r.year) < 2100 ? Number(r.year) : null;
    const key = `${entity.toLowerCase()}|${(site || '').toLowerCase()}|${status}|${Math.round(tons)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ entity, site, status, year, source, tons, basis, original: `${Number(r.value).toLocaleString('en-US')} ${unit}${r.period === '일일' && cls !== 'bpd' ? '/일' : ''}`.trim() });
  }
  return out;
}

// One chart row per (entity, site): the latest-year record wins (an expansion
// supersedes the older figure); totals (site=null) are kept out of the stacked
// bars when the same entity has site rows, so a total is never summed with its parts.
function chartRows(records) {
  const bySite = new Map();
  for (const r of records) {
    if (r.status === '목표' && !r.site) continue;
    const key = `${r.entity.toLowerCase()}|${(r.site || '').toLowerCase()}`;
    const cur = bySite.get(key);
    const rank = (x) => [x.year || 0, STATUS_RANK[x.status], x.tons];
    if (!cur || rank(r) > rank(cur)) bySite.set(key, r);
  }
  let rows = [...bySite.values()];
  const entitiesWithSites = new Set(rows.filter((r) => r.site).map((r) => r.entity.toLowerCase()));
  rows = rows.filter((r) => r.site || !entitiesWithSites.has(r.entity.toLowerCase()));
  return rows.sort((a, b) => b.tons - a.tons).slice(0, 30);
}

// requiredNames: roster companies that have supplied materials; any without a record gets an explicit "미공시" row.
function buildDataset(records, requiredNames = []) {
  if (records.length < 3) return null;
  const sorted = records.slice().sort((a, b) => a.entity.localeCompare(b.entity) || (a.site || '').localeCompare(b.site || '') || (b.year || 0) - (a.year || 0));
  const have = new Set(records.map((r) => r.entity.toLowerCase()));
  const lines = [
    '| 업체 | 거점 | 구분 | CAPA (톤/년) | 원문 표기 | 출처 |',
    '| --- | --- | --- | --- | --- | --- |',
    ...sorted.map((r) => `| ${r.entity} | ${r.site || '-'} | ${r.status}${r.year ? ` (${r.year})` : ''} | ${fmtTons(r.tons)} | ${r.original}${r.basis.startsWith('환산') ? ` → ${r.basis}` : ''} | [${r.source}] |`),
  ];
  for (const name of requiredNames) {
    const key = name.name.toLowerCase();
    if ([...have].some((h) => h.includes(key) || key.includes(h) || name.names.some((n) => h.includes(n)))) continue;
    lines.push(`| ${name.name} | - | 미공시 | - | 자료에 CAPA 수치 없음 | [${name.indices[0]}] |`);
  }
  const rows = chartRows(records);
  const chart = {
    type: 'hbar',
    auto: 'dataset',
    title: '업체·거점별 SAF/재생연료 생산능력 (톤/년, 환산 포함)',
    unit: '톤',
    combine: 'sum',
    labels: rows.map((r) => `${r.entity}${r.site ? ` ${r.site}` : ''}${r.status !== '가동' ? ` (${r.status})` : ''}`),
    groups: rows.map((r) => r.entity),
    notes: rows.map((r) => `${r.status}${r.year ? ` ${r.year}` : ''} · 원문 ${r.original}${r.basis.startsWith('환산') ? ` → ${r.basis}` : ''}`),
    series: [{ name: 'CAPA (톤/년)', data: rows.map((r) => Math.round(r.tons)) }],
  };
  const converted = records.some((r) => r.basis.startsWith('환산'));
  const note = converted ? `\n\n환산 기준: 갤런·배럴·리터는 SAF/재생연료 밀도 0.8 kg/L 가정(1갤런 ≈ 0.003028톤, 1배럴 ≈ 0.1272톤), b/d는 ×365일 연환산(가동률 100% 가정). 같은 거점은 가장 최근 연도 값을 막대에 사용했고, 표에는 모든 값을 기재했습니다.` : '\n\n같은 거점은 가장 최근 연도 값을 막대에 사용했고, 표에는 모든 값을 기재했습니다.';
  return { table: lines.join('\n'), chart, markdown: `${lines.join('\n')}\n\n\`\`\`chart\n${JSON.stringify(chart)}\n\`\`\`${note}`, records: sorted.length };
}

module.exports = { isDatasetRequest, EXTRACTION_SYSTEM, buildExtractionUser, parseRecords, verifyRecords, buildDataset, chartRows, CAPACITY_WORDS };
