const pool = require('../db/pool');
const { callProvider } = require('./ai/provider');

const JOB_NAME = 'daily_headlines_brief';
const MAX_EVIDENCE_ITEMS = 24;
const GENERATION_STALE_AFTER_MINUTES = 25;
const MAX_DAILY_GENERATION_ATTEMPTS = 3;

function kstDate(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now);
  const get = (type) => parts.find((part) => part.type === type).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function parseJsonObject(text) {
  const cleaned = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const parsed = JSON.parse(cleaned);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid_brief_json');
  return parsed;
}

function validateBrief(raw, evidence) {
  const evidenceById = new Map(evidence.map((item) => [Number(item.item_id), item.selection_basis]));
  const developments = Array.isArray(raw.developments) ? raw.developments : [];
  const seenIds = new Set();
  const normalizedDevelopments = developments.map((entry) => {
    const itemId = Number(entry && entry.item_id);
    if (!evidenceById.has(itemId)) return null;
    const importance = Number(entry && entry.importance);
    if (!Number.isInteger(importance) || importance < 4 || importance > 5 || seenIds.has(itemId)) return null;
    const summary = String(entry.summary || '').trim();
    const significance = String(entry.significance || '').trim();
    if (!summary || !significance) return null;
    seenIds.add(itemId);
    return { item_id: itemId, summary: summary.slice(0, 500), significance: significance.slice(0, 400), importance };
  }).filter(Boolean)
    .sort((a, b) => b.importance - a.importance)
    .slice(0, 5)
    .map(({ importance, ...entry }) => entry);

  if (normalizedDevelopments.length) {
    const selectedIds = new Set(normalizedDevelopments.map((item) => item.item_id));
    const hasTodayStory = [...selectedIds].some((id) => evidenceById.get(id) === 'today_published');
    const hasRecentStory = [...selectedIds].some((id) => evidenceById.get(id) === 'recent_published');
    if (!hasTodayStory || !hasRecentStory) throw new Error('brief_missing_required_date_cohort');
  }

  const watchpoints = (Array.isArray(raw.watchpoints) ? raw.watchpoints : [])
    .map((value) => String(value || '').trim()).filter(Boolean).slice(0, 4).map((value) => value.slice(0, 250));
  const lead = String(raw.lead || '').trim();
  const marketSummary = String(raw.market_summary || '').trim();
  if (!lead || !marketSummary) throw new Error('incomplete_brief');
  return {
    lead: lead.slice(0, 500),
    market_summary: marketSummary.slice(0, 800),
    developments: normalizedDevelopments,
    watchpoints,
  };
}async function buildDailyBrief(briefDate) {
  // Use disjoint publication-date cohorts so today's collection volume
  // cannot crowd out stories published earlier in the current week.
  // Use noon UTC for calendar arithmetic so converting back to YYYY-MM-DD
  // does not shift the KST date to the previous UTC day.
  const recentPublishedSince = new Date(`${briefDate}T12:00:00Z`);
  recentPublishedSince.setUTCDate(recentPublishedSince.getUTCDate() - 6);
  const { rows: items } = await pool.query(
    `WITH today_published AS (
       SELECT i.id, i.title, i.source_url, i.published_at, i.collected_at,
              COALESCE(i.summary, i.ai_summary, '') AS summary,
              COALESCE(i.insight, i.ai_insight, '') AS insight,
              s.name AS source_name, 'today_published'::text AS selection_basis, 1 AS date_priority
         FROM items i
         LEFT JOIN sources s ON s.id = i.source_id
        WHERE i.status = 'Published' AND i.published_at = $1::date
        ORDER BY i.collected_at DESC, i.id DESC
        LIMIT 12
     ), recent_published AS (
       SELECT i.id, i.title, i.source_url, i.published_at, i.collected_at,
              COALESCE(i.summary, i.ai_summary, '') AS summary,
              COALESCE(i.insight, i.ai_insight, '') AS insight,
              s.name AS source_name, 'recent_published'::text AS selection_basis, 2 AS date_priority
         FROM items i
         LEFT JOIN sources s ON s.id = i.source_id
        WHERE i.status = 'Published'
          AND i.published_at >= $2::date AND i.published_at < $1::date
        ORDER BY i.published_at DESC, i.collected_at DESC, i.id DESC
        LIMIT 12
     )
     SELECT * FROM (
       SELECT * FROM today_published
       UNION ALL
       SELECT * FROM recent_published
     ) AS selected
     ORDER BY date_priority, published_at DESC, collected_at DESC NULLS LAST, id DESC
     LIMIT $3`,
    [briefDate, recentPublishedSince.toISOString().slice(0, 10), MAX_EVIDENCE_ITEMS]
  );
  const itemIds = items.map((item) => Number(item.id));
  const hasTodayPublished = items.some((item) => item.selection_basis === 'today_published');
  const hasRecentPublished = items.some((item) => item.selection_basis === 'recent_published');
  if (!hasTodayPublished || !hasRecentPublished) {
    await pool.query(
      `UPDATE daily_briefs
          SET status = 'empty', item_count = $2, source_item_ids = $3,
              error = $4, updated_at = now(), completed_at = now()
        WHERE brief_date = $1 AND status = 'generating'`,
      [
        briefDate,
        items.length,
        JSON.stringify(itemIds),
        !hasTodayPublished && !hasRecentPublished
          ? 'missing_today_and_recent_published_items'
          : !hasTodayPublished ? 'missing_today_published_items' : 'missing_recent_published_items',
      ]
    );
    return;
  }

  const evidence = items.map((item) => ({
    item_id: Number(item.id),
    title: String(item.title || '').slice(0, 300),
    source: String(item.source_name || '출처 미상').slice(0, 120),
    published_at: item.published_at ? new Date(item.published_at).toISOString() : null,
    selection_basis: item.selection_basis === 'today_published' ? '오늘 발행' : '최근 7일 내 발행(오늘 제외)',
    summary: String(item.summary || '').slice(0, 700),
    insight: String(item.insight || '').slice(0, 500),
  }));

  const system = [
    '당신은 식용유지·유지종자·바이오연료·물류·규제 분야의 한국어 데일리 브리프 편집자다.',
    '반드시 입력 자료만 근거로 삼고, 기사에 없는 수치·인과·전망을 만들지 않는다.',
    '서로 다른 기사의 내용을 합쳐 하나의 사실처럼 쓰지 않는다. 날짜가 오래되거나 불명확하면 단정하지 않는다.',
    '오늘 발행 자료를 1순위로 평가하고, 그 다음 직전 6일 발행 자료를 검토한다. 두 날짜 범위 자료를 모두 입력으로 받는다.',
    '가격·수급·생산·투자·정책·규제·확정 계약 등 실질적 변화를 보인 자료만 주목 후보로 삼는다. 일반 동향, 단순 행사 공지, 반복 보도, 광고성 시장규모 페이지, 영향이 불명확한 자료는 제외한다.',
    '각 후보의 중요도를 1~5 정수로 평가한다. 중요도 4 이상만 developments에 넣고 최대 5개까지만 고른다. 기준을 통과하는 자료가 적으면 5개를 채우지 말고 적은 수만 출력한다. 하나도 없으면 빈 배열을 출력한다.',
    '중요도 기준을 통과하는 주목 자료가 하나라도 있으면 오늘 발행 자료와 직전 6일 발행 자료를 각각 최소 1개 포함하고, 오늘 발행 자료를 먼저 배치한다. 한쪽 기간에 기준 통과 자료가 없다면 기준을 낮춰 채우지 말고 developments를 빈 배열로 출력한다.',
    'JSON 객체만 출력한다. 형식: {"lead":"한 문장 핵심","market_summary":"오늘 자료 묶음의 관찰 요약","developments":[{"item_id":정수,"importance":1~5,"summary":"확인된 사실","significance":"이 자료가 주목할 이유"}],"watchpoints":["후속 확인할 사항"]}',
    'developments는 중요도 4 이상, 최대 5개, watchpoints는 최대 4개다. developments.item_id는 입력 item_id만 사용하고 중복 선택하지 않는다.',
    'lead와 market_summary, 모든 배열 문자열은 한국어로 쓴다.',
  ].join('\\n');
  const user = `보고일(KST): ${briefDate}\n선정 기준: 1순위 오늘 발행, 2순위 직전 6일 발행(오늘 제외). 양 기간 자료를 모두 제공함.\n자료:\n${JSON.stringify(evidence)}`;

  const raw = parseJsonObject(await callProvider({ system, user }));
  const brief = validateBrief(raw, evidence);
  await pool.query(
    `UPDATE daily_briefs
        SET status = 'ready', brief = $2, item_count = $3, source_item_ids = $4,
            error = NULL, updated_at = now(), completed_at = now()
      WHERE brief_date = $1 AND status = 'generating'`,
    [briefDate, JSON.stringify(brief), items.length, JSON.stringify(itemIds)]
  );
}
// Claims the KST report date in Postgres before starting work, so a daily
// cron retry, an in-process scheduler tick, and a manual retry cannot all
// issue duplicate LLM requests. A crashed 'generating' row is reclaimable
// only after a bounded lease expires.
async function queueDailyBriefGeneration(now = new Date(), { force = false } = {}) {
  const briefDate = kstDate(now);
  const windowEnd = now;
  // The brief is a KST daily product. Use midnight in Seoul through the
  // collection-completion time, rather than a rolling 24-hour window.
  const windowStart = new Date(`${briefDate}T00:00:00+09:00`);
  const { rows } = await pool.query(
    `INSERT INTO daily_briefs
       (brief_date, status, window_start, window_end, attempt_count)
     VALUES ($1, 'generating', $2, $3, 1)
     ON CONFLICT (brief_date) DO UPDATE
       SET status = 'generating', window_start = EXCLUDED.window_start,
           window_end = EXCLUDED.window_end, error = NULL,
           attempt_count = daily_briefs.attempt_count + 1, updated_at = now()
       WHERE (
          NOT $5::boolean
          AND (daily_briefs.status IN ('failed','empty')
            OR (daily_briefs.status = 'generating'
                AND daily_briefs.updated_at < now() - ($4::text || ' minutes')::interval))
       ) OR (
          $5::boolean
          AND daily_briefs.attempt_count < $6
          AND (daily_briefs.status IN ('failed','empty','ready')
            OR (daily_briefs.status = 'generating'
                AND daily_briefs.updated_at < now() - ($4::text || ' minutes')::interval))
       )
     RETURNING brief_date, window_start, window_end`,
    [briefDate, windowStart, windowEnd, GENERATION_STALE_AFTER_MINUTES, Boolean(force), MAX_DAILY_GENERATION_ATTEMPTS]
  );
  const claimed = rows[0];
  if (!claimed) {
    const { rows: existing } = await pool.query(
      `SELECT brief_date, status, item_count, attempt_count, completed_at
         FROM daily_briefs WHERE brief_date = $1`, [briefDate]
    );
    const current = existing[0] || null;
    const reason = force && Number(current?.attempt_count || 0) >= MAX_DAILY_GENERATION_ATTEMPTS
      ? 'daily_attempt_limit_reached'
      : 'already_running_or_not_retryable';
    return { started: false, reason, current };
  }

  buildDailyBrief(briefDate)
    .catch(async (err) => {
      console.error(`daily_brief generation failed date=${briefDate}: ${err.message}`);
      await pool.query(
        `UPDATE daily_briefs SET status = 'failed', error = $2, updated_at = now(), completed_at = now()
          WHERE brief_date = $1 AND status = 'generating'`,
        [briefDate, String(err.message || 'generation_failed').slice(0, 500)]
      ).catch((updateErr) => console.error(`daily_brief failure state update failed: ${updateErr.message}`));
    });
  return { started: true, briefDate };
}

// A direct command trigger uses the same DB-backed generator as the routine,
// without starting collection or ingestion.
async function requestDailyBriefRegeneration(now = new Date()) {
  return queueDailyBriefGeneration(now, { force: true });
}

async function getLatestDailyBrief() {
  const { rows } = await pool.query(
    `SELECT brief_date, status, window_start, window_end, item_count,
            source_item_ids, brief, error, attempt_count, created_at, updated_at, completed_at
       FROM daily_briefs ORDER BY brief_date DESC LIMIT 1`
  );
  const brief = rows[0];
  if (!brief) return null;
  const sourceIds = Array.isArray(brief.source_item_ids)
    ? brief.source_item_ids.map(Number).filter((id) => Number.isSafeInteger(id) && id > 0)
    : [];
  if (sourceIds.length) {
    const { rows: sources } = await pool.query(
      `SELECT id AS item_id, title, source_url
         FROM items
        WHERE id = ANY($1::bigint[])`,
      [sourceIds]
    );
    const sourceById = new Map(sources.map((source) => [Number(source.item_id), source]));
    brief.sources = sourceIds.map((id) => sourceById.get(id)).filter(Boolean);
  } else {
    brief.sources = [];
  }
  return brief;
}

module.exports = { kstDate, queueDailyBriefGeneration, requestDailyBriefRegeneration, getLatestDailyBrief };
