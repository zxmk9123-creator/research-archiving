// CI-only helper: inserts exactly one Published item so ciSmokeTest.js has
// a real id to GET /api/items/:id against. Prints the new id (and nothing
// else) to stdout so the workflow can capture it into SMOKE_SEED_ITEM_ID.
const pool = require('../server/db/pool');

async function main() {
  const { rows } = await pool.query(
    `INSERT INTO items (title, source_url, type, status, published_at)
     VALUES ('CI smoke test item', 'https://example.com/ci-smoke-test', '뉴스', 'Published', CURRENT_DATE)
     RETURNING id`
  );
  process.stdout.write(String(rows[0].id));
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
