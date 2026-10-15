const test = require('node:test');
const assert = require('node:assert/strict');
const { latexToPlainText } = require('../public/latexText');

test('latexToPlainText: $\\text{CO}_2$ becomes CO₂', () => {
  assert.equal(latexToPlainText('포집 $\\text{CO}_2$를 활용한'), '포집 CO₂를 활용한');
});

test('latexToPlainText: braced sub/superscripts and symbols', () => {
  assert.equal(latexToPlainText('$\\mathrm{H}_{2}\\mathrm{O}$ 와 $m^{3}$ 및 $10 \\times 5$'), 'H₂O 와 m³ 및 10 × 5');
});

test('latexToPlainText: plain currency amounts are left untouched', () => {
  const text = 'Up to $4 billion and $6.1 billion in total';
  assert.equal(latexToPlainText(text), text);
});

test('latexToPlainText: text without math is unchanged', () => {
  assert.equal(latexToPlainText('e-SAF 생산 [4]'), 'e-SAF 생산 [4]');
});
