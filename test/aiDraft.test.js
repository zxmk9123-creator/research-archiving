const test = require('node:test');
const assert = require('node:assert/strict');
const { parseDraftResponse, buildUserPrompt, buildTaxonomyBlock } = require('../server/lib/aiDraft');

const taxonomy = {
  sectors: [
    { id: 1, name: '식용유지' },
    { id: 3, name: '팜유' },
    { id: 4, name: '대두유' },
  ],
  usages: [
    { id: 1, name: 'NBO 작성' },
    { id: 3, name: '시장 전망' },
  ],
};

test('parseDraftResponse: accepts a valid structured response', () => {
  const raw = JSON.stringify({
    summary: '팜유 가격이 상승했다.',
    key_takeaway: '공급 차질이 원인이다.',
    suggested_sectors: [3],
    suggested_usages: [3],
  });
  const draft = parseDraftResponse(raw, taxonomy);
  assert.equal(draft.summary, '팜유 가격이 상승했다.');
  assert.equal(draft.keyTakeaway, '공급 차질이 원인이다.');
  assert.deepEqual(draft.suggestedSectors, [3]);
  assert.deepEqual(draft.suggestedUsages, [3]);
});

test('parseDraftResponse: strips a ```json code fence before parsing', () => {
  const raw = '```json\n{"summary":"요약","key_takeaway":"핵심","suggested_sectors":[],"suggested_usages":[]}\n```';
  const draft = parseDraftResponse(raw, taxonomy);
  assert.equal(draft.summary, '요약');
});

test('parseDraftResponse: rejects malformed JSON safely (no throw escapes as a crash, just a clear Error)', () => {
  assert.throws(() => parseDraftResponse('this is not json at all', taxonomy), /not valid JSON/);
});

test('parseDraftResponse: rejects a JSON array (not an object)', () => {
  assert.throws(() => parseDraftResponse('[1,2,3]', taxonomy), /not a JSON object/);
});

test('parseDraftResponse: rejects a response with no usable summary', () => {
  const raw = JSON.stringify({ summary: '', key_takeaway: 'x', suggested_sectors: [], suggested_usages: [] });
  assert.throws(() => parseDraftResponse(raw, taxonomy), /missing a usable summary/);
});

test('parseDraftResponse: discards unknown sector ids instead of persisting them', () => {
  const raw = JSON.stringify({
    summary: '요약',
    key_takeaway: '핵심',
    suggested_sectors: [3, 999], // 999 does not exist in taxonomy
    suggested_usages: [],
  });
  const draft = parseDraftResponse(raw, taxonomy);
  assert.deepEqual(draft.suggestedSectors, [3]);
});

test('parseDraftResponse: discards unknown usage ids instead of persisting them', () => {
  const raw = JSON.stringify({
    summary: '요약',
    key_takeaway: '핵심',
    suggested_sectors: [],
    suggested_usages: [3, 42], // 42 does not exist in taxonomy
  });
  const draft = parseDraftResponse(raw, taxonomy);
  assert.deepEqual(draft.suggestedUsages, [3]);
});

test('parseDraftResponse: deduplicates repeated ids from the model', () => {
  const raw = JSON.stringify({ summary: 's', key_takeaway: 'k', suggested_sectors: [3, 3, 1], suggested_usages: [] });
  const draft = parseDraftResponse(raw, taxonomy);
  assert.deepEqual(draft.suggestedSectors, [3, 1]);
});

test('parseDraftResponse: non-array suggestion fields degrade to empty arrays, not a crash', () => {
  const raw = JSON.stringify({ summary: 's', key_takeaway: 'k', suggested_sectors: 'not-an-array', suggested_usages: null });
  const draft = parseDraftResponse(raw, taxonomy);
  assert.deepEqual(draft.suggestedSectors, []);
  assert.deepEqual(draft.suggestedUsages, []);
});

test('buildUserPrompt: uses title + description, never claims to have read a full article', () => {
  const prompt = buildUserPrompt({ title: '팜유 뉴스', summary: '가격 상승' }, taxonomy);
  assert.match(prompt, /Title: 팜유 뉴스/);
  assert.match(prompt, /Description: 가격 상승/);
});

test('buildUserPrompt: falls back to "(none available)" when no description was collected', () => {
  const prompt = buildUserPrompt({ title: '제목만 있음', summary: null }, taxonomy);
  assert.match(prompt, /Description: \(none available\)/);
});

test('buildTaxonomyBlock: only lists the taxonomy actually passed in (grounding, not invented labels)', () => {
  const block = buildTaxonomyBlock(taxonomy.sectors, taxonomy.usages);
  assert.match(block, /3: 팜유/);
  assert.doesNotMatch(block, /어묵/); // sanity: nothing invented appears
});
