const test = require('node:test');
const assert = require('node:assert/strict');
const pool = require('../server/db/pool');
const cd = require('../server/lib/companyDiscovery');
const { parseDraftResponse } = require('../server/lib/aiDraft');

function mockPool(handler) {
  const original = pool.query;
  const calls = [];
  pool.query = async (text, params) => { calls.push({ text, params }); return handler(text, params) || { rows: [], rowCount: 0 }; };
  return { calls, restore: () => { pool.query = original; } };
}

test('extractCompanyNames: keeps clean business names, drops agencies/terms/junk, dedupes, caps at 5', () => {
  const out = cd.extractCompanyNames(['Neste', { name: ' Eni ' }, 'neste', 'IATA', 'Reuters', 'EU', 'SAF', '12 Corp', 'ab', '에코세레스', 'A Co', 'Beta Fuels', 'Gamma Oil', 'Delta Energy', 'Epsilon Bio']);
  assert.deepEqual(out, ['Neste', 'Eni', '에코세레스', 'A Co', 'Beta Fuels']);
  assert.deepEqual(cd.extractCompanyNames('Neste'), []);
  assert.deepEqual(cd.extractCompanyNames(undefined), []);
});

test('parseDraftResponse: the model\'s companies field is validated and returned', () => {
  const raw = JSON.stringify({ eligible: true, publication_decision: 'PASS', summary: 's', insight: 'i', companies: ['Neste', 'IATA', 'Neste'] });
  const draft = parseDraftResponse(raw, { sectors: [], usages: [] });
  assert.deepEqual(draft.companies, ['Neste']);
  assert.deepEqual(parseDraftResponse(JSON.stringify({ eligible: true }), { sectors: [], usages: [] }).companies, []);
});

test('recordCompanyMentions: unknown companies are filed as candidates, tracked ones are skipped', async () => {
  const { calls, restore } = mockPool((text) => {
    if (text.includes('FROM companies WHERE watched')) return { rows: [] };
    if (text.startsWith('SELECT name, aliases FROM companies')) return { rows: [{ name: 'Neste', aliases: ['네스테'] }] };
    if (text.includes('INSERT INTO company_candidates')) return { rows: [{ name_key: 'newco', name: 'NewCo', item_ids: [5], mention_count: 1, status: 'candidate' }] };
    return { rows: [] };
  });
  try {
    const r = await cd.recordCompanyMentions({ id: 5, title: 't', ai_summary: 's', ai_companies: ['Neste', 'NewCo'] });
    assert.equal(r.recorded, 1);
    const inserts = calls.filter((c) => c.text.includes('INSERT INTO company_candidates'));
    assert.equal(inserts.length, 1);
    assert.deepEqual(inserts[0].params, ['newco', 'NewCo', 5]);
    assert.ok(!calls.some((c) => c.text.includes('INSERT INTO companies')), 'below the threshold: not promoted');
  } finally {
    restore();
  }
});

test('recordCompanyMentions: a candidate reaching the threshold is promoted to the watchlist and its items are tagged', async () => {
  const { calls, restore } = mockPool((text) => {
    if (text.startsWith('SELECT name, aliases FROM companies')) return { rows: [] };
    if (text.includes('INSERT INTO company_candidates')) return { rows: [{ name_key: 'newco', name: 'NewCo', item_ids: [1, 2, 5], mention_count: 3, status: 'candidate' }] };
    if (text.includes('INSERT INTO companies')) return { rows: [{ id: 77 }] };
    return { rows: [] };
  });
  try {
    await cd.recordCompanyMentions({ id: 5, title: 't', ai_summary: 's', ai_companies: ['NewCo'] });
    const promote = calls.find((c) => c.text.includes('INSERT INTO companies'));
    assert.deepEqual(promote.params, ['NewCo', ['NewCo']]);
    const tag = calls.find((c) => c.text.includes('INSERT INTO item_companies') && c.text.includes('unnest'));
    assert.deepEqual(tag.params, [[1, 2, 5], 77]);
    assert.ok(calls.some((c) => c.text.includes("status = 'promoted'")));
  } finally {
    restore();
  }
});

test('recordCompanyMentions: a database error never throws into the publish path', async () => {
  const { restore } = mockPool(() => { throw new Error('boom'); });
  try {
    const r = await cd.recordCompanyMentions({ id: 1, title: 't', ai_summary: 's', ai_companies: ['NewCo'] });
    assert.equal(r.recorded, 0);
  } finally {
    restore();
  }
});
