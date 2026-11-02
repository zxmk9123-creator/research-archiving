// Dependency-free checks of the Doctor summary's pure logic (no express, no database): the verdict semantics for every outcome the Doctor
// can store, and the panel's labeling. Loads summarizeDoctor / renderDoctorHtml by slicing the real source, so it tests the shipped code.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const statsSrc = fs.readFileSync(path.join(root, 'server/routes/stats.js'), 'utf8');
const appSrc = fs.readFileSync(path.join(root, 'public/app.js'), 'utf8');

function load() {
  const s = statsSrc.indexOf('const DOCTOR_STALE_MS');
  const e = statsSrc.indexOf("router.get('/doctor'");
  assert.ok(s > 0 && e > s, 'summarizeDoctor block found');
  const a = appSrc.indexOf('const DOCTOR_VERDICT_LABELS');
  const b = appSrc.indexOf('// Admin-only panel: accuracy on the golden set');
  assert.ok(a > 0 && b > a, 'renderDoctorHtml block found');
  const escapeHtml = (v) => String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const ctx = { escapeHtml };
  vm.createContext(ctx);
  vm.runInContext(`${statsSrc.slice(s, e)}\n${appSrc.slice(a, b)}\nthis.summarizeDoctor = summarizeDoctor; this.renderDoctorHtml = renderDoctorHtml;`, ctx);
  return ctx;
}
const { summarizeDoctor, renderDoctorHtml } = load();

const NOW = Date.parse('2026-10-30T12:00:00Z');
const hoursAgo = (h) => new Date(NOW - h * 3600000).toISOString();
const rep = (over = {}) => ({ at: hoursAgo(1), mode: 'diagnose', outcome: 'healthy', humanNeeded: false, before: [], after: null, findings: [], actions: [], ...over });
const verdictOf = (r) => summarizeDoctor({ reports: [r] }, NOW).verdict;

test('verdict semantics for every outcome the Doctor can store', () => {
  const table = [
    [rep({ outcome: 'healthy' }), 'ok'],
    [rep({ outcome: 'in_progress' }), 'ok'],
    [rep({ outcome: 'no_action', before: ['discovery_run:fail'] }), 'attention'],
    [rep({ outcome: 'limit_reached', before: ['headline:warn'] }), 'attention'],
    [rep({ outcome: 'limit_reached', before: ['headline:fail'], humanNeeded: true }), 'human_required'],
    [rep({ outcome: 'deferred_db_unhealthy', before: ['db:fail'] }), 'attention'],
    [rep({ outcome: 'state_unavailable', before: ['x:fail'], humanNeeded: true }), 'human_required'],
    [rep({ outcome: 'approval_rejected', before: ['x:fail'] }), 'attention'],
    [rep({ outcome: 'locked', before: ['x:fail'] }), 'attention'],
    [rep({ outcome: 'recovered', mode: 'recover', before: ['x:fail'], after: [] }), 'ok'],
    [rep({ outcome: 'improving', mode: 'recover', before: ['x:fail'], after: ['x:warn'] }), 'attention'],
    [rep({ outcome: 'unresolved', mode: 'recover', before: ['x:fail'], after: ['x:fail'], humanNeeded: true }), 'human_required'],
    [rep({ outcome: 'not_applied', mode: 'recover', before: ['x:fail'], after: ['x:fail'], humanNeeded: true }), 'human_required'],
  ];
  for (const [r, verdict] of table) assert.equal(verdictOf(r), verdict, `${r.outcome} ${JSON.stringify(r.before)} -> ${JSON.stringify(r.after)}`);
});

test('no reports, or garbage in the stored row, is "unknown" and never "ok"', () => {
  for (const doc of [undefined, null, {}, { reports: [] }, { reports: 'x' }, { reports: {} }]) {
    const s = summarizeDoctor(doc, NOW);
    assert.equal(s.verdict, 'unknown');
    assert.equal(s.available, false);
  }
});

test('the latest report is the last stored one; stale means older than 36 h; a missing time is not called stale', () => {
  const s = summarizeDoctor({ reports: [rep({ at: hoursAgo(80), humanNeeded: true }), rep({ at: hoursAgo(35) })] }, NOW);
  assert.equal(s.latest.at, hoursAgo(35));
  assert.equal(s.stale, false);
  assert.equal(summarizeDoctor({ reports: [rep({ at: hoursAgo(37) })] }, NOW).stale, true);
  assert.equal(summarizeDoctor({ reports: [rep({ at: undefined })] }, NOW).stale, null);
  assert.equal(summarizeDoctor({ reports: [rep({ at: 'not a date' })] }, NOW).stale, null);
});

test('only whitelisted report fields are passed on (nothing else stored beside the reports leaks)', () => {
  const s = summarizeDoctor({ reports: [{ ...rep(), secretField: 'leak', lock: { id: 'x' } }], lock: { id: 'lease' }, approval: { id: 'ap' } }, NOW);
  assert.ok(!/leak|lease|"ap"|secretField/.test(JSON.stringify(s)));
});

test('panel: human-required, diagnosis time in KST, recovery activity and the read-only notice are shown', () => {
  const s = summarizeDoctor({ reports: [rep({ at: '2026-10-30T00:30:00.000Z', mode: 'recover', outcome: 'unresolved', humanNeeded: true, before: ['a:fail'], after: ['a:fail'], findings: [{ key: 'a:cause', classification: 'needs_human', confidence: 'likely' }], actions: [{ action: 'kick_pipeline', error: null }] })] }, NOW);
  const html = renderDoctorHtml(s);
  assert.match(html, /사람 확인 필요/);
  assert.match(html, /2026-10-30 09:30 KST/);
  assert.match(html, /kick_pipeline/);
  assert.match(html, /a:cause/);
  assert.match(html, /실행하거나 승인을 만들지 않습니다/);
  assert.ok(!/<button|onclick|<form/i.test(html));
});

test('panel: null, empty and unavailable data are labelled as such', () => {
  assert.match(renderDoctorHtml(null), /불러오지 못했습니다/);
  assert.match(renderDoctorHtml(summarizeDoctor({}, NOW)), /기록된 Doctor 실행이 없습니다/);
});
