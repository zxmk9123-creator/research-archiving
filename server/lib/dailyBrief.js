const pool = require('../db/pool');
const { callProvider } = require('./ai/provider');

const JOB_NAME = 'daily_headlines_brief';
const MAX_EVIDENCE_ITEMS = 24;
const GENERATION_STALE_AFTER_MINUTES = 25;
const MAX_AUTOMATIC_RETRIES = 5;
const RETRY_BASE_DELAY_MS = 5_000;
const RETRY_MAX_DELAY_MS = 60_000;

function kstDate(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now);
  const get = (type) => parts.find((part) => part.type === type).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function parseJsonObject(text) {
  const cleaned = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const start = cleaned.indexOf('{');
  if (start < 0) throw new Error('invalid_brief_json');
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = start; index < cleaned.length; index += 1) {
    const character = cleaned[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') quoted = true;
    else if (character === '{') depth += 1;
    else if (character === '}') {
      depth -= 1;
      if (depth === 0) {
        const parsed = JSON.parse(cleaned.slice(start, index + 1));
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid_brief_json');
        return parsed;
      }
    }
  }
  throw new Error('invalid_brief_json');
}

function validateBrief(raw, evidence) {
  const evidenceById = new Map(evidence.map((item) => [Number(item.item_id), item]));
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
    return { item_id: itemId, summary: summary.slice(0, 500).replace(/[.。]+$/u, ''), significance: significance.slice(0, 400).replace(/[.。]+$/u, ''), importance };
  }).filter(Boolean)
    .sort((a, b) => {
      const aEvidence = evidenceById.get(a.item_id);
      const bEvidence = evidenceById.get(b.item_id);
      const byPublicationDate = String(bEvidence.published_at || '').localeCompare(String(aEvidence.published_at || ''));
      if (byPublicationDate) return byPublicationDate;
      const byCollectionTime = String(bEvidence.collected_at || '').localeCompare(String(aEvidence.collected_at || ''));
      return byCollectionTime || b.importance - a.importance;
    })
    .slice(0, 5)
    .map(({ importance, ...entry }) => entry);

  const watchpoints = (Array.isArray(raw.watchpoints) ? raw.watchpoints : [])
    .map((value) => String(value || '').trim()).filter(Boolean).slice(0, 4).map((value) => value.slice(0, 250));
  const lead = String(raw.lead || '').trim().replace(/[.。]+$/u, '');
  const marketSummary = String(raw.market_summary || '').trim();
  if (!lead || !marketSummary) throw new Error('incomplete_brief');
  if (lead.length > 150) throw new Error('headline_lead_too_long');
  const briefText = [
    lead, marketSummary,
    ...normalizedDevelopments.flatMap((item) => [item.summary, item.significance]),
    ...watchpoints,
  ].join(' ');
  if (/[\\u0E00-\\u0E7F\\u3040-\\u30FF\\u3400-\\u4DBF\\u4E00-\\u9FFF]/u.test(briefText)) {
    throw new Error('unexpected_non_korean_script');
  }
  return {
    lead: lead.slice(0, 500).replace(/[.。]+$/u, ''),
    market_summary: marketSummary.slice(0, 800),
    developments: normalizedDevelopments,
    watchpoints,
  };
}async function buildDailyBriefAttempt(briefDate) {
  // Only consider items collected during this KST day and published in the
  // seven calendar days ending today. Newer publication dates rank first.
  const recentPublishedSince = new Date(`${briefDate}T12:00:00Z`);
  recentPublishedSince.setUTCDate(recentPublishedSince.getUTCDate() - 6);
  const collectionWindowStart = new Date(`${briefDate}T00:00:00+09:00`);
  const collectionWindowEnd = new Date(`${briefDate}T23:59:59.999+09:00`);
  const publicationWindowEnd = new Date(`${briefDate}T12:00:00Z`);
  publicationWindowEnd.setUTCDate(publicationWindowEnd.getUTCDate() + 1);
  const { rows: items } = await pool.query(
    `SELECT i.id, i.title, i.source_url, i.published_at, i.collected_at,
            COALESCE(i.summary, i.ai_summary, '') AS summary,
            COALESCE(i.insight, i.ai_insight, '') AS insight,
            s.name AS source_name
       FROM items i
       LEFT JOIN sources s ON s.id = i.source_id
      WHERE i.status = 'Published'
        AND i.collected_at >= $1::timestamptz AND i.collected_at <= $2::timestamptz
        AND i.published_at >= $3::date AND i.published_at < $4::date
      ORDER BY i.published_at DESC, i.collected_at DESC, i.id DESC
      LIMIT $5`,
    [
      collectionWindowStart,
      collectionWindowEnd,
      recentPublishedSince.toISOString().slice(0, 10),
      publicationWindowEnd.toISOString().slice(0, 10),
      MAX_EVIDENCE_ITEMS,
    ]
  );
  const itemIds = items.map((item) => Number(item.id));
  if (!items.length) {
    const emptyBrief = {
      lead: '오늘 수집된 자료 중 최근 7일 내 발행 조건을 충족하는 자료가 없습니다.',
      market_summary: '확인된 대상 자료가 없어 시장 변화를 요약하지 않았습니다.',
      developments: [],
      watchpoints: [],
    };
    await pool.query(
      `UPDATE daily_briefs
          SET status = 'ready', brief = $2, item_count = 0, source_item_ids = '[]'::jsonb,
              error = NULL, updated_at = now(), completed_at = now()
        WHERE brief_date = $1 AND status = 'generating'`,
      [briefDate, JSON.stringify(emptyBrief)]
    );
    return;
  }

  const evidence = items.map((item) => ({
    item_id: Number(item.id),
    title: String(item.title || '').slice(0, 300),
    source: String(item.source_name || '출처 미상').slice(0, 120),
    published_at: item.published_at ? new Date(item.published_at).toISOString() : null,
    collected_at: item.collected_at ? new Date(item.collected_at).toISOString() : null,
    summary: String(item.summary || '').slice(0, 700),
    insight: String(item.insight || '').slice(0, 500),
  }));

  const system = [
    '당신은 식용유지·유지종자·바이오연료·물류·규제 분야의 한국어 데일리 브리프 편집자다.',
    '반드시 입력 자료만 근거로 삼고, 기사에 없는 수치·인과·전망을 만들지 않는다.',
    '서로 다른 기사의 내용을 합쳐 하나의 사실처럼 쓰지 않는다. 날짜가 오래되거나 불명확하면 단정하지 않는다.',
    '입력 자료는 모두 오늘 수집되었고 최근 7일(오늘 포함) 내 발행된 자료다. 발행일이 가장 최근인 자료부터 우선 검토하고, 결과도 발행일 최신순으로 정렬한다.',
    'lead는 150자 이내의 짧은 헤드라인 한 문장으로 쓴다. 가장 중요한 확인 사실 하나를 중심으로 쓰고, 직접 관련이 없는 자료를 쉼표로 나열하지 않는다. 사건·수치·정책·계약 등 관찰된 변화만 쓰며 “~한 하루”, 과장·비유·관용구, 평가성 결론은 금지한다. 중국어·일본어·태국어 문자를 섞지 말고, lead 끝에 온점을 붙이지 않는다.',
    '가격·수급·생산·투자·정책·규제·확정 계약 등 실질적 변화를 보인 자료만 주목 후보로 삼는다. 일반 동향, 단순 행사 공지, 반복 보도, 광고성 시장규모 페이지, 영향이 불명확한 자료는 제외한다.',
    '각 후보의 중요도를 1~5 정수로 평가한다. 중요도 4 이상만 developments에 넣고 최대 5개까지만 고른다. 기준을 통과하는 자료가 적으면 5개를 채우지 말고 적은 수만 출력한다. 하나도 없으면 빈 배열을 출력한다.',
    '중요도 기준을 통과하는 자료만 developments에 넣는다. 날짜 범위별 최소 개수 조건은 없다. 자료가 적거나 기준을 통과하지 못하면 5개 미만 또는 빈 배열을 출력한다. summary와 significance는 한국어로 사실 및 시사점만 작성하고 끝에 온점을 붙이지 않는다. 중국어·일본어·태국어 문자를 섞지 않는다.',
    'JSON 객체만 출력한다. 형식: {"lead":"한 문장 핵심","market_summary":"오늘 자료 묶음의 관찰 요약","developments":[{"item_id":정수,"importance":1~5,"summary":"확인된 사실","significance":"이 자료가 주목할 이유"}],"watchpoints":["후속 확인할 사항"]}',
    'developments는 중요도 4 이상, 최대 5개, watchpoints는 최대 4개다. developments.item_id는 입력 item_id만 사용하고 중복 선택하지 않는다.',
    'lead와 market_summary, 모든 배열 문자열은 한국어로 쓴다.',
  ].join('\n');
  const user = `보고일(KST): ${briefDate}\n선정 기준: 오늘 수집되었으며 최근 7일(오늘 포함) 내 발행된 자료. 발행일 최신순으로 검토 및 정렬.\n자료:\n${JSON.stringify(evidence)}`;

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
async function buildDailyBrief(briefDate) {
  let failureCount = 0;
  while (true) {
    try {
      await buildDailyBriefAttempt(briefDate);
      return;
    } catch (err) {
      failureCount += 1;
      const exhausted = failureCount > MAX_AUTOMATIC_RETRIES;
      const delayMs = Math.min(
        RETRY_MAX_DELAY_MS,
        RETRY_BASE_DELAY_MS * (2 ** Math.min(failureCount - 1, 4))
      );
      const message = String(err.message || 'generation_failed').slice(0, 500);
      console.error(`daily_brief attempt failed date=${briefDate} retry=${failureCount - 1} exhausted=${exhausted} delay_ms=${delayMs} error=${message}`);
      await pool.query(
        `UPDATE daily_briefs
            SET attempt_count = attempt_count + 1,
                status = CASE WHEN $3::boolean THEN 'failed' ELSE 'generating' END,
                error = $2, updated_at = now(),
                completed_at = CASE WHEN $3::boolean THEN now() ELSE completed_at END
          WHERE brief_date = $1 AND status = 'generating'`,
        [briefDate, message, exhausted]
      ).catch((updateErr) => console.error(`daily_brief retry state update failed: ${updateErr.message}`));
      if (exhausted) return;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
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
          AND (daily_briefs.status = 'failed'
            OR (daily_briefs.status = 'generating'
                AND daily_briefs.updated_at < now() - ($4::text || ' minutes')::interval))
       ) OR (
          $5::boolean
          AND (daily_briefs.status IN ('failed','empty','ready')
            OR (daily_briefs.status = 'generating'
                AND daily_briefs.updated_at < now() - ($4::text || ' minutes')::interval))
       )
     RETURNING brief_date, window_start, window_end`,
    [briefDate, windowStart, windowEnd, GENERATION_STALE_AFTER_MINUTES, Boolean(force)]
  );
  const claimed = rows[0];
  if (!claimed) {
    const { rows: existing } = await pool.query(
      `SELECT brief_date, status, item_count, attempt_count, completed_at
         FROM daily_briefs WHERE brief_date = $1`, [briefDate]
    );
    const current = existing[0] || null;
    return { started: false, reason: 'already_running_or_not_retryable', current };
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
  if (brief.brief && typeof brief.brief === 'object') {
    brief.brief.lead = String(brief.brief.lead || '').trim().replace(/[.。]+$/u, '');
    if (Array.isArray(brief.brief.developments)) {
      brief.brief.developments = brief.brief.developments.map((item) => ({
        ...item,
        summary: String(item.summary || '').trim().replace(/[.。]+$/u, ''),
        significance: String(item.significance || '').trim().replace(/[.。]+$/u, ''),
      }));
    }
  }
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
