const fs = require('fs');
const path = require('path');
const pool = require('./pool');

async function main() {
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await pool.query(sql);
  console.log('schema applied');
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
