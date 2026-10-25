const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const pool = require('../server/db/pool');
const provider = require('../server/lib/ai/provider');
const searchRouter = require('../server/routes/search');
const tax = require('../server/lib/oilTaxonomy');
const market = require('../server/lib/oilMarket');

test('scopeOf: waste / non-edible / edible are told apart (폐식용유 is not 식용유)', () => {
  assert.equal(tax.scopeOf('폐식용유 가격 알려줘'), 'waste');
  assert.equal(tax.scopeOf('UCO 수출 동향'), 'waste');
  assert.equal(tax.scopeOf('SAF 혼합의무'), 'nonedible');
  assert.equal(tax.scopeOf('식용유 종류'), 'edible');
  assert.equal(tax.scopeOf('올리브유 시장'), 'edible');
  assert.equal(tax.scopeOf('국제 정세 요약'), null);
});

test('isOpportunityQuestion: minor / opportunity wording with an oil word only; never for waste or non-edible questions', () => {
  assert.equal(tax.isOpportunityQuestion('비주류 식용유 알려줘'), true);
  assert.equal(tax.isOpportunityQuestion('시장기회를 발굴할 틈새 식용유는?'), true);
  assert.equal(tax.isOpportunityQuestion('유망한 식물성 유지 품목'), true);
  assert.equal(tax.isOpportunityQuestion('팜유 시황 알려줘'), false);
  assert.equal(tax.isOpportunityQuestion('폐식용유 유망 시장'), false);
  assert.equal(tax.isOpportunityQuestion('SAF 유망 품목'), false);
});

test('taxonomy patterns match Korean and English names and keep UCO / SAF out of the edible list', () => {
  const hit = (id, text) => new RegExp(tax.OILS.find((o) => o.id === id).pattern, 'i').test(text);
  assert.ok(hit('olive', 'Olive oil exports rose') && hit('olive', '올리브유 수출'));
  assert.ok(hit('rapeseed', 'Canola crush margins') && hit('rapeseed', '카놀라유'));
  assert.ok(!tax.OILS.some((o) => new RegExp(o.pattern, 'i').test('폐식용유 수출 SAF 원료')));
});

const rows = [
  { id: 'palm', mentions: 461, recent: 131, figures: 297, latest: '2026-10-23' }, { id: 'soy', mentions: 174, recent: 58, figures: 138, latest: '2026-10-23' },
  { id: 'sunflower', mentions: 110, recent: 44, figures: 85, latest: '2026-10-24' }, { id: 'rapeseed', mentions: 41, recent: 11, figures: 34, latest: '2026-10-21' },
  { id: 'coconut', mentions: 8, recent: 1, figures: 6, latest: '2026-09-21' }, { id: 'olive', mentions: 8, recent: 0, figures: 7, latest: '2025-10-02' },
  { id: 'avocado', mentions: 0, recent: 0, figures: 0, latest: null },
];

test('analyze: shares sum to 1, trend and evidence levels are derived from the counts', () => {
  const s = market.analyze(rows);
  const by = Object.fromEntries(s.map((o) => [o.id, o]));
  assert.ok(Math.abs(s.reduce((n, o) => n + o.share, 0) - 1) < 1e-9);
  assert.equal(by.sunflower.trend, 'rising');   // recent share 44/… well above its all-time share
  assert.equal(by.olive.trend, 'quiet');
  assert.equal(by.avocado.trend, 'none');
  assert.equal(by.avocado.evidence, 'none');
  assert.equal(by.coconut.evidence, 'thin');
  assert.equal(by.palm.evidence, 'ok');
});

test('rankOpportunities: staples are the baseline, never candidates; evidence-less oils are the data-gap list', () => {
  const r = market.rankOpportunities(market.analyze(rows));
  assert.deepEqual(r.baseline.map((o) => o.id), ['palm', 'soy']);
  assert.ok(!r.ranked.some((o) => o.tier === 'dominant'));
  assert.equal(r.ranked[0].id, 'sunflower');          // most recent attention first
  assert.ok(r.gaps.some((o) => o.id === 'avocado'));
  assert.ok(!r.ranked.some((o) => o.id === 'avocado'));
});

test('evidenceBlock states shares, a baseline-only rule for the staples, "수치 미확인", the gap list and the coverage-bias caveat', () => {
  const block = market.evidenceBlock(market.analyze(rows));
  assert.match(block, /팜유 \[주류\] 아카이브 언급 461건\(전체 식용유 언급의 \d+\.\d%\)/);
  assert.match(block, /주류 기준선\(후보가 아님/);
  assert.match(block, /수치 미확인/);
  assert.match(block, /자료 공백.*아보카도유/);
  assert.match(block, /시장 규모와 같지 않다/);
});

test('loadOilStats sends every oil pattern and the 90-day cut-off as bind parameters, and returns analysed rows', async () => {
  const calls = [];
  const fake = { query: async (text, params) => { calls.push({ text, params }); return { rows }; } };
  const s = await market.loadOilStats(fake, new Date('2026-10-24T00:00:00Z'));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].params[0].length, tax.OILS.length);
  assert.equal(calls[0].params[1].length, tax.OILS.length);
  assert.equal(calls[0].params[2], '2026-07-26');
  assert.ok(s.find((o) => o.id === 'palm').share > 0.5);
});

test('dropNonEdible: sector-only non-edible items and waste/SAF text without an edible oil are dropped; edible and mixed items stay', async () => {
  const items = [
    { id: 1, title: 'Olive oil prices climb', summary: 'x' },
    { id: 2, title: 'SAF plant starts', summary: 'UCO feedstock' },
    { id: 3, title: 'UCO exports and palm oil supply', summary: 'both' },
    { id: 4, title: 'Neutral title', summary: 'tagged only biofuel' },
  ];
  const fake = { query: async () => ({ rows: [{ item_id: 4 }] }) };
  const out = await market.dropNonEdible(fake, items);
  assert.deepEqual(out.map((m) => m.id), [1, 3]);
});

// ---- the route -------------------------------------------------------------------------------------------------------------------
function withServer(fn) {
  const app = express();
  app.use(express.json());
  app.use('/api/search', searchRouter);
  return new Promise((resolve, reject) => {
    const server = app.listen(0, async () => { try { await fn(`http://127.0.0.1:${server.address().port}/api/search`); resolve(); } catch (e) { reject(e); } finally { server.close(); } });
  });
}
const item = (id, title, over = {}) => ({ id, title, summary: `${title} 요약`, insight: null, ai_summary: null, ai_insight: null, published_at: new Date(Date.now() - id * 86400000), source_name: 'S', relevance_score: 1, ...over });

test('POST /: an opportunity question gets the per-oil evidence block, the classification note, evidence items first, and no staple-only material', async () => {
  const original = pool.query;
  pool.query = async (text) => {
    if (/unnest\(\$1::text\[\]/.test(text)) return { rows };
    if (/SELECT a\.item_id FROM item_sectors/.test(text)) return { rows: [] };
    if (/~\* \$1\s+ORDER BY/.test(text)) return { rows: [item(11, '올리브유 수출 증가'), item(12, 'Coconut oil demand')] };
    if (/FROM items i/.test(text)) return { rows: [item(21, '팜유 가격 상승'), item(22, '해바라기유와 팜유 비교'), item(23, 'Soybean oil crush')] };
    return { rows: [] };
  };
  const originalProvider = provider.callProviderWithFallback;
  let seen = null;
  provider.callProviderWithFallback = async ({ user }) => { if (!seen && /\[Research Center materials\]/.test(user)) seen = user; return { text: '답변 [1]', provider: 'freellmapi' }; };
  try {
    await withServer(async (base) => {
      await fetch(base, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ question: '시장기회 발굴을 위한 비주류 식용유 알려줘' }) });
    });
    assert.ok(seen, 'the writer was called');
    assert.match(seen, /시장기회 질문 — 역학관계 기준/);
    assert.match(seen, /분류 기준 — 반드시 구분/);
    assert.match(seen, /자료 1 — 제목: 올리브유 수출 증가/);          // evidence items come first
    assert.ok(!/제목: 팜유 가격 상승/.test(seen), 'a staple-only material is not offered as evidence');
    assert.match(seen, /제목: 해바라기유와 팜유 비교/);               // mentions a non-dominant oil: kept
  } finally { pool.query = original; provider.callProviderWithFallback = originalProvider; }
});

test('POST /: an edible-oil question drops UCO/SAF material and carries the classification note; a waste-oil question does not', async () => {
  const original = pool.query;
  pool.query = async (text) => {
    if (/SELECT a\.item_id FROM item_sectors/.test(text)) return { rows: [] };
    if (/FROM items i/.test(text)) return { rows: [item(1, '식용유 소비 동향'), item(2, 'e-SAF 프로젝트 등록'), item(3, '폐식용유 수출 급증')] };
    return { rows: [] };
  };
  const originalProvider = provider.callProviderWithFallback;
  const seenBy = {};
  let current = null;
  provider.callProviderWithFallback = async ({ user }) => { if (/\[Research Center materials\]/.test(user) && !seenBy[current]) seenBy[current] = user; return { text: '답변 [1]', provider: 'freellmapi' }; };
  try {
    await withServer(async (base) => {
      for (const q of ['식용유 소비 동향 알려줘', '폐식용유 수출 동향 알려줘']) {
        current = q;
        await fetch(base, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ question: q }) });
      }
    });
    const edible = seenBy['식용유 소비 동향 알려줘'];
    assert.match(edible, /제목: 식용유 소비 동향/);
    assert.ok(!/e-SAF 프로젝트/.test(edible) && !/폐식용유 수출 급증/.test(edible));
    assert.match(edible, /분류 기준 — 반드시 구분/);
    const waste = seenBy['폐식용유 수출 동향 알려줘'];
    assert.match(waste, /폐식용유 수출 급증/);
    assert.ok(!/분류 기준 — 반드시 구분/.test(waste));
  } finally { pool.query = original; provider.callProviderWithFallback = originalProvider; }
});

test('dropNonEdible: "식용유" inside 폐식용유 / "식용유지" inside 비식용유지 / "cooking oil" inside "used cooking oil" do not count as edible-oil mentions', async () => {
  const items = [
    { id: 1, title: '폐식용유 수출 급증', summary: '' },
    { id: 2, title: '비식용유지 시장 전망', summary: 'SAF' },
    { id: 3, title: 'Used cooking oil exports', summary: 'SAF feedstock' },
    { id: 4, title: '가정용 식용유 소비', summary: '' },
    { id: 5, title: 'Cooking oil prices', summary: '' },
  ];
  const out = await market.dropNonEdible({ query: async () => ({ rows: [] }) }, items);
  assert.deepEqual(out.map((m) => m.id), [4, 5]);
});
