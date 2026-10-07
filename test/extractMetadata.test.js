const test = require('node:test');
const assert = require('node:assert/strict');
const { isBotBlockPage } = require('../server/lib/extractMetadata');

// Regression for the production finding: a bot-block/CAPTCHA interstitial
// (Radware, Akamai "Client Challenge", Cloudflare) returns HTTP 200 with a
// real <title>, so res.ok alone can't catch it — several Archive
// Discovery items were archived with exactly these titles before this check.

test('isBotBlockPage: recognizes known bot-block/CAPTCHA interstitial titles', () => {
  assert.equal(isBotBlockPage('Client Challenge'), true);
  assert.equal(isBotBlockPage('Radware Bot Manager Captcha'), true);
  assert.equal(isBotBlockPage('Just a moment...'), true);
  assert.equal(isBotBlockPage('Attention Required! | Cloudflare'), true);
  assert.equal(isBotBlockPage('Access Denied'), true);
  assert.equal(isBotBlockPage('Pardon Our Interruption'), true);
});

test('isBotBlockPage: is case-insensitive and tolerates surrounding whitespace', () => {
  assert.equal(isBotBlockPage('  client challenge  '), true);
  assert.equal(isBotBlockPage('CLIENT CHALLENGE'), true);
});

test('isBotBlockPage: does not flag a real article title, even one that mentions captcha/verification in passing', () => {
  assert.equal(isBotBlockPage('Palm Oil Market to Hit USD 105.15 Billion by 2032'), false);
  assert.equal(isBotBlockPage('How CAPTCHA verification works on e-commerce sites'), false);
  assert.equal(isBotBlockPage(null), false);
  assert.equal(isBotBlockPage(undefined), false);
  assert.equal(isBotBlockPage(''), false);
});
