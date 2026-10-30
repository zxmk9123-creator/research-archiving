const pool = require('../db/pool');
const { AsyncLocalStorage } = require('node:async_hooks');
const provider = require('./ai/provider');

// The host ends a function at its time limit no matter what is still running. A caller that knows when its invocation will be cut off
// runs the generation inside runWithDeadline(); the retry loop then decides from the time REALLY left, not from when it started itself.
const deadlineStore = new AsyncLocalStorage();
const runWithDeadline = (deadlineMs, fn) => deadlineStore.run(deadlineMs, fn);

const MAX_EVIDENCE_ITEMS = 24;
const REPAIR_EVIDENCE_ITEMS = 12;
// A live generation refreshes updated_at at every attempt (one attempt is bounded by the router's ~135 s cascade plus the retry delay, so
// well under this), so a row silent for longer than this has lost its worker (the host ended the function): reclaim it quickly.
const GENERATION_STALE_AFTER_MINUTES = 6;
const MAX_AUTOMATIC_RETRIES = 5;
// One cron invocation may run for at most 300 s on the host. Retries stop (and the row is released as 'failed' so the NEXT call picks
// it up at once) when the next one would not fit, instead of sleeping until the host kills the function and leaves the row 'generating'.
const INVOCATION_BUDGET_MS = 230_000;
const TYPICAL_ATTEMPT_MS = 60_000;
// Ceiling on automatic attempts per KST day across invocations (the forced/manual path has its own, MAX_DAILY_ATTEMPTS).
const MAX_AUTO_DAILY_ATTEMPTS = 20;
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

// Returns the end index of the balanced {...} that starts at `start` (string-aware), or -1.
function balancedObjectEnd(text, start) {
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const character = text[index];
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
      if (depth === 0) return index;
    }
  }
  return -1;
}

// Free models sometimes think out loud in the answer ("Let me analyze... the format is {"lead":..., "developments":[...]}") and give the real
// JSON afterwards. Every top-level {...} in the text is tried; the LAST one that parses and has a "lead" is the answer. Without a "lead"
// (other callers) the first object that parses is returned, as before. If nothing parses, the first candidate's parse error is thrown.
function parseJsonObject(text) {
  const cleaned = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  if (cleaned.indexOf('{') < 0) throw new Error('invalid_brief_json');
  const parsed = [];
  let firstError = null;
  let from = 0;
  while (from < cleaned.length) {
    const start = cleaned.indexOf('{', from);
    if (start < 0) break;
    const end = balancedObjectEnd(cleaned, start);
    if (end < 0) break;
    try {
      const value = JSON.parse(cleaned.slice(start, end + 1));
      if (value && typeof value === 'object' && !Array.isArray(value)) parsed.push(value);
      from = end + 1;
    } catch (err) {
      if (!firstError) firstError = err;
      from = start + 1; // a broken outer object may still hold a valid inner one
    }
  }
  if (!parsed.length) throw firstError || new Error('invalid_brief_json');
  const withLead = parsed.filter((value) => typeof value.lead === 'string');
  return withLead.length ? withLead[withLead.length - 1] : parsed[0];
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

const MIN_IMPORTANCE = 3;      // 4-5 are preferred; 3 fills the list when fewer than five reach 4
const MAX_DEVELOPMENTS = 5;
const SUMMARY_MAX = 130;       // one compressed sentence: who/what + the key figure
const SIGNIFICANCE_MAX = 90;   // one sentence: why it matters

// One sentence, cut at its own end when it is short enough, otherwise at a word boundary with an ellipsis. Trailing full stops are dropped
// (the page adds its own punctuation).
function compactSentence(text, max) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t) return '';
  const first = (t.match(/^.+?(?:[.!?。]|다\.)(?=\s|$)/u) || [t])[0].trim();
  const base = first.length <= max ? first : t;
  if (base.length <= max) return base.replace(/[.。]+$/u, '');
  const cut = base.slice(0, max);
  const at = cut.lastIndexOf(' ');
  return `${(at > max * 0.6 ? cut.slice(0, at) : cut).replace(/[\s,;:·-]+$/u, '')}…`;
}

// The summary must cover every selected development, not only the first. A development counts as covered when the summary shares a
// distinctive token with it (a number, a Latin name, or the first three letters of a Hangul word, which survives particles like 이/은/를).
// Whatever the model left out is appended from that development's own (already validated, compressed) summary, so the guarantee holds
// without another model call.
const COVERAGE_STOPWORDS = new Set(['가격', '시장', '전망', '증가', '감소', '상승', '하락', '발표', '공급', '수요', '생산', '투자', '기업', '정부', '글로벌', '이번', '올해', '대한', '통해', '위해', '있는', '따른']);
function coverageKeys(text) {
  const keys = new Set();
  for (const m of String(text || '').match(/[A-Za-z][A-Za-z0-9&-]{2,}|\d[\d,.]*%?|[가-힣]{3,}/gu) || []) {
    if (/^[가-힣]/u.test(m)) { const k = m.slice(0, 3); if (!COVERAGE_STOPWORDS.has(k)) keys.add(k); } else keys.add(m.toLowerCase());
  }
  return keys;
}
function ensureSummaryCoversDevelopments(marketSummary, developments) {
  const have = coverageKeys(marketSummary);
  let out = String(marketSummary || '').trim();
  const added = [];
  for (const d of developments) {
    const keys = coverageKeys(d.summary);
    if (![...keys].some((k) => have.has(k))) {
      const sentence = String(d.summary || '').trim().replace(/[.。]+$/u, '');
      if (!sentence) continue;
      // the model may have said the same thing in other words that share no token: never append what already stands in the text
      const squash = (t) => String(t).replace(/\s+/gu, '');
      if (squash(out).includes(squash(sentence).slice(0, 14))) continue;
      out = `${out.replace(/\s+$/u, '')}${/[.!?。]$/u.test(out) ? '' : '.'} ${sentence}.`;
      added.push(d.item_id);
    }
  }
  return { text: out, added };
}

function validateBrief(raw, evidence) {
  const evidenceById = new Map(evidence.map((item) => [Number(item.item_id), item]));
  const developments = Array.isArray(raw.developments) ? raw.developments : [];
  const seenIds = new Set();
  const normalizedDevelopments = developments.map((entry) => {
    const itemId = Number(entry && entry.item_id);
    if (!evidenceById.has(itemId)) return null;
    const importance = Number(entry && entry.importance);
    if (!Number.isInteger(importance) || importance < MIN_IMPORTANCE || importance > 5 || seenIds.has(itemId)) return null;
    const summary = String(entry.summary || '').trim();
    const significance = String(entry.significance || '').trim();
    if (!summary || !significance) return null;
    const source = evidenceById.get(itemId);
    const sourceText = [source.title, source.summary, source.insight].filter(Boolean).join(' ');
    assertSupportedCertainty(`${summary} ${significance}`, sourceText, itemId);
    seenIds.add(itemId);
    return { item_id: itemId, summary: compactSentence(summary, SUMMARY_MAX), significance: compactSentence(significance, SIGNIFICANCE_MAX), importance };
  }).filter(Boolean)
    // WHICH five: by importance first (then newest). Cutting by date first used to drop a more important older item.
    .sort((a, b) => b.importance - a.importance || String(evidenceById.get(b.item_id).published_at || '').localeCompare(String(evidenceById.get(a.item_id).published_at || '')))
    .slice(0, MAX_DEVELOPMENTS);
    // HOW they are shown: exactly that order (1 = most important, ties newest first); the lead and summary are written from the top ones.

  // TOP-UP: the page is meant to show five noteworthy materials. When the model returned fewer than the archive can supply, the remaining slots
  // are filled from the materials' own stored summary/insight (one compressed sentence each; nothing is generated), newest first.
  const wanted = Math.min(MAX_DEVELOPMENTS, evidence.length);
  if (normalizedDevelopments.length < wanted) {
    const used = new Set(normalizedDevelopments.map((d) => d.item_id));
    const spare = [...evidence].filter((e) => !used.has(Number(e.item_id)))
      .sort((a, b) => String(b.published_at || '').localeCompare(String(a.published_at || '')));
    for (const e of spare) {
      if (normalizedDevelopments.length >= wanted) break;
      const summary = compactSentence(e.summary || e.title, SUMMARY_MAX);
      const significance = compactSentence(e.insight, SIGNIFICANCE_MAX);
      if (!summary || !significance) continue; // no stored insight: nothing honest to say about why it matters
      normalizedDevelopments.push({ item_id: Number(e.item_id), summary, significance });
    }
  }
  for (const d of normalizedDevelopments) delete d.importance; // stored order is the importance order; top-ups follow, newest first

  const watchpoints = (Array.isArray(raw.watchpoints) ? raw.watchpoints : [])
    .map((value) => String(value || '').trim()).filter(Boolean).slice(0, 4).map((value) => value.slice(0, 250));
  const lead = String(raw.lead || '').trim().replace(/[.。]+$/u, '');
  const rawSummary = String(raw.market_summary || '').trim();
  if (!lead || !rawSummary) throw new Error('incomplete_brief');
  const { text: marketSummary } = ensureSummaryCoversDevelopments(rawSummary, normalizedDevelopments);
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
    market_summary: marketSummary.slice(0, 1000),
    developments: normalizedDevelopments,
    watchpoints,
  };
}// Which items may feed the headline: Published, collected during this KST day, published in the seven calendar days ending today.
// Shared with the health check so "is there anything to write a headline from?" is answered by the same rule that generation uses.
const EVIDENCE_WHERE = `i.status = 'Published'
        AND i.collected_at >= $1::timestamptz AND i.collected_at <= $2::timestamptz
        AND i.published_at >= $3::date AND i.published_at < $4::date`;
function evidenceWindow(briefDate) {
  const recentPublishedSince = new Date(`${briefDate}T12:00:00Z`);
  recentPublishedSince.setUTCDate(recentPublishedSince.getUTCDate() - 6);
  const publicationWindowEnd = new Date(`${briefDate}T12:00:00Z`);
  publicationWindowEnd.setUTCDate(publicationWindowEnd.getUTCDate() + 1);
  return [
    new Date(`${briefDate}T00:00:00+09:00`),
    new Date(`${briefDate}T23:59:59.999+09:00`),
    recentPublishedSince.toISOString().slice(0, 10),
    publicationWindowEnd.toISOString().slice(0, 10),
  ];
}
async function countEvidenceCandidates(briefDate) {
  const { rows } = await pool.query(`SELECT count(*)::int AS n FROM items i WHERE ${EVIDENCE_WHERE}`, evidenceWindow(briefDate));
  return rows[0] ? rows[0].n : 0;
}

// The model sometimes answers with the format description instead of content (`"item_id":int`, `"developments":[...]`). That is not
// parseable JSON and, unlike a random glitch, repeats on an identical prompt — so it is recognised and the next attempt says why.
const PLACEHOLDER_OUTPUT_RE = /\[\s*(?:\.{3}|…)\s*\]|"\s*:\s*(?:int|integer|string|number|정수)\s*[,}]|:\s*1~5\b/;
const REPAIR_HINT = '\n\n[재시도 안내] 직전 응답은 `[...]`, `int` 같은 자리표시자나 생략 표기를 담고 있어 무효였다. 모든 값을 입력 자료에서 뽑은 실제 내용으로 채운 완전한 JSON 객체 하나만 출력하라.';

async function buildDailyBriefAttempt(briefDate, { repairHint = false } = {}) {
  // after an invalid answer the retry gets a shorter input (the freshest items first): less to echo or elide, and the headline only uses 5
  const evidenceLimit = repairHint ? REPAIR_EVIDENCE_ITEMS : MAX_EVIDENCE_ITEMS;
  const { rows: items } = await pool.query(
    `SELECT i.id, i.title, i.source_url, i.published_at, i.collected_at,
            COALESCE(i.summary, i.ai_summary, '') AS summary,
            COALESCE(i.insight, i.ai_insight, '') AS insight,
            s.name AS source_name
       FROM items i
       LEFT JOIN sources s ON s.id = i.source_id
      WHERE ${EVIDENCE_WHERE}
      ORDER BY i.published_at DESC, i.collected_at DESC, i.id DESC
      LIMIT $5`,
    [...evidenceWindow(briefDate), evidenceLimit]
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
    'lead는 150자 이내의 헤드라인 한 문장으로 쓴다. 가장 시의성 높은(발행일이 최근이고 중요도가 높은) 자료 1~3건의 핵심 변화를 담되, 한 건으로 제한하지 않는다. 서로 직접 관련이 없는 자료는 억지로 잇지 말고 "·"나 "한편"으로 구분해 짧게 쓴다. 사건·수치·정책·계약 등 관찰된 변화만 쓰며 “~한 하루”, 과장·비유·관용구, 평가성 결론은 금지한다. 중국어·일본어·태국어 문자를 섞지 말고, lead 끝에 온점을 붙이지 않는다.',
    '가격·수급·생산·투자·정책·규제·확정 계약 등 실질적 변화를 보인 자료만 주목 후보로 삼는다. 일반 동향, 단순 행사 공지, 반복 보도, 광고성 시장규모 페이지, 영향이 불명확한 자료는 제외한다.',
    '각 후보의 중요도를 1~5 정수로 평가한다. developments는 주목할 자료 5개를 목표로 한다: 중요도 4 이상을 먼저 고르고, 5개에 못 미치면 중요도 3 자료로 채운다. 같은 사건을 다룬 자료는 하나만 고른다. 입력 자료가 5개 미만이거나 나머지가 모두 중요도 2 이하일 때만 5개 미만으로 출력하고, 무관한 자료로 억지로 채우지 않는다.',
    '각 development는 압축해서 쓴다: summary는 "누가/무엇이 + 핵심 수치"를 담은 한 문장(90자 안팎, 130자 이내), significance는 "그래서 어떤 영향인가"를 한 문장(60자 안팎, 90자 이내)이다. 배경 설명·부연·같은 말 반복 없이 수치, 주체, 영향만 쓴다. 한국어로 쓰고 끝에 온점을 붙이지 않는다. 중국어·일본어·태국어 문자를 섞지 않는다.',
    'JSON 객체만 출력한다. 모든 값은 입력 자료로 채운 실제 내용이어야 하며 `...`·`[...]`·`int` 같은 자리표시자나 생략 표기는 금지다. 형식 예시(내용은 예시를 쓰지 말고 입력 자료로 작성): {"lead":"A사가 B 공장 증설 투자를 확정했다","market_summary":"증설 소식으로 원료 수급이 빠듯해졌다. 가격 상승 압력이 커진다.","developments":[{"item_id":101,"importance":4,"summary":"A사가 연 10만 톤 규모 증설을 발표","significance":"원료 수요 확대로 가격 변동성이 커진다"}],"watchpoints":["증설 일정 확정 여부"]}',
    '문체는 브리핑이다. lead, market_summary, summary, significance는 "무슨 일이 있었는가(현상)"와 "그로 인한 영향"만 쓴다. 자료 건수·수집 경위·분류(예: "오늘 수집된 N건 중", "세 갈래", "다음과 같다")를 설명하는 서두, 수식어, 부연, 감상, 접속용 미사여구는 쓰지 않는다. market_summary는 developments에 담은 자료 전체(최대 5건)를 빠짐없이 포괄한다: 자료마다 핵심 변화와 영향을 한 문장씩, 가장 시의적인 현상부터 순서대로 쓰고, 1위 자료 하나로 채우지 않는다.',
    'developments는 중요도가 높은 순서대로(1번이 가장 중요) 나열하고, lead는 앞쪽 자료를 중심으로 쓰고 market_summary는 developments 전체를 아우른다. developments는 최대 5개(중요도 3 이상), watchpoints는 최대 4개다. developments.item_id는 입력 item_id만 사용하고 중복 선택하지 않는다.',
    'lead와 market_summary, 모든 배열 문자열은 한국어로 쓴다.',
  ].join('\n');
  const user = `보고일(KST): ${briefDate}\n선정 기준: 오늘 수집되었으며 최근 7일(오늘 포함) 내 발행된 자료. 발행일 최신순으로 검토 및 정렬.\n자료:\n${JSON.stringify(evidence)}${repairHint ? REPAIR_HINT : ''}`;

  const text = await provider.callProvider({ system, user });
  // the start of an unusable answer is kept in the attempt log: without it the cause of a repeated failure cannot be told from the message
  const withHead = (message) => `${message} | head=${String(text || '').replace(/\s+/g, ' ').slice(0, 120)}`;
  let raw;
  try {
    raw = parseJsonObject(text);
  } catch (err) {
    // name what went wrong: cut off by the token limit, a format description echoed instead of content, or plain invalid JSON
    if (/길이 제한으로 인해 중간에 잘렸/.test(String(text || ''))) throw new Error(withHead('brief_truncated_by_max_tokens'));
    if (PLACEHOLDER_OUTPUT_RE.test(String(text || ''))) throw new Error(withHead('brief_placeholder_output'));
    throw new Error(withHead(err.message));
  }
  const brief = validateBrief(raw, evidence);
  await pool.query(
    `UPDATE daily_briefs
        SET status = 'ready', brief = $2, item_count = $3, source_item_ids = $4,
            error = NULL, updated_at = now(), completed_at = now()
      WHERE brief_date = $1 AND status = 'generating'`,
    [briefDate, JSON.stringify(brief), items.length, JSON.stringify(itemIds)]
  );
}
async function buildDailyBrief(briefDate, { budgetMs = INVOCATION_BUDGET_MS, attemptMs = TYPICAL_ATTEMPT_MS, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
  const started = Date.now();
  let failureCount = 0;
  let repairHint = false;
  while (true) {
    try {
      await buildDailyBriefAttempt(briefDate, { repairHint });
      return;
    } catch (err) {
      failureCount += 1;
      const exhausted = failureCount > MAX_AUTOMATIC_RETRIES;
      const delayMs = Math.min(
        RETRY_MAX_DELAY_MS,
        RETRY_BASE_DELAY_MS * (2 ** Math.min(failureCount - 1, 4))
      );
      // not enough of this invocation is left for another delay + attempt: release the row for the next call rather than be killed mid-sleep
      const deadline = deadlineStore.getStore();
      const timeLeft = deadline ? deadline - Date.now() : budgetMs - (Date.now() - started);
      const outOfTime = !exhausted && delayMs + attemptMs > timeLeft;
      const final = exhausted || outOfTime;
      const message = String(err.message || 'generation_failed').slice(0, 480);
      console.error(`daily_brief attempt failed date=${briefDate} retry=${failureCount - 1} exhausted=${exhausted} out_of_time=${outOfTime} delay_ms=${delayMs} error=${message}`);
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
        [briefDate, outOfTime ? `retry_deferred: ${message}`.slice(0, 500) : message, final]
      ).catch((updateErr) => console.error(`daily_brief retry state update failed: ${updateErr.message}`));
      if (final) return;
      repairHint = repairHint || /brief_placeholder_output|not valid JSON|invalid_brief_json/.test(message);
      await sleep(delayMs);
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
          AND daily_briefs.attempt_count < $7
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
    [briefDate, windowStart, windowEnd, GENERATION_STALE_AFTER_MINUTES, Boolean(force), MAX_DAILY_ATTEMPTS, MAX_AUTO_DAILY_ATTEMPTS]
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

// Today's headline state, for the home status and the watchdog.
async function getBriefState(now = new Date()) {
  const { rows } = await pool.query('SELECT status, completed_at, updated_at FROM daily_briefs WHERE brief_date = $1', [kstDate(now)]);
  const row = rows[0];
  return { state: row ? row.status : 'none', completedAt: row ? row.completed_at : null, updatedAt: row ? row.updated_at : null };
}

const BRIEF_DEADLINE_HOUR_KST = 10;  // a headline exists by now even if collection is still running
// The headline is guaranteed, not hoped for. Called by the cron on every pass:
//  - collection finished (or it is past the 10:00 KST deadline) and there is no usable brief -> generate it;
//  - a ready brief is final for the day: one morning collection, one headline (no noon or later refresh).
async function ensureDailyBrief(now = new Date(), { discoveryDone = false } = {}) {
  const briefDate = kstDate(now);
  // an attempt started with less time than it needs would be cut off mid-call and leave the row 'generating'; leave the row untouched instead
  const deadline = deadlineStore.getStore();
  if (deadline && deadline - Date.now() < TYPICAL_ATTEMPT_MS) return { ran: false, reason: 'insufficient_time' };
  const hour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Seoul', hour: '2-digit', hour12: false }).format(now)) % 24;
  if (!discoveryDone && hour < BRIEF_DEADLINE_HOUR_KST) return { ran: false, reason: 'collection_running' };
  const { rows } = await pool.query('SELECT status FROM daily_briefs WHERE brief_date = $1', [briefDate]);
  const cur = rows[0];
  if (!cur || cur.status === 'failed' || cur.status === 'generating') {
    // non-force claim: starts when missing or failed, reclaims a generation stuck past its lease, leaves a live one alone
    const r = await queueDailyBriefGeneration(now);
    return { ran: r.started, reason: r.started ? 'generated' : r.reason };
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

module.exports = { countEvidenceCandidates, ensureSummaryCoversDevelopments, runWithDeadline, buildDailyBrief, PLACEHOLDER_OUTPUT_RE, MAX_AUTO_DAILY_ATTEMPTS, GENERATION_STALE_AFTER_MINUTES, validateBrief, compactSentence, ensureDailyBrief, getBriefState, kstDate, parseJsonObject, pendingBriefFor, queueDailyBriefGeneration, requestDailyBriefRegeneration, getLatestDailyBrief };
