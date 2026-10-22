// Auto-collection for Reference Sources (is_reference, method='manual'): fetch
// the source's listing page(s) (url + sector_links), pull same-site article /
// report links, and run them through the normal web-discovery pipeline
// (dedup, relevance filter, AI curation, publish gate). No search quota used.
const pool = require('../db/pool');
const { safeFetch } = require('./safeUrl');
const { readResponseText } = require('./boundedResponse');
const { decodeHTML } = require('entities');
const { collectWebDiscoverySource } = require('./webDiscoveryIngest');

const MAX_LINKS_PER_SOURCE = 12;
const PER_RUN = 6;
const NAV_PATH = /\/(tag|tags|category|categories|about|contact|login|search|privacy|terms|careers|subscribe|account|cart|page\/\d+)(\/|$)/i;

function extractArticleLinks(html, baseUrl) {
  const base = new URL(baseUrl);
  const out = [];
  const seen = new Set();
  for (const m of html.matchAll(/<a[^>]+href=["']([^"'#]+)["'][^>]*>([\s\S]{4,300}?)<\/a>/gi)) {
    const title = decodeHTML(m[2].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
    let u;
    try { u = new URL(m[1], baseUrl); } catch { continue; }
    if (!/^https?:$/.test(u.protocol) || u.hostname.replace(/^www\./, '') !== base.hostname.replace(/^www\./, '')) continue;
    const isPdf = /\.pdf$/i.test(u.pathname);
    const depth = u.pathname.split('/').filter(Boolean).length;
    if (!isPdf && (depth < 2 || NAV_PATH.test(u.pathname))) continue;
    if (title.length < 25 || title.split(' ').length < 4) continue;
    const link = u.toString();
    if (link === base.toString() || seen.has(link)) continue;
    seen.add(link);
    out.push({ title, link });
  }
  return out;
}

async function listingCandidates(source) {
  const pages = [source.url, ...(Array.isArray(source.sector_links) ? source.sector_links.map((s) => s && s.url) : [])]
    .filter(Boolean).slice(0, 4);
  const all = [];
  for (const page of pages) {
    try {
      const res = await safeFetch(page, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ResearchArchivingBot/1.0)' }, signal: AbortSignal.timeout(15000) });
      if (!res.ok) continue;
      all.push(...extractArticleLinks(await readResponseText(res, 2 * 1024 * 1024, 'reference listing HTML'), page));
    } catch { /* one page failing never blocks the rest */ }
  }
  return all.slice(0, MAX_LINKS_PER_SOURCE);
}

async function collectReferenceSource(source) {
  const candidates = await listingCandidates(source);
  if (!candidates.length) {
    await pool.query('UPDATE sources SET last_collected_at = now() WHERE id = $1', [source.id]);
    return { sourceId: source.id, ok: true, discovered: 0, archived: 0 };
  }
  const result = await collectWebDiscoverySource(source, { candidates, skipKnownRejects: true });
  await pool.query('UPDATE sources SET last_collected_at = now() WHERE id = $1', [source.id]);
  return result;
}

// Least-recently-collected first; ~weekly cycle at PER_RUN/day over 36 sources.
async function runReferenceCollections({ limit = PER_RUN } = {}) {
  const { rows } = await pool.query(
    `SELECT * FROM sources WHERE is_reference = true AND method = 'manual' AND url IS NOT NULL AND is_active = true
       AND (last_collected_at IS NULL OR last_collected_at < now() - interval '3 days')
     ORDER BY last_collected_at NULLS FIRST, id LIMIT $1`, [limit]);
  const results = [];
  for (const s of rows) {
    try { results.push(await collectReferenceSource(s)); }
    catch (err) { results.push({ sourceId: s.id, ok: false, error: err.message }); }
  }
  return results.map((r) => ({ sourceId: r.sourceId, ok: r.ok, discovered: r.discovered, archived: r.archived, error: r.error }));
}

module.exports = { extractArticleLinks, collectReferenceSource, runReferenceCollections };
