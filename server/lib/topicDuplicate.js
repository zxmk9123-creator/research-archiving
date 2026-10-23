// Same-event guard: an item about a topic already published in the last days
// is held unless it adds detail (new figures) the earlier items do not carry.
const TOPIC_DUPLICATE_VERSION = 'topic-duplicate-v1';
const WINDOW_DAYS = 7;
const OVERLAP_THRESHOLD = 0.5;
const MIN_NEW_NUMBERS = 2;

const textOf = (i) => `${i.title || ''} ${i.ai_summary || ''} ${i.ai_key_takeaway || ''}`;
const words = (t) => new Set((t.toLowerCase().match(/[a-z]{3,}|[가-힣]{2,}/g) || []));
const numbers = (t) => new Set((t.match(/\d[\d,.]*\s?(?:%|만|억|천|톤|배럴|리터|원|달러|\$)?/g) || []).map((n) => n.replace(/[\s,]/g, '')).filter((n) => /\d/.test(n)));

function sameTopic(a, b) {
  const A = words(a), B = words(b);
  if (A.size < 6 || B.size < 6) return false;
  let shared = 0;
  for (const w of A) if (B.has(w)) shared++;
  return shared / Math.min(A.size, B.size) >= OVERLAP_THRESHOLD;
}

// priors: recently published items. Returns the id of the item it duplicates, or null.
function redundantWith(candidate, priors) {
  const text = textOf(candidate);
  const related = priors.filter((p) => p.id !== candidate.id && sameTopic(text, textOf(p)));
  if (!related.length) return null;
  const known = new Set();
  for (const p of related) for (const n of numbers(textOf(p))) known.add(n);
  const fresh = [...numbers(text)].filter((n) => !known.has(n));
  return fresh.length >= MIN_NEW_NUMBERS ? null : related[0].id;
}

async function topicDuplicateOf(pool, item) {
  const { rows } = await pool.query(
    `SELECT id, title, ai_summary, ai_key_takeaway FROM items
     WHERE status = 'Published' AND id <> $1 AND coalesce(published_at, collected_at) > now() - ($2 || ' days')::interval
     ORDER BY id DESC LIMIT 150`, [item.id, String(WINDOW_DAYS)]);
  return redundantWith(item, rows);
}

module.exports = { topicDuplicateOf, redundantWith, TOPIC_DUPLICATE_VERSION };
