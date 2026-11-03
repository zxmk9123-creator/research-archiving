const test = require('node:test');
const assert = require('node:assert/strict');
const { purgeUnverifiedMarkers } = require('../server/lib/numberCheck');
const M = '⚠원문 수치 확인 필요';

test('purge: no trace of the marker survives', () => {
  const input = [
    `Indonesia는 생산 능력이 ${M} 톤이다. 다른 문장은 그대로 둔다.[1]`,
    `- **Neste**: 연간 ${M}, 싱가포르 공장 가동 중[2]`,
    `- 용량은 ${M}`,
    '| 기업 | 용량 |', '|---|---|', `| A | ${M} |`, '| B | 50만 톤 |',
    '```chart', `{"title":"x ${M}"}`, '```',
  ].join('\n');
  const out = purgeUnverifiedMarkers(input);
  assert.ok(!/⚠|확인 필요/.test(out), out);
  assert.match(out, /다른 문장은 그대로 둔다\.\[1\]/);
  assert.match(out, /싱가포르 공장 가동 중\[2\]/);
  assert.ok(!/^- 용량은/m.test(out), 'a bullet that is only the figure is removed');
  assert.match(out, /\| A \| — \|/);
  assert.match(out, /\| B \| 50만 톤 \|/);
});

test('purge: text without the marker is returned untouched', () => {
  const t = '평범한 답변입니다.\n- 항목 1';
  assert.equal(purgeUnverifiedMarkers(t), t);
});
