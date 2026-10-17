// REVIEW AUTOPILOT. The first filter already rates every collected item (eligibility + QA), yet hundreds of Draft items
// still wait for a person. This is the SECOND, automatic judgement, built so that only a small remainder needs one:
//   1. clear rejects (eligibility = false AND QA = REJECT, or a reviewer already said "not eligible") are archived
//      without a model call — unless the item looks valuable (a watched company, a quantity), then it is arbitrated;
//   2. items whose draft FAILED are re-drafted from fuller text (up to 2 attempts);
//   3. everything ambiguous (QA HOLD, eligible-but-REJECT, PASS blocked by a gate, valuable rejects) goes to an AI
//      arbiter that reads the fuller page / PDF text and decides publish | archive | human with a confidence;
//   4. "publish" means: re-draft from the fuller text and let the normal gates (QA, trust, classification) decide —
//      the gates are never bypassed; "archive" sets status = 'Archived' (restorable, never deleted);
//   5. only "human" (low confidence, important but unreadable) stays in Review, with the reason shown there.
// AUTO_REVIEW=off disables the routine; dryRun returns the decisions without writing anything.
const pool = require('../db/pool');
const provider = require('./ai/provider');
const { createLimiter } = require('./ai/concurrencyLimiter');

const ARCHIVE_MIN_CONFIDENCE = 0.6;
const PUBLISH_MIN_CONFIDENCE = 0.75;
const MAX_RETRIES = 2;
const FULL_TEXT_CHARS = 6000;
const limitArbiter = createLimiter(1, 3000);

const ARBITER_SYSTEM = `You are the second reviewer of an oils & fats market-intelligence archive (edible oils, palm/soy/rapeseed/sunflower, biofuels, SAF, feedstocks, trade, policy, plants and companies in that field).
An automatic first filter already rated the item below; decide what finally happens to it. Respond with STRICT JSON ONLY: {"decision": "publish"|"archive"|"human", "confidence": number between 0 and 1, "reason": "one concise Korean sentence"}.
- publish: it reports a concrete development (event, transaction, policy, plant, capacity, market move) with a real implication for the oils/fats/biofuel field, and the text you were given is enough to summarise it faithfully.
- archive: off-scope, a promotional / generic company or product page, a conference or webinar notice, a social-media or forum post, a standing newsletter / aggregator with nothing new, a duplicate or repost, a bare price ticker, stale news presented as current, or a page whose text is only cookie / subscription / error boilerplate.
- human: ONLY when the item looks genuinely important for the field (a named major company, a policy, a large figure) but the supplied text is too thin or contradictory for you to be confident either way. Do not use human for ordinary low-value items.
Be decisive: most items are clearly one or the other.`;

const isClearReject = (it) => (it.reviewer_eligible === false) || (it.ai_eligible === false && it.ai_qa_decision === 'REJECT');

let watchNames = { at: 0, names: [] };
async function getWatchNames() {
  if (Date.now() - watchNames.at < 10 * 60 * 1000 && watchNames.names.length) return watchNames.names;
  const { rows } = await pool.query('SELECT name, aliases FROM companies WHERE watched = true');
  watchNames = { at: Date.now(), names: rows.flatMap((r) => [r.name, ...(r.aliases || [])]).map((n) => String(n || '').toLowerCase().trim()).filter((n) => n.length >= 4) };
  return watchNames.names;
}
// A rejected item that names a watched company AND carries a quantity is worth a second look before it is archived.
function looksValuable(it, names) {
  const text = `${it.title || ''} ${it.ai_summary || it.summary || ''}`.toLowerCase();
  return /\d/.test(text) && names.some((n) => text.includes(n));
}

async function fetchFullText(it) {
  try {
    const url = it.pdf_url || it.source_url;
    if (/\.pdf(\?|$)/i.test(url || '')) {
      const { fetchPdfBuffer, extractPdfText } = require('./pdfExtract');
      const { text } = await extractPdfText(await fetchPdfBuffer(url));
      return String(text || '').replace(/\s+/g, ' ').slice(0, FULL_TEXT_CHARS);
    }
    const meta = await require('./extractMetadata').extractMetadata(it.source_url);
    return String(meta.body_text || meta.summary || '').replace(/\s+/g, ' ').slice(0, FULL_TEXT_CHARS);
  } catch (_) {
    return '';
  }
}

function parseDecision(text) {
  const raw = String(text || '');
  try {
    const o = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1));
    const decision = ['publish', 'archive', 'human'].includes(o.decision) ? o.decision : 'human';
    const confidence = Math.max(0, Math.min(1, Number(o.confidence)));
    return { decision, confidence: Number.isFinite(confidence) ? confidence : 0, reason: String(o.reason || '').slice(0, 300) };
  } catch (_) {
    return { decision: 'human', confidence: 0, reason: 'AI 판정 응답을 해석하지 못했습니다.' };
  }
}

function buildArbiterUser(it, fullText) {
  return [
    `제목: ${it.title}`,
    `출처: ${it.source_name || it.source_url} (${it.type})`,
    `발행일: ${it.published_at ? String(it.published_at).slice(0, 10) : '미확인'}`,
    it.ai_summary || it.summary ? `1차 요약: ${(it.ai_summary || it.summary).slice(0, 700)}` : null,
    `1차 적합 판정: ${it.ai_eligible === true ? '적합' : it.ai_eligible === false ? '비적합' : '미판정'} — ${(it.ai_eligibility_reason || '').slice(0, 250)}`,
    `1차 발행 점검: ${it.ai_qa_decision || '없음'} — ${(it.ai_qa_reason || '').slice(0, 250)}`,
    it.gate_hold_reason ? `자동 점검 보류 사유: ${it.gate_hold_reason}` : null,
    `페이지 본문(일부): ${fullText || '(본문을 가져오지 못함 — 제목과 1차 요약만 있음)'}`,
  ].filter(Boolean).join('\n');
}

async function setOutcome(id, outcome, reason, { status = null } = {}) {
  await pool.query(
    `UPDATE items SET auto_review = $2, auto_review_reason = $3, auto_review_at = now(), auto_review_attempts = auto_review_attempts + 1,
            status = COALESCE($4, status) WHERE id = $1`,
    [id, outcome, String(reason || '').slice(0, 300), status]
  );
}

// One item -> { id, action, reason }; writes unless dryRun.
async function reviewOne(it, { dryRun = false, names = [], arbiter = null, redraft = null } = {}) {
  const write = async (outcome, reason, opts) => { if (!dryRun) await setOutcome(it.id, outcome, reason, opts); return { id: it.id, title: it.title, action: outcome, reason }; };

  if (isClearReject(it) && !looksValuable(it, names)) {
    return write('archived', '1차 적합 판정과 발행 점검이 모두 비적합 — 자동 보관', { status: 'Archived' });
  }
  // a failed draft is retried from fuller text before anything is decided
  if (it.ai_status === 'failed' && it.ai_eligible == null && (it.auto_review_attempts || 0) < MAX_RETRIES) {
    if (dryRun) return { id: it.id, title: it.title, action: 'retry', reason: 'AI 초안 실패 — 본문을 다시 가져와 재작성' };
    const text = await fetchFullText(it);
    const r = await (redraft || regenerate)(it.id, text);
    await pool.query("UPDATE items SET auto_review = 'retry', auto_review_reason = $2, auto_review_at = now(), auto_review_attempts = auto_review_attempts + 1 WHERE id = $1 AND status = 'Draft'", [it.id, 'AI 초안 재작성 시도']);
    if (r && r.archived) return write('published', '재작성 후 자동 점검을 통과해 발행', {});
    return { id: it.id, title: it.title, action: 'retry', reason: '재작성 후 재판정 대기' };
  }

  const fullText = await fetchFullText(it);
  const verdict = await (arbiter || arbitrate)(it, fullText);
  if (verdict.decision === 'archive' && verdict.confidence >= ARCHIVE_MIN_CONFIDENCE) {
    return write('archived', `AI 2차 판정: 보관 (${verdict.confidence.toFixed(2)}) — ${verdict.reason}`, { status: 'Archived' });
  }
  if (verdict.decision === 'publish' && verdict.confidence >= PUBLISH_MIN_CONFIDENCE) {
    if (dryRun) return { id: it.id, title: it.title, action: 'published', reason: `AI 2차 판정: 발행 (${verdict.confidence.toFixed(2)}) — ${verdict.reason}` };
    const r = await (redraft || regenerate)(it.id, fullText);
    if (r && r.archived) return write('published', `AI 2차 판정: 발행 (${verdict.confidence.toFixed(2)}) — ${verdict.reason}`, {});
    return write('human', `AI는 발행으로 판정했으나 자동 점검을 통과하지 못했습니다 — ${verdict.reason}`, {});
  }
  return write('human', `AI 2차 판정 확신 부족(${verdict.decision} ${verdict.confidence.toFixed(2)}) — ${verdict.reason}`, {});
}

async function arbitrate(it, fullText) {
  const result = await limitArbiter(() => provider.callProviderWithFallback({ system: ARBITER_SYSTEM, user: buildArbiterUser(it, fullText) }));
  return parseDecision(result.text);
}

// Re-draft from the fuller text, then let the ordinary gates decide.
async function regenerate(id, fullText) {
  const aiDraft = require('./aiDraft');
  const draft = await aiDraft.generateAiDraftForItem(id, undefined, fullText || undefined);
  if (!draft.ok) return { archived: false };
  return aiDraft.applyAiDraftIfEligible(id);
}

let running = false;
const state = { lastRun: null, lastResult: null };

async function runAutopilot({ aiBudget = 8, dryRun = false, ids = null } = {}) {
  if (process.env.AUTO_REVIEW === 'off') return { skipped: 'off' };
  if (running) return { skipped: 'already_running' };
  running = true;
  const out = { archived: 0, published: 0, retry: 0, human: 0, items: [] };
  try {
    const names = await getWatchNames().catch(() => []);
    const { rows } = await pool.query(
      `SELECT i.*, s.name AS source_name FROM items i LEFT JOIN sources s ON s.id = i.source_id
        WHERE i.status = 'Draft' AND (i.auto_review IS NULL OR (i.auto_review = 'retry' AND i.auto_review_attempts < $1))
          ${ids ? 'AND i.id = ANY($3)' : ''}
        ORDER BY i.collected_at DESC LIMIT $2`,
      ids ? [MAX_RETRIES, 2000, ids] : [MAX_RETRIES, 2000]
    );
    let ai = 0;
    for (const it of rows) {
      const cheap = isClearReject(it) && !looksValuable(it, names);
      if (!cheap) { if (ai >= aiBudget) continue; ai++; }
      try {
        const r = await reviewOne(it, { dryRun, names });
        out[r.action] = (out[r.action] || 0) + 1;
        out.items.push(r);
      } catch (err) {
        console.error(`review autopilot failed for item ${it.id}: ${err.message}`);
      }
    }
    console.log(`review_autopilot ${dryRun ? 'dry-run ' : ''}${JSON.stringify({ archived: out.archived, published: out.published, retry: out.retry, human: out.human })}`);
    return out;
  } finally {
    running = false;
    state.lastRun = new Date().toISOString();
    state.lastResult = { archived: out.archived, published: out.published, retry: out.retry, human: out.human };
  }
}

async function getStatus() {
  const { rows } = await pool.query(
    `SELECT COALESCE(auto_review, CASE WHEN status = 'Draft' THEN 'pending' ELSE 'n/a' END) AS k, status, count(*)::int AS n
       FROM items WHERE status IN ('Draft','Archived') OR auto_review IS NOT NULL GROUP BY 1, 2 ORDER BY 1`
  );
  return { running, buckets: rows, ...state };
}

async function restore(id) {
  const r = await pool.query("UPDATE items SET status = 'Draft', auto_review = 'human', auto_review_reason = '사람이 복원함', auto_review_at = now() WHERE id = $1 AND status = 'Archived' RETURNING id", [id]);
  return r.rowCount > 0;
}

module.exports = { runAutopilot, reviewOne, getStatus, restore, isClearReject, looksValuable, parseDecision, buildArbiterUser, ARBITER_SYSTEM, ARCHIVE_MIN_CONFIDENCE, PUBLISH_MIN_CONFIDENCE };
