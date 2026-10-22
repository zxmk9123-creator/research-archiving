// API keys for one provider from the environment, whatever naming a platform's variable form allowed:
// PREFIX, PREFIX_2, PREFIX_3 ... / PREFIX1, PREFIX2 ... and PREFIXS (comma list, e.g. BRAVE_SEARCH_API_KEYS). Read on every call, de-duplicated, in that order.
function collectKeys(prefix, env = process.env) {
  const out = [];
  const add = (v) => { const k = String(v || '').trim(); if (k) out.push(k); };
  add(env[prefix]);
  const numbered = Object.keys(env)
    .map((name) => { const m = name.match(new RegExp(`^${prefix}_?(\\d+)$`)); return m ? [Number(m[1]), name] : null; })
    .filter(Boolean)
    .sort((a, b) => a[0] - b[0]);
  numbered.forEach(([, name]) => add(env[name]));
  String(env[`${prefix}S`] || '').split(',').forEach(add);
  return [...new Set(out)];
}
module.exports = { collectKeys };
