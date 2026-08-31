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
import { horizonOccluder } from './iconOrientation.js';
// Reused rather than reimplemented: `applyHorizonCull` is written against any
// `{length, get(i)}` shape precisely so it is not billboard-specific, and this
// layer's entities satisfy it. See the horizon-culling note in the header.
import { applyHorizonCull } from './firmsHeatmap.js';
import { governorRequestRender } from '../renderGovernor.js';
import {
  EVENT_CATEGORIES,
  EVENT_SEVERITY_MODEL,
  eventCategory,
  eventMarkerPixelSize,
  normalizeEventCategories,
  selectEventsForRender,
} from './eventsFeed.js';

/**
 * GDELT CAMEO political-interaction events — a rolling window, five categories.
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
 * WHAT THESE MARKERS ARE: one CAMEO-coded political interaction between two
 * actors, extracted by GDELT from a news article, plotted at the place the
 * action was coded to and sized by `EVENT_SEVERITY_MODEL` in `eventsFeed.js`.
 *
 * WHAT THEY ARE NOT: verified incidents, casualty counts, or damage
 * assessments. The coordinates are city centroids resolved from article text,
 * not incident positions, and the underlying record is an assertion about what
 * an article said — not a confirmed fact. This layer also covers only what
 * CAMEO can express: political interactions. It carries no natural disasters
 * (see the `earthquakes` and FIRMS layers), no humanitarian-need signal, and
 * no market data, because CAMEO has no codes for any of them.
 *
 * That centroid property is also why this layer deliberately implements NO
 * `getDetectableObjects()`: feeding city centroids into panoptic detection
 * would draw target boxes on city centres and label them as detected objects.
 *
 * HORIZON CULLING IS MANDATORY HERE, NOT AN OPTIMISATION. These markers set
 * `disableDepthTestDistance: Number.POSITIVE_INFINITY` so a marker is never
 * swallowed by the terrain it stands on — which also means NOTHING occludes
 * them, and events in Asia render straight through the planet while the camera
 * is over North America. That is true in BOTH map stacks: on google-3d the
 * Cesium globe is hidden so nothing writes far-side depth at all, and on the
 * globe stacks the depth that is written is overridden by that same flag. The
 * fix is the explicit `EllipsoidalOccluder` pass every other always-on-top
 * layer runs (`radio.js`, `cctv.js`, `flights.js`, `firmsHeatmap.js`),
 * recomputed on `camera.moveEnd` — never per frame, so the layer keeps taking
 * no continuous-render hold.
 */

const API_URL = '/api/events';

export const EVENTS_OVERLAY_SOURCE_ID = 'events';
export const EVENTS_OVERLAY_COHORT_LIMIT = 48;
export const EVENTS_OVERLAY_COLLISION_CAPACITY = 24;
/** Entity budget, applied AFTER the category filter — see `selectEventsForRender`. */
export const EVENTS_MAX_ENTITIES = 300;
/** Poll cadence. The proxy's own TTL is 15 min, matching GDELT's publish cycle. */
export const EVENTS_UPDATE_INTERVAL_MS = 10 * 60_000;
/**
 * Height of the occlusion-test point, in metres. NEVER used for rendering.
 *
 * Marker positions are built at height 0 — exactly on the WGS84 ellipsoid —
 * and `EllipsoidalOccluder` treats an exactly-on-ellipsoid point as a limb
 * boundary case, judging it hidden slightly BEFORE the true tangent. Measured
 * against Cesium from a 1.5 Mm camera over Austin, a height-0 point goes hidden
 * at 41.82° of longitude offset while a lifted one survives to 41.95°, so a
 * band of near-limb markers would blink out for a datum reason rather than a
 * geometric one. Height 0 behaves identically to a point 22 m UNDERGROUND.
 *
 * 12 m matches the lift the flights and FIRMS layers already use for the same
 * reason (`CULL_LIFT_M` in `firmsHeatmap.js`, whose `cellCullPosition` documents
 * the identical height-0 case for aggregated heat cells).
 */
export const EVENTS_CULL_LIFT_M = 12;
/**
 * Throttle for the horizon pass while the camera is in motion, in ms.
 *
 * The pass itself is not the cost — measured at 0.025 ms for 300 entities,
 * about 0.15% of a frame — so this is a courtesy bound rather than a budget.
 * 120 ms matches the CCTV hover throttle and keeps the far side clearing
 * visibly during a drag without running on every single frame.
 */
export const EVENTS_MOVING_CULL_THROTTLE_MS = 120;
/** Throttle for the hover pick pass, in ms. Matches the CCTV hover throttle. */
export const EVENTS_HOVER_THROTTLE_MS = 120;
/**
 * How far the pointer may travel between press and release and still count as
 * a click rather than a drag, in CSS pixels.
 *
 * This is the safeguard that replaces the old two-stage click. Opening a tab on
 * a single click is only safe if a click that ENDED A CAMERA DRAG cannot
 * trigger it — dragging the globe frequently finishes with the pointer over
 * some marker, and without this every such drag would open an article.
 */
export const EVENTS_CLICK_DRAG_TOLERANCE_PX = 5;
/** Longest line rendered on the hover card before truncation. */
const CARD_LINE_CHARS = 46;

const DEFAULT_OVERLAY_HOST = Object.freeze({
  setEntries: setOverlayEntries,
  setVisible: setOverlaySourceVisible,
  clearSource: clearOverlaySource,
});

/**
 * Occlusion-test anchor for one record: the marker's ground position lifted to
 * `EVENTS_CULL_LIFT_M`. This NEVER feeds rendering — the marker itself is
 * clamped to ground, and drawing it 12 m up would float it off the terrain.
 * @param {number} lon Longitude in degrees.
 * @param {number} lat Latitude in degrees.
 * @returns {Cesium.Cartesian3} Lifted anchor.
 */
export function eventCullPosition(lon, lat) {
  return Cesium.Cartesian3.fromDegrees(lon, lat, EVENTS_CULL_LIFT_M);
}

/**
 * Build the source-owned presentation for one ambient event label.
 * @param {object} input
 * @param {string} input.id Stable record id.
 * @param {Cesium.Cartesian3} input.position Ground anchor shared with the marker.
 * @param {string} input.title Short place label.
 * @param {string} input.accent Source-owned category color.
 * @param {number} input.severity CAMEO intensity index, 0..100.
 * @param {Cesium.Cartesian3} [input.cullPosition] Lifted occlusion anchor; the
 *   overlay host tests this instead of `position` so a label does not
 *   false-hide at the limb for the datum reason described on
 *   `EVENTS_CULL_LIFT_M`.
 * @returns {object} Overlay entry.
 */
export function createEventOverlayEntry({ id, position, title, accent, severity, cullPosition }) {
  return {
    id: String(id),
    position,
    cullPosition: cullPosition || position,
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
 * Whether a pointer press/release pair is a drag rather than a click.
 *
 * Pure and unit-testable. A missing endpoint counts as a drag: if we cannot
 * prove the pointer stayed put we must not open a tab.
 *
 * @param {?{x: number, y: number}} down Press position, canvas pixels.
 * @param {?{x: number, y: number}} up Release position, canvas pixels.
 * @param {object} [options]
 * @param {number} [options.tolerancePx=EVENTS_CLICK_DRAG_TOLERANCE_PX] Slop.
 * @returns {boolean} True when the gesture should NOT open anything.
 */
export function isDragGesture(down, up, { tolerancePx = EVENTS_CLICK_DRAG_TOLERANCE_PX } = {}) {
  if (!down || !up) return true;
  const dx = Number(up.x) - Number(down.x);
  const dy = Number(up.y) - Number(down.y);
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return true;
  return Math.hypot(dx, dy) > tolerancePx;
}

/**
 * Whether a completed click should open the record's source.
 *
 * Single-click-to-open, guarded by drag discrimination. The layer previously
 * required two clicks (select, then open) for exactly one reason: Cesium's
 * InfoBox is disabled (`infoBox: false` in src/main.js) and the world overlay
 * is canvas-drawn, so there is no DOM anchor, and a naive single click would
 * fire on any stray globe click during camera work. That hazard is real and
 * has NOT gone away — it is now handled by `isDragGesture` instead of by
 * making every user click twice.
 *
 * @param {?object} record Record under the pointer.
 * @param {object} [gesture]
 * @param {boolean} [gesture.dragged=false] Whether the click ended a drag.
 * @returns {boolean} True when the click should open the source URL.
 */
export function shouldOpenEventSource(record, { dragged = false } = {}) {
  if (!record || dragged) return false;
  return Boolean(record.url);
}

/** Words that stay lowercase inside a name, and ones that are acronyms. */
const NAME_MINOR = new Set(['of', 'the', 'and', 'for', 'de', 'la', 'van', 'von', 'al', 'du']);
const NAME_ACRONYMS = new Set(['us', 'uk', 'un', 'eu', 'nato', 'fbi', 'cia', 'nasa', 'who', 'nhs']);

/**
 * Restore casing on a GKG entity name, which GDELT delivers lowercased.
 *
 * Deliberately conservative: it title-cases, keeps a short list of connecting
 * words lowercase, and upper-cases a short list of acronyms. It will still get
 * some names wrong (`Mcdonald`, an unlisted acronym) — the alternative is a
 * name dictionary, which is a bigger dependency than the problem deserves.
 *
 * @param {string} value Lowercased entity name.
 * @returns {string} Display casing.
 */
export function titleCaseEntity(value) {
  return String(value ?? '').split(/\s+/).filter(Boolean).map((word, index) => {
    const lower = word.toLowerCase();
    if (NAME_ACRONYMS.has(lower)) return lower.toUpperCase();
    if (index > 0 && NAME_MINOR.has(lower)) return lower;
    return lower.charAt(0).toUpperCase() + lower.slice(1);
  }).join(' ');
}

/**
 * Entity lines for the card: persons on one line, organizations on the next.
 *
 * Two lines rather than one because organization names are long — a single
 * "person · org" line truncates mid-word on the card's width more often than
 * not. Entities that merely repeat the event's own place are dropped: the
 * place is already the card title, so "London" under "London" is noise.
 *
 * @param {?object} entities Parsed GKG record for this event's article.
 * @param {string} place The event's place, to suppress duplicates of it.
 * @returns {Array<string>} Zero, one or two lines.
 */
export function entityCardLines(entities, place) {
  const placeWords = new Set(String(place || '').toLowerCase().split(/[\s,]+/).filter(Boolean));
  const keep = (name) => {
    const words = String(name).toLowerCase().split(/\s+/);
    return !(words.length <= 2 && words.every((word) => placeWords.has(word)));
  };
  // Greedy fit rather than a fixed count: two short organizations sit on one
  // line comfortably, two long ones truncate mid-word. Taking the second name
  // only when it fits keeps every line whole, which matters more than showing
  // one extra entity.
  const fit = (names) => {
    let line = '';
    for (const name of names) {
      const next = line ? `${line}, ${name}` : name;
      if (next.length > CARD_LINE_CHARS) break;
      line = next;
    }
    // A single name longer than the line still gets shown, clamped — dropping
    // it entirely would lose the only entity the article had.
    return line || clampCardLine(names[0] || '');
  };

  const lines = [];
  const people = (entities?.persons || []).filter(keep).map(titleCaseEntity);
  const orgs = (entities?.organizations || []).filter(keep).map(titleCaseEntity);
  if (people.length) lines.push(fit(people));
  if (orgs.length) lines.push(fit(orgs));
  return lines;
}

/** Truncate one card line without breaking mid-escape. */
function clampCardLine(value) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > CARD_LINE_CHARS ? `${text.slice(0, CARD_LINE_CHARS - 1)}…` : text;
}

/**
 * Hover-card copy for one record.
 *
 * WHAT THIS DELIBERATELY DOES NOT SHOW. The export carries no article
 * headline, and the obvious substitute — an "Actor1 → Actor2" summary — does
 * not survive contact with the data: across the fixture Actor1Name is filled
 * on 86% of rows, Actor2Name on 58%, and BOTH on only 44%, and where present
 * they are frequently generic roles rather than named parties (`SCHOOL`,
 * `POLICE`, `IMAM`, `FIREFIGHTER`) with Actor1 blank. A pair line would read as
 * nonsense on most markers.
 *
 * A CAMEO leaf-code verb ("Arrest or detain") would be the informative
 * addition, but no cleanly-licensed machine-readable code→label table could be
 * found: the two community tables carry NO license at all, and the one MIT
 * repository ships a verb-pattern dictionary rather than a label map. See
 * `docs/PHASE1-DECISIONS.md` §14.
 *
 * WHAT IT SHOWS INSTEAD. When GKG entities are available for the article, the
 * card names the people and organizations in it — marker-specific, where the
 * category description is identical for every event in its category. Those
 * entities are extracted by GDELT from article text and are NOT verified: the
 * extractor does not distinguish fiction from reporting, so a comics article
 * yields "Parliament Of Trees, Justice League Unlimited" as organizations.
 * Without entities the card falls back to the category description.
 *
 * @param {object} record Render record.
 * @param {object} [options]
 * @param {?object} [options.entities] Parsed GKG record for this article.
 * @returns {{title: string, details: Array<string>}} Card copy.
 */
export function eventHoverCardLines(record, { entities = null } = {}) {
  const spec = eventCategory(record?.category);
  const details = [];
  const severity = Number(record?.severity);
  const label = spec?.label || String(record?.category || '').toUpperCase();
  details.push(clampCardLine(
    Number.isFinite(severity) ? `${label} · intensity ${severity}` : label,
  ));
  // Entities REPLACE the category description rather than joining it — naming
  // them is the whole point, and keeping both would push the card past the
  // width where its lines stay readable.
  const entityLines = entityCardLines(entities, record?.place);
  if (entityLines.length) details.push(...entityLines);
  else if (spec?.blurb) details.push(clampCardLine(spec.blurb));

  const reports = Number(record?.numArticles);
  const domain = String(record?.domain || '').trim();
  const coverage = Number.isFinite(reports) && reports > 0
    ? `${reports} report${reports === 1 ? '' : 's'}`
    : '';
  const sourceLine = [domain, coverage].filter(Boolean).join(' · ');
  if (sourceLine) details.push(clampCardLine(sourceLine));

  // One article often places events at several spots, and GKG entities are per
  // ARTICLE — so those markers carry identical names. Saying so turns a
  // repetition that reads as a bug into the fact it actually is.
  const shared = record?.sharedArticle;
  if (shared && Array.isArray(shared.places) && shared.places.length) {
    const [first, ...rest] = shared.places;
    details.push(clampCardLine(rest.length
      ? `Same report as ${first} +${rest.length} more`
      : `Same report as ${first}`));
  }

  // A marker for something GDELT coded to a date well before it ingested the
  // row must not read as "happening now".
  const retro = Number(record?.retrospectiveDays);
  if (Number.isFinite(retro) && retro > 0) {
    details.push(clampCardLine(`Event dated ${retro} day${retro === 1 ? '' : 's'} earlier`));
  }
  return { title: clampCardLine(eventLabelText(record)), details };
}

/**
 * Build the hover card overlay entry for one record.
 * @param {object} record Render record.
 * @param {Cesium.Cartesian3} position Ground anchor.
 * @param {Cesium.Cartesian3} cullPosition Lifted occlusion anchor.
 * @returns {object} Overlay entry.
 */
export function createEventHoverCardEntry(record, position, cullPosition) {
  const { title, details } = eventHoverCardLines(record);
  return {
    id: `${record.id}:card`,
    position,
    cullPosition: cullPosition || position,
    variant: 'card',
    title,
    details,
    accent: record.color,
    // Above every ambient label, so the card a pointer is resting on is never
    // decluttered away by a neighbour.
    priority: Number.MAX_SAFE_INTEGER,
    collisionGroup: 'ambient-card',
    paintLane: 'ambient-card',
    interactive: false,
    edgeFade: 'keyhole',
    horizonCull: true,
    terrainOcclusion: false,
    gapPx: 18,
    verticalOnly: true,
    placement: 'above',
  };
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
    articleCount: num(raw?.numArticles),
    sourceUrl: text(raw?.url),
    sourceDomain: text(raw?.domain),
    rootCode: text(raw?.rootCode),
    countryFips: text(raw?.countryFips),
    // Day the event was coded to happen, which can precede ingest. Exposed as
    // a distinct field so a query can tell a fresh event from a retrospective
    // one rather than reading the ingest time as the event time.
    retrospectiveDays: num(raw?.retrospectiveDays),
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
  /** Slices actually held by the proxy, and the depth it is aiming for. */
  let _sliceCount = null;
  let _windowSlices = null;
  let _enabled = false;
  let _loading = false;
  let _abort = null;
  let _selectedId = null;
  let _rowControlsListener = null;
  /** camera.moveEnd handle for the horizon pass; removed on disable/destroy. */
  let _horizonCullListener = null;
  /** camera.moveStart handle: opens the in-motion window. */
  let _moveStartListener = null;
  /** scene.postRender disposer, held ONLY while the camera is in motion. */
  let _movingRenderListener = null;
  /** Timestamp of the last in-motion pass, for the throttle. */
  let _lastMovingCullAt = 0;
  /** True between moveStart and moveEnd; hover picking pauses while set. */
  let _cameraMoving = false;
  /** Record id under the pointer, or null. */
  let _hoverId = null;
  /** Canvas position of the last LEFT_DOWN, for drag discrimination. */
  let _pointerDownAt = null;
  /** Timestamp of the last hover pick, for the throttle. */
  let _lastHoverPickAt = 0;
  /** Latest pointer position awaiting the throttle's trailing edge. */
  let _hoverPending = null;
  /** Trailing-edge timer handle. */
  let _hoverTrailingTimer = 0;
  /** Ambient label entries from the last render, republished on hover change. */
  let _labelEntries = [];
  /** Last camera position the horizon pass ran against, for the skip check. */
  let _lastCullCameraPosition = null;
  /**
   * Index-aligned occlusion inputs for `applyHorizonCull`. Kept beside the
   * entities rather than on the render records so nothing JSON-facing
   * (`getAnalystRecords`) ever sees a Cesium type.
   * @type {{entities: Array<object>, cullPositions: Array<Cesium.Cartesian3>}}
   */
  let _cullTargets = { entities: [], cullPositions: [] };
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
    _cullTargets = { entities: [], cullPositions: [] };

    const overlayEntries = [];
    for (const record of selected) {
      const position = Cesium.Cartesian3.fromDegrees(record.lon, record.lat);
      const cullPosition = eventCullPosition(record.lon, record.lat);
      const color = Cesium.Color.fromCssColorString(record.color);
      const entity = _dataSource.entities.add({
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
          articleCount: record.numArticles,
          place: record.place,
          rootCode: record.rootCode,
          retrospectiveDays: record.retrospectiveDays,
          sourceUrl: record.url ?? null,
        },
      });
      _renderedById.set(record.id, record);
      _cullTargets.entities.push(entity);
      _cullTargets.cullPositions.push(cullPosition);
      overlayEntries.push(createEventOverlayEntry({
        id: record.id,
        position,
        cullPosition,
        title: eventLabelText(record),
        accent: record.color,
        severity: record.severity,
      }));
    }

    _count = selected.length;
    _labelEntries = overlayEntries;
    if (_hoverId && !_renderedById.has(_hoverId)) _hoverId = null;
    publishOverlay();
    if (_selectedId && !_renderedById.has(_selectedId)) _selectedId = null;
    // A rebuild produces entities defaulting to show=true, so the pass must run
    // before the next frame or a poll would flash far-side markers for a tick.
    applyEventHorizonCull({ force: true });
  }

  /**
   * Hide markers the planet is in front of.
   *
   * Event-driven, never per frame: `camera.moveEnd` is the only trigger
   * besides a render rebuild, and the position check below makes a repeated
   * call with a stationary camera free. `applyHorizonCull` writes `show` only
   * when it actually flips, so a settled camera dirties nothing.
   *
   * This is deliberately NOT subscribed to `gev:map-stack-changed`. The test
   * is pure camera-vs-WGS84 geometry with no dependency on surface heights, so
   * it gives the same answer in every map stack — unlike CCTV, whose geometry
   * genuinely resolves differently between photoreal and globe regimes. A
   * stack swap that also moves the camera is covered by `moveEnd` anyway.
   *
   * @param {object} [options]
   * @param {boolean} [options.force=false] Run even if the camera has not moved.
   */
  function applyEventHorizonCull({ force = false } = {}) {
    if (!_dataSource || !_viewer?.camera) return;
    const cameraPosition = _viewer.camera.positionWC;
    if (!force && _lastCullCameraPosition && cameraPosition
      && _lastCullCameraPosition.x === cameraPosition.x
      && _lastCullCameraPosition.y === cameraPosition.y
      && _lastCullCameraPosition.z === cameraPosition.z) {
      return;
    }
    _lastCullCameraPosition = cameraPosition
      ? { x: cameraPosition.x, y: cameraPosition.y, z: cameraPosition.z }
      : null;

    const occluder = horizonOccluder(_viewer.camera);
    if (!occluder) return;
    const { entities, cullPositions } = _cullTargets;
    const before = entities.filter((entity) => entity.show !== false).length;
    const visible = applyHorizonCull(
      { length: entities.length, get: (index) => entities[index] },
      occluder,
      cullPositions,
    );
    // The pass can land after the camera settles and the governor parks the
    // scene; a changed show flag needs one frame to become visible.
    if (visible !== before) governorRequestRender('events-horizon');
  }

  /**
   * Publish the ambient label cohort, plus the hover card when one is up.
   *
   * The hovered record's own LABEL is dropped while its card is showing — the
   * card already carries the place name, and leaving both would stack two
   * copies of it over the same marker.
   */
  function publishOverlay() {
    if (!_enabled) return;
    const cohort = selectEventOverlayCohort(
      _hoverId ? _labelEntries.filter((entry) => entry.id !== _hoverId) : _labelEntries,
    );
    const card = hoverCardEntry();
    overlayHost.setEntries(
      EVENTS_OVERLAY_SOURCE_ID,
      card ? [...cohort, card] : cohort,
      {
        cohortLimit: EVENTS_OVERLAY_COHORT_LIMIT,
        collisionCapacity: EVENTS_OVERLAY_COLLISION_CAPACITY,
        moving: _cameraMoving,
      },
    );
  }

  /** Overlay entry for the hovered record's card, or null when none. */
  function hoverCardEntry() {
    if (!_hoverId) return null;
    const record = _renderedById.get(_hoverId);
    if (!record) return null;
    const index = _cullTargets.entities.findIndex((entity) => entity.id === _hoverId);
    if (index < 0) return null;
    // A card over a marker the planet is hiding would float in empty space.
    if (_cullTargets.entities[index].show === false) return null;
    return createEventHoverCardEntry(
      record,
      Cesium.Cartesian3.fromDegrees(record.lon, record.lat),
      _cullTargets.cullPositions[index],
    );
  }

  /** Pick at a pointer position and move the hover to whatever is under it. */
  function runHoverPick(viewer, endPosition) {
    _lastHoverPickAt = Date.now();
    const picked = viewer?.scene?.pick?.(endPosition);
    const record = pickedRecord(picked);
    setHover(record ? record.id : null);
  }

  /** Cancel any queued trailing hover pick. */
  function clearHoverTrailing() {
    if (_hoverTrailingTimer) clearTimeout(_hoverTrailingTimer);
    _hoverTrailingTimer = 0;
    _hoverPending = null;
  }

  /** Grow the hovered marker so the pointer target is unambiguous. */
  function setHoverStyle(id, hovered) {
    const record = _renderedById.get(id);
    const entity = _dataSource?.entities?.getById?.(id);
    if (!record || !entity?.point) return;
    const base = eventMarkerPixelSize(record);
    entity.point.pixelSize = hovered ? Math.round((base + 4) * 10) / 10 : base;
    entity.point.outlineWidth = hovered ? 3 : (record.severity >= 60 ? 2 : 1);
  }

  /** Move the hover to `id` (or clear it), restyling and republishing once. */
  function setHover(id) {
    if (_hoverId === id) return;
    if (_hoverId) setHoverStyle(_hoverId, false);
    _hoverId = id;
    if (_hoverId) setHoverStyle(_hoverId, true);
    publishOverlay();
    governorRequestRender('events-hover');
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
      // Single click opens, UNLESS the click ended a camera drag. See
      // `isDragGesture` — dropping that check would mean every globe drag that
      // happens to finish over a marker opens an article.
      const dragged = isDragGesture(_pointerDownAt, click.position);
      _pointerDownAt = null;
      if (shouldOpenEventSource(record, { dragged })) {
        _selectedId = record.id;
        openArticle(record.url);
      } else {
        _selectedId = record.id;
      }
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
            sourceUrl: record.url,
            sourceDomain: record.domain,
            articleCount: record.numArticles,
            retrospectiveDays: record.retrospectiveDays,
          });
          selectEntityContext(entity);
        }
      } catch { /* context store unavailable */ }
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);

    // Press position, for drag discrimination on release.
    _clickHandler.setInputAction((event) => {
      _pointerDownAt = event?.position
        ? { x: event.position.x, y: event.position.y }
        : null;
    }, Cesium.ScreenSpaceEventType.LEFT_DOWN);

    // Hover. Throttled, and skipped entirely while the camera is in motion:
    // picking every frame of a drag is expensive and the result is discarded
    // the moment the camera moves again.
    //
    // The throttle has a TRAILING EDGE, which is not decoration. A
    // leading-edge-only throttle drops the last move of a gesture, so flicking
    // the pointer off a marker and stopping within the window leaves the card
    // and the enlarged marker stuck under a pointer that is no longer there.
    _clickHandler.setInputAction((movement) => {
      if (!_enabled || _cameraMoving) return;
      const endPosition = movement?.endPosition;
      if (!endPosition) return;
      const wait = EVENTS_HOVER_THROTTLE_MS - (Date.now() - _lastHoverPickAt);
      if (wait > 0) {
        _hoverPending = { x: endPosition.x, y: endPosition.y };
        if (!_hoverTrailingTimer) {
          _hoverTrailingTimer = setTimeout(() => {
            _hoverTrailingTimer = 0;
            const pending = _hoverPending;
            _hoverPending = null;
            if (pending && _enabled && !_cameraMoving) runHoverPick(viewer, pending);
          }, wait);
        }
        return;
      }
      runHoverPick(viewer, endPosition);
    }, Cesium.ScreenSpaceEventType.MOUSE_MOVE);
  }

  /**
   * Run the horizon pass while the camera is in motion, throttled.
   *
   * Subscribed to `scene.postRender` ONLY between `moveStart` and `moveEnd`.
   * That choice is the whole design:
   *
   * - It costs no extra frames. A drag, a zoom and the inertia that follows are
   *   already producing frames; this rides them. When the camera is parked the
   *   scene renders nothing, so the subscription is removed and the cost is
   *   exactly zero — the layer still takes NO continuous-render hold.
   * - It covers inertia. `moveEnd` fires only once the glide has fully settled,
   *   which after a zoom is a noticeable wait with far-side markers still up.
   * - It does not touch `camera.percentageChanged`. `camera.changed` would be
   *   the obvious alternative, but that threshold is a SHARED GLOBAL on the
   *   camera — `traffic.js` sets it to 0.05 and restores it on disable
   *   precisely because leaving it mutated affects every other listener in the
   *   app. Two layers negotiating one global is a bug waiting to happen.
   */
  function installMovingCullPass() {
    if (_movingRenderListener || !_viewer?.scene?.postRender?.addEventListener) return;
    _lastMovingCullAt = 0;
    _movingRenderListener = _viewer.scene.postRender.addEventListener(() => {
      const now = Date.now();
      if (now - _lastMovingCullAt < EVENTS_MOVING_CULL_THROTTLE_MS) return;
      _lastMovingCullAt = now;
      applyEventHorizonCull();
    });
  }

  function removeMovingCullPass() {
    if (!_movingRenderListener) return;
    try {
      _movingRenderListener();
    } catch { /* scene already torn down */ }
    _movingRenderListener = null;
  }

  function installHorizonCullListener(viewer) {
    const camera = viewer?.camera;
    if (!camera?.moveEnd?.addEventListener) return;
    if (!_moveStartListener && camera.moveStart?.addEventListener) {
      _moveStartListener = () => {
        _cameraMoving = true;
        clearHoverTrailing();
        // A card anchored to a marker that is about to slide across the screen
        // reads as lag; drop it for the duration of the movement.
        if (_hoverId) setHover(null);
        installMovingCullPass();
      };
      camera.moveStart.addEventListener(_moveStartListener);
    }
    if (_horizonCullListener) return;
    _horizonCullListener = () => {
      // Close the in-motion window first, then take the settled reading.
      _cameraMoving = false;
      removeMovingCullPass();
      applyEventHorizonCull();
    };
    camera.moveEnd.addEventListener(_horizonCullListener);
  }

  function removeHorizonCullListener() {
    removeMovingCullPass();
    const camera = _viewer?.camera;
    if (_moveStartListener) {
      try {
        camera?.moveStart?.removeEventListener?.(_moveStartListener);
      } catch { /* camera already torn down */ }
      _moveStartListener = null;
    }
    if (_horizonCullListener) {
      try {
        camera?.moveEnd?.removeEventListener?.(_horizonCullListener);
      } catch { /* camera already torn down */ }
      _horizonCullListener = null;
    }
    _lastCullCameraPosition = null;
    _lastMovingCullAt = 0;
    _cameraMoving = false;
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
    // Named for what the data actually is. The old "World Events" read as a
    // general news feed, which oversells a source that codes political
    // interactions and nothing else. The layer id and its registry token stay
    // put — they are share-link contract, not display copy.
    name: 'Political Events',
    icon: '🏛️',
    source: 'GDELT CAMEO',
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
      _sliceCount = null;
      _windowSlices = null;
      _enabled = false;
      _loading = false;
      _selectedId = null;
      _hoverId = null;
      _pointerDownAt = null;
      _labelEntries = [];
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
      installHorizonCullListener(viewer || _viewer);
      render();
    },

    disable(viewer) {
      _enabled = false;
      // Abort BEFORE clearing: a poll still in flight would otherwise land on
      // a disabled layer and republish the overlay source it just cleared.
      abortInflight('events layer disabled');
      removeClickHandler();
      removeHorizonCullListener();
      clearHoverTrailing();
      _hoverId = null;
      _pointerDownAt = null;
      _labelEntries = [];
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
        _sliceCount = Number.isFinite(payload.sliceCount) ? payload.sliceCount : null;
        _windowSlices = Number.isFinite(payload.windowSlices) ? payload.windowSlices : null;
        render();
        _lastUpdate = Date.now();
        // A window still deepening is NOT an error — the proxy serves the
        // newest slice immediately and backfills behind it, so a cold start is
        // legitimately thin for a while. Reporting it as a fetch failure would
        // put a red chip on a layer that is working exactly as designed.
        _lastError = null;
        console.log(
          `[Data:Events] Updated: ${_count} events from ${_sliceCount ?? '?'}/`
          + `${_windowSlices ?? '?'} slices (${EVENT_SEVERITY_MODEL})`,
        );
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
      removeHorizonCullListener();
      clearHoverTrailing();
      _hoverId = null;
      _pointerDownAt = null;
      _labelEntries = [];
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
      _cullTargets = { entities: [], cullPositions: [] };
      _selectedId = null;
      _count = 0;
      _lastUpdate = null;
      _lastError = null;
      _stale = false;
      _sliceCount = null;
      _windowSlices = null;
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
              : `${isActive ? 'Hide' : 'Show'}: ${entry.blurb}`,
            params: { categories: next },
          };
        }),
        legend: EVENT_CATEGORIES
          .filter((entry) => active.has(entry.id))
          .map((entry) => ({
            label: entry.label,
            color: entry.color,
            count: tally.get(entry.id) || 0,
            blurb: entry.blurb,
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
        sliceCount: _sliceCount,
        windowSlices: _windowSlices,
        // True while the proxy is still backfilling its window. Surfaced so
        // the chip can say "warming up" rather than looking under-populated
        // for no stated reason.
        partialWindow: Number.isFinite(_sliceCount) && Number.isFinite(_windowSlices)
          ? _sliceCount < _windowSlices
          : false,
      };
    },
  };
  return layer;
}

const eventsLayer = createEventsLayer();

export default eventsLayer;
