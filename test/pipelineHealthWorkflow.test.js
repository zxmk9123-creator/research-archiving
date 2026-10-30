// Tests of .github/workflows/pipeline-health.yml: the two shell steps are extracted from the workflow file and RUN (bash -e, like GitHub does)
// with a fake `curl` standing in for the server, so what is asserted is the behaviour of the real scripts, not of a copy.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const WORKFLOW = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'pipeline-health.yml'), 'utf8');
const SECRET = 'sekret-value-for-tests-123';

// The `run: |` body of the step named `name` (lines indented deeper than the `run:` key).
function stepScript(name) {
  const lines = WORKFLOW.split('\n');
  const at = lines.findIndex((l) => l.trim() === `- name: ${name}`);
  assert.ok(at >= 0, `step "${name}" exists`);
  const run = lines.findIndex((l, i) => i > at && /^\s+run: \|\s*$/.test(l));
  const indent = lines[run].match(/^(\s*)/)[1].length;
  const body = [];
  for (let i = run + 1; i < lines.length; i++) {
    if (lines[i].trim() !== '' && lines[i].match(/^(\s*)/)[1].length <= indent) break;
    body.push(lines[i].slice(indent + 2));
  }
  return body.join('\n');
}
const stepBlock = (name) => {
  const lines = WORKFLOW.split('\n');
  const at = lines.findIndex((l) => l.trim() === `- name: ${name}`);
  const end = lines.findIndex((l, i) => i > at && /^\s{6}- name:/.test(l));
  return lines.slice(at, end < 0 ? undefined : end).join('\n');
};
const HEALTH = 'Check pipeline health';
const DOCTOR = 'Diagnose (read-only, mode=diagnose)';

// One simulated workflow run: step 1, then step 2 exactly when its `if` would be true (always() && steps.health.outputs.diagnose == 'true').
function simulate({ health, doctor, secret = SECRET, curlFails = false }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-'));
  const bin = path.join(dir, 'bin'); fs.mkdirSync(bin);
  const log = path.join(dir, 'curl.log');
  const stub = `#!/usr/bin/env bash
out=""; url=""; fmt=""
while [ $# -gt 0 ]; do
  case "$1" in
    -o) out="$2"; shift 2 ;;
    -w) fmt="$2"; shift 2 ;;
    -H) echo "HEADER $2" >> "${log}"; shift 2 ;;
    -m|--max-time) shift 2 ;;
    -sS|-s|-S) shift ;;
    *) url="$1"; shift ;;
  esac
done
echo "URL $url" >> "${log}"
${curlFails ? 'exit 7' : ''}
case "$url" in
  *"/api/cron/health"*) code="${health ? health.code : 500}"; body='${health && health.body !== undefined ? health.body.replace(/'/g, "'\\''") : ''}' ;;
  *"/api/cron/doctor"*) code="${doctor ? doctor.code : 500}"; body='${doctor && doctor.body !== undefined ? doctor.body.replace(/'/g, "'\\''") : ''}' ;;
  *) code=404; body='' ;;
esac
[ -n "$out" ] && printf '%s' "$body" > "$out"
[ -n "$fmt" ] && printf '%s' "$code"
exit 0
`;
  fs.writeFileSync(path.join(bin, 'curl'), stub, { mode: 0o755 });
  const files = { out: path.join(dir, 'github_output'), summary: path.join(dir, 'summary.md') };
  fs.writeFileSync(files.out, ''); fs.writeFileSync(files.summary, '');
  const env = { PATH: `${bin}:${process.env.PATH}`, CRON_SECRET: secret, APP_URL: 'https://app.example.test', GITHUB_OUTPUT: files.out, GITHUB_STEP_SUMMARY: files.summary, HOME: dir };
  const runStep = (name) => {
    const f = path.join(dir, `${name.replace(/\W+/g, '_')}.sh`);
    fs.writeFileSync(f, stepScript(name));
    const r = spawnSync('bash', ['-e', f], { cwd: dir, env, encoding: 'utf8' });
    return { code: r.status, stdout: r.stdout, stderr: r.stderr };
  };
  const result = { health: runStep(HEALTH) };
  const outputs = Object.fromEntries(fs.readFileSync(files.out, 'utf8').split('\n').filter(Boolean).map((l) => l.split('=')));
  result.outputs = outputs;
  result.doctorRan = outputs.diagnose === 'true'; // the step's `if` has always(), so the health step's exit code does not matter
  if (result.doctorRan) result.doctor = runStep(DOCTOR);
  result.curlLog = fs.readFileSync(log, 'utf8').split('\n').filter(Boolean);
  result.summary = fs.readFileSync(files.summary, 'utf8');
  return result;
}
const healthBody = (status) => JSON.stringify({ status, summary: `Pipeline ${status}\n- [PASS] discovery_run: x`, checkedAt: '2026-10-30T01:10:00Z' });
const doctorBody = (over = {}) => JSON.stringify({ outcome: 'review_only', mode: 'diagnose', humanNeeded: false, actions: [], summary: 'Doctor (diagnose): review_only\n- headline → late_completion', ...over });
const calls = (r, part) => r.curlLog.filter((l) => l.startsWith('URL ') && l.includes(part)).length;

// ---------- the trigger decision, and the health semantics that must NOT change ----------

test('PASS: verdict ok -> exit 0, no doctor call', () => {
  const r = simulate({ health: { code: 200, body: healthBody('ok') } });
  assert.equal(r.health.code, 0);
  assert.equal(r.outputs.diagnose, 'false');
  assert.equal(r.doctorRan, false);
  assert.equal(calls(r, '/api/cron/doctor'), 0);
});

test('unknown: verdict unknown -> exit 0 (as before), no doctor call (only WARN and FAILED are diagnosed)', () => {
  const r = simulate({ health: { code: 200, body: healthBody('unknown') } });
  assert.equal(r.health.code, 0);
  assert.equal(r.outputs.diagnose, 'false');
  assert.equal(calls(r, '/api/cron/doctor'), 0);
});

test('WARN: verdict warn -> exit 0 (as before), exactly one authenticated diagnose call, step passes when no person is needed', () => {
  const r = simulate({ health: { code: 200, body: healthBody('warn') }, doctor: { code: 200, body: doctorBody() } });
  assert.equal(r.health.code, 0, 'the health step keeps its semantics: warn is not a failure');
  assert.equal(r.outputs.diagnose, 'true');
  assert.equal(calls(r, '/api/cron/doctor'), 1);
  assert.equal(r.doctor.code, 0);
  assert.match(r.summary, /### Pipeline doctor \(diagnose\): review_only/);
  assert.match(r.summary, /### Pipeline health: warn/, 'the health summary is still written');
});

test('FAIL: verdict failed -> the health step still exits 1 (as before), but the trigger is recorded BEFORE it and exactly one diagnose call follows', () => {
  const r = simulate({ health: { code: 200, body: healthBody('failed') }, doctor: { code: 200, body: doctorBody({ outcome: 'needs_human', humanNeeded: true }) } });
  assert.equal(r.health.code, 1);
  assert.equal(r.outputs.diagnose, 'true', 'set before the exit 1');
  assert.equal(calls(r, '/api/cron/doctor'), 1);
  assert.equal(r.doctor.code, 1, 'a person is needed -> the doctor step fails so the run is visibly red');
  assert.match(r.doctor.stdout, /::error::a person is needed \(needs_human\)/);
});

test('the health endpoint itself failing (HTTP 500, invalid body, no answer) keeps exit 1 and starts NO doctor', () => {
  for (const health of [{ code: 500, body: 'boom' }, { code: 200, body: 'not json' }, { code: 200, body: '{"nostatus":1}' }]) {
    const r = simulate({ health, doctor: { code: 200, body: doctorBody() } });
    assert.equal(r.health.code, 1);
    assert.equal(r.doctorRan, false);
    assert.equal(calls(r, '/api/cron/doctor'), 0);
  }
  const down = simulate({ health: { code: 200, body: healthBody('warn') }, curlFails: true });
  assert.equal(down.health.code, 1);
  assert.equal(down.doctorRan, false);
});

// ---------- the doctor response contract ----------

test('doctor response validation: HTTP errors, malformed JSON and contract violations all FAIL the step', () => {
  const warn = { code: 200, body: healthBody('warn') };
  const bad = [
    [{ code: 401, body: '{"error":"unauthorized"}' }, /HTTP 401/],
    [{ code: 500, body: '{"outcome":"error"}' }, /HTTP 500/],
    [{ code: 200, body: 'not json at all' }, /invalid body/],
    [{ code: 200, body: '{"mode":"diagnose","actions":[]}' }, /invalid body/],                                   // no outcome
    [{ code: 200, body: doctorBody({ mode: 'recover' }) }, /diagnose-only contract violated/],                    // wrong mode
    [{ code: 200, body: doctorBody({ mode: undefined }) }, /diagnose-only contract violated/],                    // mode missing
    [{ code: 200, body: doctorBody({ actions: [{ action: 'kick_pipeline' }] }) }, /diagnose-only contract violated/], // something was executed
    [{ code: 200, body: doctorBody({ actions: undefined }) }, /diagnose-only contract violated/],                 // actions missing
  ];
  for (const [doctor, pattern] of bad) {
    const r = simulate({ health: warn, doctor });
    assert.equal(r.health.code, 0, 'the health verdict itself is unaffected');
    assert.equal(r.doctor.code, 1, `should fail: ${doctor.body.slice(0, 60)}`);
    assert.match(r.doctor.stdout, pattern);
  }
});

test('humanNeeded=true fails the step; humanNeeded=false passes — including a clean "healthy"/"review_only" report', () => {
  const warn = { code: 200, body: healthBody('warn') };
  assert.equal(simulate({ health: warn, doctor: { code: 200, body: doctorBody({ humanNeeded: true, outcome: 'needs_human' }) } }).doctor.code, 1);
  assert.equal(simulate({ health: warn, doctor: { code: 200, body: doctorBody({ humanNeeded: false, outcome: 'healthy' }) } }).doctor.code, 0);
});

// ---------- authentication and "no recovery" ----------

test('authentication: the secret is sent as a Bearer header to BOTH endpoints, never printed, never in the summary; an empty secret fails before any request', () => {
  const r = simulate({ health: { code: 200, body: healthBody('warn') }, doctor: { code: 200, body: doctorBody() } });
  const headers = r.curlLog.filter((l) => l.startsWith('HEADER '));
  assert.equal(headers.length, 2);
  assert.ok(headers.every((h) => h === `HEADER Authorization: Bearer ${SECRET}`));
  for (const text of [r.health.stdout, r.health.stderr, r.doctor.stdout, r.doctor.stderr, r.summary]) assert.ok(!text.includes(SECRET), 'the secret never reaches logs or the summary');

  for (const name of [HEALTH, DOCTOR]) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-empty-'));
    fs.writeFileSync(path.join(dir, 's.sh'), stepScript(name));
    const res = spawnSync('bash', ['-e', path.join(dir, 's.sh')], { cwd: dir, env: { PATH: process.env.PATH, CRON_SECRET: '', APP_URL: 'https://x.test', GITHUB_OUTPUT: path.join(dir, 'o'), GITHUB_STEP_SUMMARY: path.join(dir, 'm') }, encoding: 'utf8' });
    assert.equal(res.status, 1);
    assert.match(res.stdout, /CRON_SECRET secret is not set/);
  }
});

test('no recovery: the doctor is only ever requested with the literal mode=diagnose; the workflow has no input, no recover mode, and no other endpoint', () => {
  const r = simulate({ health: { code: 200, body: healthBody('failed') }, doctor: { code: 200, body: doctorBody() } });
  const doctorUrls = r.curlLog.filter((l) => l.startsWith('URL ') && l.includes('/api/cron/doctor'));
  assert.deepEqual(doctorUrls, ['URL https://app.example.test/api/cron/doctor?mode=diagnose']);
  const nonComment = WORKFLOW.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');
  assert.ok(!/recover/i.test(nonComment), 'the word "recover" appears only in comments');
  assert.ok(!/\binputs\./.test(nonComment) && !/workflow_dispatch:\s*\n\s+inputs/.test(nonComment), 'the mode cannot be supplied from outside');
  assert.equal((nonComment.match(/api\/cron\/doctor\?mode=diagnose/g) || []).length, 1);
  assert.ok(!/DOCTOR_RECOVERY/.test(nonComment), 'the workflow never touches the recovery flag');
  assert.deepEqual([...new Set(nonComment.match(/secrets\.[A-Z_]+/g))], ['secrets.CRON_SECRET'], 'only the existing secret is used');
});

// ---------- structure: duplicate/concurrent invocations ----------

test('duplicate triggers: one doctor call per run (same job as the health step), runs serialize under the existing concurrency group, the step runs even after a failed health step', () => {
  const block = stepBlock(DOCTOR);
  assert.match(block, /if: always\(\) && steps\.health\.outputs\.diagnose == 'true'/);
  assert.match(WORKFLOW, /concurrency:\s*\n\s+group: pipeline-health\s*\n\s+cancel-in-progress: false/);
  assert.equal((WORKFLOW.match(/^ {2}[a-z_]+:\s*$/gm) || []).filter((l) => /^ {2}(check|doctor):/.test(l)).length, 1, 'a single job holds both steps');
  assert.match(stepBlock(HEALTH), /id: health/);
  // two runs back to back, as with a double dispatch: each makes exactly one doctor call, none overlaps (serial execution in this harness)
  const a = simulate({ health: { code: 200, body: healthBody('warn') }, doctor: { code: 200, body: doctorBody() } });
  const b = simulate({ health: { code: 200, body: healthBody('warn') }, doctor: { code: 200, body: doctorBody() } });
  assert.deepEqual([calls(a, '/api/cron/doctor'), calls(b, '/api/cron/doctor')], [1, 1]);
  // the doctor never calls anything that could start another run
  assert.ok(!/workflow_dispatch|gh |api\.github\.com|repository_dispatch/.test(stepScript(DOCTOR)));
});

test('the existing health semantics are untouched: same endpoint, same verdict-to-exit mapping, summary still written', () => {
  const script = stepScript(HEALTH);
  assert.match(script, /\/api\/cron\/health/);
  assert.match(script, /ok\) exit 0/);
  assert.match(script, /warn\) .*exit 0/);
  assert.match(script, /unknown\) .*exit 0/);
  assert.match(script, /\*\) echo "::error::pipeline health FAILED"; exit 1/);
  const table = [['ok', 0], ['warn', 0], ['unknown', 0], ['failed', 1]];
  for (const [status, exit] of table) assert.equal(simulate({ health: { code: 200, body: healthBody(status) }, doctor: { code: 200, body: doctorBody() } }).health.code, exit, status);
});
