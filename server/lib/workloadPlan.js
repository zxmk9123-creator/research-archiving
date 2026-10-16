// Pre-flight scope card for heavy requests. A request that fans out into many
// sources and extra AI calls (whole-roster completeness, verified data
// tables/charts) is not started silently: the server answers first with a
// plan — what will be covered, which steps will run, and an honest cost
// estimate — and starts only when the user confirms (optionally choosing the
// lighter "quick" scope). Light requests never see a card.
const dp = require('./datasetPipeline');
const rc = require('./requestCompliance');

const CHARS_PER_TOKEN = 2.6; // mixed Korean/English prose, conservative
const QUICK_CANDIDATES = 28;

const tokens = (chars) => Math.round(chars / CHARS_PER_TOKEN);
const round100 = (n) => Math.round(n / 100) * 100;
const human = (n) => (n >= 10000 ? `약 ${(n / 10000).toFixed(1).replace(/\.0$/, '')}만` : `약 ${n.toLocaleString('en-US')}`);

function assessWorkload({ question, candidates, required = [], expectLong = false, systemChars = 0, materialsChars = 0, extractionChars = 0, quickMaterialsChars = 0 }) {
  const req = rc.parseRequest(question);
  const dataset = dp.isDatasetRequest(req, question);
  const sweep = required.length >= 3 && req.completeness;
  const heavy = dataset || sweep || expectLong;
  if (!heavy) return { heavy: false };

  const genIn = tokens(systemChars + materialsChars) + 400;
  const exIn = dataset ? tokens(extractionChars) + 700 : 0;
  const fullOut = dataset ? 1200 : 2600;
  const exOut = dataset ? 1800 : 0;
  const full = {
    id: 'full',
    label: '전체 누락 없이',
    detail: dataset
      ? `관련 자료 ${candidates.length}건에서 업체·거점별 수치를 모두 추출하고, 값을 검증·톤 환산한 표와 차트를 만듭니다.`
      : `관련 자료 ${candidates.length}건을 모두 읽고 모든 대상을 빠짐없이 다룹니다.`,
    aiCalls: dataset ? '2~3회' : '1~2회',
    tokens: round100(genIn + exIn + fullOut + exOut),
    seconds: dataset ? '약 40~90초' : '약 25~60초',
  };
  const quickIn = tokens(systemChars + (quickMaterialsChars || materialsChars * (QUICK_CANDIDATES / Math.max(candidates.length, 1)))) + 400;
  const quick = {
    id: 'quick',
    label: '핵심 요약 (빠름)',
    detail: `상위 ${Math.min(QUICK_CANDIDATES, candidates.length)}건 중심으로 주요 대상을 간결하게 정리합니다. 빠르고 가볍게 먼저 확인하고, 필요하면 전체로 다시 요청할 수 있습니다.`,
    aiCalls: '1회',
    tokens: round100(quickIn + 2200),
    seconds: '약 15~35초',
  };
  for (const o of [full, quick]) o.tokensText = `${human(o.tokens)} 토큰`;

  const names = required.map((c) => c.name);
  return {
    heavy: true,
    plan: {
      title: '작업 범위를 확인해 주세요',
      reason: dataset
        ? '여러 업체의 수치를 모아 단위를 통일하고 표·차트로 만드는 큰 작업입니다.'
        : sweep
          ? '관심 기업 전체를 대상으로 하는 큰 작업입니다.'
          : '답변이 길어질 수 있는 요청입니다. 중간에 끊기지 않도록 범위를 먼저 정합니다.',
      scope: {
        question,
        materials: candidates.length,
        companies: names.length,
        companyNames: names.slice(0, 14),
        moreCompanies: Math.max(names.length - 14, 0),
      },
      steps: dataset
        ? ['관련 자료 검색', '업체·거점별 수치 추출 (AI)', '원문 대조 검증 · 톤 환산', '표·차트 생성', '해석 작성 (AI)']
        : ['관련 자료 검색', '대상별 자료 확인', '답변 작성 (AI)', '수치·출처 검증'],
      // the lighter, faster scope is the recommended default; the full run is one click away
      options: [quick, full],
      recommended: 'quick',
      notes: ['같은 질문은 15분간 저장되어 다시 물어도 즉시 표시됩니다.'],
    },
  };
}

module.exports = { assessWorkload, QUICK_CANDIDATES };
