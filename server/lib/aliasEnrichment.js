// Company ALIASES: the roster matches a company by its name and aliases only, so a Korean (or English) spelling that
// is missing from `aliases` splits one company into several rows ("인피니엄" / "Infinium"). Two repairs:
//   1) enrichAliases — the model proposes common Korean / English spellings per company; a proposal is stored ONLY if
//      it is a plausible name AND literally occurs in the archive's own published texts (so nothing is invented);
//   2) mergeDuplicateRoster — an auto-discovered roster row that names the same company as a tagged one
//      (e.g. "Kuala Lumpur Kepong Bhd" next to "KLK") becomes an alias of it and is switched off (never deleted).
const pool = require('../db/pool');
const provider = require('./ai/provider');

const SYSTEM = 'For each company give the other names it is commonly written with in Korean and English news (Korean transliterations, short forms, former names, brand names). Respond with ONLY a JSON array of {"name": string, "aliases": [string]}. Use the exact input name in "name". Only well-known real spellings; an empty list when unsure.';

const escapeLike = (s) => String(s).replace(/[\\%_]/g, (c) => `\\${c}`);
const plausible = (a) => {
  const t = String(a || '').trim();
  if (/[가-힣]/.test(t)) return t.length >= 2 && t.length <= 30;
  return t.length >= 3 && t.length <= 40 && /[A-Za-z]/.test(t);
};
const parseReply = (text) => {
  const raw = String(text || '').replace(/^```(?:json)?/i, '').replace(/```\s*$/, '');
  const a = raw.indexOf('[');
  const b = raw.lastIndexOf(']');
  if (a < 0 || b <= a) return [];
  try { const arr = JSON.parse(raw.slice(a, b + 1)); return Array.isArray(arr) ? arr : []; } catch (_) { return []; }
};

async function occursInArchive(alias) {
  const { rows } = await pool.query(
    `SELECT 1 FROM items WHERE status = 'Published' AND (title ILIKE $1 OR summary ILIKE $1 OR ai_summary ILIKE $1) LIMIT 1`,
    [`%${escapeLike(alias)}%`]
  );
  return rows.length > 0;
}

async function enrichAliases({ batch = 10 } = {}) {
  const { rows: companies } = await pool.query('SELECT id, name, aliases FROM companies WHERE watched = true ORDER BY id');
  const added = [];
  for (let i = 0; i < companies.length; i += batch) {
    const slice = companies.slice(i, i + batch);
    let proposals = [];
    try {
      const result = await provider.callProviderWithFallback({ system: SYSTEM, user: JSON.stringify(slice.map((c) => c.name)) });
      proposals = parseReply(result.text);
    } catch (err) { console.error(`alias enrichment batch failed: ${err.message}`); continue; }
    for (const p of proposals) {
      const company = slice.find((c) => c.name === (p && p.name));
      if (!company || !Array.isArray(p.aliases)) continue;
      const known = new Set([company.name, ...(company.aliases || [])].map((n) => String(n).toLowerCase()));
      const fresh = [];
      for (const alias of p.aliases) {
        const a = String(alias || '').trim();
        if (!plausible(a) || known.has(a.toLowerCase())) continue;
        if (await occursInArchive(a)) { fresh.push(a); known.add(a.toLowerCase()); }
      }
      if (fresh.length) {
        await pool.query('UPDATE companies SET aliases = (SELECT ARRAY(SELECT DISTINCT unnest(aliases || $2::text[]))) WHERE id = $1', [company.id, fresh]);
        added.push({ company: company.name, aliases: fresh });
      }
    }
  }
  return { companies: companies.length, added };
}

const namesOf = (c) => Array.from(new Set([c.name, String(c.name).split(/[\s.]+/)[0], ...(c.aliases || [])].map((n) => String(n || '').trim().toLowerCase()).filter((n) => n.length >= 3)));
const sameCompany = (a, b) => namesOf(a).some((x) => namesOf(b).some((y) => x === y || x.includes(y) || y.includes(x)));

async function mergeDuplicateRoster() {
  const { rows } = await pool.query('SELECT id, name, aliases, segment FROM companies WHERE watched = true ORDER BY id');
  const tagged = rows.filter((c) => c.segment);
  const merged = [];
  for (const dup of rows.filter((c) => !c.segment)) {
    const main = tagged.find((t) => sameCompany(t, dup));
    if (!main) continue;
    await pool.query('UPDATE companies SET aliases = (SELECT ARRAY(SELECT DISTINCT unnest(aliases || $2::text[]))) WHERE id = $1', [main.id, [dup.name, ...(dup.aliases || [])]]);
    await pool.query('UPDATE companies SET watched = false WHERE id = $1', [dup.id]);
    merged.push({ into: main.name, from: dup.name });
  }
  return { merged };
}

module.exports = { enrichAliases, mergeDuplicateRoster, plausible, parseReply, sameCompany };
