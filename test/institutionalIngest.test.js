// Collaborators are stubbed on their module objects before institutionalIngest destructures them (one process per test file).
const test = require('node:test');
const assert = require('node:assert/strict');

const stub = { discover: [], pdf: async () => Buffer.from('x'), text: async () => ({ text: '팜유 시장 본문' }), relevant: () => true, draft: async () => ({ ok: true }), apply: async () => ({ archived: true }) };
require('../server/lib/adapters/institutionPdf').discoverReports = async () => stub.discover;
const pdf = require('../server/lib/pdfExtract');
pdf.fetchPdfBuffer = (...a) => stub.pdf(...a);
pdf.extractPdfText = (...a) => stub.text(...a);
require('../server/lib/companyMatch').matchCompanies = async () => {};
require('../server/lib/relevanceFilter').isRelevantToOilFatsScope = (...a) => stub.relevant(...a);
const ai = require('../server/lib/aiDraft');
ai.generateAiDraftForItem = (...a) => stub.draft(...a);
ai.applyAiDraftIfEligible = (...a) => stub.apply(...a);

const pool = require('../server/db/pool');
const { collectInstitutionSource } = require('../server/lib/institutionalIngest');

function mockDb({ existingUrls = [], titles = [], insert } = {}) {
  const original = pool.query;
  const calls = [];
  let nextId = 100;
  pool.query = async (text, params) => {
    calls.push({ text, params });
    if (/SELECT source_url FROM items/.test(text)) return { rows: existingUrls.map((u) => ({ source_url: u })) };
    if (/SELECT title FROM items/.test(text)) return { rows: titles.map((t) => ({ title: t })) };
    if (/INSERT INTO items/.test(text)) { if (insert) return insert(params); return { rows: [{ id: nextId++ }] }; }
    return { rows: [] };
  };
  return { calls, restore: () => { pool.query = original; } };
}
const reset = () => Object.assign(stub, { pdf: async () => Buffer.from('x'), text: async () => ({ text: '본문' }), relevant: () => true, draft: async () => ({ ok: true }), apply: async () => ({ archived: true }) });
const SRC = { id: 9 };
// clearly different titles: similar ones would (correctly) be treated as near-duplicates of each other
const TITLES = ['Global palm oil outlook', 'Indonesia biodiesel mandate review', 'World Bank commodity pink sheet', 'Soybean crush margin study'];
const cand = (n) => ({ title: TITLES[n - 1], link: `https://inst.example/${n}.pdf` });

test('happy path: new reports are archived and counted; the source is marked collected', async () => {
  reset(); stub.discover = [cand(1), cand(2)];
  const m = mockDb();
  try {
    const r = await collectInstitutionSource(SRC);
    assert.equal(r.ok, true);
    assert.deepEqual([r.discovered, r.archived, r.rejected, r.filtered, r.failed, r.count], [2, 2, 0, 0, 0, 2]);
    assert.ok(m.calls.some((c) => /UPDATE sources SET last_collected_at/.test(c.text)));
  } finally { m.restore(); }
});

test('already-archived URLs and near-duplicate titles are skipped without any insert', async () => {
  reset(); stub.discover = [cand(1), { title: 'Commodity Markets Outlook April 2026', link: 'https://inst.example/new.pdf' }];
  const m = mockDb({ existingUrls: [cand(1).link], titles: ['Commodity Markets Outlook, April 2026'] });
  try {
    const r = await collectInstitutionSource(SRC);
    assert.equal(r.archived, 0);
    assert.equal(m.calls.filter((c) => /INSERT INTO items/.test(c.text)).length, 0);
  } finally { m.restore(); }
});

test('an AI-rejected report is counted as rejected, not archived; an AI failure is counted failed', async () => {
  reset(); stub.discover = [cand(1), cand(2)];
  stub.apply = async () => ({ archived: false });
  let m = mockDb();
  try { const r = await collectInstitutionSource(SRC); assert.deepEqual([r.archived, r.rejected], [0, 2]); } finally { m.restore(); }
  reset(); stub.discover = [cand(3)];
  stub.draft = async () => ({ ok: false, error: 'provider down' });
  m = mockDb();
  try { const r = await collectInstitutionSource(SRC); assert.equal(r.failed, 1); assert.equal(r.details[0].stage, 'ai_screening'); } finally { m.restore(); }
});

test('PDF extraction failure keeps the item as an auditable failed draft and the rest of the run continues', async () => {
  reset(); stub.discover = [cand(1), cand(2)];
  let n = 0;
  stub.text = async () => { n += 1; if (n === 1) throw new Error('scanned PDF'); return { text: '본문' }; };
  const m = mockDb();
  try {
    const r = await collectInstitutionSource(SRC);
    assert.deepEqual([r.failed, r.archived], [1, 1]);
    const upd = m.calls.find((c) => /ai_status = 'failed'/.test(c.text));
    assert.match(upd.params[0], /PDF acquisition\/extraction failed: scanned PDF/);
  } finally { m.restore(); }
});

test('text that fails the scope pre-filter is filtered before any AI call', async () => {
  reset(); stub.discover = [cand(1)];
  stub.relevant = () => false;
  let aiCalls = 0;
  stub.draft = async () => { aiCalls += 1; return { ok: true }; };
  const m = mockDb();
  try { const r = await collectInstitutionSource(SRC); assert.equal(r.filtered, 1); assert.equal(aiCalls, 0); } finally { m.restore(); }
});

test('a concurrent run that inserted the same URL (23505) is skipped silently; another insert error counts as failed', async () => {
  reset(); stub.discover = [cand(1), cand(2)];
  let n = 0;
  const m = mockDb({ insert: () => { n += 1; throw Object.assign(new Error(n === 1 ? 'dup' : 'db down'), n === 1 ? { code: '23505' } : {}); } });
  try {
    const r = await collectInstitutionSource(SRC);
    assert.deepEqual([r.failed, r.archived], [1, 0]);
    assert.equal(r.details[0].stage, 'insert');
  } finally { m.restore(); }
});

test('discovery failure is reported on the source (last_error) and returned as ok:false', async () => {
  reset();
  require('../server/lib/adapters/institutionPdf').discoverReports = async () => { throw new Error('listing page 500'); };
  const m = mockDb();
  try {
    // institutionalIngest holds the original reference: re-require with the throwing stub
    delete require.cache[require.resolve('../server/lib/institutionalIngest')];
    const { collectInstitutionSource: again } = require('../server/lib/institutionalIngest');
    const r = await again(SRC);
    assert.deepEqual([r.ok, r.error], [false, 'listing page 500']);
    assert.ok(m.calls.some((c) => /SET last_error = \$1/.test(c.text) && c.params[0] === 'listing page 500'));
  } finally { m.restore(); }
});
