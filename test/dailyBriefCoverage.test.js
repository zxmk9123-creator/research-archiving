const test = require('node:test');
const assert = require('node:assert/strict');
const { validateBrief, ensureSummaryCoversDevelopments } = require('../server/lib/dailyBrief');

const D = [
  { item_id: 1, summary: '세계은행이 2026년 원유 생산 5.2% 감소를 전망' },
  { item_id: 2, summary: '말레이시아 팜유 선물이 이번 주 1.5% 하락' },
  { item_id: 3, summary: '영국과 일본이 지속가능항공유 의무화를 추진' },
];

test('a summary that already touches every development is left alone', () => {
  const s = '세계은행은 원유 생산이 5.2% 줄 것으로 본다. 말레이시아 팜유 선물은 1.5% 내렸다. 영국과 일본은 지속가능항공유 의무화를 추진한다.';
  const out = ensureSummaryCoversDevelopments(s, D);
  assert.equal(out.text, s);
  assert.deepEqual(out.added, []);
});

test('a summary about the first item only gets the others appended from their own validated summaries (no model call, no new facts)', () => {
  const out = ensureSummaryCoversDevelopments('세계은행이 원유 생산 5.2% 감소를 전망해 공급 부족 우려가 커진다.', D);
  assert.deepEqual(out.added, [2, 3]);
  assert.match(out.text, /말레이시아 팜유 선물이 이번 주 1\.5% 하락\./);
  assert.match(out.text, /영국과 일본이 지속가능항공유 의무화를 추진\.$/);
  assert.ok(out.text.startsWith('세계은행이 원유 생산 5.2% 감소를 전망해'));
});

test('validateBrief applies it: the stored market_summary covers all five selected items, the lead may name more than one', () => {
  const ev = (id) => ({ item_id: id, title: `자료 ${id}`, source: 'S', published_at: '2026-10-28T00:00:00.000Z', collected_at: '2026-10-29T16:00:00.000Z', summary: `자료 ${id}의 저장된 요약 문장이다.`, insight: `자료 ${id}의 인사이트이다.` });
  const dev = (id, name) => ({ item_id: id, importance: 5, summary: `${name}이 변화를 발표`, significance: `${name} 영향이 이어진다` });
  const raw = {
    lead: '세계은행 원유 감산 전망·팜유 선물 하락',
    market_summary: '세계은행 전망으로 공급 부족 우려가 커진다.',
    developments: [dev(1, '세계은행'), dev(2, '말레이시아팜유'), dev(3, '영국정부안'), dev(4, '일본항공연맹'), dev(5, '인도네시아부처')],
    watchpoints: [],
  };
  const out = validateBrief(raw, [1, 2, 3, 4, 5].map(ev));
  for (const name of ['말레이시아팜유', '영국정부안', '일본항공연맹', '인도네시아부처']) assert.ok(out.market_summary.includes(name), `${name} appears in the summary`);
  assert.ok(out.lead.includes('·'), 'a multi-item lead is accepted');
  assert.ok(out.lead.length <= 150);
});

test('the prompt asks for a lead over the most timely items and a summary over all of them', () => {
  const src = require('fs').readFileSync(require.resolve('../server/lib/dailyBrief.js'), 'utf8');
  assert.match(src, /한 건으로 제한하지 않는다/);
  assert.match(src, /자료 전체\(최대 5건\)를 빠짐없이 포괄/);
  assert.ok(!/가장 중요한 확인 사실 하나를 중심으로/.test(src), 'the single-fact rule is gone');
});
