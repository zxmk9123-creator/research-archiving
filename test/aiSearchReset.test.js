const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');

test('AI search: resetting the conversation aborts the in-flight request and frees the form (no waiting for the old answer)', () => {
  // the request is cancellable
  assert.match(app, /const controller = new AbortController\(\);\s*aiSearchAbort = controller;/);
  assert.match(app, /fetch\('\/api\/search', \{[\s\S]*?signal: controller\.signal/);
  // the reset handler aborts it, stops the status animation and re-enables submit
  const reset = app.match(/resetBtn\.onclick = \(\) => \{[\s\S]*?\n    \};/)[0];
  assert.match(reset, /aiSearchAbort\.abort\(\)/);
  assert.match(reset, /stopAiSearchStatus\(/);
  assert.match(reset, /submitBtn\.disabled = false/);
  // an aborted run neither shows an error nor touches the state of a search started after the reset
  assert.match(app, /if \(controller\.signal\.aborted\) return;/);
  assert.match(app, /if \(aiSearchAbort === controller\) \{[\s\S]*?stopAiSearchStatus\(moduleEl\);[\s\S]*?submitBtn\.disabled = false;/);
});

test('server side: a client disconnect aborts the upstream AI call (so the reset also stops the API work)', () => {
  const search = fs.readFileSync(path.join(__dirname, '..', 'server', 'routes', 'search.js'), 'utf8');
  assert.match(search, /res\.once\('close', onClose\)/);
  assert.match(search, /controller\.abort\(/);
  assert.match(search, /provider\.callProviderWithFallbackStreaming\([\s\S]*?\{ signal, lane: 'chat' \}/);
});
