// ENTITY REGISTRY. One row per real-world company: `entity` = the original spelling kept as the representative,
// `same_names` = the other names it is called by (Latin / Hangul, "S.p.A." / "Ltd" variants, roster aliases, learned
// bilingual spellings), `role` = what it is in the supply chain. Everything that shows a company name (relations, diagrams)
// maps any spelling to `entity`, so one company is never two values.
const pool = require('../db/pool');
const provider = require('./ai/provider');
const { createLimiter } = require('./ai/concurrencyLimiter');
const { baseKey } = require('./companyRelations');

const ROLES = ['emitter', 'supplier', 'producer', 'consumer', 'trader', 'engineering', 'finance', 'other'];
const limitCall = createLimiter(1, 4000);

// ---- clustering (pure) --------------------------------------------------------------------------------------------------
// names: [{ name, n }] (n = how often the spelling occurs); links: [[nameA, nameB]] known same-company pairs;
// rosterNames: names that win the representative choice.
function cluster(names, { links = [], rosterNames = [] } = {}) {
  const parent = new Map();
  const find = (x) => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
  const union = (a, b) => { if (!parent.has(a)) parent.set(a, a); if (!parent.has(b)) parent.set(b, b); const ra = find(a); const rb = find(b); if (ra !== rb) parent.set(ra, rb); };
  const count = new Map();
  for (const { name, n } of names) { const k = String(name).trim(); if (k.length < 2) continue; count.set(k, (count.get(k) || 0) + (n || 1)); if (!parent.has(k)) parent.set(k, k); }
  const byKey = new Map();
  for (const k of count.keys()) {
    const bk = baseKey(k);
    if (bk.length < 3) continue;
    if (byKey.has(bk)) union(k, byKey.get(bk)); else byKey.set(bk, k);
  }
  const lower = new Map([...count.keys()].map((k) => [k.toLowerCase(), k]));
  for (const [a, b] of links) { const x = lower.get(String(a).toLowerCase().trim()); const y = lower.get(String(b).toLowerCase().trim()); if (x && y) union(x, y); }
  const roster = new Set(rosterNames.map((r) => String(r).toLowerCase().trim()));
  const groups = new Map();
  for (const k of count.keys()) { const r = find(k); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(k); }
  const out = [];
  for (const members of groups.values()) {
    const rep = members.slice().sort((a, b) => (roster.has(b.toLowerCase()) - roster.has(a.toLowerCase())) || (count.get(b) - count.get(a)) || (/[A-Za-z]/.test(b) - /[A-Za-z]/.test(a)) || a.length - b.length)[0];
    out.push({ entity: rep, same_names: members.filter((m) => m !== rep).sort() });
  }
  return out;
}

// Roster aliases are sometimes a subsidiary, a site or a partner ("Archaea Energy", "bp Castellón", "Darling Ingredients"
// listed under BP / Diamond Green Diesel). Only spellings of the SAME company are merged: equal base name, one script vs the
// other (Latin / Hangul), a Hangul prefix, a base name plus only generic words, or an acronym of the name.
const GENERIC = new Set(['international', 'global', 'energy', 'group', 'holdings', 'holding', 'oil', 'oils', 'corporation', 'resources', 'biofuels', 'bioenergy', 'renewables', 'renewable', 'petroleum', 'chemical', 'chemicals', 'industries', 'industry', 'company', 'limited']);
function sameCompanyName(a, b) {
  const x = baseKey(a);
  const y = baseKey(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const hx = /[가-힣]/.test(x); const hy = /[가-힣]/.test(y);
  const lx = /[a-z]/.test(x); const ly = /[a-z]/.test(y);
  if ((hx && !lx && ly && !hy) || (hy && !ly && lx && !hx)) return true;          // Hangul spelling vs Latin spelling
  if (hx && hy) { const [s, l] = x.length <= y.length ? [x, y] : [y, x]; return s.length >= 3 && l.startsWith(s); }
  const tx = x.split(' '); const ty = y.split(' ');
  const [small, big] = tx.length <= ty.length ? [tx, ty] : [ty, tx];
  if (small.every((t) => big.includes(t)) && big.filter((t) => !small.includes(t)).every((t) => GENERIC.has(t))) return true;
  const acr = (raw, other) => { const u = String(raw).replace(/[^A-Za-z]/g, ''); return u.length >= 2 && u.length <= 5 && u === u.toUpperCase() && other.split(' ').map((t) => t[0]).join('') === u.toLowerCase(); };
  return acr(a, y) || acr(b, x);
}

async function loadInputs() {
  const names = [];
  const add = (rows, col) => { for (const r of rows) if (r[col]) names.push({ name: r[col], n: Number(r.n) || 1 }); };
  add((await pool.query('SELECT entity, COUNT(*) AS n FROM item_facts WHERE entity_type = $1 GROUP BY entity', ['기업'])).rows, 'entity');
  add((await pool.query('SELECT src, COUNT(*) AS n FROM company_relations GROUP BY src')).rows, 'src');
  add((await pool.query('SELECT dst, COUNT(*) AS n FROM company_relations GROUP BY dst')).rows, 'dst');
  const { rows: companies } = await pool.query('SELECT name, aliases FROM companies');
  const links = [];
  const rosterNames = [];
  for (const c of companies) {
    rosterNames.push(c.name);
    names.push({ name: c.name, n: 50 });
    for (const a of c.aliases || []) { if (a) { names.push({ name: a, n: 1 }); if (sameCompanyName(c.name, a)) links.push([c.name, a]); } }
  }
  try {
    const { rows } = await pool.query('SELECT term, alt FROM term_aliases WHERE alt IS NOT NULL');
    for (const a of rows) links.push([a.term, a.alt]);
  } catch (_) { /* optional */ }
  return { names, links, rosterNames };
}

// Hangul-only names with no Latin counterpart: ask once for the official English name and keep it ONLY when it is the same
// company as a Latin name already in the data (so nothing is merged on a guess). Stored in term_aliases.
const TRANSLATE_SYSTEM = 'For each Korean company name give its official English name, or null when you are not sure. Respond with ONLY a JSON array of {"ko": string, "en": string|null}.';
async function learnBilingual({ limit = 120 } = {}) {
  const { names } = await loadInputs();
  const all = [...new Set(names.map((n) => String(n.name).trim()))];
  const latin = all.filter((n) => /[A-Za-z]/.test(n) && !/[가-힣]/.test(n));
  const hangul = all.filter((n) => /[가-힣]/.test(n) && !/[A-Za-z]/.test(n) && !latin.some((l) => sameCompanyName(l, n))).slice(0, limit);
  let linked = 0;
  for (let i = 0; i < hangul.length; i += 40) {
    const batch = hangul.slice(i, i + 40);
    try {
      const result = await limitCall(() => provider.callProviderWithFallback({ system: TRANSLATE_SYSTEM, user: batch.map((b) => `- ${b}`).join('\n') }));
      const text = String(result.text || '');
      const arr = JSON.parse(text.slice(text.indexOf('['), text.lastIndexOf(']') + 1));
      for (const a of Array.isArray(arr) ? arr : []) {
        if (!a || !a.en || !batch.includes(a.ko)) continue;
        const match = latin.find((l) => sameCompanyName(l, a.en));
        if (!match) continue;
        await pool.query('INSERT INTO term_aliases (term, alt) VALUES ($1, $2) ON CONFLICT DO NOTHING', [a.ko, match]);
        linked++;
      }
    } catch (err) { console.error(`bilingual name batch failed: ${err.message}`); }
  }
  return { hangulChecked: hangul.length, linked };
}

async function rebuild() {
  const { names, links, rosterNames } = await loadInputs();
  const groups = cluster(names, { links, rosterNames });
  let written = 0;
  for (const g of groups) {
    await pool.query(
      `INSERT INTO entity_registry (entity, same_names) VALUES ($1, $2)
       ON CONFLICT (LOWER(entity)) DO UPDATE SET same_names = EXCLUDED.same_names, updated_at = now()`,
      [g.entity, g.same_names]
    );
    written++;
  }
  // a spelling that became a same_name of another row no longer keeps its own row (unless a role was set by hand)
  await pool.query(
    `DELETE FROM entity_registry r WHERE r.role IS NULL AND EXISTS (SELECT 1 FROM entity_registry o WHERE o.id <> r.id AND LOWER(r.entity) = ANY (SELECT LOWER(x) FROM unnest(o.same_names) x))`
  );
  cache.at = 0;
  return { clusters: groups.length, written, multi: groups.filter((g) => g.same_names.length).length };
}

// ---- roles --------------------------------------------------------------------------------------------------------------
const ROLE_SYSTEM = `Classify each company by its role in the oils & fats / biofuel feedstock chain. Respond with ONLY a JSON array of {"entity": string, "role": "emitter"|"supplier"|"producer"|"consumer"|"trader"|"engineering"|"finance"|"other"}.
emitter = where the feedstock ARISES: a restaurant / fast-food / food-service chain, food factory, retailer or household-waste source whose used cooking oil or fat waste is collected (the 배출처). supplier = collects, aggregates and itself distributes / sells / exports the feedstock (UCO collector-aggregator, rendering company, feedstock trader-supplier). producer = refines or produces fuels / oils (refinery, SAF/HVO plant owner, plantation, mill). consumer = buys or uses the product (airline, shipper, fleet). trader = trades without aggregating. engineering = designs / builds plants for others. finance = investor, lender. other = anything else. Use the hints given with each company; when unsure choose other.`;

async function classifyRoles({ limit = 400 } = {}) {
  const { rows } = await pool.query('SELECT entity FROM entity_registry WHERE role IS NULL ORDER BY id LIMIT $1', [Math.min(Number(limit) || 400, 1500)]);
  let done = 0;
  for (let i = 0; i < rows.length; i += 30) {
    const batch = rows.slice(i, i + 30).map((r) => r.entity);
    const hints = [];
    for (const name of batch) {
      const { rows: ev } = await pool.query('SELECT evidence FROM company_relations WHERE (LOWER(src) = LOWER($1) OR LOWER(dst) = LOWER($1)) AND evidence IS NOT NULL LIMIT 1', [name]);
      hints.push(`${name}${ev[0] ? ` — "${String(ev[0].evidence).slice(0, 110)}"` : ''}`);
    }
    try {
      const result = await limitCall(() => provider.callProviderWithFallback({ system: ROLE_SYSTEM, user: hints.map((h) => `- ${h}`).join('\n') }));
      const text = String(result.text || '');
      const arr = JSON.parse(text.slice(text.indexOf('['), text.lastIndexOf(']') + 1));
      for (const a of Array.isArray(arr) ? arr : []) {
        if (!ROLES.includes(a && a.role) || !batch.includes(a.entity)) continue;
        const r = await pool.query('UPDATE entity_registry SET role = $2, updated_at = now() WHERE LOWER(entity) = LOWER($1) AND role IS NULL', [a.entity, a.role]);
        done += r.rowCount;
      }
    } catch (err) { console.error(`entity role classification batch failed: ${err.message}`); }
  }
  cache.at = 0;
  return { requested: rows.length, classified: done };
}

// ---- lookup (cached) -----------------------------------------------------------------------------------------------------
const cache = { at: 0, byName: new Map() };
const TTL = 10 * 60 * 1000;
async function getRegistry() {
  if (process.env.ENTITY_REGISTRY === 'off') return { canon: (n) => n, roleOf: () => null, byName: new Map() };
  if (!cache.at || Date.now() - cache.at > TTL) {
    try {
      const { rows } = await pool.query('SELECT entity, same_names, role FROM entity_registry');
      const byName = new Map();
      for (const r of rows) for (const n of [r.entity, ...(r.same_names || [])]) byName.set(String(n).toLowerCase().trim(), { entity: r.entity, role: r.role });
      cache.byName = byName;
      cache.at = Date.now();
    } catch (_) { /* registry optional */ }
  }
  const byName = cache.byName;
  return {
    byName,
    canon: (n) => (byName.get(String(n).toLowerCase().trim()) || {}).entity || n,
    roleOf: (n) => (byName.get(String(n).toLowerCase().trim()) || {}).role || null,
  };
}

async function lookup(q) {
  const { rows } = await pool.query(
    `SELECT entity, same_names, role FROM entity_registry WHERE ($1::text IS NULL OR LOWER(entity) LIKE '%' || LOWER($1) || '%' OR EXISTS (SELECT 1 FROM unnest(same_names) x WHERE LOWER(x) LIKE '%' || LOWER($1) || '%')) ORDER BY entity LIMIT 200`,
    [q || null]
  );
  return rows;
}

module.exports = { learnBilingual, sameCompanyName, cluster, rebuild, classifyRoles, getRegistry, lookup, ROLES };
