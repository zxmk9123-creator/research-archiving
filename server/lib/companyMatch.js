const pool = require('../db/pool');

// Auto-archiving: tag an item with any watchlist company whose name/alias
// appears in its title or summary.
async function matchCompanies(itemId, text) {
  const { rows: companies } = await pool.query(
    'SELECT id, name, aliases FROM companies WHERE watched = true'
  );
  const haystack = (text || '').toLowerCase();
  const matched = companies.filter((c) =>
    [c.name, ...(c.aliases || [])].some(
      (n) => n && haystack.includes(n.toLowerCase())
    )
  );
  if (matched.length === 0) return;
  const values = matched.map((c) => `(${itemId}, ${c.id})`).join(',');
  await pool.query(
    `INSERT INTO item_companies (item_id, company_id) VALUES ${values} ON CONFLICT DO NOTHING`
  );
}

module.exports = { matchCompanies };
