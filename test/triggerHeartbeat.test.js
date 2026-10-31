const test = require('node:test');
const assert = require('node:assert/strict');
const pool = require('../server/db/pool');
const { classifyTrigger, recordTrigger, triggerIncidents } = require('../server/lib/triggerHeartbeat');
const { dispatchAlerts, keyOf, MAX_ATTEMPTS, RETRY_AFTER_MS } = require('../server/lib/opsAlerts');

function fakeJobs(initial = {}) {
  const docs = new Map(Object.entries(initial));
  const orig = pool.query;
  pool.query = async (text, params) => {
    if (/^SELECT/.test(text)) return { rows: docs.has(params[0]) ? [{ last_totals: JSON.parse(JSON.stringify(docs.get(params[0]))) }] : [] };
    if (/^INSERT/.test(text)) { if (docs.has(params[0])) return { rows: [] }; docs.set(params[0], JSON.parse(params[1])); return { rows: [{}] }; }
    if (JSON.stringify(docs.get(params[0])) !== params[2]) return { rows: [] };
    docs.set(params[0], JSON.parse(params[1]));
    return { rows: [{}] };
  };
  return { docs, restore: () => { pool.query = orig; } };
}
const T = (s) => new Date(s).getTime();

test('classifyTrigger: only Vercel cron and the workflow\'s own header are trusted; a bare curl or browser is unknown, not GitHub', () => {
  assert.equal(classifyTrigger('vercel-cron/1.0', ''), 'vercel');
  assert.equal(classifyTrigger('curl/8.5.0', 'github-actions'), 'github');
  assert.equal(classifyTrigger('curl/8.5.0', ''), 'unknown');
  assert.equal(classifyTrigger('Mozilla/5.0', ''), 'unknown');
  assert.equal(classifyTrigger('curl/8.5.0', 'something-else'), 'unknown');
});

test('recordTrigger: per-KST-day first/last/count per source, concurrency-safe merge, and a stable "since"', async () => {
  const f = fakeJobs({ trigger_heartbeat: { since: '2026-10-29T00:00:00.000Z', last: { vercel: '2026-10-29T00:00:00.000Z' }, days: { '2026-10-29': { vercel: { first: '2026-10-29T00:00:00.000Z', n: 1, last: '2026-10-29T00:00:00.000Z' } } } } });
  try {
    assert.equal(await recordTrigger('curl/8', 'github-actions', new Date('2026-10-29T05:07:00Z')), true);
    const d = f.docs.get('trigger_heartbeat');
    assert.equal(d.since, '2026-10-29T00:00:00.000Z');
    assert.equal(d.days['2026-10-29'].github.n, 1);
    assert.equal(d.days['2026-10-29'].vercel.n, 1);
    assert.equal(d.last.github, '2026-10-29T05:07:00.000Z');
  } finally { f.restore(); }
});

const hb = (days, extra = {}) => ({ since: '2026-10-27T00:00:00.000Z', last: {}, days, ...extra });

test('triggerIncidents: the morning deadline is 07:45 KST — before it nothing, after it a miss, and a Vercel self-heal does not erase the miss', () => {
  const day = '2026-10-29';
  const before = T('2026-10-28T22:40:00Z'); // 07:40 KST
  const after = T('2026-10-28T22:50:00Z'); // 07:50 KST
  const onlyVercel = hb({ [day]: { vercel: { first: '2026-10-28T22:00:00Z', n: 3, last: '2026-10-28T23:20:00Z' } } });
  assert.deepEqual(triggerIncidents(onlyVercel, { now: before }), []);
  const out = triggerIncidents(onlyVercel, { now: T('2026-10-29T00:30:00Z') }); // run already completed via Vercel
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, 'missed');
  assert.equal(out[0].key, `github_morning_missed:${day}`);
  assert.match(out[0].text, /vercel cron calls: 3/);
  assert.equal(triggerIncidents(onlyVercel, { now: after })[0].kind, 'missed');
  const delivered = hb({ [day]: { github: { first: '2026-10-28T22:30:00Z', n: 1, last: '2026-10-28T22:30:00Z' } } }, { last: { github: '2026-10-28T22:30:00Z' } });
  assert.deepEqual(triggerIncidents(delivered, { now: T('2026-10-29T00:30:00Z') }), [], 'a delayed but delivered call counts');
});

test('triggerIncidents: missing or late-starting telemetry and unattributed calls are telemetry, never a confirmed miss', () => {
  const now = T('2026-10-29T00:30:00Z');
  assert.equal(triggerIncidents(undefined, { now }).length, 0, 'not read: nothing to say');
  assert.deepEqual(triggerIncidents(null, { now }).map((i) => i.kind), ['telemetry']);
  const late = triggerIncidents({ since: '2026-10-28T23:50:00Z', last: {}, days: {} }, { now });
  assert.deepEqual(late.map((i) => i.kind), ['telemetry']);
  const unknown = triggerIncidents(hb({ '2026-10-29': { unknown: { first: '2026-10-28T22:10:00Z', n: 2, last: '2026-10-28T22:20:00Z' } } }), { now });
  assert.deepEqual(unknown.map((i) => i.kind), ['telemetry']);
  assert.match(unknown[0].text, /X-Trigger-Source/);
});

test('triggerIncidents: a 9 h silence after a GitHub call is a miss with its own key (a new silence is a new incident)', () => {
  const last = '2026-10-29T01:00:00Z';
  const deliveredToday = { '2026-10-29': { github: { first: last, n: 1, last } } };
  assert.deepEqual(triggerIncidents(hb(deliveredToday, { last: { github: last } }), { now: T('2026-10-29T08:00:00Z') }), [], '7 h is within what history shows');
  const out = triggerIncidents(hb(deliveredToday, { last: { github: last } }), { now: T('2026-10-29T10:15:00Z') });
  assert.equal(out[0].key, `github_gap:${last}`);
  assert.match(out[0].text, /silent for 9 h/);
});

test('dispatchAlerts: not configured sends nothing and says so; success is recorded and deduplicated; a new incident alerts again', async () => {
  const f = fakeJobs();
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push(JSON.parse(init.body).text); return { ok: true, status: 200 }; };
  try {
    assert.deepEqual(await dispatchAlerts([{ key: 'a', text: 'x' }], { url: '', fetchImpl }), { configured: false, sent: 0, failed: 0, skipped: 0 });
    assert.equal(calls.length, 0);
    const url = 'https://hooks.example/test';
    assert.equal((await dispatchAlerts([{ key: 'a', text: 'incident A' }], { url, fetchImpl, now: 1000 })).sent, 1);
    const again = await dispatchAlerts([{ key: 'a', text: 'incident A' }], { url, fetchImpl, now: 2000 });
    assert.deepEqual([again.sent, again.skipped], [0, 1], 'same incident is not re-sent');
    assert.equal((await dispatchAlerts([{ key: 'b', text: 'incident B' }], { url, fetchImpl, now: 3000 })).sent, 1);
    assert.deepEqual(calls, ['[Research Archiving] incident A', '[Research Archiving] incident B']);
    assert.ok(!JSON.stringify(f.docs.get('ops_alerts')).includes(url), 'the webhook address is never stored');
  } finally { f.restore(); }
});

test('dispatchAlerts: a failed delivery is recorded, retried after the delay up to the attempt limit, then left failed', async () => {
  const f = fakeJobs();
  let n = 0;
  const failing = async () => { n++; return { ok: false, status: 500 }; };
  const url = 'https://hooks.example/test';
  try {
    let now = 1000;
    const r1 = await dispatchAlerts([{ key: 'k', text: 't' }], { url, fetchImpl: failing, now });
    assert.deepEqual([r1.sent, r1.failed], [0, 1]);
    assert.equal(f.docs.get('ops_alerts').sent.k.ok, false);
    assert.equal((await dispatchAlerts([{ key: 'k', text: 't' }], { url, fetchImpl: failing, now: now + 1000 })).skipped, 1, 'too soon to retry');
    for (let i = 1; i < MAX_ATTEMPTS; i++) { now += RETRY_AFTER_MS + 1; await dispatchAlerts([{ key: 'k', text: 't' }], { url, fetchImpl: failing, now }); }
    assert.equal(n, MAX_ATTEMPTS);
    now += RETRY_AFTER_MS + 1;
    assert.equal((await dispatchAlerts([{ key: 'k', text: 't' }], { url, fetchImpl: failing, now })).skipped, 1, 'attempt limit reached');
    const thrown = await dispatchAlerts([{ key: 'z', text: 't' }], { url, fetchImpl: async () => { throw new Error('ECONNREFUSED'); }, now });
    assert.equal(thrown.failed, 1);
    assert.equal(f.docs.get('ops_alerts').sent.z.error, 'ECONNREFUSED');
  } finally { f.restore(); }
});

test('keyOf: numbers inside a warning do not make a new incident, a new day does', () => {
  assert.equal(keyOf('source 77 timed out 3 times', '2026-10-29'), keyOf('source 77 timed out 4 times', '2026-10-29'));
  assert.notEqual(keyOf('source 77 timed out 3 times', '2026-10-29'), keyOf('source 77 timed out 3 times', '2026-10-30'));
});

test('dispatchAlerts: e-mail channel sends high-importance mail; webhook failure falls through to e-mail; failing mail is recorded', async () => {
  const { emailConfig } = require('../server/lib/opsAlerts');
  assert.equal(emailConfig({}), null);
  const cfg = emailConfig({ ALERT_SMTP_USER: 'a@gmail.com', ALERT_SMTP_PASS: 'abcd efgh ijkl mnop' });
  assert.equal(cfg.pass, 'abcdefghijklmnop'); assert.equal(cfg.to, 'a@gmail.com');
  const mails = [];
  const key = `mail-${Date.now()}`;
  const r = await dispatchAlerts([{ key, text: 'incident', urgent: true }], { url: 'https://hook.example/x', email: cfg, sendMail: async (c, m) => { mails.push(m); }, fetchImpl: async () => ({ ok: false, status: 500 }), now: 5000 });
  assert.equal(r.sent, 1); assert.match(mails[0].subject, /^\[긴급\]/);
  const bad = await dispatchAlerts([{ key: key + 'x', text: 't' }], { email: cfg, sendMail: async () => { throw new Error('535 auth'); }, now: 6000 });
  assert.equal(bad.failed, 1);
});

test('alertTestHandler: 401 without secret; 200 when delivered; 502 when nothing delivered', async () => {
  const { alertTestHandler } = require('../server/lib/cronRunner');
  process.env.CRON_SECRET = 's';
  const run = async (send, auth) => { const o = { code: 200 }; const res = { status: (c) => { o.code = c; return res; }, json: (b) => { o.body = b; return res; } }; await alertTestHandler({ send })({ headers: { authorization: auth }, query: {} }, res); return o; };
  assert.equal((await run(async () => ({}), undefined)).code, 401);
  assert.equal((await run(async () => ({ configured: true, sent: 1 }), 'Bearer s')).code, 200);
  assert.equal((await run(async () => ({ configured: false, sent: 0 }), 'Bearer s')).code, 502);
});
