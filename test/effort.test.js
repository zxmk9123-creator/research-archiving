const test = require('node:test');
const assert = require('node:assert/strict');
const effort = require('../server/lib/effort');

test('effort: unknown values fall back to medium; low and high add a writer instruction, medium adds none', () => {
  assert.equal(effort.normalize('high'), 'high');
  assert.equal(effort.normalize('turbo'), 'medium');
  assert.equal(effort.normalize(undefined), 'medium');
  assert.match(effort.promptBlock('low'), /간결/);
  assert.match(effort.promptBlock('high'), /상세/);
  assert.equal(effort.promptBlock('medium'), '');
  assert.ok(effort.LOW_CANDIDATES < 12);
});
