// ANSWER EFFORT chosen on the home chat (낮음 / 중간 / 높음). It sets how much time the answer is allowed to take and how much it says:
//  - low: fewer materials are read (the best few), the writer is told to answer briefly -> fastest, shortest
//  - medium: the unchanged default
//  - high: all retrieved materials, the writer is told to explain background, evidence and caveats in depth -> slowest, longest
const LEVELS = ['low', 'medium', 'high'];
const LOW_CANDIDATES = 6;

const normalize = (v) => (LEVELS.includes(String(v)) ? String(v) : 'medium');

function promptBlock(level) {
  if (level === 'low') return '\n\n[답변 수준: 낮음 — 간결] 사용자가 빠르고 짧은 답을 원한다. 핵심 결론을 먼저 한두 문장으로 쓰고, 근거는 3~5개 항목 이내로 간추린다. 표·긴 배경 설명·부가 논점은 생략한다(자료 인용 [N]과 수치 확인 규칙은 그대로 지킨다).';
  if (level === 'high') return '\n\n[답변 수준: 높음 — 상세] 사용자가 충분히 자세한 답을 원한다. 결론에 이어 배경, 자료별 근거, 서로 다른 의견이나 한계, 실무적 시사점을 구분해 설명한다. 자료에 없는 내용을 덧붙이지 말고, 자료가 부족한 부분은 "미확보"로 밝힌다(인용 [N]과 수치 확인 규칙은 그대로 지킨다).';
  return '';
}

module.exports = { LEVELS, LOW_CANDIDATES, normalize, promptBlock };
