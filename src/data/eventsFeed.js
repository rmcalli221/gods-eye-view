/**
 * GDELT GEO 2.0 event-feed parsing, category specs, and severity scoring.
 *
 * PURE MODULE — no Cesium, no Node built-ins, no I/O. It is imported by BOTH
 * the `/api/events` dev/preview proxy in `vite.config.js` and the globe layer
 * in `src/data/events.js`, so parser and renderer can never disagree about a
 * record's shape. Same split as `firmsCsv.js` ↔ `firmsHeatmap.js` and
 * `tomtomTiles.js` ↔ `traffic.js`: the config cannot import a module that
 * pulls in the Cesium bundle.
 *
 * Upstream: https://api.gdeltproject.org/api/v2/geo/geo
 *   ?query=<category query>&format=GeoJSON&mode=PointData&timespan=24h
 *
 * WHY GEO 2.0 AND NOT DOC 2.0: GEO returns coordinates GDELT already resolved.
 * DOC returns structured article rows with no coordinates, and the only
 * geocoder wired into this repo is Nominatim, which `fetchRegionalPlace()`
 * deliberately serializes to one request per second — unusable for hundreds of
 * points per refresh. The cost of GEO is that article URLs arrive inside an
 * HTML blob (`properties.html`) instead of structured rows, which
 * `extractArticleLinks` unpacks server-side so raw upstream HTML never reaches
 * the browser.
 *
 * ⚠ THE PARSED SHAPE IS UNVERIFIED AGAINST A LIVE RESPONSE. It was written
 * from GDELT's published documentation in an environment with no route to
 * api.gdeltproject.org. Every field is optional-tolerant (missing → skipped
 * record or null field, never a throw), but the exact `properties.html` markup,
 * whether `count` is always present, and which `theme:` codes actually return
 * volume all still need confirming against real traffic. See
 * `src/data/fixtures/README.md`.
 */

/** Longest article headline retained; longer titles are truncated. */
const MAX_TITLE_CHARS = 140;
/** Longest place label retained. */
const MAX_PLACE_CHARS = 120;
/** Articles kept per location per category. */
export const EVENT_MAX_ARTICLES = 3;
/** Coordinate rounding used for the cross-category dedupe key (~110 m). */
const DEDUPE_DECIMALS = 3;

/**
 * The five event categories, in canonical order.
 *
 * `code` is the single letter this category contributes to the share-link
 * option value (see `OPTION_GROUPS.events` in `src/data/layerState.js`) and is
 * therefore part of the URL contract — never change one for an existing
 * category. `query` is the GDELT query string; `weight` feeds the severity
 * table below.
 *
 * ⚠ THE `query` VALUES ARE UNVERIFIED. GKG theme codes are documented but
 * their live volume through the GEO endpoint is not something this environment
 * could measure. A code that returns nothing yields an empty category, not an
 * error.
 *
 * @type {ReadonlyArray<{id: string, code: string, label: string, color: string,
 *   query: string, weight: number}>}
 */
export const EVENT_CATEGORIES = Object.freeze([
  Object.freeze({
    id: 'conflict',
    code: 'c',
    label: 'CONFLICT',
    color: '#ff4438',
    query: 'theme:ARMEDCONFLICT',
    weight: 1,
  }),
  Object.freeze({
    id: 'political',
    code: 'p',
    label: 'POLITICAL',
    color: '#ffb020',
    query: 'theme:PROTEST',
    weight: 0.7,
  }),
  Object.freeze({
    id: 'humanitarian',
    code: 'h',
    label: 'HUMANITARIAN',
    color: '#4fc3f7',
    query: 'theme:HUMANITARIAN_AID',
    weight: 0.85,
  }),
  Object.freeze({
    id: 'economic',
    code: 'e',
    label: 'ECONOMIC',
    color: '#a78bfa',
    query: 'theme:ECON_STOCKMARKET',
    weight: 0.55,
  }),
  Object.freeze({
    id: 'disaster',
    code: 'd',
    label: 'DISASTER',
    color: '#ff7a1a',
    query: 'theme:NATURAL_DISASTER',
    weight: 0.95,
  }),
]);

/** Category ids in canonical order. */
export const EVENT_CATEGORY_IDS = Object.freeze(EVENT_CATEGORIES.map((entry) => entry.id));

const CATEGORY_BY_ID = new Map(EVENT_CATEGORIES.map((entry) => [entry.id, entry]));
const CATEGORY_BY_CODE = new Map(EVENT_CATEGORIES.map((entry) => [entry.code, entry]));

/**
 * Look up one category spec.
 * @param {string} id Category id.
 * @returns {?object} The frozen spec, or null when unknown.
 */
export function eventCategory(id) {
  return CATEGORY_BY_ID.get(String(id || '')) || null;
}

/**
 * Which severity model `scoreEventSeverity` implements, named so the layer,
 * legend copy, and DATA_SOURCES.md cannot drift from the code.
 *
 * `coverage-index` is deliberately NOT called severity in user-facing copy: it
 * ranks how much coverage a place is getting, which is not the same question
 * as how bad the underlying event is. A well-covered protest in a major media
 * market outranks an under-covered atrocity. That is a real and unfixable
 * property of article-volume ranking, and it is stated rather than smoothed.
 */
export const EVENT_SEVERITY_MODEL = 'coverage-index';

/**
 * Severity weights, as one frozen, inspectable table.
 *
 * The shipped model is coverage-only: GEO 2.0's GeoJSON output carries NO tone
 * per feature (tone is reachable only as a query-side operator, which costs a
 * separate request per tone band). The `tone` block is therefore present but
 * DISABLED — switching to a tone-banded model is a change to this table and
 * its tests, not to the proxy, the layer, or the render path.
 */
export const EVENT_SEVERITY_WEIGHTS = Object.freeze({
  /** Per-category multiplier applied to the normalized coverage term. */
  category: Object.freeze(Object.fromEntries(
    EVENT_CATEGORIES.map((entry) => [entry.id, entry.weight]),
  )),
  /**
   * Coverage term: log1p(count) normalized against the maximum count in the
   * SAME fetch, so a quiet news day still spreads across the range. `floor`
   * keeps the least-covered location in a category visible rather than zero.
   */
  coverage: Object.freeze({ enabled: true, floor: 0.08 }),
  /** Reserved for a tone-banded model. See the note above. */
  tone: Object.freeze({
    enabled: false,
    bands: Object.freeze({ severe: 1, elevated: 0.75, baseline: 0.5 }),
  }),
  /** Output range is 0..scale. */
  scale: 100,
});

/**
 * Score one record's coverage intensity on 0..`scale`.
 *
 * @param {{count: ?number, category: string, toneBand: ?string}} record Parsed record.
 * @param {object} [context] Scoring context.
 * @param {number} [context.maxCount=0] Largest count in the same fetch.
 * @param {object} [context.weights=EVENT_SEVERITY_WEIGHTS] Weight table override.
 * @returns {number} Integer in [0, weights.scale].
 */
export function scoreEventSeverity(record, { maxCount = 0, weights = EVENT_SEVERITY_WEIGHTS } = {}) {
  const scale = Number.isFinite(weights?.scale) ? weights.scale : 100;
  const count = Number(record?.count);
  if (!Number.isFinite(count) || count <= 0) return 0;

  let coverage = 1;
  if (weights?.coverage?.enabled !== false) {
    const ceiling = Number(maxCount);
    const normalized = Number.isFinite(ceiling) && ceiling > 1
      ? Math.log1p(count) / Math.log1p(ceiling)
      : 1;
    const floor = Number(weights?.coverage?.floor) || 0;
    coverage = floor + (1 - floor) * Math.max(0, Math.min(1, normalized));
  }

  let tone = 1;
  if (weights?.tone?.enabled === true) {
    const band = weights.tone.bands?.[String(record?.toneBand || '')];
    tone = Number.isFinite(band) ? band : (weights.tone.bands?.baseline ?? 1);
  }

  const categoryWeight = Number(weights?.category?.[record?.category]);
  const weight = Number.isFinite(categoryWeight) ? categoryWeight : 1;
  const score = scale * weight * coverage * tone;
  return Math.max(0, Math.min(scale, Math.round(score)));
}

/**
 * Collapse whitespace and bound a free-text value.
 * @param {*} value Raw value.
 * @param {number} maxLength Character ceiling.
 * @returns {string} Cleaned text (possibly empty).
 */
function cleanText(value, maxLength) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

/**
 * Parse an http(s) URL, rejecting every other scheme.
 *
 * Mirrors `safeHttpUrl` in `src/data/regionalBrief.js` — duplicated rather
 * than exported from there because that module is the cockpit's and this one
 * must stay importable by `vite.config.js`.
 * @param {*} value Candidate URL.
 * @returns {?URL} Parsed URL, or null.
 */
function safeHttpUrl(value) {
  try {
    const parsed = new URL(String(value ?? ''));
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed : null;
  } catch {
    return null;
  }
}

/** Minimal entity decode for anchor text; GDELT emits no CDATA in this field. */
function decodeEntities(value) {
  return String(value ?? '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;/g, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&');
}

const ANCHOR_PATTERN = /<a\s[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;

/**
 * Extract structured article links from GEO 2.0's `properties.html` blob.
 *
 * This is the ONLY path from a GEO feature to a source URL, and it is the
 * highest-risk piece of the parser: the exact markup is undocumented beyond
 * "an HTML list of links". Anything that fails to yield an http(s) URL and a
 * non-empty title is dropped, so a markup change degrades to zero articles
 * rather than to garbage. Modelled on `normalizeRssArticles` in
 * `vite.config.js`, which strips tags the same way.
 *
 * The raw HTML never leaves the proxy — only the rows this returns do.
 *
 * @param {*} html Raw `properties.html` value.
 * @param {number} [limit=EVENT_MAX_ARTICLES] Maximum rows to return.
 * @returns {Array<{title: string, url: string, domain: string}>} Article rows.
 */
export function extractArticleLinks(html, limit = EVENT_MAX_ARTICLES) {
  const source = String(html ?? '');
  const cap = Math.max(0, Math.floor(Number(limit) || 0));
  if (!source || cap === 0) return [];
  const seen = new Set();
  const articles = [];
  ANCHOR_PATTERN.lastIndex = 0;
  for (const match of source.matchAll(ANCHOR_PATTERN)) {
    const parsed = safeHttpUrl(decodeEntities(match[1]));
    if (!parsed) continue;
    const title = cleanText(decodeEntities(String(match[2]).replace(/<[^>]+>/g, ' ')), MAX_TITLE_CHARS);
    if (!title) continue;
    const signature = `${title.toLowerCase()}|${parsed.hostname}`;
    if (seen.has(signature)) continue;
    seen.add(signature);
    articles.push({
      title,
      url: parsed.href,
      domain: parsed.hostname.replace(/^www\./, ''),
    });
    if (articles.length >= cap) break;
  }
  return articles;
}

/** Deterministic dedupe/identity key for a coordinate pair. */
function locationKey(lat, lon) {
  return `${lat.toFixed(DEDUPE_DECIMALS)},${lon.toFixed(DEDUPE_DECIMALS)}`;
}

/**
 * Parse one GEO 2.0 GeoJSON response into per-category records.
 *
 * Returns `null` — not `[]` — for a structurally wrong payload, so the proxy
 * can tell "this category has no events" from "this is not GeoJSON" and serve
 * stale for the second case. Same distinction `parseFirmsCsv` makes.
 *
 * @param {*} payload Parsed JSON body.
 * @param {object} options
 * @param {string} options.category Category id this response was fetched for.
 * @param {number} [options.maxRecords=Infinity] Cap on returned records.
 * @param {number} [options.maxArticles=EVENT_MAX_ARTICLES] Articles per record.
 * @returns {?Array<object>} Records, or null when the payload is malformed.
 */
export function parseGeoFeatureCollection(payload, {
  category,
  maxRecords = Infinity,
  maxArticles = EVENT_MAX_ARTICLES,
} = {}) {
  if (!payload || typeof payload !== 'object') return null;
  if (payload.type !== undefined && payload.type !== 'FeatureCollection') return null;
  if (!Array.isArray(payload.features)) return null;
  if (!CATEGORY_BY_ID.has(String(category || ''))) return null;

  const cap = Number.isFinite(maxRecords) ? Math.max(0, Math.floor(maxRecords)) : Infinity;
  const records = [];
  for (const feature of payload.features) {
    if (records.length >= cap) break;
    const coordinates = feature?.geometry?.coordinates;
    if (!Array.isArray(coordinates) || coordinates.length < 2) continue;
    const lon = Number(coordinates[0]);
    const lat = Number(coordinates[1]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) continue;

    const properties = feature.properties && typeof feature.properties === 'object'
      ? feature.properties
      : {};
    const rawCount = Number(properties.count);
    records.push({
      id: `evt:${category}:${locationKey(lat, lon)}`,
      category,
      lat,
      lon,
      place: cleanText(properties.name, MAX_PLACE_CHARS) || null,
      count: Number.isFinite(rawCount) && rawCount >= 0 ? Math.floor(rawCount) : null,
      articles: extractArticleLinks(properties.html, maxArticles),
    });
  }
  return records;
}

/**
 * Score a single category's records against their own maximum count.
 *
 * Scoring is per category on purpose: normalizing across categories would let
 * a high-volume economic feed suppress every disaster point, and the category
 * weight already carries the cross-category ordering.
 *
 * @param {Array<object>} records Records from `parseGeoFeatureCollection`.
 * @param {object} [options]
 * @param {object} [options.weights] Weight table override.
 * @returns {Array<object>} The same records with `severity` added.
 */
export function scoreCategoryRecords(records, { weights = EVENT_SEVERITY_WEIGHTS } = {}) {
  if (!Array.isArray(records) || records.length === 0) return [];
  let maxCount = 0;
  for (const record of records) {
    const count = Number(record?.count);
    if (Number.isFinite(count) && count > maxCount) maxCount = count;
  }
  return records.map((record) => ({
    ...record,
    severity: scoreEventSeverity(record, { maxCount, weights }),
  }));
}

/**
 * Merge every category's scored records into one deduplicated location set.
 *
 * Locations are deduplicated on a 3-decimal coordinate key, because the same
 * city commonly appears in several category queries. Per-category count,
 * severity, and articles are all KEPT under `byCategory` rather than collapsed:
 * filtering to one category must yield that category's own ranking and its own
 * article links, not a blended figure.
 *
 * `maxPoints` is a payload-size guard, applied AFTER dedupe and only to bound
 * the JSON the proxy serves. It deliberately does not pre-rank across
 * categories — the per-category cap in the proxy is what bounds each feed, so
 * a filtered view keeps its depth.
 *
 * @param {Array<{category: string, records: Array<object>}>} groups Scored groups.
 * @param {object} [options]
 * @param {number} [options.maxPoints=Infinity] Payload-size ceiling.
 * @returns {Array<object>} Merged records sorted by severity desc, then id.
 */
export function mergeCategoryResults(groups, { maxPoints = Infinity } = {}) {
  const merged = new Map();
  for (const group of Array.isArray(groups) ? groups : []) {
    const category = String(group?.category || '');
    if (!CATEGORY_BY_ID.has(category)) continue;
    for (const record of Array.isArray(group.records) ? group.records : []) {
      const lat = Number(record?.lat);
      const lon = Number(record?.lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      const key = locationKey(lat, lon);
      let entry = merged.get(key);
      if (!entry) {
        entry = {
          id: `evt:${key}`,
          lat,
          lon,
          place: record.place ?? null,
          categories: [],
          byCategory: {},
        };
        merged.set(key, entry);
      }
      if (!entry.place && record.place) entry.place = record.place;
      if (!entry.byCategory[category]) entry.categories.push(category);
      entry.byCategory[category] = {
        count: record.count ?? null,
        severity: Number.isFinite(record.severity) ? record.severity : 0,
        articles: Array.isArray(record.articles) ? record.articles : [],
      };
    }
  }

  const out = [];
  for (const entry of merged.values()) {
    entry.categories.sort(
      (a, b) => EVENT_CATEGORY_IDS.indexOf(a) - EVENT_CATEGORY_IDS.indexOf(b),
    );
    let severity = 0;
    for (const category of entry.categories) {
      severity = Math.max(severity, entry.byCategory[category].severity);
    }
    entry.severity = severity;
    out.push(entry);
  }
  out.sort((a, b) => b.severity - a.severity || a.id.localeCompare(b.id));
  const cap = Number.isFinite(maxPoints) ? Math.max(0, Math.floor(maxPoints)) : Infinity;
  return cap === Infinity ? out : out.slice(0, cap);
}

/**
 * Normalize a requested category filter into a canonical, non-empty id list.
 * An empty or fully invalid request means "all categories" — a filter that
 * selects nothing would silently blank the layer.
 * @param {*} categories Requested ids.
 * @returns {Array<string>} Canonical-order category ids.
 */
export function normalizeEventCategories(categories) {
  const requested = new Set(
    (Array.isArray(categories) ? categories : [])
      .map((value) => String(value || '').trim().toLowerCase())
      .filter((value) => CATEGORY_BY_ID.has(value)),
  );
  if (requested.size === 0) return [...EVENT_CATEGORY_IDS];
  return EVENT_CATEGORY_IDS.filter((id) => requested.has(id));
}

/**
 * Encode a category set as the share-link option value: category `code`
 * letters in canonical order (e.g. `cdehp`). No `.` or `_`, which the `lo`
 * grammar in `layerState.js` reserves as separators.
 * @param {*} categories Category ids.
 * @returns {string} Encoded value.
 */
export function encodeEventCategories(categories) {
  return normalizeEventCategories(categories)
    .map((id) => CATEGORY_BY_ID.get(id).code)
    .join('');
}

/**
 * Decode a share-link category value. Returns null (rejecting the assignment,
 * per the codec's fail-closed rule) for anything not a set of known codes.
 * @param {*} value Encoded value.
 * @returns {?Array<string>} Category ids, or null when invalid.
 */
export function decodeEventCategories(value) {
  const raw = String(value ?? '');
  if (!/^[a-z]{1,5}$/.test(raw)) return null;
  const ids = [];
  const seen = new Set();
  for (const code of raw) {
    const spec = CATEGORY_BY_CODE.get(code);
    if (!spec || seen.has(code)) return null;
    seen.add(code);
    ids.push(spec.id);
  }
  return EVENT_CATEGORY_IDS.filter((id) => ids.includes(id));
}

/**
 * Coerce any accepted category-filter representation into canonical ids.
 *
 * Two representations exist on purpose: the layer and its row chips speak in
 * id arrays, while the share-link codec stores the compact `code` string so
 * that the durable value compares by VALUE (`===`) and a default-valued filter
 * is omitted from the URL rather than always written out. This is the one
 * place that knows both.
 *
 * @param {*} value Id array, encoded code string, or null/undefined for "all".
 * @returns {?Array<string>} Canonical ids, or null when the value is unusable.
 */
export function coerceEventCategories(value) {
  if (value === null || value === undefined) return [...EVENT_CATEGORY_IDS];
  if (Array.isArray(value)) return normalizeEventCategories(value);
  if (typeof value === 'string') return decodeEventCategories(value);
  return null;
}

/**
 * Choose which merged records to render, under the active category filter and
 * the layer's entity budget.
 *
 * The filter is applied BEFORE the cap so that narrowing to one category
 * yields that category's own depth rather than whatever survived a global
 * ranking. Each result carries the winning category's own severity, colour,
 * count, and article links.
 *
 * @param {Array<object>} records Merged records from `mergeCategoryResults`.
 * @param {object} [options]
 * @param {Array<string>} [options.categories] Active category ids (default all).
 * @param {number} [options.maxEntities=Infinity] Entity budget.
 * @returns {Array<object>} Render records, severity desc then id asc.
 */
export function selectEventsForRender(records, { categories, maxEntities = Infinity } = {}) {
  const active = new Set(normalizeEventCategories(categories));
  const selected = [];
  for (const record of Array.isArray(records) ? records : []) {
    const available = Array.isArray(record?.categories) ? record.categories : [];
    let best = null;
    for (const category of available) {
      if (!active.has(category)) continue;
      const detail = record.byCategory?.[category];
      if (!detail) continue;
      const severity = Number.isFinite(detail.severity) ? detail.severity : 0;
      if (!best || severity > best.severity
        || (severity === best.severity
          && EVENT_CATEGORY_IDS.indexOf(category) < EVENT_CATEGORY_IDS.indexOf(best.category))) {
        best = { category, severity, detail };
      }
    }
    if (!best) continue;
    const spec = CATEGORY_BY_ID.get(best.category);
    selected.push({
      id: record.id,
      lat: record.lat,
      lon: record.lon,
      place: record.place ?? null,
      category: best.category,
      categoryLabel: spec.label,
      color: spec.color,
      severity: best.severity,
      count: best.detail.count ?? null,
      articles: Array.isArray(best.detail.articles) ? best.detail.articles : [],
      categories: available,
    });
  }
  selected.sort((a, b) => b.severity - a.severity || a.id.localeCompare(b.id));
  const cap = Number.isFinite(maxEntities) ? Math.max(0, Math.floor(maxEntities)) : Infinity;
  return cap === Infinity ? selected : selected.slice(0, cap);
}

/**
 * Marker pixel size for a render record. Static per poll — never a
 * `CallbackProperty`: see the frame-cost note in `src/data/earthquakes.js`.
 * @param {object} record Render record.
 * @returns {number} Pixel size.
 */
export function eventMarkerPixelSize(record) {
  const severity = Number(record?.severity);
  const normalized = Number.isFinite(severity) ? Math.max(0, Math.min(100, severity)) / 100 : 0;
  return Math.round((6 + normalized * 10) * 10) / 10;
}
