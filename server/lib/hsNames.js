// Display names for the HS levels the API does not name for us (2- and 4-digit headings of the oils-and-fats scope). 6- and 10-digit names come from
// the API rows themselves. HEADINGS is what the sync fetches: chapter 15 (animal/vegetable fats and oils) plus the closely related feedstock and
// product headings. Names are plain Korean trade terms, not official customs wording.
const HEADINGS = [
  ['1501', '돼지·가금 지방'], ['1502', '소·양 지방(우지 등)'], ['1503', '라드스테아린·라드유'], ['1504', '어류·해양포유류 유지'], ['1505', '양모지·라놀린'],
  ['1506', '기타 동물성 유지'], ['1507', '대두유'], ['1508', '땅콩유'], ['1509', '올리브유'], ['1510', '기타 올리브 유지'], ['1511', '팜유'],
  ['1512', '해바라기유·홍화유·면실유'], ['1513', '야자유·팜핵유·바바수유'], ['1514', '유채유·겨자유'], ['1515', '기타 식물성 유지(아마인·옥수수·피마자·참기름 등)'],
  ['1516', '경화·에스테르화 가공 유지'], ['1517', '마가린·식용 혼합 유지'], ['1518', '산화·중합 가공 유지 혼합물'], ['1520', '글리세롤'],
  ['1521', '식물성 왁스·밀랍'], ['1522', '데그라·유지 찌꺼기'],
  ['3826', '바이오디젤(FAME) 등'],
  ['1201', '대두(콩)'], ['1205', '유채씨'], ['1206', '해바라기씨'], ['1207', '기타 유지종자(팜핵 등)'],
  ['2304', '대두박(유박)'], ['2306', '기타 유박'],
].map(([hs, name]) => ({ hs, name }));

const HS_NAMES = {
  15: '동식물성 유지와 분해생산물',
  12: '유지종자와 과실',
  23: '식품 공업의 잔재물·사료',
  38: '기타 화학공업 생산품',
  ...Object.fromEntries(HEADINGS.map((h) => [h.hs, h.name])),
};

// Everyday words people actually type (no one knows HS codes). Each maps to the heading(s) it means.
const ALIASES = {
  팜유: ['1511'], 팜: ['1511', '1513'], 팜올레인: ['1511'], 팜핵유: ['1513'], 코코넛: ['1513'], 야자: ['1513'], 코코넛유: ['1513'],
  대두유: ['1507'], 콩기름: ['1507'], 콩: ['1201', '1507', '2304'], 대두: ['1201', '1507', '2304'], 소이: ['1507'],
  유채: ['1514', '1205'], 카놀라: ['1514', '1205'], 채종유: ['1514'], 해바라기: ['1512', '1206'], 면실유: ['1512'], 홍화유: ['1512'],
  올리브: ['1509', '1510'], 올리브유: ['1509'], 땅콩: ['1508'], 참기름: ['1515'], 옥수수유: ['1515'], 아마인유: ['1515'], 피마자: ['1515'], 쌀겨유: ['1515'],
  우지: ['1502'], 탤로: ['1502'], 소기름: ['1502'], 라드: ['1501', '1503'], 돼지기름: ['1501'], 어유: ['1504'], 생선기름: ['1504'], 피쉬오일: ['1504'],
  마가린: ['1517'], 쇼트닝: ['1517'], 경화유: ['1516'], 가공유지: ['1516', '1518'], 글리세린: ['1520'], 글리세롤: ['1520'], 밀랍: ['1521'],
  폐식용유: ['1518', '1522'], UCO: ['1518', '1522'], 바이오디젤: ['3826'], FAME: ['3826'], 바이오연료: ['3826'],
  식용유: ['15'], 유지: ['15'], 기름: ['15'], 대두박: ['2304'], 유박: ['2304', '2306'], 사료: ['2304', '2306'], 유지종자: ['1201', '1205', '1206', '1207'],
};

// Plain-language groups for browsing without codes.
const GROUPS = [
  ['식물성 기름', ['1511', '1507', '1514', '1512', '1513', '1509', '1508', '1515']],
  ['동물성 기름', ['1502', '1501', '1503', '1504', '1506']],
  ['가공 유지·부산물', ['1516', '1517', '1518', '1520', '1522']],
  ['원료(유지종자)·유박', ['1201', '1205', '1206', '1207', '2304', '2306']],
  ['바이오연료', ['3826']],
].map(([name, codes]) => ({ name, codes }));

// Customs tariff names are legal text: bracketed conditions, Hanja and English glosses, "...한 것" clauses. People read item names, so they are
// normalized to short noun phrases. A few clauses no rule can shorten well get a written name (same meaning, plain words).
const NAME_OVERRIDES = {
  151800: '화학 변성 유지·비식용 유지 혼합물', 150300: '라드스테아린·라드유·올레오유·탤로우유', 230400: '대두박', 382600: '바이오디젤과 그 혼합물',
  150600: '그 밖의 동물성 유지', 152000: '글리세롤(조글리세롤·폐액)', 150500: '울그리스·라놀린', 152200: '데그라스·유지 처리 잔유물',
  150420: '어유(간유 제외)', 150410: '어류 간유', 1504101000: '상어 간유', 1502101010: '산가 2 이하', 1201901000: '착유·탈지대두박용',
  150710: '대두 조유', 151221: '면실 조유', 120760: '잇꽃씨', 120510: '저에루크산 유채씨',
};
const HANJA = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/u;
function cleanHsName(code, raw) {
  const c = String(code || '');
  const exact = NAME_OVERRIDES[c] || NAME_OVERRIDES[c.slice(0, 6)];
  if (exact && (NAME_OVERRIDES[c] || c.endsWith('0000'))) return exact;
  let t = String(raw || '').replace(/ㆍ/g, '·').replace(/\s+/g, ' ').trim();
  if (!t) return t;
  let prev;
  do { prev = t; t = t.replace(/\[[^\[\]]*\]/g, ''); } while (t !== prev);                 // [conditions]
  do {
    prev = t;
    t = t.replace(/\(([^()]*)\)/g, (m, inner) => (HANJA.test(inner) || /[A-Za-z]/.test(inner) || /상관없|한정|제외|포함|조제/.test(inner) ? '' : m));
  } while (t !== prev);                                                                       // (粗油) (palm olein) (…에 상관없다)
  t = t.replace(new RegExp(HANJA.source, 'gu'), '');
  t = t.replace(/로서 .*$/u, '').replace(/, 따로 분류.*$/u, '');                               // "...로서 조제를 하지 않은 것"
  if (/^2306/.test(c)) t = t.replace(/^(.+?)에서 나온 것$/u, '$1 유박');
  t = t.replace(/^(.+?)에서 나온 것$/u, '$1 유래')
    .replace(/^(\S+)하지 않은 것$/u, '미$1').replace(/^가공하지 않은 (.+)$/u, '미가공 $1')
    .replace(/^정제한 것$/u, '정제품').replace(/^(.+?)인 것$/u, '$1')
    .replace(/(\S)나 (\S)/gu, '$1·$2');
  t = t.replace(/\s+([,·])/g, '$1').replace(/\s{2,}/g, ' ').replace(/^[,·\s]+|[,·\s]+$/g, '').trim();
  return t || String(raw || '').trim();
}

module.exports = { HEADINGS, HS_NAMES, ALIASES, GROUPS, cleanHsName };
