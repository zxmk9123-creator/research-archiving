const test = require('node:test');
const assert = require('node:assert/strict');
const { validateBrief, compactSentence } = require('../server/lib/dailyBrief');

const ev = (id, day, over = {}) => ({ item_id: id, title: `자료 ${id}`, source: 'S', published_at: `2026-10-${day}T00:00:00.000Z`, collected_at: '2026-10-26T01:00:00.000Z', summary: `자료 ${id}의 저장된 요약 문장이다. 두번째 문장이다.`, insight: `자료 ${id}의 저장된 인사이트이다.`, ...over });
const dev = (id, importance, over = {}) => ({ item_id: id, importance, summary: `자료 ${id} 핵심 사실 4,793링깃`, significance: `자료 ${id} 영향`, ...over });
const raw = (developments) => ({ lead: '팜유 선물이 수출 증가로 상승', market_summary: '팜유 수출 증가가 가격을 지지한다.', developments, watchpoints: [] });

test('compactSentence: first sentence only, trailing full stop dropped, long text cut at a word boundary with an ellipsis', () => {
  assert.equal(compactSentence('팜유 가격이 올랐다. 두번째 문장은 버린다.', 100), '팜유 가격이 올랐다');
  assert.equal(compactSentence('', 50), '');
  const long = compactSentence('word '.repeat(60), 40);
  assert.ok(long.length <= 41 && long.endsWith('…'));
});

test('five developments are shown, chosen by importance first (an older important item is not dropped for a newer minor one), displayed in importance order (ties newest first)', () => {
  const evidence = [ev(1, '20'), ev(2, '21'), ev(3, '22'), ev(4, '23'), ev(5, '24'), ev(6, '25'), ev(7, '26')];
  const out = validateBrief(raw([dev(1, 5), dev(2, 3), dev(3, 4), dev(4, 3), dev(5, 4), dev(6, 3), dev(7, 3)]), evidence);
  const ids = out.developments.map((d) => d.item_id);
  assert.equal(ids.length, 5);
  assert.ok(ids.includes(1), 'importance 5 on the OLDEST item still makes the cut');
  assert.ok(ids.includes(3) && ids.includes(5));
  assert.deepEqual(ids, [1, 5, 3, 7, 6], '1 = most important; equal importance newest first');
  assert.ok(out.developments.every((d) => !('importance' in d)));
});

test('importance 3 fills the list; importance 2 and below never appears; the old "4 or nothing" rule is gone', () => {
  const evidence = [ev(1, '20'), ev(2, '21'), ev(3, '22')];
  const out = validateBrief(raw([dev(1, 4), dev(2, 3), dev(3, 2)]), evidence);
  // item 3 is importance 2 (not chosen by the model) but the archive can supply it: it is topped up from its own stored text, not from the model
  assert.deepEqual(out.developments.map((d) => d.item_id).sort(), [1, 2, 3]);
  assert.match(out.developments.find((d) => d.item_id === 3).summary, /저장된 요약 문장/);
});

test('top-up: when the model returns one item but five are available, the rest come from stored summary + insight (one compressed sentence each)', () => {
  const evidence = [ev(1, '20'), ev(2, '21'), ev(3, '22'), ev(4, '23'), ev(5, '24')];
  const out = validateBrief(raw([dev(5, 5)]), evidence);
  assert.equal(out.developments.length, 5);
  const filled = out.developments.find((d) => d.item_id === 2);
  assert.equal(filled.summary, '자료 2의 저장된 요약 문장이다');
  assert.equal(filled.significance, '자료 2의 저장된 인사이트이다');
});

test('top-up skips materials without a stored insight and never pads beyond the available evidence', () => {
  const evidence = [ev(1, '20'), ev(2, '21', { insight: '' }), ev(3, '22')];
  const out = validateBrief(raw([dev(1, 5)]), evidence);
  assert.deepEqual(out.developments.map((d) => d.item_id).sort(), [1, 3]);
  const two = validateBrief(raw([dev(1, 5)]), [ev(1, '20'), ev(3, '22')]);
  assert.equal(two.developments.length, 2);
});

test('model output is compressed to one sentence per field; unknown item ids and duplicates are still dropped', () => {
  const evidence = [ev(1, '20'), ev(2, '21')];
  const out = validateBrief(raw([
    dev(1, 5, { summary: '말레이시아 팜유 1월물이 0.5% 올라 4,793링깃을 기록했다. 수출은 58% 늘었다. 배경 설명이 길게 이어진다.', significance: '단기 가격 지지 요인이다. 다만 재고가 많다.' }),
    dev(1, 4), dev(99, 5),
  ]), evidence);
  const first = out.developments.find((d) => d.item_id === 1);
  assert.equal(first.summary, '말레이시아 팜유 1월물이 0.5% 올라 4,793링깃을 기록했다');
  assert.equal(first.significance, '단기 가격 지지 요인이다');
  assert.ok(!out.developments.some((d) => d.item_id === 99));
  assert.equal(out.developments.filter((d) => d.item_id === 1).length, 1);
});
