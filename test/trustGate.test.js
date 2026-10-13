const test = require('node:test');
const assert = require('node:assert/strict');
const {
  passesTrustGate,
  hasValidSourceUrl,
  hasPlausiblePublishedAt,
  hasUsableSummary,
  hasSaneMetadata,
} = require('../server/lib/trustGate');

function baseItem(overrides = {}) {
  return {
    source_url: 'https://example.org/article',
    published_at: '2026-01-01',
    title: 'Palm oil export tariff raised',
    ai_summary: 'Indonesia raised its palm oil export tariff to stabilize domestic supply.',
    ai_failure_type: null,
    ...overrides,
  };
}

test('passesTrustGate: a normal, well-formed item passes', () => {
  assert.equal(passesTrustGate(baseItem()), true);
});

test('hasValidSourceUrl: rejects a missing or malformed URL', () => {
  assert.equal(hasValidSourceUrl(baseItem({ source_url: '' })), false);
  assert.equal(hasValidSourceUrl(baseItem({ source_url: 'not a url' })), false);
  assert.equal(hasValidSourceUrl(baseItem({ source_url: 'ftp://example.org/x' })), false);
  assert.equal(hasValidSourceUrl(baseItem({ source_url: 'https://example.org/x' })), true);
});

test('hasPlausiblePublishedAt: a missing date is fine (extraction often finds none)', () => {
  assert.equal(hasPlausiblePublishedAt(baseItem({ published_at: null })), true);
});

test('hasPlausiblePublishedAt: rejects an unparseable or far-future date', () => {
  assert.equal(hasPlausiblePublishedAt(baseItem({ published_at: 'not a date' })), false);
  const farFuture = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  assert.equal(hasPlausiblePublishedAt(baseItem({ published_at: farFuture })), false);
});

test('hasPlausiblePublishedAt: allows a small future grace window (timezone slack)', () => {
  const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  assert.equal(hasPlausiblePublishedAt(baseItem({ published_at: tomorrow })), true);
});

test('hasUsableSummary: rejects a recorded AI failure even if ai_summary happens to be set', () => {
  assert.equal(hasUsableSummary(baseItem({ ai_failure_type: 'timeout' })), false);
});

test('hasUsableSummary: rejects a missing or too-short summary', () => {
  assert.equal(hasUsableSummary(baseItem({ ai_summary: null })), false);
  assert.equal(hasUsableSummary(baseItem({ ai_summary: '   ' })), false);
  assert.equal(hasUsableSummary(baseItem({ ai_summary: 'short' })), false);
});

test('hasUsableSummary: rejects a summary that is just the title restated (degenerate extraction)', () => {
  assert.equal(hasUsableSummary(baseItem({ ai_summary: 'Palm oil export tariff raised', title: 'Palm oil export tariff raised' })), false);
});

test('hasSaneMetadata: rejects a missing title or a bot-block interstitial title', () => {
  assert.equal(hasSaneMetadata(baseItem({ title: '' })), false);
  assert.equal(hasSaneMetadata(baseItem({ title: 'Just a moment...' })), false);
  assert.equal(hasSaneMetadata(baseItem({ title: 'Attention Required! | Cloudflare' })), false);
});

test('passesTrustGate: fails if any single check fails', () => {
  assert.equal(passesTrustGate(baseItem({ source_url: 'not a url' })), false);
  assert.equal(passesTrustGate(baseItem({ ai_failure_type: 'server_error' })), false);
  assert.equal(passesTrustGate(baseItem({ title: 'Just a moment...' })), false);
});
