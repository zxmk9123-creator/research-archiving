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

// -> normalized object or null
function sanitize(raw, { canon = (n) => n, isNonCompany = () => false } = {}) {
  const d = raw && typeof raw === 'object' ? raw : null;
  if (!d || !Array.isArray(d.nodes)) return null;
  const type = d.type === 'relations' ? 'relations' : 'valuechain';
  const stages = type === 'valuechain' && Array.isArray(d.stages)
    ? d.stages.slice(0, 8).map((s) => ({ id: str(s && s.id, 20), label: str(s && s.label, 24) })).filter((s) => s.id && s.label)
    : [];
  const stageIds = new Set(stages.map((s) => s.id));
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
function sanitizeInText(text, { maxSource = Infinity, canon, isNonCompany } = {}) {
  return String(text || '').replace(/```diagram[^\n]*\n([\s\S]*?)```/g, (whole, body) => {
    const d = sanitize(parse(body), { canon, isNonCompany });
    if (!d) return '';
    for (const e of d.edges) if (e.source && e.source > maxSource) e.source = null;
    return `\`\`\`diagram\n${JSON.stringify(d)}\n\`\`\`\n`;
  });
}

module.exports = { isDiagramQuestion, PROMPT_NOTE, sanitize, sanitizeInText, EDGE_TYPES };
