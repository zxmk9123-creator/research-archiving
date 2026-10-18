// DIAGRAMS (value chains, relationship maps). The model never draws: it writes a small JSON ```diagram block (nodes, edges,
// optional stages) and the browser renders it as SVG. This module decides when a question wants one, tells the model the
// format, and sanitizes the block (known node ids only, bounded size, relation types from a fixed set) before it is shown.
const WANTS = /(관계도|밸류\s*체인|가치\s*사슬|value\s*chain|구조도|흐름도|지배\s*구조|지분\s*구조|공급망\s*(도|지도|맵)|도식|다이어그램|diagram|네트워크\s*도|조직도)/i;
const EDGE_TYPES = ['owns', 'stake', 'jv', 'supplies', 'contract', 'flow'];
// readability ceiling: beyond ~16 boxes / 24 lines a 4-5 column diagram stops being scannable, so extra nodes are not drawn
const MAX_NODES = 16;
const MAX_EDGES = 24;

const baseKey = (n) => require('./companyRelations').baseKey(n);
const isDiagramQuestion = (q) => WANTS.test(String(q || ''));

const PROMPT_NOTE = `\n\n[질의 유형: 도식] 사용자는 관계도·밸류체인 같은 그림을 요청했다. 답변에 아래 형식의 \`\`\`diagram 코드블록을 정확히 하나 넣고, 그 뒤에 2~4줄의 설명만 쓰고 각 줄 끝에 근거 자료 번호 [n]을 붙인다(그림을 글로 다시 나열하지 않는다). 형식(JSON만):
{"type":"valuechain"|"relations","title":"짧은 제목","stages":[{"id":"s1","label":"원료 수거·집적"}],"nodes":[{"id":"n1","label":"회사/설비명","stage":"s1","group":"같은 소속·국가면 같은 문자열 또는 null"}],"edges":[{"from":"n1","to":"n2","type":"owns|stake|jv|supplies|contract|flow","label":"짧은 설명(예: 51%, 원료 공급)","source":3,"inferred":false}]}
규칙: (1) valuechain은 stages를 왼쪽→오른쪽 순서로 쓰고 모든 node에 stage를 준다. relations는 stages 없이 모회사→자회사 방향(from=지배·공급하는 쪽)으로 쓴다. (2) 노드와 선은 자료나 [기업 관계 DB]에서 확인된 것만 넣고, 선마다 근거 자료 번호를 source로 적는다(관계 DB 항목은 source 생략 가능). 확인되지 않지만 맥락상 필요한 연결은 inferred:true로 표시하거나 넣지 않는다. (3) 한 도식에는 기업·설비 같은 같은 위계만 담고 국가·기관을 섞지 않는다. (4) 노드는 최대 ${MAX_NODES}개(핵심 기업·설비 위주로 추리고 곁가지는 쓰지 않는다), 선은 최대 ${MAX_EDGES}개, 회사명은 한 가지 표기만 쓰고 사명 변경·한영 표기가 다른 같은 회사(예: Sime Darby Plantation = SD Guthrie)는 한 노드로 합친다. 노드는 실제 기업·설비·사업장 이름만 쓰고 국가·지역·시장·기관, 익명 표기("A사"), 제품·브랜드명(예: CERTIO®)은 노드로 쓰지 않는다. 선 label은 12자 이내 짧은 말이고 근거 번호는 source에만 쓴다. (5) type: owns=모회사→자회사, stake=지분 보유, jv=합작 파트너(방향 무관), supplies=원료·제품 공급, contract=하청·시공·라이선스, flow=공정·물류 흐름.`;

function parse(body) {
  try { return JSON.parse(body); } catch (_) { return null; }
}

const str = (v, n) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, n);

// The relationship DB's rules, applied to the model's edges (the label is the only evidence a diagram edge carries):
//   a JV / joint partner or a share <= 50% is a stake, never the parent; two or more owners of one box without a stated
//   majority are all stakes; ownership with no ownership wording becomes a plain flow; an airline is never the seller;
//   one jv line per pair.
function applyRelationRules(edges, nodes) {
  const rel = require('./companyRelations');
  const label = new Map(nodes.map((n) => [n.id, n.label]));
  const pctOf = (e) => { const m = String(e.label || '').match(/(\d+(?:\.\d+)?)\s*%/); return m ? Number(m[1]) : 0; };
  let out = edges.map((e) => {
    const f = rel.fixRelation({ src: label.get(e.from), dst: label.get(e.to), relation: e.type === 'jv' ? 'jv_partner' : e.type === 'contract' ? 'contractor_for' : e.type === 'owns' || e.type === 'stake' || e.type === 'supplies' ? e.type : 'flow', share_pct: pctOf(e) || null, evidence: e.label });
    if (e.type === 'owns' || e.type === 'stake') {
      if (!f) return { ...e, type: 'flow' };                      // no ownership wording: a flow, not a parent link
      return { ...e, type: f.relation === 'stake' ? 'stake' : e.type };
    }
    if (e.type === 'supplies' && f && f.src !== label.get(e.from)) return { ...e, from: e.to, to: e.from }; // an airline is a buyer
    return e;
  });
  // several owners of one box, none with a stated majority: all stakes
  const incoming = new Map();
  for (const e of out) if (e.type === 'owns') incoming.set(e.to, (incoming.get(e.to) || []).concat(e));
  for (const list of incoming.values()) if (list.length >= 2 && !list.some((e) => pctOf(e) > 50)) for (const e of list) e.type = 'stake';
  // one jv line per pair, one line per (from, to, type)
  const seen = new Set();
  out = out.filter((e) => {
    const key = e.type === 'jv' ? [e.from, e.to].sort().join('|') + '|jv' : `${e.from}|${e.to}|${e.type}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return out;
}

// -> normalized object or null
function sanitize(raw, { canon = (n) => n, isNonCompany = (n) => require('./companyRelations').isNonCompanyName(n), roleOf = () => null } = {}) {
  const d = raw && typeof raw === 'object' ? raw : null;
  if (!d || !Array.isArray(d.nodes)) return null;
  const type = d.type === 'relations' ? 'relations' : 'valuechain';
  let stages = type === 'valuechain' && Array.isArray(d.stages)
    ? d.stages.slice(0, 8).map((s) => ({ id: str(s && s.id, 20), label: str(s && s.label, 24) })).filter((s) => s.id && s.label)
    : [];
  let stageIds = new Set(stages.map((s) => s.id));
  const seen = new Set();
  const remap = new Map(); // model id -> kept node id (same company under two spellings is one node)
  const byLabel = new Map();
  let nodes = [];
  for (const n of d.nodes) {
    const id = str(n && n.id, 30);
    const raw = str(n && n.label, 40);
    if (!id || !raw || seen.has(id)) continue;
    seen.add(id);
    const label = canon(raw) || raw;
    if (isNonCompany(label)) continue; // countries / markets / institutions are not boxes of a company diagram
    const key = baseKey(label) || label.toLowerCase(); // Eni / Eni S.p.A. / (주)Eni are one box
    if (byLabel.has(key)) { remap.set(id, byLabel.get(key)); continue; }
    byLabel.set(key, id);
    remap.set(id, id);
    nodes.push({ id, label, stage: stageIds.has(n.stage) ? n.stage : null, group: str(n.group, 24) || null });
  }
  if (nodes.length < 2) return null;
  // emitters (배출처: restaurants, food factories ...) and suppliers (aggregate + distribute) are different stages
  if (type === 'valuechain') {
    const SUPPLY = /집적|공급|수거|aggregat|supplier/i;
    let emit = stages.find((s) => /배출|emit/i.test(s.label) && !SUPPLY.test(s.label)); // a pure emitter stage only
    const supply = stages.find((s) => SUPPLY.test(s.label));
    for (const n of nodes) {
      const role = roleOf(n.label);
      if (role === 'emitter') {
        if (!emit) { emit = { id: 's_emit', label: '배출처' }; stages = [emit, ...stages]; stageIds = new Set(stages.map((x) => x.id)); }
        n.stage = emit.id;
      } else if (role === 'supplier' && emit && n.stage === emit.id) n.stage = supply ? supply.id : n.stage;
    }
  }
  let edges = [];
  const keys = new Set();
  const known = new Set(nodes.map((n) => n.id));
  for (const e of Array.isArray(d.edges) ? d.edges : []) {
    const from = remap.get(str(e && e.from, 30));
    const to = remap.get(str(e && e.to, 30));
    const t = EDGE_TYPES.includes(e && e.type) ? e.type : 'flow';
    if (!from || !to || !known.has(from) || !known.has(to) || from === to) continue;
    const key = `${from}|${to}|${t}`;
    if (keys.has(key)) continue;
    keys.add(key);
    const src = Number(e.source);
    edges.push({ from, to, type: t, label: str(e.label, 14) || null, source: Number.isInteger(src) && src > 0 ? src : null, inferred: e.inferred === true });
  }
  if (!edges.length) return null;
  edges = applyRelationRules(edges, nodes);
  // ceiling: keep the best-connected nodes (then the earliest listed), drop edges to removed nodes and isolated nodes
  if (nodes.length > MAX_NODES) {
    const deg = new Map(nodes.map((n) => [n.id, 0]));
    for (const e of edges) { deg.set(e.from, deg.get(e.from) + 1); deg.set(e.to, deg.get(e.to) + 1); }
    const keep = new Set(nodes.map((n, i) => ({ id: n.id, i })).sort((a, b) => deg.get(b.id) - deg.get(a.id) || a.i - b.i).slice(0, MAX_NODES).map((o) => o.id));
    nodes = nodes.filter((n) => keep.has(n.id));
    edges = edges.filter((e) => keep.has(e.from) && keep.has(e.to));
  }
  edges = edges.slice(0, MAX_EDGES);
  const linked = new Set(edges.flatMap((e) => [e.from, e.to]));
  nodes = nodes.filter((n) => linked.has(n.id));
  if (nodes.length < 2 || !edges.length) return null;
  return { type, title: str(d.title, 60) || null, stages, nodes, edges };
}

// Replaces every ```diagram fence with the sanitized block (invalid ones are removed). Evidence is carried by the [n]
// markers of the explanation lines (the diagram itself shows no source marks).
function sanitizeInText(text, { maxSource = Infinity, canon, isNonCompany, roleOf } = {}) {
  return String(text || '').replace(/```diagram[^\n]*\n([\s\S]*?)```/g, (whole, body) => {
    const d = sanitize(parse(body), { canon, isNonCompany, roleOf });
    if (!d) return '';
    for (const e of d.edges) if (e.source && e.source > maxSource) e.source = null;
    return `\`\`\`diagram\n${JSON.stringify(d)}\n\`\`\`\n`;
  });
}

module.exports = { isDiagramQuestion, PROMPT_NOTE, sanitize, sanitizeInText, EDGE_TYPES };
