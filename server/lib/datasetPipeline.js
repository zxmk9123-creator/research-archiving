// STRUCTURED DATASET PIPELINE for quantity-comparison requests (any product, any
// industry segment): "<대상들>의 생산능력/생산량/물량/투자액 … 그래프·표로". Free-form
// generation kept failing the same ways — items dropped because their unit differed,
// mixed units in one column, a total double-counted next to its parts, a figure with a
// lost zero. So for these requests the numbers never come from the writing model:
//   1) an EXTRACTION call turns the materials into records
//      {entity, site, metric, value, unit, period, status, year, source};
//   2) every record is VERIFIED in code: its figure must literally exist in the cited
//      material (unit-aware), and is then CONVERTED exactly into one unit;
//   3) the table and the chart are BUILT in code from the verified records: one unit,
//      every entity, parts of one entity stacked, totals never summed with their parts;
//   4) the writing model's own table/chart are replaced by these.
// Units: mass (톤), volume (리터), and money (달러/유로/원) are handled as separate
// groups; volume becomes mass ONLY when the product's density is known (fuels and edible
// oils are recognised; otherwise volumes stay in volume and are never guessed into tons).
const nc = require('./numberCheck');

const METRIC_WORDS = /(capa|capacity|생산\s*능력|용량|생산량|생산\s*규모|처리량|공급량|출하|물량|수출량|수입량|판매량|소비량|재고|투자액|투자\s*규모|투자금|매출|시장\s*규모|규모)/i;
const STATUS_RANK = { 가동: 3, 건설중: 2, 계획: 1, 목표: 0 };
// One state vocabulary on screen (the same words the chart labels use): 현재 / 건설중 / 계획 / 목표.
const STATUS_LABEL = { 가동: '현재', 건설중: '건설중', 계획: '계획', 목표: '목표' };
const GROUP_OF = { mass: 'mass', gal: 'volume', bbl: 'volume', liter: 'volume', bpd: 'volume', usd: 'usd', eur: 'eur', krw: 'krw' };
const GROUP_LABEL = { mass: '톤', volume: '리터', usd: '달러', eur: '유로', krw: '원' };
const GROUP_PRIORITY = ['mass', 'volume', 'usd', 'eur', 'krw'];
const LITERS = { gal: 3.785411784, bbl: 158.987, liter: 1, bpd: 158.987 * 365 }; // per unit, per year for b/d

const FUEL_WORDS = /(saf|항공유|jet fuel|디젤|diesel|hvo|바이오디젤|biodiesel|재생\s*연료|renewable (?:diesel|fuel)|biofuel|바이오\s*연료|바이오에탄올|ethanol)/gi;
const OIL_WORDS = /(팜유|대두유|유채|해바라기|식용유|palm oil|soybean oil|rapeseed|canola|sunflower|vegetable oil|cooking oil)/gi;
// kg per litre of the product the question/materials are about; null = unknown (no volume->mass guess)
function productDensity(text) {
  const t = String(text || '');
  const fuel = (t.match(FUEL_WORDS) || []).length;
  const oil = (t.match(OIL_WORDS) || []).length;
  if (!fuel && !oil) return null;
  return fuel >= oil ? 0.8 : 0.92;
}

// Stored facts (item_facts) -> the records of THIS question: only the kind of quantity it
// asks about (capacity vs output volume vs money), tons filled in from the product density.
const MONEY_Q = /(투자|매출|금액|자금|인수|예산|capex|달러|유로)/i;
const CAP_Q = /(capa|capacity|생산\s*능력|용량|처리\s*능력|설비)/i;
const OUT_Q = /(생산량|출하|물량|판매|수출|수입|소비|재고|공급량)/i;
const CAP_METRIC = /(능력|capa|capacity|용량|처리)/i;
const OUT_METRIC = /(생산량|출하|판매|수출|수입|소비|재고|물량|공급)/i;
const MONEY_METRIC = /(투자|매출|금액|자금|인수|예산|capex)/i;
function recordsForQuestion(records, question, density = null) {
  const q = String(question || '');
  const wantsMoney = MONEY_Q.test(q);
  const wantsCap = CAP_Q.test(q);
  const wantsOut = OUT_Q.test(q);
  return records
    .filter((r) => {
      const isMoney = r.group === 'usd' || r.group === 'eur' || r.group === 'krw';
      if (isMoney) return wantsMoney;
      if (wantsMoney && !wantsCap && !wantsOut) return false; // a money question: quantities of goods are out
      const m = r.metric || '';
      if (m && wantsCap && !wantsOut && !CAP_METRIC.test(m) && (OUT_METRIC.test(m) || MONEY_METRIC.test(m))) return false;
      if (m && wantsOut && !wantsCap && !OUT_METRIC.test(m) && (CAP_METRIC.test(m) || MONEY_METRIC.test(m))) return false;
      return true;
    })
    .map((r) => ({ ...r, tons: r.group === 'mass' ? r.amount : r.group === 'volume' && density ? (r.amount * density) / 1000 : null }));
}

function isDatasetRequest(req, question) {
  return Boolean(req && (req.wantsChart || req.wantsTable) && METRIC_WORDS.test(String(question || '')));
}

const EXTRACTION_SYSTEM = `You extract a structured dataset from supplied materials. Respond with ONLY a JSON array — no prose, no code fences.
Each element: {"entity": string, "site": string|null, "metric": string, "value": number, "unit": string, "period": "연간"|"일일"|null, "status": "가동"|"건설중"|"계획"|"목표", "year": number|null, "source": number}
Rules:
- Extract the quantity the QUESTION asks about (for example production capacity, output volume, shipments, trade volume, investment amount). One element per distinct figure that a material STATES for an entity's plant/site/segment (or for the entity as a whole when no site is given, site=null). Cover EVERY entity and EVERY site the materials give a figure for; never skip an item because of its unit (gallons, barrels, b/d, currency are all fine).
- "metric" is a short Korean label of the quantity (e.g. "생산능력", "생산량", "투자액").
- "value" and "unit" must reproduce the material's own figure exactly as written, splitting number from unit: "50만 톤" -> value 50, unit "만 톤"; "1.2 Mt/a" -> value 1.2, unit "Mt"; "340 million gallons" -> value 340, unit "million gallons"; "22,000 b/d" -> value 22000, unit "b/d"; "2만 5,000톤" -> value 25000, unit "톤". Never convert, round or rescale. Never invent a figure. Skip prices per unit (e.g. $/톤) and percentages.
- "source" is the 자료 number the figure comes from. "status": 가동 (operating/current), 건설중 (under construction), 계획 (planned/expected), 목표 (entity-wide target). "year": the year the status/figure refers to, if stated.
- "entity" is the company/country/organisation the figure belongs to; "site" the plant/location/segment or null.`;

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

const fmtNum = (n) => Math.round(n).toLocaleString('en-US');
const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();

// Verifies each record against its cited material; keeps the figure in its own group's
// base unit (tons / litres / currency units) plus a tons value when the density allows.
function verifyRecords(records, candidates, materialText, { density = null } = {}) {
  const out = [];
  const seen = new Set();
  for (const r of records) {
    const source = Number(r && r.source);
    const value = Number(r && r.value);
    const unit = clean(r && r.unit);
    const entity = clean(r && r.entity);
    if (!entity || !unit || !(value > 0) || !Number.isInteger(source) || source < 1 || source > candidates.length) continue;
    if (/\/\s*(톤|t\b|kg|ton|bbl|배럴|gal|갤런|MT|mt|리터|l\b)/i.test(unit)) continue; // a price per unit, not a quantity
    const q = nc.extractQuantities(`${value} ${unit}`)[0];
    if (!q) continue;
    let cls = q.cls;
    if (cls === 'bbl' && /일일|daily|per day|\/d/i.test(`${r.period || ''} ${unit}`)) cls = 'bpd';
    const group = GROUP_OF[cls];
    if (!group) continue;
    const direct = nc.extractQuantities(materialText(candidates[source - 1])).filter((m) => m.cls === q.cls);
    // the figure must literally exist in the cited material (same class, within 1.5%)
    if (!direct.some((m) => Math.abs(m.value - q.value) <= Math.max(m.value, q.value) * 0.015)) continue;
    // a rate stated per day/month is annualised so every figure is "per year"; per-hour or
    // other rates cannot be placed on the same footing and are skipped
    const periodText = `${r.period || ''} ${unit}`;
    let annual = 1;
    let annualNote = '';
    if (/\/\s*(?:일|day|d)(?![A-Za-z가-힣])|일일|daily|per day/i.test(periodText) && cls !== 'bpd') { annual = 365; annualNote = '일→연 ×365'; }
    else if (/\/\s*(?:월|month)|월간|monthly/i.test(periodText)) { annual = 12; annualNote = '월→연 ×12'; }
    else if (/\/\s*(?:시간|hour|h|분|min|초|sec)(?![A-Za-z가-힣])/i.test(periodText)) continue;
    let amount = q.value * annual; // in the group's base unit
    let basis = annualNote ? `환산(${annualNote})` : '직접';
    if (group === 'volume') {
      const perUnit = cls === 'gal' ? LITERS.gal : cls === 'bbl' ? LITERS.bbl : cls === 'bpd' ? LITERS.bpd : 1;
      amount = q.value * annual * perUnit;
      if (cls !== 'liter') basis = `환산(${cls === 'gal' ? '갤런' : cls === 'bbl' ? '배럴' : 'b/d×365'}→리터${annualNote ? `, ${annualNote}` : ''})`;
    }
    if (!(amount > 0)) continue;
    const status = Object.prototype.hasOwnProperty.call(STATUS_RANK, r.status) ? r.status : '목표';
    const site = clean(r.site) || null;
    const year = Number.isInteger(Number(r.year)) && Number(r.year) > 1990 && Number(r.year) < 2100 ? Number(r.year) : null;
    const key = `${entity.toLowerCase()}|${(site || '').toLowerCase()}|${status}|${group}|${Math.round(amount)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      entity, site, status, year, source, group, amount, basis, metric: clean(r.metric) || null,
      tons: group === 'mass' ? amount : group === 'volume' && density ? (amount * density) / 1000 : null,
      original: `${Number(r.value).toLocaleString('en-US')} ${unit}${r.period === '일일' && cls !== 'bpd' ? '/일' : ''}`.trim(),
    });
  }
  return out;
}

// Which group the chart is drawn in, and each record's value in it (null = not chartable).
function chartBasis(records, { unitTons = false, density = null } = {}) {
  const hasDensity = Boolean(density);
  const valueIn = (r, group) => {
    if (group === 'mass') return r.group === 'mass' ? r.amount : r.tons;
    return r.group === group ? r.amount : null;
  };
  let group;
  if (unitTons && (hasDensity || records.some((r) => r.group === 'mass'))) group = 'mass';
  else {
    const counts = Object.fromEntries(GROUP_PRIORITY.map((g) => [g, records.filter((r) => valueIn(r, g) !== null).length]));
    group = GROUP_PRIORITY.slice().sort((a, b) => counts[b] - counts[a] || GROUP_PRIORITY.indexOf(a) - GROUP_PRIORITY.indexOf(b))[0];
  }
  return { group, valueIn: (r) => valueIn(r, group) };
}

// One chart row per (entity, site): the latest-year record wins (an expansion
// supersedes the older figure); entity-wide totals (site=null) are kept out of the stacked
// bars when the same entity has site rows, so a total is never summed with its parts.
function chartRows(records, valueOf = (r) => r.amount) {
  const bySite = new Map();
  for (const r of records) {
    if (valueOf(r) === null || valueOf(r) === undefined) continue;
    if (r.status === '목표' && !r.site) continue;
    const key = `${r.entity.toLowerCase()}|${(r.site || '').toLowerCase()}`;
    const cur = bySite.get(key);
    const rank = (x) => [x.year || 0, STATUS_RANK[x.status], valueOf(x)];
    if (!cur || rank(r) > rank(cur)) bySite.set(key, r);
  }
  let rows = [...bySite.values()];
  const entitiesWithSites = new Set(rows.filter((r) => r.site).map((r) => r.entity.toLowerCase()));
  rows = rows.filter((r) => r.site || !entitiesWithSites.has(r.entity.toLowerCase()));
  return rows.sort((a, b) => valueOf(b) - valueOf(a)).slice(0, 30);
}

// requiredNames: roster entities that have supplied materials; any without a record gets an explicit "미공시" row.
function buildDataset(records, requiredNames = [], { unitTons = false, density = null } = {}) {
  if (records.length < 3) return null;
  const basis = chartBasis(records, { unitTons, density });
  const unitLabel = GROUP_LABEL[basis.group];
  const valueOf = basis.valueIn;
  const sorted = records.slice().sort((a, b) => a.entity.localeCompare(b.entity) || (a.site || '').localeCompare(b.site || '') || (b.year || 0) - (a.year || 0));
  const have = new Set(records.map((r) => r.entity.toLowerCase()));
  const cellOf = (r) => {
    const v = valueOf(r);
    return v === null || v === undefined ? '- (다른 단위 · 원문 참조)' : fmtNum(v);
  };
  const lines = [
    `| 대상 | 거점·구분 | 상태 | 수치 (${unitLabel}) | 원문 표기 | 출처 |`,
    '| --- | --- | --- | --- | --- | --- |',
    ...sorted.map((r) => `| ${r.entity} | ${r.site || '-'} | ${STATUS_LABEL[r.status]}${r.year ? ` (${r.year})` : ''} | ${cellOf(r)} | ${r.original}${r.basis !== '직접' ? ` → ${r.basis}` : ''} | [${r.source}] |`),
  ];
  for (const name of requiredNames) {
    const key = name.name.toLowerCase();
    if ([...have].some((h) => h.includes(key) || key.includes(h) || name.names.some((n) => h.includes(n)))) continue;
    lines.push(`| ${name.name} | - | 미공시 | - | 자료에 수치 없음 | [${name.indices[0]}] |`);
  }
  const rows = chartRows(records, valueOf);
  if (!rows.length) return null;
  const metric = (() => {
    const counts = new Map();
    for (const r of records) if (r.metric) counts.set(r.metric, (counts.get(r.metric) || 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || '수치';
  })();
  const chart = {
    type: 'hbar',
    auto: 'dataset',
    title: `대상·거점별 ${metric} (${unitLabel}${records.some((r) => r.basis !== '직접') ? ', 환산 포함' : ''})`,
    unit: unitLabel,
    combine: 'sum',
    labels: rows.map((r) => `${r.entity}${r.site ? ` ${r.site}` : ''}${r.status !== '가동' ? ` (${STATUS_LABEL[r.status]})` : ''}`),
    groups: rows.map((r) => r.entity),
    notes: rows.map((r) => `${STATUS_LABEL[r.status]}${r.year ? ` ${r.year}` : ''} · 원문 ${r.original}${r.basis !== '직접' ? ` → ${r.basis}` : ''}`),
    series: [{ name: `${metric} (${unitLabel})`, data: rows.map((r) => Math.round(valueOf(r))) }],
  };
  const notes = [];
  const toMass = basis.group === 'mass' && records.some((r) => r.group === 'volume' && r.tons !== null);
  if (records.some((r) => r.basis !== '직접')) notes.push('부피 단위는 갤런 3.785리터, 배럴 158.987리터, b/d는 ×365일 연환산(가동률 100% 가정)으로 리터로 바꿨습니다.');
  if (toMass) notes.push(`리터를 톤으로 바꿀 때는 제품 밀도 ${density} kg/L를 가정했습니다.`);
  const excluded = records.filter((r) => valueOf(r) === null || valueOf(r) === undefined).length;
  if (excluded) notes.push(`다른 단위의 ${excluded}건은 차트에서 제외했고 표에 원문 표기로 남겼습니다${basis.group === 'mass' && !density ? ' (제품 밀도를 알 수 없어 톤으로 환산하지 않음)' : ''}.`);
  notes.push('같은 거점은 가장 최근 연도 값을 막대에 사용했고, 표에는 모든 값을 기재했습니다.');
  return { table: lines.join('\n'), chart, markdown: `${lines.join('\n')}\n\n\`\`\`chart\n${JSON.stringify(chart)}\n\`\`\`\n\n${notes.join(' ')}`, records: sorted.length };
}

module.exports = { recordsForQuestion, isDatasetRequest, productDensity, EXTRACTION_SYSTEM, buildExtractionUser, parseRecords, verifyRecords, buildDataset, chartRows, chartBasis, METRIC_WORDS };
