const pool = require('../db/pool');
const { collectWebDiscoverySource } = require('./webDiscoveryIngest');
const { matchCompanies } = require('./companyMatch');

// ONE-TIME MANUAL TOOL: builds company-profile depth in the archive for the
// 9 SAF/renewable-fuel majors in the "SAF Executive" workbook (2026-10-08),
// so the AI chatbot has per-company material (sites, CAPA, capex, strategy).
// Runs the normal Web Discovery pipeline (dedup, relevance filter, AI
// screening, classification, publish rules) over per-company queries, files
// results as type '보고서' (Archive), and tags them to a watched company.
const COMPANIES = [
  { name: 'Neste', aliases: ['Neste', '네스테'], extra: ['Neste Rotterdam SAF expansion 2027 1.2 Mt', 'Neste Singapore refinery SAF 1.0 Mt capacity', 'Neste Martinez Renewables Marathon joint venture', 'Neste Mahoney Environmental UCO collection'] },
  { name: 'Diamond Green Diesel', aliases: ['Diamond Green Diesel', 'DGD', 'Darling Ingredients'], extra: ['Diamond Green Diesel Port Arthur SAF 235 million gallons', 'Darling Ingredients DGD earnings EBITDA per gallon', 'Valero Darling Diamond Green Diesel St. Charles Norco expansion'] },
  { name: 'Phillips 66', aliases: ['Phillips 66'], extra: ['Phillips 66 Rodeo Renewed SAF 850 million conversion', 'Phillips 66 Humber refinery SAF co-processing', 'Phillips 66 renewable fuels RIN 45Z margin'] },
  { name: 'Eni S.p.A.', qname: 'Eni Enilive', aliases: ['Enilive', 'Eni S.p.A', '에니'], extra: ['Enilive Gela Venice biorefinery SAF capacity', 'Enilive KKR stake biorefinery Livorno Sannazzaro Priolo', 'Eni LG Chem Daesan Seosan biorefinery SAF', 'Enilive Pengerang Petronas Euglena biorefinery', 'Enilive Chalmette St. Bernard Renewables PBF'] },
  { name: 'Chevron', aliases: ['Chevron', '쉐브론', '셰브론'], extra: ['Chevron Renewable Energy Group Geismar renewable diesel expansion', 'Chevron El Segundo renewable fuels SAF co-processing', 'Chevron REG biodiesel plants idle 2024 Ralston Madison'] },
  { name: 'TotalEnergies', aliases: ['TotalEnergies', '토탈에너지스'], extra: ['TotalEnergies Grandpuits SAF biorefinery 230 kt', 'TotalEnergies La Mède biorefinery Normandy SAF', 'TotalEnergies SAF 1.5 Mt 2030 target co-processing'] },
  { name: 'BP plc', qname: 'bp', aliases: ['BP plc', 'bp Castellón', 'bp Kwinana', 'Archaea Energy'], extra: ['bp Castellón SAF co-processing 5% jet', 'bp Lingen refinery SAF co-processing', 'bp Archaea Energy sale transition spending cut biofuels', 'bp Kwinana Cherry Point SAF project paused'] },
  { name: 'Petrobras', aliases: ['Petrobras', '페트로브라스'], extra: ['Petrobras BioRefino co-processing REDUC SAF', 'Petrobras RPBC HEFA dedicated plant FID', 'Petrobras Combustível do Futuro 2027 SAF mandate', 'Petrobras biorefino projects delayed 2026'] },
  { name: 'VARO Energy', aliases: ['VARO', 'Preem', '프림'], extra: ['Preem Lysekil ICR SEK 5.5 billion FID', 'Preem Rotterdam SAF $600M VARO FID', 'VARO Energy acquires Preem 2026', 'Preem Synsat co-processing renewable diesel Lysekil'] },
];

// Second one-off set (palm-oil upstream/refining majors): CPO mills, refineries, oleochemicals,
// kernel crushing plants, FFB/CPO/PK output and planted area.
const PALM_TEMPLATES = [
  (n) => `${n} palm oil refinery capacity tonnes per year`,
  (n) => `${n} CPO mills FFB CPO PK production annual output`,
  (n) => `${n} oleochemical kernel crushing plant capacity`,
  (n) => `${n} oil palm planted area hectares plantation`,
  (n) => `${n} 팜유 정제 생산능력 플랜테이션 면적`,
];
const PALM_COMPANIES = [
  { name: 'Golden Agri-Resources', qname: 'Golden Agri-Resources GAR Sinar Mas', aliases: ['Golden Agri-Resources', 'Golden Agri', 'Sinar Mas Agribusiness', '시나르마스'], extra: ['Golden Agri-Resources planted area mills refineries annual report'] },
  { name: 'Wilmar', qname: 'Wilmar International', aliases: ['Wilmar', 'Wilmar International', '윌마'], extra: ['Wilmar International palm oil refining capacity plants oleochemicals', 'Wilmar plantation planted area CPO production'] },
  { name: 'SD Guthrie', qname: 'SD Guthrie Berhad Sime Darby Plantation', aliases: ['SD Guthrie', 'SD Guthrie Berhad', 'Sime Darby Plantation'], extra: ['SD Guthrie FFB production planted area mills downstream'] },
  { name: 'KLK', qname: 'KLK Kuala Lumpur Kepong Berhad', aliases: ['KLK', 'Kuala Lumpur Kepong', 'KLK Oleo'], extra: ['Kuala Lumpur Kepong plantation oleochemical KLK Oleo capacity', 'KLK refinery kernel crushing capacity'] },
  { name: 'Tunas Baru Lampung', qname: 'TBL Tunas Baru Lampung Sungai Budi', aliases: ['Tunas Baru Lampung', 'Sungai Budi', 'Sungai Budi Group'], extra: ['Sungai Budi Group palm oil refinery cooking oil capacity'] },
  { name: 'Mewah', qname: 'Mewah International', aliases: ['Mewah', 'Mewah International'], extra: ['Mewah International refinery capacity Pasir Gudang Port Klang'] },
  { name: 'IOI Corporation', qname: 'IOI Group IOI Corporation', aliases: ['IOI Corporation', 'IOI Group', 'IOI Loders Croklaan'], extra: ['IOI Corporation plantation planted area FFB mills refinery oleochemical'] },
  { name: 'FGV Holdings', qname: 'FGV Holdings', aliases: ['FGV Holdings', 'FGV', 'Felda Global Ventures'], extra: ['FGV Holdings CPO mills refinery kernel crushing planted area'] },
  { name: 'Mahkota Group', qname: 'Mahkota Group Berhad', aliases: ['Mahkota Group', 'Mahkota'], extra: ['Mahkota Group palm oil mills plantation capacity'] },
  { name: 'Sarawak Oil Palms', qname: 'Sarawak Oil Palms Berhad', aliases: ['Sarawak Oil Palms', 'Sarawak Oil Palms Berhad', 'SOPB'], extra: ['Sarawak Oil Palms Berhad planted area mills FFB CPO production'] },
];

const TEMPLATES = [
  (n) => `${n} sustainable aviation fuel SAF capacity production sites`,
  (n) => `${n} SAF investment expansion plan capex`,
  (n) => `${n} renewable diesel HEFA biorefinery capacity`,
  (n) => `${n} SAF used cooking oil feedstock margin spread`,
  (n) => `${n} 지속가능항공유 SAF 투자 생산능력`,
];

const status = { running: false, startedAt: null, finishedAt: null, total: 0, done: 0, current: null, totals: { discovered: 0, filtered: 0, archived: 0, rejected: 0, failed: 0 }, failedQueries: 0, perCompany: {} };

function buildQueries(company) {
  return [...(company.palm ? PALM_TEMPLATES : TEMPLATES).map((t) => t(company.qname || company.name)), ...company.extra];
}

async function ensureSetup(list = COMPANIES) {
  for (const c of list) {
    await pool.query(
      `INSERT INTO companies (name, aliases, watched) VALUES ($1, $2, true)
       ON CONFLICT (name) DO UPDATE SET aliases = (SELECT ARRAY(SELECT DISTINCT unnest(companies.aliases || EXCLUDED.aliases))), watched = true`,
      [c.name, c.aliases]
    );
  }
  const name = 'Company Profile Collection (one-off)';
  const { rows } = await pool.query('SELECT * FROM sources WHERE name = $1 LIMIT 1', [name]);
  if (rows[0]) return rows[0];
  // Inactive + no URL: no scheduler or bulk collection ever picks this row up.
  const ins = await pool.query(
    `INSERT INTO sources (name, publisher, method, frequency_days, trust_grade, is_active) VALUES ($1, 'Web Discovery', 'crawl', 9999, 'B', false) RETURNING *`,
    [name]
  );
  return ins.rows[0];
}

async function runCompanyProfileCollection({ only, set } = {}) {
  if (status.running) return { started: false, reason: 'already_running' };
  const pool_ = set === 'palm' ? PALM_COMPANIES.map((c) => ({ ...c, palm: true })) : COMPANIES;
  const companies = pool_.filter((c) => !only || only.includes(c.name));
  Object.assign(status, { running: true, startedAt: new Date().toISOString(), finishedAt: null, done: 0, current: null, failedQueries: 0, perCompany: {}, totals: { discovered: 0, filtered: 0, archived: 0, rejected: 0, failed: 0 } });
  status.total = companies.reduce((a, c) => a + buildQueries(c).length, 0);
  (async () => {
    try {
      const source = await ensureSetup(companies);
      for (const company of companies) {
        const pc = (status.perCompany[company.name] = { queries: 0, archived: 0, discovered: 0 });
        for (const q of buildQueries(company)) {
          status.current = q;
          const r = await collectWebDiscoverySource({ ...source, url: q }, { itemType: '보고서', skipStaleCheck: true, skipKnownRejects: true });
          status.done++; pc.queries++;
          if (!r.ok) { status.failedQueries++; continue; }
          for (const k of Object.keys(status.totals)) status.totals[k] += r[k] || 0;
          pc.archived += r.archived || 0; pc.discovered += r.discovered || 0;
          for (const d of r.details || []) {
            if (d.stage === 'archived' && d.itemId) {
              try {
                const { rows } = await pool.query('SELECT title, ai_summary, summary FROM items WHERE id = $1', [d.itemId]);
                if (rows[0]) await matchCompanies(d.itemId, `${rows[0].title} ${rows[0].ai_summary || rows[0].summary || ''}`);
              } catch (_) { /* tagging is best-effort */ }
            }
          }
        }
      }
    } catch (err) {
      status.error = err.message;
    } finally {
      status.running = false; status.current = null; status.finishedAt = new Date().toISOString();
      console.log(`company_profile_collection completed ${JSON.stringify({ totals: status.totals, failedQueries: status.failedQueries, error: status.error || null })}`);
    }
  })();
  return { started: true, total: status.total };
}

module.exports = { runCompanyProfileCollection, getStatus: () => status, COMPANIES, PALM_COMPANIES, buildQueries };
