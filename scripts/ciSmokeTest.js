// CI merge gate: hits a REAL running server (booted against a real
// Postgres, not the mocked pool.query the unit tests use) and checks both
// the normal AND the error response of the list/detail/month-counts item
// APIs plus the search API — the exact surface two real production
// incidents broke:
//   1. a LIMIT/OFFSET string spliced into SQL instead of bound as a $N
//      placeholder, crashing the whole process on every /api/items request
//      (unit tests never caught it — a mocked pool.query never validates
//      $N count against params.length);
//   2. a stray `});` left over from a refactor that made server/routes/
//      search.js fail to `require()` at all (the process never even
//      booted) — unit tests that `require()` the module directly would
//      have caught this one, but this script also re-proves it end to
//      end against the actual listening server.
// node -c (run separately in CI, see the workflow) catches (2) earlier and
// cheaper; this script is the live-request layer unit tests structurally
// cannot reach: an actual bind-parameter mismatch only surfaces against a
// real Postgres, never against a mock.
const BASE = process.env.SMOKE_BASE_URL || 'http://127.0.0.1:3000';
const SEED_ITEM_ID = process.env.SMOKE_SEED_ITEM_ID;

let failed = false;

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

async function check(desc, fn) {
  try {
    await fn();
    console.log(`PASS: ${desc}`);
  } catch (err) {
    failed = true;
    console.error(`FAIL: ${desc}\n  ${err.message}`);
  }
}

async function main() {
  await check('server is up and serving the static app', async () => {
    const res = await fetch(`${BASE}/`);
    assert(res.status === 200, `expected 200, got ${res.status}`);
  });

  await check('GET /api/items — normal request returns a 200 JSON array', async () => {
    const res = await fetch(`${BASE}/api/items?status=Published&limit=5`);
    assert(res.status === 200, `expected 200, got ${res.status}`);
    const body = await res.json();
    assert(Array.isArray(body), 'expected a JSON array body');
  });

  await check('GET /api/items — a DB-level error (non-numeric source_id) returns 500 JSON, not a crash', async () => {
    const res = await fetch(`${BASE}/api/items?source_id=not-a-number`);
    assert(res.status === 500, `expected 500, got ${res.status}`);
    const body = await res.json();
    assert(body && typeof body.error === 'string', 'expected a JSON {error} body');
  });

  await check('GET /api/items/:id — the seeded item returns 200 with that item', async () => {
    assert(SEED_ITEM_ID, 'SMOKE_SEED_ITEM_ID env var not set');
    const res = await fetch(`${BASE}/api/items/${SEED_ITEM_ID}`);
    assert(res.status === 200, `expected 200, got ${res.status}`);
    const body = await res.json();
    assert(String(body.id) === String(SEED_ITEM_ID), 'expected the seeded item back');
  });

  await check('GET /api/items/:id — a nonexistent id returns 404 JSON', async () => {
    const res = await fetch(`${BASE}/api/items/999999999`);
    assert(res.status === 404, `expected 404, got ${res.status}`);
    const body = await res.json();
    assert(body && typeof body.error === 'string', 'expected a JSON {error} body');
  });

  await check('GET /api/items/:id — a DB-level error (non-numeric id) returns 500 JSON, not a crash', async () => {
    const res = await fetch(`${BASE}/api/items/not-a-number`);
    assert(res.status === 500, `expected 500, got ${res.status}`);
    const body = await res.json();
    assert(body && typeof body.error === 'string', 'expected a JSON {error} body');
  });

  await check('GET /api/items/month-counts — normal request returns a 200 JSON array', async () => {
    const res = await fetch(`${BASE}/api/items/month-counts?status=Published`);
    assert(res.status === 200, `expected 200, got ${res.status}`);
    const body = await res.json();
    assert(Array.isArray(body), 'expected a JSON array body');
  });

  await check('GET /api/items/month-counts — a DB-level error (non-numeric source_id) returns 500 JSON, not a crash', async () => {
    const res = await fetch(`${BASE}/api/items/month-counts?source_id=not-a-number`);
    assert(res.status === 500, `expected 500, got ${res.status}`);
    const body = await res.json();
    assert(body && typeof body.error === 'string', 'expected a JSON {error} body');
  });

  await check('POST /api/search — a missing question returns 400 JSON', async () => {
    const res = await fetch(`${BASE}/api/search`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}),
    });
    assert(res.status === 400, `expected 400, got ${res.status}`);
    const body = await res.json();
    assert(body && typeof body.error === 'string', 'expected a JSON {error} body');
  });

  await check('POST /api/search — a question with no matching material returns 200 (insufficient evidence), no provider call needed', async () => {
    const res = await fetch(`${BASE}/api/search`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ question: '존재하지 않는 키워드에 대한 질문' }),
    });
    assert(res.status === 200, `expected 200, got ${res.status}`);
    const body = await res.json();
    assert(body.insufficient === true, 'expected insufficient=true for a no-candidate question');
  });

  await check('server process is still alive after every request above (no unhandled-rejection crash)', async () => {
    const res = await fetch(`${BASE}/`);
    assert(res.status === 200, `expected 200, got ${res.status}`);
  });
}

main()
  .then(() => process.exit(failed ? 1 : 0))
  .catch((err) => { console.error('smoke test runner crashed:', err); process.exit(1); });
