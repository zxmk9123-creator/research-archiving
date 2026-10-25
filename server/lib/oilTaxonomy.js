// OIL CLASSIFICATION — one definition used by retrieval, the chatbot prompt and the opportunity analysis.
//   식용유(식용유지)  edible oils: staples + minor/niche edible oils below
//   폐식용유(UCO)      used cooking oil: collected after use, a FEEDSTOCK for biofuel — never an "edible oil" product
//   비식용유지         non-edible fats/oils and fuels made from them: SAF, UCOME, FAME, HVO, tallow ... — never an "edible oil"
// Tiers describe market weight, not importance: dominant (global trade volume leaders), major (large regional/global), minor (small or niche).
// `pattern` is a regular expression valid in BOTH JavaScript and PostgreSQL (case-insensitive), matching Korean and English names.
const OILS = [
  { id: 'palm', name: '팜유', tier: 'dominant', pattern: '팜유|palm oil' },
  { id: 'soy', name: '대두유', tier: 'dominant', pattern: '대두유|soybean oil|soy oil|콩기름' },
  { id: 'sunflower', name: '해바라기유', tier: 'major', pattern: '해바라기유|sunflower oil' },
  { id: 'rapeseed', name: '유채씨유(카놀라유)', tier: 'major', pattern: '유채씨유|카놀라|채종유|rapeseed oil|canola' },
  { id: 'palm-kernel', name: '팜핵유', tier: 'minor', pattern: '팜핵유|palm kernel oil' },
  { id: 'corn', name: '옥수수유', tier: 'minor', pattern: '옥수수유|corn oil' },
  { id: 'olive', name: '올리브유', tier: 'minor', pattern: '올리브유|olive oil' },
  { id: 'coconut', name: '코코넛유', tier: 'minor', pattern: '코코넛유|coconut oil' },
  { id: 'peanut', name: '땅콩유', tier: 'minor', pattern: '땅콩유|peanut oil|groundnut oil' },
  { id: 'sesame', name: '참기름', tier: 'minor', pattern: '참기름|sesame oil' },
  { id: 'perilla', name: '들기름', tier: 'minor', pattern: '들기름|perilla oil' },
  { id: 'cottonseed', name: '면실유', tier: 'minor', pattern: '면실유|cottonseed oil' },
  { id: 'rice-bran', name: '쌀겨유', tier: 'minor', pattern: '쌀겨유|rice bran oil' },
  { id: 'avocado', name: '아보카도유', tier: 'minor', pattern: '아보카도유|avocado oil' },
  { id: 'flax', name: '아마씨유', tier: 'minor', pattern: '아마씨유|flaxseed oil|linseed oil' },
  { id: 'grapeseed', name: '포도씨유', tier: 'minor', pattern: '포도씨유|grapeseed oil' },
  { id: 'safflower', name: '홍화유', tier: 'minor', pattern: '홍화씨?유|safflower oil' },
  { id: 'walnut', name: '호두유', tier: 'minor', pattern: '호두유|walnut oil' },
];

const WASTE_TERMS = /폐식용유|\bUCO\b|used cooking oil|waste cooking oil/i;
const NON_EDIBLE_TERMS = /비식용|\bSAF\b|e-SAF|지속\s*가능\s*항공유|바이오\s*항공유|\bUCOME\b|\bFAME\b|\bHVO\b|바이오\s*디젤|재생\s*디젤|biodiesel|renewable diesel|tallow|우지|sustainable aviation fuel/i;
const EDIBLE_WORD = /(식용유|식용\s*유지|식물성\s*유|식용\s*오일|cooking oil|edible oil|vegetable oil)/i;

// The question's scope: 'waste' (it names UCO/폐식용유), 'nonedible' (SAF, biodiesel ...), 'edible' (an edible-oil word and neither of the others),
// or null (no oil-class word at all).
function scopeOf(question) {
  const q = String(question || '');
  if (WASTE_TERMS.test(q)) return 'waste';
  if (NON_EDIBLE_TERMS.test(q)) return 'nonedible';
  if (EDIBLE_WORD.test(q) || OILS.some((o) => new RegExp(o.pattern, 'i').test(q))) return 'edible';
  return null;
}

// Market-opportunity / minor-oil questions: a minor-oil cue, or an opportunity cue together with an oil word.
const MINOR_CUE = /(비주류|마이너|틈새|소규모|니치|niche|minor|비\s*주력|대안\s*(식용유|유지|오일))/i;
const OPPORTUNITY_CUE = /(시장\s*기회|사업\s*기회|기회\s*(영역|발굴|시장)|발굴|블루\s*오션|성장\s*잠재|신흥|유망|신규\s*(품목|시장)|새로운\s*(품목|시장))/i;
function isOpportunityQuestion(question) {
  const q = String(question || '');
  const oilWord = EDIBLE_WORD.test(q) || /(오일|\boils?\b|유지|식물성)/i.test(q) || OILS.some((o) => new RegExp(o.pattern, 'i').test(q));
  if (scopeOf(q) === 'waste' || scopeOf(q) === 'nonedible') return false;
  return oilWord && (MINOR_CUE.test(q) || OPPORTUNITY_CUE.test(q));
}

// Prompt note: the classification, stated once so the writer never mixes the classes.
const CLASSIFICATION_NOTE = '\n\n[분류 기준 — 반드시 구분] 식용유: 팜유·대두유(주류), 해바라기유·유채씨유(2차), 그 밖의 비주류 식용유(올리브유·코코넛유·옥수수유·쌀겨유 등). 폐식용유(UCO)는 사용 후 회수한 유지로 바이오연료 원료이며 식용유 품목이 아니다. SAF·UCOME·FAME·HVO·우지(Tallow)는 비식용유지·연료 계열이며 식용유 품목이 아니다. 질문이 식용유를 묻는데 자료가 폐식용유·SAF·바이오연료 중심이면 그 자료를 식용유의 근거로 쓰지 않는다.';

module.exports = { OILS, scopeOf, isOpportunityQuestion, CLASSIFICATION_NOTE, WASTE_TERMS, NON_EDIBLE_TERMS };
