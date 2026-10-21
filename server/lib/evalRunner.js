// GOLDEN-SET ACCURACY. server/eval/golden.json holds cases a human already judged. The deterministic suites run the CURRENT rules
// (relation rules, company-name merging, roles, typo corrector, label colons) against them: no AI call, no cost, so `npm test` and
// the maintenance job can run them every time. The live audit compares the relations stored in the database with the human verdicts
// (a relation judged wrong must not be there as an active row, a judged-correct one must be, an ended one must be marked ended).
// Every run is stored in eval_runs so the ops panel can show whether accuracy moved after a rule change.
const golden = require('../eval/golden.json');
const rel = require('./companyRelations');
const reg = require('./entityRegistry');
const { canonicalizeProperNouns } = require('./nameFix');
const { stripForms } = require('./corpSuffix');

function fixColons(text) {
  return String(text || '').replace(/(^|\n)([ \t]*(?:[-*•]|\d+[.)])[ \t]+)?(\*\*[^*\n]{1,60}\*\*)[ \t]*[;；][ \t]*/g, (m, nl, bullet, label) => `${nl}${bullet || ''}${label}: `);
}

const SUITES = {
  relation_rules: (c) => {
    const out = rel.fixRelation({ ...c.input });
    if (!c.expect.keep) return out === null ? null : `kept as ${out.relation} ${out.src} -> ${out.dst}`;
    if (!out) return 'dropped';
    for (const k of ['relation', 'src', 'dst']) if (c.expect[k] && out[k] !== c.expect[k]) return `${k} = ${out[k]} (expected ${c.expect[k]})`;
    return null;
  },
  merge_pairs: (c) => {
    const got = reg.sameCompanyName(c.a, c.b, c.opts || {}) || stripForms(c.a) === stripForms(c.b);
    return got === c.same ? null : `merged = ${got} (expected ${c.same})`;
  },
  roles: (c) => {
    const got = reg.refineRole(c.ai, c.ctx);
    return got === c.expect ? null : `role = ${got} (expected ${c.expect})`;
  },
  typos: (c) => {
    const got = canonicalizeProperNouns(c.text, c.materials || [], c.roster || []);
    return got === c.expect ? null : `got "${got}"`;
  },
  evidence_names: (c) => {
    const got = rel.evidenceNamesBoth(c.evidence, c.src, c.dst);
    return got === c.expect ? null : `names both = ${got} (expected ${c.expect})`;
  },
  roster_aliases: (c) => {
    const { map, baseMap } = rel.rosterAliasMap([{ name: c.company, aliases: c.aliases }]);
    const got = map.get(c.input.toLowerCase().trim()) || baseMap.get(rel.baseKey(c.input)) || c.input;
    return got === c.expect ? null : `canonical = ${got} (expected ${c.expect})`;
  },
  colons: (c) => {
    const got = fixColons(c.text);
    return got === c.expect ? null : `got "${got}"`;
  },
};

function runDeterministic(g = golden) {
  const suites = {};
  for (const [name, check] of Object.entries(SUITES)) {
    const cases = g[name] || [];
    const failures = [];
    for (const c of cases) {
      let problem;
      try { problem = check(c); } catch (err) { problem = `error: ${err.message}`; }
      if (problem) failures.push({ id: c.id, problem, note: c.note || null });
    }
    suites[name] = { total: cases.length, passed: cases.length - failures.length, accuracy: cases.length ? (cases.length - failures.length) / cases.length : null, failures };
  }
  return suites;
}

// Live audit against the stored relations (needs the database).
async function runLiveAudit(pool, g = golden) {
  const cases = g.live_relations || [];
  const { rows } = await pool.query('SELECT src, dst, relation, status FROM company_relations');
  const key = (n) => rel.baseKey(n).replace(/\s+/g, '');
  const find = (c) => rows.filter((r) => r.relation === c.relation && ((key(r.src) === key(c.src) && key(r.dst) === key(c.dst)) || (c.relation === 'jv_partner' && key(r.src) === key(c.dst) && key(r.dst) === key(c.src))));
  const failures = [];
  for (const c of cases) {
    const hits = find(c);
    const active = hits.filter((h) => h.status !== 'ended');
    let problem = null;
    if (c.verdict === 'correct' && !active.length) problem = hits.length ? 'present but ended' : 'missing';
    if (c.verdict === 'wrong' && active.length) problem = 'still stored as an active relation';
    if (c.verdict === 'ended' && !(hits.length && !active.length)) problem = hits.length ? 'still active' : 'missing (should exist as ended)';
    if (problem) failures.push({ id: c.id, problem, note: `${c.src} -> ${c.dst} (${c.relation}, ${c.verdict})` });
  }
  return { total: cases.length, passed: cases.length - failures.length, accuracy: cases.length ? (cases.length - failures.length) / cases.length : null, failures };
}

async function runAll(pool) {
  const suites = runDeterministic();
  try { suites.live_relations = await runLiveAudit(pool); } catch (err) { suites.live_relations = { total: 0, passed: 0, accuracy: null, failures: [], error: err.message }; }
  const total = Object.values(suites).reduce((a, s) => a + s.total, 0);
  const passed = Object.values(suites).reduce((a, s) => a + s.passed, 0);
  const result = { version: golden.version, ranAt: new Date().toISOString(), total, passed, accuracy: total ? passed / total : null, suites };
  try { await pool.query('INSERT INTO eval_runs (result) VALUES ($1)', [JSON.stringify(result)]); } catch (_) { /* table may not exist yet */ }
  return result;
}

async function getRecent(pool, n = 10) {
  const { rows } = await pool.query('SELECT id, created_at, result FROM eval_runs ORDER BY id DESC LIMIT $1', [n]);
  return rows.map((r) => ({ id: r.id, at: r.created_at, accuracy: r.result.accuracy, total: r.result.total, passed: r.result.passed, suites: Object.fromEntries(Object.entries(r.result.suites || {}).map(([k, v]) => [k, { total: v.total, passed: v.passed, accuracy: v.accuracy }])), failures: Object.entries(r.result.suites || {}).flatMap(([k, v]) => (v.failures || []).map((f) => ({ suite: k, ...f }))) }));
}

module.exports = { runDeterministic, runLiveAudit, runAll, getRecent, golden };
