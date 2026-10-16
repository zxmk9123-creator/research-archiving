// FRESHNESS POLICY. Company / quantity data is only useful while current: an article older
// than MAX_AGE_DAYS is blocked twice — at ingest (profile collection) and again at answer time
// (retrieval candidates and stored facts), so outdated material can never reach the chatbot.
// An explicitly historical question (a past year, 추이, 연도별, 과거 ...) is the only exception.
const MAX_AGE_DAYS = 548; // ~18 months

const HISTORICAL = /(추이|추세|연도별|역사|과거|지난\s*\d+\s*년|\d+\s*년간|history|historical|trend|over the years|time series)/i;

function wantsHistorical(question, now = new Date()) {
  const q = String(question || '');
  if (HISTORICAL.test(q)) return true;
  const years = (q.match(/(?<![0-9])(19|20)\d\d(?![0-9])/g) || []).map(Number);
  return years.some((y) => y <= now.getFullYear() - 2);
}

function isOutdated(publishedAt, now = new Date()) {
  if (!publishedAt) return false;
  const t = new Date(publishedAt).getTime();
  if (Number.isNaN(t)) return false;
  return (now.getTime() - t) / 86400000 > MAX_AGE_DAYS;
}

// An undated page whose own text only names years that are already old (newest year mentioned
// is two or more years back) is treated as outdated.
function textLooksOutdated(text, now = new Date()) {
  const years = (String(text || '').match(/(?<![0-9])(19|20)\d\d(?![0-9])/g) || []).map(Number).filter((y) => y <= now.getFullYear() + 1);
  return years.length > 0 && Math.max(...years) <= now.getFullYear() - 2;
}

module.exports = { MAX_AGE_DAYS, wantsHistorical, isOutdated, textLooksOutdated };
