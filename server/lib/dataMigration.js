// One-off, resumable copy of every public table from another Postgres (SOURCE_DATABASE_URL) into this app's database.
// Used to move the data when the app changes hosts. Safe to call repeatedly: a table is copied in primary-order chunks and the number
// of rows already in the target is the resume point; a table that already has as many rows as the source is skipped.
const { Pool } = require('pg');
const target = require('../db/pool');

const CHUNK = 400;
const q = (id) => `"${String(id).replace(/"/g, '""')}"`;

async function tableOrder(pool) {
  const tables = (await pool.query("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY 1")).rows.map((r) => r.table_name);
  const deps = new Map(tables.map((t) => [t, new Set()]));
  const fk = await pool.query(`SELECT c.conrelid::regclass::text AS child, c.confrelid::regclass::text AS parent FROM pg_constraint c
    JOIN pg_namespace n ON n.oid = c.connamespace WHERE c.contype = 'f' AND n.nspname = 'public'`);
  for (const { child, parent } of fk.rows) if (child !== parent && deps.has(child) && deps.has(parent)) deps.get(child).add(parent);
  const out = []; const left = new Set(tables);
  while (left.size) {
    const ready = [...left].filter((t) => [...deps.get(t)].every((p) => !left.has(p)));
    const batch = ready.length ? ready : [[...left][0]]; // a cycle: take one and let the database say if it objects
    for (const t of batch.sort()) { out.push(t); left.delete(t); }
  }
  return out;
}

async function columnsOf(pool, table) {
  return (await pool.query("SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position", [table])).rows.map((r) => r.column_name);
}

async function migrate({ sourceUrl, budgetMs = 240000, truncateFirst = false } = {}) {
  if (!sourceUrl) throw new Error('SOURCE_DATABASE_URL is not set');
  const started = Date.now();
  const source = new Pool({ connectionString: sourceUrl, ssl: process.env.PGSSL === 'false' ? false : { rejectUnauthorized: false }, max: 2 });
  const report = [];
  try {
    await source.query('SELECT 1'); // fail before touching the target if the source cannot be reached
    const order = await tableOrder(target);
    // the schema file seeds a few rows (e.g. sources); a first run on a fresh database clears them so ids match the source exactly
    if (truncateFirst) await target.query(`TRUNCATE ${order.map(q).join(', ')} RESTART IDENTITY CASCADE`);
    for (const table of order) {
      const srcCols = await columnsOf(source, table);
      if (!srcCols.length) { report.push({ table, status: 'not_in_source' }); continue; }
      const tgtCols = await columnsOf(target, table);
      const cols = srcCols.filter((c) => tgtCols.includes(c));
      const total = Number((await source.query(`SELECT COUNT(*) AS n FROM ${q(table)}`)).rows[0].n);
      let have = Number((await target.query(`SELECT COUNT(*) AS n FROM ${q(table)}`)).rows[0].n);
      if (have >= total) { report.push({ table, status: 'done', rows: have }); continue; }
      const colList = cols.map(q).join(', ');
      while (have < total) {
        if (Date.now() - started > budgetMs) { report.push({ table, status: 'partial', rows: have, of: total }); return { complete: false, report }; }
        const { rows } = await source.query(`SELECT ${colList} FROM ${q(table)} ORDER BY 1 LIMIT ${CHUNK} OFFSET ${have}`);
        if (!rows.length) break;
        await target.query(`INSERT INTO ${q(table)} (${colList}) OVERRIDING SYSTEM VALUE SELECT ${colList} FROM jsonb_populate_recordset(null::${q(table)}, $1::jsonb)`, [JSON.stringify(rows)]);
        have += rows.length;
      }
      report.push({ table, status: have >= total ? 'copied' : 'short', rows: have, of: total });
    }
    // serial / identity counters continue after the copied ids
    const seqs = (await target.query(`SELECT c.table_name, c.column_name, pg_get_serial_sequence(quote_ident(c.table_name), c.column_name) AS seq
      FROM information_schema.columns c WHERE c.table_schema = 'public' AND (c.column_default LIKE 'nextval(%' OR c.is_identity = 'YES')`)).rows;
    for (const s of seqs) if (s.seq) await target.query(`SELECT setval($1, GREATEST((SELECT COALESCE(MAX(${q(s.column_name)}), 0) FROM ${q(s.table_name)}), 1))`, [s.seq]);
    return { complete: true, report };
  } finally {
    await source.end().catch(() => {});
  }
}

module.exports = { migrate, tableOrder };
