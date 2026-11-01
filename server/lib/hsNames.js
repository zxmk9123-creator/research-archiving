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

module.exports = { HEADINGS, HS_NAMES };
