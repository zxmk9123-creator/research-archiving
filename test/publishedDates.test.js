const test = require('node:test');
const assert = require('node:assert/strict');
const { dateFromUrl } = require('../server/lib/publishedDates');
const { VERIFY_DATED_COMPANIES, buildQueries } = require('../server/lib/companyProfileCollection');

const now = new Date('2026-10-17T00:00:00Z');
test('dateFromUrl: full dates, compact dates, year/month; ids and future dates are not dates', () => {
  assert.equal(dateFromUrl('https://x.com/news/2025/03/12/saf-plant', now), '2025-03-12');
  assert.equal(dateFromUrl('https://x.com/2025-03-12-saf', now), '2025-03-12');
  assert.equal(dateFromUrl('https://x.com/press/20250312_saf.html', now), '2025-03-12');
  assert.equal(dateFromUrl('https://x.com/blog/2024/07/saf-update', now), '2024-07-01');
  assert.equal(dateFromUrl('https://x.com/article/12345678901', now), null);      // a long id, not a date
  assert.equal(dateFromUrl('https://x.com/2027/05/12/future', now), null);        // in the future
  assert.equal(dateFromUrl('https://x.com/2025/13/40/x', now), null);             // impossible
  assert.equal(dateFromUrl('https://x.com/report.pdf', now), null);
  assert.equal(dateFromUrl('https://www.idemitsu.com/en/news/2023/240313.html', now), null); // 'YYMMDD' file names are not guessed
});

test('verify-dated set: two dated-news queries per large SAF producer', () => {
  assert.ok(VERIFY_DATED_COMPANIES.length >= 15);
  for (const c of VERIFY_DATED_COMPANIES) {
    const q = buildQueries(c);
    assert.equal(q.length, 2);
    assert.ok(q.every((x) => /20(25|26)/.test(x)), c.name);
  }
});

test('dateFromHtml: reads the date the page itself declares and ignores anything else', () => {
  const { dateFromHtml } = require('../server/lib/publishedDates');
  const now = new Date('2026-10-22T00:00:00Z');
  assert.equal(dateFromHtml('<meta property="article:published_time" content="2026-03-04T09:00:00+09:00">', now), '2026-03-04');
  assert.equal(dateFromHtml('<script type="application/ld+json">{"@type":"NewsArticle","datePublished":"2025-11-30T01:02:03Z"}</script>', now), '2025-11-30');
  assert.equal(dateFromHtml('<time datetime="2024-01-15">Jan 15</time>', now), '2024-01-15');
  assert.equal(dateFromHtml('<meta property="article:published_time" content="2031-01-01">', now), null, 'a future date is not accepted');
  assert.equal(dateFromHtml('<p>no date here</p>', now), null);
});
