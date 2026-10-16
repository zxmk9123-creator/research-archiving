const test = require('node:test');
const assert = require('node:assert/strict');
const ss = require('../server/lib/subjectScope');

test('forQuestion: palm producer/refiner listing only', () => {
  assert.ok(ss.forQuestion('팜유 생산업체 숏리스트 작성해줘'));
  assert.ok(ss.forQuestion('팜유 주요 리파이너리 업체들'));
  assert.ok(ss.forQuestion('팜 생산업체 리스트업해줘'));
  assert.ok(ss.forQuestion('팜 농장 업체 목록'));
  assert.ok(ss.forQuestion('palm oil producers shortlist'));
  assert.equal(ss.forQuestion('팜유 수출 정책'), null);
  assert.equal(ss.forQuestion('팜유를 쓰는 바이오디젤 업체'), null);
  assert.equal(ss.forQuestion('SAF 업체 CAPA'), null);
});

test('out-of-scope companies are dropped from table rows and bullets', () => {
  const roster = [
    { name: 'Wilmar', names: ['wilmar'], segment: 'palm' },
    { name: 'Neste', names: ['neste', '네스테'], segment: null },
    { name: 'GS칼텍스', names: ['gs칼텍스'], segment: null },
  ];
  const { outside } = ss.splitRoster(roster, { segment: 'palm' });
  const text = ['# 목록', '| 업체 | 비고 |', '| --- | --- |', '| Wilmar | 정제 [1] |', '| **Neste** | HVO [2] |', '- GS칼텍스: 팜폐수 [3]', '- Wilmar는 선두 [1]', '본문에서 Neste를 언급한다.'].join('\n');
  const out = ss.dropOutOfScopeLines(text, outside);
  assert.ok(out.includes('| Wilmar |') && out.includes('- Wilmar는') && out.includes('본문에서 Neste'));
  assert.ok(!out.includes('HVO') && !out.includes('GS칼텍스'));
});

test('in-scope wins a name overlap: auto-discovered duplicates of a palm company stay in scope', () => {
  const roster = [
    { name: 'Wilmar', names: ['wilmar', '윌마', 'wilmar international'], segment: 'palm' },
    { name: 'Wilmar International Limited', names: ['wilmar international limited', 'wilmar'], segment: null },
    { name: 'Kuala Lumpur Kepong Bhd', names: ['kuala lumpur kepong bhd', 'kuala'], segment: null },
    { name: 'KLK', names: ['klk', 'kuala lumpur kepong'], segment: 'palm' },
    { name: 'Neste', names: ['neste'], segment: null },
  ];
  const { allowed, outside } = ss.splitRoster(roster, { segment: 'palm' });
  assert.deepEqual(allowed.map((c) => c.name).sort(), ['KLK', 'Kuala Lumpur Kepong Bhd', 'Wilmar', 'Wilmar International Limited']);
  assert.deepEqual(outside.map((c) => c.name), ['Neste']);
  assert.match(ss.retrievalHint('팜 생산업체 리스트업', { segment: 'palm' }), /팜유 palm oil/);
  assert.equal(ss.retrievalHint('팜유 생산업체', { segment: 'palm' }), '팜유 생산업체');
});
