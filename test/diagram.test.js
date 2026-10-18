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
  assert.match(out, /근거: \[2\]/);
  assert.equal((out.match(/```diagram/g) || []).length, 1);
  assert.ok(!out.includes('"source":9'));
});
