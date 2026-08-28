// src/data/eventsProxy.test.mjs
// Offline tests for the `/api/events` GDELT proxy. The real middleware is
// installed into a fake stack and driven with a stubbed `globalThis.fetch`, so
// cache, budget, stale-serve, and error sanitization are exercised end to end
// with NO NETWORK. Upstream bodies come from the committed fixtures under
// src/data/fixtures/ (documented GDELT shape, marked unverified there).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';

// The proxy resolves `.gev-cache/` from process.cwd() when the plugin factory
// runs. Move to a throwaway directory BEFORE building the config so no test
// writes a cache or budget file into the repo. `node --test` gives each test
// file its own child process, so this cannot leak into another file.
const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
process.chdir(mkdtempSync(path.join(os.tmpdir(), 'gev-events-proxy-')));

const createViteConfig = (await import('../../vite.config.js')).default;
const {
  GDELT_CATEGORY_MAX_POINTS,
  GDELT_DEFAULT_DAILY_BUDGET,
  GDELT_DEFAULT_MAX_POINTS,
  GDELT_DEFAULT_TIMESPAN,
  GDELT_MIN_REQUEST_SPACING_MS,
} = await import('../../vite.config.js');

const fixture = (name) => readFileSync(path.join(FIXTURES, name), 'utf8');
const CONFLICT_BODY = fixture('gdelt-geo-conflict-sample.json');
const DISASTER_BODY = fixture('gdelt-geo-disaster-sample.json');
const EMPTY_BODY = fixture('gdelt-geo-empty.json');

/**
 * Build a fresh, isolated proxy instance with its own cache and budget state.
 *
 * Each instance gets its OWN temp cwd: the plugin resolves `.gev-cache/` once,
 * at creation, so without this a "cold" test would find the disk cache a
 * previous test wrote and never reach upstream at all.
 */
function freshProxy() {
  process.chdir(mkdtempSync(path.join(os.tmpdir(), 'gev-events-proxy-')));
  const config = createViteConfig({ mode: 'test' });
  const plugin = config.plugins.find((entry) => entry.name === 'gdelt-events-proxy');
  const handlers = [];
  plugin.configureServer({ middlewares: { use: (route, handler) => handlers.push([route, handler]) } });
  const [route, handler] = handlers[0];
  return { plugin, route, handler };
}

/** Minimal ServerResponse double capturing status, headers, and parsed body. */
function fakeRes() {
  return {
    headersSent: false,
    status: null,
    headers: null,
    raw: '',
    get body() { return this.raw ? JSON.parse(this.raw) : null; },
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers;
      this.headersSent = true;
    },
    end(chunk) { this.raw = String(chunk ?? ''); },
  };
}

const upstreamOk = (body) => ({
  ok: true,
  status: 200,
  headers: new Headers(),
  text: async () => body,
});

/**
 * Stub `globalThis.fetch` for the duration of `run`, recording every upstream
 * URL. `respond` receives the request index and returns a Response double or
 * throws to simulate an upstream failure.
 */
async function withUpstream(respond, run) {
  const original = globalThis.fetch;
  const urls = [];
  globalThis.fetch = async (url) => {
    const index = urls.length;
    urls.push(String(url));
    return respond(index, String(url));
  };
  try {
    return await run(urls);
  } finally {
    globalThis.fetch = original;
  }
}

const get = (handler, url = '/') => {
  const res = fakeRes();
  return handler({ method: 'GET', url }, res).then(() => res);
};

// Category order matches EVENT_CATEGORIES; index 0 is conflict, 4 is disaster.
const bodyForIndex = (index) => (index === 0 ? CONFLICT_BODY : index === 4 ? DISASTER_BODY : EMPTY_BODY);

test.before(() => {
  // Remove the courtesy spacing so a five-category refresh does not take 20 s.
  process.env.GDELT_MIN_REQUEST_SPACING_MS = '0';
});

test.beforeEach(() => {
  delete process.env.GDELT_DAILY_REQUEST_BUDGET;
  delete process.env.GDELT_EVENTS_TIMESPAN;
  delete process.env.GDELT_EVENTS_MAX_POINTS;
});

// ── Wiring ──────────────────────────────────────────────────────────────────

test('the events proxy installs /api/events on both the dev and preview servers', () => {
  const config = createViteConfig({ mode: 'test' });
  const plugin = config.plugins.find((entry) => entry.name === 'gdelt-events-proxy');
  assert.ok(plugin, 'the plugin is registered');
  assert.equal(typeof plugin.configureServer, 'function', 'dev hook');
  assert.equal(typeof plugin.configurePreviewServer, 'function', 'preview hook');
  assert.equal(freshProxy().route, '/api/events');
});

test('point caps rank per category only; the merged cap is a payload guard', () => {
  // The per-category cap is what preserves depth under a category filter. A
  // merged cap that ranked across categories would let a high-volume feed
  // starve a quiet one, so it is deliberately larger and applied after dedupe.
  assert.equal(GDELT_CATEGORY_MAX_POINTS, 150);
  assert.equal(GDELT_DEFAULT_MAX_POINTS, 750);
  assert.ok(GDELT_DEFAULT_MAX_POINTS >= GDELT_CATEGORY_MAX_POINTS * 5);
  assert.equal(GDELT_DEFAULT_TIMESPAN, '24h');
  assert.equal(GDELT_MIN_REQUEST_SPACING_MS, 5_000);
  // Worst case is 5 categories x 96 refreshes/day = 480.
  assert.ok(GDELT_DEFAULT_DAILY_BUDGET > 480 * 2);
});

// ── Happy path ──────────────────────────────────────────────────────────────

test('a cold request fetches every category sequentially and serves merged events', async () => {
  const { handler } = freshProxy();
  await withUpstream((index) => upstreamOk(bodyForIndex(index)), async (urls) => {
    const res = await get(handler);
    assert.equal(res.status, 200);
    assert.equal(res.headers['Cache-Control'], 'no-store');
    assert.equal(urls.length, 5, 'one upstream request per category');
    for (const url of urls) {
      assert.ok(url.startsWith('https://api.gdeltproject.org/api/v2/geo/geo?'));
      assert.ok(url.includes('format=GeoJSON'));
      assert.ok(url.includes('mode=PointData'));
      assert.ok(url.includes('timespan=24h'));
    }

    const payload = res.body;
    assert.equal(payload.stale, false);
    assert.equal(payload.severityModel, 'coverage-index');
    assert.equal(payload.timespan, '24h');
    assert.equal(payload.categories.length, 5);
    assert.ok(payload.categories.every((entry) => entry.ok === true));
    assert.equal(payload.count, payload.events.length);
    assert.ok(payload.count > 0);

    const kharkiv = payload.events.find((event) => event.id === 'evt:49.981,36.230');
    assert.deepEqual(kharkiv.categories, ['conflict', 'disaster'], 'cross-category dedupe');
    assert.ok(kharkiv.byCategory.conflict.articles.length > 0);
  });
});

test('the served payload carries structured article rows and never raw upstream HTML', async () => {
  const { handler } = freshProxy();
  await withUpstream((index) => upstreamOk(bodyForIndex(index)), async () => {
    const res = await get(handler);
    const serialized = JSON.stringify(res.body);
    assert.ok(!serialized.includes('<a href'), 'no anchor markup reaches the client');
    assert.ok(!serialized.includes('<br'), 'no markup at all');
    assert.ok(!serialized.includes('shareimage'), 'unused upstream fields are dropped');
    const [event] = res.body.events;
    for (const detail of Object.values(event.byCategory)) {
      for (const article of detail.articles) {
        assert.ok(article.url.startsWith('https://'));
        assert.equal(typeof article.title, 'string');
        assert.equal(typeof article.domain, 'string');
      }
    }
  });
});

test('a warm cache serves without touching upstream again', async () => {
  const { handler } = freshProxy();
  await withUpstream((index) => upstreamOk(bodyForIndex(index)), async (urls) => {
    await get(handler);
    assert.equal(urls.length, 5);
    const second = await get(handler);
    assert.equal(second.status, 200);
    assert.equal(second.body.stale, false);
    assert.equal(urls.length, 5, 'the second request is a pure cache hit');
  });
});

test('concurrent cold requests share one upstream pass (single-flight)', async () => {
  const { handler } = freshProxy();
  await withUpstream((index) => upstreamOk(bodyForIndex(index)), async (urls) => {
    const [a, b, c] = await Promise.all([get(handler), get(handler), get(handler)]);
    assert.equal(urls.length, 5, 'three callers, one refresh');
    for (const res of [a, b, c]) assert.equal(res.status, 200);
    assert.deepEqual(a.body.events, b.body.events);
  });
});

test('the timespan is env-tunable and rejects a malformed value', async () => {
  process.env.GDELT_EVENTS_TIMESPAN = '3d';
  await withUpstream((index) => upstreamOk(bodyForIndex(index)), async (urls) => {
    await get(freshProxy().handler);
    assert.ok(urls.every((url) => url.includes('timespan=3d')));
  });
  process.env.GDELT_EVENTS_TIMESPAN = 'not a timespan';
  await withUpstream((index) => upstreamOk(bodyForIndex(index)), async (urls) => {
    await get(freshProxy().handler);
    assert.ok(urls.every((url) => url.includes('timespan=24h')), 'falls back to the default');
  });
});

// ── Failure handling ────────────────────────────────────────────────────────

test('a partial category failure still serves, with the failed categories marked', async () => {
  const { handler } = freshProxy();
  await withUpstream((index) => {
    if (index === 4) throw new Error('upstream exploded with secret detail');
    return upstreamOk(bodyForIndex(index));
  }, async () => {
    const res = await get(handler);
    assert.equal(res.status, 200, 'one failed category does not fail the request');
    const failed = res.body.categories.filter((entry) => entry.ok === false);
    assert.equal(failed.length, 1);
    assert.equal(failed[0].category, 'disaster');
    assert.ok(!JSON.stringify(res.body).includes('secret detail'));
  });
});

test('a total upstream failure with no cache returns a sanitized 502', async () => {
  const { handler } = freshProxy();
  await withUpstream(() => { throw new Error('ECONNREFUSED 10.0.0.1:443 internal detail'); }, async () => {
    const res = await get(handler);
    assert.equal(res.status, 502);
    assert.deepEqual(res.body, { error: 'events fetch failed and no cache available' });
    assert.ok(!res.raw.includes('ECONNREFUSED'), 'no upstream error text');
    assert.ok(!res.raw.includes('10.0.0.1'), 'no internal address');
    assert.ok(!res.raw.includes('gdeltproject'), 'no upstream URL');
  });
});

test('an upstream outage after a good fetch serves the stale cache, not an error', async () => {
  const { handler } = freshProxy();
  let fresh = null;
  await withUpstream((index) => upstreamOk(bodyForIndex(index)), async () => {
    fresh = (await get(handler)).body;
  });
  // Age the cache past its TTL, then break upstream entirely.
  const realNow = Date.now;
  Date.now = () => realNow() + 16 * 60_000;
  try {
    await withUpstream(() => { throw new Error('upstream down'); }, async () => {
      const res = await get(handler);
      assert.equal(res.status, 200, 'stale beats empty');
      assert.equal(res.body.stale, true, 'staleness is reported honestly');
      assert.deepEqual(res.body.events, fresh.events);
    });
  } finally {
    Date.now = realNow;
  }
});

test('a non-JSON body is an upstream failure, never cached as an empty category', async () => {
  const { handler } = freshProxy();
  await withUpstream(() => upstreamOk('<html><body>GDELT is down</body></html>'), async () => {
    const res = await get(handler);
    assert.equal(res.status, 502, 'an HTML error page is not "no events"');
    assert.ok(!res.raw.includes('<html>'));
  });
});

test('a JSON body that is not GeoJSON is also treated as a failure', async () => {
  const { handler } = freshProxy();
  await withUpstream(() => upstreamOk(fixture('gdelt-geo-malformed.json')), async () => {
    assert.equal((await get(handler)).status, 502);
  });
});

test('an upstream HTTP error is a category failure with no status leakage', async () => {
  const { handler } = freshProxy();
  await withUpstream(() => ({
    ok: false,
    status: 403,
    headers: new Headers(),
    text: async () => 'Forbidden: key xyz',
  }), async () => {
    const res = await get(handler);
    assert.equal(res.status, 502);
    assert.ok(!res.raw.includes('403'));
    assert.ok(!res.raw.includes('xyz'));
  });
});

test('a non-GET request is refused', async () => {
  const { handler } = freshProxy();
  const res = fakeRes();
  await handler({ method: 'POST', url: '/' }, res);
  assert.equal(res.status, 405);
  assert.deepEqual(res.body, { error: 'method not allowed' });
});

// ── Budget governor ─────────────────────────────────────────────────────────

test('an exhausted daily budget returns 429 rather than an unbudgeted fetch', async () => {
  process.env.GDELT_DAILY_REQUEST_BUDGET = '3';
  const { handler } = freshProxy();
  await withUpstream((index) => upstreamOk(bodyForIndex(index)), async (urls) => {
    // The first refresh spends 5 against a limit of 3 (a soft cap: the pass in
    // flight is allowed to finish), which puts the next one over.
    await get(handler);
    assert.equal(urls.length, 5);
    const realNow = Date.now;
    Date.now = () => realNow() + 16 * 60_000; // expire the cache
    try {
      const res = await get(handler);
      assert.equal(res.status, 200, 'over budget with a cache serves the cache');
      assert.equal(res.body.stale, true);
      assert.equal(urls.length, 5, 'no further upstream requests are issued');
    } finally {
      Date.now = realNow;
    }
  });
});

test('over budget with no cache at all is an honest 429', async () => {
  process.env.GDELT_DAILY_REQUEST_BUDGET = '1';
  const { handler } = freshProxy();
  await withUpstream(() => { throw new Error('upstream down'); }, async (urls) => {
    await get(handler); // spends budget, fails, caches nothing
    const realNow = Date.now;
    Date.now = () => realNow() + 16 * 60_000;
    try {
      const res = await get(handler);
      assert.equal(res.status, 429);
      assert.deepEqual(res.body, { error: 'budget' });
      assert.equal(urls.length, 5, 'the second request never reaches upstream');
    } finally {
      Date.now = realNow;
    }
  });
});

// ── Status route ────────────────────────────────────────────────────────────

test('/status reports cache and budget state without touching upstream', async () => {
  const { handler } = freshProxy();
  const cold = await get(handler, '/status');
  assert.equal(cold.status, 200);
  assert.equal(cold.body.lastFetch, null);
  assert.equal(cold.body.count, null);
  assert.equal(cold.body.stale, false);
  assert.equal(cold.body.ttlMs, 900_000);
  assert.equal(cold.body.severityModel, 'coverage-index');
  assert.equal(cold.body.budget.limit, GDELT_DEFAULT_DAILY_BUDGET);
  assert.equal(cold.body.budget.count, 0);
  assert.match(cold.body.budget.date, /^\d{4}-\d{2}-\d{2}$/);

  await withUpstream((index) => upstreamOk(bodyForIndex(index)), async (urls) => {
    await get(handler);
    const warm = await get(handler, '/status');
    assert.ok(Number.isFinite(warm.body.lastFetch));
    assert.ok(warm.body.count > 0);
    assert.equal(warm.body.budget.count, 5, 'five upstream attempts counted');
    assert.equal(urls.length, 5, '/status itself never fetches');
  });
});
