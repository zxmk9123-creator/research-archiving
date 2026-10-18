// COMPANY-SPEC QUESTIONS ("업체별 스펙 비교/정리"): a spec table lists only companies that have at least one concrete
// spec, keeps status / basis year / product scope / unit apart, and never pads rows for companies without figures.
const SPEC = /(스펙|사양|제원|\bspecs?\b|specification)/i;
const COMPANY = /(업체|기업|회사|메이커|생산자|company|companies|producer)/i;

function isSpecQuestion(q) {
  const s = String(q || '');
  return SPEC.test(s) && (COMPANY.test(s) || /[A-Za-z가-힣]+\s*[,，、]\s*[A-Za-z가-힣]+/.test(s));
}

const PROMPT_NOTE = '\n\n[질의 유형: 업체별 스펙] 표에는 이 질문의 항목(생산능력·원료·제품·가동 시점 등)에 대해 자료에서 확인된 값이 하나라도 있는 업체만 넣는다. 값이 전혀 없는 업체·항공사·구매처·투자사는 행으로 만들지 않고, 그런 업체를 따로 해명하는 문장도 쓰지 않는다. 한 칸에는 값 하나만 쓴다: 현재 가동 값과 계획·목표 값, 서로 다른 단위(톤·배럴·갤런), 서로 다른 제품 범위(SAF 전용 / 재생디젤·HVO 포함)를 한 칸에 섞지 말고 열이나 행으로 분리해 "상태"와 "기준 시점"을 함께 적는다. 같은 업체·항목에 값이 여러 개면 가장 최신의 값 하나를 표에 쓰고 나머지는 표 아래 "참고" 줄에 상태·시점과 함께 적는다. 제품 범위가 확인되지 않은 값은 SAF 전용 용량으로 쓰지 않는다.';

const EMPTY = /^(?:-+|—|–|n\/a|na|미공시|미확보|미확인|없음|해당\s*없음|확인\s*불가|(?:자료에\s*)?언급\s*없음|자료에\s*없음|⚠.*)$/i;
const cellEmpty = (c) => {
  const t = String(c || '').replace(/\[\d+\]/g, '').replace(/[*_`]/g, '').trim();
  return t === '' || EMPTY.test(t);
};

// A table row whose every cell after the first is empty ("자료에 언급 없음", "-", ...) is removed.
function dropEmptyRows(text) {
  const lines = String(text || '').split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const isRow = /^\s*\|.*\|\s*$/.test(l);
    const isSep = /^\s*\|[\s:|-]+\|\s*$/.test(l);
    const prevIsTable = out.length && /^\s*\|/.test(out[out.length - 1]);
    const headerNext = /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1] || '');
    if (isRow && !isSep && prevIsTable && !headerNext) {
      const cells = l.trim().replace(/^\||\|$/g, '').split('|');
      if (cells.length >= 2 && cells.slice(1).every(cellEmpty)) continue;
    }
    out.push(l);
  }
  // lines that only explain why a non-producer has no spec
  return out.filter((l) => !/(항공사|구매처|수요처|투자사)/.test(l) || !/(스펙|수치|정보|생산)/.test(l) || !/(없|않|제공되지|언급되)/.test(l)).join('\n');
}

module.exports = { isSpecQuestion, PROMPT_NOTE, dropEmptyRows };
