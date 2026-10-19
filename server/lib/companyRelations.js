// COMPANY RELATIONSHIP MAP. Subsidiaries, affiliates (equity stakes), joint ventures, supplier and contractor (하청) links
// between companies, kept as rows (src <relation> dst) with the article they come from. Sources, none of them guessed:
//   1. item_facts.parent (already extracted with the facts)  -> 'owns'
//   2. an AI pass over a published item's text; BOTH names must literally occur in that text, otherwise the row is dropped
//   3. manual rows (origin 'manual') that the pass never overwrites
const pool = require('../db/pool');
const provider = require('./ai/provider');
const { createLimiter } = require('./ai/concurrencyLimiter');

const RELATIONS = ['owns', 'stake', 'jv_partner', 'supplies', 'contractor_for', 'offtake_from'];
const LABEL = {
  owns: '모회사 → 자회사', stake: '지분 보유(관계기업·투자)', jv_partner: '합작 파트너', supplies: '공급(원료·제품)', contractor_for: '하청·시공(EPC·위탁)', offtake_from: '구매·오프테이크',
};
const limitCall = createLimiter(1, 4000);

const SYSTEM = `You extract company relationships from ONE article. Respond with ONLY a JSON array (possibly empty).
Each element: {"src": string, "dst": string, "relation": "owns"|"stake"|"jv_partner"|"supplies"|"contractor_for"|"offtake_from", "share_pct": number|null, "evidence": string, "status": "active"|"ended", "ended_evidence": string|null}
Direction: "src <relation> dst". owns = src controls / is the parent of dst (dst is its subsidiary); stake = src holds a minority or unspecified equity stake in dst (associate, investment); jv_partner = src and dst are partners of the same joint venture (use the two partner companies, never the JV itself); supplies = src supplies feedstock / product / equipment to dst; contractor_for = src is the contractor / EPC / licensor / outsourced operator doing work for dst; offtake_from = src is the BUYER (offtaker) and dst the seller. supplies / offtake_from never have an airline as the supplier. When dst is a joint venture that several partners formed, each partner relates to it as stake (owns only if the article says the partner controls it or holds more than 50%) and the partners relate to each other as jv_partner. owns needs a stated acquisition / ownership / subsidiary / percentage; a review, plan or rumour is not ownership. Airports, associations, agencies and governments are not companies. status = "ended" ONLY when the article says the relationship is over (a stake sold or the partner's stake fully acquired so the joint venture ended, a deal terminated or cancelled, a supplier or customer that stopped buying, a partner that withdrew); "ended_evidence" = the phrase that says so; otherwise "active".
Rules: only relationships the article STATES between two named companies (not people, governments or institutions); names exactly as written in the article; "share_pct" only when a percentage is stated; "evidence" = the short phrase from the article that states it. A plant or JV entity may be dst of owns/stake. No inference, no general-knowledge additions.`;

// ---- name hygiene shared by extraction, cleanup and diagrams ------------------------------------------------------------
const SUFFIX = /\b(s\.p\.a\.?|s\.a\.?|sdn\.? bhd\.?|bhd\.?|tbk\.?|pt\.?|plc|ltd\.?|limited|inc\.?|corp\.?|corporation|co\.?|company|llc|gmbh|ag|nv|bv|ab|asa|oyj|holdings?|group)\b|\(.*?\)|（.*?）|㈜|주식회사|\(주\)|그룹|홀딩스/gi;
const { stripForms } = require('./corpSuffix');
const baseKey = (n) => stripForms(n).replace(SUFFIX, ' ').replace(/[.,&®™*_`‐–-]/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
const NON_COMPANY = /(공항|airport|터미널|\bterminal\b|협회|association|institute|council|ministry|부처|정부|government|commission|위원회|agency|거래소|exchange|university|대학)$/i;
const AIRLINE = /(airlines?|airways|항공|\b(delta|united|american|jetblue|southwest|lufthansa|klm|iag|qantas|cathay|ryanair|easyjet|alaska|emirates|etihad|singapore air|air (france|canada|china|india|new zealand))\b)/i;
const OWNERSHIP_CUE = /(인수|소유|자회사|지분|보유|취득|합병|모회사|계열|지배|%|acqui|own|subsidiar|parent|stake|merger|merged|wholly|controlling)/i;
// a joint venture must be stated as one (a "collaboration" or a "business combination" is not); brand ownership is not company
// ownership; an exploration block / field / mine is an asset, not a company
const JV_STRICT = /(합작|joint[- ]venture|\bJV\b|공동\s*(출자|투자|설립|개발)|co-?invest|consortium|컨소시엄)/i;
const BRAND_CUE = /(브랜드|상표|brand|trademark|라이선스|licen[cs]e)/i;
const STRONG_OWNERSHIP = /(인수|acqui|지분|stake|자회사|subsidiar|\d\s*%|모회사|parent|합병|merger|wholly|지배)/i;
const ASSET_NAME = /(탐사\s*블록|광구|\bblocks?\b|\bfields?\b|유전|가스전|\blicen[cs]e area\b|\bwells?\b|광산|\bmines?\b)/i;
// wording that says a relationship is over; "ended" is accepted only when the article itself contains such wording
const END_CUE = /(전량|지분\s*(전부|전체)?\s*(매각|처분)|매각|철수|종료|중단|해지|청산|파기|취소|결렬|무산|buy[- ]?out|bought out|acquired (?:the )?(?:remaining|entire|full)|divest|sold (?:its|the|all)|\bexit(?:ed)?\b|terminat|cancel|ceased|\bended\b|withdr|wound up|stopped (?:buying|purchasing)|구매\s*중단|거래\s*중단)/i;
const JV_CUE = /(합작|joint venture|\bJV\b|공동\s*(출자|투자|설립)|co-?invest|설립한)/i;

// Collective / generic labels ("중국 내 식당", "여러 항공사들", "인도 자회사", "major airlines") name no single company.
const AGG_KO = /^(주요|글로벌|여러|다수|일부|각국|현지|국내|해외|대형|중소|기타|모든|전\s*세계)\s|(\s|^)(업체|기업|회사|항공사|제조업체|시추업체|식당|자회사|고객사|고객|공급사|판매점|업계)(들|\s*(중\s*)?(하나|\d+곳))?$|^(항공사|식당|업체|기업|고객|고객사)들?$|\s(내|산하)\s/;
const AGG_EN = /^(?:(?:major|leading|local|various|several|other|many|some|multiple)\s+)?(?:restaurants|airlines|companies|customers|suppliers|producers|retailers|households|refiners|others?)$/i;
// "Valero, Darling Ingredients" / "Neste, Marathon Petroleum": several companies in one label ("Foo, Inc." is one company)
const multiCompany = (name) => {
  const parts = String(name || '').split(/\s*,\s*/).filter(Boolean);
  const isForm = (p) => p.split(/\s+/).every((w) => require('./corpSuffix').FORMS.has(w.toLowerCase().replace(/[.]/g, '')));
  return parts.length >= 2 && !parts.slice(1).every(isForm); // "Foo, Inc." / "Foo, Co., Ltd." / "Foo, Pte. Ltd." are one company
};
const isAggregateName = (name) => AGG_KO.test(String(name || '').trim()) || AGG_EN.test(String(name || '').trim()) || multiCompany(name);

function isNonCompanyName(name) {
  if (isAggregateName(name)) return true;
  try {
    const level = require('./classificationScope').levelOf({ entity: name });
    if (level !== 'company') return true;
  } catch (_) { /* optional */ }
  return NON_COMPANY.test(String(name || '').trim()) || /^[A-Za-z가-힣]{1,2}사$/.test(String(name || '').trim());
}

// One relation row -> its corrected form, or null to drop it. Rules (code, from the sentence the row came with):
//   owns needs an ownership cue and, for a joint venture or a share <= 50%, is a stake instead (a JV partner is not its parent);
//   offtake_from / supplies run seller -> buyer, so an airline can never be the seller; non-companies never become nodes.
function fixRelation(r) {
  let { src, dst, relation } = r;
  if (isNonCompanyName(src) || isNonCompanyName(dst)) return null;
  const ev = String(r.evidence || '');
  const pct = Number(r.share_pct) || 0;
  if (['owns', 'stake', 'jv_partner'].includes(relation) && (ASSET_NAME.test(dst) || ASSET_NAME.test(src))) return null; // assets are not companies
  if (relation === 'jv_partner' && !JV_STRICT.test(ev)) return null;                    // "협력", "기업 결합" are not a joint venture
  if (relation === 'owns') {
    if (ev && BRAND_CUE.test(ev) && !STRONG_OWNERSHIP.test(ev)) return null;           // "소유의 브랜드" is brand ownership
    if (ev && JV_CUE.test(ev) && pct <= 50) relation = 'stake';        // a JV partner is not the JV's parent
    else if (pct > 0 && pct <= 50) relation = 'stake';
    else if (ev && !OWNERSHIP_CUE.test(ev)) return null;              // "strategic review of X" is not ownership
  }
  if (relation === 'offtake_from' && AIRLINE.test(dst) && !AIRLINE.test(src)) [src, dst] = [dst, src]; // buyer is src
  if (relation === 'supplies' && AIRLINE.test(src) && !AIRLINE.test(dst)) [src, dst] = [dst, src];
  return { ...r, src, dst, relation };
}

const textOf = (item) => [item.title, item.summary || item.ai_summary, item.insight || item.ai_insight].filter(Boolean).join('\n');
const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const clean = (s) => norm(s).replace(/^[“"'‘]|[”"'’]$/g, '');

function parseRelations(raw) {
  const text = String(raw || '').replace(/^```(?:json)?/i, '').replace(/```\s*$/, '');
  const start = text.indexOf('[');
  if (start < 0) return [];
  try { const a = JSON.parse(text.slice(start, text.lastIndexOf(']') + 1)); return Array.isArray(a) ? a : []; } catch (_) { return []; }
}

// Keeps only rows whose two names both occur in the article text; names are mapped to the roster's canonical spelling.
function verifyRelations(rows, text, canon = (n) => n) {
  const low = String(text || '').toLowerCase();
  const out = [];
  const seen = new Set();
  for (const r of rows || []) {
    const relation = RELATIONS.includes(r && r.relation) ? r.relation : null;
    const src = clean(r && r.src);
    const dst = clean(r && r.dst);
    if (!relation || src.length < 2 || dst.length < 2 || src.toLowerCase() === dst.toLowerCase()) continue;
    if (!low.includes(src.toLowerCase()) || !low.includes(dst.toLowerCase())) continue;
    const fixed = fixRelation({ src, dst, relation, share_pct: r.share_pct, evidence: r.evidence });
    if (!fixed) continue;
    let [a, b] = [canon(fixed.src), canon(fixed.dst)];
    const relationF = fixed.relation;
    if (a.toLowerCase() === b.toLowerCase()) continue;
    if (relationF === 'jv_partner' && a.toLowerCase() > b.toLowerCase()) [a, b] = [b, a]; // symmetric: one row per pair
    const key = `${a.toLowerCase()}|${b.toLowerCase()}|${relationF}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const pct = Number(r.share_pct);
    const ended = r.status === 'ended' && END_CUE.test(`${text} ${r.ended_evidence || ''}`);
    out.push({ src: a, dst: b, relation: relationF, share_pct: pct > 0 && pct <= 100 ? pct : null, evidence: clean(r.evidence).slice(0, 240) || null, status: ended ? 'ended' : 'active', ended_note: ended ? clean(r.ended_evidence).slice(0, 200) || null : null });
  }
  return out;
}

async function canonicalizer() {
  try {
    const { rows } = await pool.query('SELECT name, aliases FROM companies');
    const map = new Map();
    const baseMap = new Map();
    for (const c of rows) for (const n of [c.name, ...(c.aliases || [])]) if (n) { map.set(String(n).toLowerCase().trim(), c.name); if (baseKey(n).length >= 3) baseMap.set(baseKey(n), c.name); }
    // bilingual spellings learned elsewhere (term_aliases): the Latin spelling is the canonical one
    let bilingual = new Map();
    try {
      const { rows: al } = await pool.query('SELECT term, alt FROM term_aliases WHERE alt IS NOT NULL');
      for (const a of al) {
        const [h, l] = /[가-힣]/.test(a.term) ? [a.term, a.alt] : [a.alt, a.term];
        if (/[가-힣]/.test(h) && /^[A-Za-z]/.test(l) && !/[가-힣]/.test(l)) bilingual.set(String(h).toLowerCase().trim(), l);
      }
    } catch (_) { /* optional */ }
    let registry = null;
    try { registry = await require('./entityRegistry').getRegistry(); } catch (_) { /* optional */ }
    return (n) => {
      const k = String(n).toLowerCase().trim();
      const viaRegistry = registry && registry.canon(n);
      if (viaRegistry && viaRegistry !== n) return viaRegistry;
      const viaRoster = map.get(k) || baseMap.get(baseKey(n));
      if (viaRoster) return viaRoster;
      const latin = bilingual.get(k);
      return latin ? (map.get(latin.toLowerCase()) || baseMap.get(baseKey(latin)) || latin) : n;
    };
  } catch (_) { return (n) => n; }
}

// One-off cleanup of stored rows with the same rules (re-canonicalize, fix type / direction, drop non-companies,
// merge the rows that become identical). Manual rows are left alone.
async function cleanupRelations() {
  const canon = await canonicalizer();
  const { rows } = await pool.query("SELECT id, src, dst, relation, share_pct, evidence, item_id FROM company_relations WHERE origin <> 'manual' ORDER BY id");
  const stats = { checked: rows.length, dropped: 0, changed: 0, merged: 0 };
  for (const r of rows) {
    const fixed = fixRelation(r);
    if (!fixed) { await pool.query('DELETE FROM company_relations WHERE id = $1', [r.id]); stats.dropped++; continue; }
    let [a, b] = [canon(fixed.src), canon(fixed.dst)];
    if (a.toLowerCase() === b.toLowerCase()) { await pool.query('DELETE FROM company_relations WHERE id = $1', [r.id]); stats.dropped++; continue; }
    if (fixed.relation === 'jv_partner' && a.toLowerCase() > b.toLowerCase()) [a, b] = [b, a];
    if (a === r.src && b === r.dst && fixed.relation === r.relation) continue;
    try {
      await pool.query('UPDATE company_relations SET src = $2, dst = $3, relation = $4 WHERE id = $1', [r.id, a, b, fixed.relation]);
      stats.changed++;
    } catch (_) { // the corrected row already exists: keep that one
      await pool.query('DELETE FROM company_relations WHERE id = $1', [r.id]);
      stats.merged++;
    }
  }
  return stats;
}

async function storeRelations(rows, itemId, origin = 'ai') {
  let added = 0;
  for (const r of rows) {
    const res = await pool.query(
      `INSERT INTO company_relations (src, dst, relation, share_pct, evidence, item_id, origin, status, ended_note) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (LOWER(src), LOWER(dst), relation) DO UPDATE SET share_pct = COALESCE(company_relations.share_pct, EXCLUDED.share_pct),
         status = CASE WHEN EXCLUDED.status = 'ended' THEN 'ended' ELSE company_relations.status END,
         ended_note = COALESCE(EXCLUDED.ended_note, company_relations.ended_note)`,
      [r.src, r.dst, r.relation, r.share_pct, r.evidence, itemId, origin, r.status === 'ended' ? 'ended' : 'active', r.ended_note || null]
    );
    added += res.rowCount;
  }
  return added;
}

// One item -> stored relations. Never throws.
async function extractRelationsForItem(item, { canon = null } = {}) {
  try {
    const text = textOf(item);
    if (text.length < 80) { await pool.query("UPDATE items SET relations_status = 'none' WHERE id = $1", [item.id]); return { status: 'none', relations: 0 }; }
    const result = await limitCall(() => provider.callProviderWithFallback({ system: SYSTEM, user: `제목: ${item.title}\n${text}` }));
    const rows = verifyRelations(parseRelations(result.text), text, canon || (await canonicalizer()));
    if (rows.length) await storeRelations(rows, item.id);
    if (rows.length) require('./entityRegistry').registerNames(rows.flatMap((r) => [r.src, r.dst])); // new companies join the registry at once
    await pool.query('UPDATE items SET relations_status = $2 WHERE id = $1', [item.id, rows.length ? 'done' : 'none']);
    return { status: rows.length ? 'done' : 'none', relations: rows.length };
  } catch (err) {
    console.error(`company_relations extraction failed for item ${item && item.id}: ${err.message}`);
    return { status: 'error', relations: 0 };
  }
}

function extractRelationsInBackground(item) {
  if (process.env.COMPANY_RELATIONS === 'off') return;
  extractRelationsForItem(item).catch(() => {});
}

// item_facts.parent -> 'owns' rows (no AI call).
async function seedFromFacts() {
  const { rows } = await pool.query(
    `SELECT DISTINCT ON (LOWER(f.parent), LOWER(f.entity)) f.parent, f.entity, f.item_id FROM item_facts f
      WHERE f.parent IS NOT NULL AND f.entity_type = '기업' AND LOWER(f.parent) <> LOWER(f.entity)`
  );
  let n = 0;
  for (const r of rows) n += await storeRelations([{ src: r.parent, dst: r.entity, relation: 'owns', share_pct: null, evidence: null }], r.item_id, 'facts');
  return n;
}

// Re-extract the relations of every item whose stored evidence mentions one of the names (after a naming fix): the AI rows of
// those items are deleted and the items go back into the backfill queue. Manual rows stay.
async function requeueByEvidence(names) {
  const pats = (names || []).map((n) => `%${String(n).trim()}%`).filter((p) => p.length > 4);
  if (!pats.length) return { items: 0 };
  const { rows } = await pool.query("SELECT DISTINCT item_id FROM company_relations WHERE item_id IS NOT NULL AND origin = 'ai' AND (evidence ILIKE ANY($1) OR src ILIKE ANY($1) OR dst ILIKE ANY($1))", [pats]);
  const ids = rows.map((r) => r.item_id);
  if (ids.length) {
    await pool.query("DELETE FROM company_relations WHERE item_id = ANY($1) AND origin = 'ai'", [ids]);
    await pool.query('UPDATE items SET relations_status = NULL WHERE id = ANY($1)', [ids]);
  }
  return { items: ids.length };
}

const status = { running: false, startedAt: null, finishedAt: null, total: 0, done: 0, withRelations: 0, relations: 0, errors: 0 };
async function runBackfill({ limit = 300 } = {}) {
  if (status.running) return { started: false, reason: 'already_running' };
  const { rows } = await pool.query(
    `SELECT id, title, summary, ai_summary, insight, ai_insight FROM items WHERE status = 'Published' AND relations_status IS NULL
      ORDER BY published_at DESC NULLS LAST, id DESC LIMIT $1`, [Math.min(Number(limit) || 300, 2000)]
  );
  Object.assign(status, { running: true, startedAt: new Date().toISOString(), finishedAt: null, total: rows.length, done: 0, withRelations: 0, relations: 0, errors: 0 });
  (async () => {
    try {
      const canon = await canonicalizer();
      for (const item of rows) {
        const r = await extractRelationsForItem(item, { canon });
        status.done++;
        if (r.status === 'done') { status.withRelations++; status.relations += r.relations; } else if (r.status === 'error') status.errors++;
      }
    } finally {
      status.running = false;
      status.finishedAt = new Date().toISOString();
      console.log(`company_relations backfill completed ${JSON.stringify(status)}`);
    }
  })();
  return { started: true, total: rows.length };
}

// Relations touching any of the names (either side), for prompts and the API.
async function relationsFor(names, { limit = 60 } = {}) {
  const list = [...new Set((names || []).map((n) => String(n || '').trim().toLowerCase()).filter(Boolean))].slice(0, 20);
  if (!list.length) return [];
  const { rows } = await pool.query(
    `SELECT r.id, r.src, r.dst, r.relation, r.share_pct, r.evidence, r.origin, r.item_id, r.status, r.ended_note FROM company_relations r
      WHERE LOWER(r.src) = ANY($1) OR LOWER(r.dst) = ANY($1) ORDER BY r.relation, r.src, r.dst LIMIT $2`, [list, limit]
  );
  return rows;
}

const describeBase = (r) => {
  const pct = r.share_pct ? ` ${Number(r.share_pct)}%` : '';
  return { owns: `${r.src}는 ${r.dst}의 모회사${pct}`, stake: `${r.src}는 ${r.dst} 지분 보유${pct}`, jv_partner: `${r.src}와 ${r.dst}는 합작 파트너`, supplies: `${r.src}는 ${r.dst}에 공급`, contractor_for: `${r.src}는 ${r.dst}의 하청·시공`, offtake_from: `${r.src}는 ${r.dst}로부터 구매` }[r.relation];
};

const describe = (r) => `${describeBase(r)}${r.status === 'ended' ? ' (종료)' : ''}`;

// A short block for the answer prompt: only relations stored for the companies the question is about.
function promptBlock(rowsAll) {
  const rows = rowsAll.filter((r) => r.status !== 'ended');
  const ended = rowsAll.filter((r) => r.status === 'ended');
  const endedBlock = ended.length ? `\n\n[종료된 관계 — 과거 이력일 뿐이므로 현재 구조·관계도·밸류체인에는 넣지 않고, 필요하면 "과거에는 …였으나 종료됨"으로만 언급한다]\n${ended.map((r) => `- ${describeBase(r)}${r.ended_note ? ` — ${r.ended_note}` : ''}`).join('\n')}` : '';
  if (!rows.length) return endedBlock;
  return `\n\n[기업 관계 DB — 질문 기업의 자회사·관계기업·합작·공급·하청 관계(기사에서 확인된 것만). 이 관계는 답변에서 소속·합작 구분과 중복 합산 방지에 사용하고, DB에 없는 관계는 추정하지 않는다]\n${rows.map((r) => `- ${describe(r)}`).join('\n')}${endedBlock}`;
}

module.exports = { isAggregateName, requeueByEvidence, baseKey, isNonCompanyName, fixRelation, cleanupRelations, RELATIONS, LABEL, parseRelations, verifyRelations, extractRelationsForItem, extractRelationsInBackground, seedFromFacts, runBackfill, getStatus: () => status, relationsFor, promptBlock, describe, storeRelations };
