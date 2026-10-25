const pool = require('../db/pool');
const { callProvider } = require('./ai/provider');

const MAX_EVIDENCE_ITEMS = 24;
const GENERATION_STALE_AFTER_MINUTES = 25;
const MAX_AUTOMATIC_RETRIES = 5;
// Hard ceiling on total generation attempts per KST day for the forced
// (manual) path, so repeated commands can't burn unbounded LLM calls.
const MAX_DAILY_ATTEMPTS = 10;
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


const CERTAINTY_CLAIMS = [
  {
    name: 'contract_execution',
    claim: /(?:(?:오프테이크|공급|구매|판매|장기|연료)?\s*(?:계약|합의서|합의|오프테이크)\s*(?:을|를)?\s*(?:체결|서명|맺)(?:했|하였|하고|한|됨|됐다|되었습니다)?(?!\s*(?:가능성|여부|추진|협상|예정|계획|검토|논의))|(?:MOU|MoU|양해각서)\s*(?:를)?\s*(?:체결|서명|맺)(?:했|하였|하고|한|됨|됐다|되었습니다)?(?!\s*(?:가능성|여부|추진|협상|예정|계획|검토|논의))|(?:signed|executed|concluded|entered into)\s+(?:a\s+)?(?:binding\s+)?(?:supply\s+|offtake\s+)?(?:agreement|contract|MOU)|(?:agreement|contract|MOU)\s+(?:was\s+)?(?:signed|executed|concluded)|(?:합의에 도달|합의가 타결)|reached\s+(?:a\s+)?(?:binding\s+)?agreement)/iu,
    evidence: /(?:(?:계약|합의서|합의|오프테이크|agreement|contract|offtake).{0,60}(?:체결|서명|맺|signed|executed|concluded|entered into)|(?:체결|서명|맺|signed|executed|concluded|entered into).{0,60}(?:계약|합의서|합의|오프테이크|agreement|contract|offtake)|(?:MOU|MoU|양해각서).{0,40}(?:체결|서명|signed|executed|concluded)|(?:체결|서명|signed|executed|concluded).{0,40}(?:MOU|MoU|양해각서)|합의.{0,20}(?:도달|타결)|reached.{0,30}agreement)/iu,
  },
  {
    name: 'supply_commitment',
    claim: /(?:공급|오프테이크|장기 공급).{0,24}(?:확정|확보|합의|보장)|(?:supply|offtake).{0,32}(?:confirmed|secured|guaranteed|finali[sz]ed)/iu,
    evidence: /(?:공급|오프테이크|supply|offtake).{0,60}(?:확정|확보|체결|서명|secured|signed|confirmed|guaranteed|executed)|(?:확정|확보|체결|서명|secured|signed|confirmed|guaranteed|executed).{0,60}(?:공급|오프테이크|supply|offtake)/iu,
  },
  {
    name: 'plan_finalization',
    claim: /(?:계획|일정|목표|생산능력|공급량|프로젝트).{0,24}(?:확정|최종 승인|최종 결정)(?:했|하였|됨|됐다|되었|되었습니다)?|(?:plan|schedule|target|capacity|project).{0,24}(?:confirmed|finali[sz]ed|approved)/iu,
    evidence: /(?:계획|일정|목표|생산능력|공급량|프로젝트).{0,60}(?:확정|최종 승인|최종 결정|confirmed|finali[sz]ed|approved)|(?:confirmed|finali[sz]ed|approved).{0,60}(?:plan|schedule|target|capacity|project)/iu,
  },
  {
    name: 'operation_completion',
    claim: /(?:생산을 시작|생산 개시|상업운전(?:을)? 시작|가동을 시작|가동에 들어|착공(?:을)? 시작|착공(?:했|했다|하였)|공사를 완료|완공(?:했|됐다|되었)|준공(?:했|됐다|되었)|started production|began production|commenced operations|began operations|construction began|construction completed|commissioned)/iu,
    evidence: /(?:생산을 시작|생산 개시|상업운전(?:을)? 시작|가동을 시작|가동에 들어|착공(?:을)? 시작|공사를 완료|완공|준공|began production|started production|began operations|commenced operations|construction began|construction completed|commissioned)/iu,
  },
];

function assertSupportedCertainty(claimText, sourceText, itemId) {
  for (const rule of CERTAINTY_CLAIMS) {
    if (rule.claim.test(claimText) && !rule.evidence.test(sourceText)) {
      throw new Error(`unsupported_certainty_${rule.name}${itemId ? `_item_${itemId}` : ''}`);
    }
  }
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
    const source = evidenceById.get(itemId);
    const sourceText = [source.title, source.summary, source.insight].filter(Boolean).join(' ');
    assertSupportedCertainty(`${summary} ${significance}`, sourceText, itemId);
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
  if (/\d+\s*건\s*중|수집된\s*(?:\S+\s*){0,3}자료|[두세네다]\s*갈래|다음과 같|살펴보면|확인됐다\.?$/u.test(`${lead} ${marketSummary}`)) throw new Error('meta_phrase_in_summary');
  const allEvidenceText = evidence.map((item) => [item.title, item.summary, item.insight].filter(Boolean).join(' ')).join(' ');
  assertSupportedCertainty(`${lead} ${marketSummary}`, allEvidenceText);
  if (lead.length > 150) throw new Error('headline_lead_too_long');
  const briefText = [
    lead, marketSummary,
    ...normalizedDevelopments.flatMap((item) => [item.summary, item.significance]),
    ...watchpoints,
  ].join(' ');
  if (/[\u0E00-\u0E7F\u3040-\u30FF\u3400-\u4DBF\u4E00-\u9FFF]/u.test(briefText)) {
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
    '대원칙(최우선): 헤드라인에 쓰는 자료는 (1) 보고일(KST)에 수집·적재된 자료여야 하고, (2) 기사 발행일이 보고일 포함 최근 7일 이내여야 한다. 두 조건을 모두 만족하지 않는 자료는 lead, developments, watchpoints 어디에도 근거로 쓰지 않는다. 발행일이 없거나 7일을 벗어난 자료, 보고일 이전에 수집된 자료는 입력에 있어도 제외한다.',
    '당신은 식용유지·유지종자·바이오연료·물류·규제 분야의 한국어 데일리 브리프 편집자다.',
    '반드시 입력 자료만 근거로 삼고, 기사에 없는 수치·인과·전망을 만들지 않는다.',
    '사실의 확정 수준은 원문과 동일하게 유지한다. selected/선정은 계약 체결이 아니고, proposed/제안은 확정이 아니며, negotiating/in talks/협상 중은 체결이 아니다. planned/targeting/예정은 착공·생산·가동이 시작됐다는 뜻이 아니다. 원문에 서명·체결·최종 승인·실제 착공/가동이 명시되지 않으면 그런 완료형 표현을 쓰지 말고 선정·협상 중·제안·계획·목표 등 원문의 상태를 그대로 표시한다.',
    '서로 다른 기사의 내용을 합쳐 하나의 사실처럼 쓰지 않는다. 날짜가 오래되거나 불명확하면 단정하지 않는다.',
    '입력 자료는 모두 오늘 수집되었고 최근 7일(오늘 포함) 내 발행된 자료다. 발행일이 가장 최근인 자료부터 우선 검토하고, 결과도 발행일 최신순으로 정렬한다.',
    'lead는 150자 이내의 짧은 헤드라인 한 문장으로 쓴다. 가장 중요한 확인 사실 하나를 중심으로 쓰고, 직접 관련이 없는 자료를 쉼표로 나열하지 않는다. 사건·수치·정책·계약 등 관찰된 변화만 쓰며 “~한 하루”, 과장·비유·관용구, 평가성 결론은 금지한다. 중국어·일본어·태국어 문자를 섞지 말고, lead 끝에 온점을 붙이지 않는다.',
    '가격·수급·생산·투자·정책·규제·확정 계약 등 실질적 변화를 보인 자료만 주목 후보로 삼는다. 일반 동향, 단순 행사 공지, 반복 보도, 광고성 시장규모 페이지, 영향이 불명확한 자료는 제외한다.',
    '각 후보의 중요도를 1~5 정수로 평가한다. 중요도 4 이상만 developments에 넣고 최대 5개까지만 고른다. 기준을 통과하는 자료가 적으면 5개를 채우지 말고 적은 수만 출력한다. 하나도 없으면 빈 배열을 출력한다.',
    '중요도 기준을 통과하는 자료만 developments에 넣는다. 날짜 범위별 최소 개수 조건은 없다. 자료가 적거나 기준을 통과하지 못하면 5개 미만 또는 빈 배열을 출력한다. summary와 significance는 한국어로 사실 및 시사점만 작성하고 끝에 온점을 붙이지 않는다. 중국어·일본어·태국어 문자를 섞지 않는다.',
    'JSON 객체만 출력한다. 형식: {"lead":"한 문장 핵심","market_summary":"현상→영향 순서의 2~3문장 브리핑","developments":[{"item_id":정수,"importance":1~5,"summary":"확인된 사실","significance":"이 자료가 주목할 이유"}],"watchpoints":["후속 확인할 사항"]}',
    '문체는 브리핑이다. lead, market_summary, summary, significance는 "무슨 일이 있었는가(현상)"와 "그로 인한 영향"만 쓴다. 자료 건수·수집 경위·분류(예: "오늘 수집된 N건 중", "세 갈래", "다음과 같다")를 설명하는 서두, 수식어, 부연, 감상, 접속용 미사여구는 쓰지 않는다. market_summary는 가장 시의적인 현상부터 사실과 영향을 이어서 쓴다.',
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
        'INSERT INTO daily_brief_attempts (brief_date, failure_count, exhausted, error) VALUES ($1, $2, $3, $4)',
        [briefDate, failureCount, exhausted, message]
      ).catch((logErr) => console.error(`daily_brief attempt log failed: ${logErr.message}`));
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
          AND daily_briefs.attempt_count < $6
          AND (daily_briefs.status IN ('failed','empty','ready')
            OR (daily_briefs.status = 'generating'
                AND daily_briefs.updated_at < now() - ($4::text || ' minutes')::interval))
       )
     RETURNING brief_date, window_start, window_end`,
    [briefDate, windowStart, windowEnd, GENERATION_STALE_AFTER_MINUTES, Boolean(force), MAX_DAILY_ATTEMPTS]
  );
  const claimed = rows[0];
  if (!claimed) {
    const { rows: existing } = await pool.query(
      `SELECT brief_date, status, item_count, attempt_count, completed_at
         FROM daily_briefs WHERE brief_date = $1`, [briefDate]
    );
    const current = existing[0] || null;
    if (force && current && current.attempt_count >= MAX_DAILY_ATTEMPTS) {
      return { started: false, reason: 'daily_attempt_limit_reached', current };
    }
    return { started: false, reason: 'already_running_or_not_retryable', current };
  }

  // tracked: on a serverless host the generation would otherwise be frozen the moment the response is sent
  require('./background').track(buildDailyBrief(briefDate)
    .catch(async (err) => {
      console.error(`daily_brief generation failed date=${briefDate}: ${err.message}`);
      await pool.query(
        `UPDATE daily_briefs SET status = 'failed', error = $2, updated_at = now(), completed_at = now()
          WHERE brief_date = $1 AND status = 'generating'`,
        [briefDate, String(err.message || 'generation_failed').slice(0, 500)]
      ).catch((updateErr) => console.error(`daily_brief failure state update failed: ${updateErr.message}`));
    }));
  return { started: true, briefDate };
}

// A direct command trigger uses the same DB-backed generator as the routine,
// without starting collection or ingestion.
async function requestDailyBriefRegeneration(now = new Date()) {
  return queueDailyBriefGeneration(now, { force: true });
}

// Noon refresh: items the review autopilot publishes after the morning collection are not in the first brief. The hourly cron calls
// this; from 12:00 KST it regenerates today's brief once (a brief completed before noon is stale, one completed after is not).
async function maybeRefreshDailyBriefAtNoon(now = new Date()) {
  const briefDate = kstDate(now);
  const noon = new Date(`${briefDate}T12:00:00+09:00`);
  if (now < noon) return { ran: false, reason: 'before_noon' };
  const { rows } = await pool.query('SELECT status, completed_at FROM daily_briefs WHERE brief_date = $1', [briefDate]);
  const current = rows[0];
  if (!current) return { ran: false, reason: 'no_morning_brief' };
  if (current.status === 'generating') return { ran: false, reason: 'already_running' };
  if (current.status === 'ready' && current.completed_at && new Date(current.completed_at) >= noon) {
    return { ran: false, reason: 'already_refreshed' };
  }
  const result = await queueDailyBriefGeneration(now, { force: current.status !== 'failed' });
  return { ran: result.started, reason: result.started ? 'refreshed' : result.reason };
}

// Today's headline state, for the home status and the watchdog.
async function getBriefState(now = new Date()) {
  const { rows } = await pool.query('SELECT status, completed_at FROM daily_briefs WHERE brief_date = $1', [kstDate(now)]);
  const row = rows[0];
  return { state: row ? row.status : 'none', completedAt: row ? row.completed_at : null };
}

const BRIEF_DEADLINE_HOUR_KST = 10;  // a headline exists by now even if collection is still running
const REFRESH_MIN_NEW_ITEMS = 3;     // regenerate a ready brief only when this many more eligible items exist
async function countEligibleItems(briefDate) {
  const since = new Date(`${briefDate}T12:00:00Z`);
  since.setUTCDate(since.getUTCDate() - 6);
  const until = new Date(`${briefDate}T12:00:00Z`);
  until.setUTCDate(until.getUTCDate() + 1);
  const { rows } = await pool.query(
    `SELECT count(*)::int AS n FROM items i
      WHERE i.status = 'Published' AND i.collected_at >= $1::timestamptz AND i.collected_at <= $2::timestamptz
        AND i.published_at >= $3::date AND i.published_at < $4::date`,
    [new Date(`${briefDate}T00:00:00+09:00`), new Date(`${briefDate}T23:59:59.999+09:00`), since.toISOString().slice(0, 10), until.toISOString().slice(0, 10)]
  );
  return rows[0] ? rows[0].n : 0;
}

// The headline is guaranteed, not hoped for. Called by the cron on every pass:
//  - collection finished (or it is past the 10:00 KST deadline) and there is no usable brief -> generate it;
//  - a ready brief was built from fewer items than are eligible now (items published after it was made) -> regenerate it.
async function ensureDailyBrief(now = new Date(), { discoveryDone = false } = {}) {
  const briefDate = kstDate(now);
  const hour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Seoul', hour: '2-digit', hour12: false }).format(now)) % 24;
  if (!discoveryDone && hour < BRIEF_DEADLINE_HOUR_KST) return { ran: false, reason: 'collection_running' };
  const { rows } = await pool.query('SELECT status, item_count FROM daily_briefs WHERE brief_date = $1', [briefDate]);
  const cur = rows[0];
  if (!cur || cur.status === 'failed' || cur.status === 'generating') {
    // non-force claim: starts when missing or failed, reclaims a generation stuck past its lease, leaves a live one alone
    const r = await queueDailyBriefGeneration(now);
    return { ran: r.started, reason: r.started ? 'generated' : r.reason };
  }
  const eligible = Math.min(await countEligibleItems(briefDate), MAX_EVIDENCE_ITEMS);
  if (eligible >= (cur.item_count || 0) + REFRESH_MIN_NEW_ITEMS) {
    const r = await queueDailyBriefGeneration(now, { force: true });
    return { ran: r.started, reason: r.started ? 'refreshed_more_items' : r.reason };
  }
  return { ran: false, reason: 'up_to_date' };
}

// At the KST date change the headline starts over: yesterday's brief is not shown as today's. Until today's generation begins (it
// starts when the morning collection completes) the page gets this empty "pending" state instead of the previous day's content.
function pendingBriefFor(todayKst, previousDate) {
  return {
    brief_date: todayKst, status: 'pending', window_start: null, window_end: null, item_count: 0,
    source_item_ids: [], brief: null, error: null, attempt_count: 0, sources: [], previous_brief_date: previousDate || null,
  };
}

async function getLatestDailyBrief(now = new Date()) {
  const { rows } = await pool.query(
    `SELECT brief_date, status, window_start, window_end, item_count,
            source_item_ids, brief, error, attempt_count, created_at, updated_at, completed_at
       FROM daily_briefs ORDER BY brief_date DESC LIMIT 1`
  );
  const brief = rows[0];
  if (!brief) return null;
  const todayKst = kstDate(now);
  const latestDate = brief.brief_date instanceof Date ? brief.brief_date.toISOString().slice(0, 10) : String(brief.brief_date).slice(0, 10);
  if (latestDate < todayKst) return pendingBriefFor(todayKst, latestDate);
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

module.exports = { ensureDailyBrief, getBriefState, maybeRefreshDailyBriefAtNoon, kstDate, parseJsonObject, pendingBriefFor, queueDailyBriefGeneration, requestDailyBriefRegeneration, getLatestDailyBrief };
