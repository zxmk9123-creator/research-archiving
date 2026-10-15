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

function validateBrief(raw, evidenceIds) {
  const validIds = new Set(evidenceIds.map(Number));
  const developments = Array.isArray(raw.developments) ? raw.developments : [];
  const normalizedDevelopments = developments.slice(0, 5).map((entry) => {
    const itemId = Number(entry && entry.item_id);
    if (!validIds.has(itemId)) return null;
    const summary = String(entry.summary || '').trim();
    const significance = String(entry.significance || '').trim();
    if (!summary || !significance) return null;
    return { item_id: itemId, summary: summary.slice(0, 500), significance: significance.slice(0, 400) };
  }).filter(Boolean);

  const watchpoints = (Array.isArray(raw.watchpoints) ? raw.watchpoints : [])
    .map((value) => String(value || '').trim()).filter(Boolean).slice(0, 4).map((value) => value.slice(0, 250));
  const lead = String(raw.lead || '').trim();
  const marketSummary = String(raw.market_summary || '').trim();
  if (!lead || !marketSummary || !normalizedDevelopments.length) throw new Error('incomplete_brief');
  return {
    lead: lead.slice(0, 500),
    market_summary: marketSummary.slice(0, 800),
    developments: normalizedDevelopments,
    watchpoints,
  };
}

async function buildDailyBrief(briefDate, windowStart, windowEnd) {
  // Include material collected during today's KST collection window plus
  // items published on one of the seven KST calendar dates ending today.
  // Use noon UTC for calendar arithmetic so converting back to YYYY-MM-DD
  // does not shift the KST date to the previous UTC day.
  const recentPublishedSince = new Date(`${briefDate}T12:00:00Z`);
  recentPublishedSince.setUTCDate(recentPublishedSince.getUTCDate() - 6);
  const { rows: items } = await pool.query(
    `SELECT i.id, i.title, i.source_url, i.published_at, i.collected_at,
            COALESCE(i.summary, i.ai_summary, '') AS summary,
            COALESCE(i.insight, i.ai_insight, '') AS insight,
            s.name AS source_name
       FROM items i
       LEFT JOIN sources s ON s.id = i.source_id
      WHERE i.status = 'Published'
        AND ((i.collected_at >= $1 AND i.collected_at < $2)
          OR (i.published_at >= $3::date AND i.published_at <= $4::date))
      ORDER BY CASE WHEN i.collected_at >= $1 AND i.collected_at < $2 THEN 0 ELSE 1 END,
               i.collected_at DESC, i.id DESC
      LIMIT $5`,
    [windowStart, windowEnd, recentPublishedSince.toISOString().slice(0, 10), briefDate, MAX_EVIDENCE_ITEMS]
  );
  const itemIds = items.map((item) => Number(item.id));
  if (!items.length) {
    await pool.query(
      `UPDATE daily_briefs
          SET status = 'empty',
              item_count = CASE WHEN brief IS NULL THEN 0 ELSE item_count END,
              error = NULL, updated_at = now(), completed_at = now()
        WHERE brief_date = $1 AND status = 'generating'`,
      [briefDate]
    );
    return;
  }

  const evidence = items.map((item) => ({
    item_id: Number(item.id),
    title: String(item.title || '').slice(0, 300),
    source: String(item.source_name || '출처 미상').slice(0, 120),
    published_at: item.published_at ? new Date(item.published_at).toISOString() : null,
    collected_at: item.collected_at ? new Date(item.collected_at).toISOString() : null,
    selection_basis: item.collected_at >= windowStart && item.collected_at < windowEnd
      ? '오늘 수집'
      : '최근 7일 내 발행',
    summary: String(item.summary || '').slice(0, 700),
    insight: String(item.insight || '').slice(0, 500),
  }));

  const system = [
    '당신은 식용유지·유지종자·바이오연료·물류·규제 분야의 한국어 데일리 브리프 편집자다.',
    '반드시 입력 자료만 근거로 삼고, 기사에 없는 수치·인과·전망을 만들지 않는다.',
    '서로 다른 기사의 내용을 합쳐 하나의 사실처럼 쓰지 않는다. 날짜가 오래되거나 불명확하면 단정하지 않는다.',
    '중요한 변화와 의사결정 영향 위주로 짧게 쓴다. 유의미한 시사점이 불명확하면 watchpoints를 비운다.',
    'JSON 객체만 출력한다. 형식: {"lead":"한 문장 핵심","market_summary":"오늘 자료 묶음의 관찰 요약","developments":[{"item_id":정수,"summary":"확인된 사실","significance":"이 자료가 주목할 이유"}],"watchpoints":["후속 확인할 사항"]}',
    'developments는 최대 5개, watchpoints는 최대 4개다. developments.item_id는 입력 item_id만 사용한다.',
    'lead와 market_summary, 모든 배열 문자열은 한국어로 쓴다.',
  ].join('\n');
  const user = `보고일(KST): ${briefDate}\n선정 기준: 오늘 수집된 자료 또는 최근 7개 KST 날짜 내 발행된 자료\n자료:\n${JSON.stringify(evidence)}`;

  const raw = parseJsonObject(await callProvider({ system, user }));
  const brief = validateBrief(raw, itemIds);
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

  buildDailyBrief(briefDate, new Date(claimed.window_start), new Date(claimed.window_end))
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
