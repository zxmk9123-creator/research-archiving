const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === 'false' ? false : { rejectUnauthorized: false },
  max: Number(process.env.PG_POOL_MAX) || 10,
  connectionTimeoutMillis: 15000, // a saturated or restarting database fails a request instead of hanging it forever
  idleTimeoutMillis: 30000,
  statement_timeout: 90000, // a runaway query cannot hold a connection (and its request) indefinitely
});

// An error on an IDLE client (database restart, network drop) is emitted on the pool; without a listener it is an
// uncaught exception that ends the process.
pool.on('error', (err) => console.error('pg idle client error (pool keeps running):', err.message));

module.exports = pool;
