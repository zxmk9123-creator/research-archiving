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
const freshness = require('./freshness');

const METRIC_WORDS = /(capa|capacity|생산\s*능력|용량|생산량|생산\s*규모|처리량|공급량|출하|물량|수출량|수입량|판매량|소비량|재고|투자액|투자\s*규모|투자금|매출|시장\s*규모|규모|면적|식재|헥타르|hectare|planted)/i;
const STATUS_RANK = { 가동: 3, 건설중: 2, 계획: 1, 목표: 0 };
// One state vocabulary on screen (the same words the chart labels use): 현재 / 건설중 / 계획 / 목표.
const STATUS_LABEL = { 가동: '현재', 건설중: '건설중', 계획: '계획', 목표: '목표' };
const GROUP_OF = { mass: 'mass', gal: 'volume', bbl: 'volume', liter: 'volume', bpd: 'volume', usd: 'usd', eur: 'eur', krw: 'krw' };
const GROUP_LABEL = { mass: '톤', volume: '리터', usd: '달러', eur: '유로', krw: '원', area: '헥타르' };
const GROUP_PRIORITY = ['mass', 'volume', 'usd', 'eur', 'krw', 'area'];
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
// Industry bodies / agencies are sources of estimates, not producers: never charted as a company
// unless the question names them. Unlabelled (older) facts fall back to a name list.
const ENTITY_TYPES = new Set(['기업', '기관', '국가', '기타']);
const INSTITUTION_NAME = /^(IATA|ICAO|IEA|IRENA|EASA|ISCC|FAO|USDA|OPEC|EPA|CARB|EIA|UN|WTO|IMO|EU|European Commission|국제항공운송협회|국제민간항공기구|국제에너지기구)(?![A-Za-z])/i;
const isInstitution = (r) => r.etype === '기관' || (!r.etype && INSTITUTION_NAME.test(String(r.entity || '').trim()));
function recordsForQuestion(records, question, density = null) {
  const q = String(question || '');
  const historical = freshness.wantsHistorical(q);
  const wantsCompanies = WANTS_COMPANIES.test(q);
  const wantsMoney = MONEY_Q.test(q);
  const wantsArea = /(면적|식재|헥타르|hectare|planted|landbank)/i.test(q);
  const wantsCap = CAP_Q.test(q);
  const wantsOut = OUT_Q.test(q);
  return records
    .filter((r) => {
      if (!historical && freshness.isOutdated(r.pubAt)) return false; // outdated facts never reach an answer
      if (isInstitution(r) && !q.toLowerCase().includes(String(r.entity).toLowerCase())) return false;
      // a company question lists companies: countries and other non-company entities (entity_type) are out
      if (wantsCompanies && (r.etype === '국가' || r.etype === '기관') && !q.toLowerCase().includes(String(r.entity).toLowerCase())) return false;
      if (r.group === 'area') return wantsArea;
      if (wantsArea && !wantsCap && !wantsOut && !/(생산|output|production)/i.test(q)) return false; // an area question: quantities of goods are out
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

// One company, one row: names that differ only by case, spacing, punctuation or a corporate
// suffix are the same entity; roster aliases (e.g. 에코세레스 / EcoCeres) map to the roster name
// (a Hangul/Latin pair can only be matched through the roster). Fields of the first record win.
const CORP_SUFFIX = /(?:\b(?:inc|corp|corporation|co|ltd|limited|llc|plc|gmbh|sa|ag|bv|oyj|asa|bhd|berhad)\b\.?|\bs\.?\s?p\.?\s?a\.?(?=\s|$)|주식회사|\(주\)|㈜|유한회사)/gi;
// "Phillips 66 Aviation", "Infinium Energy": a roster company name followed only by a generic qualifier is that company.
const QUALIFIER = /^(aviation|energy|renewables?|oil|group|holdings?|international|refining|biofuels?|fuels?|corp|company|산업|에너지)$/;
const nameKey = (s) => String(s || '').toLowerCase().replace(CORP_SUFFIX, '').replace(/[^a-z0-9가-힣]/g, '');
function canonicalizeEntities(records, roster = []) {
  const byKey = new Map();
  for (const c of roster) for (const n of c.rawNames || [c.name]) { const k = nameKey(n); if (k.length >= 2 && !byKey.has(k)) byKey.set(k, c.name); }
  const first = new Map();
  return records.map((r) => {
    const k = nameKey(r.entity);
    if (!k) return r;
    let name = byKey.get(k);
    if (!name) {
      // roster key + qualifier word(s)
      for (const [rk, rn] of byKey) {
        if (rk.length >= 4 && k.startsWith(rk) && QUALIFIER.test(k.slice(rk.length))) { name = rn; break; }
      }
    }
    name = name || (first.has(k) ? first.get(k) : (first.set(k, r.entity), r.entity));
    return name === r.entity ? r : { ...r, entity: name };
  });
}

// JOINT VENTURES: one physical facility is often reported under the venture AND each of its owners ("Diamond Green
// Diesel 12억 갤런" next to "Valero Energy 12억 갤런"). Records that state the SAME figure (status, year, unit group,
// amount) for entities that refer to each other in their own source text (and have compatible sites) are one facility:
// the entity most associated with the facility (a stated site, else most self-mentions) keeps the row, the others are
// dropped and remembered as `partners`, so a ranking or a sum never counts the facility twice.
const firstToken = (name) => String(name || '').toLowerCase().split(/[\s.(]+/).find((w) => w.length >= 3) || String(name || '').toLowerCase();
function mergeJointVentures(records, textOfSource) {
  const keyOf = (r) => `${r.status}|${r.year || 0}|${r.group}|${Math.round(r.amount)}`;
  const groups = new Map();
  records.forEach((r, i) => { const k = keyOf(r); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(i); });
  const drop = new Set();
  const partnersOf = new Map();
  for (const idxs of groups.values()) {
    const ents = [...new Set(idxs.map((i) => records[i].entity))];
    if (ents.length < 2) continue;
    const text = new Map(ents.map((e) => [e, idxs.filter((i) => records[i].entity === e).map((i) => String(textOfSource(records[i]) || '')).join(' ').toLowerCase()]));
    const sites = new Map(ents.map((e) => [e, new Set(idxs.filter((i) => records[i].entity === e).map((i) => records[i].site || ''))]));
    const compatible = (a, b) => [...sites.get(a)].some((sa) => [...sites.get(b)].some((sb) => !sa || !sb || sa.toLowerCase() === sb.toLowerCase()));
    const related = (a, b) => compatible(a, b) && (text.get(a).includes(firstToken(b)) || text.get(b).includes(firstToken(a)));
    const parent = new Map(ents.map((e) => [e, e]));
    const find = (e) => (parent.get(e) === e ? e : find(parent.get(e)));
    for (let x = 0; x < ents.length; x++) for (let y = x + 1; y < ents.length; y++) if (related(ents[x], ents[y])) parent.set(find(ents[x]), find(ents[y]));
    const comps = new Map();
    for (const e of ents) { const root = find(e); if (!comps.has(root)) comps.set(root, []); comps.get(root).push(e); }
    for (const members of comps.values()) {
      if (members.length < 2) continue;
      const score = (e) => (idxs.some((i) => records[i].entity === e && records[i].site) ? 1000 : 0) + (text.get(e).split(firstToken(e)).length - 1);
      const rep = members.slice().sort((a, b) => score(b) - score(a))[0];
      const others = members.filter((e) => e !== rep);
      partnersOf.set(rep, [...(partnersOf.get(rep) || []), ...others]);
      idxs.forEach((i) => { if (others.includes(records[i].entity)) drop.add(i); });
    }
  }
  const merged = records.filter((_, i) => !drop.has(i)).map((r) => (partnersOf.has(r.entity) ? { ...r, partners: [...new Set(partnersOf.get(r.entity))] } : r));
  return { records: merged, dropped: drop.size };
}

const WANTS_COMPANIES = /(기업|업체|회사|company|companies|producer|생산자)/i;

function isDatasetRequest(req, question) {
  return Boolean(req && (req.wantsChart || req.wantsTable) && METRIC_WORDS.test(String(question || '')));
}

const EXTRACTION_SYSTEM = `You extract a structured dataset from supplied materials. Respond with ONLY a JSON array — no prose, no code fences.
Each element: {"entity": string, "site": string|null, "scope": "site"|"total", "metric": string, "value": number, "unit": string, "period": "연간"|"일일"|null, "status": "가동"|"건설중"|"계획"|"목표", "year": number|null, "entity_type": "기업"|"기관"|"국가"|"기타", "country": string|null, "parent": string|null, "source": number}
Rules:
- Extract the quantity the QUESTION asks about (for example production capacity, output volume, shipments, trade volume, investment amount). One element per distinct figure that a material STATES for an entity's plant/site/segment (or for the entity as a whole when no site is given, site=null). Cover EVERY entity and EVERY site the materials give a figure for; never skip an item because of its unit (gallons, barrels, b/d, currency are all fine).
- "metric" is a short Korean label of the quantity (e.g. "생산능력", "생산량", "투자액").
- "value" and "unit" must reproduce the material's own figure exactly as written, splitting number from unit: "50만 톤" -> value 50, unit "만 톤"; "1.2 Mt/a" -> value 1.2, unit "Mt"; "340 million gallons" -> value 340, unit "million gallons"; "22,000 b/d" -> value 22000, unit "b/d"; "2만 5,000톤" -> value 25000, unit "톤". Never convert, round or rescale. Never invent a figure. Skip prices per unit (e.g. $/톤) and percentages.
- SCOPE (critical): "scope":"site" only for a figure stated for ONE named plant/site, and "site" is then that plant. A figure for the entity's TOTAL across several sites ("전체", "총", "글로벌", "합계", "global/total capacity", "across all refineries") is scope "total" with site=null — NEVER attribute a company-wide total to a site, and never attribute one site's figure to another site or to the company.
- TIME (critical): "status" is 가동 (operating NOW), 건설중 (under construction), 계획 (planned), 목표 (target). A figure that is true today is 가동 with the year it was reported if stated; a figure for a future date ("by 2027", "2026년 완공") is 계획 or 목표 with year = that future year. "year" is the year the figure refers to (not the article year), null only if truly unstated. Record the present value and each future value as SEPARATE elements — never merge a current and a future figure.
- "source" is the 자료 number the figure comes from.
- "entity" is the company/country/organisation the figure belongs to; "site" the plant/location/segment or null.
- "entity_type": 기업 = a company or its plant operator; 기관 = an industry body, agency, regulator, NGO, research house or exchange (IATA, ICAO, IEA, USDA, EU, ISCC...) that merely reports/estimates a figure; 국가 = a country/region; 기타 otherwise. "country" = the country (Korean) where the entity is headquartered (or the country itself for 국가), null if not stated or not certain. "parent" = the owning group when the entity is a subsidiary/JV named so in the material, else null.`;

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

// A figure that follows words like 전체/총/글로벌/합계/total/global describes the ENTITY, not a
// site, whatever site the extraction attached to it; and a site that is not named in the
// material at all cannot be the figure's site.
const TOTAL_CUE = /(전체|총\s*[가-힣0-9]|총생산|글로벌|전\s*세계|전사|합계|합산|전반|\bglobal\b|\btotal\b|worldwide|company-?wide|combined|overall|across (?:all|its)|all (?:its )?(?:refineries|sites|plants))/i;
function demoteToTotal(site, text, figureStart) {
  if (!site) return site;
  // a Latin site name must literally occur in the material; a Hangul one may be a translation of it, so it cannot be checked this way
  if (/[A-Za-z]/.test(site) && !/[가-힣]/.test(site) && !String(text || '').toLowerCase().includes(String(site).toLowerCase())) return null;
  if (figureStart !== null && figureStart !== undefined) {
    const before = text.slice(Math.max(0, figureStart - 50), figureStart);
    if (TOTAL_CUE.test(before)) return null;
  }
  return site;
}
// the same guard for a STORED record: locate its figure in the source text via its original wording
function guardStoredRecord(rec, text) {
  if (!rec.site) return rec;
  const q = nc.extractQuantities(String(rec.original || ''))[0];
  let start = null;
  if (q) {
    const hit = nc.extractQuantities(text).find((m) => m.cls === q.cls && Math.abs(m.value - q.value) <= Math.max(m.value, q.value) * 0.015);
    if (hit) start = hit.start;
  }
  const site = demoteToTotal(rec.site, text, start);
  return site === rec.site ? rec : { ...rec, site };
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
    const hit = direct.find((m) => Math.abs(m.value - q.value) <= Math.max(m.value, q.value) * 0.015);
    if (!hit) continue;
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
    const mText = materialText(candidates[source - 1]);
    const site = r.scope === 'total' ? null : demoteToTotal(clean(r.site) || null, mText, hit.start);
    const year = Number.isInteger(Number(r.year)) && Number(r.year) > 1990 && Number(r.year) < 2100 ? Number(r.year) : null;
    const key = `${entity.toLowerCase()}|${(site || '').toLowerCase()}|${status}|${group}|${Math.round(amount)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      entity, site, status, year, source, group, amount, basis, metric: clean(r.metric) || null, etype: ENTITY_TYPES.has(r.entity_type) ? r.entity_type : null, country: clean(r.country) || null, parent: clean(r.parent) || null, pubAt: candidates[source - 1].published_at || null,
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

const asOfCell = (r) => (r.year ? `${r.year}년` : yearOf(r.pubAt) ? `${yearOf(r.pubAt)}년 발표` : '-');

// ---- time and scope ---------------------------------------------------------------
const yearOf = (d) => { const t = d ? new Date(d) : null; return t && !Number.isNaN(t.getTime()) ? t.getFullYear() : 0; };
const asOfYear = (r) => r.year || yearOf(r.pubAt);
const pubTime = (r) => { const t = r.pubAt ? new Date(r.pubAt).getTime() : 0; return Number.isNaN(t) ? 0 : t; };
const isCurrent = (r) => r.status === '가동';
const isStalePlan = (r, nowYear) => r.status !== '가동' && r.year != null && r.year < nowYear;
const isFuture = (r, nowYear) => r.status !== '가동' && !isStalePlan(r, nowYear);

// One row per (entity, site) for a bucket: CURRENT keeps the most recent as-of figure; FUTURE keeps
// the furthest-year plan/target (the newest statement wins ties). An entity-wide TOTAL (site=null) is
// never stacked with its own sites: it only appears when the entity has no site rows in the bucket.
function bucketRows(records, valueOf, pick) {
  const best = new Map();
  for (const r of records) {
    const v = valueOf(r);
    if (v === null || v === undefined) continue;
    const key = `${r.entity.toLowerCase()}|${(r.site || '').toLowerCase()}`;
    const cur = best.get(key);
    if (!cur || pick(r, cur) > 0) best.set(key, r);
  }
  let rows = [...best.values()];
  const withSites = new Set(rows.filter((r) => r.site).map((r) => r.entity.toLowerCase()));
  rows = rows.filter((r) => r.site || !withSites.has(r.entity.toLowerCase()));
  return rows.sort((a, b) => valueOf(b) - valueOf(a)).slice(0, 30);
}
const newerCurrent = (a, b) => (asOfYear(a) - asOfYear(b)) || (pubTime(a) - pubTime(b)) || (a.amount - b.amount);
const furtherFuture = (a, b) => ((a.year || 0) - (b.year || 0)) || (pubTime(a) - pubTime(b)) || (a.amount - b.amount);

// requiredNames: roster entities that have supplied materials; any without a record gets an explicit "미공시" row.
// RANKING ("Top10 기업의 생산능력만 도표로"): one row per COMPANY, the largest first. A company's own stated total
// is used when there is one, otherwise its current site figures are summed (and the row says so); a company with no
// current figure is ranked by its furthest plan/target and labelled as such. Nothing else is written.
function buildRanking(records, valueOf, unitLabel, topN, nowYear) {
  const byEntity = new Map();
  for (const r of records) {
    if (valueOf(r) === null || valueOf(r) === undefined) continue;
    const k = r.entity.toLowerCase();
    if (!byEntity.has(k)) byEntity.set(k, []);
    byEntity.get(k).push(r);
  }
  const entries = [];
  for (const recs of byEntity.values()) {
    const entity = recs[0].entity;
    const cur = recs.filter(isCurrent);
    const totals = cur.filter((r) => !r.site).sort((a, b) => newerCurrent(b, a));
    const siteRows = bucketRows(cur.filter((r) => r.site), valueOf, newerCurrent);
    let entry = null;
    if (totals.length) {
      const t = totals[0];
      entry = { entity, value: valueOf(t), state: `현재 ${asOfCell(t)}`, how: `전사 공시 · 원문 ${t.original}${t.partners ? ` · 합작 중복 제외: ${t.partners.join(', ')}` : ''}`, sources: [t.source], country: t.country };
    } else if (siteRows.length) {
      const sum = siteRows.reduce((a, r) => a + valueOf(r), 0);
      entry = { entity, value: sum, state: `현재 ${asOfCell(siteRows.sort((a, b) => newerCurrent(b, a))[0])}`, how: `거점 합산 ${siteRows.length}곳 (${siteRows.map((r) => r.site).join(' + ')})`, sources: siteRows.map((r) => r.source), country: siteRows[0].country };
    } else {
      const fut = recs.filter((r) => isFuture(r, nowYear)).sort((a, b) => furtherFuture(b, a))[0];
      if (!fut) continue;
      entry = { entity, value: valueOf(fut), state: `${STATUS_LABEL[fut.status]} ${fut.year ? `${fut.year}년` : asOfCell(fut)}`, how: `${fut.site ? `${fut.site} · ` : '전사 · '}원문 ${fut.original}`, sources: [fut.source], country: fut.country };
    }
    entries.push(entry);
  }
  entries.sort((a, b) => b.value - a.value);
  const top = entries.slice(0, topN);
  if (!top.length) return null;
  const metric = (() => {
    const counts = new Map();
    for (const r of records) if (r.metric) counts.set(r.metric, (counts.get(r.metric) || 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || '수치';
  })();
  const cite = (e) => [...new Set(e.sources)].map((s) => `[${s}]`).join('');
  const lines = [
    `| 순위 | 기업 | ${metric} (${unitLabel}) | 상태·기준 | 산정 | 출처 |`,
    '| --- | --- | --- | --- | --- | --- |',
    ...top.map((e, i) => `| ${i + 1} | ${e.entity}${e.country ? ` (${e.country})` : ''} | ${fmtNum(e.value)} | ${e.state} | ${e.how} | ${cite(e)} |`),
  ];
  const note = `※ 현재(가동) 값 기준이며 현재 값이 없는 기업은 계획·목표 값을 해당 상태로 표기했습니다.${top.length < topN ? ` 자료에서 수치가 확인된 기업은 ${top.length}곳입니다.` : ''}`;
  return { entities: top.map((e) => e.entity), table: lines.join('\n'), chart: null, charts: [], markdown: `${lines.join('\n')}\n\n${note}`, records: top.length, only: true };
}

function buildDataset(records, requiredNames = [], { unitTons = false, density = null, nowYear = new Date().getFullYear(), topN = null, only = false } = {}) {
  if (records.length < 3) return null;
  const basis = chartBasis(records, { unitTons, density });
  const unitLabel = GROUP_LABEL[basis.group];
  const valueOf = basis.valueIn;
  if (only || topN) {
    const ranked = buildRanking(records, valueOf, unitLabel, topN || 10, nowYear);
    if (ranked) return ranked;
  }
  const statusOrder = { 가동: 0, 건설중: 1, 계획: 2, 목표: 3 };
  const seenRows = new Set();
  const sorted = records.slice().sort((a, b) => a.entity.localeCompare(b.entity) || (a.site || '').localeCompare(b.site || '') || (statusOrder[a.status] - statusOrder[b.status]) || ((b.year || 0) - (a.year || 0)))
    .filter((r) => { const k = `${r.entity.toLowerCase()}|${r.site || ''}|${r.status}|${r.year || 0}|${Math.round(r.amount)}|${r.group}`; if (seenRows.has(k)) return false; seenRows.add(k); return true; }); // the same figure stated twice is one row
  const have = new Set(records.map((r) => r.entity.toLowerCase()));
  const cellOf = (r) => {
    const v = valueOf(r);
    return v === null || v === undefined ? '- (다른 단위 · 원문 참조)' : fmtNum(v);
  };
  const stateOf = (r) => `${STATUS_LABEL[r.status]}${isStalePlan(r, nowYear) ? ' · 기준 경과' : ''}`;
  const lines = [
    `| 대상 | 거점·범위 | 상태 | 기준 | 수치 (${unitLabel}) | 원문 표기 | 출처 |`,
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...sorted.map((r) => `| ${r.entity}${r.country ? ` (${r.country})` : ''} | ${r.site || '전사 합계'} | ${stateOf(r)} | ${asOfCell(r)} | ${cellOf(r)} | ${r.original}${r.basis !== '직접' ? ` → ${r.basis}` : ''}${r.partners ? ` · 합작 중복 제외: ${r.partners.join(', ')}` : ''} | [${r.source}] |`),
  ];
  for (const name of requiredNames) {
    const key = name.name.toLowerCase();
    if ([...have].some((h) => h.includes(key) || key.includes(h) || name.names.some((n) => h.includes(n)))) continue;
    lines.push(`| ${name.name} | - | 미공시 | - | - | 자료에 수치 없음 | [${name.indices[0]}] |`);
  }
  const metric = (() => {
    const counts = new Map();
    for (const r of records) if (r.metric) counts.set(r.metric, (counts.get(r.metric) || 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || '수치';
  })();
  const converted = records.some((r) => r.basis !== '직접');
  const makeChart = (title, rows, future) => ({
    type: 'hbar',
    auto: 'dataset',
    title: `${title} (${unitLabel}${converted ? ', 환산 포함' : ''})`,
    unit: unitLabel,
    combine: 'sum',
    labels: rows.map((r) => `${r.entity}${r.site ? ` ${r.site}` : ' 전사'}${future && r.year ? ` (${r.year})` : ''}`),
    groups: rows.map((r) => r.entity),
    notes: rows.map((r) => `${STATUS_LABEL[r.status]}${r.year ? ` ${r.year}` : ''}${r.site ? '' : ' · 전사 합계'} · 원문 ${r.original}${r.basis !== '직접' ? ` → ${r.basis}` : ''}`),
    series: [{ name: `${metric} (${unitLabel})`, data: rows.map((r) => Math.round(valueOf(r))) }],
  });
  const currentRows = bucketRows(records.filter(isCurrent), valueOf, newerCurrent);
  const futureRows = bucketRows(records.filter((r) => isFuture(r, nowYear)), valueOf, furtherFuture);
  if (!currentRows.length && !futureRows.length) return null;
  const charts = [];
  if (currentRows.length && futureRows.length) {
    charts.push(makeChart(`현재 ${metric}`, currentRows, false), makeChart(`계획·목표 ${metric}`, futureRows, true));
  } else if (currentRows.length) charts.push(makeChart(`현재 ${metric}`, currentRows, false));
  else charts.push(makeChart(`계획·목표 ${metric}`, futureRows, true));
  const notes = [];
  const toMass = basis.group === 'mass' && records.some((r) => r.group === 'volume' && r.tons !== null);
  if (converted) notes.push('부피 단위는 갤런 3.785리터, 배럴 158.987리터, b/d는 ×365일 연환산(가동률 100% 가정)으로, 일·월 단위는 연으로 바꿨습니다.');
  if (toMass) notes.push(`리터를 톤으로 바꿀 때는 제품 밀도 ${density} kg/L를 가정했습니다.`);
  const excluded = records.filter((r) => valueOf(r) === null || valueOf(r) === undefined).length;
  if (excluded) notes.push(`다른 단위의 ${excluded}건은 차트에서 제외했고 표에 원문 표기로 남겼습니다${basis.group === 'mass' && !density ? ' (제품 밀도를 알 수 없어 톤으로 환산하지 않음)' : ''}.`);
  notes.push('현재 값은 거점별 가장 최근 기준, 계획·목표는 거점별 가장 먼 연도의 값을 막대로 그렸고, 전사 합계는 거점 값과 합산하지 않았습니다. 표에는 모든 값과 기준 연도를 기재했습니다.');
  const chartBlocks = charts.map((c) => `\`\`\`chart\n${JSON.stringify(c)}\n\`\`\``).join('\n\n');
  return { entities: [...new Set(records.filter((r) => valueOf(r) !== null && valueOf(r) !== undefined).map((r) => r.entity))], table: lines.join('\n'), chart: charts[0], charts, markdown: `${lines.join('\n')}\n\n${chartBlocks}\n\n${notes.join(' ')}`, records: sorted.length };
}

module.exports = { mergeJointVentures, WANTS_COMPANIES, canonicalizeEntities, guardStoredRecord, recordsForQuestion, isDatasetRequest, productDensity, EXTRACTION_SYSTEM, buildExtractionUser, parseRecords, verifyRecords, buildDataset, bucketRows, chartBasis, METRIC_WORDS };
