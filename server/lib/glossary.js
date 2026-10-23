// BASIC-KNOWLEDGE CARDS. The chatbot answers only from archived materials, so a plain definition question ("HVO가 뭐야?")
// used to be refused whenever no archived article happened to define the term. These cards are editor-reviewed definitions
// — concepts only, never figures, dates or company facts — used (1) as the whole answer when nothing in the archive matches,
// and (2) as a labelled "기초 지식" layer in front of the archive-grounded answer. Add or fix cards here; nothing else needs to change.
const CARDS = [
  { id: 'edible', name: '식용유(식용 유지)의 종류', terms: [/(^|[^폐비])식용유(?!지)/, '식용유지', '식물성유', 'cooking oil', 'edible oil', 'vegetable oil'], def: '식용유는 원료에 따라 크게 식물성과 동물성으로 나뉩니다. 식물성에는 대두유(콩기름), 팜유, 유채씨유(카놀라유), 해바라기유, 옥수수유, 올리브유, 참기름·들기름, 코코넛유, 땅콩유 등이 있고, 동물성에는 우지, 라드(돼지 지방), 버터 등이 있습니다. 같은 유지라도 정제 정도와 지방산 조성(포화·불포화)에 따라 용도와 가격이 달라집니다. 폐식용유(UCO)는 사용 후 회수한 식용유를 가리키며 일반 식용유의 종류와는 구분됩니다.' },
  { id: 'palm', name: '팜유', terms: ['팜유', 'palm oil', '팜오일'], def: '기름야자 열매의 과육에서 짜낸 식물성 유지입니다. 상온에서 반고체 상태이며 식용유·가공식품·유지화학 제품·바이오디젤 원료로 쓰입니다. 원유 형태는 CPO(Crude Palm Oil), 정제를 거친 것은 RBD 팜유라고 부릅니다.' },
  { id: 'palm-kernel', name: '팜핵유', terms: ['팜핵유', 'palm kernel oil', 'pko'], def: '기름야자 열매의 씨앗(핵)에서 얻는 유지로, 과육에서 얻는 팜유와는 별개의 제품입니다. 라우르산 함량이 높아 제과·마가린 등 식품 용도와 비누·세제·유지화학 용도에 쓰입니다.' },
  { id: 'olein', name: '팜 올레인·스테아린', terms: ['올레인', 'olein', '스테아린', 'stearin', 'rbd'], def: '팜유를 온도에 따라 분리(분별)하면 액체 분획인 올레인과 고체 분획인 스테아린이 얻어집니다. RBD는 정제(Refined)·탈색(Bleached)·탈취(Deodorized)를 모두 거친 유지를 뜻합니다.' },
  { id: 'soy', name: '대두유', terms: ['대두유', 'soybean oil', 'soy oil', '콩기름'], def: '대두(콩)를 착유해 얻는 식물성 유지입니다. 착유 과정에서 사료용 대두박이 함께 생산되며, 식용유와 바이오디젤·재생디젤 원료로 널리 쓰입니다.' },
  { id: 'crush', name: '크러싱 마진', terms: ['크러싱', 'crush margin', '크러쉬', 'crushing'], def: '대두 등 유지종자를 착유해 얻는 기름과 박(meal)의 가치 합계에서 원료 종자 가격을 뺀 가공 마진을 말합니다. 착유업체의 수익성과 가동 의욕을 가늠하는 지표로 쓰입니다.' },
  { id: 'rapeseed', name: '유채씨유(카놀라유·채종유)', terms: ['유채씨유', '카놀라유', '채종유', '유채유', 'rapeseed oil', 'canola oil', '카놀라'], def: '유채 씨앗에서 얻는 식물성 유지입니다. 카놀라유는 에루스산과 글루코시놀레이트를 낮춘 식용 품종 유채에서 얻은 것을 가리키며, 유럽에서는 주로 rapeseed oil이라고 부릅니다. 채종유는 유채씨유의 다른 이름이고, 식용 외에 바이오디젤 원료로도 쓰입니다.' },
  { id: 'sunflower', name: '해바라기유', terms: ['해바라기유', 'sunflower oil'], def: '해바라기 씨앗에서 얻는 식물성 유지로, 주로 식용으로 쓰입니다. 흑해 지역(우크라이나·러시아)이 대표적인 공급지여서 이 지역의 작황·물류·수출 정책이 시장에 영향을 줍니다.' },
  { id: 'uco', name: 'UCO(폐식용유)', terms: ['uco', 'used cooking oil', '폐식용유'], def: '식당·식품 가공 등에서 사용한 뒤 회수한 식용유입니다. 바이오디젤(FAME)·HVO·SAF의 대표적인 폐기물계 원료이며, 원산지 추적과 진위(다른 유지 혼입) 확인이 중요한 이슈입니다.' },
  { id: 'tallow', name: 'Tallow(우지)', terms: ['tallow', '우지'], def: '소·양 등 반추동물의 지방을 가공해 얻는 동물성 유지입니다(우지는 그중 소 지방을 가리킵니다). 비누·사료·유지화학 용도 외에 바이오연료 원료로도 쓰입니다.' },
  { id: 'fame', name: '바이오디젤(FAME)', terms: ['fame', '바이오디젤', 'biodiesel', 'ucome'], def: '유지를 메탄올과 반응시켜(에스테르 교환) 만든 지방산 메틸에스테르(Fatty Acid Methyl Ester)입니다. 경유에 일정 비율로 혼합해 쓰며, UCO를 원료로 한 것은 UCOME이라고 부릅니다.' },
  { id: 'hvo', name: 'HVO(재생디젤)', terms: ['hvo', '재생디젤', 'renewable diesel'], def: '유지를 수소로 처리(수첨)해 만든 파라핀계 디젤입니다. 화학 조성이 화석 디젤과 비슷해 FAME 바이오디젤보다 혼합 제약이 적고, 저온 특성이 좋은 것으로 알려져 있습니다.' },
  { id: 'hefa', name: 'HEFA', terms: ['hefa'], def: 'Hydroprocessed Esters and Fatty Acids의 약자로, UCO·동물성 지방·식물성 유지를 수소처리해 SAF나 재생디젤(HVO)을 만드는 공정 경로입니다. 현재 SAF 상업 생산의 중심이 되는 경로입니다.' },
  { id: 'saf', name: 'SAF(지속가능항공유)', terms: ['saf', '지속가능항공유', 'sustainable aviation fuel', '바이오항공유'], def: '폐식용유·지방·바이오매스·재생전력 기반 수소와 CO₂ 등 지속가능한 원료로 만들어, 기존 제트유와 섞어 쓸 수 있는 항공 연료입니다. 주요 생산 경로로 HEFA, Alcohol-to-Jet, Fischer-Tropsch, Power-to-Liquid(e-SAF) 등이 있습니다.' },
  { id: 'mandate', name: '혼합의무', terms: ['혼합의무', '혼합 의무', '블렌딩', 'blending mandate', 'mandate'], def: '연료 공급업자에게 화석연료에 일정 비율 이상의 바이오연료나 SAF를 혼합해 공급하도록 법령으로 의무화하는 제도입니다. 해당 연료의 수요를 정책으로 만들어 원료 시장에도 영향을 줍니다.' },
  { id: 'blend-b', name: 'B30·B40 등 바이오디젤 혼합률', terms: ['b30', 'b35', 'b40', 'b50', 'b20', 'b10', '바이오디젤 혼합률'], def: '경유에 섞는 바이오디젤의 비율을 "B+숫자"로 표기한 것입니다. 예를 들어 B30은 바이오디젤 30%, 경유 70% 혼합을 뜻합니다. 팜유 생산국 등이 혼합률을 단계적으로 높이는 정책에 흔히 쓰이는 표기이며, 혼합률이 오르면 원료 유지 수요가 늘어나는 구조입니다.' },
  { id: 'export-levy', name: '유지 수출세·부과금', terms: ['수출세', '수출 부과금', '수출부과금', 'export levy', 'export tax'], def: '일부 유지·유지작물 수출국(팜유 생산국, 해바라기유를 수출하는 러시아 등)은 수출 시 세금이나 부과금을 매기고, 그 수준을 시장 가격에 연동해 조정하기도 합니다. 수출세·부과금이 오르면 해당국의 수출 경쟁력과 국제 가격, 국내 가격에 영향을 줄 수 있으며, 걷힌 재원이 바이오디젤 보조 등에 쓰이는 경우도 있습니다.' },
  { id: 'futures', name: '유지 선물시장(BMD·CBOT·DCE)', terms: ['bmd', 'cbot', 'dce', '다롄', '대련상품거래소', '말레이시아 파생상품거래소', '선물시장'], def: '유지 가격의 대표 지표가 되는 선물거래소입니다. 말레이시아 파생상품거래소(BMD)는 팜유 선물, 시카고상품거래소(CBOT)는 대두·대두유 선물, 중국 다롄상품거래소(DCE)는 팜유·대두유 등 선물이 거래되어 현물 가격 형성과 헤지에 참고됩니다.' },
  { id: 'agencies', name: 'MPOB·MPOC·GAPKI', terms: ['mpob', 'mpoc', 'gapki', '말레이시아팜유청', '말레이시아 팜유청', '말레이시아팜유위원회'], def: 'MPOB(말레이시아팜유청)는 말레이시아의 월별 생산·수출·재고 통계를 발표하는 기관이고, MPOC(말레이시아팜유위원회)는 팜유 홍보와 시장 전망을 내는 기관입니다. GAPKI는 인도네시아 팜유협회로 인도네시아의 생산·수출 통계와 업계 의견을 냅니다.' },
  { id: 'elnino', name: '엘니뇨·라니냐와 유지 작황', terms: ['엘니뇨', 'el nino', 'el niño', '라니냐'], def: '엘니뇨는 동남아시아 등에서 가뭄을 부를 수 있는 기후 현상으로, 팜 열매 수확량과 대두·해바라기·유채 등 유지작물 작황에 지역에 따라 감소 또는 증가의 영향을 줄 수 있습니다. 반대 위상인 라니냐는 동남아시아에서 강수가 늘어나는 경향이 있습니다. 팜은 영향이 시차를 두고 수확에 나타나는 것으로 알려져 있어 가격 전망에서는 기후 사건 이후 수개월 이상을 함께 봅니다.' },
  { id: 'spread', name: '팜유-대두유 스프레드', terms: ['스프레드'], def: '일반적으로 두 가격의 차이를 뜻하며, 유지 시장에서는 팜유와 대두유처럼 서로 대체될 수 있는 유지의 상대 가격을 비교할 때 씁니다. 스프레드가 달라지면 수입국과 식품·화학 업체가 어느 유지를 더 쓸지 선택이 바뀌어 수요가 이동할 수 있습니다.' },
  { id: 'iscc', name: 'ISCC', terms: ['iscc'], def: 'International Sustainability and Carbon Certification의 약자로, 바이오연료·SAF 등의 원료와 제품이 지속가능성 기준과 온실가스 감축 기준을 충족하는지 이력 추적(Chain of Custody)을 통해 인증하는 제도입니다. UCO 등 폐기물계 원료의 추적에도 쓰입니다.' },
  { id: 'red', name: 'EU RED(재생에너지 지침)', terms: ['eu red', 'red ii', 'red iii', 'renewable energy directive', '재생에너지 지침', '재생에너지지침'], def: 'EU가 운송 연료 등에서 재생에너지 사용 목표를 정하고, 바이오연료 원료의 지속가능성 기준과 간접 토지이용 변화(ILUC) 위험이 큰 원료(대표적으로 팜유)의 단계적 감축 등을 규정한 지침입니다. EU의 바이오디젤·SAF 원료 수요에 영향을 줍니다.' },
  { id: 'eudr', name: 'EUDR(EU 삼림전용방지 규정)', terms: ['eudr', '삼림전용방지', 'deforestation regulation'], def: '팜유·대두·소고기·커피·코코아·목재·고무 등 특정 상품과 그 파생품이 2020년 12월 31일 이후 삼림 벌채가 이뤄진 토지에서 생산되지 않았고 생산국 법령을 지켜 생산되었음을 실사로 입증해야 EU 시장에 출시하거나 수출할 수 있도록 한 EU 규정입니다.' },
  { id: 'rspo', name: 'RSPO', terms: ['rspo', '지속가능 팜유 인증'], def: 'Roundtable on Sustainable Palm Oil의 약자로, 환경·사회 기준을 충족한 팜유 생산·유통에 인증을 부여하는 국제 협의체이자 인증 제도입니다.' },
];

const DEFINITION_CUE = /(뭐(야|예요|에요|지|임|니|가)|무엇|뜻|의미|정의|이란|란\?|란\s*$|차이|구분|비교|설명|알려|개념|종류|what\s+is|define|difference|\bvs\.?\b|types?\s+of)/i;
const pad = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function termHit(q, term) {
  if (term instanceof RegExp) return term.test(q);
  const t = term.toLowerCase();
  return /^[a-z0-9 ]+$/.test(t) ? new RegExp(`(^|[^a-z0-9])${pad(t)}([^a-z0-9]|$)`).test(q) : q.includes(t);
}

// Cards for a definition-style question (at most `max`); [] when the question is not asking what something is.
function matchCards(question, max = 3) {
  const q = String(question || '').toLowerCase();
  if (!DEFINITION_CUE.test(q)) return [];
  return CARDS.filter((c) => c.terms.some((t) => termHit(q, t))).slice(0, max);
}

const FOOTNOTE = '※ 위 내용은 Research Center가 편집한 기초 지식이며 아카이빙 자료에 기반한 분석이 아닙니다. 시장 동향·수치는 관련 자료가 축적되면 확인할 수 있습니다.';

// The whole answer when the archive has nothing for the question.
function cardsAnswer(cards) {
  return `# 기초 지식\n${cards.map((c) => `- **${c.name}**: ${c.def}`).join('\n')}\n\n${FOOTNOTE}`;
}

// Writer-prompt block: an explicit exception to "materials only", limited to definitions, kept visibly separate from cited material.
function cardsPromptBlock(cards) {
  if (!cards.length) return '';
  return `\n\n[기초 지식 카드 — "자료만 사용" 규칙의 예외] 아래는 편집 검수된 정의이다. 답변 맨 앞에 "# 기초 지식" 섹션을 두고 카드 내용만 풀어 쓴다(카드에 없는 내용 추가 금지, [N] 인용 불필요, 수치·날짜·기업 사실은 쓰지 않는다). 이어서 "# 아카이브 근거" 섹션에는 자료로 확인되는 내용만 [N] 인용과 함께 쓴다. 카드와 자료가 어긋나면 자료를 따르고 그 사실을 한 줄로 밝힌다.\n${cards.map((c) => `- ${c.name}: ${c.def}`).join('\n')}`;
}

module.exports = { CARDS, matchCards, cardsAnswer, cardsPromptBlock };
