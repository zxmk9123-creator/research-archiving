// Annual-report facts (annual_report_facts) -> dataset-pipeline records, so a quantity table/chart can
// use them. Only comparable kinds are produced: annual output in tonnes (FFB / CPO / PK, one family per
// question — never mixed) and planted area in hectares (one definition per company). Rates, counts,
// money and per-hour/day capacities are not charted here (they stay in the report text).
const pool = require('../db/pool');

const TONNE_UNIT = /^(?:(million|thousand|M|[\u2019'\u2018]?000)\s*)?(?:mt|metric\s+(?:tonnes?|tons?)|tonnes?|tons?)$/i;
const HA_UNIT = /^(?:ha|hectares?)$/i;

// Wording that makes a figure NOT the comparable one (rates, prices, other crops, partial bases, certified volumes).
const NOT_COMPARABLE = /(yield|rate|price|cost|ratio|per hectare|per ha|per mature|sales|export|capacity|revenue|%)/i;
const OTHER_CROP = /(rubber|sugar|cocoa|coconut|durian|avocado|banana|pineapple|organic|replant|harvested area|associate|subsidiar|cash crop|estate area)/i;
const PARTIAL_BASIS = /(mature|immature|young|nucleus|plasma|associate|organic|certified|rspo|mspo|iscc|segment|since |coconut)/i;

function familyOf(metric, definition = '') {
  const m = String(metric || '').toLowerCase();
  const d = String(definition || '');
  if (NOT_COMPARABLE.test(m) || OTHER_CROP.test(m)) return null;
  if (/(planted area|hectarage)/.test(m)) return PARTIAL_BASIS.test(m) || PARTIAL_BASIS.test(d) || OTHER_CROP.test(d) ? null : 'area';
  if (PARTIAL_BASIS.test(m) || PARTIAL_BASIS.test(d)) return null;
  if (/(crude palm kernel oil|cpko|kernel oil)/.test(m)) return null;
  if (/\bffb\b|fresh fruit bunch/.test(m)) return 'ffb';
  if (/\bcpo\b|crude palm oil/.test(m)) return 'cpo';
  if (/(\bpk\b|palm kernel)/.test(m)) return 'pk';
  return null;
}
const FAMILY_LABEL = { ffb: 'FFB 생산량', cpo: 'CPO(원유) 생산량', pk: 'PK(팜핵) 생산량', area: '식재 면적(전체)' };

// Which family the question asks for; null = not an annual-report style question.
function familyForQuestion(question) {
  const q = String(question || '');
  if (/(면적|식재|헥타르|hectare|planted|landbank|토지)/i.test(q)) return 'area';
  if (/\bffb\b|과일송이|신선과/i.test(q)) return 'ffb';
  if (/\bpk\b|팜핵|palm kernel/i.test(q)) return 'pk';
  if (/(생산량|생산\s*능력|생산|output|production|capa)/i.test(q) && /(팜유|palm|cpo|플랜테이션|plantation)/i.test(q)) return 'cpo';
  return null;
}

function toRecord(row) {
  const family = familyOf(row.metric, row.definition);
  if (!family) return null;
  const unit = String(row.unit || '').trim();
  const value = Number(row.value);
  if (!(value > 0) || row.value_max) return null;
  let amount;
  let group;
  const t = unit.match(TONNE_UNIT);
  if (family !== 'area' && t) {
    amount = value * (t[1] ? (/million/i.test(t[1]) ? 1e6 : 1e3) : 1);
    group = 'mass';
  } else if (family === 'area' && HA_UNIT.test(unit)) {
    amount = value;
    group = 'area';
  } else return null;
  return {
    entity: row.entity, site: row.location || null, metric: FAMILY_LABEL[family], family, status: '가동', year: row.fiscal_year || null,
    group, amount, basis: '직접', original: `${value.toLocaleString('en-US')} ${unit}${row.definition ? ` (${row.definition})` : ''}`,
    definition: row.definition || null, etype: '기업', country: null, parent: null, tons: group === 'mass' ? amount : null,
    pubAt: row.published_at || null, itemKey: row.source_url, scope: row.scope,
  };
}

// One figure per company: among the candidates of the company's latest year, a figure that belongs to a
// multi-year series (the same metric and definition stated for several years) is preferred over a one-off
// mention; then a year-end ("as at") basis over a weighted average; for area the smaller total is taken
// (an all-crops total is never smaller than the oil-palm total); for output the larger.
function onePerEntity(records, family) {
  const seriesYears = new Map();
  for (const r of records) {
    const k = `${r.entity.toLowerCase()}|${r.metric}|${r.definition || ''}`;
    if (!seriesYears.has(k)) seriesYears.set(k, new Set());
    seriesYears.get(k).add(r.year || 0);
  }
  const series = (r) => seriesYears.get(`${r.entity.toLowerCase()}|${r.metric}|${r.definition || ''}`).size;
  const defRank = (r) => (/as at/i.test(r.definition || '') ? 3 : /weighted/i.test(r.definition || '') ? 1 : 2);
  const better = (a, b) => (series(a) - series(b)) || (defRank(a) - defRank(b)) || (family === 'area' ? b.amount - a.amount : a.amount - b.amount);
  const latest = new Map();
  for (const r of records) latest.set(r.entity.toLowerCase(), Math.max(latest.get(r.entity.toLowerCase()) || 0, r.year || 0));
  const best = new Map();
  for (const r of records) {
    const key = r.entity.toLowerCase();
    if ((r.year || 0) !== latest.get(key)) continue;
    const cur = best.get(key);
    if (!cur || better(r, cur) > 0) best.set(key, r);
  }
  return [...best.values()];
}

// {records, items}: items are the synthetic archive items holding each report's text (footnote targets).
async function loadAnnualRecords(question, { candidates = [], baseIndex = 0 } = {}) {
  const family = familyForQuestion(question);
  if (!family) return { records: [], items: [] };
  // facts first WITHOUT the (large) report text; the text of only the picked reports is fetched afterwards
  const { rows } = await pool.query(
    `SELECT f.*, i.id AS item_id, i.published_at
       FROM annual_report_facts f JOIN items i ON i.source_url = f.source_url || '#annual-report-facts' AND i.status = 'Published'`
  );
  const mapped = rows.filter((r) => r.scope !== 'country' && r.scope !== 'site').map((r) => ({ row: r, rec: toRecord(r) })).filter((x) => x.rec && x.rec.family === family);
  const picked = onePerEntity(mapped.map((x) => x.rec), family);
  const rowOf = new Map(mapped.map((x) => [x.rec, x.row]));
  const items = [];
  const indexOf = new Map(candidates.map((c, i) => [c.id, i + 1]));
  const records = [];
  const needed = [...new Set(picked.map((rec) => rowOf.get(rec).item_id).filter((id) => !indexOf.has(id)))];
  const textRows = needed.length
    ? (await pool.query('SELECT id, title, summary, ai_summary, insight, ai_insight, published_at FROM items WHERE id = ANY($1)', [needed])).rows
    : [];
  const textById = new Map(textRows.map((r) => [r.id, r]));
  for (const rec of picked) {
    const row = rowOf.get(rec);
    let idx = indexOf.get(row.item_id);
    if (!idx) {
      const t = textById.get(row.item_id);
      if (!t) continue;
      items.push({ ...t, source_name: 'Company annual report' });
      idx = baseIndex + items.length;
      indexOf.set(row.item_id, idx);
    }
    records.push({ ...rec, source: idx });
  }
  return { records, items, family };
}

module.exports = { familyOf, familyForQuestion, toRecord, onePerEntity, loadAnnualRecords, FAMILY_LABEL };
