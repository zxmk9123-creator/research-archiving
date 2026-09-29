const test = require('node:test');
const assert = require('node:assert/strict');
const { isRelevantToOilFatsScope } = require('../server/lib/relevanceFilter');

test('isRelevantToOilFatsScope: a clearly relevant Oil & Fats article is accepted', () => {
  assert.equal(
    isRelevantToOilFatsScope('Indonesia raises palm oil export levy', 'The government increased the tax on crude palm oil shipments.'),
    true
  );
  assert.equal(
    isRelevantToOilFatsScope('Soybean oil futures rise on tight supply', null),
    true
  );
});

test('isRelevantToOilFatsScope: a clearly irrelevant article is filtered out', () => {
  assert.equal(
    isRelevantToOilFatsScope('Central bank raises interest rates amid inflation concerns', 'The rate hike is the third this year.'),
    false
  );
  assert.equal(
    isRelevantToOilFatsScope('Local football team wins championship final', 'Fans celebrated in the streets overnight.'),
    false
  );
});

test('isRelevantToOilFatsScope: English aliases for the existing sector taxonomy are accepted', () => {
  assert.equal(isRelevantToOilFatsScope('New sunflower oil refinery opens in Ukraine', null), true);
  assert.equal(isRelevantToOilFatsScope('Canada canola oil exports climb', null), true);
  assert.equal(isRelevantToOilFatsScope('EU rapeseed oil output forecast cut', null), true);
  assert.equal(isRelevantToOilFatsScope('Used cooking oil collection expands in California', null), true);
  assert.equal(isRelevantToOilFatsScope('SAF demand grows as airlines seek lower emissions', 'Sustainable aviation fuel producers ramp up capacity.'), true);
  assert.equal(isRelevantToOilFatsScope('Tallow-based biodiesel plant announced', null), true);
  assert.equal(isRelevantToOilFatsScope('FAME blending mandate raised to 10%', null), true);
});

test('isRelevantToOilFatsScope: a generic keyword used unrelatedly does not create an obvious false positive', () => {
  // Bare "oil"/"fat" are intentionally NOT matched on their own — crude
  // petroleum, engine oil, and dietary-fat health articles must not trip
  // the filter just because they mention the word.
  assert.equal(
    isRelevantToOilFatsScope('Oil prices surge as OPEC agrees to cut output', 'Crude oil benchmark rose 3% in early trading.'),
    false
  );
  assert.equal(
    isRelevantToOilFatsScope('Study finds low-fat diet reduces heart disease risk', 'Researchers tracked body fat percentage over five years.'),
    false
  );
  assert.equal(
    isRelevantToOilFatsScope('Mechanic recommends synthetic motor oil for winter driving', null),
    false
  );
});

test('isRelevantToOilFatsScope: matches against description even when the title is generic', () => {
  assert.equal(
    isRelevantToOilFatsScope('Company announces quarterly results', 'Growth was driven by higher palm oil sales volumes.'),
    true
  );
});

test('isRelevantToOilFatsScope: matches Korean sector names directly', () => {
  assert.equal(isRelevantToOilFatsScope('팜유 가격 상승', null), true);
  assert.equal(isRelevantToOilFatsScope('중앙은행 금리 인상 발표', null), false);
});
