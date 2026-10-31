// 👍/👎 on AI search answers: collection of good/bad samples and a plain statistical read of what separates them.
//
// Privacy: ai_search_logs deliberately keeps no question/answer text. This table is different and opt-in per answer: a row exists ONLY because
// the reader pressed 👍/👎 on that answer, and pressing the same button again (rating 0) deletes the row.
const REASONS = {
  inaccurate: '부정확',
  irrelevant: '질문과 무관',
  too_long: '너무 김',
  too_short: '너무 짧음',
  no_sources: '출처 부족',
  other: '기타',
};
const MAX_QUESTION = 1000;
const MAX_ANSWER = 8000;
const MAX_COMMENT = 500;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const TABLE_SQL = `
CREATE TABLE IF NOT EXISTS ai_answer_feedback (
  id SERIAL PRIMARY KEY,
  request_id UUID NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  rating SMALLINT NOT NULL CHECK (rating IN (-1, 1)),
  reason TEXT,
  comment TEXT,
  question TEXT NOT NULL,
  answer TEXT NOT NULL,
  source_count INTEGER,
  is_followup BOOLEAN NOT NULL DEFAULT false,
  features JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS idx_ai_answer_feedback_created_at ON ai_answer_feedback(created_at);`;

// The table is also in schema.sql; this makes the first feedback work on a database where the schema was applied before this feature existed.
const ensured = new WeakMap();
function ensureTable(db) {
  if (!ensured.has(db)) {
    const p = db.query(TABLE_SQL).catch((err) => { ensured.delete(db); throw err; });
    ensured.set(db, p);
  }
  return ensured.get(db);
}

// Pure. Measurable properties of an answer, computed server-side so nobody can submit made-up "features".
function answerFeatures(answer, sourceCount = 0) {
  const text = String(answer || '');
  const citations = [...text.matchAll(/\[(\d{1,2})\]/g)].map((m) => m[1]);
  const letters = text.replace(/[^\p{L}]/gu, '');
  const hangul = (letters.match(/\p{Script=Hangul}/gu) || []).length;
  return {
    chars: text.length,
    paragraphs: text.split(/\n{2,}/).filter((p) => p.trim()).length,
    bullets: (text.match(/^\s*(?:[-*•]|\d+\.)\s+/gm) || []).length,
    tables: (text.match(/^\s*\|.*\|\s*$/gm) || []).length >= 2 ? 1 : 0,
    charts: (text.match(/```chart/g) || []).length,
    citations: citations.length,
    distinctCitations: new Set(citations).size,
    numbers: (text.match(/\d[\d,.]*/g) || []).length,
    hangulRatio: letters.length ? Math.round((hangul / letters.length) * 100) / 100 : 0,
    sources: Math.max(0, Number(sourceCount) || 0),
  };
}

// Pure. Returns { ok: true, value } or { ok: false, status, error }.
function validateFeedback(body = {}) {
  const requestId = String(body.requestId || '');
  if (!UUID_RE.test(requestId)) return { ok: false, status: 400, error: 'invalid_request_id' };
  const rating = Number(body.rating);
  if (![1, -1, 0].includes(rating)) return { ok: false, status: 400, error: 'invalid_rating' };
  if (rating === 0) return { ok: true, value: { requestId, rating } };
  const question = typeof body.question === 'string' ? body.question.trim().slice(0, MAX_QUESTION) : '';
  const answer = typeof body.answer === 'string' ? body.answer.trim().slice(0, MAX_ANSWER) : '';
  if (!question || !answer) return { ok: false, status: 400, error: 'question_and_answer_required' };
  let reason = null;
  if (body.reason != null && body.reason !== '') {
    if (rating !== -1 || !Object.prototype.hasOwnProperty.call(REASONS, body.reason)) return { ok: false, status: 400, error: 'invalid_reason' };
    reason = body.reason;
  }
  const comment = typeof body.comment === 'string' && body.comment.trim() ? body.comment.trim().slice(0, MAX_COMMENT) : null;
  const sourceCount = Math.min(100, Math.max(0, Math.floor(Number(body.sourceCount) || 0)));
  return { ok: true, value: { requestId, rating, reason, comment, question, answer, sourceCount, isFollowup: body.isFollowup === true } };
}

// rating 0 removes the reader's vote. Otherwise insert/update by request id, so one answer holds at most one vote.
async function saveFeedback(db, body) {
  const v = validateFeedback(body);
  if (!v.ok) return v;
  await ensureTable(db);
  const f = v.value;
  if (f.rating === 0) {
    await db.query('DELETE FROM ai_answer_feedback WHERE request_id = $1', [f.requestId]);
    return { ok: true, status: 200, saved: false };
  }
  // only answers this server actually produced can be rated (stops arbitrary text being posted into the sample set)
  const known = await db.query("SELECT 1 FROM ai_search_logs WHERE request_id = $1 AND outcome IN ('success', 'insufficient_evidence') LIMIT 1", [f.requestId]);
  if (!known.rows || !known.rows.length) return { ok: false, status: 404, error: 'unknown_request' };
  await db.query(
    `INSERT INTO ai_answer_feedback (request_id, rating, reason, comment, question, answer, source_count, is_followup, features)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)
     ON CONFLICT (request_id) DO UPDATE SET rating = EXCLUDED.rating, reason = EXCLUDED.reason, comment = EXCLUDED.comment, updated_at = now()`,
    [f.requestId, f.rating, f.reason, f.comment, f.question, f.answer, f.sourceCount, f.isFollowup, JSON.stringify(answerFeatures(f.answer, f.sourceCount))],
  );
  return { ok: true, status: 200, saved: true };
}

async function loadFeedback(db, { days = 180, limit = 5000 } = {}) {
  await ensureTable(db);
  const { rows } = await db.query(
    `SELECT request_id, created_at, rating, reason, comment, question, answer, source_count, is_followup, features
       FROM ai_answer_feedback WHERE created_at > now() - make_interval(days => $1) ORDER BY created_at DESC LIMIT $2`,
    [Math.min(3650, Math.max(1, Math.floor(Number(days)) || 180)), Math.min(20000, Math.max(1, Math.floor(Number(limit)) || 5000))],
  );
  return rows;
}

const pct = (n) => `${Math.round(n * 100)}%`;
const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const round1 = (n) => (n == null ? null : Math.round(n * 10) / 10);

// Pure. rows = feedback rows (rating, reason, features, is_followup). A finding is only reported when both sides of a comparison have enough
// votes (MIN_GROUP) and the like rates differ by at least MIN_GAP — otherwise the report says the sample is too small instead of guessing.
const MIN_GROUP = 5;
const MIN_GAP = 0.15;
function analyze(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const liked = list.filter((r) => Number(r.rating) === 1);
  const disliked = list.filter((r) => Number(r.rating) === -1);
  const total = liked.length + disliked.length;
  const likeRate = total ? liked.length / total : null;
  const feat = (r) => (r.features && typeof r.features === 'object' ? r.features : {});

  const reasons = {};
  for (const r of disliked) { const k = r.reason || 'unspecified'; reasons[k] = (reasons[k] || 0) + 1; }

  const numeric = ['chars', 'paragraphs', 'bullets', 'citations', 'distinctCitations', 'numbers', 'sources'];
  const featureMeans = numeric.map((name) => ({
    feature: name,
    liked: round1(avg(liked.map((r) => Number(feat(r)[name])).filter(Number.isFinite))),
    disliked: round1(avg(disliked.map((r) => Number(feat(r)[name])).filter(Number.isFinite))),
  }));

  // like rate inside a group of answers that share a property
  const groups = [
    { key: 'short_answer', label: '짧은 답변(400자 미만)', test: (r) => feat(r).chars < 400 },
    { key: 'long_answer', label: '긴 답변(1,500자 이상)', test: (r) => feat(r).chars >= 1500 },
    { key: 'with_table', label: '표 포함', test: (r) => feat(r).tables > 0 },
    { key: 'with_chart', label: '차트 포함', test: (r) => feat(r).charts > 0 },
    { key: 'many_citations', label: '인용 3개 이상', test: (r) => feat(r).citations >= 3 },
    { key: 'no_citations', label: '인용 없음', test: (r) => feat(r).citations === 0 },
    { key: 'followup', label: '후속 질문', test: (r) => Boolean(r.is_followup) },
  ].map((g) => {
    const inside = list.filter((r) => Number(r.rating) !== 0 && g.test(r));
    const up = inside.filter((r) => Number(r.rating) === 1).length;
    return { key: g.key, label: g.label, n: inside.length, likeRate: inside.length ? up / inside.length : null };
  });

  const findings = [];
  if (total < 30) findings.push(`표본이 ${total}건으로 적어 아래 비교는 참고용입니다 (30건 이상부터 권장).`);
  const byKey = Object.fromEntries(groups.map((g) => [g.key, g]));
  const compare = (a, b, text) => {
    const A = byKey[a]; const B = byKey[b];
    if (A.n >= MIN_GROUP && B.n >= MIN_GROUP && Math.abs(A.likeRate - B.likeRate) >= MIN_GAP) {
      const [hi, lo] = A.likeRate > B.likeRate ? [A, B] : [B, A];
      findings.push(`${text}: ${hi.label} ${pct(hi.likeRate)}(n=${hi.n}) vs ${lo.label} ${pct(lo.likeRate)}(n=${lo.n})`);
    }
  };
  compare('short_answer', 'long_answer', '답변 길이에 따른 호평률 차이');
  compare('many_citations', 'no_citations', '인용 여부에 따른 호평률 차이');
  for (const g of groups) {
    if (['with_table', 'with_chart', 'followup'].includes(g.key) && g.n >= MIN_GROUP && likeRate != null && Math.abs(g.likeRate - likeRate) >= MIN_GAP) {
      findings.push(`${g.label} 답변의 호평률 ${pct(g.likeRate)}(n=${g.n}) — 전체 ${pct(likeRate)}와 차이`);
    }
  }
  const topReason = Object.entries(reasons).sort((a, b) => b[1] - a[1])[0];
  if (topReason && topReason[1] >= 3) findings.push(`싫어요 주된 사유: ${REASONS[topReason[0]] || '미선택'} ${topReason[1]}건 (싫어요 ${disliked.length}건 중)`);

  return {
    total, liked: liked.length, disliked: disliked.length, likeRate,
    reasons: Object.fromEntries(Object.entries(reasons).map(([k, n]) => [REASONS[k] || '미선택', n])),
    featureMeans, groups, findings,
  };
}

// Newest-first liked answers as JSON lines: a seed for few-shot examples or an evaluation set (question + answer the readers approved).
function toJsonl(rows, rating = 1) {
  return rows.filter((r) => Number(r.rating) === rating).map((r) => JSON.stringify({
    question: r.question, answer: r.answer, rating: Number(r.rating), reason: r.reason || null, features: r.features || {}, at: r.created_at,
  })).join('\n');
}

// Pure. Closes the loop: the reader votes feed a regression signal. input = { recent: {up, down}, prior: {up, down} } (last 7 days vs the 21 days
// before). Warn-only (a vote count is never an outage); silent below MIN_VOTES in either window, so a quiet week yields no row.
const MIN_VOTES = 8;
const DROP_WARN = 0.2;
function answerQualityCheck(input) {
  if (!input || !input.recent || !input.prior) return [];
  const n = (w) => (Number(w.up) || 0) + (Number(w.down) || 0);
  const rate = (w) => (Number(w.up) || 0) / n(w);
  if (n(input.recent) < MIN_VOTES || n(input.prior) < MIN_VOTES) return [];
  const r = rate(input.recent); const p = rate(input.prior);
  const detail = `like rate ${pct(r)} over ${n(input.recent)} votes in the last 7 days vs ${pct(p)} over ${n(input.prior)} in the 21 days before`;
  if (p - r >= DROP_WARN) return [{ id: 'answer_quality', status: 'warn', detail: `answer quality dropped: ${detail}` }];
  return [{ id: 'answer_quality', status: 'pass', detail }];
}

// SELECT only (health checks never write): a database where the table does not exist yet makes this throw, which the caller reports as 'not collected'.
async function collectAnswerQuality(db) {
  const { rows } = await db.query(
    `SELECT count(*) FILTER (WHERE rating = 1 AND created_at > now() - interval '7 days')::int AS r_up,
            count(*) FILTER (WHERE rating = -1 AND created_at > now() - interval '7 days')::int AS r_down,
            count(*) FILTER (WHERE rating = 1 AND created_at <= now() - interval '7 days')::int AS p_up,
            count(*) FILTER (WHERE rating = -1 AND created_at <= now() - interval '7 days')::int AS p_down
       FROM ai_answer_feedback WHERE created_at > now() - interval '28 days'`);
  const r = rows[0] || {};
  return { recent: { up: r.r_up || 0, down: r.r_down || 0 }, prior: { up: r.p_up || 0, down: r.p_down || 0 } };
}

module.exports = { answerQualityCheck, collectAnswerQuality, REASONS, MAX_QUESTION, MAX_ANSWER, answerFeatures, validateFeedback, saveFeedback, loadFeedback, analyze, toJsonl, ensureTable };
