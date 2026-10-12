const test = require('node:test');
const assert = require('node:assert/strict');
const { parseSuggestResponse } = require('../server/lib/sourceMetadataSuggest');

function fullResponse(overrides = {}) {
  return JSON.stringify({
    name: 'USDA FAS PSD Online',
    source_type: '정부/국제기구 통계',
    region: '글로벌',
    commodities: ['팜유', '대두유'],
    access_format: ['web', 'CSV'],
    update_frequency: 'Monthly',
    coverage_note: '세계 유지종자 생산·소비·교역 공식 통계.',
    usage_note: '국가별 수급 동향 파악에 활용.',
    ...overrides,
  });
}

test('parseSuggestResponse: parses a well-formed response', () => {
  const result = parseSuggestResponse(fullResponse());
  assert.equal(result.name, 'USDA FAS PSD Online');
  assert.equal(result.source_type, '정부/국제기구 통계');
  assert.equal(result.region, '글로벌');
  assert.deepEqual(result.commodities, ['팜유', '대두유']);
  assert.deepEqual(result.access_format, ['web', 'CSV']);
  assert.equal(result.update_frequency, 'Monthly');
  assert.equal(result.coverage_note, '세계 유지종자 생산·소비·교역 공식 통계.');
  assert.equal(result.usage_note, '국가별 수급 동향 파악에 활용.');
});

test('parseSuggestResponse: strips a markdown code fence', () => {
  const result = parseSuggestResponse(`\`\`\`json\n${fullResponse()}\n\`\`\``);
  assert.equal(result.name, 'USDA FAS PSD Online');
});

test('parseSuggestResponse: throws on invalid JSON', () => {
  assert.throws(() => parseSuggestResponse('not json'), /not valid JSON/);
});

test('parseSuggestResponse: throws when the JSON is an array, not an object', () => {
  assert.throws(() => parseSuggestResponse('[1, 2, 3]'), /not a JSON object/);
});

test('parseSuggestResponse: missing/non-string string fields default to empty string', () => {
  const result = parseSuggestResponse(fullResponse({ name: 123, region: null, usage_note: undefined }));
  assert.equal(result.name, '');
  assert.equal(result.region, '');
  assert.equal(result.usage_note, '');
});

test('parseSuggestResponse: non-array array fields default to empty array', () => {
  const result = parseSuggestResponse(fullResponse({ commodities: 'not an array', access_format: null }));
  assert.deepEqual(result.commodities, []);
  assert.deepEqual(result.access_format, []);
});

test('parseSuggestResponse: filters access_format down to the allowed set only', () => {
  const result = parseSuggestResponse(fullResponse({ access_format: ['web', 'Word', 'API', 'docx'] }));
  assert.deepEqual(result.access_format, ['web', 'API']);
});

test('parseSuggestResponse: blank commodity/access_format entries are dropped', () => {
  const result = parseSuggestResponse(fullResponse({ commodities: ['팜유', '', '  '] }));
  assert.deepEqual(result.commodities, ['팜유']);
});
