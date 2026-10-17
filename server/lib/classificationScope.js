// CLASSIFICATION SCOPE CARD. A broad request ("글로벌 SAF 플랜트 Capacity Top10") leaves open WHICH slice of the
// classifications kept in the DB is meant: which sector, which unit of analysis (the operating entity of a plant, its
// owning parent, or the plant itself), which status (running now / planned), which kind of entity (company only, or also
// institutions / countries). Instead of guessing, the user is asked once; the answers are then enforced in code.
// Only the dimensions the question has NOT already fixed are asked, and nothing is asked for narrow requests.
const { SECTOR_KEYWORD_PATTERNS } = require('./classificationSanity');

const PLANT_WORDS = /(플랜트|설비|공장|시설|거점|사업장|plant|facilit|refiner|biorefiner|\bsites?\b|capa|capacity|생산\s*능력)/i;
const COMPANY_WORDS = /(기업|업체|회사|생산자|메이저|company|companies|producer|operator)/i;
const BROAD_WORDS = /(글로벌|전\s*세계|세계|주요|상위|top\s*\d+|전체|모든|전수|순위|비교|리스트|목록|global|worldwide|leading|ranking)/i;
const UNIT_FIXED = /(거점별|플랜트별|설비별|공장별|사업장별|모회사|지주|소유\s*기준|지분|운영사|운영\s*법인|법인\s*기준|기업별|업체별|회사별)/i;
const STATUS_FIXED = /(현재|가동|운영\s*중|건설|계획|목표|예정|전망|20[2-4]\d\s*년|향후|미래|\bcurrent\b|planned|target)/i;
const PRODUCT_FIXED = /(SAF\s*전용|SAF만|항공유\s*전용|재생\s*디젤|HVO|바이오\s*디젤|재생\s*연료\s*전체|바이오\s*연료\s*전체|전체\s*재생\s*연료|renewable diesel)/i;
const CAPACITY_WORDS = /(capa|capacity|생산\s*능력|생산량|용량)/i;
const KIND_FIXED = /(기관|국가|정부|협회|기업만|업체만|회사만)/i;

// Each group: the user's choice is sent back as classification[group.id].
function buildGroups(question, { sectors = [], entityTypes = [] } = {}) {
  const q = String(question || '');
  const groups = [];
  const namedSector = Object.values(SECTOR_KEYWORD_PATTERNS).some((re) => re.test(q)) || sectors.some((s) => s.name && q.toLowerCase().includes(String(s.name).toLowerCase()));
  if (!namedSector && sectors.length) {
    groups.push({
      id: 'subject', label: '분야 (DB 분류)', hint: '어느 분야의 자료를 기준으로 할까요?',
      options: [...sectors.slice(0, 8).map((s) => ({ id: s.name, label: s.name, detail: `자료 ${s.count}건` })), { id: '', label: '질문 그대로 (분야 제한 없음)', detail: '' }],
      default: sectors[0].name,
    });
  }
  if ((PLANT_WORDS.test(q) || COMPANY_WORDS.test(q)) && !UNIT_FIXED.test(q.replace(/기업별|업체별|회사별/g, (m) => (PLANT_WORDS.test(q) ? '' : m)))) {
    groups.push({
      id: 'unit', label: '집계 단위 (주체·소유자)', hint: '한 설비를 어느 주체의 수치로 볼까요? 합작(JV)은 같은 설비가 두 회사에 걸리기도 합니다.',
      options: [
        { id: 'operator', label: '운영 법인 기준', detail: '설비를 운영하는 법인 이름 그대로 (예: Diamond Green Diesel). 기본값' },
        { id: 'owner', label: '소유 모회사 기준', detail: '지분을 가진 모회사로 합산 (자료에 모회사가 밝혀진 경우만 적용)' },
        { id: 'site', label: '플랜트(거점) 단위', detail: '기업으로 묶지 않고 설비별로 나열' },
      ],
      default: 'operator',
    });
  }
  // SAF plants usually make renewable diesel too: is the capacity wanted SAF only, or all renewable fuels?
  if (SECTOR_KEYWORD_PATTERNS.SAF.test(q) && CAPACITY_WORDS.test(q) && !PRODUCT_FIXED.test(q)) {
    groups.push({
      id: 'product', label: '제품 범위 (SAF 전용 / 재생연료 전체)', hint: '한 플랜트의 생산능력에는 SAF와 재생디젤(HVO)이 함께 잡히는 경우가 많습니다.',
      options: [
        { id: 'saf', label: 'SAF 전용', detail: '지속가능항공유로 밝혀진 용량만. 제품 범위가 확인되지 않은 값은 제외합니다. 기본값' },
        { id: 'all', label: '재생연료 전체 (SAF + 재생디젤·HVO 포함)', detail: '플랜트가 만드는 재생연료 총 용량' },
      ],
      default: 'saf',
    });
  }
  if (!STATUS_FIXED.test(q)) {
    groups.push({
      id: 'status', label: '시점·상태', hint: '현재 가동 중인 값과 건설·계획·목표 값을 섞지 않습니다.',
      options: [
        { id: 'current', label: '현재 가동 기준', detail: '최신 보고 시점의 가동 중 용량. 기본값' },
        { id: 'plan', label: '건설·계획·목표 기준', detail: '아직 가동 전인 값만' },
        { id: 'both', label: '둘 다, 따로 표시', detail: '현재와 계획·목표를 구분해 함께' },
      ],
      default: 'current',
    });
  }
  if (COMPANY_WORDS.test(q) && !KIND_FIXED.test(q)) {
    const n = (t) => (entityTypes.find((e) => e.type === t) || {}).count;
    groups.push({
      id: 'kind', label: '대상 유형 (entity_type)', hint: 'DB가 구분해 둔 주체 유형 중 무엇을 포함할까요?',
      options: [
        { id: 'company', label: '기업만', detail: `${n('기업') ? `기업 ${n('기업')}곳 · ` : ''}기관·국가 제외. 기본값` },
        { id: 'all', label: '기관·국가 포함', detail: `${n('기관') ? `기관 ${n('기관')} · ` : ''}${n('국가') ? `국가 ${n('국가')}` : '협회·정부 추정치 포함'}` },
      ],
      default: 'company',
    });
  }
  return groups;
}

// A card is shown only for BROAD requests with at least two open dimensions.
function detectAmbiguity(question, ctx = {}) {
  const q = String(question || '');
  if (!BROAD_WORDS.test(q) && !(ctx.req && (ctx.req.topN || ctx.req.completeness))) return null;
  if (ctx.intentType === 'entity') return null;
  if (!ctx.isDataset && !PLANT_WORDS.test(q) && !COMPANY_WORDS.test(q)) return null;
  const groups = buildGroups(q, ctx);
  if (groups.length < 2) return null;
  return {
    kind: 'classification',
    title: '어떤 분류의 데이터를 원하시나요?',
    reason: '범위가 넓어 주체·소유자·시점이 모호합니다. DB에 유지하는 분류 중 어느 것을 기준으로 할지 먼저 정합니다.',
    groups,
    notes: ['선택한 기준은 표·차트를 만들 때 코드로 그대로 적용됩니다.'],
  };
}

const ALLOWED = { unit: ['operator', 'owner', 'site'], status: ['current', 'plan', 'both'], kind: ['company', 'all'], product: ['saf', 'all'] };
function sanitizeChoices(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const out = {};
  for (const [k, vals] of Object.entries(ALLOWED)) if (vals.includes(raw[k])) out[k] = raw[k];
  if (typeof raw.subject === 'string' && raw.subject.length <= 40) out.subject = raw.subject.trim();
  return Object.keys(out).length ? out : {};
}

const PLAN_STATUS = new Set(['건설중', '계획', '목표']);
// Enforce the answers on stored records.
function applyToRecords(records, choices) {
  if (!choices) return records;
  let out = records;
  if (choices.status === 'current') out = out.filter((r) => r.status === '가동');
  else if (choices.status === 'plan') out = out.filter((r) => PLAN_STATUS.has(r.status));
  if (choices.kind === 'company') out = out.filter((r) => r.etype !== '기관' && r.etype !== '국가');
  if (choices.product === 'saf' || choices.product === 'all') {
    // product scope: only applied when most facts carry a product label (older facts are labelled by re-extraction);
    // filtering on a thin labelled minority would silently drop most companies
    const labelled = out.filter((r) => r.product);
    if (labelled.length >= 3 && labelled.length / out.length >= 0.6) {
      const keep = choices.product === 'saf' ? new Set(['saf']) : new Set(['saf', 'renewable_diesel', 'biofuel_total']);
      out = out.filter((r) => r.product && keep.has(r.product));
    }
  }
  if (choices.unit === 'owner') out = out.map((r) => (r.parent ? { ...r, entity: r.parent } : r));
  if (choices.unit === 'site') out = out.filter((r) => r.site);
  return out;
}

// One sentence for the writer, so its prose matches what the code enforces.
function describeChoices(choices) {
  if (!choices) return '';
  const p = [];
  if (choices.subject) p.push(`분야: ${choices.subject}`);
  if (choices.unit) p.push({ operator: '집계 단위: 운영 법인', owner: '집계 단위: 소유 모회사', site: '집계 단위: 플랜트(거점)' }[choices.unit]);
  if (choices.status) p.push({ current: '시점: 현재 가동', plan: '시점: 건설·계획·목표', both: '시점: 현재와 계획을 구분' }[choices.status]);
  if (choices.product) p.push({ saf: '제품 범위: SAF 전용', all: '제품 범위: 재생연료 전체' }[choices.product]);
  if (choices.kind) p.push({ company: '대상: 기업만', all: '대상: 기관·국가 포함' }[choices.kind]);
  return p.length ? `\n\n[사용자가 확인한 분류 기준 — ${p.join(' · ')}. 이 기준을 벗어난 항목은 쓰지 않는다.]` : '';
}

// ---- conversation context -----------------------------------------------------------------
// Structured memory of the conversation, owned by the server, carried by the client between turns:
//   subject (sector), classification (the card answers), entities (companies of the last table/answer).
// A follow-up inherits what it does not itself state — never by re-reading old answer text.
const CTX_UNITS = ['operator', 'owner', 'site'];
function sanitizeContext(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const strs = (a) => (Array.isArray(a) ? a.filter((x) => typeof x === 'string' && x.length <= 80).slice(0, 30) : []);
  return {
    subject: typeof raw.subject === 'string' && raw.subject.length <= 40 ? raw.subject : null,
    classification: sanitizeChoices(raw.classification) || {},
    entities: strs(raw.entities),
  };
}

// Words that point back at the previous table / list ("그 업체들", "위 표", "이 중에서").
const REFERS_BACK = /(그\s*(중|업체|기업|회사|표|목록|리스트|순위|수치|결과|데이터)|이\s*(중|업체|기업|회사|표|목록|리스트|순위)|위\s*(표|목록|업체|기업|순위|결과)|해당\s*(업체|기업|회사|표)|이들|그들|방금|앞서|같은\s*(업체|기업|회사)|동일한\s*(업체|기업|회사))/;
const refersBack = (q) => REFERS_BACK.test(String(q || ''));

// What a follow-up inherits: the card answers (unless this question fixes that dimension itself) and the
// sector. cardAnswered = the user already answered the card in this conversation, so it is not asked again.
function carry(prev, question) {
  const q = String(question || '');
  if (!prev) return { choices: null, cardAnswered: false };
  const choices = { ...prev.classification };
  if (STATUS_FIXED.test(q)) delete choices.status;
  if (UNIT_FIXED.test(q)) delete choices.unit;
  if (KIND_FIXED.test(q)) delete choices.kind;
  if (PRODUCT_FIXED.test(q)) delete choices.product;
  const namesSector = Object.values(SECTOR_KEYWORD_PATTERNS).some((re) => re.test(q));
  if (!namesSector && prev.subject && !choices.subject) choices.subject = prev.subject;
  const cardAnswered = Boolean(prev.classification && (prev.classification.unit || prev.classification.status || prev.classification.kind));
  return { choices: Object.keys(choices).length ? choices : null, cardAnswered };
}

function nextContext(prev, { question, choices, datasetEntities, focusEntities }) {
  const q = String(question || '');
  const matched = Object.entries(SECTOR_KEYWORD_PATTERNS).find(([, re]) => re.test(q));
  return {
    subject: (choices && choices.subject) || (matched ? matched[0] : null) || (prev && prev.subject) || null,
    classification: { ...((prev && prev.classification) || {}), ...(choices || {}) },
    entities: (datasetEntities && datasetEntities.length ? datasetEntities : focusEntities && focusEntities.length ? focusEntities : (prev && prev.entities) || []).slice(0, 30),
  };
}

module.exports = { sanitizeContext, refersBack, carry, nextContext, detectAmbiguity, buildGroups, sanitizeChoices, applyToRecords, describeChoices };
