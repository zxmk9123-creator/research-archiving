// UPSTREAM FEEDSTOCK-SUPPLY QUESTIONS ("UCO 수거업체", "원료 공급업체", "트레이더"): the asker wants the companies that
// collect / aggregate / trade the feedstock — not the plants that consume it. Archive articles never say "수거업체",
// they say "UCO supply / feedstock deal / trading partnership", so retrieval needs those words, and the answer must not
// be replaced by a list of producers when none of the supply side is found.
const CUE = /(수거|집하|원료\s*(?:공급|조달|확보)|원료\s*업체|공급\s*업체|조달\s*업체|트레이더|트레이딩\s*업체|collector|collection|aggregator|feedstock\s*(?:supplier|trader|provider)|\bUCO\s*(?:supplier|trader)|rendere)/i;
const FEEDSTOCK = /(UCO|폐식용유|used cooking oil|동물성|tallow|POME|폐유|feedstock|원료)/i;

function isFeedstockSupplyQuestion(q) {
  const s = String(q || '');
  return CUE.test(s) && FEEDSTOCK.test(s);
}

function retrievalHint(q) {
  return isFeedstockSupplyQuestion(q) ? `${q} UCO supply feedstock supplier collector trading partnership used cooking oil` : q;
}

const PROMPT_NOTE = '\n\n[질의 유형: 원료 공급망(수거·집하·트레이딩)] 질문자가 찾는 것은 원료를 모아 공급하거나 거래하는 후방산업 기업이다. 그 원료를 사용하는 생산 기업(SAF·HVO·재생디젤 공장; 예: 에코세레스/EcoCeres, Neste, Cepsa, Eni, Diamond Green Diesel)은 원료를 직접 일부 조달하더라도 이 질문의 답으로 나열하지 않는다. 자료에 원료 공급·수거·트레이딩 기업이 있으면(예: UCO 공급 계약·파트너십의 공급자 쪽) 그 기업만 근거와 함께 정리하고, 없으면 없다고만 말하며 어떤 역할의 기업을 찾는지 되묻는다.';

module.exports = { isFeedstockSupplyQuestion, retrievalHint, PROMPT_NOTE };
