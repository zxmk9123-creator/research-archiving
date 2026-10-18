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
Each element: {"src": string, "dst": string, "relation": "owns"|"stake"|"jv_partner"|"supplies"|"contractor_for"|"offtake_from", "share_pct": number|null, "evidence": string}
Direction: "src <relation> dst". owns = src controls / is the parent of dst (dst is its subsidiary); stake = src holds a minority or unspecified equity stake in dst (associate, investment); jv_partner = src and dst are partners of the same joint venture (use the two partner companies, never the JV itself); supplies = src supplies feedstock / product / equipment to dst; contractor_for = src is the contractor / EPC / licensor / outsourced operator doing work for dst; offtake_from = src buys / has an offtake agreement with dst as seller.
Rules: only relationships the article STATES between two named companies (not people, governments or institutions); names exactly as written in the article; "share_pct" only when a percentage is stated; "evidence" = the short phrase from the article that states it. A plant or JV entity may be dst of owns/stake. No inference, no general-knowledge additions.`;

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
    let [a, b] = [canon(src), canon(dst)];
    if (relation === 'jv_partner' && a.toLowerCase() > b.toLowerCase()) [a, b] = [b, a]; // symmetric: one row per pair
    const key = `${a.toLowerCase()}|${b.toLowerCase()}|${relation}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const pct = Number(r.share_pct);
    out.push({ src: a, dst: b, relation, share_pct: pct > 0 && pct <= 100 ? pct : null, evidence: clean(r.evidence).slice(0, 240) || null });
  }
  return out;
}

async function canonicalizer() {
  try {
    const { rows } = await pool.query('SELECT name, aliases FROM companies');
    const map = new Map();
    for (const c of rows) for (const n of [c.name, ...(c.aliases || [])]) if (n) map.set(String(n).toLowerCase().trim(), c.name);
    return (n) => map.get(String(n).toLowerCase().trim()) || n;
  } catch (_) { return (n) => n; }
}

async function storeRelations(rows, itemId, origin = 'ai') {
  let added = 0;
  for (const r of rows) {
    const res = await pool.query(
      `INSERT INTO company_relations (src, dst, relation, share_pct, evidence, item_id, origin) VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (LOWER(src), LOWER(dst), relation) DO UPDATE SET share_pct = COALESCE(company_relations.share_pct, EXCLUDED.share_pct)`,
      [r.src, r.dst, r.relation, r.share_pct, r.evidence, itemId, origin]
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
    `SELECT r.id, r.src, r.dst, r.relation, r.share_pct, r.evidence, r.origin, r.item_id FROM company_relations r
      WHERE LOWER(r.src) = ANY($1) OR LOWER(r.dst) = ANY($1) ORDER BY r.relation, r.src, r.dst LIMIT $2`, [list, limit]
  );
  return rows;
}

const describe = (r) => {
  const pct = r.share_pct ? ` ${Number(r.share_pct)}%` : '';
  return { owns: `${r.src}는 ${r.dst}의 모회사${pct}`, stake: `${r.src}는 ${r.dst} 지분 보유${pct}`, jv_partner: `${r.src}와 ${r.dst}는 합작 파트너`, supplies: `${r.src}는 ${r.dst}에 공급`, contractor_for: `${r.src}는 ${r.dst}의 하청·시공`, offtake_from: `${r.src}는 ${r.dst}로부터 구매` }[r.relation];
};

// A short block for the answer prompt: only relations stored for the companies the question is about.
function promptBlock(rows) {
  if (!rows.length) return '';
  return `\n\n[기업 관계 DB — 질문 기업의 자회사·관계기업·합작·공급·하청 관계(기사에서 확인된 것만). 이 관계는 답변에서 소속·합작 구분과 중복 합산 방지에 사용하고, DB에 없는 관계는 추정하지 않는다]\n${rows.map((r) => `- ${describe(r)}`).join('\n')}`;
}

module.exports = { RELATIONS, LABEL, parseRelations, verifyRelations, extractRelationsForItem, extractRelationsInBackground, seedFromFacts, runBackfill, getStatus: () => status, relationsFor, promptBlock, describe, storeRelations };
