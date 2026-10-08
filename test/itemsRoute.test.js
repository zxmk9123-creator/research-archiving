const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const pool = require('../server/db/pool');
const itemsRouter = require('../server/routes/items');

// Minimal live-server harness (express + node's own fetch) rather than a
// new test-framework dependency — the router's PATCH guard for the
// minimum classification invariant needs to be exercised through the
// actual HTTP route (where the guard lives), not just its inner helper.
function withServer(fn) {
  const app = express();
  app.use(express.json());
  app.use('/api/items', itemsRouter);
  return new Promise((resolve, reject) => {
    const server = app.listen(0, async () => {
      const { port } = server.address();
      try {
        await fn(`http://127.0.0.1:${port}/api/items`);
        resolve();
      } catch (err) {
        reject(err);
      } finally {
        server.close();
      }
    });
  });
}

// Same substring-matched pool.query dispatcher convention used across the
// existing test suite (collector.test.js, aiDraft.test.js).
function mockPool(handlers) {
  const original = pool.query;
  const calls = [];
  pool.query = async (text, params) => {
    calls.push({ text, params });
    for (const [match, handler] of handlers) {
      if (text.includes(match)) return handler(text, params);
    }
    return { rows: [] };
  };
  return { calls, restore: () => { pool.query = original; } };
}

function itemRow(overrides) {
  return { id: 10, title: 'Test item', status: 'Draft', ...overrides };
}

test('PATCH /:id: rejects publishing an item with no sector/usage classification', async () => {
  const { calls, restore } = mockPool([
    ['SELECT id, type FROM items WHERE id', () => ({ rows: [{ id: 10, type: '뉴스' }] })],
    ['SELECT EXISTS', () => ({ rows: [{ has_sector: false, has_usage: false }] })],
  ]);
  try {
    await withServer(async (base) => {
      const res = await fetch(`${base}/10`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status: 'Published' }),
      });
      assert.equal(res.status, 400);
      const body = await res.json();
      assert.match(body.error, /섹터|usage|classification/i);
      assert.equal(calls.filter((c) => c.text.includes('UPDATE items SET') && c.text.includes('status')).length, 0);
    });
  } finally {
    restore();
  }
});

test('PATCH /:id: publishes an item that already has valid sector/usage tags', async () => {
  const { calls, restore } = mockPool([
    ['SELECT id, type FROM items WHERE id', () => ({ rows: [{ id: 11, type: '뉴스' }] })],
    ['SELECT EXISTS', () => ({ rows: [{ has_sector: true, has_usage: true }] })],
    ['FROM items i', () => ({ rows: [itemRow({ id: 11, status: 'Published' })] })],
  ]);
  try {
    await withServer(async (base) => {
      const res = await fetch(`${base}/11`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status: 'Published' }),
      });
      assert.equal(res.status, 200);
      const updateCall = calls.find((c) => c.text.includes('UPDATE items SET') && c.text.includes('status'));
      assert.ok(updateCall, 'expected the status UPDATE to run');
      assert.ok(updateCall.params.includes('Published'));
    });
  } finally {
    restore();
  }
});

test('PATCH /:id: publishing a 뉴스 item sets content_category to daily_report', async () => {
  const { calls, restore } = mockPool([
    ['SELECT id, type FROM items WHERE id', () => ({ rows: [{ id: 14, type: '뉴스' }] })],
    ['SELECT EXISTS', () => ({ rows: [{ has_sector: true, has_usage: true }] })],
    ['FROM items i', () => ({ rows: [itemRow({ id: 14, status: 'Published' })] })],
  ]);
  try {
    await withServer(async (base) => {
      const res = await fetch(`${base}/14`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status: 'Published' }),
      });
      assert.equal(res.status, 200);
      const updateCall = calls.find((c) => c.text.includes('UPDATE items SET') && c.text.includes('content_category'));
      assert.ok(updateCall);
      assert.ok(updateCall.params.includes('daily_report'));
    });
  } finally {
    restore();
  }
});

test('PATCH /:id: publishing a 보고서 item sets content_category to archive', async () => {
  const { calls, restore } = mockPool([
    ['SELECT id, type FROM items WHERE id', () => ({ rows: [{ id: 15, type: '보고서' }] })],
    ['SELECT EXISTS', () => ({ rows: [{ has_sector: true, has_usage: true }] })],
    ['FROM items i', () => ({ rows: [itemRow({ id: 15, status: 'Published' })] })],
  ]);
  try {
    await withServer(async (base) => {
      const res = await fetch(`${base}/15`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status: 'Published' }),
      });
      assert.equal(res.status, 200);
      const updateCall = calls.find((c) => c.text.includes('UPDATE items SET') && c.text.includes('content_category'));
      assert.ok(updateCall);
      assert.ok(updateCall.params.includes('archive'));
    });
  } finally {
    restore();
  }
});

test('PATCH /:id: a type change in the same publish request decides content_category over the stored type', async () => {
  const { calls, restore } = mockPool([
    ['SELECT id, type FROM items WHERE id', () => ({ rows: [{ id: 16, type: '뉴스' }] })],
    ['SELECT EXISTS', () => ({ rows: [{ has_sector: true, has_usage: true }] })],
    ['FROM items i', () => ({ rows: [itemRow({ id: 16, status: 'Published' })] })],
  ]);
  try {
    await withServer(async (base) => {
      const res = await fetch(`${base}/16`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status: 'Published', type: '보고서' }),
      });
      assert.equal(res.status, 200);
      const updateCall = calls.find((c) => c.text.includes('UPDATE items SET') && c.text.includes('content_category'));
      assert.ok(updateCall);
      assert.ok(updateCall.params.includes('archive'));
    });
  } finally {
    restore();
  }
});

test('PATCH /:id: classifying and publishing in the same request is evaluated against the new tags', async () => {
  const { calls, restore } = mockPool([
    ['SELECT id, type FROM items WHERE id', () => ({ rows: [{ id: 12, type: '뉴스' }] })],
    // setTags() issues DELETE then INSERT for sectors/usages — none of
    // that needs real persistence here, only that hasValidClassification
    // is checked with the "tags now exist" answer, proving the route
    // evaluates classification after applying this request's own tags.
    ['SELECT EXISTS', () => ({ rows: [{ has_sector: true, has_usage: true }] })],
    ['FROM items i', () => ({ rows: [itemRow({ id: 12, status: 'Published' })] })],
  ]);
  try {
    await withServer(async (base) => {
      const res = await fetch(`${base}/12`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status: 'Published', sector_ids: [3], usage_ids: [7] }),
      });
      assert.equal(res.status, 200);
      assert.ok(calls.some((c) => c.text.includes('INSERT INTO item_sectors') && c.text.includes('(12, 3)')));
      assert.ok(calls.some((c) => c.text.includes('INSERT INTO item_usages') && c.text.includes('(12, 7)')));
      assert.ok(calls.some((c) => c.text.includes('UPDATE items SET') && c.text.includes('status')));
    });
  } finally {
    restore();
  }
});

test('PATCH /:id: a non-publish update (e.g. editing the title) is never gated by the classification check', async () => {
  const { calls, restore } = mockPool([
    ['SELECT id, type FROM items WHERE id', () => ({ rows: [{ id: 13, type: '뉴스' }] })],
    ['FROM items i', () => ({ rows: [itemRow({ id: 13, title: 'New title' })] })],
  ]);
  try {
    await withServer(async (base) => {
      const res = await fetch(`${base}/13`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'New title' }),
      });
      assert.equal(res.status, 200);
      assert.ok(!calls.some((c) => c.text.includes('SELECT EXISTS')), 'classification check should not run when status is not being set to Published');
    });
  } finally {
    restore();
  }
});

test('GET /: a category query param filters on content_category, same clause style as status/sector', async () => {
  const { calls, restore } = mockPool([
    ['FROM items i', () => ({ rows: [] })],
  ]);
  try {
    await withServer(async (base) => {
      const res = await fetch(`${base}?status=Published&category=daily_report`);
      assert.equal(res.status, 200);
      const listCall = calls.find((c) => c.text.includes('FROM items i'));
      assert.ok(listCall);
      assert.match(listCall.text, /i\.content_category = \$\d/);
      assert.ok(listCall.params.includes('daily_report'));
    });
  } finally {
    restore();
  }
});

test('PATCH /:id: returns 404 for a nonexistent item without running the classification check', async () => {
  const { calls, restore } = mockPool([
    ['SELECT id, type FROM items WHERE id', () => ({ rows: [] })],
  ]);
  try {
    await withServer(async (base) => {
      const res = await fetch(`${base}/999`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status: 'Published' }),
      });
      assert.equal(res.status, 404);
      assert.ok(!calls.some((c) => c.text.includes('SELECT EXISTS')));
    });
  } finally {
    restore();
  }
});

// Production incident: a duplicate source_url hit idx_items_source_url_unique
// as an unhandled pg error, which crashed the whole Node process (not just
// this request) — every other request then got a 502 "Application failed
// to respond" until the container restarted. Registering the same URL twice
// (e.g. retrying "AI 초안 작성" after an earlier attempt already saved it) is
// routine and must stay a normal 409, never take the app down.
test('POST /: a duplicate source_url returns 409 instead of throwing (crashing the process)', async () => {
  const { calls, restore } = mockPool([
    ['INSERT INTO items', () => {
      const err = new Error('duplicate key value violates unique constraint "idx_items_source_url_unique"');
      err.code = '23505';
      throw err;
    }],
  ]);
  try {
    await withServer(async (base) => {
      const res = await fetch(base, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'Dup', source_url: 'https://example.org/already-saved', type: '뉴스' }),
      });
      assert.equal(res.status, 409);
      const body = await res.json();
      assert.match(body.error, /이미 등록된/);
      assert.ok(!calls.some((c) => c.text.includes('SELECT') && c.text.includes('item_sectors')), 'must not proceed to tagging after the insert failed');
    });
  } finally {
    restore();
  }
});

test('POST /: a non-constraint insert failure returns 500 instead of crashing the process', async () => {
  const { restore } = mockPool([
    ['INSERT INTO items', () => { throw new Error('connection terminated unexpectedly'); }],
  ]);
  try {
    await withServer(async (base) => {
      const res = await fetch(base, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'X', source_url: 'https://example.org/x', type: '뉴스' }),
      });
      assert.equal(res.status, 500);
    });
  } finally {
    restore();
  }
});

// Re-extraction on regenerate: a retry/regenerate for an item collected
// automatically (no client-side extracted_text to send, unlike the manual-
// registration form) should still get the fuller <p> body text rather than
// being stuck on whatever thin summary was stored at collection time —
// same principle, applied uniformly regardless of how the item arrived.
function mockExternalFetch(externalHandler) {
  const original = global.fetch;
  global.fetch = async (url, ...rest) => {
    if (String(url).includes('127.0.0.1')) return original(url, ...rest);
    return externalHandler(url, ...rest);
  };
  return () => { global.fetch = original; };
}

function withoutFreeLlmApiKey(fn) {
  const prev = process.env.FREELLMAPI_API_KEY;
  delete process.env.FREELLMAPI_API_KEY;
  return Promise.resolve().then(fn).finally(() => {
    if (prev !== undefined) process.env.FREELLMAPI_API_KEY = prev;
  });
}

test('POST /:id/ai-draft: re-extracts body text from item.source_url when no extracted_text is given', () => withoutFreeLlmApiKey(async () => {
  const { restore } = mockPool([
    ['SELECT id, status, ai_status, source_url FROM items WHERE id', () => ({ rows: [{ id: 20, status: 'Draft', ai_status: 'not_requested', source_url: 'https://example.org/article' }] })],
    ['FROM items i', () => ({ rows: [itemRow({ id: 20 })] })],
  ]);
  let fetchedUrl;
  const restoreFetch = mockExternalFetch(async (url) => {
    fetchedUrl = url;
    return {
      ok: true,
      status: 200,
      text: async () => '<html><head><title>t</title></head><body><p>' + 'A'.repeat(60) + '</p></body></html>',
    };
  });
  try {
    await withServer(async (base) => {
      const res = await fetch(`${base}/20/ai-draft`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      assert.equal(res.status, 200);
      assert.equal(fetchedUrl, 'https://example.org/article');
    });
  } finally {
    restoreFetch();
    restore();
  }
}));

test('POST /:id/ai-draft: skips re-extraction when extracted_text is already provided in the request', () => withoutFreeLlmApiKey(async () => {
  const { restore } = mockPool([
    ['SELECT id, status, ai_status, source_url FROM items WHERE id', () => ({ rows: [{ id: 21, status: 'Draft', ai_status: 'not_requested', source_url: 'https://example.org/article' }] })],
    ['FROM items i', () => ({ rows: [itemRow({ id: 21 })] })],
  ]);
  let externalFetchCalled = false;
  const restoreFetch = mockExternalFetch(async () => { externalFetchCalled = true; return { ok: true, status: 200, text: async () => '<html></html>' }; });
  try {
    await withServer(async (base) => {
      const res = await fetch(`${base}/21/ai-draft`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ extracted_text: 'already have the body text client-side' }),
      });
      assert.equal(res.status, 200);
      assert.equal(externalFetchCalled, false, 'must not re-fetch when extracted_text was already sent');
    });
  } finally {
    restoreFetch();
    restore();
  }
}));
