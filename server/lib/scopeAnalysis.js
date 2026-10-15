// Weekly scope-tuning analysis. Looks at what the pipeline kept vs dropped
// (discovery_exclusions, Published items, reviewer/AI-rejected items) and
// asks the LLM to PROPOSE: topics the static relevance filter wrongly
// excludes (expand), topics that keep producing rejected material (narrow),
// and new Daily Discovery search queries. Proposals are stored as 'pending'
// and change nothing until an operator approves them — nothing here edits
// the filter or sources on its own.
//
// Every LLM suggestion is re-checked against the data it was shown (an
// "expand" term must literally appear in several excluded candidates; a
// "narrow" term must appear in several rejected titles and in NO published
// title), so a hallucinated or over-broad term is dropped before it can
// even be proposed.
const pool = require('../db/pool');
// Module object (not destructured) so tests can mock the LLM call.
const provider = require('./ai/provider');
const { parseJsonObject } = require('./dailyBrief');
const { kstPartsOf } = require('./dailyDiscovery');
const { setDynamicScopeTerms } = require('./relevanceFilter');

const JOB_NAME = 'scope_analysis';
const WINDOW_DAYS = 14;
const MIN_EXCLUSIONS = 15;
const MAX_PER_KIND = 5;
const MIN_EXPAND_EVIDENCE = 2;
const MIN_NARROW_EVIDENCE = 3;

const norm = (s) => String(s || '').toLowerCase().replace(/[‐‑‒]/g, '-');
const cleanTerm = (s) => norm(s).replace(/\s+/g, ' ').trim();

async function refreshScopeTerms() {
  const { rows } = await pool.query('SELECT term, mode FROM scope_terms');
  setDynamicScopeTerms({
    include: rows.filter((r) => r.mode === 'include').map((r) => r.term),
    exclude: rows.filter((r) => r.mode === 'exclude').map((r) => r.term),
  });
  return rows.length;
}

async function gatherSignals() {
  const since = `now() - interval '${WINDOW_DAYS} days'`;
  const [excluded, published, rejected, queries] = await Promise.all([
    pool.query(
      `SELECT url, title, summary, reason, seen_count FROM discovery_exclusions
        WHERE last_seen_at > ${since} ORDER BY seen_count DESC, last_seen_at DESC LIMIT 80`
    ),
    pool.query(
      `SELECT title FROM items WHERE status = 'Published' AND collected_at > ${since}
        ORDER BY collected_at DESC LIMIT 60`
    ),
    pool.query(
      `SELECT title FROM items
        WHERE collected_at > ${since}
          AND (reviewer_eligible = false OR ai_qa_decision = 'REJECT' OR ai_eligible = false)
        ORDER BY collected_at DESC LIMIT 60`
    ),
    pool.query(`SELECT url FROM sources WHERE method = 'crawl' AND is_daily_discovery = true`),
  ]);
  return {
    excluded: excluded.rows,
    published: published.rows.map((r) => r.title),
    rejected: rejected.rows.map((r) => r.title),
    queries: queries.rows.map((r) => r.url),
  };
}

function buildPrompt(signals) {
  const system = [
    '당신은 식용유지·유지종자·바이오연료(SAF 포함)·물류·규제·주요 기업 리서치 아카이브의 수집 범위를 점검하는 분석가다.',
    '입력은 (1) 범위 필터가 제외한 후보, (2) 최근 발행된 자료 제목, (3) 검수/AI에서 부적합 판정된 자료 제목, (4) 현재 검색어 목록이다.',
    '입력에 실제로 나타난 단어·구만 제안한다. 입력에 없는 용어를 만들지 않는다.',
    'expand: 아카이브 범위에 속하는데 제외된 후보에 반복 등장하는 주제어(1~4단어, 소문자). narrow: 부적합 자료 제목에 반복되고 발행 자료 제목에는 없는 주제어. queries: 현재 검색어와 겹치지 않는 새 검색어(영어 또는 한국어).',
    'JSON 객체만 출력한다. 형식: {"expand":[{"term":"..","rationale":"한국어 한 문장"}],"narrow":[{"term":"..","rationale":".."}],"queries":[{"query":"..","rationale":".."}]}',
    `각 배열은 최대 ${MAX_PER_KIND}개. 근거가 약하면 빈 배열을 출력한다.`,
  ].join('\n');
  const user = JSON.stringify({
    excluded_candidates: signals.excluded.map((e) => ({
      title: e.title, reason: e.reason, seen_count: e.seen_count, summary: String(e.summary || '').slice(0, 160),
    })),
    published_titles: signals.published,
    rejected_titles: signals.rejected,
    current_queries: signals.queries,
  });
  return { system, user };
}

// Re-verifies every suggestion against the data the model was shown.
function validateAnalysis(raw, signals) {
  const out = [];
  const rejectedTitles = signals.rejected.map(norm);
  const publishedTitles = signals.published.map(norm);
  const existingQueries = new Set(signals.queries.map(cleanTerm));
  const seen = new Set();
  const countIn = (haystacks, term) => haystacks.filter((h) => h.includes(term)).length;

  for (const item of (Array.isArray(raw?.expand) ? raw.expand : []).slice(0, MAX_PER_KIND)) {
    const term = cleanTerm(item?.term);
    if (term.length < 3 || term.length > 40 || seen.has(`e:${term}`)) continue;
    const hits = signals.excluded.filter((e) => norm(`${e.title || ''} ${e.summary || ''}`).includes(term));
    if (hits.length < MIN_EXPAND_EVIDENCE) continue;
    seen.add(`e:${term}`);
    out.push({
      kind: 'expand_scope', term, rationale: String(item.rationale || '').slice(0, 300),
      evidence: hits.slice(0, 5).map((h) => ({ title: h.title, url: h.url })),
    });
  }
  for (const item of (Array.isArray(raw?.narrow) ? raw.narrow : []).slice(0, MAX_PER_KIND)) {
    const term = cleanTerm(item?.term);
    if (term.length < 3 || term.length > 40 || seen.has(`n:${term}`)) continue;
    if (countIn(rejectedTitles, term) < MIN_NARROW_EVIDENCE) continue;
    if (countIn(publishedTitles, term) > 0) continue;
    seen.add(`n:${term}`);
    out.push({
      kind: 'narrow_scope', term, rationale: String(item.rationale || '').slice(0, 300),
      evidence: signals.rejected.filter((t) => norm(t).includes(term)).slice(0, 5).map((t) => ({ title: t })),
    });
  }
  for (const item of (Array.isArray(raw?.queries) ? raw.queries : []).slice(0, MAX_PER_KIND)) {
    const query = String(item?.query || '').replace(/\s+/g, ' ').trim();
    const key = cleanTerm(query);
    if (query.length < 5 || query.length > 200 || existingQueries.has(key) || seen.has(`q:${key}`)) continue;
    seen.add(`q:${key}`);
    out.push({ kind: 'add_query', term: query, rationale: String(item.rationale || '').slice(0, 300), evidence: [] });
  }
  return out;
}

async function storeProposals(proposals) {
  let stored = 0;
  for (const p of proposals) {
    // Never re-propose something already decided in the last 60 days.
    const { rows: prior } = await pool.query(
      `SELECT 1 FROM scope_proposals
        WHERE kind = $1 AND lower(term) = lower($2)
          AND (status = 'pending' OR created_at > now() - interval '60 days') LIMIT 1`,
      [p.kind, p.term]
    );
    if (prior.length) continue;
    const { rowCount } = await pool.query(
      `INSERT INTO scope_proposals (kind, term, rationale, evidence) VALUES ($1, $2, $3, $4::jsonb)
       ON CONFLICT DO NOTHING`,
      [p.kind, p.term, p.rationale, JSON.stringify(p.evidence)]
    );
    stored += rowCount;
  }
  return stored;
}

async function runScopeAnalysis() {
  const signals = await gatherSignals();
  if (signals.excluded.length < MIN_EXCLUSIONS) {
    return { ran: false, reason: 'insufficient_data', excluded: signals.excluded.length, needed: MIN_EXCLUSIONS };
  }
  const { system, user } = buildPrompt(signals);
  const raw = parseJsonObject(await provider.callProvider({ system, user }));
  const proposals = validateAnalysis(raw, signals);
  const stored = await storeProposals(proposals);
  console.log(`scope_analysis completed suggested=${proposals.length} stored=${stored}`);
  return { ran: true, suggested: proposals.length, stored };
}

// Weekly automatic run: Mondays (KST) from 10:00, claimed atomically per
// week in scheduler_jobs so a redeploy/restart can't run it twice. The
// claim is released if the run throws, so a failed run is retried on the
// next tick instead of being skipped for a week.
async function maybeRunWeeklyScopeAnalysis(now = new Date()) {
  const { date, hour } = kstPartsOf(now);
  if (new Date(`${date}T00:00:00Z`).getUTCDay() !== 1 || hour < 10) return { ran: false, reason: 'not_due' };
  const { rowCount } = await pool.query(
    `INSERT INTO scheduler_jobs (job_name, last_run_date) VALUES ($1, $2)
     ON CONFLICT (job_name) DO UPDATE SET last_run_date = $2
     WHERE scheduler_jobs.last_run_date IS DISTINCT FROM $2`,
    [JOB_NAME, date]
  );
  if (!rowCount) return { ran: false, reason: 'already_ran_this_week' };
  try {
    const result = await runScopeAnalysis();
    if (!result.ran) await pool.query('UPDATE scheduler_jobs SET last_run_date = NULL WHERE job_name = $1', [JOB_NAME]);
    return result;
  } catch (err) {
    await pool.query('UPDATE scheduler_jobs SET last_run_date = NULL WHERE job_name = $1', [JOB_NAME]).catch(() => {});
    throw err;
  }
}

async function applyProposal(id) {
  const { rows } = await pool.query('SELECT * FROM scope_proposals WHERE id = $1', [id]);
  const p = rows[0];
  if (!p) return { ok: false, status: 404, error: 'not found' };
  if (p.status !== 'pending') return { ok: false, status: 409, error: `already ${p.status}` };
  if (p.kind === 'add_query') {
    await pool.query(
      `INSERT INTO sources (name, url, method, frequency_days, trust_grade, is_daily_discovery)
       SELECT $1, $2, 'crawl', 7, 'B', true
       WHERE NOT EXISTS (SELECT 1 FROM sources WHERE url = $2 AND method = 'crawl')`,
      [`Web Discovery: ${p.term.slice(0, 80)}`, p.term]
    );
  } else {
    await pool.query(
      `INSERT INTO scope_terms (term, mode, proposal_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
      [p.term, p.kind === 'expand_scope' ? 'include' : 'exclude', p.id]
    );
    await refreshScopeTerms();
  }
  await pool.query(`UPDATE scope_proposals SET status = 'applied', decided_at = now() WHERE id = $1`, [id]);
  return { ok: true };
}

// Undo for an approved term: removes it and refreshes the filter cache so
// the change takes effect immediately. The originating proposal stays
// 'applied' as history (and, via the 60-day no-re-proposal window, the same
// term isn't immediately suggested again).
async function revokeScopeTerm(id) {
  const { rowCount } = await pool.query('DELETE FROM scope_terms WHERE id = $1', [id]);
  if (!rowCount) return { ok: false, status: 404, error: 'not found' };
  await refreshScopeTerms();
  return { ok: true };
}

async function rejectProposal(id) {
  const { rowCount } = await pool.query(
    `UPDATE scope_proposals SET status = 'rejected', decided_at = now() WHERE id = $1 AND status = 'pending'`,
    [id]
  );
  return rowCount ? { ok: true } : { ok: false, status: 404, error: 'not found or already decided' };
}

module.exports = {
  refreshScopeTerms, runScopeAnalysis, maybeRunWeeklyScopeAnalysis, validateAnalysis,
  applyProposal, rejectProposal, revokeScopeTerm, MIN_EXCLUSIONS,
};
