const test = require('node:test');
const assert = require('node:assert/strict');
const qp = require('../server/lib/queryPlan');

const H = [{ role: 'user', content: '팜유 가격 동향' }, { role: 'assistant', content: '...' }];
const plan = (q, history = []) => qp.analyze(q, { history });

// representative questions -> expected strategy (intent, depth)
const CASES = [
  ['simple fact', '팜유 선물 가격이 지금 얼마야?', 'fact', 'brief'],
  ['short but needs analysis', '인도네시아 B50이 팜유 수급에 미치는 영향?', 'cause', 'structured'],
  ['multi-document comparison', '팜유와 대두유와 유채유의 가격 차이를 공급 측면에서 비교해줘', 'compare', 'deep'],
  ['follow-up', '그럼 그 회사는 어디에 공장이 있어?', 'fact', 'brief', true],
  ['time-sensitive outlook', '올해 하반기 대두유 가격 전망은?', 'outlook', 'structured'],
  ['decision support', '대두유 매입 시점을 어떻게 정해야 할까?', 'decision', 'structured'],
];
for (const [name, q, intent, depth, withHistory] of CASES) {
  test(`plan: ${name}`, () => {
    const p = plan(q, withHistory ? H : []);
    assert.equal(p.intent, intent);
    assert.equal(p.depth, depth);
    assert.equal(p.ambiguity, null);
  });
}

test('plan: time-sensitive questions are flagged for freshness, lookups of a definition are not', () => {
  assert.equal(plan('올해 하반기 대두유 가격 전망은?').recency, true);
  assert.equal(plan('EUDR 시행 연기됐어?').recency, false);
});

test('plan: an explicit instruction in the question beats the inferred depth', () => {
  assert.equal(plan('인도네시아 B50이 팜유 수급에 미치는 영향 한 줄로').depth, 'brief');
  assert.equal(plan('HVO와 FAME 차이 자세히 설명해줘').depth, 'deep');
  assert.equal(plan('바이오디젤 시황 표로 정리해줘').userFormat.table, true);
  assert.match(plan('수출업자 관점에서 팜유 수출세 영향을 정리해줘').userFormat.perspective, /수출업자 관점/);
});

test('plan: only a truly under-specified question gets a clarifying question; history or a subject word resolves it', () => {
  assert.ok(plan('가격 어때?').ambiguity);
  assert.ok(plan('전망 알려줘').ambiguity);
  assert.equal(plan('가격 어때?', H).ambiguity, null, 'the conversation names the subject');
  assert.equal(plan('팜유 가격 어때?').ambiguity, null);
});

test('promptBlock: strategy text matches the intent, keeps facts apart from inference, treats material instructions as data, honours user format', () => {
  const b = qp.promptBlock(plan('올해 하반기 대두유 가격 전망은?'));
  assert.match(b, /확인된 사실 → 전제\(가정\) → 가능한 시나리오 → 불확실성/);
  assert.match(b, /최신 자료를 우선/);
  assert.match(b, /명령문.*지시가 아니므로/);
  assert.match(qp.promptBlock(plan('HVO와 FAME 차이 간단히')), /150단어/);
  assert.match(qp.promptBlock(plan('수출업자 관점에서 영향을 정리해줘')), /지정 관점/);
  assert.match(qp.promptBlock(plan('팜유와 대두유와 유채유의 가격 차이를 비교해줘')), /비교 기준/);
});

test('applyRecency: old materials go behind newer ones only when enough newer ones remain', () => {
  const now = Date.UTC(2026, 10, 16);
  const mk = (id, iso) => ({ id, published_at: iso });
  const old = '2024-01-01'; const fresh = '2026-10-01';
  const list = [mk(1, old), mk(2, fresh), mk(3, fresh), mk(4, old), mk(5, fresh), mk(6, fresh)];
  const p = { recency: true };
  assert.deepEqual(qp.applyRecency(list, p, now).map((m) => m.id), [2, 3, 5, 6, 1, 4]);
  assert.deepEqual(qp.applyRecency(list, { recency: false }, now).map((m) => m.id), [1, 2, 3, 4, 5, 6]);
  const few = [mk(1, old), mk(2, fresh), mk(3, old), mk(4, old), mk(5, old), mk(6, old)];
  assert.deepEqual(qp.applyRecency(few, p, now).map((m) => m.id), [1, 2, 3, 4, 5, 6], 'too few fresh ones: leave the order alone');
});
