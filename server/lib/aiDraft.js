const pool = require('../db/pool');
const { callProvider } = require('./ai/provider');

// Strict JSON-only contract — no free prose parsing. The model is given the
// full allowed vocabulary and told to return existing ids only, never invent
// new sector/usage labels.
const SYSTEM_PROMPT = `You are a research-archiving assistant for an oils & fats market intelligence archive.
Given a title and (if available) a short description of a collected article, respond with STRICT JSON ONLY — no markdown fences, no commentary, nothing before or after the JSON object.

The JSON object must have exactly this shape:
{"summary": string, "key_takeaway": string, "suggested_sectors": number[], "suggested_usages": number[]}

Rules:
- summary: 2-3 concise Korean sentences summarizing the article for a research archive.
- key_takeaway: one concise Korean sentence stating the single most useful insight for a reviewer.
- suggested_sectors: 0-3 ids chosen ONLY from the allowed sector id list given below. Never invent an id or a name that is not listed.
- suggested_usages: 0-3 ids chosen ONLY from the allowed usage id list given below. Never invent an id or a name that is not listed.
- If you cannot confidently choose any tag, return an empty array for that field rather than guessing.
- You are working only from the title/description given — do not claim to have read a full article.
- Output ONLY the JSON object.`;

function buildTaxonomyBlock(sectors, usages) {
  const sectorLines = sectors.map((s) => `${s.id}: ${s.name}`).join('\n');
  const usageLines = usages.map((u) => `${u.id}: ${u.name}`).join('\n');
  return `Allowed sectors (id: name):\n${sectorLines}\n\nAllowed usages (id: name):\n${usageLines}`;
}

// Source material priority: this project has no full-article extraction, so
// the only material ever sent is title + whatever short description/summary
// was already collected (RSS description, or a manually entered summary).
// The prompt above explicitly tells the model not to claim it read more.
function buildUserPrompt(item, taxonomy) {
  const material = [
    `Title: ${item.title}`,
    item.summary ? `Description: ${item.summary}` : 'Description: (none available)',
  ].join('\n');
  return `${material}\n\n${buildTaxonomyBlock(taxonomy.sectors, taxonomy.usages)}`;
}

// Pure validation: parses the model's raw text, enforces the contract, and
// discards any sector/usage id not present in the taxonomy passed in. Never
// touches the DB — fully unit-testable without a provider or a database.
function parseDraftResponse(raw, taxonomy) {
  let parsed;
  try {
    const cleaned = String(raw)
      .trim()
      .replace(/^```(json)?/i, '')
      .replace(/```$/, '')
      .trim();
    parsed = JSON.parse(cleaned);
  } catch (err) {
    throw new Error('AI response was not valid JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('AI response was not a JSON object');
  }

  const summary = typeof parsed.summary === 'string' ? parsed.summary.trim() : '';
  const keyTakeaway = typeof parsed.key_takeaway === 'string' ? parsed.key_takeaway.trim() : '';
  if (!summary) throw new Error('AI response missing a usable summary');

  const sectorIds = new Set((taxonomy.sectors || []).map((s) => s.id));
  const usageIds = new Set((taxonomy.usages || []).map((u) => u.id));
  const suggestedSectors = Array.isArray(parsed.suggested_sectors)
    ? [...new Set(parsed.suggested_sectors.map(Number))].filter((id) => sectorIds.has(id))
    : [];
  const suggestedUsages = Array.isArray(parsed.suggested_usages)
    ? [...new Set(parsed.suggested_usages.map(Number))].filter((id) => usageIds.has(id))
    : [];

  return { summary, keyTakeaway, suggestedSectors, suggestedUsages };
}

async function getTaxonomy() {
  const [{ rows: sectors }, { rows: usages }] = await Promise.all([
    pool.query('SELECT id, name FROM sectors ORDER BY id'),
    pool.query('SELECT id, name FROM usages ORDER BY id'),
  ]);
  return { sectors, usages };
}

// Sanitized for storage/UI: short, human-safe, never a stack trace, API key,
// or raw provider payload.
function sanitizeError(err) {
  const msg = err && err.message ? String(err.message) : 'unknown error';
  return msg.slice(0, 200);
}

// Generates (or retries) the AI draft for one existing item. Writes only to
// ai_* columns — never to summary/insight/item_sectors/item_usages/status,
// so a reviewer's confirmed values or a published item are never touched.
// Safe to call repeatedly: it only ever updates the same row by id, so a
// retry can never create a duplicate item. Never throws — always resolves
// with { ok, error? } so a fire-and-forget caller can't crash on it.
async function generateAiDraftForItem(itemId, providerFn = callProvider) {
  const { rows } = await pool.query('SELECT * FROM items WHERE id = $1', [itemId]);
  const item = rows[0];
  if (!item) return { ok: false, error: 'item not found' };

  await pool.query(`UPDATE items SET ai_status = 'pending', ai_error = NULL WHERE id = $1`, [itemId]);

  try {
    const taxonomy = await getTaxonomy();
    const userPrompt = buildUserPrompt(item, taxonomy);
    const raw = await providerFn({ system: SYSTEM_PROMPT, user: userPrompt });
    const draft = parseDraftResponse(raw, taxonomy);

    await pool.query(
      `UPDATE items SET
         ai_status = 'completed',
         ai_summary = $1,
         ai_key_takeaway = $2,
         ai_suggested_sectors = $3,
         ai_suggested_usages = $4,
         ai_error = NULL,
         ai_generated_at = now()
       WHERE id = $5`,
      [draft.summary, draft.keyTakeaway, draft.suggestedSectors, draft.suggestedUsages, itemId]
    );
    return { ok: true };
  } catch (err) {
    const reason = sanitizeError(err);
    console.error(`AI draft generation failed for item ${itemId}: ${reason}`);
    await pool.query(`UPDATE items SET ai_status = 'failed', ai_error = $1 WHERE id = $2`, [reason, itemId]);
    return { ok: false, error: reason };
  }
}

module.exports = {
  SYSTEM_PROMPT,
  buildTaxonomyBlock,
  buildUserPrompt,
  parseDraftResponse,
  getTaxonomy,
  sanitizeError,
  generateAiDraftForItem,
};
