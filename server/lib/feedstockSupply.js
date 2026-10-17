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

const PROMPT_NOTE = '\n\n[질의 유형: 원료 공급업체] 찾는 대상은 UCO 배출처(식당·식품공장 등)의 폐식용유를 집적해 바이오연료 생산자 등에 직접 유통·판매하는 공급업체다(수거 자체에 초점을 두지 않는다). 자료에 나온 기업을 이 기준으로 나누어 표나 소제목으로 제시한다: (1) 집적·직접 유통 공급업체(핵심: 여러 배출처의 UCO를 모아 자기 명의로 공급·수출·판매; 공급 계약·파트너십·수출 계획·수거망 구축 기사에서 공급자 쪽에 해당하는 기업 포함, 예: FatHopes Energy, PVOIL/PVOIL Trans, Restaurant Technologies) (2) 트레이더·중개(물량을 사고팔지만 집적 기반이 불분명, 예: UCO Trading) (3) 수거·물류 전문(공급 계약 없이 수거·운송만). 각 기업은 근거 문장과 함께 한 곳에만 넣고, 어느 분류인지 자료로 판단되지 않으면 "분류 불명"으로 따로 둔다. 해당 기업이 없는 분류는 아예 쓰지 않는다("해당 사항 없음" 표기 금지). 기사에서 공급자로 확인되는 기업을 엄격한 기준으로 빠뜨리지 않는다. 배출처(예: Sheetz 같은 식당 체인)와 UCO를 원료로 쓰는 생산 기업(SAF·HVO·재생디젤 공장; 예: 에코세레스/EcoCeres, Neste, Cepsa, Eni, Diamond Green Diesel)은 일부 직접 조달하더라도 나열하지 않으며, "제외 대상" 표나 목록으로도 보여주지 않고 언급 자체를 하지 않는다. 다른 기업에 UCO를 대는 공급자(예: Neste에 말레이시아 UCO를 공급하는 Evergreen Oil & Feed)는 분류 불명이 아니라 (1) 또는 (2)에 넣는다. 공급업체가 자료에 없으면 없다고만 말하고 어떤 역할의 기업을 찾는지 되묻는다.';

module.exports = { isFeedstockSupplyQuestion, retrievalHint, PROMPT_NOTE };
