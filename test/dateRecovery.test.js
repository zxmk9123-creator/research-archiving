const test = require('node:test');
const assert = require('node:assert/strict');
const pool = require('../server/db/pool');
const safeUrl = require('../server/lib/safeUrl');
const ai = require('../server/lib/aiDraft');
const P = require('../server/lib/publishedDates');
const { buildDateRecoveryReport } = require('../server/lib/dateRecovery');

const NOW = new Date('2026-10-28T03:00:00Z');
const html = (head, body = '') => `<html><head>${head}</head><body>${body}</body></html>`;
const resp = (status, body) => ({ ok: status >= 200 && status < 300, status, body });
const readBody = async (r) => r.body;

// ---- provenance: only publication fields are read -------------------------------------------------------------------------
test('provenance: dateModified / updated_time / page-header dates are never publication dates', () => {
  assert.equal(P.dateFromPage(html('<meta property="article:modified_time" content="2026-10-20T00:00:00Z"><meta property="og:updated_time" content="2026-10-21T00:00:00Z">',
    '<script type="application/ld+json">{"dateModified":"2026-10-22T00:00:00Z"}</script>Wednesday, 28 Oct 2026'), 'https://news.example/a', NOW), null);
  const ok = P.dateFromPage(html('<meta property="article:published_time" content="2026-10-19T10:00:00Z"><meta property="article:modified_time" content="2026-10-25T00:00:00Z">',
    'October 19, 2026'), 'https://news.example/a', NOW);
  assert.deepEqual([ok.date, ok.method, ok.corroborated], ['2026-10-19', 'page_meta', true]);
  assert.match(ok.evidence, /^meta:article:published_time=/);
});

test('provenance: Biomass publishedAt counts only when printed on the page; createdAt/updatedAt and other hosts never count', () => {
  const payload = '{"createdAt":"2026-10-16T21:26:48Z","publishedAt":"2026-10-19T14:15:00Z","updatedAt":"2026-10-25T00:00:00Z"}';
  const url = 'https://biomassmagazine.com/articles/x';
  const good = P.dateFromPage(html(`<script>${payload}</script>`, 'IATA corporate demand October 19, 2026 By Erin'), url, NOW);
  assert.deepEqual([good.date, good.method], ['2026-10-19', 'biomass_publishedAt']);
  assert.equal(P.dateFromPage(html(`<script>${payload}</script>`, 'no printed date here'), url, NOW), null, 'uncorroborated stays unresolved');
  assert.equal(P.dateFromPage(html(`<script>{"createdAt":"2026-10-16T21:26:48Z","updatedAt":"2026-10-25T00:00:00Z"}</script>`, 'October 16, 2026'), url, NOW), null);
  assert.equal(P.dateFromPage(html(`<script>${payload}</script>`, 'October 19, 2026'), 'https://other.example/x', NOW), null, 'rule is host-scoped');
});

test('S&P Global: the MMDDYY slug prefix is read only on spglobal.com and only when it is a real, non-future date', () => {
  const sp = (slug) => `https://www.spglobal.com/energy/en/news-research/latest-news/agriculture/${slug}`;
  assert.deepEqual(P.dateFromUrlDetailed(sp('093026-black-sea-sunflower-oil'), NOW), { date: '2026-09-30', precision: 'day', method: 'spglobal_url_mmddyy' });
  assert.equal(P.dateFromUrl(sp('012225-eni-boosts-saf'), NOW), '2025-01-22');
  assert.equal(P.dateFromUrl(sp('133026-bad-month'), NOW), null);
  assert.equal(P.dateFromUrl(sp('123126-in-the-future'), NOW), null, 'after today');
  assert.equal(P.dateFromUrl('https://example.com/news/093026-black-sea', NOW), null, 'other hosts are not interpreted');
});

// ---- month-only and future dates -----------------------------------------------------------------------------------------------
test('month-only URL dates are reported as precision "month" and are never proposed for writing', async () => {
  assert.deepEqual(P.dateFromUrlDetailed('https://a.example/2026/10/some-story', NOW), { date: '2026-10-01', precision: 'month', method: 'url_month_only' });
  const rep = await buildDateRecoveryReport({
    rows: [{ id: 1, status: 'Draft', type: '뉴스', source_url: 'https://a.example/2026/10/some-story', auto_review: null }],
    now: NOW, deps: { safeFetch: async () => resp(200, html('')), readResponseText: readBody },
  });
  assert.equal(rep.rows[0].precision, 'month');
  assert.equal(rep.rows[0].proposed_action, 'review_month_only_low_confidence');
  assert.equal(rep.rows[0].writes, 'none');
});

test('future dates are rejected everywhere (URL, page metadata, social timestamp)', async () => {
  assert.equal(P.dateFromUrl('https://a.example/2026/12/25/story', NOW), null);
  assert.equal(P.dateFromPage(html('<meta property="article:published_time" content="2027-01-05T00:00:00Z">'), 'https://a.example/s', NOW), null);
  const far = (BigInt(Date.UTC(2027, 0, 1)) << 22n).toString();
  assert.equal(P.socialPostTimestamp(`https://www.linkedin.com/posts/x_y-activity-${far}-Ab`, NOW), null);
});

// ---- social-post ids -------------------------------------------------------------------------------------------------------------
test('social ids are unverified post timestamps: reported as evidence, never a candidate for published_at', async () => {
  const li = 'https://www.linkedin.com/posts/happy-ground_oilpalm-activity-7519307142617534464-Sw98';
  assert.deepEqual(P.socialPostTimestamp(li, NOW), { platform: 'linkedin_activity_id', iso: '2026-10-23T08:02:04.771Z', kind: 'unverified_post_timestamp' });
  assert.equal(P.dateFromUrl(li, NOW), null);
  assert.equal(P.socialPostTimestamp('https://www.instagram.com/p/DezFUwSpkv7', NOW).kind, 'unverified_post_timestamp');
  let fetched = 0;
  const rep = await buildDateRecoveryReport({
    rows: [{ id: 2, status: 'Draft', type: '뉴스', source_url: li }, { id: 3, status: 'Draft', type: '뉴스', source_url: 'https://www.facebook.com/x/posts/123' }],
    now: NOW, deps: { safeFetch: async () => { fetched++; return resp(200, html('')); }, readResponseText: readBody },
  });
  assert.equal(fetched, 0, 'unreadable social hosts are not fetched');
  const byId = Object.fromEntries(rep.rows.map((r) => [r.id, r]));
  assert.equal(byId[2].proposed_action, 'report_only_unverified_social_timestamp');
  assert.equal(byId[2].candidate_date, null);
  assert.equal(byId[2].social_post_timestamp.kind, 'unverified_post_timestamp');
  assert.equal(byId[2].writes, 'none');
  assert.equal(byId[3].proposed_action, 'mark_unresolved_permanent');
});

test('LinkedIn /pulse/ articles are public pages and are read; /posts/ are not', async () => {
  assert.equal(P.isUnreadableSocial('https://www.linkedin.com/pulse/some-article-abcd'), false);
  assert.equal(P.isUnreadableSocial('https://www.linkedin.com/posts/x-activity-1'), true);
  const r = await P.resolvePublicationDate('https://www.linkedin.com/pulse/a-b', {
    safeFetch: async () => resp(200, html('<script type="application/ld+json">{"datePublished":"2026-10-27T04:49:05.000+0000","dateModified":"2026-10-28T01:00:00.000+0000"}</script>', 'Oct 27, 2026')),
    readResponseText: readBody, now: NOW,
  });
  assert.deepEqual([r.outcome, r.date, r.method, r.corroborated], ['dated', '2026-10-27', 'page_ld_json', true]);
});

// ---- transient vs permanent ---------------------------------------------------------------------------------------------------
test('failure classification: network/timeout/429/5xx are transient; 401/403/404, no-date pages, pdf and social are permanent; reason recorded', async () => {
  const outcome = async (safeFetch, url = 'https://x.example/a') => P.resolvePublicationDate(url, { safeFetch, readResponseText: readBody, now: NOW });
  const t = async (status) => outcome(async () => resp(status, ''));
  for (const [status, reason] of [[429, 'http_429'], [503, 'http_503'], [500, 'http_500'], [408, 'http_408']]) assert.deepEqual([(await t(status)).outcome, (await t(status)).reason], ['transient', reason]);
  const timeout = await outcome(async () => { const e = new Error('t'); e.name = 'TimeoutError'; throw e; });
  assert.deepEqual([timeout.outcome, timeout.reason], ['transient', 'fetch_error:TimeoutError']);
  for (const [status, reason] of [[403, 'http_403'], [404, 'http_404'], [401, 'http_401'], [410, 'http_410']]) assert.deepEqual([(await t(status)).outcome, (await t(status)).reason], ['permanent', reason]);
  const nodate = await outcome(async () => resp(200, html('<title>x</title>')));
  assert.deepEqual([nodate.outcome, nodate.reason], ['permanent', 'no_date_found']);
  assert.deepEqual((await outcome(async () => { throw new Error('unused'); }, 'https://x.example/f.pdf')).reason, 'pdf_not_read');
  const readFail = await P.resolvePublicationDate('https://x.example/a', { safeFetch: async () => resp(200, ''), readResponseText: async () => { const e = new Error('r'); e.name = 'AbortError'; throw e; }, now: NOW });
  assert.deepEqual([readFail.outcome, readFail.reason], ['transient', 'read_error:AbortError']);
});

test('a page larger than the read cap still yields its date (Yahoo pages exceed 800 KB; the old reader rejected them as "no date")', async () => {
  const head = html('<script type="application/ld+json">{"datePublished":"2024-12-09T10:00:00Z"}</script>', 'Dec 9, 2024 ') ;
  const filler = 'x'.repeat(1_200_000);
  const stream = new ReadableStream({ start(c) { c.enqueue(Buffer.from(head + filler)); c.close(); } });
  const r = await P.resolvePublicationDate('https://finance.yahoo.com/news/big-1.html', { safeFetch: async () => new Response(stream, { status: 200 }), now: NOW });
  assert.deepEqual([r.outcome, r.date, r.method], ['dated', '2024-12-09', 'page_ld_json']);
});

// ---- retry bookkeeping in the live step ---------------------------------------------------------------------------------------
function harness(rows, fetchImpl) {
  const original = pool.query; const calls = [];
  const sf = safeUrl.safeFetch;
  const bounded = require('../server/lib/boundedResponse');
  const rp = bounded.readResponsePrefixText;
  safeUrl.safeFetch = fetchImpl; bounded.readResponsePrefixText = async (r) => r.body;
  const applied = [];
  const origApply = ai.applyAiDraftIfEligible;
  ai.applyAiDraftIfEligible = async (id) => { applied.push(id); return { archived: false }; };
  pool.query = async (text, params) => { calls.push({ text, params }); return /SELECT id, source_url.* FROM items/.test(text) ? { rows } : { rows: [] }; };
  return { calls, applied, restore: () => { pool.query = original; safeUrl.safeFetch = sf; bounded.readResponsePrefixText = rp; ai.applyAiDraftIfEligible = origApply; } };
}
const markerFor = (calls, id) => calls.filter((c) => /UPDATE items SET gate_hold_rule_version/.test(c.text) && c.params[0] === id).map((c) => c.params[1]);
const finalFor = (calls, id) => calls.filter((c) => /undated_news_checked/.test(c.text) && c.params[0] === id).map((c) => c.params[1]);

test('held news: a transient failure is retried on later days only, at most 3 times, with the reason recorded; then it is settled', async () => {
  const run = async (row, day) => {
    const h = harness([row], async () => resp(429, ''));
    try { const out = await P.fillHeldNewsDates({ limit: 5, now: new Date(`${day}T03:00:00Z`) }); return { out, calls: h.calls }; } finally { h.restore(); }
  };
  const base = { id: 7, source_url: 'https://rate.example/a', gate_hold_rule_version: 'undated-news-v1' };
  const d1 = await run(base, '2026-10-28');
  assert.equal(d1.out.retry_scheduled, 1);
  assert.deepEqual(markerFor(d1.calls, 7), ['undated-news-v2:retry:1:2026-10-28:http_429']);
  // same day again: not due, no fetch, no write
  const same = await run({ ...base, gate_hold_rule_version: 'undated-news-v2:retry:1:2026-10-28:http_429' }, '2026-10-28');
  assert.deepEqual([same.out.retry_scheduled, same.out.unresolved, markerFor(same.calls, 7).length, finalFor(same.calls, 7).length], [0, 0, 0, 0]);
  const d2 = await run({ ...base, gate_hold_rule_version: 'undated-news-v2:retry:1:2026-10-28:http_429' }, '2026-10-29');
  assert.deepEqual(markerFor(d2.calls, 7), ['undated-news-v2:retry:2:2026-10-29:http_429']);
  const d3 = await run({ ...base, gate_hold_rule_version: 'undated-news-v2:retry:2:2026-10-29:http_429' }, '2026-10-30');
  assert.deepEqual(finalFor(d3.calls, 7), ['undated-news-v2:transient_exhausted:http_429']);
  assert.equal(d3.out.unresolved, 1);
});

test('held news: permanent outcomes are settled once with the reason recorded and are not selected again', async () => {
  const h = harness([{ id: 8, source_url: 'https://blocked.example/a' }, { id: 9, source_url: 'https://nodate.example/a' }],
    async (url) => (/blocked/.test(url) ? resp(403, '') : resp(200, html('<title>x</title>'))));
  try {
    const out = await P.fillHeldNewsDates({ limit: 5, now: NOW });
    assert.equal(out.unresolved, 2);
    assert.deepEqual(finalFor(h.calls, 8), ['undated-news-v2:http_403']);
    assert.deepEqual(finalFor(h.calls, 9), ['undated-news-v2:no_date_found']);
    const select = h.calls.find((c) => /SELECT id, source_url/.test(c.text));
    assert.match(select.text, /gate_hold_reason = \$1/);   // only 'undated_news' rows: settled ones carry 'undated_news_checked'
  } finally { h.restore(); }
});

test('held news: per-host fetches never overlap (limit 1); different hosts run in parallel', async () => {
  const live = {}; let maxSame = 0; let maxAll = 0; let all = 0;
  const h = harness(
    ['a', 'a', 'a', 'b', 'c'].map((host, i) => ({ id: 20 + i, source_url: `https://${host}.example/p${i}` })),
    async (url) => {
      const host = new URL(url).hostname; live[host] = (live[host] || 0) + 1; all++;
      maxSame = Math.max(maxSame, live[host]); maxAll = Math.max(maxAll, all);
      await new Promise((r) => setTimeout(r, 15));
      live[host]--; all--;
      return resp(200, html('<title>x</title>'));
    });
  try { await P.fillHeldNewsDates({ limit: 10, now: NOW }); } finally { h.restore(); }
  assert.equal(maxSame, 1);
  assert.ok(maxAll >= 2, 'hosts are processed in parallel');
});

// ---- preservation -------------------------------------------------------------------------------------------------------------
test('held news: a human-reviewed record only gets published_at / hold bookkeeping — summary, insight, tags and status are never written, and it is not re-published', async () => {
  const h = harness([{ id: 30, source_url: 'https://news.example/a', auto_review: 'human' }], async () => resp(200, html('<meta property="article:published_time" content="2026-10-24T08:00:00Z">', 'October 24, 2026')));
  try {
    const out = await P.fillHeldNewsDates({ limit: 5, now: NOW });
    assert.equal(out.dated, 1);
    const writes = h.calls.filter((c) => /^\s*(UPDATE|INSERT|DELETE)/i.test(c.text));
    assert.ok(writes.length >= 1);
    for (const w of writes) assert.ok(!/summary|insight|status\s*=|item_sectors|item_usages/i.test(w.text), w.text);
    assert.ok(writes.every((w) => /published_at|gate_hold/.test(w.text)));
  } finally { h.restore(); }
});

test('dry-run report: performs no database call, never fetches settled-permanent rows, and a backfill would only ever write published_at', async () => {
  const original = pool.query; let dbCalls = 0; pool.query = async () => { dbCalls++; return { rows: [] }; };
  let fetches = 0;
  try {
    const rep = await buildDateRecoveryReport({
      rows: [
        { id: 40, status: 'Published', type: '뉴스', source_url: 'https://news.example/2026/10/20/palm', auto_review: 'human' },
        { id: 41, status: 'Draft', type: '뉴스', source_url: 'https://settled.example/a', gate_hold_reason: 'undated_news_checked', gate_hold_rule_version: 'undated-news-v2:no_date_found' },
        { id: 42, status: 'Draft', type: '뉴스', source_url: 'https://legacy.example/a', gate_hold_reason: 'undated_news_checked', gate_hold_rule_version: 'undated-news-v1' },
        { id: 43, status: 'Draft', type: '뉴스', source_url: 'https://flaky.example/a' },
        { id: 44, status: 'Draft', type: '뉴스', source_url: 'https://meta.example/a' },
      ],
      now: NOW,
      deps: {
        safeFetch: async (url) => {
          fetches++;
          if (/flaky/.test(url)) return resp(503, '');
          if (/meta/.test(url)) return resp(200, html('<meta name="date" content="2026-10-23">', ''));   // metadata the page never prints
          return resp(200, html('<meta property="article:published_time" content="2026-10-21T00:00:00Z">', 'October 21, 2026'));
        },
        readResponseText: readBody,
      },
    });
    const by = Object.fromEntries(rep.rows.map((r) => [r.id, r]));
    assert.equal(dbCalls, 0);
    assert.equal(rep.dry_run, true);
    assert.deepEqual([by[40].proposed_action, by[40].writes, by[40].human_reviewed, by[40].method], ['set_published_at', 'published_at only', true, 'url_date']);
    assert.equal(by[41].proposed_action, 'skip_settled_permanent');
    assert.equal(by[42].proposed_action, 'set_published_at', 'a legacy checked row is fetched once more');
    assert.equal(by[43].proposed_action, 'retry_later');
    assert.equal(by[44].proposed_action, 'review_uncorroborated_metadata_date');
    assert.equal(fetches, 4, 'a URL-dated row costs one cross-check fetch; settled rows cost none');
    assert.match(by[40].cross_check, /^agrees_within_1_day:page_meta/);
    for (const r of rep.rows) assert.ok(['none', 'published_at only'].includes(r.writes));
  } finally { pool.query = original; }
});

test('URL dates are cross-checked against the page: a conflict is held for review, an uncorroborated compact 8-digit date is not trusted alone, a separated date is', async () => {
  const page = (d) => resp(200, html(`<meta property="article:published_time" content="${d}T00:00:00Z">`, ''));
  const none = resp(200, html('<title>x</title>'));
  const run = (rows, fetchFor) => buildDateRecoveryReport({ rows, now: NOW, deps: { safeFetch: async (url) => fetchFor(url), readResponseText: readBody } });
  const rep = await run([
    { id: 1, status: 'Draft', type: '뉴스', source_url: 'https://a.example/2026/10/20/story' },
    { id: 2, status: 'Draft', type: '뉴스', source_url: 'https://b.example/news/20261020-story' },
    { id: 3, status: 'Draft', type: '뉴스', source_url: 'https://c.example/2026/10/20/story' },
    { id: 4, status: 'Draft', type: '뉴스', source_url: 'https://d.example/news/20261020-story' },
    { id: 5, status: 'Draft', type: '뉴스', source_url: 'https://e.example/2026/10/20/story', collected_at: '2026-10-10T00:00:00Z' },
  ], (url) => (/a\.example/.test(url) ? page('2026-09-01') : /d\.example/.test(url) ? page('2026-10-20') : none));
  const by = Object.fromEntries(rep.rows.map((r) => [r.id, r]));
  assert.equal(by[1].proposed_action, 'review_conflicting_dates');
  assert.match(by[1].cross_check, /^CONFLICT/);
  assert.equal(by[2].proposed_action, 'review_url_date_uncorroborated');
  assert.equal(by[3].proposed_action, 'set_published_at');
  assert.match(by[3].cross_check, /^no_page_date/);
  assert.equal(by[4].proposed_action, 'set_published_at');
  assert.equal(by[4].cross_check, 'agrees:page_meta');
  assert.equal(by[5].proposed_action, 'review_date_after_collection', 'a publication date later than the collection day is not credible');
});

test('"printed on the page" means visible text: a date that only appears inside <script> JSON does not corroborate a metadata date', () => {
  const only = P.dateFromPage(html('<meta property="article:published_time" content="2026-10-19T10:00:00Z"><script>{"d":"October 19, 2026"}</script>', 'no date shown'), 'https://n.example/a', NOW);
  assert.deepEqual([only.date, only.corroborated], ['2026-10-19', false]);
  const shown = P.dateFromPage(html('<meta property="article:published_time" content="2026-10-19T10:00:00Z">', 'Published October 19, 2026'), 'https://n.example/a', NOW);
  assert.equal(shown.corroborated, true);
});

test('Biomass publishedAt rule also covers the BBI sister sites with the same CMS payload, with the same on-page corroboration', () => {
  const payload = '{"createdAt":"2025-01-31T00:02:34Z","publishedAt":"2025-01-31T00:02:36Z"}';
  for (const host of ['biodieselmagazine.com', 'ethanolproducer.com', 'biomassmagazine.com']) {
    const r = P.dateFromPage(html(`<script>${payload}</script>`, 'January 31, 2025'), `https://www.${host}/articles/x`, NOW);
    assert.deepEqual([r.date, r.method, r.corroborated], ['2025-01-31', 'biomass_publishedAt', true], host);
  }
  assert.equal(P.dateFromPage(html(`<script>${payload}</script>`, 'January 31, 2025'), 'https://example.com/articles/x', NOW), null);
});
