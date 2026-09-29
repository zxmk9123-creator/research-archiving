const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyEligibilityMatch } = require('../public/eligibilityMatch');

test('classifyEligibilityMatch: true/true is a match', () => {
  assert.equal(classifyEligibilityMatch(true, true), 'match');
});

test('classifyEligibilityMatch: false/false is a match', () => {
  assert.equal(classifyEligibilityMatch(false, false), 'match');
});

test('classifyEligibilityMatch: AI true, reviewer false is an AI false positive', () => {
  assert.equal(classifyEligibilityMatch(true, false), 'ai_false_positive');
});

test('classifyEligibilityMatch: AI false, reviewer true is an AI false negative', () => {
  assert.equal(classifyEligibilityMatch(false, true), 'ai_false_negative');
});

test('classifyEligibilityMatch: excludes items with no reviewer decision (NULL/undefined)', () => {
  assert.equal(classifyEligibilityMatch(true, null), null);
  assert.equal(classifyEligibilityMatch(false, null), null);
  assert.equal(classifyEligibilityMatch(true, undefined), null);
});

test('classifyEligibilityMatch: excludes items with no AI verdict, even if reviewed', () => {
  assert.equal(classifyEligibilityMatch(null, true), null);
  assert.equal(classifyEligibilityMatch(null, false), null);
  assert.equal(classifyEligibilityMatch(undefined, true), null);
});

test('classifyEligibilityMatch: excludes when both sides are unset', () => {
  assert.equal(classifyEligibilityMatch(null, null), null);
});
