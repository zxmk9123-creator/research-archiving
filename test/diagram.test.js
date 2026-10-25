const test = require('node:test');
const assert = require('node:assert/strict');
const dg = require('../server/lib/diagram');

test('diagram questions are recognised', () => {
  assert.ok(dg.isDiagramQuestion('UCO 밸류체인을 도식으로 보여줘'));
  assert.ok(dg.isDiagramQuestion('Eni 관계도 그려줘'));
  assert.ok(!dg.isDiagramQuestion('SAF 생산능력 표'));
});

test('sanitize keeps known nodes and fixed edge types, bounds size, drops broken blocks', () => {
  const ok = dg.sanitize({ type: 'valuechain', title: 'UCO', stages: [{ id: 's1', label: '수거' }, { id: 's2', label: '정제' }], nodes: [{ id: 'a', label: 'RT', stage: 's1' }, { id: 'b', label: 'Neste', stage: 's9' }, { id: 'a', label: 'dup' }],
    edges: [{ from: 'a', to: 'b', type: 'supplies', label: 'UCO', source: 3 }, { from: 'a', to: 'zzz', type: 'owns' }, { from: 'a', to: 'a', type: 'owns' }, { from: 'b', to: 'a', type: 'weird' }] });
  assert.equal(ok.nodes.length, 2);
  assert.equal(ok.nodes[1].stage, null);
  assert.deepEqual(ok.edges.map((e) => e.type), ['supplies', 'flow']);
  assert.equal(dg.sanitize({ nodes: [{ id: 'a', label: 'x' }], edges: [] }), null);
  assert.equal(dg.sanitize(null), null);
});

test('sanitizeInText rewrites valid blocks with an evidence line and removes invalid ones', () => {
  const good = JSON.stringify({ type: 'relations', nodes: [{ id: 'a', label: 'Eni' }, { id: 'b', label: 'Enilive' }], edges: [{ from: 'a', to: 'b', type: 'owns', source: 2 }, { from: 'a', to: 'b', type: 'supplies', source: 9 }] });
  const out = dg.sanitizeInText(`설명\n\`\`\`diagram\n${good}\n\`\`\`\n끝\n\`\`\`diagram\n{bad json}\n\`\`\``, { maxSource: 5 });
  assert.match(out, /```diagram\n\{/);
  assert.equal((out.match(/```diagram/g) || []).length, 1);
  assert.ok(!out.includes('"source":9'));
});

test('sanitize: canonical names merge the same company, markets/countries are dropped, node and edge ceilings hold', () => {
  const isNonCompany = (n) => /시장$|^일본$/.test(n);
  const d = dg.sanitize({ type: 'valuechain', stages: [{ id: 's1', label: 'a' }], nodes: [
    { id: 'a', label: 'Sime Darby Plantation Bhd.', stage: 's1' }, { id: 'b', label: 'SD Guthrie', stage: 's1' }, { id: 'c', label: 'PT.ARC' }, { id: 'd', label: '인도 시장' },
  ], edges: [{ from: 'a', to: 'c', type: 'supplies' }, { from: 'b', to: 'c', type: 'supplies' }, { from: 'c', to: 'd', type: 'flow' }] }, { canon: (n) => (n.startsWith('Sime Darby') ? 'SD Guthrie' : n), isNonCompany });
  assert.deepEqual(d.nodes.map((n) => n.label), ['SD Guthrie', 'PT.ARC']);
  assert.equal(d.edges.length, 1);
  const many = { type: 'relations', nodes: Array.from({ length: 30 }, (_, i) => ({ id: `n${i}`, label: `Co${i}` })), edges: Array.from({ length: 30 }, (_, i) => ({ from: `n${i}`, to: `n${(i + 1) % 30}`, type: 'owns' })) };
  const out = dg.sanitize(many);
  assert.ok(out.nodes.length <= 16 && out.edges.length <= 24);
  assert.ok(out.edges.every((e) => out.nodes.some((n) => n.id === e.from) && out.nodes.some((n) => n.id === e.to)));
});

test('sanitize applies the relation rules to edges: JV owners are stakes, cue-less ownership is a flow, airline is a buyer, one jv line per pair', () => {
  const d = dg.sanitize({ type: 'relations', nodes: [
    { id: 'a', label: 'LG화학' }, { id: 'b', label: 'Eni' }, { id: 'c', label: 'LG Eni BioRefining' }, { id: 'd', label: '대산 HVO 공장' }, { id: 'e', label: 'Air France-KLM' }, { id: 'f', label: 'TotalEnergies' }, { id: 'g', label: 'KLK' }, { id: 'h', label: 'PT Putra' },
  ], edges: [
    { from: 'a', to: 'c', type: 'owns', label: '합작법인 설립' }, { from: 'b', to: 'c', type: 'owns', label: '합작법인 설립' },
    { from: 'a', to: 'b', type: 'jv', label: '합작' }, { from: 'b', to: 'a', type: 'jv', label: '합작' },
    { from: 'c', to: 'd', type: 'owns', label: '공장 건설' },
    { from: 'e', to: 'f', type: 'supplies', label: 'SAF 구매' },
    { from: 'g', to: 'h', type: 'owns', label: '95% 지분 인수' },
  ] });
  const t = (from, to) => d.edges.find((e) => e.from === from && e.to === to);
  assert.equal(t('a', 'c').type, 'stake');
  assert.equal(t('b', 'c').type, 'stake');
  assert.equal(d.edges.filter((e) => e.type === 'jv').length, 1);
  assert.equal(t('c', 'd').type, 'flow');
  assert.equal(t('f', 'e').type, 'supplies');
  assert.equal(t('g', 'h').type, 'owns');
});

test('sanitize: emitters get their own stage, a supplier is moved out of the emitter stage (roles come from the registry)', () => {
  const roles = { sheetz: 'emitter', 'restaurant technologies': 'supplier', fathopes: 'supplier' };
  const d = dg.sanitize({ type: 'valuechain', stages: [{ id: 's1', label: '배출·수거·집적' }, { id: 's2', label: '정제·생산' }], nodes: [
    { id: 'a', label: 'Sheetz', stage: 's1' }, { id: 'b', label: 'Restaurant Technologies', stage: 's1' }, { id: 'c', label: 'Chevron', stage: 's2' },
  ], edges: [{ from: 'a', to: 'b', type: 'supplies', label: 'UCO' }, { from: 'b', to: 'c', type: 'supplies', label: 'UCO' }] }, { roleOf: (n) => roles[n.toLowerCase()] || null });
  assert.equal(d.stages[0].label, '배출처');
  assert.equal(d.nodes.find((n) => n.label === 'Sheetz').stage, d.stages[0].id);
  assert.notEqual(d.nodes.find((n) => n.label === 'Restaurant Technologies').stage, d.stages[0].id);
});
