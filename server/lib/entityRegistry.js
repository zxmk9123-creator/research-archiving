// ENTITY REGISTRY. One row per real-world company: `entity` = the original spelling kept as the representative,
// `same_names` = the other names it is called by (Latin / Hangul, "S.p.A." / "Ltd" variants, roster aliases, learned
// bilingual spellings), `role` = what it is in the supply chain. Everything that shows a company name (relations, diagrams)
// maps any spelling to `entity`, so one company is never two values.
const pool = require('../db/pool');
const provider = require('./ai/provider');
const { createLimiter } = require('./ai/concurrencyLimiter');
const { baseKey, isNonCompanyName } = require('./companyRelations');

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
  // "Golden Agri" / "Golden Agri Resources" / "Golden Agri-Resources": the same base name plus generic words only
  const latinNames = [...count.keys()].filter((k) => /[A-Za-z]/.test(k) && !/[가-힣]/.test(k));
  for (let i = 0; i < latinNames.length; i++) for (let j = i + 1; j < latinNames.length; j++) if (sameCompanyName(latinNames[i], latinNames[j], { crossScript: false, acronym: false })) union(latinNames[i], latinNames[j]);
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
// corporate-form words only: "Chevron" vs "Chevron Renewable Energy Group" or "Mitsui" vs "Mitsui Chemicals" are different companies
const GENERIC = new Set(['international', 'global', 'group', 'holdings', 'holding', 'corporation', 'company', 'limited', 'industries', 'resources']);
function sameCompanyName(a, b, { crossScript = true, acronym = true } = {}) {
  const x = baseKey(a);
  const y = baseKey(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const hx = /[가-힣]/.test(x); const hy = /[가-힣]/.test(y);
  const lx = /[a-z]/.test(x); const ly = /[a-z]/.test(y);
  if ((hx && !lx && ly && !hy) || (hy && !ly && lx && !hx)) return crossScript;   // Hangul spelling vs Latin spelling (roster aliases only: the pair is already known to be one company)
  if (hx && hy) { const [s, l] = x.length <= y.length ? [x, y] : [y, x]; return s.length >= 3 && l.startsWith(s); }
  const tx = x.split(' '); const ty = y.split(' ');
  const [small, big] = tx.length <= ty.length ? [tx, ty] : [ty, tx];
  if (small.every((t) => big.includes(t)) && big.filter((t) => !small.includes(t)).every((t) => GENERIC.has(t))) return true;
  const acr = (raw, other) => { const u = String(raw).replace(/[^A-Za-z]/g, ''); return u.length >= 2 && u.length <= 5 && u === u.toUpperCase() && other.split(' ').map((t) => t[0]).join('') === u.toLowerCase(); };
  return acronym && (acr(a, y) || acr(b, x));
}

async function loadInputs() {
  const names = [];
  const add = (rows, col) => { for (const r of rows) if (r[col]) names.push({ name: r[col], n: Number(r.n) || 1 }); };
  add((await pool.query('SELECT entity, COUNT(*) AS n FROM item_facts WHERE entity_type = $1 GROUP BY entity', ['기업'])).rows, 'entity');
  add((await pool.query('SELECT src, COUNT(*) AS n FROM company_relations GROUP BY src')).rows, 'src');
  add((await pool.query('SELECT dst, COUNT(*) AS n FROM company_relations GROUP BY dst')).rows, 'dst');
  const links = [];
  // spellings stored by an earlier build stay linked even when the raw data no longer contains them (relations are rewritten
  // to the canonical name): entity <-> each of its same_names
  try {
    const { rows: prev } = await pool.query('SELECT entity, same_names FROM entity_registry');
    for (const p of prev) for (const sn of p.same_names || []) { names.push({ name: sn, n: 0 }); if (sameCompanyName(p.entity, sn, { acronym: false })) links.push([p.entity, sn]); } // a wrong merge stored earlier is not kept alive
  } catch (_) { /* first build */ }
  const { rows: companies } = await pool.query('SELECT name, aliases FROM companies');
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
  const { rows: known } = await pool.query('SELECT term FROM term_aliases');
  const have = new Set(known.map((r) => r.term));
  const hangul = all.filter((n) => /[가-힣]/.test(n) && !/[A-Za-z]/.test(n) && !have.has(n)).slice(0, limit);
  let linked = 0;
  for (let i = 0; i < hangul.length; i += 40) {
    const batch = hangul.slice(i, i + 40);
    try {
      const result = await limitCall(() => provider.callProviderWithFallback({ system: TRANSLATE_SYSTEM, user: batch.map((b) => `- ${b}`).join('\n') }));
      const text = String(result.text || '');
      const arr = JSON.parse(text.slice(text.indexOf('['), text.lastIndexOf(']') + 1));
      for (const a of Array.isArray(arr) ? arr : []) {
        if (!a || !a.en || !batch.includes(a.ko)) continue;
        const match = latin.find((l) => sameCompanyName(l, a.en, { crossScript: false, acronym: false }));
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
  const groups = cluster(names.filter((n) => !isNonCompanyName(n.name)), { links, rosterNames });
  const { rows: old } = await pool.query('SELECT entity, same_names, role FROM entity_registry');
  const roleOf = new Map();
  for (const o of old) if (o.role) for (const n of [o.entity, ...(o.same_names || [])]) if (!roleOf.has(String(n).toLowerCase())) roleOf.set(String(n).toLowerCase(), o.role);
  // the rows are replaced as a whole: a spelling is either a representative or a same_name, never both (roles are carried over)
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM entity_registry');
    for (const g of groups) {
      const role = [g.entity, ...g.same_names].map((n) => roleOf.get(n.toLowerCase())).find(Boolean) || null;
      await client.query('INSERT INTO entity_registry (entity, same_names, role) VALUES ($1, $2, $3) ON CONFLICT (LOWER(entity)) DO NOTHING', [g.entity, g.same_names, role]);
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally { client.release(); }
  cache.at = 0;
  return { clusters: groups.length, written: groups.length, multi: groups.filter((g) => g.same_names.length).length };
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

// ---- second pass: roles from evidence + the facts' own role votes, then code rules ---------------------------------------
const ROLE_SYSTEM_V2 = `Classify each company by its role in the oils & fats / biofuel feedstock chain, using the hints given with it. Respond with ONLY a JSON array of {"entity": string, "role": "emitter"|"supplier"|"producer"|"consumer"|"trader"|"engineering"|"finance"|"other"}.
emitter = a restaurant / fast-food / food-service chain, fuel-station food retailer or food factory WHERE USED COOKING OIL OR WASTE FAT ARISES and is collected (a food brand that merely BUYS edible oil is a consumer, not an emitter). supplier = collects and aggregates feedstock (used cooking oil, fats, POME) and itself distributes / sells / exports it (collector-aggregator, renderer, feedstock supplier); a jet-fuel or fuel distributor is a trader, not a supplier. producer = refines or produces oils or fuels, incl. integrated energy majors and the operating arms of conglomerates (Idemitsu Kosan, plantations, mills, SAF/HVO plants). consumer = buys or uses the product (airline, shipper, food brand, tech buyer). trader = trading house, commodity trader, fuel distributor, general trading company (Mitsui & Co., Mitsubishi Corp., Gunvor, POSCO International). engineering = designs / builds / licenses plants and equipment. finance = ONLY banks, funds, asset managers, investors and lenders. other = associations, agencies, consultants, terminals, ports, airports, anything else.`;

const FINANCE_NAME = /(capital|bank|fund|asset management|investment|infrastructure partners|blackrock|black rock|\bGIP\b|\bING\b|BNP|파리바|캐피탈|펀드|은행|자산운용|투자|\bLP\b)/i;
const TRADER_NAME = /(trading|trade\b|상사|商事|mitsui|mitsubishi|itochu|marubeni|sumitomo|gunvor|trafigura|glencore|cargill|dreyfus|물산|posco international|포스코인터)/i;
const USED_OIL = /(used cooking oil|\bUCO\b|폐식용유|waste (cooking )?oil|waste fat|식당|restaurant|튀김|fryer)/i;
const FEEDSTOCK_EVIDENCE = /(collect|aggregat|\bUCO\b|used cooking|feedstock|rendering|수거|집하|폐식용유|원료|supply|공급)/i;
const FACT_TO_ROLE = { producer: 'producer', consumer: 'consumer', engineering: 'engineering', trader: 'trader', finance: 'finance', other: 'other' };

// ai: the model's role; ctx: { name, evidence: [text], factRoles: { role: count } } -> the role to store
function refineRole(ai, ctx) {
  const name = String(ctx.name || '');
  const ev = (ctx.evidence || []).join(' ');
  const votes = Object.entries(ctx.factRoles || {}).sort((a, b) => b[1] - a[1]);
  const factRole = votes.length && votes[0][1] >= 2 ? FACT_TO_ROLE[votes[0][0]] || null : null;
  let role = ROLES.includes(ai) ? ai : 'other';
  if (role === 'finance' && !FINANCE_NAME.test(name)) role = TRADER_NAME.test(name) ? 'trader' : (factRole && factRole !== 'finance' ? factRole : 'other');
  if (role === 'emitter' && !USED_OIL.test(ev)) role = 'consumer';                      // a food brand that buys oil is not a 배출처
  if (role === 'supplier' && !FEEDSTOCK_EVIDENCE.test(ev)) role = factRole && factRole !== 'supplier' ? factRole : 'trader';
  if (role === 'other' && factRole === 'producer' && !/(association|agency|institute|consult|coalition|chamber|ministry|협회|연합|정부)/i.test(name)) role = 'producer';
  return role;
}

async function reclassifyRoles({ limit = 600 } = {}) {
  const { rows } = await pool.query('SELECT entity, same_names FROM entity_registry ORDER BY id LIMIT $1', [Math.min(Number(limit) || 600, 1500)]);
  let changed = 0;
  for (let i = 0; i < rows.length; i += 25) {
    const batch = rows.slice(i, i + 25);
    const ctxs = new Map();
    for (const r of batch) {
      const names = [r.entity, ...(r.same_names || [])].map((n) => n.toLowerCase());
      const { rows: ev } = await pool.query('SELECT evidence FROM company_relations WHERE (LOWER(src) = ANY($1) OR LOWER(dst) = ANY($1)) AND evidence IS NOT NULL LIMIT 3', [names]);
      const { rows: fr } = await pool.query('SELECT role, COUNT(*)::int AS n FROM item_facts WHERE LOWER(entity) = ANY($1) AND role IS NOT NULL GROUP BY role', [names]);
      ctxs.set(r.entity, { name: r.entity, evidence: ev.map((e) => String(e.evidence).slice(0, 120)), factRoles: Object.fromEntries(fr.map((f) => [f.role, f.n])) });
    }
    const hints = batch.map((r) => { const c = ctxs.get(r.entity); return `- ${r.entity}${c.evidence.length ? ` — evidence: ${c.evidence.map((e) => `"${e}"`).join(' | ')}` : ''}${Object.keys(c.factRoles).length ? ` — other extraction tagged it: ${Object.entries(c.factRoles).map(([k, v]) => `${k}×${v}`).join(', ')}` : ''}`; });
    let ai = [];
    try {
      const result = await limitCall(() => provider.callProviderWithFallback({ system: ROLE_SYSTEM_V2, user: hints.join('\n') }));
      const text = String(result.text || '');
      ai = JSON.parse(text.slice(text.indexOf('['), text.lastIndexOf(']') + 1));
    } catch (err) { console.error(`entity role reclassification batch failed: ${err.message}`); continue; }
    const byEntity = new Map((Array.isArray(ai) ? ai : []).filter((a) => a && typeof a.entity === 'string').map((a) => [a.entity, a.role]));
    for (const r of batch) {
      if (!byEntity.has(r.entity)) continue;
      const role = refineRole(byEntity.get(r.entity), ctxs.get(r.entity));
      const u = await pool.query('UPDATE entity_registry SET role = $2, updated_at = now() WHERE LOWER(entity) = LOWER($1) AND role IS DISTINCT FROM $2', [r.entity, role]);
      changed += u.rowCount;
    }
  }
  cache.at = 0;
  return { checked: rows.length, changed };
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

// A merge the data owner rejects: the learned Hangul/English pair is dropped (an empty-alt marker keeps it from being learned again)
// and the spelling is removed from every roster alias list.
async function rejectAlias(term) {
  const t = String(term || '').trim();
  if (!t) return { removed: 0 };
  const a = await pool.query('DELETE FROM term_aliases WHERE term = $1 AND alt <> $2', [t, '']);
  await pool.query("INSERT INTO term_aliases (term, alt) VALUES ($1, '') ON CONFLICT DO NOTHING", [t]);
  const b = await pool.query('UPDATE companies SET aliases = array_remove(aliases, $1) WHERE $1 = ANY(aliases)', [t]);
  await pool.query('UPDATE entity_registry SET same_names = array_remove(same_names, $1) WHERE $1 = ANY(same_names)', [t]);
  cache.at = 0;
  return { removed: a.rowCount, rosterAliasesRemoved: b.rowCount };
}

module.exports = { refineRole, reclassifyRoles, rejectAlias, learnBilingual, sameCompanyName, cluster, rebuild, classifyRoles, getRegistry, lookup, ROLES };
