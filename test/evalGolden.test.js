const test = require('node:test');
const assert = require('node:assert/strict');
const ev = require('../server/lib/evalRunner');

// The deterministic golden suites must stay at 100%: a rule change that breaks a case a human already judged fails here.
test('golden set: every deterministic suite passes', () => {
  const suites = ev.runDeterministic();
  const names = Object.keys(suites);
  assert.deepEqual(names.sort(), ['colons', 'evidence_names', 'merge_pairs', 'relation_rules', 'roles', 'roster_aliases', 'typos']);
  const problems = Object.entries(suites).flatMap(([name, s]) => s.failures.map((f) => `${name}/${f.id}: ${f.problem}`));
  assert.deepEqual(problems, [], `golden-set regressions:\n${problems.join('\n')}`);
  for (const s of Object.values(suites)) assert.ok(s.total > 0);
});

test('golden set: structure is sound (unique ids, every live case has a verdict)', () => {
  const g = ev.golden;
  const ids = Object.entries(g).filter(([, v]) => Array.isArray(v)).flatMap(([, v]) => v.map((c) => c.id));
  assert.equal(new Set(ids).size, ids.length);
  for (const c of g.live_relations) assert.ok(['correct', 'wrong', 'ended'].includes(c.verdict));
  assert.ok(ids.length >= 100);
});

test('a broken rule is detected: a deliberately wrong expectation is reported as a failure', () => {
  const suites = ev.runDeterministic({ relation_rules: [{ id: 'x', input: { src: 'bp', dst: 'Castrol', relation: 'owns', evidence: '카스트롤에 대한 전략적 검토' }, expect: { keep: true } }], merge_pairs: [], roles: [], typos: [], colons: [], evidence_names: [], roster_aliases: [] });
  assert.equal(suites.relation_rules.passed, 0);
  assert.equal(suites.relation_rules.failures[0].id, 'x');
});

test('live audit: judged-wrong relations must be absent, judged-correct present, ended marked ended', async () => {
  const rows = [
    { src: 'POSCO International', dst: 'ARC', relation: 'owns', status: 'active' },
    { src: 'LanzaTech', dst: 'Mibelle Group', relation: 'jv_partner', status: 'active' },
    { src: 'PZ Cussons', dst: 'Wilmar', relation: 'jv_partner', status: 'ended' },
  ];
  const pool = { query: async () => ({ rows }) };
  const r = await ev.runLiveAudit(pool, { live_relations: [
    { id: 'a', src: 'POSCO International', dst: 'ARC', relation: 'owns', verdict: 'correct' },
    { id: 'b', src: 'LanzaTech', dst: 'Mibelle Group', relation: 'jv_partner', verdict: 'wrong' },
    { id: 'c', src: 'Wilmar', dst: 'PZ Cussons', relation: 'jv_partner', verdict: 'ended' },
  ] });
  assert.equal(r.total, 3);
  assert.deepEqual(r.failures.map((f) => f.id), ['b']);
});
