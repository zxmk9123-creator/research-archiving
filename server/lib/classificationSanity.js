// Sector misclassification check: a second-line precision gate run just
// before auto-publish, alongside hasValidClassification (which only
// checks that *some* sector/usage tag exists) and the trust gate (which
// checks data integrity, not classification accuracy). This checks that
// AT LEAST ONE of the AI-suggested sectors is actually grounded in the
// item's own title/summary text — catching the concrete failure mode
// where the AI tags a sector that the article never actually discusses
// (e.g. a soybean-oil-only article mistakenly tagged 팜유 alone).
//
// Deliberately permissive, not a full classifier: catch-all buckets
// (식용유지/비식용유지/기타 */물류/운임료/국제 정세) have no specific
// commodity to ground against, so they always pass. And any ONE grounded
// sector among several suggested is enough — an AI that tags both the
// right sector and an adjacent/related one isn't penalized for the extra
// tag, only for getting ALL of them wrong.
const pool = require('../db/pool');

// Keyword patterns mirror relevanceFilter.js's own product terms — same
// sector, same wording, not a second taxonomy to keep in sync by hand.
const SECTOR_KEYWORD_PATTERNS = {
  '팜유': /\bpalm oil\b|팜유/i,
  '대두유': /\bsoy(?:bean)? oil\b|대두유/i,
  '유채씨유': /\brapeseed oil\b|\bcanola oil\b|유채씨유/i,
  '해바라기유': /\bsunflower oil\b|해바라기유/i,
  'UCO': /\bUCO\b|\bused cooking oil\b/i,
  'UCOME': /\bUCOME\b/,
  'SAF': /\bSAF\b|\bsustainable aviation fuel\b/i,
  'Tallow': /\btallow\b/i,
  'FAME': /\bFAME\b|\bfatty acid methyl esters?\b/i,
};

// These buckets are intentionally generic ("other", "logistics",
// "freight rates", "geopolitics") — there is no specific commodity term
// to ground them against, so they can never be "misclassified" by this
// check.
const UNGROUNDABLE_SECTOR_NAMES = new Set([
  '식용유지', '비식용유지', '기타 식용유지', '기타 비식용유지', '기타', '물류', '운임료', '국제 정세',
]);

async function hasGroundedClassification(item) {
  const suggestedIds = item.ai_suggested_sectors || [];
  if (!suggestedIds.length) return true; // hasValidClassification already covers the empty case

  const { rows } = await pool.query('SELECT id, name FROM sectors WHERE id = ANY($1)', [suggestedIds]);
  const text = `${item.title || ''} ${item.ai_summary || item.summary || ''}`;

  return rows.some(({ name }) => {
    if (UNGROUNDABLE_SECTOR_NAMES.has(name)) return true;
    const pattern = SECTOR_KEYWORD_PATTERNS[name];
    return pattern ? pattern.test(text) : true; // an unmapped sector name is never penalized
  });
}

module.exports = { hasGroundedClassification, SECTOR_KEYWORD_PATTERNS, UNGROUNDABLE_SECTOR_NAMES };
