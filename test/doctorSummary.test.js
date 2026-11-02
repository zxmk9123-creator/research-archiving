const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const express = require('express');
const pool = require('../server/db/pool');
const statsRouter = require('../server/routes/stats');
const { SESSION_COOKIE, issueSessionToken } = require('../server/lib/auth');

// The read-only Doctor summary: GET /api/stats/doctor (admin) and the Ops page panel. It reads the stored reports only.

function withServer(fn) {
  const app = express();
  app.use(express.json());
  app.use('/api/stats', statsRouter);
  return new Promise((resolve, reject) => {
    const server = app.listen(0, async () => {
      try { await fn(`http://127.0.0.1:${server.address().port}/api/stats`); resolve(); } catch (e) { reject(e); } finally { server.close(); }
    });
  });
}
function mockPool(lastTotals) {
  const original = pool.query;
  const calls = [];
  pool.query = async (text, params) => {
    calls.push({ text, params });
    return { rows: lastTotals === undefined ? [] : [{ last_totals: lastTotals }] };
  };
  return { calls, restore: () => { pool.query = original; } };
}
const admin = { headers: { cookie: `${SESSION_COOKIE}=${issueSessionToken()}` } };
const HOUR = 3600000;
const at = (hoursAgo) => new Date(Date.now() - hoursAgo * HOUR).toISOString();
const report = (over = {}) => ({ at: at(1), mode: 'diagnose', outcome: 'no_action_needed', humanNeeded: false, before: [], after: null, findings: [], actions: [], ...over });

test('GET /doctor: an admin session is required, and nothing is queried without it', () => withServer(async (base) => {
  const m = mockPool({ reports: [report()] });
  try {
    assert.equal((await fetch(`${base}/doctor`)).status, 401);
    assert.equal(m.calls.length, 0);
  } finally { m.restore(); }
}));

test('GET /doctor: no stored report is "unknown", never "ok"', () => withServer(async (base) => {
  for (const stored of [undefined, {}, { reports: [] }]) {
    const m = mockPool(stored);
    try {
      const body = await (await fetch(`${base}/doctor`, admin)).json();
      assert.equal(body.available, false);
      assert.equal(body.verdict, 'unknown');
      assert.equal(body.latest, null);
    } finally { m.restore(); }
  }
}));

test('GET /doctor: the verdict comes from the latest report: ok, attention (still failing), human_required', () => withServer(async (base) => {
  const cases = [
    [report(), 'ok'],
    [report({ before: ['discovery_run'], after: ['discovery_run'], outcome: 'unresolved' }), 'attention'],
    [report({ before: ['discovery_run'], after: [], outcome: 'recovered' }), 'ok'],
    [report({ before: ['headline'], humanNeeded: true, outcome: 'not_applied' }), 'human_required'],
  ];
  for (const [r, verdict] of cases) {
    const m = mockPool({ reports: [report({ humanNeeded: true, before: ['old'] }), r] });
    try {
      const body = await (await fetch(`${base}/doctor`, admin)).json();
      assert.equal(body.verdict, verdict, JSON.stringify(r));
      assert.equal(body.latest.verdict, verdict);
      assert.equal(body.latest.at, r.at);
      assert.ok(body.generatedAt);
    } finally { m.restore(); }
  }
}));

test('GET /doctor: timestamp, stale flag, recovery activity and human-required warnings are reported from existing fields', () => withServer(async (base) => {
  const reports = [
    report({ at: at(50), humanNeeded: true, outcome: 'unresolved', findings: [{ key: 'headline:db_pool_contention', classification: 'needs_human', confidence: 'likely' }] }),
    report({ at: at(30), mode: 'recover', outcome: 'recovered', before: ['discovery_run'], after: [], findings: [{ key: 'discovery_run:run_not_started', classification: 'auto_recoverable', confidence: 'likely' }], actions: [{ action: 'kick_pipeline', result: { kicked: true } }] }),
    report({ at: at(2) }),
  ];
  const m = mockPool({ reports, lock: { id: 'secret-lease', until: 1 }, approval: { id: 'secret-approval' }, days: { x: 1 } });
  try {
    const body = await (await fetch(`${base}/doctor`, admin)).json();
    assert.equal(body.latest.at, reports[2].at, 'the LAST stored report is the latest');
    assert.equal(body.stale, false);
    assert.equal(body.recovery.reports, 3);
    assert.equal(body.recovery.withActions, 1);
    assert.deepEqual(body.recovery.recent[0].actions, [{ action: 'kick_pipeline', error: null }]);
    assert.equal(body.humanRequired.length, 1);
    assert.deepEqual(body.humanRequired[0].causes, ['headline:db_pool_contention']);
    const text = JSON.stringify(body);
    assert.ok(!/secret-lease|secret-approval|"days"|"lock"/.test(text), 'lease, approval and counters stored beside the reports are not exposed');
  } finally { m.restore(); }
  const old = mockPool({ reports: [report({ at: at(40) })] });
  try { assert.equal((await (await fetch(`${base}/doctor`, admin)).json()).stale, true, 'older than 36 h'); } finally { old.restore(); }
}));

test('GET /doctor: is strictly read-only (one SELECT of the stored row, no writes, no Doctor/health execution)', () => withServer(async (base) => {
  const m = mockPool({ reports: [report()] });
  try {
    await fetch(`${base}/doctor`, admin);
    assert.equal(m.calls.length, 1);
    assert.match(m.calls[0].text, /^\s*SELECT last_totals FROM scheduler_jobs WHERE job_name = 'ops_doctor'\s*$/);
    assert.ok(!/\b(INSERT|UPDATE|DELETE|ALTER|CREATE|DROP)\b/i.test(m.calls[0].text));
  } finally { m.restore(); }
  const src = fs.readFileSync(path.join(__dirname, '../server/routes/stats.js'), 'utf8');
  assert.ok(!/pipelineDoctor|runDoctor|runHealthCheck|armApproval|mutateJobState/.test(src), 'the route module does not import or call Doctor / health / approval code');
  const route = src.slice(src.indexOf("router.get('/doctor'"));
  assert.ok(!/router\.(post|put|patch|delete)\(['"]\/doctor/.test(src), 'no write method on /doctor');
  assert.ok(route.length > 0);
}));

test('GET /doctor: a database failure is a 500 with a plain message, not a crash or a fake "ok"', () => withServer(async (base) => {
  const original = pool.query;
  pool.query = async () => { throw new Error('db down'); };
  try {
    const res = await fetch(`${base}/doctor`, admin);
    assert.equal(res.status, 500);
    const body = await res.json();
    assert.ok(body.error);
    assert.equal(body.verdict, undefined);
  } finally { pool.query = original; }
}));

// --- the Ops page panel ---------------------------------------------------------------------------

function loadPanel() {
  const src = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
  const start = src.indexOf('const DOCTOR_VERDICT_LABELS');
  const end = src.indexOf('// Admin-only panel: accuracy on the golden set');
  assert.ok(start > 0 && end > start);
  const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const ctx = { escapeHtml };
  vm.createContext(ctx);
  vm.runInContext(`${src.slice(start, end)}; this.renderDoctorHtml = renderDoctorHtml;`, ctx);
  return { renderDoctorHtml: ctx.renderDoctorHtml, src };
}

test('panel: shows verdict, diagnosis time (KST), recovery activity and human-required warnings; escapes report text', () => {
  const { renderDoctorHtml } = loadPanel();
  const data = {
    available: true, verdict: 'human_required', stale: false,
    latest: { at: '2026-10-30T00:30:00.000Z', mode: 'recover', outcome: 'unresolved', humanNeeded: true, before: ['discovery_run'], after: ['discovery_run'], findings: [], actions: [] },
    humanRequired: [{ at: '2026-10-30T00:30:00.000Z', outcome: 'unresolved', causes: ['headline:<b>x</b>'] }],
    recovery: { reports: 4, withActions: 2, recent: [{ at: '2026-10-29T00:00:00.000Z', outcome: 'improving', actions: [{ action: 'kick_pipeline', error: 'boom <script>' }] }] },
  };
  const html = renderDoctorHtml(data);
  assert.match(html, /사람 확인 필요/);
  assert.match(html, /2026-10-30 09:30 KST/);
  assert.match(html, /2\/4/);
  assert.match(html, /kick_pipeline/);
  assert.match(html, /discovery_run/);
  assert.ok(!html.includes('<script>') && !html.includes('<b>x</b>'), 'report text is escaped');
  assert.match(html, /실행하거나 승인을 만들지 않습니다/);
});

test('panel: unavailable data, no report and a stale report are stated, not shown as healthy', () => {
  const { renderDoctorHtml } = loadPanel();
  assert.match(renderDoctorHtml(null), /불러오지 못했습니다/);
  assert.match(renderDoctorHtml({ available: false, verdict: 'unknown' }), /기록된 Doctor 실행이 없습니다/);
  const stale = renderDoctorHtml({ available: true, verdict: 'ok', stale: true, latest: { at: '2026-10-01T00:00:00.000Z', mode: 'diagnose', outcome: 'no_action_needed', before: [], after: null }, humanRequired: [], recovery: { reports: 1, withActions: 0, recent: [] } });
  assert.match(stale, /36시간 넘게 갱신 없음/);
  assert.match(stale, /정상/);
});

test('panel: only admin sessions fetch and render it, and it contains no action buttons or write calls', () => {
  const { renderDoctorHtml, src } = loadPanel();
  assert.match(src, /if \(isAdmin\) usageHtml = renderDoctorHtml\(await api\('\/stats\/doctor'\)/);
  const html = renderDoctorHtml({ available: true, verdict: 'ok', stale: false, latest: { at: '2026-10-30T00:00:00.000Z', mode: 'diagnose', outcome: 'no_action_needed', before: [], after: null }, humanRequired: [], recovery: { reports: 1, withActions: 0, recent: [] } });
  assert.ok(!/<button|onclick|<form|method=/i.test(html));
  const block = src.slice(src.indexOf('const DOCTOR_VERDICT_LABELS'), src.indexOf('// Admin-only panel: accuracy on the golden set'));
  assert.ok(!/method:\s*'(POST|PUT|PATCH|DELETE)'/i.test(block) && !/\bapi\(/.test(block));
});

test('panel: a stale verdict is labelled as old; a fresh one is not', () => {
  const { renderDoctorHtml } = loadPanel();
  const mk = (stale, verdict = 'ok') => renderDoctorHtml({ available: true, verdict, stale, latest: { at: '2026-10-30T00:00:00.000Z', mode: 'diagnose', outcome: 'healthy', before: [], after: null }, humanRequired: [], recovery: { reports: 1, withActions: 0, recent: [] } });
  assert.match(mk(true), /<strong>정상 \(오래된 기록\)<\/strong>/);
  assert.match(mk(true, 'human_required'), /<strong>사람 확인 필요 \(오래된 기록\)<\/strong>/);
  assert.match(mk(false), /<strong>정상<\/strong>/);
  assert.ok(!mk(false).includes('오래된 기록'));
  assert.ok(!mk(null).includes('오래된 기록'), 'an unknown age is not called old');
});

test('panel: a malformed or missing stored time renders "-" and never throws', () => {
  const { renderDoctorHtml } = loadPanel();
  for (const bad of ['garbage', '', null, undefined, '2026-13-45T00:00:00Z', 'Invalid Date']) {
    const html = renderDoctorHtml({ available: true, verdict: 'attention', stale: null, latest: { at: bad, mode: 'diagnose', outcome: 'x', before: ['a'], after: null },
      humanRequired: [{ at: bad, outcome: 'x', causes: [] }], recovery: { reports: 1, withActions: 1, recent: [{ at: bad, outcome: 'x', actions: [{ action: 'kick_pipeline', error: null }] }] } });
    assert.match(html, /<strong>-<\/strong>/, String(bad));
    assert.ok(!html.includes('NaN') && !html.includes('Invalid'));
  }
});
