// src/data/eventsProxy.test.mjs
// Offline tests for the `/api/events` GDELT proxy. The real middleware is
// installed into a fake stack and driven with a stubbed `globalThis.fetch`, so
// the ZIP reader, slice ring, backfill, cache, budget, stale-serve, and error
// sanitization are all exercised end to end with NO NETWORK. Upstream bodies
// come from the committed archives under src/data/fixtures/.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import { deflateRawSync } from 'node:zlib';

// The proxy resolves `.gev-cache/` from process.cwd() when the plugin factory
// runs. Move to a throwaway directory BEFORE building the config so no test
// writes a cache or budget file into the repo. `node --test` gives each test
// file its own child process, so this cannot leak into another file.
const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
process.chdir(mkdtempSync(path.join(os.tmpdir(), 'gev-events-proxy-')));

const createViteConfig = (await import('../../vite.config.js')).default;
const {
  GDELT_DEFAULT_DAILY_BUDGET,
  GDELT_DEFAULT_MAX_EVENTS,
  GDELT_EXPORT_BASE,
  GDELT_MAX_INFLATED_BYTES,
  GDELT_MAX_ZIP_BYTES,
  GDELT_MIN_REQUEST_SPACING_MS,
  GDELT_WINDOW_SLICES,
  readZipEntry,
} = await import('../../vite.config.js');

const archive = (name) => readFileSync(path.join(FIXTURES, name));
const SLICE_ZIP = archive('gdelt-export-slice.export.CSV.zip');
const DATADESC_ZIP = archive('gdelt-export-datadesc.export.CSV.zip');
const SAMPLE_TSV = readFileSync(path.join(FIXTURES, 'gdelt-export-sample.tsv'), 'utf8');

const NEWEST = '20260829004500';
// The GKG size is MEASURED: 5,336,697 bytes for the same window whose export is
// ~67 KB, i.e. 79x larger. An earlier revision of this file carried an invented
// figure here, and the real one matters because it is the number any "join the
// GKG for article headlines" proposal has to justify — see docs/ROADMAP.md.
// The export size matches the ~67 KB measured in docs/PHASE1-DECISIONS.md §6.
// The mentions size is a placeholder: nothing reads it, and it has never been
// measured — do not cite it.
const lastUpdateBody = (slice = NEWEST) => [
  `229194 aaaa ${GDELT_EXPORT_BASE}${slice}.mentions.CSV.zip`,
  `67421 bbbb ${GDELT_EXPORT_BASE}${slice}.export.CSV.zip`,
  `5336697 cccc ${GDELT_EXPORT_BASE}${slice}.gkg.csv.zip`,
].join('\n');

/**
 * The most recently built proxy, so `afterEach` can settle its background
 * backfill. A fire-and-forget pass that outlives its test would otherwise keep
 * fetching after `withUpstream` restored the real `globalThis.fetch` — hitting
 * the network for real and recording its calls against the NEXT test's stub.
 */
let liveProxy = null;

function freshProxy() {
  process.chdir(mkdtempSync(path.join(os.tmpdir(), 'gev-events-proxy-')));
  const config = createViteConfig({ mode: 'test' });
  const plugin = config.plugins.find((entry) => entry.name === 'gdelt-events-proxy');
  const handlers = [];
  plugin.configureServer({ middlewares: { use: (route, handler) => handlers.push([route, handler]) } });
  const [route, handler] = handlers[0];
  liveProxy = plugin;
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

const textOk = (body) => ({
  ok: true,
  status: 200,
  headers: new Headers(),
  text: async () => body,
  body: null,
});

const zipOk = (buffer) => ({
  ok: true,
  status: 200,
  headers: new Headers({ 'content-length': String(buffer.byteLength) }),
  arrayBuffer: async () => buffer.buffer.slice(
    buffer.byteOffset, buffer.byteOffset + buffer.byteLength,
  ),
});

const httpError = (status) => ({
  ok: false,
  status,
  headers: new Headers(),
  text: async () => 'upstream detail that must never be echoed',
  arrayBuffer: async () => new ArrayBuffer(0),
});

/**
 * Stub `globalThis.fetch` for the duration of `run`, recording every upstream
 * URL. `respond` receives the request index and the URL.
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

/** Serve lastupdate.txt plus the newest slice; every other slice 404s. */
const singleSlice = (index, url) => {
  if (url.endsWith('lastupdate.txt')) return textOk(lastUpdateBody());
  if (url.endsWith(`${NEWEST}.export.CSV.zip`)) return zipOk(SLICE_ZIP);
  return httpError(404);
};

const get = (handler, url = '/') => {
  const res = fakeRes();
  return handler({ method: 'GET', url }, res).then(() => res);
};

test.before(() => {
  // Remove the courtesy spacing so a backfill pass does not take a minute.
  process.env.GDELT_MIN_REQUEST_SPACING_MS = '0';
});

test.beforeEach(() => {
  delete process.env.GDELT_DAILY_REQUEST_BUDGET;
  delete process.env.GDELT_EVENTS_MAX_POINTS;
  // A one-slice ring by default, so no background backfill runs and each test
  // sees exactly the upstream calls it caused. The ring tests opt in.
  process.env.GDELT_WINDOW_SLICES = '1';
  liveProxy = null;
});

test.afterEach(async () => {
  await liveProxy?.__testing?.settled();
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

test('the tuning constants stay within their stated headroom', () => {
  assert.equal(GDELT_WINDOW_SLICES, 16, '4 h at 15 min a slice');
  assert.equal(GDELT_DEFAULT_MAX_EVENTS, 750);
  assert.equal(GDELT_MIN_REQUEST_SPACING_MS, 5_000);
  // Steady state is 96 slice fetches a day plus backfill.
  assert.ok(GDELT_DEFAULT_DAILY_BUDGET > 96 * 2);
  // A slice is ~67 KB zipped, ~400 KB inflated.
  assert.ok(GDELT_MAX_ZIP_BYTES > 67_000 * 10);
  assert.ok(GDELT_MAX_INFLATED_BYTES > 400_000 * 10);
  assert.ok(GDELT_MAX_INFLATED_BYTES > GDELT_MAX_ZIP_BYTES);
});

// ── The ZIP reader ──────────────────────────────────────────────────────────

test('the ZIP reader recovers the exact bytes of a standard archive', () => {
  const text = readZipEntry(SLICE_ZIP).toString('utf8');
  assert.equal(text, SAMPLE_TSV);
  assert.equal(text.split('\n').filter(Boolean).length, 209);
});

// The case the migration plan flagged as the container risk. A streamed writer
// cannot seek back to fill in the sizes, so it sets general-purpose bit 3 and
// zeroes them in the local header. A reader that trusts the local header
// inflates nothing and reports an EMPTY FILE — a silent wrong answer.
test('the ZIP reader handles the data-descriptor case via the central directory', () => {
  assert.equal(DATADESC_ZIP.readUInt16LE(6) & 0x08, 0x08, 'fixture really has bit 3 set');
  assert.equal(DATADESC_ZIP.readUInt32LE(18), 0, 'and a zeroed local-header size');

  const text = readZipEntry(DATADESC_ZIP).toString('utf8');
  assert.ok(text.length > 0, 'not silently empty');
  const rows = text.split('\n').filter(Boolean);
  assert.equal(rows.length, 3);
  for (const row of rows) assert.equal(row.split('\t').length, 61);
});

test('the ZIP reader refuses a truncated archive rather than returning partial rows', () => {
  assert.throws(() => readZipEntry(SLICE_ZIP.subarray(0, 200)), /truncated|central directory/i);
  assert.throws(() => readZipEntry(Buffer.alloc(10)), /not a zip archive/);
  assert.throws(() => readZipEntry(Buffer.alloc(200)), /not a zip archive/);
});

test('the ZIP reader caps inflation rather than trusting the declared size', () => {
  // Declared size over the cap is refused before any inflate work happens.
  assert.throws(
    () => readZipEntry(SLICE_ZIP, { maxInflatedBytes: 1024 }),
    (err) => err.code === 'RESPONSE_TOO_LARGE',
  );

  // And a header that LIES about being small cannot exhaust memory: the cap is
  // enforced on what inflate actually produces, not on what it promised.
  const bomb = Buffer.alloc(1024 * 1024); // compresses to almost nothing
  const deflated = deflateRawSync(bomb);
  const name = Buffer.from('x');
  const local = Buffer.alloc(30 + name.length);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(0, 6);            // no data descriptor
  local.writeUInt16LE(8, 8);            // deflate
  local.writeUInt32LE(deflated.length, 18);
  local.writeUInt32LE(4096, 22);        // lies: claims 4 KB, really 1 MB
  local.writeUInt16LE(name.length, 26);
  name.copy(local, 30);
  assert.throws(
    () => readZipEntry(Buffer.concat([local, deflated]), { maxInflatedBytes: 8192 }),
    /maxOutputLength|too large|buffer/i,
  );
});

// ── Happy path ──────────────────────────────────────────────────────────────

test('a cold request reads lastupdate.txt, then the slice it names', async () => {
  const { handler } = freshProxy();
  await withUpstream(singleSlice, async (urls) => {
    const res = await get(handler);
    assert.equal(res.status, 200);
    // The newest slice URL is DISCOVERED, never built from the local clock —
    // GDELT's publish time drifts and a hand-built "now" URL 404s routinely.
    assert.ok(urls[0].endsWith('lastupdate.txt'), `first call is the pointer: ${urls[0]}`);
    assert.ok(urls[1].endsWith(`${NEWEST}.export.CSV.zip`), `then the slice: ${urls[1]}`);

    const body = res.body;
    assert.equal(body.stale, false);
    assert.equal(body.sliceCount, 1);
    assert.equal(body.windowFrom, NEWEST);
    assert.equal(body.windowTo, NEWEST);
    assert.ok(body.count > 0);
    assert.equal(body.count, body.events.length);
    assert.equal(body.severityModel, 'cameo-intensity');
  });
});

test('the served window is reduced server-side and reports its funnel', async () => {
  const { handler } = freshProxy();
  await withUpstream(singleSlice, async () => {
    const { funnel, events, count } = (await get(handler)).body;
    // 209 rows in, city-precision only, then deduped by article and place.
    assert.equal(funnel.total, 209);
    assert.equal(funnel.no_geo, 10);
    assert.equal(funnel.low_precision, 75);
    assert.equal(funnel.retained, 91);
    assert.equal(count, 91);
    assert.ok(count <= GDELT_DEFAULT_MAX_EVENTS);

    // Ranked most-severe-first, so a cap keeps the top of the ranking.
    for (let i = 1; i < events.length; i += 1) {
      assert.ok(events[i - 1].severity >= events[i].severity);
    }
    // Every served record is renderable: a coordinate, a category, a source.
    for (const event of events) {
      assert.ok(Number.isFinite(event.lat) && Number.isFinite(event.lon));
      assert.ok(event.category);
      assert.match(event.url, /^https?:\/\//);
    }
  });
});

test('the payload cap is env-tunable and applied after ranking', async () => {
  process.env.GDELT_EVENTS_MAX_POINTS = '5';
  const { handler } = freshProxy();
  await withUpstream(singleSlice, async () => {
    const body = (await get(handler)).body;
    assert.equal(body.count, 5);
    assert.equal(body.funnel.retained, 91, 'the funnel still reports what was retained');
  });
});

test('a warm cache serves without touching upstream again', async () => {
  const { handler } = freshProxy();
  await withUpstream(singleSlice, async (urls) => {
    await get(handler);
    const before = urls.length;
    const res = await get(handler);
    assert.equal(res.status, 200);
    assert.equal(res.body.stale, false);
    assert.equal(urls.length, before, 'no further upstream calls');
  });
});

test('concurrent cold requests share one upstream pass (single-flight)', async () => {
  const { handler } = freshProxy();
  await withUpstream(singleSlice, async (urls) => {
    const [a, b, c] = await Promise.all([get(handler), get(handler), get(handler)]);
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    assert.equal(c.status, 200);
    assert.equal(urls.filter((url) => url.endsWith('lastupdate.txt')).length, 1);
  });
});

// ── The slice ring ──────────────────────────────────────────────────────────

test('the ring deepens backwards in the background, one slice at a time', async () => {
  process.env.GDELT_WINDOW_SLICES = '4';
  const { plugin, handler } = freshProxy();
  await withUpstream((index, url) => {
    if (url.endsWith('lastupdate.txt')) return textOk(lastUpdateBody());
    if (url.endsWith('.export.CSV.zip')) return zipOk(SLICE_ZIP);
    return httpError(404);
  }, async () => {
    const res = await get(handler);
    // The FIRST response is served from the newest slice alone: a cold start
    // must not wait out a multi-minute walk backwards.
    assert.equal(res.body.sliceCount, 1);

    await plugin.__testing.settled();
    // Backwards from 00:45 in 15-minute steps, to the configured depth.
    assert.deepEqual(plugin.__testing.sliceKeys(), [
      '20260829000000', '20260829001500', '20260829003000', '20260829004500',
    ]);
  });
});

test('a skipped publish window is a recorded gap, not a stall', async () => {
  process.env.GDELT_WINDOW_SLICES = '4';
  const { plugin, handler } = freshProxy();
  await withUpstream((index, url) => {
    if (url.endsWith('lastupdate.txt')) return textOk(lastUpdateBody());
    // GDELT occasionally skips a window; the walk must step past it.
    if (url.endsWith('20260829003000.export.CSV.zip')) return httpError(404);
    if (url.endsWith('.export.CSV.zip')) return zipOk(SLICE_ZIP);
    return httpError(404);
  }, async () => {
    await get(handler);
    await plugin.__testing.settled();
    assert.deepEqual(plugin.__testing.gaps(), ['20260829003000']);
    // The walk continued past the hole rather than stopping at it — but it
    // does NOT reach further back to make up the missing slice. The window is
    // a span of time, not a quota of files: a quarter hour GDELT never
    // published has no events, and silently extending into an earlier hour to
    // fill the count would misreport how much of the window is covered.
    assert.deepEqual(plugin.__testing.sliceKeys(), [
      '20260829000000', '20260829001500', '20260829004500',
    ]);
  });
});

test('slices already held are never refetched', async () => {
  process.env.GDELT_WINDOW_SLICES = '2';
  const { plugin, handler } = freshProxy();
  await withUpstream((index, url) => {
    if (url.endsWith('lastupdate.txt')) return textOk(lastUpdateBody());
    if (url.endsWith('.export.CSV.zip')) return zipOk(SLICE_ZIP);
    return httpError(404);
  }, async (urls) => {
    await get(handler);
    await plugin.__testing.settled();
    const sliceCalls = urls.filter((url) => url.endsWith('.export.CSV.zip'));
    assert.equal(sliceCalls.length, 2);
    assert.equal(new Set(sliceCalls).size, 2, 'each slice fetched exactly once');
  });
});

// ── Failure handling ────────────────────────────────────────────────────────

test('a total upstream failure with no cache returns a sanitized 502', async () => {
  const { handler } = freshProxy();
  await withUpstream(() => httpError(503), async () => {
    const res = await get(handler);
    assert.equal(res.status, 502);
    assert.deepEqual(res.body, { error: 'events fetch failed and no cache available' });
    assert.ok(!res.raw.includes('503'), 'no upstream status leaks');
    assert.ok(!res.raw.includes('must never be echoed'), 'no upstream body leaks');
    assert.ok(!res.raw.includes('gdeltproject'), 'no upstream URL leaks');
  });
});

test('an upstream outage after a good fetch serves the stale cache, not an error', async () => {
  const { handler } = freshProxy();
  await withUpstream(singleSlice, async () => {
    assert.equal((await get(handler)).status, 200);
  });
  // Age the cache past its TTL, then take upstream away entirely.
  const realNow = Date.now;
  Date.now = () => realNow() + 20 * 60_000;
  try {
    await withUpstream(() => { throw new Error('connection reset'); }, async () => {
      const res = await get(handler);
      assert.equal(res.status, 200, 'stale beats empty');
      assert.equal(res.body.stale, true);
      assert.ok(res.body.count > 0);
    });
  } finally {
    Date.now = realNow;
  }
});

test('a corrupt archive is a failure, never cached as an empty window', async () => {
  const { handler } = freshProxy();
  await withUpstream((index, url) => {
    if (url.endsWith('lastupdate.txt')) return textOk(lastUpdateBody());
    return zipOk(Buffer.from('this is not a zip file at all'));
  }, async () => {
    const res = await get(handler);
    assert.equal(res.status, 502, 'an unreadable slice is not zero events');
    assert.ok(!res.raw.includes('zip'), 'no parser detail leaks');
  });
});

test('an unusable lastupdate pointer fails rather than guessing a URL', async () => {
  const { handler } = freshProxy();
  await withUpstream((index, url) => {
    if (url.endsWith('lastupdate.txt')) return textOk('nothing useful here');
    return zipOk(SLICE_ZIP);
  }, async (urls) => {
    assert.equal((await get(handler)).status, 502);
    assert.equal(urls.filter((url) => url.endsWith('.zip')).length, 0, 'no slice was guessed at');
  });
});

test('an oversized archive is refused before it is inflated', async () => {
  const { handler } = freshProxy();
  await withUpstream((index, url) => {
    if (url.endsWith('lastupdate.txt')) return textOk(lastUpdateBody());
    return {
      ok: true,
      status: 200,
      headers: new Headers({ 'content-length': String(GDELT_MAX_ZIP_BYTES + 1) }),
      arrayBuffer: async () => { throw new Error('body must not be read'); },
    };
  }, async () => {
    assert.equal((await get(handler)).status, 502);
  });
});

test('a non-GET request is refused', async () => {
  const { handler } = freshProxy();
  const res = fakeRes();
  await handler({ method: 'POST', url: '/' }, res);
  assert.equal(res.status, 405);
  assert.deepEqual(res.body, { error: 'method not allowed' });
});

// ── Budget ──────────────────────────────────────────────────────────────────

test('an exhausted daily budget serves cache rather than an unbudgeted fetch', async () => {
  process.env.GDELT_DAILY_REQUEST_BUDGET = '2';
  const { handler } = freshProxy();
  await withUpstream(singleSlice, async (urls) => {
    assert.equal((await get(handler)).status, 200);
    const spent = urls.length;
    const realNow = Date.now;
    Date.now = () => realNow() + 20 * 60_000;
    try {
      const res = await get(handler);
      assert.equal(res.status, 200);
      assert.equal(res.body.stale, true, 'cache beats a dead layer');
      assert.equal(urls.length, spent, 'and no further upstream calls');
    } finally {
      Date.now = realNow;
    }
  });
});

test('over budget with no cache at all is an honest 429', async () => {
  process.env.GDELT_DAILY_REQUEST_BUDGET = '1';
  const { handler } = freshProxy();
  await withUpstream(() => httpError(500), async () => {
    await get(handler); // spends the budget and caches nothing
    const res = await get(handler);
    assert.equal(res.status, 429);
    assert.deepEqual(res.body, { error: 'budget' });
  });
});

// ── Status ──────────────────────────────────────────────────────────────────

test('/status reports window and budget state without touching upstream', async () => {
  const { handler } = freshProxy();
  await withUpstream(singleSlice, async (urls) => {
    await get(handler);
    const before = urls.length;
    const res = await get(handler, '/status');
    assert.equal(res.status, 200);
    assert.equal(urls.length, before, 'status never fetches');

    const body = res.body;
    assert.equal(body.stale, false);
    assert.equal(body.severityModel, 'cameo-intensity');
    assert.equal(body.windowSlices, 1, 'the depth this test configured');
    assert.equal(body.sliceCount, 1);
    assert.equal(body.windowTo, NEWEST);
    assert.ok(Array.isArray(body.gaps));
    assert.equal(body.budget.limit, GDELT_DEFAULT_DAILY_BUDGET);
    assert.ok(body.budget.count > 0, 'attempts are counted');
    assert.match(body.budget.date, /^\d{4}-\d{2}-\d{2}$/);
  });
});
