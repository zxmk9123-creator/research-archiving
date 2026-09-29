const test = require('node:test');
const assert = require('node:assert/strict');
const { translateSourceError } = require('../public/sourceErrors');

test('translateSourceError: 404 maps to a human-readable not-found message', () => {
  const result = translateSourceError('fetch failed: 404');
  assert.equal(result.message, '수집 주소에서 자료를 찾지 못했어요');
  assert.equal(result.detail, 404);
});

test('translateSourceError: 403 maps to a permission message', () => {
  const result = translateSourceError('fetch failed: 403');
  assert.equal(result.message, '접근 권한이 없어 자료를 가져오지 못했어요');
  assert.equal(result.detail, 403);
});

test('translateSourceError: 429 maps to a rate-limit message', () => {
  const result = translateSourceError('fetch failed: 429');
  assert.equal(result.message, '요청이 많아 잠시 후 다시 확인할게요');
  assert.equal(result.detail, 429);
});

test('translateSourceError: any 5xx maps to a generic provider-unavailable message', () => {
  for (const status of [500, 502, 503, 599]) {
    const result = translateSourceError(`fetch failed: ${status}`);
    assert.equal(result.message, '제공처에서 응답하지 않았어요');
    assert.equal(result.detail, status);
  }
});

test('translateSourceError: a timeout message maps to a timeout translation', () => {
  const result = translateSourceError('The operation was aborted due to timeout');
  assert.equal(result.message, '응답 시간이 너무 길어 확인하지 못했어요');
  assert.equal(result.detail, 'timeout');
});

test('translateSourceError: unknown/empty error falls back to a generic message without exposing the raw string', () => {
  assert.equal(translateSourceError('').message, '자료를 가져오는 중 문제가 발생했어요');
  assert.equal(translateSourceError(null).message, '자료를 가져오는 중 문제가 발생했어요');
  assert.equal(translateSourceError('ECONNRESET').message, '자료를 가져오는 중 문제가 발생했어요');
});
