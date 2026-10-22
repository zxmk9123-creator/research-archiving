// API keys for one provider from the environment, whatever naming a platform's variable form allowed:
// PREFIX, PREFIX_2, PREFIX_3 ... / PREFIX1, PREFIX2 ... and PREFIXS (comma list, e.g. BRAVE_SEARCH_API_KEYS). Names are matched
// case-insensitively (a variable typed as Tavily_API_KEY still counts). Read on every call, de-duplicated, in that order.
function collectKeys(prefix, env = process.env) {
  const want = String(prefix).toUpperCase();
  const out = [];
  const add = (v) => { const k = String(v || '').trim(); if (k) out.push(k); };
  const names = Object.keys(env).map((name) => [name, name.toUpperCase()]);
  names.filter(([, up]) => up === want).forEach(([name]) => add(env[name]));
  names
    .map(([name, up]) => { const m = up.match(new RegExp(`^${want}_?(\\d+)$`)); return m ? [Number(m[1]), name] : null; })
    .filter(Boolean)
    .sort((a, b) => a[0] - b[0])
    .forEach(([, name]) => add(env[name]));
  names.filter(([, up]) => up === `${want}S`).forEach(([name]) => String(env[name] || '').split(',').forEach(add));
  return [...new Set(out)];
}
module.exports = { collectKeys };
