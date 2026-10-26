const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'style.css'), 'utf8');

test('card grid tracks use minmax(0, 1fr) at every breakpoint: a plain 1fr track grows to its content, so one card with an unbreakable title stretched the left column (742px vs 105px)', () => {
  const rules = css.match(/\.grid \{[^}]*\}/g) || [];
  assert.equal(rules.length, 3, 'desktop, tablet and phone rules');
  for (const r of rules) {
    assert.match(r, /grid-template-columns:[^;]*minmax\(0, 1fr\)/, r);
    assert.ok(!/repeat\(\d, 1fr\)|columns: 1fr;/.test(r), `plain 1fr track in: ${r}`);
  }
  assert.match(css, /\.grid > \.card \{ min-width: 0; \}/);
  assert.match(css, /\.card-body h3[^{]*\{ overflow-wrap: anywhere; \}/);
});
