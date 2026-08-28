import * as Cesium from 'cesium';
import {
  clearOverlaySource,
  setOverlayEntries,
  setOverlaySourceVisible,
} from '../overlays/worldOverlay.js';
import {
  clearSelectedEntityContextForLayer,
  registerEntityContext,
  removeEntityContextsForLayer,
  selectEntityContext,
} from './contextStore.js';
import { isOwnedByOtherLayer, registerPickOwner, resolvePickId, unregisterPickOwner } from './pickRegistry.js';
import {
  EVENT_CATEGORIES,
  EVENT_SEVERITY_MODEL,
  eventMarkerPixelSize,
  normalizeEventCategories,
  selectEventsForRender,
} from './eventsFeed.js';

/**
 * GDELT geolocated events — trailing 24 h, five categories.
 *
 * Markers are `point` graphics in one `CustomDataSource`, NOT clamped ground
 * ellipses. `src/data/earthquakes.js` documents why in its header: 58
 * CLAMP_TO_GROUND ellipses with callback axes re-tessellate their ground
 * primitives every frame and cost 32.4 ms/frame against 1.4 ms static. Points
 * have no ground geometry at all, and every visual property here is a plain
 * number recomputed only when a poll brings new data — never a
 * `CallbackProperty`. With no per-frame animator the layer also takes no
 * continuous-render hold; the manager's `layer-tick` / `layer-visibility`
 * requests already cover every discrete mutation.
 *
 * WHAT THESE MARKERS ARE: a location GDELT's coverage clustered around, sized
 * by a coverage-intensity index (see `EVENT_SEVERITY_MODEL` in
 * `eventsFeed.js`). They are NOT verified incidents, casualty counts, or
 * damage assessments, and the coordinates are place centroids resolved from
 * article text rather than incident positions. That is also why this layer
 * deliberately implements NO `getDetectableObjects()`: feeding city centroids
 * into panoptic detection would draw target boxes on city centres and label
 * them as detected objects.
 */

const API_URL = '/api/events';

export const EVENTS_OVERLAY_SOURCE_ID = 'events';
export const EVENTS_OVERLAY_COHORT_LIMIT = 48;
export const EVENTS_OVERLAY_COLLISION_CAPACITY = 24;
/** Entity budget, applied AFTER the category filter — see `selectEventsForRender`. */
export const EVENTS_MAX_ENTITIES = 300;
/** Poll cadence. The proxy's own TTL is 15 min, matching GDELT's publish cycle. */
export const EVENTS_UPDATE_INTERVAL_MS = 10 * 60_000;

const DEFAULT_OVERLAY_HOST = Object.freeze({
  setEntries: setOverlayEntries,
  setVisible: setOverlaySourceVisible,
  clearSource: clearOverlaySource,
});

/**
 * Build the source-owned presentation for one ambient event label.
 * @param {object} input
 * @param {string} input.id Stable record id.
 * @param {Cesium.Cartesian3} input.position Ground anchor shared with the marker.
 * @param {string} input.title Short place label.
 * @param {string} input.accent Source-owned category color.
 * @param {number} input.severity Coverage-intensity index, 0..100.
 * @returns {object} Overlay entry.
 */
export function createEventOverlayEntry({ id, position, title, accent, severity }) {
  return {
    id: String(id),
    position,
    variant: 'label',
    title,
    accent,
    priority: Math.round((Number(severity) || 0) * 1000),
    collisionGroup: 'ambient-label',
    paintLane: 'ambient-label',
    interactive: false,
    edgeFade: 'keyhole',
    horizonCull: true,
    terrainOcclusion: false,
    gapPx: 15,
    verticalOnly: true,
    placement: 'above',
  };
}

/** Keep the highest-severity events, with stable identity as the tie-break. */
export function selectEventOverlayCohort(entries, limit = EVENTS_OVERLAY_COHORT_LIMIT) {
  const cap = Math.max(0, Math.min(
    EVENTS_OVERLAY_COHORT_LIMIT,
    Math.floor(Number(limit) || 0),
  ));
  if (!Array.isArray(entries) || cap === 0) return [];
  return entries.slice().sort((a, b) => (
    b.priority - a.priority || String(a.id).localeCompare(String(b.id))
  )).slice(0, cap);
}

/**
 * Short label for a marker: the place name, or its coordinates when GDELT
 * supplied no name.
 * @param {object} record Render record.
 * @returns {string} Label text.
 */
export function eventLabelText(record) {
  const place = String(record?.place || '').trim();
  if (place) return place.split(',')[0].slice(0, 28);
  const lat = Number(record?.lat);
  const lon = Number(record?.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return 'EVENT';
  return `${lat.toFixed(1)}, ${lon.toFixed(1)}`;
}

/**
 * Whether a click on an already-selected record should open its source.
 *
 * Click-through is deliberately TWO-STAGE: the first click selects, a second
 * click on the same record opens the article. Cesium's InfoBox is disabled
 * (`infoBox: false` in src/main.js) and the world overlay is canvas-drawn, so
 * there is no DOM surface that could hold a real anchor; a single click that
 * opened a tab would fire on any stray globe click during camera work.
 *
 * @param {?string} selectedId Currently selected record id.
 * @param {object} record Record just picked.
 * @returns {boolean} True when the pick should open the source URL.
 */
export function shouldOpenEventSource(selectedId, record) {
  if (!record || !selectedId) return false;
  if (selectedId !== record.id) return false;
  return Boolean(record.articles?.[0]?.url);
}

/**
 * Map one event record to a JSON-safe analyst record (analyst query engine
 * seam). Pure — no Cesium types. Missing/unknown fields are null, never
 * NaN/undefined.
 * @param {Object|null|undefined} raw Plain record values.
 * @param {number} [index=0] Position in the snapshot (fallback id only).
 * @returns {object} Analyst record.
 */
export function mapAnalystRecord(raw, index = 0) {
  const num = (v) => (Number.isFinite(v) ? v : null);
  const text = (v) => { const t = String(v ?? '').trim(); return t || null; };
  return {
    id: text(raw?.id) || `EVENT-${String(index).padStart(4, '0')}`,
    category: text(raw?.category),
    place: text(raw?.place),
    lat: num(raw?.lat),
    lon: num(raw?.lon),
    severity: num(raw?.severity),
    articleCount: num(raw?.count),
    sourceUrl: text(raw?.articles?.[0]?.url),
    headline: text(raw?.articles?.[0]?.title),
  };
}

/**
 * Construct a GDELT events layer.
 * @param {object} [options]
 * @param {object} [options.overlayHost] Injectable world-overlay host (tests).
 * @param {(url: string) => void} [options.openSource] Injectable source opener (tests).
 * @param {(canvas: object) => object} [options.screenSpaceEventHandlerFactory] Injectable handler.
 * @returns {object} Layer module.
 */
export function createEventsLayer({
  overlayHost = DEFAULT_OVERLAY_HOST,
  openSource = null,
  screenSpaceEventHandlerFactory = null,
} = {}) {
  let _dataSource = null;
  let _viewer = null;
  let _clickHandler = null;
  let _count = 0;
  let _lastUpdate = null;
  let _lastError = null;
  let _stale = false;
  let _enabled = false;
  let _loading = false;
  let _abort = null;
  let _selectedId = null;
  let _rowControlsListener = null;
  /** Merged records from the last successful poll, pre-filter. */
  let _records = [];
  /** Rendered records by entity id, for pick resolution. */
  const _renderedById = new Map();
  let _categories = normalizeEventCategories([]);

  const openArticle = typeof openSource === 'function'
    ? openSource
    : (url) => {
      if (typeof window !== 'undefined') window.open(url, '_blank', 'noopener,noreferrer');
    };

  const makeHandler = typeof screenSpaceEventHandlerFactory === 'function'
    ? screenSpaceEventHandlerFactory
    : (canvas) => new Cesium.ScreenSpaceEventHandler(canvas);

  /** Abort any in-flight poll. Safe to call repeatedly. */
  function abortInflight(reason = 'events layer aborted') {
    if (!_abort) return;
    const controller = _abort;
    _abort = null;
    _loading = false;
    try {
      controller.abort(reason);
    } catch {
      // an already-settled controller is not an error
    }
  }

  /** Rebuild entities and overlay labels from `_records` under the filter. */
  function render() {
    if (!_dataSource) return;
    const selected = selectEventsForRender(_records, {
      categories: _categories,
      maxEntities: EVENTS_MAX_ENTITIES,
    });
    _dataSource.entities.removeAll();
    _renderedById.clear();

    const overlayEntries = [];
    for (const record of selected) {
      const position = Cesium.Cartesian3.fromDegrees(record.lon, record.lat);
      const color = Cesium.Color.fromCssColorString(record.color);
      _dataSource.entities.add({
        id: record.id,
        position,
        point: {
          // Static values — see the module header. A CallbackProperty here
          // would put this layer back on the per-frame budget for nothing.
          pixelSize: eventMarkerPixelSize(record),
          color: color.withAlpha(0.85),
          outlineColor: color.withAlpha(1),
          outlineWidth: record.severity >= 60 ? 2 : 1,
          heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
        properties: {
          category: record.category,
          severity: record.severity,
          articleCount: record.count,
          place: record.place,
          sourceUrl: record.articles?.[0]?.url ?? null,
        },
      });
      _renderedById.set(record.id, record);
      overlayEntries.push(createEventOverlayEntry({
        id: record.id,
        position,
        title: eventLabelText(record),
        accent: record.color,
        severity: record.severity,
      }));
    }

    _count = selected.length;
    if (_enabled) {
      overlayHost.setEntries(
        EVENTS_OVERLAY_SOURCE_ID,
        selectEventOverlayCohort(overlayEntries),
        {
          cohortLimit: EVENTS_OVERLAY_COHORT_LIMIT,
          collisionCapacity: EVENTS_OVERLAY_COLLISION_CAPACITY,
          moving: false,
        },
      );
    }
    if (_selectedId && !_renderedById.has(_selectedId)) _selectedId = null;
  }

  /** Resolve a scene pick to one of this layer's rendered records, or null. */
  function pickedRecord(picked) {
    const pickId = resolvePickId(picked);
    if (!pickId) return null;
    return _renderedById.get(pickId) || null;
  }

  function installClickHandler(viewer) {
    if (_clickHandler || !viewer?.scene?.canvas) return;
    _clickHandler = makeHandler(viewer.scene.canvas);
    _clickHandler.setInputAction((click) => {
      if (!_enabled) return;
      const picked = viewer.scene.pick(click.position);
      const record = pickedRecord(picked);
      if (!record) {
        const pickId = resolvePickId(picked);
        // Another layer's pick is not "empty space" — leave its selection be.
        if (pickId && isOwnedByOtherLayer('events', pickId)) return;
        if (_selectedId) {
          _selectedId = null;
          try {
            clearSelectedEntityContextForLayer('events');
          } catch { /* context store unavailable */ }
        }
        return;
      }
      // Two-stage: select first, open on a repeat click. See
      // `shouldOpenEventSource`.
      if (shouldOpenEventSource(_selectedId, record)) {
        openArticle(record.articles[0].url);
        return;
      }
      _selectedId = record.id;
      // Context is registered ON SELECTION, not per rendered marker: a poll
      // renders up to EVENTS_MAX_ENTITIES of them every ten minutes and the
      // shared store has no eviction of its own, so registering all of them
      // would grow it without bound to feed a record only the clicked marker
      // ever reads.
      try {
        const entity = _dataSource?.entities?.getById?.(record.id);
        if (entity) {
          registerEntityContext(entity, {
            id: record.id,
            layerId: 'events',
            kind: 'event',
            label: eventLabelText(record),
            category: record.categoryLabel,
            severity: record.severity,
            place: record.place,
            articles: record.articles,
          });
          selectEntityContext(entity);
        }
      } catch { /* context store unavailable */ }
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
  }

  function removeClickHandler() {
    if (!_clickHandler) return;
    try {
      _clickHandler.destroy?.();
    } catch { /* already destroyed */ }
    _clickHandler = null;
  }

  const layer = {
    id: 'events',
    name: 'World Events (24h)',
    icon: '📰',
    source: 'GDELT',
    updateInterval: EVENTS_UPDATE_INTERVAL_MS,

    init(viewer) {
      _viewer = viewer;
      _dataSource = new Cesium.CustomDataSource('events');
      _dataSource.show = false;
      viewer.dataSources.add(_dataSource);
      _count = 0;
      _lastUpdate = null;
      _lastError = null;
      _stale = false;
      _enabled = false;
      _loading = false;
      _selectedId = null;
      _records = [];
      _renderedById.clear();
      overlayHost.setVisible(EVENTS_OVERLAY_SOURCE_ID, false);
      console.log('[Data:Events] Initialized');
    },

    enable(viewer) {
      _enabled = true;
      if (_dataSource) _dataSource.show = true;
      overlayHost.setVisible(EVENTS_OVERLAY_SOURCE_ID, true);
      registerPickOwner('events', (pickedId) => _renderedById.has(String(pickedId)));
      installClickHandler(viewer || _viewer);
      render();
    },

    disable(viewer) {
      _enabled = false;
      // Abort BEFORE clearing: a poll still in flight would otherwise land on
      // a disabled layer and republish the overlay source it just cleared.
      abortInflight('events layer disabled');
      removeClickHandler();
      unregisterPickOwner('events');
      if (_selectedId) {
        _selectedId = null;
        try {
          clearSelectedEntityContextForLayer('events');
        } catch { /* context store unavailable */ }
      }
      try {
        removeEntityContextsForLayer('events');
      } catch { /* context store unavailable */ }
      if (_dataSource) _dataSource.show = false;
      overlayHost.clearSource(EVENTS_OVERLAY_SOURCE_ID);
      overlayHost.setVisible(EVENTS_OVERLAY_SOURCE_ID, false);
    },

    /**
     * Poll `/api/events` and swap in the new records.
     *
     * Honours BOTH cancellation authorities: the manager's `options.signal`
     * and a layer-owned controller that `disable()`/`destroy()` abort. An
     * AbortError is RETHROWN rather than swallowed — `manager.js` classifies
     * it via `isAbortError()` as a cancelled transition, so a toggle-off is
     * never recorded as a fetch failure in `getStats().error`.
     *
     * @param {object} viewer Active viewer (unused; entities live on the source).
     * @param {object} [options]
     * @param {?AbortSignal} [options.signal] Caller cancellation authority.
     * @returns {Promise<boolean>} False when the poll produced no new data.
     */
    async update(viewer, { signal = null } = {}) {
      if (signal?.aborted) {
        const error = new Error('events update aborted before start');
        error.name = 'AbortError';
        throw error;
      }
      abortInflight('superseded by a newer events poll');
      const controller = new AbortController();
      _abort = controller;
      _loading = true;
      const onOuterAbort = () => controller.abort(signal?.reason || 'aborted');
      signal?.addEventListener?.('abort', onOuterAbort, { once: true });

      try {
        const response = await fetch(API_URL, { signal: controller.signal });
        if (!response.ok) {
          _lastError = response.status === 429
            ? 'GDELT daily budget reached'
            : `GDELT proxy HTTP ${response.status}`;
          console.warn(`[Data:Events] Proxy returned ${response.status}`);
          return false;
        }
        const payload = await response.json();
        if (!payload || !Array.isArray(payload.events)) {
          _lastError = 'Malformed events response';
          return false;
        }

        _records = payload.events;
        _stale = payload.stale === true;
        render();
        _lastUpdate = Date.now();
        _lastError = null;
        const failed = (payload.categories || []).filter((entry) => entry.ok === false);
        if (failed.length) {
          _lastError = `${failed.length}/${EVENT_CATEGORIES.length} categories unavailable`;
        }
        console.log(`[Data:Events] Updated: ${_count} locations (${EVENT_SEVERITY_MODEL})`);
        _rowControlsListener?.();
        return true;
      } catch (e) {
        if (e?.name === 'AbortError') throw e;
        console.warn('[Data:Events] Fetch error:', e);
        _lastError = 'Events proxy unreachable';
        return false;
      } finally {
        signal?.removeEventListener?.('abort', onOuterAbort);
        if (_abort === controller) {
          _abort = null;
          _loading = false;
        }
      }
    },

    destroy(viewer) {
      _enabled = false;
      abortInflight('events layer destroyed');
      removeClickHandler();
      unregisterPickOwner('events');
      try {
        clearSelectedEntityContextForLayer('events');
        removeEntityContextsForLayer('events');
      } catch { /* context store unavailable */ }
      overlayHost.clearSource(EVENTS_OVERLAY_SOURCE_ID);
      overlayHost.setVisible(EVENTS_OVERLAY_SOURCE_ID, false);
      if (_dataSource) {
        (viewer || _viewer)?.dataSources?.remove(_dataSource, true);
        _dataSource = null;
      }
      _viewer = null;
      _records = [];
      _renderedById.clear();
      _selectedId = null;
      _count = 0;
      _lastUpdate = null;
      _lastError = null;
      _stale = false;
    },

    /**
     * Apply runtime parameters. Only `categories` is supported; an unusable
     * value is rejected so the manager reports it rather than silently
     * blanking the layer.
     * @param {object} params Requested parameters.
     * @returns {boolean} False rejects the parameter intent.
     */
    setParams(params = {}) {
      if (!Object.hasOwn(params, 'categories')) return true;
      const requested = params.categories;
      if (requested !== null && requested !== undefined && !Array.isArray(requested)) return false;
      _categories = normalizeEventCategories(requested);
      render();
      return true;
    },

    /** Current runtime parameters, read back by the manager after `setParams`. */
    getParams() {
      return { categories: [..._categories] };
    },

    /**
     * Category filter chips plus a colour legend with live counts. Chips are
     * stateless descriptors — the manager owns the write through
     * `setLayerParams`, so restore and share links stay the single source of
     * truth. Mirrors `satellites.js`.
     * @returns {{chips: Array<object>, legend: Array<object>}} Row controls.
     */
    getRowControls() {
      const active = new Set(_categories);
      const tally = new Map(EVENT_CATEGORIES.map((entry) => [entry.id, 0]));
      for (const record of _renderedById.values()) {
        tally.set(record.category, (tally.get(record.category) || 0) + 1);
      }
      return {
        chips: EVENT_CATEGORIES.map((entry) => {
          const isActive = active.has(entry.id);
          // Turning the last active chip off would blank the layer, and
          // `normalizeEventCategories` would silently restore all five —
          // so the chip refuses instead of lying about the result.
          const isLastActive = isActive && active.size === 1;
          const next = isActive
            ? _categories.filter((id) => id !== entry.id)
            : [..._categories, entry.id];
          return {
            id: entry.id,
            label: entry.label,
            active: isActive,
            disabled: isLastActive,
            state: isActive ? 'active' : 'idle',
            title: isLastActive
              ? `${entry.label} is the only active category`
              : `${isActive ? 'Hide' : 'Show'} ${entry.label.toLowerCase()} events`,
            params: { categories: next },
          };
        }),
        legend: EVENT_CATEGORIES
          .filter((entry) => active.has(entry.id))
          .map((entry) => ({
            label: entry.label,
            color: entry.color,
            count: tally.get(entry.id) || 0,
            blurb: 'Coverage volume, not a verified incident count',
          })),
      };
    },

    /** Install the manager's "row controls changed" callback. */
    setRowControlsListener(listener) {
      _rowControlsListener = typeof listener === 'function' ? listener : null;
    },

    /**
     * Snapshot the rendered events as plain JSON-safe records for the analyst
     * query engine. On-demand only — no listeners, no caching.
     * @param {number} [maxCount=2000] Maximum records to return.
     * @returns {Array<Object>} See `mapAnalystRecord`.
     */
    getAnalystRecords(maxCount = 2000) {
      if (!_dataSource || !_dataSource.show) return [];
      const limit = Number.isFinite(maxCount) ? Math.max(1, Math.floor(maxCount)) : 2000;
      const result = [];
      for (const record of _renderedById.values()) {
        if (result.length >= limit) break;
        result.push(mapAnalystRecord(record, result.length));
      }
      return result;
    },

    getStats() {
      return {
        count: _count,
        lastUpdate: _lastUpdate,
        error: _lastError,
        loading: _loading,
        stale: _stale,
      };
    },
  };
  return layer;
}

const eventsLayer = createEventsLayer();

export default eventsLayer;
