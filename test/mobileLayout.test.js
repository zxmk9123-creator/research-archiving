const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'style.css'), 'utf8');

test('mobile header: nav is one scrollable row that never wraps or widens the page', () => {
  const m = css.match(/@media \(max-width: 720px\) \{\s*html \{[\s\S]*?\n\}/);
  assert.ok(m, 'mobile block');
  assert.match(m[0], /\.topbar nav \{[^}]*overflow-x: auto/);
  assert.match(m[0], /white-space: nowrap/);
  assert.match(m[0], /\.sources-table \{[^}]*overflow-x: auto/);
});
