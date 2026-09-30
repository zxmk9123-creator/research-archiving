const pool = require('../db/pool');

// Minimum classification invariant shared by every path that can set an
// item to status='Published' — the manual Review PATCH route
// (routes/items.js) and the autonomous applyAiDraftIfEligible() path
// (aiDraft.js). Reuses the existing item_sectors/item_usages association
// tables (whose FK constraints already guarantee any row references a
// real sectors/usages taxonomy entry) rather than adding a parallel
// validation system.
async function hasValidClassification(itemId) {
  const { rows } = await pool.query(
    `SELECT EXISTS(SELECT 1 FROM item_sectors WHERE item_id = $1) AS has_sector,
            EXISTS(SELECT 1 FROM item_usages WHERE item_id = $1) AS has_usage`,
    [itemId]
  );
  return rows[0].has_sector && rows[0].has_usage;
}

module.exports = { hasValidClassification };
