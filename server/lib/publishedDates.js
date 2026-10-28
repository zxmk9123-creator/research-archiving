// UNDATED items: pages collected without a publication date (profile collection, institutional pages) cannot be judged
// by the freshness rules and drop to "시점 불명". Many carry the date in their own URL (/2025/03/12/..., 20250312,
// /2025/03/): that is the page's own evidence, used only for items that have no date at all.
const pool = require('../db/pool');

const MIN_YEAR = 2015;
function valid(y, m, d, now = new Date()) {
  if (y < MIN_YEAR || y > now.getFullYear()) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d || dt.getTime() > now.getTime()) return null;
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

// S&P Global Commodity Insights slugs start with the publication date as MMDDYY (".../agriculture/093026-black-sea-sunflower-...").
// Verified shape only: host spglobal.com, a path segment that BEGINS with six digits and a hyphen, month 01-12, day 01-31, year 2015..now.
function dateFromSpglobalUrl(url, now = new Date()) {
  let u;
  try { u = new URL(String(url || '')); } catch (_) { return null; }
  if (!/(^|\.)spglobal\.com$/i.test(u.hostname)) return null;
  const seg = u.pathname.split('/').find((x) => /^\d{6}-/.test(x));
  if (!seg) return null;
  return valid(2000 + Number(seg.slice(4, 6)), Number(seg.slice(0, 2)), Number(seg.slice(2, 4)), now);
}

// -> { date: 'YYYY-MM-DD', precision: 'day' | 'month', method } or null. A month-only URL date (/2026/10/) takes the 1st and is reported as
// precision 'month' so callers can treat it as low confidence instead of as a real publication day.
function dateFromUrlDetailed(url, now = new Date()) {
  const u = String(url || '');
  const sp = dateFromSpglobalUrl(u, now);
  if (sp) return { date: sp, precision: 'day', method: 'spglobal_url_mmddyy' };
  let m = u.match(/(?<![0-9])(20[12]\d)[\/_.-](0[1-9]|1[0-2])[\/_.-](0[1-9]|[12]\d|3[01])(?![0-9])/);
  if (m) { const d = valid(+m[1], +m[2], +m[3], now); return d ? { date: d, precision: 'day', method: 'url_date' } : null; }
  m = u.match(/(?<![0-9])(20[12]\d)(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])(?![0-9])/);
  if (m) { const d = valid(+m[1], +m[2], +m[3], now); return d ? { date: d, precision: 'day', method: 'url_date' } : null; }
  m = u.match(/\/(20[12]\d)\/(0[1-9]|1[0-2])(?:\/|$|\?)/);
  if (m) { const d = valid(+m[1], +m[2], 1, now); return d ? { date: d, precision: 'month', method: 'url_month_only' } : null; }
  return null;
}

// -> 'YYYY-MM-DD' (month-only dates take the 1st) or null
function dateFromUrl(url, now = new Date()) {
  const r = dateFromUrlDetailed(url, now);
  return r ? r.date : null;
}

async function backfillPublishedDates() {
  const { rows } = await pool.query("SELECT id, source_url FROM items WHERE published_at IS NULL AND source_url IS NOT NULL");
  let updated = 0;
  for (const r of rows) {
    const d = dateFromUrl(r.source_url);
    if (!d) continue;
    await pool.query('UPDATE items SET published_at = $2 WHERE id = $1 AND published_at IS NULL', [r.id, d]);
    updated++;
  }
  return { undated: rows.length, updated };
}

// Publication date from the page's own metadata (what the article itself declares): article:published_time, JSON-LD datePublished,
// itemprop / name="date" meta tags, <time datetime>. Returns 'YYYY-MM-DD' or null. Never guesses from the fetch time.
function dateFromHtml(html, now = new Date()) {
  return dateFromCheerio(require('cheerio').load(String(html || '').slice(0, 600000)), now);
}

// Any date string a page may hold -> 'YYYY-MM-DD' or null: ISO first, then "Oct 18th, 2025" / "18 October 2025" style text.
function normalizeDateString(raw, now = new Date()) {
  const s = String(raw || '').trim();
  if (!s) return null;
  const iso = s.match(/(20[12]\d)-(\d{2})-(\d{2})/);
  if (iso) return valid(+iso[1], +iso[2], +iso[3], now);
  const t = Date.parse(s.replace(/(\d)(st|nd|rd|th)\b/gi, '$1'));
  if (Number.isNaN(t)) return null;
  const d = new Date(t);
  return valid(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), now);
}

// Publication-date candidates in priority order, each with where it came from. Only publication fields are read: dateModified,
// og:updated_time, article:modified_time and visible page-header dates are never candidates.
function dateFromCheerioDetailed($, now = new Date()) {
  const cands = [];
  const meta = ['article:published_time', 'og:article:published_time', 'og:published_time', 'datePublished', 'pubdate', 'publishdate', 'date', 'dc.date', 'dc.date.issued', 'parsely-pub-date', 'sailthru.date'];
  $('meta').each((_, el) => {
    const key = String($(el).attr('property') || $(el).attr('name') || $(el).attr('itemprop') || '').toLowerCase();
    if (meta.includes(key)) cands.push([$(el).attr('content'), `meta:${key}`]);
  });
  $('script[type="application/ld+json"]').each((_, el) => {
    const txt = $(el).contents().text();
    for (const m of txt.matchAll(/"datePublished"\s*:\s*"([^"]+)"/g)) cands.push([m[1], 'ld+json:datePublished']);
  });
  $('[itemprop="datePublished"]').each((_, el) => { cands.push([$(el).attr('content') || $(el).attr('datetime') || $(el).text(), 'itemprop:datePublished']); });
  $('time[datetime]').slice(0, 3).each((_, el) => cands.push([$(el).attr('datetime'), 'time[datetime]']));
  for (const [raw, evidence] of cands) {
    const v = normalizeDateString(raw, now);
    if (v) return { date: v, evidence: `${evidence}=${String(raw).slice(0, 40)}` };
  }
  return null;
}

function dateFromCheerio($, now = new Date()) {
  const r = dateFromCheerioDetailed($, now);
  return r ? r.date : null;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

// Biomass Magazine renders its article as a JSON payload whose FIRST publishedAt is the article's own (createdAt differs, related-article cards
// carry their own). Accepted only when the same calendar day is also printed on the page ("October 19, 2026"); otherwise it stays unresolved.
function dateFromBiomassJson(html, text, now = new Date()) {
  const m = String(html || '').match(/"publishedAt"\s*:\s*"([^"]+)"/);
  if (!m) return null;
  const d = normalizeDateString(m[1], now);
  if (!d) return null;
  const [y, mo, da] = d.split('-').map(Number);
  const printed = `${MONTHS[mo - 1]} ${da}, ${y}`;
  if (!String(text || '').includes(printed)) return null;
  return { date: d, evidence: `json:publishedAt=${m[1].slice(0, 30)} + page text "${printed}"` };
}

// Is this calendar day printed on the page itself ("October 19, 2026", "19 Oct 2026", "2026-10-19")? Independent corroboration of a metadata date.
function printedDateInText(date, text) {
  const [y, mo, da] = String(date).split('-').map(Number);
  if (!y || !mo || !da) return false;
  const full = MONTHS[mo - 1];
  const forms = [`${full} ${da}, ${y}`, `${full} ${da},${y}`, `${da} ${full} ${y}`, `${full.slice(0, 3)} ${da}, ${y}`, `${da} ${full.slice(0, 3)} ${y}`, date];
  return forms.some((f) => String(text || '').includes(f));
}

// Page -> { date, method, evidence, corroborated } or null. Generic publication metadata first; the narrow Biomass rule only for that host.
// `corroborated`: the same day is also printed on the page (a metadata date alone can be a template or a stale field).
function dateFromPage(html, url, now = new Date()) {
  const $ = require('cheerio').load(String(html || '').slice(0, 600000));
  const text = $('body').text().replace(/\s+/g, ' ');
  const generic = dateFromCheerioDetailed($, now);
  if (generic) return { date: generic.date, method: generic.evidence.startsWith('ld+json') ? 'page_ld_json' : 'page_meta', evidence: generic.evidence, corroborated: printedDateInText(generic.date, text) };
  let host = '';
  try { host = new URL(url).hostname; } catch (_) { /* no host */ }
  if (/(^|\.)biomassmagazine\.com$/i.test(host)) {
    const b = dateFromBiomassJson(html, text, now);
    if (b) return { date: b.date, method: 'biomass_publishedAt', evidence: b.evidence, corroborated: true };
  }
  return null;
}

const SOCIAL_HOSTS = /(^|\.)(linkedin|facebook|instagram|x|twitter|tiktok|youtube)\.com$/i;

// Slice of undated PUBLISHED items whose page can be read; fills published_at only when the page declares a valid date.
async function backfillFromPages({ limit = 40, afterId = 0, budgetMs = 200000 } = {}) {
  const { safeFetch } = require('./safeUrl');
  const { readResponseText } = require('./boundedResponse');
  const { rows } = await pool.query(
    "SELECT id, source_url FROM items WHERE status = 'Published' AND published_at IS NULL AND source_url IS NOT NULL AND id > $1 ORDER BY id LIMIT $2",
    [afterId, limit]
  );
  const started = Date.now();
  let updated = 0; let skipped = 0; let failed = 0; let lastId = afterId;
  const queue = [...rows];
  const worker = async () => {
    while (queue.length && Date.now() - started < budgetMs) {
      const r = queue.shift();
      lastId = Math.max(lastId, r.id);
      let host = '';
      try { host = new URL(r.source_url).hostname; } catch (_) { failed++; continue; }
      if (SOCIAL_HOSTS.test(host) || /\.pdf($|\?)/i.test(r.source_url)) { skipped++; continue; }
      try {
        const res = await safeFetch(r.source_url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ResearchArchivingBot/1.0)' }, signal: AbortSignal.timeout(8000) });
        if (!res.ok) { failed++; continue; }
        const d = dateFromHtml(await readResponseText(res, 800000, 'page'));
        if (!d) { skipped++; continue; }
        await pool.query('UPDATE items SET published_at = $2 WHERE id = $1 AND published_at IS NULL', [r.id, d]);
        updated++;
      } catch (_) { failed++; }
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  const { rows: left } = await pool.query("SELECT COUNT(*) AS n FROM items WHERE status = 'Published' AND published_at IS NULL AND id > $1", [lastId]);
  return { checked: rows.length - queue.length, updated, skipped, failed, nextAfterId: queue.length ? Math.min(...queue.map((q) => q.id)) - 1 : lastId, remainingAfter: Number(left[0].n) };
}

// ---- Unverified social-post timestamps -------------------------------------------------------------------------------------------
// LinkedIn "activity" ids and Instagram/Threads shortcodes encode when the POST was created. That is the post's own timestamp, not the
// publication date of any article it shares, and no independent ground-truth check has been done on it: it is reported as evidence only and
// is never written to published_at (nothing in this file uses it for that).
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
function socialPostTimestamp(url, now = new Date()) {
  const u = String(url || '');
  let ms = null; let platform = null;
  let m = u.match(/linkedin\.com\/posts\/[^?#]*activity-(\d{19})/i);
  if (m) { ms = Number(BigInt(m[1]) >> 22n); platform = 'linkedin_activity_id'; }
  if (ms === null) {
    m = u.match(/(?:instagram\.com\/(?:p|reel)\/|threads\.(?:com|net)\/@[^/]+\/post\/)([A-Za-z0-9_-]{6,})/i);
    if (m) {
      let id = 0n;
      for (const ch of m[1].slice(0, 11)) { const i = B64.indexOf(ch); if (i < 0) return null; id = id * 64n + BigInt(i); }
      ms = Number(id >> 23n) + 1314220021721;
      platform = /instagram/i.test(u) ? 'instagram_shortcode' : 'threads_shortcode';
    }
  }
  if (ms === null || !Number.isFinite(ms)) return null;
  const dt = new Date(ms);
  if (dt.getUTCFullYear() < MIN_YEAR || dt.getTime() > now.getTime()) return null;
  return { platform, iso: dt.toISOString(), kind: 'unverified_post_timestamp' };
}

// ---- Fetch outcome: dated / transient (retry later) / permanent (date-not-found, do not refetch) ----------------------------------
const UA = { 'User-Agent': 'Mozilla/5.0 (compatible; ResearchArchivingBot/1.0)' };
const isLinkedInPulse = (u) => /^https?:\/\/([a-z0-9-]+\.)?linkedin\.com\/pulse\//i.test(String(u || ''));
// social hosts are not read (login walls / blocks) — except LinkedIn /pulse/ articles, which are public pages with JSON-LD dates
function isUnreadableSocial(url) {
  let host = '';
  try { host = new URL(url).hostname; } catch (_) { return false; }
  return SOCIAL_HOSTS.test(host) && !isLinkedInPulse(url);
}
const TRANSIENT_STATUS = (n) => n === 408 || n === 425 || n === 429 || n >= 500;

// -> { outcome: 'dated' | 'transient' | 'permanent', date?, precision?, method?, evidence?, reason?, httpStatus? }
// Order: a full date in the URL (no fetch) > the page's own publication metadata > a month-only URL date (low confidence, precision 'month').
async function resolvePublicationDate(url, { safeFetch, readResponseText, now = new Date() } = {}) {
  const fromUrl = dateFromUrlDetailed(url, now);
  if (fromUrl && fromUrl.precision === 'day') return { outcome: 'dated', date: fromUrl.date, precision: 'day', method: fromUrl.method, evidence: `url:${String(url).slice(0, 120)}` };
  const monthOnly = () => (fromUrl ? { outcome: 'dated', date: fromUrl.date, precision: 'month', method: fromUrl.method, evidence: `url month only:${String(url).slice(0, 120)}` } : null);
  if (isUnreadableSocial(url)) return monthOnly() || { outcome: 'permanent', reason: 'social_host_unreadable' };
  if (/\.pdf($|\?)/i.test(String(url))) return monthOnly() || { outcome: 'permanent', reason: 'pdf_not_read' };
  const doFetch = safeFetch || require('./safeUrl').safeFetch;
  // prefix reader: a page over the cap (Yahoo Finance pages exceed 800 KB) is read up to the cap, not rejected — the old whole-body reader threw
  // 'exceeds limit', which the held-news step then recorded as 'no date' forever; publication metadata sits in the first bytes
  const readText = readResponseText || require('./boundedResponse').readResponsePrefixText;
  let res;
  try {
    res = await doFetch(url, { headers: UA, signal: AbortSignal.timeout(8000) });
  } catch (err) {
    return { outcome: 'transient', reason: `fetch_error:${String((err && (err.name || err.code)) || 'error').slice(0, 30)}` };
  }
  if (!res.ok) {
    const st = Number(res.status);
    if (TRANSIENT_STATUS(st)) return { outcome: 'transient', reason: `http_${st}`, httpStatus: st };
    return monthOnly() || { outcome: 'permanent', reason: Number.isFinite(st) && st >= 400 ? `http_${st}` : 'http_error', httpStatus: st };
  }
  let html;
  try { html = await readText(res, 800000); } catch (err) { return { outcome: 'transient', reason: `read_error:${String((err && (err.name || err.code)) || 'error').slice(0, 30)}` }; }
  const page = dateFromPage(html, url, now);
  if (page) return { outcome: 'dated', date: page.date, precision: 'day', method: page.method, evidence: page.evidence, corroborated: page.corroborated };
  return monthOnly() || { outcome: 'permanent', reason: 'no_date_found' };
}

// At most `perHost` fetches in flight per host, `overall` in total (keeps one site from being hit in a burst and answering 429).
async function mapWithHostLimit(items, hostOf, fn, { perHost = 1, overall = 3, budgetMs = Infinity } = {}) {
  const started = Date.now();
  const queue = [...items];
  const inflight = new Map();
  const results = [];
  await new Promise((resolve) => {
    let active = 0;
    const pump = () => {
      while (active < overall && queue.length && Date.now() - started < budgetMs) {
        const i = queue.findIndex((it) => (inflight.get(hostOf(it)) || 0) < perHost);
        if (i < 0) break;
        const [it] = queue.splice(i, 1);
        const h = hostOf(it);
        inflight.set(h, (inflight.get(h) || 0) + 1);
        active++;
        Promise.resolve(fn(it)).then((r) => results.push(r), (err) => results.push({ error: String(err && err.message) })).finally(() => {
          inflight.set(h, inflight.get(h) - 1);
          active--;
          pump();
        });
      }
      if (!active && (!queue.length || Date.now() - started >= budgetMs)) resolve();
    };
    pump();
  });
  return results;
}

const MAX_TRANSIENT_ATTEMPTS = 3;
const RULE_V2 = 'undated-news-v2';
// Bookkeeping lives in existing columns (no schema change): gate_hold_reason stays 'undated_news' while retries remain, and
// gate_hold_rule_version carries "undated-news-v2:retry:<attempts>:<YYYY-MM-DD last try>:<reason>"; a final outcome is
// gate_hold_reason 'undated_news_checked' with gate_hold_rule_version "undated-news-v2:<reason>".
function parseRetryMarker(v) {
  const m = String(v || '').match(new RegExp(`^${RULE_V2}:retry:(\\d+):(\\d{4}-\\d{2}-\\d{2}):(.*)$`));
  return m ? { attempts: Number(m[1]), lastDate: m[2], reason: m[3] } : null;
}
const kstDay = (now = new Date()) => new Date(now.getTime() + 9 * 3600 * 1000).toISOString().slice(0, 10);

// Held news (gate_hold_reason = 'undated_news'): read each page for the date it declares and, when found, set it and run the publish step again.
//  - date found            -> published_at set (only while it is still NULL), publish step retried
//  - transient failure     -> retried on a later day, at most MAX_TRANSIENT_ATTEMPTS times, once per day, reason recorded
//  - permanent (no date, blocked, social, pdf) -> 'undated_news_checked' with the reason recorded; never fetched again
// Only items collected in the last 3 days are tried. At most one fetch per host at a time.
async function fillHeldNewsDates({ limit = 24, budgetMs = 60000, now = new Date() } = {}) {
  const { applyAiDraftIfEligible, UNDATED_NEWS_REASON } = require('./aiDraft');
  const { rows } = await pool.query(
    `SELECT id, source_url, gate_hold_rule_version FROM items WHERE status = 'Draft' AND type = '뉴스' AND published_at IS NULL AND gate_hold_reason = $1
        AND collected_at >= now() - interval '3 days' ORDER BY id DESC LIMIT $2`,
    [UNDATED_NEWS_REASON, limit]
  );
  const today = kstDay(now);
  const due = rows.filter((r) => {
    const mk = parseRetryMarker(r.gate_hold_rule_version);
    return !mk || (mk.attempts < MAX_TRANSIENT_ATTEMPTS && mk.lastDate < today);
  });
  const out = { held: rows.length, dated: 0, published: 0, unresolved: 0, retry_scheduled: 0 };
  const finish = (id, reason) => pool.query("UPDATE items SET gate_hold_reason = 'undated_news_checked', gate_hold_rule_version = $2 WHERE id = $1 AND published_at IS NULL", [id, `${RULE_V2}:${reason}`.slice(0, 120)]);
  const hostOf = (r) => { try { return new URL(r.source_url).hostname; } catch (_) { return ''; } };
  await mapWithHostLimit(due, hostOf, async (r) => {
    const res = await resolvePublicationDate(r.source_url, { now });
    if (res.outcome === 'dated') {
      await pool.query('UPDATE items SET published_at = $2 WHERE id = $1 AND published_at IS NULL', [r.id, res.date]);
      out.dated++;
      try { if ((await applyAiDraftIfEligible(r.id)).archived) out.published++; } catch (_) { /* the item keeps its hold reason */ }
      return;
    }
    if (res.outcome === 'transient') {
      const attempts = ((parseRetryMarker(r.gate_hold_rule_version) || { attempts: 0 }).attempts) + 1;
      if (attempts >= MAX_TRANSIENT_ATTEMPTS) { out.unresolved++; await finish(r.id, `transient_exhausted:${res.reason}`); return; }
      out.retry_scheduled++;
      await pool.query("UPDATE items SET gate_hold_rule_version = $2 WHERE id = $1 AND published_at IS NULL AND gate_hold_reason = 'undated_news'", [r.id, `${RULE_V2}:retry:${attempts}:${today}:${res.reason}`.slice(0, 120)]);
      return;
    }
    out.unresolved++;
    await finish(r.id, res.reason);
  }, { perHost: 1, overall: 3, budgetMs });
  return out;
}

module.exports = {
  fillHeldNewsDates, resolvePublicationDate, mapWithHostLimit, parseRetryMarker, socialPostTimestamp, isUnreadableSocial, isLinkedInPulse,
  dateFromUrl, dateFromUrlDetailed, dateFromSpglobalUrl, dateFromHtml, dateFromPage, dateFromBiomassJson, dateFromCheerio, dateFromCheerioDetailed,
  normalizeDateString, backfillPublishedDates, backfillFromPages, MAX_TRANSIENT_ATTEMPTS,
};
