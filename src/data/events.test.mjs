// src/data/events.test.mjs
// Lifecycle, abort, render-budget, filter, and click-through tests for the
// GDELT CAMEO political-events layer. NO NETWORK: `fetch` is stubbed with
// payloads assembled from the real export fixture under src/data/fixtures/,
// pushed through the same parser and classifier the proxy uses — so the record
// shape under test cannot drift from the one actually served.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import * as Cesium from 'cesium';
import {
  EVENTS_MAX_ENTITIES,
  EVENTS_OVERLAY_COHORT_LIMIT,
  EVENTS_OVERLAY_COLLISION_CAPACITY,
  createEventOverlayEntry,
  createEventsLayer,
  eventLabelText,
  mapAnalystRecord,
  selectEventOverlayCohort,
  shouldOpenEventSource,
} from './events.js';
import { classifyEventRecords } from './eventsFeed.js';
import { parseExportTsv } from './gdeltExport.js';
import { registerPickOwner, unregisterPickOwner } from './pickRegistry.js';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const SAMPLE = readFileSync(path.join(FIXTURES, 'gdelt-export-sample.tsv'), 'utf8');
const FIXTURE_EVENTS = classifyEventRecords(parseExportTsv(SAMPLE).records);
/** The highest-ranked fixture record — the one a click test can rely on. */
const TOP_EVENT = FIXTURE_EVENTS[0];

/** Build the `/api/events` payload the proxy would serve, from the fixture. */
function proxyPayload({ stale = false, sliceCount = 16, events = FIXTURE_EVENTS } = {}) {
  return {
    fetchedAt: 1_753_600_000_000,
    stale,
    ttlMs: 900_000,
    severityModel: 'cameo-intensity',
    windowSlices: 16,
    sliceCount,
    windowFrom: '20260829004500',
    windowTo: '20260829004500',
    gaps: [],
    funnel: { total: 209, retained: events.length },
    count: events.length,
    events,
  };
}

/** Minimal viewer double: data-source collection plus a stubbed scene pick. */
function fakeViewer({ pickResult = null } = {}) {
  const dataSources = [];
  return {
    dataSources,
    scene: {
      canvas: { id: 'canvas' },
      pick: () => pickResult,
    },
    _setPick(next) { this.scene.pick = () => next; },
    dataSourcesApi: {
      add(dataSource) { dataSources.push(dataSource); return dataSource; },
      remove(dataSource) {
        const index = dataSources.indexOf(dataSource);
        if (index >= 0) dataSources.splice(index, 1);
        return index >= 0;
      },
    },
  };
}

function viewerWithSources(options = {}) {
  const base = fakeViewer(options);
  const sources = [];
  base.dataSources = {
    add(dataSource) { sources.push(dataSource); return dataSource; },
    remove(dataSource) {
      const index = sources.indexOf(dataSource);
      if (index >= 0) sources.splice(index, 1);
      return index >= 0;
    },
  };
  base.sources = sources;
  return base;
}

function recordingHost() {
  const calls = [];
  return {
    calls,
    setEntries: (...args) => calls.push(['entries', ...args]),
    setVisible: (...args) => calls.push(['visible', ...args]),
    clearSource: (...args) => calls.push(['clear', ...args]),
  };
}

/**
 * Headless stand-in for `Cesium.ScreenSpaceEventHandler`, which registers DOM
 * listeners in its constructor and therefore needs a `document` node:test has
 * not got. Tests that exercise clicking use `clickHandlerFactory()` instead.
 */
const NOOP_HANDLER_FACTORY = () => ({ setInputAction() {}, destroy() {} });

/** Capture the LEFT_CLICK callback the layer installs. */
function clickHandlerFactory() {
  const state = { action: null, destroyed: false };
  return {
    state,
    factory: () => ({
      setInputAction(action) { state.action = action; },
      destroy() { state.destroyed = true; },
    }),
  };
}

function withFetch(impl, run) {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  return Promise.resolve(run()).finally(() => { globalThis.fetch = original; });
}

const okResponse = (payload) => ({ ok: true, status: 200, json: async () => payload });

// ── Pure helpers ────────────────────────────────────────────────────────────

test('event label prefers the leading place component and falls back to coordinates', () => {
  assert.equal(eventLabelText({ place: "Kharkiv, Kharkivs'ka Oblast', Ukraine" }), 'Kharkiv');
  assert.equal(eventLabelText({ place: '   ', lat: 49.98, lon: 36.23 }), '50.0, 36.2');
  assert.equal(eventLabelText({}), 'EVENT');
  assert.ok(eventLabelText({ place: 'x'.repeat(80) }).length <= 28);
});

test('overlay entry carries source-owned accent and a severity-ordered priority', () => {
  const position = Cesium.Cartesian3.fromDegrees(36.23, 49.98);
  const entry = createEventOverlayEntry({
    id: 'evt:1', position, title: 'Kharkiv', accent: '#ff4438', severity: 87,
  });
  assert.equal(entry.variant, 'label');
  assert.equal(entry.paintLane, 'ambient-label');
  assert.equal(entry.collisionGroup, 'ambient-label');
  assert.equal(entry.interactive, false);
  assert.equal(entry.position, position);
  assert.equal(entry.priority, 87_000);
  assert.equal(createEventOverlayEntry({ id: 'x', severity: undefined }).priority, 0);
});

test('overlay cohort keeps the highest priority and is bounded by the cohort limit', () => {
  const entries = Array.from({ length: EVENTS_OVERLAY_COHORT_LIMIT + 20 }, (_, index) => ({
    id: `evt-${String(index).padStart(3, '0')}`,
    priority: index,
  }));
  const cohort = selectEventOverlayCohort(entries);
  assert.equal(cohort.length, EVENTS_OVERLAY_COHORT_LIMIT);
  assert.equal(cohort[0].id, `evt-${String(EVENTS_OVERLAY_COHORT_LIMIT + 19).padStart(3, '0')}`);
  assert.equal(cohort.at(-1).id, 'evt-020');
  assert.deepEqual(selectEventOverlayCohort(null), []);
});

test('analyst record is JSON-safe with nulls instead of NaN or undefined', () => {
  const record = mapAnalystRecord({
    id: 'evt:49.981,36.230',
    category: 'conflict',
    place: 'Kharkiv',
    lat: 49.98,
    lon: 36.23,
    severity: 100,
    numArticles: 42,
    url: 'https://example-news.org/a/1',
    domain: 'example-news.org',
    rootCode: '19',
    countryFips: 'UP',
    retrospectiveDays: 0,
  }, 0);
  assert.equal(record.sourceUrl, 'https://example-news.org/a/1');
  assert.equal(record.sourceDomain, 'example-news.org');
  assert.equal(record.articleCount, 42);
  assert.equal(record.rootCode, '19');
  // FIPS is carried under a name that says so, so nothing downstream reads it
  // as ISO — UP is Ukraine here, and unassigned in ISO 3166.
  assert.equal(record.countryFips, 'UP');
  assert.deepEqual(JSON.parse(JSON.stringify(record)), record);

  const sparse = mapAnalystRecord({ severity: NaN, lat: undefined }, 7);
  assert.equal(sparse.id, 'EVENT-0007');
  assert.equal(sparse.severity, null);
  assert.equal(sparse.lat, null);
  assert.equal(sparse.sourceUrl, null);
  for (const [key, value] of Object.entries(sparse)) {
    assert.notEqual(value, undefined, `${key} must not be undefined`);
  }
});

test('click-through opens only on a repeat click of the selected record with a URL', () => {
  const record = { id: 'evt:1', url: 'https://example-news.org/a/1' };
  assert.equal(shouldOpenEventSource(null, record), false, 'first click selects');
  assert.equal(shouldOpenEventSource('evt:other', record), false);
  assert.equal(shouldOpenEventSource('evt:1', record), true);
  assert.equal(shouldOpenEventSource('evt:1', { id: 'evt:1' }), false);
  assert.equal(shouldOpenEventSource('evt:1', null), false);
});

// ── Lifecycle ───────────────────────────────────────────────────────────────

test('lifecycle renders markers, publishes overlay labels, and tears down cleanly', async () => {
  const viewer = viewerWithSources();
  const host = recordingHost();
  const layer = createEventsLayer({
    overlayHost: host,
    openSource() {},
    screenSpaceEventHandlerFactory: NOOP_HANDLER_FACTORY,
  });

  await withFetch(async () => okResponse(proxyPayload()), async () => {
    layer.init(viewer);
    assert.equal(viewer.sources.length, 1);
    assert.equal(viewer.sources[0].show, false, 'a fresh source starts hidden');

    layer.enable(viewer);
    assert.equal(viewer.sources[0].show, true);
    assert.equal(await layer.update(viewer, {}), true);

    const entities = viewer.sources[0].entities.values;
    assert.ok(entities.length > 0, 'markers are rendered');
    assert.ok(entities.every((entity) => entity.point), 'points, never clamped ellipses');
    assert.ok(entities.every((entity) => entity.ellipse === undefined));
    assert.ok(entities.every((entity) => entity.label === undefined), 'labels go to the host');

    const publication = host.calls.findLast(([type]) => type === 'entries');
    assert.ok(publication, 'the update path publishes the overlay source');
    assert.equal(publication[1], 'events');
    assert.deepEqual(publication[3], {
      cohortLimit: EVENTS_OVERLAY_COHORT_LIMIT,
      collisionCapacity: EVENTS_OVERLAY_COLLISION_CAPACITY,
      moving: false,
    });

    const stats = layer.getStats();
    assert.equal(stats.count, entities.length);
    assert.equal(stats.error, null);
    assert.ok(Number.isFinite(stats.lastUpdate));

    layer.disable(viewer);
    assert.equal(viewer.sources[0].show, false);
    assert.deepEqual(host.calls.slice(-2), [['clear', 'events'], ['visible', 'events', false]]);

    layer.destroy(viewer);
    assert.equal(viewer.sources.length, 0, 'destroy removes the data source from the viewer');
    assert.deepEqual(host.calls.slice(-2), [['clear', 'events'], ['visible', 'events', false]]);
    assert.deepEqual(layer.getStats(), {
      count: 0, lastUpdate: null, error: null, loading: false, stale: false,
      sliceCount: null, windowSlices: null, partialWindow: false,
    });
  });
});

test('marker geometry is STATIC — a CallbackProperty would re-enter the frame budget', async () => {
  const viewer = viewerWithSources();
  const layer = createEventsLayer({
    overlayHost: { setEntries() {}, setVisible() {}, clearSource() {} },
    screenSpaceEventHandlerFactory: NOOP_HANDLER_FACTORY,
  });
  await withFetch(async () => okResponse(proxyPayload()), async () => {
    layer.init(viewer);
    layer.enable(viewer);
    await layer.update(viewer, {});
    const [entity] = viewer.sources[0].entities.values;
    assert.ok(entity.point, 'the marker is a point graphic');
    assert.ok(entity.point.pixelSize instanceof Cesium.ConstantProperty);
    assert.ok(entity.point.color instanceof Cesium.ConstantProperty);
    assert.ok(!(entity.point.pixelSize instanceof Cesium.CallbackProperty));
    layer.destroy(viewer);
  });
});

// ── AbortSignal contract ────────────────────────────────────────────────────

test('a pre-aborted signal makes no request and rethrows AbortError', async () => {
  const viewer = viewerWithSources();
  const layer = createEventsLayer({
    overlayHost: { setEntries() {}, setVisible() {}, clearSource() {} },
    screenSpaceEventHandlerFactory: NOOP_HANDLER_FACTORY,
  });
  let fetchCalls = 0;
  await withFetch(async () => { fetchCalls += 1; return okResponse(proxyPayload()); }, async () => {
    layer.init(viewer);
    layer.enable(viewer);
    const controller = new AbortController();
    controller.abort('user toggled off');
    await assert.rejects(
      () => layer.update(viewer, { signal: controller.signal }),
      // manager.js isAbortError() keys on the NAME — a cancelled toggle must
      // not be recorded as a fetch failure.
      (error) => error.name === 'AbortError',
    );
    assert.equal(fetchCalls, 0, 'no upstream request is issued');
    assert.equal(layer.getStats().error, null, 'cancellation is not a layer error');
    layer.destroy(viewer);
  });
});

test('aborting mid-flight aborts the in-flight request and rethrows AbortError', async () => {
  const viewer = viewerWithSources();
  const layer = createEventsLayer({
    overlayHost: { setEntries() {}, setVisible() {}, clearSource() {} },
    screenSpaceEventHandlerFactory: NOOP_HANDLER_FACTORY,
  });
  let observedSignal = null;
  const hangingFetch = (url, init) => new Promise((resolve, reject) => {
    observedSignal = init.signal;
    init.signal.addEventListener('abort', () => {
      const error = new Error('aborted');
      error.name = 'AbortError';
      reject(error);
    }, { once: true });
  });

  await withFetch(hangingFetch, async () => {
    layer.init(viewer);
    layer.enable(viewer);
    const controller = new AbortController();
    const pending = layer.update(viewer, { signal: controller.signal });
    await Promise.resolve();
    assert.ok(observedSignal, 'the layer passes a signal into fetch');
    assert.equal(observedSignal.aborted, false);
    controller.abort('layer toggled off');
    await assert.rejects(() => pending, (error) => error.name === 'AbortError');
    assert.equal(observedSignal.aborted, true, 'the in-flight request was aborted');
    layer.destroy(viewer);
  });
});

test('disable() aborts an in-flight poll so it cannot republish after teardown', async () => {
  const viewer = viewerWithSources();
  const host = recordingHost();
  const layer = createEventsLayer({
    overlayHost: host,
    screenSpaceEventHandlerFactory: NOOP_HANDLER_FACTORY,
  });
  let observedSignal = null;
  const hangingFetch = (url, init) => new Promise((resolve, reject) => {
    observedSignal = init.signal;
    init.signal.addEventListener('abort', () => {
      const error = new Error('aborted');
      error.name = 'AbortError';
      reject(error);
    }, { once: true });
  });

  await withFetch(hangingFetch, async () => {
    layer.init(viewer);
    layer.enable(viewer);
    const pending = layer.update(viewer, {});
    await Promise.resolve();
    layer.disable(viewer);
    assert.equal(observedSignal.aborted, true, 'disable aborts the poll');
    await assert.rejects(() => pending, (error) => error.name === 'AbortError');
    // Nothing published after the clear that disable() performed.
    const lastEntries = host.calls.findLastIndex(([type]) => type === 'entries');
    const lastClear = host.calls.findLastIndex(([type]) => type === 'clear');
    assert.ok(lastClear > lastEntries, 'no overlay publication survives the teardown');
    layer.destroy(viewer);
  });
});

test('destroy() aborts an in-flight poll and drops the data source', async () => {
  const viewer = viewerWithSources();
  const layer = createEventsLayer({
    overlayHost: { setEntries() {}, setVisible() {}, clearSource() {} },
    screenSpaceEventHandlerFactory: NOOP_HANDLER_FACTORY,
  });
  let observedSignal = null;
  await withFetch((url, init) => new Promise((resolve, reject) => {
    observedSignal = init.signal;
    init.signal.addEventListener('abort', () => {
      const error = new Error('aborted');
      error.name = 'AbortError';
      reject(error);
    }, { once: true });
  }), async () => {
    layer.init(viewer);
    layer.enable(viewer);
    const pending = layer.update(viewer, {});
    await Promise.resolve();
    layer.destroy(viewer);
    assert.equal(observedSignal.aborted, true);
    await assert.rejects(() => pending, (error) => error.name === 'AbortError');
    assert.equal(viewer.sources.length, 0);
  });
});

// ── Failure reporting ───────────────────────────────────────────────────────

test('a proxy failure is reported through getStats without throwing', async () => {
  const viewer = viewerWithSources();
  const layer = createEventsLayer({
    overlayHost: { setEntries() {}, setVisible() {}, clearSource() {} },
    screenSpaceEventHandlerFactory: NOOP_HANDLER_FACTORY,
  });
  await withFetch(async () => ({ ok: false, status: 502, json: async () => ({}) }), async () => {
    layer.init(viewer);
    layer.enable(viewer);
    assert.equal(await layer.update(viewer, {}), false);
    assert.equal(layer.getStats().error, 'GDELT proxy HTTP 502');
    assert.equal(layer.getStats().lastUpdate, null);
    layer.destroy(viewer);
  });
});

test('a budget 429 and a malformed body get distinct honest error strings', async () => {
  const viewer = viewerWithSources();
  const layer = createEventsLayer({
    overlayHost: { setEntries() {}, setVisible() {}, clearSource() {} },
    screenSpaceEventHandlerFactory: NOOP_HANDLER_FACTORY,
  });
  await withFetch(async () => ({ ok: false, status: 429, json: async () => ({}) }), async () => {
    layer.init(viewer);
    layer.enable(viewer);
    await layer.update(viewer, {});
    assert.equal(layer.getStats().error, 'GDELT daily budget reached');
  });
  await withFetch(async () => okResponse({ events: 'not-an-array' }), async () => {
    await layer.update(viewer, {});
    assert.equal(layer.getStats().error, 'Malformed events response');
    layer.destroy(viewer);
  });
});

test('a stale payload is surfaced, and a still-deepening window is not an error', async () => {
  const viewer = viewerWithSources();
  const layer = createEventsLayer({
    overlayHost: { setEntries() {}, setVisible() {}, clearSource() {} },
    screenSpaceEventHandlerFactory: NOOP_HANDLER_FACTORY,
  });
  const partial = proxyPayload({ stale: true, sliceCount: 3 });
  await withFetch(async () => okResponse(partial), async () => {
    layer.init(viewer);
    layer.enable(viewer);
    await layer.update(viewer, {});
    const stats = layer.getStats();
    assert.equal(stats.stale, true, 'a served-stale cache is reported as stale');
    assert.ok(stats.count > 0, 'stale beats empty — the markers still render');
    // A window still backfilling is reported as such, NOT as a fetch failure.
    // The proxy serves the newest slice immediately and deepens behind it, so
    // a cold start is legitimately thin and a red chip would be a lie.
    assert.equal(stats.error, null);
    assert.equal(stats.partialWindow, true);
    assert.equal(stats.sliceCount, 3);
    assert.equal(stats.windowSlices, 16);
    layer.destroy(viewer);
  });
});

// ── Entity budget and category filter ───────────────────────────────────────

test('the entity budget caps rendered markers at EVENTS_MAX_ENTITIES', async () => {
  const viewer = viewerWithSources();
  const layer = createEventsLayer({
    overlayHost: { setEntries() {}, setVisible() {}, clearSource() {} },
    screenSpaceEventHandlerFactory: NOOP_HANDLER_FACTORY,
  });
  const events = Array.from({ length: EVENTS_MAX_ENTITIES + 120 }, (_, index) => ({
    id: `evt:${index}`,
    lat: (index % 80) - 40,
    lon: (index % 170) - 85,
    place: `Place ${index}`,
    category: 'conflict',
    numArticles: index + 1,
    severity: index % 100,
  }));
  await withFetch(async () => okResponse({ ...proxyPayload(), events }), async () => {
    layer.init(viewer);
    layer.enable(viewer);
    await layer.update(viewer, {});
    assert.equal(viewer.sources[0].entities.values.length, EVENTS_MAX_ENTITIES);
    assert.equal(layer.getStats().count, EVENTS_MAX_ENTITIES);
    layer.destroy(viewer);
  });
});

test('setParams filters categories and re-renders without refetching', async () => {
  const viewer = viewerWithSources();
  const layer = createEventsLayer({
    overlayHost: { setEntries() {}, setVisible() {}, clearSource() {} },
    screenSpaceEventHandlerFactory: NOOP_HANDLER_FACTORY,
  });
  let fetchCalls = 0;
  await withFetch(async () => { fetchCalls += 1; return okResponse(proxyPayload()); }, async () => {
    layer.init(viewer);
    layer.enable(viewer);
    await layer.update(viewer, {});
    const all = viewer.sources[0].entities.values.length;
    assert.equal(fetchCalls, 1);

    assert.equal(layer.setParams({ categories: ['coercion'] }), true);
    const coercionOnly = viewer.sources[0].entities.values;
    assert.ok(coercionOnly.length < all, 'the filter narrows the rendered set');
    assert.ok(coercionOnly.length > 0, 'and the category is not empty');
    assert.equal(fetchCalls, 1, 'filtering re-renders from cached records');
    assert.deepEqual(layer.getParams(), { categories: ['coercion'] });
    for (const entity of coercionOnly) {
      assert.equal(entity.properties.category.getValue(Cesium.JulianDate.now()), 'coercion');
    }

    assert.equal(layer.setParams({ categories: 'conflict' }), false, 'a non-array is rejected');
    assert.deepEqual(layer.getParams(), { categories: ['coercion'] }, 'a rejected write changes nothing');
    assert.equal(layer.setParams({}), true, 'an unrelated params write is a no-op');
    layer.destroy(viewer);
  });
});

test('row controls expose one chip per category and refuse to disable the last one', async () => {
  const viewer = viewerWithSources();
  const layer = createEventsLayer({
    overlayHost: { setEntries() {}, setVisible() {}, clearSource() {} },
    screenSpaceEventHandlerFactory: NOOP_HANDLER_FACTORY,
  });
  await withFetch(async () => okResponse(proxyPayload()), async () => {
    layer.init(viewer);
    layer.enable(viewer);
    await layer.update(viewer, {});

    const all = layer.getRowControls();
    assert.equal(all.chips.length, 5, 'one chip per category');
    // Four active, not five: diplomacy is roughly 70% of any window and is
    // deliberately off until asked for.
    assert.deepEqual(
      all.chips.filter((chip) => chip.active).map((chip) => chip.id),
      ['conflict', 'unrest', 'coercion', 'dissent'],
    );
    assert.equal(all.chips.find((chip) => chip.id === 'diplomacy').active, false);
    assert.ok(all.chips.every((chip) => !chip.disabled));
    assert.equal(all.legend.length, 4, 'the legend shows only active categories');
    assert.ok(all.legend.every((item) => /^#[0-9a-f]{6}$/i.test(item.color)));
    assert.ok(all.legend.every((item) => item.blurb.length > 0), 'each legend row says what it means');
    assert.ok(all.legend.some((item) => item.count > 0), 'the legend tallies rendered markers');

    layer.setParams({ categories: ['conflict'] });
    const single = layer.getRowControls();
    const conflict = single.chips.find((chip) => chip.id === 'conflict');
    assert.equal(conflict.active, true);
    assert.equal(conflict.disabled, true, 'the last active chip cannot be turned off');
    assert.equal(single.legend.length, 1);
    const diplomacy = single.chips.find((chip) => chip.id === 'diplomacy');
    assert.deepEqual(diplomacy.params.categories.includes('diplomacy'), true);
    layer.destroy(viewer);
  });
});

// ── Click-through ───────────────────────────────────────────────────────────

test('first click selects, second click opens the source, and only then', async () => {
  const viewer = viewerWithSources();
  const clicks = clickHandlerFactory();
  const opened = [];
  const layer = createEventsLayer({
    overlayHost: { setEntries() {}, setVisible() {}, clearSource() {} },
    openSource: (url) => opened.push(url),
    screenSpaceEventHandlerFactory: clicks.factory,
  });

  await withFetch(async () => okResponse(proxyPayload()), async () => {
    layer.init(viewer);
    layer.enable(viewer);
    await layer.update(viewer, {});
    assert.ok(clicks.state.action, 'enable installs a LEFT_CLICK handler');

    const entity = viewer.sources[0].entities.values
      .find((candidate) => candidate.id === TOP_EVENT.id);
    assert.ok(entity, 'the highest-ranked marker is rendered');
    viewer._setPick({ id: entity });

    clicks.state.action({ position: { x: 1, y: 1 } });
    assert.deepEqual(opened, [], 'the first click only selects');

    clicks.state.action({ position: { x: 1, y: 1 } });
    assert.deepEqual(opened, [TOP_EVENT.url], 'the second click opens the source');

    // A click on empty space clears the selection, so the next click on the
    // same marker selects again rather than opening.
    viewer._setPick(null);
    clicks.state.action({ position: { x: 2, y: 2 } });
    viewer._setPick({ id: entity });
    clicks.state.action({ position: { x: 1, y: 1 } });
    assert.equal(opened.length, 1, 'selection was cleared, so this click re-selects');

    layer.disable(viewer);
    assert.equal(clicks.state.destroyed, true, 'disable destroys the click handler');
    layer.destroy(viewer);
  });
});

test('a pick owned by another layer is left alone, not treated as empty space', async () => {
  // pickRegistry contract: a sibling layer's entity is NOT "the user clicked
  // nothing". Clearing the events selection there would fight that layer for
  // the same click, which is the exact bug the registry exists to prevent.
  const viewer = viewerWithSources();
  const clicks = clickHandlerFactory();
  const opened = [];
  const layer = createEventsLayer({
    overlayHost: { setEntries() {}, setVisible() {}, clearSource() {} },
    openSource: (url) => opened.push(url),
    screenSpaceEventHandlerFactory: clicks.factory,
  });
  registerPickOwner('test-sibling', (pickedId) => pickedId === 'sibling-entity');
  try {
    await withFetch(async () => okResponse(proxyPayload()), async () => {
      layer.init(viewer);
      layer.enable(viewer);
      await layer.update(viewer, {});
      const entity = viewer.sources[0].entities.values
        .find((candidate) => candidate.id === TOP_EVENT.id);

      viewer._setPick({ id: entity });
      clicks.state.action({ position: { x: 1, y: 1 } });

      viewer._setPick({ id: 'sibling-entity' });
      clicks.state.action({ position: { x: 3, y: 3 } });
      assert.deepEqual(opened, [], 'a sibling pick opens nothing');

      viewer._setPick({ id: entity });
      clicks.state.action({ position: { x: 1, y: 1 } });
      assert.deepEqual(
        opened,
        [TOP_EVENT.url],
        'the selection survived the sibling pick',
      );
      layer.destroy(viewer);
    });
  } finally {
    unregisterPickOwner('test-sibling');
  }
});

test('a pick owned by nobody clears the selection like empty space', async () => {
  const viewer = viewerWithSources();
  const clicks = clickHandlerFactory();
  const opened = [];
  const layer = createEventsLayer({
    overlayHost: { setEntries() {}, setVisible() {}, clearSource() {} },
    openSource: (url) => opened.push(url),
    screenSpaceEventHandlerFactory: clicks.factory,
  });
  await withFetch(async () => okResponse(proxyPayload()), async () => {
    layer.init(viewer);
    layer.enable(viewer);
    await layer.update(viewer, {});
    const entity = viewer.sources[0].entities.values
      .find((candidate) => candidate.id === TOP_EVENT.id);

    viewer._setPick({ id: entity });
    clicks.state.action({ position: { x: 1, y: 1 } });
    viewer._setPick({ id: 'unclaimed-entity' });
    clicks.state.action({ position: { x: 3, y: 3 } });
    viewer._setPick({ id: entity });
    clicks.state.action({ position: { x: 1, y: 1 } });
    assert.deepEqual(opened, [], 'the deselecting click means this one re-selects');
    layer.destroy(viewer);
  });
});

test('a marker with no article link never opens anything on a repeat click', async () => {
  const viewer = viewerWithSources();
  const clicks = clickHandlerFactory();
  const opened = [];
  const layer = createEventsLayer({
    overlayHost: { setEntries() {}, setVisible() {}, clearSource() {} },
    openSource: (url) => opened.push(url),
    screenSpaceEventHandlerFactory: clicks.factory,
  });
  const linkless = {
    ...proxyPayload(),
    events: [{
      id: 'evt:0.000,0.000',
      lat: 0,
      lon: 0,
      place: 'Nowhere',
      category: 'conflict',
      numArticles: 4,
      severity: 50,
      url: null,
    }],
  };
  await withFetch(async () => okResponse(linkless), async () => {
    layer.init(viewer);
    layer.enable(viewer);
    await layer.update(viewer, {});
    const [entity] = viewer.sources[0].entities.values;
    viewer._setPick({ id: entity });
    clicks.state.action({ position: { x: 1, y: 1 } });
    clicks.state.action({ position: { x: 1, y: 1 } });
    clicks.state.action({ position: { x: 1, y: 1 } });
    assert.deepEqual(opened, []);
    layer.destroy(viewer);
  });
});

// ── Contract surface ────────────────────────────────────────────────────────

test('the layer satisfies the DataLayerManager contract and omits getDetectableObjects', () => {
  const layer = createEventsLayer();
  assert.equal(layer.id, 'events');
  assert.equal(typeof layer.name, 'string');
  assert.equal(typeof layer.icon, 'string');
  assert.equal(layer.source, 'GDELT CAMEO');
  // The display name must not read as a general news feed — the source codes
  // political interactions and nothing else.
  assert.equal(layer.name, 'Political Events');
  assert.ok(Number.isFinite(layer.updateInterval) && layer.updateInterval > 0);
  for (const method of ['init', 'enable', 'disable', 'update', 'destroy', 'getStats']) {
    assert.equal(typeof layer[method], 'function', `${method} is required by the manager`);
  }
  // Deliberately absent: the coordinates are place centroids resolved from
  // article text, not incident positions. Labelling them as detected objects
  // would present inference as observation. See the module header.
  assert.equal(layer.getDetectableObjects, undefined);
  assert.deepEqual(layer.getStats(), {
    count: 0, lastUpdate: null, error: null, loading: false, stale: false,
    sliceCount: null, windowSlices: null, partialWindow: false,
  });
});

test('getAnalystRecords is empty while hidden and JSON-safe once rendered', async () => {
  const viewer = viewerWithSources();
  const layer = createEventsLayer({
    overlayHost: { setEntries() {}, setVisible() {}, clearSource() {} },
    screenSpaceEventHandlerFactory: NOOP_HANDLER_FACTORY,
  });
  await withFetch(async () => okResponse(proxyPayload()), async () => {
    layer.init(viewer);
    assert.deepEqual(layer.getAnalystRecords(), [], 'hidden source yields nothing');
    layer.enable(viewer);
    await layer.update(viewer, {});
    const records = layer.getAnalystRecords();
    assert.ok(records.length > 0);
    assert.deepEqual(JSON.parse(JSON.stringify(records)), records);
    assert.equal(layer.getAnalystRecords(1).length, 1, 'truncation is honoured');
    layer.destroy(viewer);
  });
});
