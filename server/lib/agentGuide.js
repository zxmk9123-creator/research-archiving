// AGENT LAYER of the chatbot. Besides answering from the archive, the assistant (1) explains the platform itself and what it can do for
// the person ("Oil&Fat Research Center는 무슨 플랫폼이야?", "뭘 할 수 있어?", greetings) WITHOUT searching or calling a model, always closing with a
// question that offers next steps, and (2) attaches clickable follow-up questions to ordinary answers. Everything here is fixed, editor-written
// text: no figures, dates or company facts. Follow-ups are plain questions: choosing one simply asks it.
const glossary = require('./glossary');

const IDENTITY = /((oil\s*&?\s*(and\s*)?fats?|research\s*center|리서치\s*센터|유지\s*리서치)[^?]{0,24}(뭐|무슨|무엇|어떤|소개|설명))|((무슨|어떤)\s*(플랫폼|사이트|서비스|곳|도구))|(뭐\s*하는\s*(곳|사이트|플랫폼|서비스))|(이\s*(플랫폼|사이트|서비스)[^?]{0,10}(뭐|소개|설명))/i;
const HELP = /((뭘|무엇을|뭐를|어떤\s*것을?)\s*(할\s*수|도와|물어))|(어떻게\s*(사용|써|쓰|이용|시작))|(사용\s*(법|방법))|(도와\s*줘|도움\s*(이\s*)?(필요|줘))|(할\s*수\s*있는\s*(게|것|기능))|(기능\s*(이|을)?\s*(뭐|알려|소개))/i;
const GREET = /^\s*(안녕(하세요)?|하이|헬로|hello|hi|hey)[\s!?.~]*$/i;

const ABOUT = [
  '**Oil&Fat Research Center**는 팜유·대두유·유채씨유·해바라기유 같은 유지(油脂) 시장과, 바이오디젤·HVO·SAF 등 관련 연료·규제 동향을 한곳에 모아 보여 주는 리서치 플랫폼입니다.',
  '',
  '- **자료 아카이브**: 뉴스·리포트·통계·규제 자료를 매일 수집해 정리합니다.',
  '- **오늘의 헤드라인**: 수집된 자료를 바탕으로 하루 핵심 흐름을 요약합니다.',
  '- **AI 검색(지금 대화)**: 아카이브에 담긴 자료만 근거로 답하고, 출처를 함께 보여 줍니다.',
  '- **무역통계**: UN Comtrade 기준 수출입 통계를 품목·국가별로 조회합니다.',
  '- **레퍼런스**: 유지·바이오연료 용어와 기관·규제 개념을 짧게 설명합니다.',
].join('\n');
const CAPABILITIES = [
  '제가 도와드릴 수 있는 일은 이렇습니다.',
  '',
  '- **시장 동향 파악**: 품목(팜유·대두유 등)이나 주제(바이오연료, 수출세 등)별 최근 자료를 요약해 드립니다.',
  '- **용어·개념 설명**: 모르는 용어가 있으면 개념부터 풀어 드리고, 오타가 있으면 비슷한 용어를 찾아 드립니다.',
  '- **자료 비교·정리**: 두 가지를 비교하거나 표로 정리해 달라고 하셔도 됩니다.',
  '- **다음 단계 안내**: 무역통계 조회, 오늘의 헤드라인 보기 등 플랫폼 기능으로 이어 드립니다.',
  '',
  '답변은 아카이브에 있는 자료를 근거로 하며, 자료가 부족하면 부족하다고 말씀드립니다.',
].join('\n');

const ASK_BACK = '\n\n**어떤 도움이 필요하세요?** 아래에서 고르시거나, 궁금한 품목·주제를 그대로 입력해 주세요.';
const STARTERS = [
  { label: '오늘의 유지 시장 동향', question: '오늘 수집된 자료 기준으로 유지 시장 주요 동향을 정리해줘' },
  { label: '용어 설명 듣기', question: 'HVO와 FAME의 차이를 설명해줘' },
  { label: '팜유 최근 자료', question: '팜유 관련 최근 자료를 요약해줘' },
  { label: '무역통계는 어떻게 보나요?', question: '무역통계 메뉴는 어떻게 사용하나요?' },
];

// { answer, followups } for platform / help / greeting questions, else null.
function guideFor(question) {
  const q = String(question || '').trim();
  if (!q || q.length > 80) return null;
  if (GREET.test(q)) return { answer: `안녕하세요! 유지 시장 리서치를 도와드리는 **Oil&Fat Research Center** 어시스턴트입니다.${ASK_BACK}`, followups: STARTERS };
  if (IDENTITY.test(q)) return { answer: `${ABOUT}${ASK_BACK}`, followups: STARTERS };
  if (HELP.test(q) && q.length <= 40 && !glossary.mentionedCards(q, 1).length) return { answer: `${CAPABILITIES}${ASK_BACK}`, followups: STARTERS };
  if (/무역\s*통계.*(어떻게|사용|쓰|방법)/.test(q)) {
    return {
      answer: '**무역통계** 메뉴에서 UN Comtrade 기준 수출입 통계를 볼 수 있습니다.\n\n- 수출국·수입국(기본은 전체 국가), 품목, 기간 단위(월·분기·연)를 고른 뒤 조회합니다.\n- 일부 기간을 받지 못했다면 달력 버튼으로 추가 기간을 조회할 수 있습니다. 시간이 걸릴 수 있어요.\n- 표시되는 값은 신고국이 보고한 수출입 기준입니다.\n\n**원하시는 품목이나 국가가 있으면 알려 주세요.** 어떤 자료를 함께 보면 좋을지 안내해 드릴게요.',
      followups: [{ label: '팜유 관련 최근 자료', question: '팜유 관련 최근 자료를 요약해줘' }, { label: '대두유 시장 동향', question: '대두유 시장 동향을 정리해줘' }],
    };
  }
  return null;
}

// Up to two follow-up questions for an ordinary answer, from the glossary terms the question mentions (editor-written, deterministic).
function followupsFor(question) {
  const cards = glossary.mentionedCards(question, 1);
  if (!cards.length) return [];
  const n = cards[0].name;
  return [
    { label: `${n} 최근 동향`, question: `${n}의 최근 동향을 자료 기준으로 정리해줘` },
    { label: `${n} 관련 규제·정책`, question: `${n}와 관련된 규제나 정책 소식이 있어?` },
  ];
}

module.exports = { guideFor, followupsFor };
