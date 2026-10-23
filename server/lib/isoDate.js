// pg returns DATE columns as Date objects: String(date).slice(0, 10) gave "Fri Dec 26" (no year) in model prompts, and the
// model copied it into answers. Always an ISO yyyy-mm-dd, or '' when there is no usable date.
function isoDate(value) {
  if (!value) return '';
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? '' : value.toISOString().slice(0, 10);
  const s = String(value);
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const t = Date.parse(s);
  return Number.isNaN(t) ? '' : new Date(t).toISOString().slice(0, 10);
}

module.exports = { isoDate };
