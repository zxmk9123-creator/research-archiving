const test = require('node:test');
const assert = require('node:assert/strict');
const { discoverFromHtml, discoverFromCgspaceHtml, discoverReports } = require('../server/lib/adapters/institutionPdf');

test('discoverFromHtml: finds a direct .pdf link with its anchor text as title', () => {
  const html = `<a href="/reports/CMO-October-2026.pdf">Commodity Markets Outlook, October 2026</a>`;
  const candidates = discoverFromHtml(html, 'https://example.org/research/');
  assert.deepEqual(candidates, [
    { title: 'Commodity Markets Outlook, October 2026', link: 'https://example.org/reports/CMO-October-2026.pdf' },
  ]);
});

test('discoverFromHtml: finds a repository "bitstream download" link even without a .pdf extension', () => {
  const html = `<a href="https://openknowledge.example.org/bitstreams/abc-123/download">Full report</a>`;
  const candidates = discoverFromHtml(html, 'https://example.org/');
  assert.deepEqual(candidates, [
    { title: 'Full report', link: 'https://openknowledge.example.org/bitstreams/abc-123/download' },
  ]);
});

test('discoverFromHtml: ignores non-report links (nav, unrelated pages)', () => {
  const html = `
    <a href="/about">About Us</a>
    <a href="/research/commodity-markets/report-archive">Report Archive</a>
    <a href="/image.png">A picture</a>
  `;
  assert.deepEqual(discoverFromHtml(html, 'https://example.org/'), []);
});

test('discoverFromHtml: decodes HTML entities in anchor text', () => {
  const html = `<a href="/x.pdf">Prices &amp; Trends, Q3&#39;26</a>`;
  const candidates = discoverFromHtml(html, 'https://example.org/');
  assert.equal(candidates[0].title, "Prices & Trends, Q3'26");
});

test('discoverFromHtml: dedupes the same href linked twice on the page', () => {
  const html = `
    <a href="/x.pdf">Report (image link)</a>
    <a href="/x.pdf">Report (text link)</a>
  `;
  const candidates = discoverFromHtml(html, 'https://example.org/');
  assert.equal(candidates.length, 1);
});

test('discoverFromHtml: skips a PDF link with only trivial/whitespace anchor text', () => {
  const html = `<a href="/x.pdf">  </a>`;
  assert.deepEqual(discoverFromHtml(html, 'https://example.org/'), []);
});

test('discoverFromHtml: resolves a relative href against the listing page URL', () => {
  const html = `<a href="../reports/x.pdf">A Report</a>`;
  const candidates = discoverFromHtml(html, 'https://example.org/research/commodity-markets');
  assert.equal(candidates[0].link, 'https://example.org/reports/x.pdf');
});

test('discoverFromHtml: never accepts a literal "Download" (or similar generic label) as a title', () => {
  const html = `<a href="/x.pdf">Download</a>`;
  assert.deepEqual(discoverFromHtml(html, 'https://example.org/'), []);
});

// --- discoverFromCgspaceHtml: CGSpace/IFPRI listing pages join the real
// title (a separate <h4>) to the download link via a shared
// data-identifier — the download <a>'s own anchor text is always the
// generic word "Download" and must never become the title.

function cgspaceCard({ identifier, title, bitstreamId }) {
  return `
    <div class="resultsItem resourceItemRecord">
      <div class="cardContent">
        <div class="ifResourcesWrap list">
          <h4 class="ifResourcesTitle ifb-title list" data-identifier ="${identifier}">${title}</h4>
        </div>
        <section class="resourceBtnSection">
          <button class="resourceDownloadBtn ifResBtn detailsBtn" data-identifier ="${identifier}">
            <a href="https://cgspace.cgiar.org/server/api/core/bitstreams/${bitstreamId}/content" target="_blank" data-identifier ="${identifier}">Download</a>
          </button>
        </section>
      </div>
    </div>
  `;
}

test('discoverFromCgspaceHtml: joins the real <h4> title to its download link via data-identifier', () => {
  const html = cgspaceCard({
    identifier: '10568_185564',
    title: "Mapping the policy landscape for climate action in Ethiopia&#039;s agrifood systems",
    bitstreamId: '02f28e7a-7f7b-4283-b922-1f3af25f416f',
  });
  const candidates = discoverFromCgspaceHtml(html);
  assert.deepEqual(candidates, [
    {
      title: "Mapping the policy landscape for climate action in Ethiopia's agrifood systems",
      link: 'https://cgspace.cgiar.org/server/api/core/bitstreams/02f28e7a-7f7b-4283-b922-1f3af25f416f/content',
    },
  ]);
});

test('discoverFromCgspaceHtml: never returns the literal "Download" anchor text as a title', () => {
  // Same shape as the real page: the download <a>'s own text is "Download"
  // — discoverFromCgspaceHtml must read the <h4> instead, never this.
  const html = cgspaceCard({ identifier: '1', title: 'Real Report Title', bitstreamId: 'abc' });
  const candidates = discoverFromCgspaceHtml(html);
  assert.equal(candidates[0].title, 'Real Report Title');
  assert.notEqual(candidates[0].title, 'Download');
});

test('discoverFromCgspaceHtml: skips a download link whose data-identifier has no matching <h4> title', () => {
  const html = `
    <a href="https://cgspace.cgiar.org/server/api/core/bitstreams/orphan-id/content" data-identifier ="999">Download</a>
  `;
  assert.deepEqual(discoverFromCgspaceHtml(html), []);
});

test('discoverFromCgspaceHtml: skips a <h4> title that is itself only a generic placeholder', () => {
  const html = cgspaceCard({ identifier: '2', title: 'Download', bitstreamId: 'def' });
  assert.deepEqual(discoverFromCgspaceHtml(html), []);
});

test('discoverFromCgspaceHtml: handles multiple cards and dedupes a repeated download link', () => {
  const html = cgspaceCard({ identifier: '1', title: 'First Report', bitstreamId: 'aaa' })
    + cgspaceCard({ identifier: '2', title: 'Second Report', bitstreamId: 'bbb' })
    + `<a href="https://cgspace.cgiar.org/server/api/core/bitstreams/aaa/content" data-identifier ="1">Download</a>`;
  const candidates = discoverFromCgspaceHtml(html);
  assert.equal(candidates.length, 2);
  assert.deepEqual(candidates.map((c) => c.title).sort(), ['First Report', 'Second Report']);
});

// --- discoverReports: dispatches to the CGSpace-specific extraction only
// for CGSpace-backed pages, and keeps the original anchor-text scan for
// every other institutional page (World Bank's included) unchanged.

function mockFetch(handler) {
  const original = global.fetch;
  global.fetch = handler;
  return () => { global.fetch = original; };
}

test('discoverReports: a World Bank-style page (no CGSpace markers) uses the original anchor-text discovery, unchanged', async () => {
  const html = `<a href="/reports/CMO-2026.pdf">Commodity Markets Outlook, 2026</a>`;
  const restore = mockFetch(async () => ({ ok: true, status: 200, text: async () => html }));
  try {
    const candidates = await discoverReports({ url: 'https://www.worldbank.org/en/research/commodity-markets' });
    assert.deepEqual(candidates, [
      { title: 'Commodity Markets Outlook, 2026', link: 'https://www.worldbank.org/reports/CMO-2026.pdf' },
    ]);
  } finally {
    restore();
  }
});

test('discoverReports: a CGSpace-backed page (IFPRI) is routed to the title/data-identifier join extraction', async () => {
  const html = cgspaceCard({ identifier: '10568_185564', title: 'Real IFPRI Report Title', bitstreamId: '02f28e7a-7f7b-4283-b922-1f3af25f416f' });
  const restore = mockFetch(async () => ({ ok: true, status: 200, text: async () => html }));
  try {
    const candidates = await discoverReports({ url: 'https://www.ifpri.org/publications/' });
    assert.deepEqual(candidates, [
      {
        title: 'Real IFPRI Report Title',
        link: 'https://cgspace.cgiar.org/server/api/core/bitstreams/02f28e7a-7f7b-4283-b922-1f3af25f416f/content',
      },
    ]);
  } finally {
    restore();
  }
});
