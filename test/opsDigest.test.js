const test = require('node:test');
const assert = require('node:assert/strict');
const { buildDigest, runDigest } = require('../server/lib/opsDigest');
const { opsDigestHandler } = require('../server/lib/cronRunner');

const health = { status: 'ok', summary: 'Pipeline healthy.\n- [PASS] headline: ready' };
const router = { status: 'pass', check: { detail: '20/20 searches answered' } };
const feedback = { total: 40, liked: 30, disliked: 10, likeRate: 0.75, findings: ['표 포함 호평률 90%'] };

test('buildDigest: all sections, overall status is the worst of health and router', () => {
  const d = buildDigest({ day: '2026-10-31', health, router, feedback, doctor: { at: 'x', outcome: 'healthy', humanNeeded: false } });
  assert.equal(d.status, 'ok'); assert.match(d.subject, /정상/);
  for (const h of ['■ 파이프라인', '■ AI 라우터', '■ 답변 평가', '■ Doctor']) assert.ok(d.text.includes(h));
  assert.equal(buildDigest({ day: 'd', health, router: { status: 'fail', check: { detail: 'down' } } }).status, 'failed');
  assert.equal(buildDigest({ day: 'd', health: { status: 'warn', summary: 's' }, router }).status, 'warn');
});
test('buildDigest: unreadable parts are reported as unknown, not guessed', () => {
  const d = buildDigest({ day: 'd', health: null, router: null, feedback: null, doctor: null });
  assert.equal(d.status, 'unknown'); assert.match(d.text, /확인 불가/);
});
test('runDigest sends once with a per-day key; urgent only when failed', async () => {
  const sent = [];
  const r = await runDigest({ now: new Date('2026-10-31T03:07:00Z'), health, router, feedback, doctor: null, send: async (a) => { sent.push(...a); return { configured: true, sent: 1, failed: 0, skipped: 0 }; } });
  assert.equal(sent[0].key, 'digest-2026-10-31'); assert.equal(sent[0].urgent, false); assert.equal(r.delivery.sent, 1);
});
test('handler: 401, 200 delivered or already sent today, 502 nothing delivered', async () => {
  process.env.CRON_SECRET = 's';
  const call = async (run, auth) => { const o = { code: 200 }; const res = { status: (c) => { o.code = c; return res; }, json: (b) => { o.body = b; return res; } }; await opsDigestHandler({ run })({ headers: { authorization: auth }, query: {} }, res); return o; };
  assert.equal((await call(async () => ({}), undefined)).code, 401);
  assert.equal((await call(async () => ({ delivery: { sent: 1, skipped: 0 } }), 'Bearer s')).code, 200);
  assert.equal((await call(async () => ({ delivery: { sent: 0, skipped: 1 } }), 'Bearer s')).code, 200);
  assert.equal((await call(async () => ({ delivery: { configured: false, sent: 0, skipped: 0 } }), 'Bearer s')).code, 502);
});
