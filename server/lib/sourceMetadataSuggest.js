// AI-assisted field suggestion for the Reference Source add form — the
// same "paste a link, let AI fill the blanks" idea aiDraft.js already
// uses for item drafts, applied to a Reference Source's own fields
// (source_type/region/commodities/access_format/update_frequency/
// coverage_note/usage_note) instead of an article's summary/insight.
// Strict JSON-only contract, same convention as aiDraft.js's
// SYSTEM_PROMPT, so a malformed/empty response fails loudly rather than
// silently filling the form with garbage.
const { callProviderWithFallback } = require('./ai/provider');

const SYSTEM_PROMPT = `You are a research-archiving assistant cataloguing an institutional data/research source for an oils & fats market intelligence archive.
Given a URL's extracted title and description/body excerpt, respond with STRICT JSON ONLY — no markdown fences, no commentary, nothing before or after the JSON object.

The JSON object must have exactly this shape:
{"name": string, "source_type": string, "region": string, "commodities": string[], "access_format": string[], "update_frequency": string, "coverage_note": string, "usage_note": string}

Rules:
- name: the institution/publisher's own name (e.g. "USDA FAS PSD Online", "MPOB"), not the page's article title.
- source_type: a short Korean category, e.g. "정부/국제기구 통계", "거래소/가격데이터", "뉴스", "리서치/보고서". Use "" if you cannot tell.
- region: the country/region this source covers, in Korean (e.g. "미국", "인도네시아", "글로벌"). Use "" if unclear.
- commodities: 0-5 Korean commodity names actually covered (e.g. "팜유", "대두유", "유채유", "해바라기유", "UCO", "SAF", "Tallow"). Empty array if none is evident.
- access_format: 0-3 values chosen ONLY from this exact set: "web","PDF","XLSX","CSV","API","RSS". Empty array if unclear. Never invent a value outside this set.
- update_frequency: a short cadence (e.g. "Monthly", "Weekly", "비정기"). Use "" if unclear.
- coverage_note: one concise Korean sentence describing what data/content this source actually provides.
- usage_note: one concise Korean sentence on how this source would be used in oil/fats market research, or "" if not evident.
- Every string field must be written in Korean, except an institution's own name/abbreviation or a standard English term with no Korean equivalent.
- Leave any field you cannot confidently infer as "" (or [] for the array fields) — never guess or invent a value just to fill a blank.
- Output ONLY the JSON object.`;

function buildUserPrompt(title, summary, bodyText) {
  const body = (bodyText || '').slice(0, 3000);
  return `Title: ${title || '(none)'}\nDescription: ${summary || '(none)'}\nBody excerpt:\n${body || '(none)'}`;
}

const STRING_FIELDS = ['name', 'source_type', 'region', 'update_frequency', 'coverage_note', 'usage_note'];
const ALLOWED_ACCESS_FORMATS = new Set(['web', 'PDF', 'XLSX', 'CSV', 'API', 'RSS']);

// Pure validation: parses the model's raw text and enforces the contract.
// Never touches the network/DB — unit-testable with a fake raw string.
function parseSuggestResponse(raw) {
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

  const result = {};
  for (const key of STRING_FIELDS) {
    result[key] = typeof parsed[key] === 'string' ? parsed[key].trim() : '';
  }
  result.commodities = Array.isArray(parsed.commodities)
    ? parsed.commodities.map((v) => String(v).trim()).filter(Boolean)
    : [];
  result.access_format = Array.isArray(parsed.access_format)
    ? parsed.access_format.map((v) => String(v).trim()).filter((v) => ALLOWED_ACCESS_FORMATS.has(v))
    : [];
  return result;
}

async function suggestSourceMetadata({ title, summary, bodyText }) {
  const { text } = await callProviderWithFallback({
    system: SYSTEM_PROMPT,
    user: buildUserPrompt(title, summary, bodyText),
  });
  return parseSuggestResponse(text);
}

module.exports = { suggestSourceMetadata, parseSuggestResponse, SYSTEM_PROMPT };
