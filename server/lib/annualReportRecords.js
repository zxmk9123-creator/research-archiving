// Annual-report facts (annual_report_facts) -> dataset-pipeline records, so a quantity table/chart can
// use them. Only comparable kinds are produced: annual output in tonnes (FFB / CPO / PK, one family per
// question — never mixed) and planted area in hectares (one definition per company). Rates, counts,
// money and per-hour/day capacities are not charted here (they stay in the report text).
const pool = require('../db/pool');

const TONNE_UNIT = /^(?:(million|'?000|thousand)\s+)?(?:mt|metric\s+tonnes?|tonnes?|tons?)$/i;
const HA_UNIT = /^(?:ha|hectares?)$/i;

function familyOf(metric) {
  const m = String(metric || '').toLowerCase();
  if (/(rate|yield|cost|price|per hectare|per mature|extraction|ratio|%)/.test(m)) return null;
  if (/(rubber|sugar|cocoa)/.test(m)) return null;
  if (/ffb|fresh fruit bunch/.test(m) && /(production|output|harvest)/.test(m)) return 'ffb';
  if (/(crude palm kernel oil|cpko)/.test(m)) return null;
  if (/\bcpo\b|crude palm oil/.test(m) && /(production|output)/.test(m)) return 'cpo';
  if (/(\bpk\b|palm kernel)/.test(m) && /(production|output)/.test(m)) return 'pk';
  if (/(planted area|hectarage|oil palm area)/.test(m) && !/(mature|immature|young)/.test(m)) return 'area';
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
  const family = familyOf(row.metric);
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

// One definition per company and year: a year-end ("as at") basis wins over a weighted-average one.
function onePerEntity(records) {
  const rank = (r) => (/as at/i.test(r.definition || '') ? 3 : /weighted/i.test(r.definition || '') ? 1 : 2);
  const best = new Map();
  for (const r of records) {
    const key = `${r.entity.toLowerCase()}|${r.site || ''}|${r.year || 0}`;
    const cur = best.get(key);
    if (!cur || rank(r) > rank(cur) || (rank(r) === rank(cur) && r.amount > cur.amount)) best.set(key, r);
  }
  return [...best.values()];
}

// {records, items}: items are the synthetic archive items holding each report's text (footnote targets).
async function loadAnnualRecords(question, { candidates = [], baseIndex = 0 } = {}) {
  const family = familyForQuestion(question);
  if (!family) return { records: [], items: [] };
  const { rows } = await pool.query(
    `SELECT f.*, i.id AS item_id, i.title, i.summary, i.ai_summary, i.insight, i.ai_insight, i.published_at
       FROM annual_report_facts f JOIN items i ON i.source_url = f.source_url || '#annual-report-facts' AND i.status = 'Published'`
  );
  const mapped = rows.filter((r) => r.scope !== 'country' && r.scope !== 'site').map((r) => ({ row: r, rec: toRecord(r) })).filter((x) => x.rec && x.rec.family === family);
  // latest fiscal year per company
  const latest = new Map();
  for (const x of mapped) latest.set(x.rec.entity.toLowerCase(), Math.max(latest.get(x.rec.entity.toLowerCase()) || 0, x.rec.year || 0));
  const kept = mapped.filter((x) => (x.rec.year || 0) === latest.get(x.rec.entity.toLowerCase()));
  const items = [];
  const indexOf = new Map(candidates.map((c, i) => [c.id, i + 1]));
  const records = [];
  for (const x of kept) {
    let idx = indexOf.get(x.row.item_id);
    if (!idx) {
      items.push({ id: x.row.item_id, title: x.row.title, summary: x.row.summary, ai_summary: x.row.ai_summary, insight: x.row.insight, ai_insight: x.row.ai_insight, published_at: x.row.published_at, source_name: 'Company annual report' });
      idx = baseIndex + items.length;
      indexOf.set(x.row.item_id, idx);
    }
    records.push({ ...x.rec, source: idx });
  }
  return { records: family === 'area' ? onePerEntity(records) : records, items, family };
}

module.exports = { familyOf, familyForQuestion, toRecord, onePerEntity, loadAnnualRecords, FAMILY_LABEL };
