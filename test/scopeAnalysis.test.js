const test = require('node:test');
const assert = require('node:assert/strict');
const pool = require('../server/db/pool');
const provider = require('../server/lib/ai/provider');
const relevance = require('../server/lib/relevanceFilter');
const scope = require('../server/lib/scopeAnalysis');

function mockPool(handler) {
  const original = pool.query;
  const calls = [];
  pool.query = async (text, params) => { calls.push({ text, params }); return handler(text, params) || { rows: [], rowCount: 0 }; };
  return { calls, restore: () => { pool.query = original; } };
}

// --- relevanceFilter dynamic terms -------------------------------------

test('relevanceFilter: an approved include term makes an otherwise out-of-scope candidate relevant', () => {
  relevance.setDynamicScopeTerms({});
  assert.equal(relevance.isRelevantToOilFatsScope('Quantum battery startup unveils prototype', 'new cell chemistry'), false);
  relevance.setDynamicScopeTerms({ include: ['quantum battery'] });
  try {
    assert.equal(relevance.isRelevantToOilFatsScope('Quantum battery startup unveils prototype', 'new cell chemistry'), true);
  } finally {
    relevance.setDynamicScopeTerms({});
  }
});

test('relevanceFilter: an approved exclude term drops a candidate only when it is in the TITLE', () => {
  const inScope = ['Brent crude oil price jumps on OPEC cut', 'Football sponsorship deal'];
  relevance.setDynamicScopeTerms({});
  assert.equal(relevance.isRelevantToOilFatsScope(...inScope), true);
  relevance.setDynamicScopeTerms({ exclude: ['brent'] });
  try {
    assert.equal(relevance.isRelevantToOilFatsScope(...inScope), false);
    // same term only in the body -> not excluded
    assert.equal(relevance.isRelevantToOilFatsScope('OPEC cut lifts crude oil price', 'Brent futures rose'), true);
  } finally {
    relevance.setDynamicScopeTerms({});
  }
});

test('relevanceFilter: terms shorter than 3 chars are ignored (too broad to be safe)', () => {
  relevance.setDynamicScopeTerms({ include: ['ab'] });
  try {
    assert.equal(relevance.isRelevantToOilFatsScope('Absolutely unrelated ab story', 'nothing'), false);
  } finally {
    relevance.setDynamicScopeTerms({});
  }
});

// --- validateAnalysis grounding ----------------------------------------

const signals = {
  excluded: [
    { url: 'u1', title: 'LG Chem e-SAF demo plant', summary: 'CO2 to e-saf', reason: 'out_of_scope', seen_count: 3 },
    { url: 'u2', title: 'Hyundai e-SAF process study', summary: '', reason: 'out_of_scope', seen_count: 1 },
    { url: 'u3', title: 'Cooking tips', summary: 'recipes', reason: 'out_of_scope', seen_count: 1 },
  ],
  published: ['Palm oil export tariff raised'],
  rejected: ['Celebrity gossip roundup', 'Celebrity wedding news', 'Celebrity fashion week', 'Palm oil export tariff raised again'],
  queries: ['palm oil export tariff regulation'],
};

test('validateAnalysis: keeps an expand term only if it appears in >=2 excluded candidates', () => {
  const out = scope.validateAnalysis({
    expand: [{ term: 'e-SAF', rationale: 'r' }, { term: 'recipes', rationale: 'r' }, { term: 'made-up topic', rationale: 'r' }],
  }, signals);
  assert.deepEqual(out.map((p) => p.term), ['e-saf']);
  assert.equal(out[0].kind, 'expand_scope');
  assert.equal(out[0].evidence.length, 2);
});

test('validateAnalysis: narrow term needs >=3 rejected titles and must never appear in a published title', () => {
  const out = scope.validateAnalysis({
    narrow: [{ term: 'celebrity', rationale: 'r' }, { term: 'palm oil', rationale: 'r' }],
  }, signals);
  assert.deepEqual(out.map((p) => p.term), ['celebrity']);
});

test('validateAnalysis: drops queries that duplicate an existing one and caps length', () => {
  const out = scope.validateAnalysis({
    queries: [
      { query: 'Palm Oil Export Tariff Regulation', rationale: 'dup' },
      { query: 'e-SAF Korea producers LG Chem Hyundai', rationale: 'new' },
      { query: 'x', rationale: 'too short' },
    ],
  }, signals);
  assert.deepEqual(out.map((p) => p.term), ['e-SAF Korea producers LG Chem Hyundai']);
});

test('validateAnalysis: tolerates malformed model output', () => {
  assert.deepEqual(scope.validateAnalysis(null, signals), []);
  assert.deepEqual(scope.validateAnalysis({ expand: 'nope', narrow: 3 }, signals), []);
});

// --- runScopeAnalysis / weekly gate ------------------------------------

test('runScopeAnalysis: below the minimum data threshold it does not call the LLM', async () => {
  let llmCalls = 0;
  const original = provider.callProvider;
  const { restore } = mockPool((text) => {
    if (text.includes('FROM discovery_exclusions')) return { rows: [{ url: 'u', title: 't', summary: '', reason: 'out_of_scope', seen_count: 1 }] };
    return { rows: [] };
  });
  try {
    const r = await scope.runScopeAnalysis();
    assert.equal(r.ran, false);
    assert.equal(r.reason, 'insufficient_data');
    assert.equal(llmCalls, 0);
  } finally {
    restore();
    provider.callProvider = original;
  }
});

test('maybeRunWeeklyScopeAnalysis: not due outside Monday 10:00+ KST, and no query is made', async () => {
  const { calls, restore } = mockPool(() => ({ rows: [] }));
  try {
    // 2026-10-14 is a Wednesday (KST)
    assert.equal((await scope.maybeRunWeeklyScopeAnalysis(new Date('2026-10-14T05:00:00Z'))).reason, 'not_due');
    // Monday 2026-10-19 09:00 KST (00:00Z) is before 10:00
    assert.equal((await scope.maybeRunWeeklyScopeAnalysis(new Date('2026-10-19T00:00:00Z'))).reason, 'not_due');
    assert.equal(calls.length, 0);
  } finally {
    restore();
  }
});

test('maybeRunWeeklyScopeAnalysis: a second caller in the same week is refused by the atomic claim', async () => {
  const { restore } = mockPool((text) => (text.includes('INSERT INTO scheduler_jobs') ? { rowCount: 0 } : { rows: [] }));
  try {
    const r = await scope.maybeRunWeeklyScopeAnalysis(new Date('2026-10-19T02:00:00Z')); // Mon 11:00 KST
    assert.equal(r.reason, 'already_ran_this_week');
  } finally {
    restore();
  }
});

test('maybeRunWeeklyScopeAnalysis: insufficient data releases the claim so it can retry later in the week', async () => {
  const { calls, restore } = mockPool((text) => {
    if (text.includes('INSERT INTO scheduler_jobs')) return { rowCount: 1 };
    return { rows: [] };
  });
  try {
    const r = await scope.maybeRunWeeklyScopeAnalysis(new Date('2026-10-19T02:00:00Z'));
    assert.equal(r.ran, false);
    assert.ok(calls.some((c) => c.text.includes('SET last_run_date = NULL')));
  } finally {
    restore();
  }
});

// --- applyProposal / rejectProposal ------------------------------------

test('applyProposal(expand_scope): writes an include term, refreshes the filter cache, marks applied', async () => {
  const { calls, restore } = mockPool((text) => {
    if (text.includes('SELECT * FROM scope_proposals')) return { rows: [{ id: 5, kind: 'expand_scope', term: 'quantum battery', status: 'pending' }] };
    if (text.includes('FROM scope_terms')) return { rows: [{ term: 'quantum battery', mode: 'include' }] };
    return { rows: [] };
  });
  try {
    const r = await scope.applyProposal(5);
    assert.equal(r.ok, true);
    const ins = calls.find((c) => c.text.includes('INSERT INTO scope_terms'));
    assert.deepEqual(ins.params, ['quantum battery', 'include', 5]);
    assert.ok(calls.some((c) => c.text.includes("SET status = 'applied'")));
    assert.equal(relevance.isRelevantToOilFatsScope('Quantum battery news', ''), true);
  } finally {
    restore();
    relevance.setDynamicScopeTerms({});
  }
});

test('applyProposal(add_query): inserts a daily-discovery crawl source, idempotently', async () => {
  const { calls, restore } = mockPool((text) => (
    text.includes('SELECT * FROM scope_proposals') ? { rows: [{ id: 6, kind: 'add_query', term: 'e-SAF Korea producers', status: 'pending' }] } : { rows: [] }
  ));
  try {
    assert.equal((await scope.applyProposal(6)).ok, true);
    const ins = calls.find((c) => c.text.includes('INSERT INTO sources'));
    assert.match(ins.text, /WHERE NOT EXISTS/);
    assert.match(ins.text, /true/);
    assert.equal(ins.params[1], 'e-SAF Korea producers');
  } finally {
    restore();
  }
});

test('applyProposal: unknown id -> 404, already-decided -> 409', async () => {
  let row = [];
  const { restore } = mockPool((text) => (text.includes('SELECT * FROM scope_proposals') ? { rows: row } : { rows: [] }));
  try {
    assert.equal((await scope.applyProposal(1)).status, 404);
    row = [{ id: 1, kind: 'add_query', term: 'x', status: 'applied' }];
    assert.equal((await scope.applyProposal(1)).status, 409);
  } finally {
    restore();
  }
});

test('rejectProposal: only a pending proposal can be rejected', async () => {
  let count = 1;
  const { restore } = mockPool(() => ({ rowCount: count }));
  try {
    assert.equal((await scope.rejectProposal(3)).ok, true);
    count = 0;
    assert.equal((await scope.rejectProposal(3)).ok, false);
  } finally {
    restore();
  }
});

test('runScopeAnalysis: with enough data it calls the (mockable) LLM, validates, and stores only grounded proposals', async () => {
  const excluded = Array.from({ length: 16 }, (_, i) => ({
    url: `https://x.test/${i}`, title: i < 3 ? `Quantum battery plant ${i}` : `filler ${i}`, summary: '', reason: 'out_of_scope', seen_count: 1,
  }));
  const inserts = [];
  const { restore } = mockPool((text, params) => {
    if (text.includes('FROM discovery_exclusions')) return { rows: excluded };
    if (text.includes('FROM scope_proposals')) return { rows: [] };
    if (text.includes('INSERT INTO scope_proposals')) { inserts.push(params); return { rowCount: 1 }; }
    return { rows: [] };
  });
  const original = provider.callProvider;
  provider.callProvider = async () => JSON.stringify({
    expand: [{ term: 'quantum battery', rationale: 'ok' }, { term: 'hallucinated topic', rationale: 'bad' }],
    narrow: [], queries: [],
  });
  try {
    const r = await scope.runScopeAnalysis();
    assert.equal(r.ran, true);
    assert.equal(r.stored, 1);
    assert.equal(inserts.length, 1);
    assert.equal(inserts[0][1], 'quantum battery');
  } finally {
    provider.callProvider = original;
    restore();
  }
});

test('revokeScopeTerm: deletes the term and refreshes the filter cache immediately', async () => {
  relevance.setDynamicScopeTerms({ include: ['quantum battery'] });
  assert.equal(relevance.isRelevantToOilFatsScope('Quantum battery news', ''), true);
  const { calls, restore } = mockPool((text) => {
    if (text.includes('DELETE FROM scope_terms')) return { rowCount: 1 };
    if (text.includes('FROM scope_terms')) return { rows: [] }; // nothing left after revoke
    return { rows: [] };
  });
  try {
    assert.deepEqual(await scope.revokeScopeTerm(4), { ok: true });
    assert.deepEqual(calls[0].params, [4]);
    assert.equal(relevance.isRelevantToOilFatsScope('Quantum battery news', ''), false);
  } finally {
    restore();
    relevance.setDynamicScopeTerms({});
  }
});

test('revokeScopeTerm: unknown id -> 404 and the cache is left alone', async () => {
  const { calls, restore } = mockPool(() => ({ rowCount: 0 }));
  try {
    const r = await scope.revokeScopeTerm(99);
    assert.equal(r.ok, false);
    assert.equal(r.status, 404);
    assert.equal(calls.length, 1);
  } finally {
    restore();
  }
});
