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

// Archive / Daily Report split: decided deterministically from the
// existing `type` taxonomy at publish time, reused by both the autonomous
// applyAiDraftIfEligible() path (aiDraft.js) and the manual Review PATCH
// route (routes/items.js) so a Published item always gets the same
// category regardless of which path published it. '뉴스' (news) is the
// day-to-day bulletin content; every other type (보고서/통계/규제) is
// longer-shelf-life research that belongs in the Archive view.
const DAILY_REPORT_TYPES = new Set(['뉴스']);
function deriveContentCategory(type) {
  return DAILY_REPORT_TYPES.has(type) ? 'daily_report' : 'archive';
}

module.exports = { hasValidClassification, deriveContentCategory };
