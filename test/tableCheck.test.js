const test = require('node:test');
const assert = require('node:assert/strict');
const tc = require('../server/lib/tableCheck');
const { unitMultiplier } = require('../server/lib/numberCheck');

const md = (...rows) => ['| 기업 | 능력 |', '| --- | --- |', ...rows.map((r) => `| ${r} |`)].join('\n');

test('tableCheck: one kind of quantity in a column is rewritten into a single unit and number format', () => {
  const r = tc.normalizeTablesInText(md('Neste | 1.0 Mt/a', 'Eni | 400 kt/y', 'Total | 5만 ~ 12만 톤', 'X | 120만 톤 [3]'));
  assert.equal(r.text, md('Neste | 100만 톤/년', 'Eni | 40만 톤/년', 'Total | 5만 ~ 12만 톤', 'X | 120만 톤 [3]'));
  assert.ok(r.normalized >= 2);
  // idempotent
  assert.equal(tc.normalizeTablesInText(r.text).text, r.text);
});

test('tableCheck: a column mixing different kinds of quantity is annotated, never silently combined', () => {
  const r = tc.normalizeTablesInText(md('A | 50만 톤', 'B | 340 million gallons'));
  assert.match(r.text, /열에 서로 다른 단위\(톤 \/ 갤런\)가 섞여 있어/);
  assert.match(r.text, /\| A \| 50만 톤 \|/);
  assert.equal(r.warnings, 1);
});

test('tableCheck: malformed numbers are never displayed', () => {
  const r = tc.normalizeTablesInText(md('A | 1.2.5 Mt', 'B | 50만 톤', 'C | 1,2 Mt'));
  assert.ok(!/1\.2\.5|1,2 Mt/.test(r.text));
  assert.equal((r.text.match(/원문 수치 확인 필요/g) || []).length, 2);
});

test('tableCheck: text-only tables and non-table text are untouched', () => {
  const t = '| a | b |\n| --- | --- |\n| 가 | 나 |\n\n본문 50만 톤';
  assert.equal(tc.normalizeTablesInText(t).text, t);
});

test('tableCheck: chart values are reconciled with the table row of the same entity', () => {
  const rows = tc.tableRowQuantities(md('Neste 싱가포르 | 100만 톤', 'Eni | 40만 톤'));
  const um = unitMultiplier('만 톤');
  const r = tc.reconcileChartWithTable({ labels: ['Neste 싱가포르', 'Eni', 'Unlisted'], series: [{ name: 's', data: [10, 40, 7] }] }, rows, um.mult, um.cls);
  assert.deepEqual(r.chart.series[0].data, [100, 40, 7]);
  assert.equal(r.fixed, 1);
});
