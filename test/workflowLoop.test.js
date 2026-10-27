// Runs the scheduled-jobs workflow's own shell script against stub curl/sleep binaries: success, partial progress, timeout, terminal failure.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const yml = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'scheduled-jobs.yml'), 'utf8');
const body = yml.slice(yml.indexOf('        run: |\n') + '        run: |\n'.length).split('\n').map((l) => l.replace(/^ {10}/, '')).join('\n');

// responses: list of [httpCode, bodyJson]; the stub serves them in order and repeats the last one
function run(responses) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-'));
  fs.writeFileSync(path.join(dir, 'responses.json'), JSON.stringify(responses));
  fs.writeFileSync(path.join(dir, 'count'), '0');
  fs.writeFileSync(path.join(dir, 'curl'), `#!/usr/bin/env bash
dir="${dir}"
n=$(cat "$dir/count"); echo $((n+1)) > "$dir/count"
node -e '
const r=require(process.argv[1]+"/responses.json");const n=Number(process.argv[2]);const x=r[Math.min(n,r.length-1)];
require("fs").writeFileSync(process.argv[1]+"/out.json",x[1]);process.stdout.write(String(x[0]));' "$dir" "$n"
while [ $# -gt 0 ]; do [ "$1" = "-o" ] && cp "$dir/out.json" "$2"; shift; done
`, { mode: 0o755 });
  fs.writeFileSync(path.join(dir, 'sleep'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
  const res = spawnSync('bash', ['-c', body], { cwd: dir, env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, CRON_SECRET: 's', APP_URL: 'http://x' }, encoding: 'utf8' });
  return { status: res.status, calls: Number(fs.readFileSync(path.join(dir, 'count'), 'utf8')), out: res.stdout };
}
const body200 = (discovery) => JSON.stringify({ ok: true, results: { daily_discovery: discovery } });

test('workflow loop: keeps calling while discovery has progress or a hop holds the lease, stops cleanly when done', () => {
  const r = run([[200, body200({ ran: true, done: false })], [200, body200({ ran: false, reason: 'in_progress' })], [200, body200({ ran: true, done: true })]]);
  assert.equal(r.status, 0);
  assert.equal(r.calls, 3);
});

test('workflow loop: a normal off-hours response (nothing to do) ends after one call', () => {
  const r = run([[200, body200({ ran: false, reason: 'already_ran_today' })]]);
  assert.equal(r.status, 0);
  assert.equal(r.calls, 1);
});

test('workflow loop: timeouts/5xx are retried, success resets the counter, five in a row fail the run', () => {
  const recovers = run([[0, ''], [504, ''], [200, body200({ ran: true, done: true })]]);
  assert.equal(recovers.status, 0);
  assert.equal(recovers.calls, 3);
  const dead = run([[500, '']]);
  assert.equal(dead.status, 1);
  assert.equal(dead.calls, 5);
});

test('workflow loop: terminal failures stop at once (bad secret, moved domain, a step that reported an error)', () => {
  assert.deepEqual([401, 404, 301].map((c) => run([[c, '']])).map((r) => [r.status, r.calls]), [[1, 1], [1, 1], [1, 1]]);
  const stepError = run([[200, JSON.stringify({ ok: true, results: { daily_discovery: 'error: boom' } })]]);
  assert.equal(stepError.status, 1);
  assert.equal(stepError.calls, 1);
});
