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
  EVENTS_CLICK_DRAG_TOLERANCE_PX,
  EVENTS_CULL_LIFT_M,
  EVENTS_HOVER_THROTTLE_MS,
  EVENTS_MAX_ENTITIES,
  EVENTS_OVERLAY_COHORT_LIMIT,
  EVENTS_OVERLAY_COLLISION_CAPACITY,
  createEventOverlayEntry,
  createEventsLayer,
  createEventHoverCardEntry,
  entityCardLines,
  eventCullPosition,
  eventHoverCardLines,
  eventLabelText,
  isDragGesture,
  mapAnalystRecord,
  selectEventOverlayCohort,
  shouldOpenEventSource,
  titleCaseEntity,
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
/**
 * Camera double with a real `positionWC` and a `moveEnd` event, so the horizon
 * pass runs the production path. Without a camera the pass returns early and
 * every test around it is a false green.
 */
function fakeCamera(lon = -97.7, lat = 30.2, height = 25_000_000) {
  const moveStartListeners = [];
  const moveEndListeners = [];
  const event = (list) => ({
    addEventListener: (fn) => { list.push(fn); },
    removeEventListener: (fn) => {
      const i = list.indexOf(fn);
      if (i >= 0) list.splice(i, 1);
    },
  });
  return {
    positionWC: Cesium.Cartesian3.fromDegrees(lon, lat, height),
    moveStart: event(moveStartListeners),
    moveEnd: event(moveEndListeners),
    moveStartListeners,
    moveEndListeners,
    /** Every camera subscription this layer holds. */
    get listeners() { return [...moveStartListeners, ...moveEndListeners]; },
    /** Move the camera and fire the full start/settle cycle, as Cesium would. */
    flyTo(nextLon, nextLat, nextHeight = height) {
      for (const fn of [...moveStartListeners]) fn();
      this.positionWC = Cesium.Cartesian3.fromDegrees(nextLon, nextLat, nextHeight);
      for (const fn of [...moveEndListeners]) fn();
    },
  };
}

function fakeViewer({ pickResult = null, camera = fakeCamera() } = {}) {
  const dataSources = [];
  return {
    dataSources,
    camera,
    scene: {
      canvas: { id: 'canvas' },
      pick: () => pickResult,
      postRender: {
        listeners: [],
        addEventListener(fn) {
          this.listeners.push(fn);
          return () => {
            const i = this.listeners.indexOf(fn);
            if (i >= 0) this.listeners.splice(i, 1);
          };
        },
      },
      /** Drive N frames, the way a drag would. */
      _renderFrames(n = 1) {
        for (let i = 0; i < n; i += 1) for (const fn of [...this.postRender.listeners]) fn();
      },
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
    /** Entries from the most recent publish, for overlay-content assertions. */
    last() {
      for (let i = calls.length - 1; i >= 0; i -= 1) {
        if (calls[i][0] === 'entries') return calls[i][2] || [];
      }
      return [];
    },
  };
}

/**
 * Headless stand-in for `Cesium.ScreenSpaceEventHandler`, which registers DOM
 * listeners in its constructor and therefore needs a `document` node:test has
 * not got. Tests that exercise clicking use `clickHandlerFactory()` instead.
 */
const NOOP_HANDLER_FACTORY = () => ({ setInputAction() {}, destroy() {} });

/** Capture the LEFT_CLICK callback the layer installs. */
/**
 * ScreenSpaceEventHandler double. The layer registers three input actions now
 * (click, press, hover), so they are keyed by Cesium's event type rather than
 * collapsed into one slot.
 */
function clickHandlerFactory() {
  const state = { action: null, byType: new Map(), destroyed: false };
  const helpers = {
    /** Press then release at the same point — an unambiguous click. */
    click(position = { x: 1, y: 1 }) {
      state.byType.get(Cesium.ScreenSpaceEventType.LEFT_DOWN)?.({ position });
      state.byType.get(Cesium.ScreenSpaceEventType.LEFT_CLICK)?.({ position });
    },
    /** Press at one point, release at another — a camera drag. */
    drag(from = { x: 1, y: 1 }, to = { x: 80, y: 60 }) {
      state.byType.get(Cesium.ScreenSpaceEventType.LEFT_DOWN)?.({ position: from });
      state.byType.get(Cesium.ScreenSpaceEventType.LEFT_CLICK)?.({ position: to });
    },
    hover(endPosition = { x: 1, y: 1 }) {
      state.byType.get(Cesium.ScreenSpaceEventType.MOUSE_MOVE)?.({ endPosition });
    },
  };
  return {
    state,
    helpers,
    factory: () => ({
      setInputAction(action, type) {
        state.byType.set(type, action);
        if (type === Cesium.ScreenSpaceEventType.LEFT_CLICK) state.action = action;
      },
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

test('a single click opens, but only when the gesture was not a drag', () => {
  const record = { id: 'evt:1', url: 'https://example-news.org/a/1' };
  assert.equal(shouldOpenEventSource(record), true, 'one click is enough now');
  assert.equal(shouldOpenEventSource(record, { dragged: true }), false);
  assert.equal(shouldOpenEventSource({ id: 'evt:1' }), false, 'no URL, nothing to open');
  assert.equal(shouldOpenEventSource(null), false);
});

test('drag discrimination: slop is a click, travel is a drag, unknown is a drag', () => {
  const at = (x, y) => ({ x, y });
  assert.equal(isDragGesture(at(10, 10), at(10, 10)), false, 'no movement');
  assert.equal(isDragGesture(at(10, 10), at(13, 13)), false, 'inside tolerance (4.2 px)');
  assert.equal(isDragGesture(at(10, 10), at(60, 40)), true, 'a real drag');
  assert.equal(
    isDragGesture(at(0, 0), at(EVENTS_CLICK_DRAG_TOLERANCE_PX + 1, 0)), true,
    'just outside tolerance',
  );
  // Fail closed. If we cannot prove the pointer stayed put we must not open a
  // tab — a missing press is exactly the ambiguous case.
  assert.equal(isDragGesture(null, at(1, 1)), true);
  assert.equal(isDragGesture(at(1, 1), null), true);
  assert.equal(isDragGesture(at(NaN, 1), at(1, 1)), true);
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

test('one click opens the source; a click that ended a drag does not', async () => {
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

    // One click is all it takes now — no select-then-open dance.
    clicks.helpers.click();
    assert.deepEqual(opened, [TOP_EVENT.url], 'a single click opens the source');

    // The safeguard the two-stage click used to provide, kept explicitly.
    // Dragging the globe routinely finishes with the pointer over a marker,
    // and that must never open an article.
    clicks.helpers.drag({ x: 1, y: 1 }, { x: 90, y: 70 });
    assert.equal(opened.length, 1, 'a click that ended a drag opens nothing');

    // A release with no matching press cannot be proven stationary, so it is
    // treated as a drag rather than trusted.
    clicks.state.byType.get(Cesium.ScreenSpaceEventType.LEFT_CLICK)({ position: { x: 5, y: 5 } });
    assert.equal(opened.length, 1, 'an unpaired release opens nothing');

    // A click on empty space still clears the selection.
    viewer._setPick(null);
    clicks.helpers.click({ x: 2, y: 2 });
    assert.equal(opened.length, 1);

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
      clicks.helpers.click();
      assert.deepEqual(opened, [TOP_EVENT.url], 'our marker opened');

      // A sibling layer's entity is not "empty space": it must not clear our
      // selection, and it must not open anything of ours.
      viewer._setPick({ id: 'sibling-entity' });
      clicks.helpers.click({ x: 3, y: 3 });
      assert.deepEqual(opened, [TOP_EVENT.url], 'a sibling pick opens nothing');
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


// ── Horizon culling ─────────────────────────────────────────────────────────
//
// Reported defect: markers for events in Asia rendered while the camera was
// over North America. These markers set `disableDepthTestDistance: INFINITY`
// so nothing occludes them, in either map stack — the Cesium globe is hidden
// under google-3d, and on the globe stacks that flag overrides the depth that
// is written. An explicit occluder pass is the only thing standing between the
// layer and markers punching through the planet.

const ASIA = { lon: 116.4, lat: 39.9 };     // Beijing — the reported case
const NORTH_AMERICA = { lon: -97.7, lat: 30.2 };

/** One render record at a given place, enough for the layer to draw it. */
const eventAt = (id, { lon, lat }) => ({
  id, lon, lat, place: id, category: 'conflict', severity: 50, numArticles: 3,
  url: 'https://example.org/a',
});

test('the occlusion anchor is lifted, and the lift is what fixes the limb case', () => {
  const lifted = eventCullPosition(NORTH_AMERICA.lon, NORTH_AMERICA.lat);
  const carto = Cesium.Cartographic.fromCartesian(lifted);
  assert.ok(Math.abs(carto.height - EVENTS_CULL_LIFT_M) < 0.01);
  assert.equal(EVENTS_CULL_LIFT_M, 12);

  // Why the lift exists, measured against Cesium's own occluder rather than
  // asserted. Marker positions are built at height 0 — exactly ON the
  // ellipsoid — and EllipsoidalOccluder treats that as a limb boundary case,
  // judging it hidden BEFORE the true tangent. At this camera a height-0 point
  // reads hidden while the lifted one is still visible, so without the lift a
  // band of near-limb markers would blink out for a datum reason. Height 0
  // behaves identically to a point 22 m underground.
  const camera = Cesium.Cartesian3.fromDegrees(
    NORTH_AMERICA.lon, NORTH_AMERICA.lat, 1_500_000,
  );
  const occluder = new Cesium.EllipsoidalOccluder(Cesium.Ellipsoid.WGS84, camera);
  const limbLon = NORTH_AMERICA.lon + 41.87;
  const atSurface = Cesium.Cartesian3.fromDegrees(limbLon, NORTH_AMERICA.lat, 0);
  const atLift = eventCullPosition(limbLon, NORTH_AMERICA.lat);
  assert.equal(occluder.isPointVisible(atSurface), false, 'height 0 false-hides');
  assert.equal(occluder.isPointVisible(atLift), true, 'the lifted anchor does not');
});

test('markers behind the planet are hidden while near-side markers render', async () => {
  const camera = fakeCamera(NORTH_AMERICA.lon, NORTH_AMERICA.lat, 12_000_000);
  const viewer = viewerWithSources({ camera });
  const layer = createEventsLayer({
    overlayHost: { setEntries() {}, setVisible() {}, clearSource() {} },
    screenSpaceEventHandlerFactory: NOOP_HANDLER_FACTORY,
  });
  const events = [eventAt('near', NORTH_AMERICA), eventAt('far', ASIA)];
  await withFetch(async () => okResponse(proxyPayload({ events })), async () => {
    layer.init(viewer);
    layer.enable(viewer);
    await layer.update(viewer, {});

    const byId = new Map(viewer.sources[0].entities.values.map((e) => [e.id, e]));
    assert.equal(byId.size, 2, 'both markers exist as entities');
    // The defect verbatim: with the camera over North America, Asia must not
    // be drawn through the globe.
    assert.equal(byId.get('near').show, true, 'the near-side marker renders');
    assert.equal(byId.get('far').show, false, 'the far-side marker does not');
    layer.destroy(viewer);
  });
});

test('the pass recomputes when the camera moves, not per frame', async () => {
  const camera = fakeCamera(NORTH_AMERICA.lon, NORTH_AMERICA.lat, 12_000_000);
  const viewer = viewerWithSources({ camera });
  const layer = createEventsLayer({
    overlayHost: { setEntries() {}, setVisible() {}, clearSource() {} },
    screenSpaceEventHandlerFactory: NOOP_HANDLER_FACTORY,
  });
  const events = [eventAt('near', NORTH_AMERICA), eventAt('far', ASIA)];
  await withFetch(async () => okResponse(proxyPayload({ events })), async () => {
    layer.init(viewer);
    layer.enable(viewer);
    await layer.update(viewer, {});
    assert.deepEqual(
      [camera.moveStartListeners.length, camera.moveEndListeners.length], [1, 1],
      'one moveStart and one moveEnd subscription',
    );

    const byId = new Map(viewer.sources[0].entities.values.map((e) => [e.id, e]));
    assert.equal(byId.get('far').show, false);

    // Fly to the other side of the planet; the answer must invert.
    camera.flyTo(ASIA.lon, ASIA.lat, 12_000_000);
    assert.equal(byId.get('far').show, true, 'Asia is now the near side');
    assert.equal(byId.get('near').show, false, 'and North America is behind the limb');
    layer.destroy(viewer);
  });
});

test('a settled camera dirties nothing on a repeat pass', async () => {
  const camera = fakeCamera(NORTH_AMERICA.lon, NORTH_AMERICA.lat, 12_000_000);
  const viewer = viewerWithSources({ camera });
  const layer = createEventsLayer({
    overlayHost: { setEntries() {}, setVisible() {}, clearSource() {} },
    screenSpaceEventHandlerFactory: NOOP_HANDLER_FACTORY,
  });
  const events = [eventAt('near', NORTH_AMERICA), eventAt('far', ASIA)];
  await withFetch(async () => okResponse(proxyPayload({ events })), async () => {
    layer.init(viewer);
    layer.enable(viewer);
    await layer.update(viewer, {});

    // Count writes to `show` across a moveEnd that did not actually move.
    let writes = 0;
    for (const entity of viewer.sources[0].entities.values) {
      let value = entity.show;
      Object.defineProperty(entity, 'show', {
        configurable: true,
        get: () => value,
        set: (next) => { value = next; writes += 1; },
      });
    }
    for (const fn of [...camera.listeners]) fn();
    assert.equal(writes, 0, 'an unmoved camera writes no show flags');
    layer.destroy(viewer);
  });
});

test('the cull is map-stack independent and subscribes to no stack event', async () => {
  // Unlike CCTV, whose geometry genuinely resolves differently between the
  // photoreal and globe regimes, this test is pure camera-vs-WGS84 geometry
  // with no surface-height dependency. It must give the same answer in every
  // stack — so a stack change alone must not perturb it, and the layer must
  // not have quietly grown a listener for one.
  const camera = fakeCamera(NORTH_AMERICA.lon, NORTH_AMERICA.lat, 12_000_000);
  const viewer = viewerWithSources({ camera });
  const layer = createEventsLayer({
    overlayHost: { setEntries() {}, setVisible() {}, clearSource() {} },
    screenSpaceEventHandlerFactory: NOOP_HANDLER_FACTORY,
  });
  const events = [eventAt('near', NORTH_AMERICA), eventAt('far', ASIA)];

  const added = [];
  const realAdd = globalThis.window?.addEventListener;
  globalThis.window = globalThis.window || {};
  globalThis.window.addEventListener = (type) => { added.push(type); };
  try {
    await withFetch(async () => okResponse(proxyPayload({ events })), async () => {
      layer.init(viewer);
      layer.enable(viewer);
      await layer.update(viewer, {});
      const byId = new Map(viewer.sources[0].entities.values.map((e) => [e.id, e]));
      const before = { near: byId.get('near').show, far: byId.get('far').show };

      assert.ok(
        !added.includes('gev:map-stack-changed'),
        'no stack listener: the horizon test has no surface dependency to re-resolve',
      );
      // Both regimes need the cull equally — google-3d hides the Cesium globe
      // so nothing writes far-side depth, and on globe stacks
      // disableDepthTestDistance overrides the depth that is written.
      assert.deepEqual(
        { near: byId.get('near').show, far: byId.get('far').show },
        before,
        'a stack change alone does not alter horizon visibility',
      );
      layer.destroy(viewer);
    });
  } finally {
    if (realAdd) globalThis.window.addEventListener = realAdd;
  }
});

test('teardown removes the camera subscription', async () => {
  const camera = fakeCamera();
  const viewer = viewerWithSources({ camera });
  const layer = createEventsLayer({
    overlayHost: { setEntries() {}, setVisible() {}, clearSource() {} },
    screenSpaceEventHandlerFactory: NOOP_HANDLER_FACTORY,
  });
  layer.init(viewer);
  layer.enable(viewer);
  assert.equal(camera.listeners.length, 2, 'moveStart and moveEnd');
  layer.disable(viewer);
  assert.equal(camera.listeners.length, 0, 'disable unsubscribes both');

  layer.enable(viewer);
  assert.equal(camera.listeners.length, 2, 'and re-enable resubscribes exactly once each');
  layer.destroy(viewer);
  assert.equal(camera.listeners.length, 0, 'destroy unsubscribes');
});

test('overlay labels are culled against the lifted anchor, not the surface point', () => {
  const position = Cesium.Cartesian3.fromDegrees(10, 20, 0);
  const cullPosition = eventCullPosition(10, 20);
  const entry = createEventOverlayEntry({
    id: 'x', position, cullPosition, title: 'X', accent: '#fff', severity: 10,
  });
  assert.equal(entry.cullPosition, cullPosition);
  assert.equal(entry.horizonCull, true, 'the overlay host runs its own cull too');
  // Falls back to the render position when no lifted anchor is supplied, so an
  // older call site degrades to the previous behaviour rather than to null.
  const bare = createEventOverlayEntry({
    id: 'y', position, title: 'Y', accent: '#fff', severity: 10,
  });
  assert.equal(bare.cullPosition, position);
});


// ── Hover, card, and in-motion culling ──────────────────────────────────────

test('the hover card says what we actually have, and no actor pair', () => {
  const record = {
    id: '1', category: 'conflict', place: 'Kharkiv, Kharkivska, Ukraine',
    severity: 87, numArticles: 10, domain: 'example-news.org', retrospectiveDays: 0,
  };
  const { title, details } = eventHoverCardLines(record);
  assert.equal(title, 'Kharkiv');
  assert.equal(details[0], 'CONFLICT · intensity 87');
  assert.equal(details[1], 'Assault, fight, unconventional mass violence');
  assert.equal(details[2], 'example-news.org · 10 reports');
  assert.equal(details.length, 3, 'no retrospective line for a current event');

  // The export carries no headline, and an Actor1 -> Actor2 line is filled on
  // only 44% of rows and frequently generic where it is (SCHOOL, POLICE,
  // IMAM), so the card must not attempt one.
  const joined = [title, ...details].join(' ');
  assert.ok(!joined.includes('->'), 'no actor-pair line');
  assert.ok(!joined.includes('undefined') && !joined.includes('null'));

  // A backdated event is badged rather than left to read as current.
  const retro = eventHoverCardLines({ ...record, retrospectiveDays: 365 });
  assert.equal(retro.details[3], 'Event dated 365 days earlier');
  assert.equal(eventHoverCardLines({ ...record, retrospectiveDays: 1 }).details[3],
    'Event dated 1 day earlier');
});

test('card copy degrades rather than printing blanks on a sparse record', () => {
  const { title, details } = eventHoverCardLines({ id: 'x', category: 'unrest' });
  assert.equal(title, 'EVENT');
  assert.equal(details[0], 'UNREST', 'no severity, so no intensity suffix');
  assert.equal(details[1], 'Protest');
  assert.equal(details.length, 2, 'no source line without a domain or count');
  for (const line of details) assert.ok(line.length > 0);
});

test('hovering a marker enlarges it and publishes a card', async () => {
  const host = recordingHost();
  const camera = fakeCamera(NORTH_AMERICA.lon, NORTH_AMERICA.lat, 12_000_000);
  const viewer = viewerWithSources({ camera });
  const clicks = clickHandlerFactory();
  const layer = createEventsLayer({
    overlayHost: host, screenSpaceEventHandlerFactory: clicks.factory,
  });
  const events = [eventAt('near', NORTH_AMERICA)];
  await withFetch(async () => okResponse(proxyPayload({ events })), async () => {
    layer.init(viewer);
    layer.enable(viewer);
    await layer.update(viewer, {});
    const [entity] = viewer.sources[0].entities.values;
    // Cesium wraps assigned primitives in a ConstantProperty, so read through
    // getValue rather than comparing the property object.
    const now = Cesium.JulianDate.now();
    const sizeOf = (e) => e.point.pixelSize.getValue(now);
    const outlineOf = (e) => e.point.outlineWidth.getValue(now);
    const baseSize = sizeOf(entity);

    viewer._setPick({ id: entity });
    clicks.helpers.hover();
    assert.ok(sizeOf(entity) > baseSize, 'the hovered marker grows');
    assert.equal(outlineOf(entity), 3);

    const card = host.last().find((e) => e.variant === 'card');
    assert.ok(card, 'a card entry is published');
    assert.equal(card.id, 'near:card');
    assert.match(card.details[0], /^CONFLICT/);
    assert.ok(card.cullPosition, 'the card is culled on the lifted anchor too');
    // The card carries the place name, so its own label would be a duplicate.
    assert.ok(!host.last().some((e) => e.id === 'near'), 'the label yields to the card');

    // Moving off the marker and STOPPING lands inside the throttle window. A
    // leading-edge-only throttle would drop that last move and leave the card
    // stuck under a pointer that has gone; the trailing edge must deliver it.
    viewer._setPick(null);
    clicks.helpers.hover({ x: 9, y: 9 });
    assert.equal(sizeOf(entity), baseSize + 4, 'still hovered inside the window');
    await new Promise((resolve) => { setTimeout(resolve, EVENTS_HOVER_THROTTLE_MS + 40); });
    assert.equal(sizeOf(entity), baseSize, 'the trailing edge restores the marker');
    assert.ok(!host.last().some((e) => e.variant === 'card'), 'and drops the card');
    layer.destroy(viewer);
  });
});

test('a queued trailing hover never fires after teardown', async () => {
  // The trailing timer outlives the gesture by design, so teardown must cancel
  // it — otherwise it picks against a destroyed data source.
  const camera = fakeCamera(NORTH_AMERICA.lon, NORTH_AMERICA.lat, 12_000_000);
  const viewer = viewerWithSources({ camera });
  const clicks = clickHandlerFactory();
  const layer = createEventsLayer({
    overlayHost: recordingHost(), screenSpaceEventHandlerFactory: clicks.factory,
  });
  const events = [eventAt('near', NORTH_AMERICA)];
  await withFetch(async () => okResponse(proxyPayload({ events })), async () => {
    layer.init(viewer);
    layer.enable(viewer);
    await layer.update(viewer, {});
    clicks.helpers.hover({ x: 1, y: 1 });
    clicks.helpers.hover({ x: 2, y: 2 });   // queues a trailing pick
    layer.destroy(viewer);
    let threw = null;
    viewer.scene.pick = () => { threw = new Error('picked after destroy'); return null; };
    await new Promise((resolve) => { setTimeout(resolve, EVENTS_HOVER_THROTTLE_MS + 40); });
    assert.equal(threw, null, 'the queued pick was cancelled');
  });
});

test('a card is never published for a marker the planet is hiding', async () => {
  const host = recordingHost();
  const camera = fakeCamera(NORTH_AMERICA.lon, NORTH_AMERICA.lat, 12_000_000);
  const viewer = viewerWithSources({ camera });
  const clicks = clickHandlerFactory();
  const layer = createEventsLayer({
    overlayHost: host, screenSpaceEventHandlerFactory: clicks.factory,
  });
  const events = [eventAt('far', ASIA)];
  await withFetch(async () => okResponse(proxyPayload({ events })), async () => {
    layer.init(viewer);
    layer.enable(viewer);
    await layer.update(viewer, {});
    const [entity] = viewer.sources[0].entities.values;
    assert.equal(entity.show, false, 'the marker is behind the limb');

    viewer._setPick({ id: entity });
    clicks.helpers.hover();
    // Otherwise the card floats in empty space over the near side of the globe.
    assert.ok(!host.last().some((e) => e.variant === 'card'));
    layer.destroy(viewer);
  });
});

test('hover picking is throttled and pauses while the camera moves', async () => {
  const camera = fakeCamera(NORTH_AMERICA.lon, NORTH_AMERICA.lat, 12_000_000);
  const viewer = viewerWithSources({ camera });
  const clicks = clickHandlerFactory();
  const layer = createEventsLayer({
    overlayHost: recordingHost(), screenSpaceEventHandlerFactory: clicks.factory,
  });
  let picks = 0;
  const events = [eventAt('near', NORTH_AMERICA)];
  await withFetch(async () => okResponse(proxyPayload({ events })), async () => {
    layer.init(viewer);
    layer.enable(viewer);
    await layer.update(viewer, {});
    viewer.scene.pick = () => { picks += 1; return null; };

    clicks.helpers.hover({ x: 1, y: 1 });
    const afterFirst = picks;
    assert.equal(afterFirst, 1, 'the first hover picks');
    for (let i = 0; i < 20; i += 1) clicks.helpers.hover({ x: i, y: i });
    assert.equal(picks, afterFirst, 'the throttle suppresses the burst');

    // Picking every frame of a drag is wasted work — the result is discarded
    // the moment the camera moves again.
    for (const fn of [...camera.moveStartListeners]) fn();
    const beforeMoving = picks;
    for (let i = 0; i < 20; i += 1) clicks.helpers.hover({ x: 200 + i, y: i });
    assert.equal(picks, beforeMoving, 'no picking while the camera is in motion');
    layer.destroy(viewer);
  });
});

test('the horizon pass runs during movement, not only when it ends', async () => {
  const camera = fakeCamera(NORTH_AMERICA.lon, NORTH_AMERICA.lat, 12_000_000);
  const viewer = viewerWithSources({ camera });
  const layer = createEventsLayer({
    overlayHost: recordingHost(), screenSpaceEventHandlerFactory: NOOP_HANDLER_FACTORY,
  });
  const events = [eventAt('near', NORTH_AMERICA), eventAt('far', ASIA)];
  await withFetch(async () => okResponse(proxyPayload({ events })), async () => {
    layer.init(viewer);
    layer.enable(viewer);
    await layer.update(viewer, {});
    const byId = new Map(viewer.sources[0].entities.values.map((e) => [e.id, e]));
    assert.equal(byId.get('far').show, false);

    // Nothing rides postRender while the camera is parked, so a settled scene
    // costs exactly zero and the layer keeps taking no continuous-render hold.
    assert.equal(viewer.scene.postRender.listeners.length, 0, 'parked: no subscription');

    for (const fn of [...camera.moveStartListeners]) fn();
    assert.equal(viewer.scene.postRender.listeners.length, 1, 'moving: subscribed');

    // Move the camera WITHOUT firing moveEnd — this is the drag/inertia case
    // the old moveEnd-only pass could not see.
    camera.positionWC = Cesium.Cartesian3.fromDegrees(ASIA.lon, ASIA.lat, 12_000_000);
    viewer.scene._renderFrames(1);
    assert.equal(byId.get('far').show, true, 'far side cleared mid-movement');
    assert.equal(byId.get('near').show, false);

    for (const fn of [...camera.moveEndListeners]) fn();
    assert.equal(viewer.scene.postRender.listeners.length, 0, 'settled: unsubscribed');
    layer.destroy(viewer);
  });
});

test('the in-motion pass is throttled and never touches percentageChanged', async () => {
  const camera = fakeCamera(NORTH_AMERICA.lon, NORTH_AMERICA.lat, 12_000_000);
  camera.percentageChanged = 0.5;
  const viewer = viewerWithSources({ camera });
  const layer = createEventsLayer({
    overlayHost: recordingHost(), screenSpaceEventHandlerFactory: NOOP_HANDLER_FACTORY,
  });
  const events = [eventAt('near', NORTH_AMERICA), eventAt('far', ASIA)];
  await withFetch(async () => okResponse(proxyPayload({ events })), async () => {
    layer.init(viewer);
    layer.enable(viewer);
    await layer.update(viewer, {});
    const byId = new Map(viewer.sources[0].entities.values.map((e) => [e.id, e]));

    for (const fn of [...camera.moveStartListeners]) fn();
    viewer.scene._renderFrames(1);
    // Move, then drive many frames inside one throttle window: the pass must
    // not run again, so the stale answer stands until the window expires.
    camera.positionWC = Cesium.Cartesian3.fromDegrees(ASIA.lon, ASIA.lat, 12_000_000);
    viewer.scene._renderFrames(30);
    assert.equal(byId.get('far').show, false, 'throttled out within the window');

    // camera.percentageChanged is a SHARED GLOBAL — traffic.js sets and
    // restores it, and a second layer mutating it would fight for one value.
    assert.equal(camera.percentageChanged, 0.5, 'left untouched');
    layer.destroy(viewer);
  });
});


// ── GKG entity card copy ────────────────────────────────────────────────────

test('entities replace the generic category line, which is the whole point', () => {
  const record = {
    id: '1', category: 'conflict', place: 'Shelby County, Tennessee, United States',
    severity: 87, numArticles: 7, domain: 'local3news.com',
  };
  const withEntities = eventHoverCardLines(record, {
    entities: { persons: ['george santos'], organizations: ['commodity futures trading commission'] },
  });
  assert.deepEqual(withEntities.details, [
    'CONFLICT · intensity 87',
    'George Santos',
    'Commodity Futures Trading Commission',
    'local3news.com · 7 reports',
  ]);
  // The category description is identical for every conflict event, so it is
  // dropped when something marker-specific is available.
  assert.ok(!withEntities.details.includes('Assault, fight, unconventional mass violence'));

  // ...and restored when nothing is.
  const bare = eventHoverCardLines(record, { entities: null });
  assert.ok(bare.details.includes('Assault, fight, unconventional mass violence'));
  assert.deepEqual(eventHoverCardLines(record).details, bare.details, 'entities are optional');
});

test('a shared source article is named, so identical entities read as intended', () => {
  const record = {
    id: '1', category: 'conflict', place: 'Shelby County, Tennessee', severity: 87,
    domain: 'local3news.com', numArticles: 7,
  };
  const two = eventHoverCardLines({ ...record, sharedArticle: { count: 2, places: ['Memphis'] } });
  assert.ok(two.details.includes('Same report as Memphis'));

  const three = eventHoverCardLines({
    ...record, sharedArticle: { count: 3, places: ['Rangiuru', 'Paengaroa'] },
  });
  assert.ok(three.details.includes('Same report as Rangiuru +1 more'));

  assert.ok(!eventHoverCardLines(record).details.some((d) => d.startsWith('Same report')));
});

test('entity lines stay whole rather than truncating mid-name', () => {
  const width = 46;
  // Two short organizations share a line; two long ones do not.
  assert.deepEqual(
    entityCardLines({ organizations: ['european commission', 'nato'] }, 'Brussels'),
    ['European Commission, NATO'],
  );
  assert.deepEqual(
    entityCardLines({
      organizations: ['commodity futures trading commission', 'white house'],
    }, 'Shelby County'),
    ['Commodity Futures Trading Commission'],
  );
  for (const line of entityCardLines({
    persons: ['a'.repeat(80)], organizations: [],
  }, 'X')) {
    assert.ok(line.length <= width, 'a single over-long name is clamped, not dropped');
  }
});

test('entities that merely repeat the place are dropped', () => {
  // The place is already the card title; "London" under "London" is noise.
  assert.deepEqual(entityCardLines({ organizations: ['london'] }, 'London, City of, United Kingdom'), []);
  // But a longer name that merely contains the place word is kept.
  assert.deepEqual(
    entityCardLines({ organizations: ['london school of economics'] }, 'London, United Kingdom'),
    ['London School of Economics'],
  );
});

test('entity casing handles connectors and known acronyms', () => {
  assert.equal(titleCaseEntity('parliament of trees'), 'Parliament of Trees');
  assert.equal(titleCaseEntity('justice league unlimited'), 'Justice League Unlimited');
  assert.equal(titleCaseEntity('nato'), 'NATO');
  assert.equal(titleCaseEntity('european commission'), 'European Commission');
  assert.equal(titleCaseEntity(''), '');
});

test('a fictional entity is rendered exactly like a real one — a stated limit', () => {
  // GDELT extracts entities from article text without distinguishing fiction
  // from reporting. These values are verbatim from a real comics article, and
  // there is nothing in the export or the GKG that reliably filters them.
  // See DATA_SOURCES.md; the card must not imply verification.
  const lines = entityCardLines({
    persons: ['jeremy adams', 'john ostrander'],
    organizations: ['parliament of trees', 'justice league unlimited'],
  }, 'Barcelona, Spain');
  assert.deepEqual(lines, [
    'Jeremy Adams, John Ostrander',
    'Parliament of Trees, Justice League Unlimited',
  ]);
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
