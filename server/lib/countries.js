// Countries offered in the two-country view: UN Comtrade numeric codes with Korean names. The set is the major producers, exporters,
// importers and processors of fats, oils and oilseeds; any code the API knows can be added here (this list is the only gate).
const COUNTRIES = [
  [360, 'ID', '인도네시아'], [458, 'MY', '말레이시아'], [699, 'IN', '인도'], [156, 'CN', '중국'], [410, 'KR', '대한민국'], [842, 'US', '미국'],
  [32, 'AR', '아르헨티나'], [76, 'BR', '브라질'], [643, 'RU', '러시아'], [804, 'UA', '우크라이나'], [528, 'NL', '네덜란드'], [276, 'DE', '독일'],
  [251, 'FR', '프랑스'], [724, 'ES', '스페인'], [380, 'IT', '이탈리아'], [826, 'GB', '영국'], [792, 'TR', '튀르키예'], [818, 'EG', '이집트'],
  [586, 'PK', '파키스탄'], [50, 'BD', '방글라데시'], [704, 'VN', '베트남'], [764, 'TH', '태국'], [608, 'PH', '필리핀'], [392, 'JP', '일본'],
  [702, 'SG', '싱가포르'], [36, 'AU', '호주'], [124, 'CA', '캐나다'], [682, 'SA', '사우디아라비아'], [784, 'AE', '아랍에미리트'], [364, 'IR', '이란'],
  [368, 'IQ', '이라크'], [484, 'MX', '멕시코'], [170, 'CO', '콜롬비아'], [600, 'PY', '파라과이'], [858, 'UY', '우루과이'], [398, 'KZ', '카자흐스탄'],
  [566, 'NG', '나이지리아'], [710, 'ZA', '남아프리카공화국'], [504, 'MA', '모로코'], [12, 'DZ', '알제리'], [404, 'KE', '케냐'], [834, 'TZ', '탄자니아'],
  [144, 'LK', '스리랑카'], [104, 'MM', '미얀마'], [116, 'KH', '캄보디아'], [598, 'PG', '파푸아뉴기니'], [218, 'EC', '에콰도르'], [604, 'PE', '페루'],
  [152, 'CL', '칠레'], [616, 'PL', '폴란드'], [56, 'BE', '벨기에'], [752, 'SE', '스웨덴'], [208, 'DK', '덴마크'], [642, 'RO', '루마니아'],
  [100, 'BG', '불가리아'], [348, 'HU', '헝가리'], [440, 'LT', '리투아니아'], [376, 'IL', '이스라엘'], [344, 'HK', '홍콩'], [579, 'NO', '노르웨이'],
  [246, 'FI', '핀란드'], [620, 'PT', '포르투갈'], [300, 'GR', '그리스'], [288, 'GH', '가나'], [384, 'CI', '코트디부아르'], [120, 'CM', '카메룬'],
  [180, 'CD', '콩고민주공화국'], [188, 'CR', '코스타리카'], [340, 'HN', '온두라스'], [320, 'GT', '과테말라'], [762, 'TJ', '타지키스탄'], [860, 'UZ', '우즈베키스탄'],
].map(([code, iso, ko]) => ({ code, iso, ko }));

const BY_CODE = new Map(COUNTRIES.map((c) => [c.code, c]));
const KO_SORTED = [...COUNTRIES].sort((a, b) => a.ko.localeCompare(b.ko, 'ko'));
module.exports = { COUNTRIES: KO_SORTED, countryByCode: (c) => BY_CODE.get(Number(c)) || null, isCountry: (c) => BY_CODE.has(Number(c)) };
