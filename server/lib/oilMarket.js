// MARKET DYNAMICS FOR OPPORTUNITY QUESTIONS. "Which minor oils have potential?" cannot be answered by listing the staples: palm and soybean
// oil dominate every count. This computes, per oil, from the archive itself: how often it is mentioned (share of all oil mentions),
// whether that is rising (share of the last 90 days vs its all-time share), how many materials carry volume/price figures, and how recent
// the latest one is — and picks the evidence materials for the oils that have any. Mention counts measure ARCHIVE coverage, which follows
// what the collector searches for; they are a signal of attention, not market size, and the answer must say so.
const { OILS } = require('./oilTaxonomy');

const RECENT_DAYS = 90;
const MIN_RECENT_FOR_TREND = 2;
const FIGURE_RE = '[0-9][0-9.,]*\\s*(만|천|백만|억)?\\s*(톤|t|mt|%|달러|usd|원|ringgit|링깃)';

// rows: [{ id, mentions, recent, figures, latest }] -> annotated, ranked stats
function analyze(rows, oils = OILS) {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const base = oils.map((o) => {
    const r = byId.get(o.id) || {};
    return { id: o.id, name: o.name, tier: o.tier, mentions: Number(r.mentions) || 0, recent: Number(r.recent) || 0, figures: Number(r.figures) || 0, latest: r.latest || null };
  });
  const totalAll = base.reduce((n, o) => n + o.mentions, 0) || 1;
  const totalRecent = base.reduce((n, o) => n + o.recent, 0) || 1;
  return base.map((o) => {
    const share = o.mentions / totalAll;
    const recentShare = o.recent / totalRecent;
    let trend = 'steady';
    if (o.mentions === 0) trend = 'none';
    else if (o.recent === 0) trend = 'quiet';
    else if (o.recent >= MIN_RECENT_FOR_TREND && share > 0 && recentShare / share >= 1.3) trend = 'rising';
    else if (share > 0 && recentShare / share <= 0.7) trend = 'falling';
    const evidence = o.mentions === 0 ? 'none' : (o.mentions < 10 || o.figures < 3 || o.recent === 0 ? 'thin' : 'ok');
    return { ...o, share, recentShare, trend, evidence };
  });
}

const TREND_TEXT = { none: '언급 없음', quiet: '최근 90일 언급 없음', rising: '최근 언급 비중 상승', falling: '최근 언급 비중 하락', steady: '비중 유사' };
const EVIDENCE_TEXT = { none: '자료 없음', thin: '근거 빈약', ok: '근거 있음' };
const TIER_TEXT = { dominant: '주류', major: '2차', minor: '비주류' };
const pct = (x) => `${(x * 100).toFixed(1)}%`;
const day = (v) => (v ? new Date(v).toISOString().slice(0, 10) : '-');

// Candidate oils for the answer: everything except the dominant tier, with some archive evidence, ordered by recent attention then
// mentions then figures. Oils with no evidence are returned separately as the "data gap" list.
function rankOpportunities(stats) {
  const nonDominant = stats.filter((o) => o.tier !== 'dominant');
  const withEvidence = nonDominant.filter((o) => o.mentions > 0).sort((a, b) => b.recent - a.recent || b.mentions - a.mentions || b.figures - a.figures);
  return { ranked: withEvidence, gaps: nonDominant.filter((o) => o.mentions === 0), baseline: stats.filter((o) => o.tier === 'dominant') };
}

function evidenceBlock(stats, { recentDays = RECENT_DAYS } = {}) {
  const { ranked, gaps, baseline } = rankOpportunities(stats);
  const line = (o) => `- ${o.name} [${TIER_TEXT[o.tier]}] 아카이브 언급 ${o.mentions}건(전체 식용유 언급의 ${pct(o.share)}), 최근 ${recentDays}일 ${o.recent}건, 수치 포함 ${o.figures}건, 최신 ${day(o.latest)}, ${TREND_TEXT[o.trend]}, ${EVIDENCE_TEXT[o.evidence]}`;
  return `\n\n[시장기회 질문 — 역학관계 기준] 이 질문은 주류 품목(팜유·대두유)이 아니라 시장기회·비주류 식용유 발굴을 묻는다. 아래 수치는 아카이브에서 계산한 값이다(언급 빈도는 수집 범위의 영향을 받는 관심도 지표이지 시장 규모가 아니다).
주류 기준선(후보가 아님, 답변에서 한 줄로만 언급):
${baseline.map(line).join('\n')}
후보 품목(근거 있는 순):
${ranked.length ? ranked.map(line).join('\n') : '- (근거가 있는 비주류 품목이 없다)'}
자료 공백(아카이브에 자료 없음): ${gaps.length ? gaps.map((o) => o.name).join(', ') : '없음'}
작성 규칙: ① 핵심 이슈는 후보 품목 중 근거가 있는 2~4개만, 언급 빈도·최근성·자료에 적힌 수요·소비·수출·가격 수치 순으로 정렬해 쓴다. ② 주류 품목은 기준선 한 줄(점유 비교)로만 쓰고 이슈로 올리지 않는다. ③ 수요·소비·수출량이 자료에 없으면 "수치 미확인"이라 쓰고 추정하지 않는다. ④ 자료 공백 품목은 "아카이브 자료 없음(추가 조사 필요)"로 한 줄에 묶는다. ⑤ "근거 빈약" 품목은 자료 1~2건만으로 시장 전체를 단정하지 않는다. ⑥ 폐식용유(UCO)·SAF·바이오연료는 후보가 아니다. ⑦ 종합 판단에 "언급 빈도는 아카이브 수집 범위를 반영하며 시장 규모와 같지 않다"를 한 문장으로 밝힌다.`;
}

async function loadOilStats(pool, now = new Date(), oils = OILS) {
  const since = new Date(now.getTime() - RECENT_DAYS * 86400000).toISOString().slice(0, 10);
  const { rows } = await pool.query(
    `WITH oils(id, pat) AS (SELECT * FROM unnest($1::text[], $2::text[])),
          base AS (SELECT published_at, (title || ' ' || coalesce(summary, '') || ' ' || coalesce(ai_summary, '')) AS t FROM items WHERE status = 'Published')
     SELECT o.id,
            count(*) FILTER (WHERE b.t ~* o.pat)::int AS mentions,
            count(*) FILTER (WHERE b.t ~* o.pat AND b.published_at >= $3::date)::int AS recent,
            count(*) FILTER (WHERE b.t ~* o.pat AND b.t ~* $4)::int AS figures,
            max(b.published_at) FILTER (WHERE b.t ~* o.pat) AS latest
       FROM oils o CROSS JOIN base b GROUP BY o.id`,
    [oils.map((o) => o.id), oils.map((o) => o.pattern), since, FIGURE_RE]
  );
  return analyze(rows, oils);
}

// Evidence materials: per ranked oil (at most `oilLimit` oils) its newest materials, ones with figures first.
async function loadEvidenceItems(pool, ranked, { oilLimit = 6, perOil = 2 } = {}) {
  const oils = ranked.slice(0, oilLimit);
  const patternOf = new Map(OILS.map((o) => [o.id, o.pattern]));
  const lists = await Promise.all(oils.map(async (o) => {
    const { rows } = await pool.query(
      `SELECT i.id, i.title, i.summary, i.insight, i.ai_summary, i.ai_insight, i.published_at, s.name AS source_name, 0 AS relevance_score
         FROM items i LEFT JOIN sources s ON s.id = i.source_id
        WHERE i.status = 'Published' AND (i.title || ' ' || coalesce(i.summary, '') || ' ' || coalesce(i.ai_summary, '')) ~* $1
        ORDER BY ((i.title || ' ' || coalesce(i.summary, '')) ~* $2) DESC, i.published_at DESC NULLS LAST, i.id DESC LIMIT ${Number(perOil)}`,
      [patternOf.get(o.id), FIGURE_RE]
    );
    return rows;
  }));
  const seen = new Set();
  return lists.flat().filter((r) => (seen.has(r.id) ? false : seen.add(r.id)));
}

module.exports = { analyze, rankOpportunities, evidenceBlock, loadOilStats, loadEvidenceItems, FIGURE_RE, RECENT_DAYS };

// An edible-oil question must not be answered from waste-oil (UCO) / SAF / biofuel material. Drops materials that (a) are tagged only with
// non-edible sectors, or (b) talk about waste/non-edible products and name no edible oil at all. Applied only when the question itself is
// about edible oils (see oilTaxonomy.scopeOf).
const EDIBLE_SECTORS = ['식용유지', '팜유', '대두유', '유채씨유', '해바라기유', '기타 식용유지'];
const NON_EDIBLE_SECTORS = ['비식용유지', 'UCO', 'UCOME', 'SAF', 'Tallow', 'FAME', '기타 비식용유지'];
const { WASTE_TERMS, NON_EDIBLE_TERMS } = require('./oilTaxonomy');
const EDIBLE_OIL_RE = new RegExp(`${OILS.map((o) => o.pattern).join('|')}|(?<![폐비])식용유(?!지)|(?<!비)식용\\s*유지|식물성\\s*유|(?<!used )(?<!waste )cooking oil|edible oil|vegetable oil`, 'i');
const textOfItem = (m) => [m.title, m.summary, m.ai_summary].filter(Boolean).join(' ');

async function dropNonEdible(pool, candidates) {
  if (!candidates.length) return candidates;
  let sectorOnly = new Set();
  try {
    const { rows } = await pool.query(
      `SELECT a.item_id FROM item_sectors a JOIN sectors s ON s.id = a.sector_id WHERE a.item_id = ANY($1::bigint[])
        GROUP BY a.item_id HAVING bool_or(s.name = ANY($2)) AND NOT bool_or(s.name = ANY($3))`,
      [candidates.map((c) => c.id), NON_EDIBLE_SECTORS, EDIBLE_SECTORS]
    );
    sectorOnly = new Set(rows.map((r) => Number(r.item_id)));
  } catch (_) { /* the text rule below still applies */ }
  return candidates.filter((m) => {
    if (sectorOnly.has(Number(m.id))) return false;
    const t = textOfItem(m);
    return !((WASTE_TERMS.test(t) || NON_EDIBLE_TERMS.test(t)) && !EDIBLE_OIL_RE.test(t));
  });
}

module.exports.dropNonEdible = dropNonEdible;
