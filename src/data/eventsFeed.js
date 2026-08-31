/**
 * CAMEO event categories, severity scoring, and the share-link codec.
 *
 * PURE MODULE — no Cesium, no Node built-ins, no I/O. Imported by BOTH the
 * `/api/events` dev/preview proxy in `vite.config.js` and the globe layer in
 * `src/data/events.js`, so proxy and renderer can never disagree.
 *
 * This module owns PRESENTATION POLICY. The wire format — 61 columns, FIPS
 * codes, precision rules — belongs to `gdeltExport.js`, which deliberately
 * assigns no category. Keeping the two apart is what lets the source change
 * without the UI changing, and vice versa.
 *
 * WHAT THIS LAYER COVERS, AND WHAT IT DOES NOT. The GDELT 2.0 Event Database
 * records POLITICAL INTERACTIONS BETWEEN TWO ACTORS, coded with CAMEO root
 * codes 01-20. That is the whole ontology. There is no natural-disaster code,
 * no humanitarian-crisis code, and no market code — so this layer cannot
 * express those things, and does not pretend to. Disasters are covered by the
 * `earthquakes` and FIRMS heatmap layers, which have purpose-built data.
 * See `DATA_SOURCES.md` and `docs/PHASE1-DECISIONS.md` §7.
 */

import { dedupeExportRecords } from './gdeltExport.js';

/** Longest place label retained. */
const MAX_PLACE_CHARS = 120;

/**
 * The five categories, in PRECEDENCE order — most severe first.
 *
 * Each is defined by CAMEO `EventRootCode` alone. An earlier draft mixed
 * `rootCode` with `quadClass`, which was both redundant and actively harmful:
 * QuadClass is a pure coarsening of the root code (01-05 -> 1, 06-09 -> 2,
 * 10-14 -> 3, 15-20 -> 4, confirmed across the whole fixture), so it carries no
 * information the root code lacks — but a `quadClass === 4` clause in
 * `conflict` swallowed EVERY root-17 row and left `coercion` permanently
 * empty. Keying on root codes alone makes the five buckets a total, disjoint
 * partition of 01-20, which `eventsFeed.test.mjs` asserts directly.
 *
 * `code` is the letter this category contributes to the share-link option
 * value (see `OPTION_GROUPS.events` in `src/data/layerState.js`). Only `c`
 * carries over from the GKG-theme grammar, because only `conflict` kept its
 * meaning; see `RETIRED_CATEGORY_CODES`.
 *
 * @type {ReadonlyArray<{id: string, code: string, label: string, color: string,
 *   roots: ReadonlyArray<string>, weight: number, blurb: string}>}
 */
export const EVENT_CATEGORIES = Object.freeze([
  Object.freeze({
    id: 'conflict',
    code: 'c',
    label: 'CONFLICT',
    color: '#ff4438',
    roots: Object.freeze(['18', '19', '20']),
    weight: 1,
    blurb: 'Assault, fight, unconventional mass violence',
  }),
  Object.freeze({
    id: 'unrest',
    code: 'u',
    label: 'UNREST',
    color: '#ff7a1a',
    roots: Object.freeze(['14']),
    weight: 0.85,
    blurb: 'Protest',
  }),
  Object.freeze({
    id: 'coercion',
    code: 'x',
    label: 'COERCION',
    color: '#ffb020',
    roots: Object.freeze(['13', '15', '16', '17']),
    weight: 0.8,
    blurb: 'Threaten, force posture, reduce relations, coerce',
  }),
  Object.freeze({
    id: 'dissent',
    code: 's',
    label: 'DISSENT',
    color: '#a78bfa',
    roots: Object.freeze(['10', '11', '12']),
    weight: 0.5,
    blurb: 'Demand, disapprove, reject',
  }),
  Object.freeze({
    id: 'diplomacy',
    code: 'y',
    label: 'DIPLOMACY',
    color: '#4fc3f7',
    roots: Object.freeze(['01', '02', '03', '04', '05', '06', '07', '08', '09']),
    weight: 0.3,
    blurb: 'Statements, consultation, cooperation, aid',
  }),
]);

/** Category ids in canonical (precedence) order. */
export const EVENT_CATEGORY_IDS = Object.freeze(EVENT_CATEGORIES.map((entry) => entry.id));

/**
 * Categories on by default.
 *
 * `diplomacy` is OFF. It is not a minor category — it is roughly 70% of every
 * window (statements, consultations and meetings dominate the feed), so
 * leaving it on renders a globe of diplomatic meetings in which the six
 * percent of rows that are actual violence are invisible. It stays available
 * as a chip, and turning it on is a deliberate act.
 */
export const EVENT_DEFAULT_CATEGORY_IDS = Object.freeze(
  EVENT_CATEGORY_IDS.filter((id) => id !== 'diplomacy'),
);

/**
 * Share-link codes that existed under the GKG-theme grammar and no longer
 * name anything.
 *
 * `p` was `political` (theme:PROTEST), `h` `humanitarian`, `e` `economic`,
 * `d` `disaster`. None survives the move to CAMEO: protest is now `unrest`,
 * and humanitarian, economic and disaster have no CAMEO equivalent at all.
 *
 * These letters are DEPRECATED, NOT REUSED. Handing `p` to `diplomacy` or `d`
 * to `dissent` would have kept old links parsing while silently changing what
 * they select — a link that asked for protests would come back selecting
 * diplomatic chatter. Retiring the letters instead means such a link loses
 * that category and keeps the rest, which is visible rather than deceptive.
 *
 * `LAYER_STATE_VERSION` is deliberately NOT bumped for this. `decodeLayerState`
 * rejects the whole URL on a version mismatch, for every layer at once, so a
 * bump would break camera, flights and CCTV state to re-grammar one option.
 * Tolerating retired codes here is the contained fix.
 */
export const RETIRED_CATEGORY_CODES = Object.freeze(new Set(['p', 'h', 'e', 'd']));

const CATEGORY_BY_ID = new Map(EVENT_CATEGORIES.map((entry) => [entry.id, entry]));
const CATEGORY_BY_CODE = new Map(EVENT_CATEGORIES.map((entry) => [entry.code, entry]));
const CATEGORY_BY_ROOT = new Map();
for (const entry of EVENT_CATEGORIES) {
  for (const root of entry.roots) CATEGORY_BY_ROOT.set(root, entry.id);
}

/**
 * Look up one category spec.
 * @param {string} id Category id.
 * @returns {?object} The frozen spec, or null when unknown.
 */
export function eventCategory(id) {
  return CATEGORY_BY_ID.get(String(id || '')) || null;
}

/**
 * Assign one CAMEO root code to exactly one category.
 *
 * The buckets partition 01-20 with no gaps and no overlaps, so this is a
 * lookup rather than a search — but it is expressed as a total function with a
 * null fallback because CAMEO could add a root code and an unknown one must
 * land nowhere rather than defaulting into a bucket it does not belong in.
 *
 * @param {*} rootCode CAMEO EventRootCode, e.g. '19'.
 * @returns {?string} Category id, or null for an unknown root code.
 */
export function categoryForRootCode(rootCode) {
  const raw = String(rootCode ?? '').trim();
  if (!raw) return null;
  return CATEGORY_BY_ROOT.get(raw.padStart(2, '0')) || null;
}

/**
 * Which severity model `scoreEventSeverity` implements, named so the layer,
 * legend copy and DATA_SOURCES.md cannot drift from the code.
 *
 * `cameo-intensity` ranks how CONFLICTUAL and how WIDELY REPORTED an event is.
 * It is NOT a casualty estimate, a damage assessment, or a measure of how bad
 * something is. A well-covered diplomatic row in a major media market can
 * still outrank an under-covered killing, because article volume is one of the
 * terms. That is a real property of any coverage-weighted ranking and it is
 * stated rather than smoothed over.
 */
export const EVENT_SEVERITY_MODEL = 'cameo-intensity';

/**
 * Severity weights, as one frozen inspectable table.
 *
 * Each term can be disabled independently, so re-weighting the model is a
 * change to this table and its tests — not to the proxy, the layer, or the
 * render path.
 */
export const EVENT_SEVERITY_WEIGHTS = Object.freeze({
  /** Per-category multiplier — the CAMEO class's own severity ordering. */
  category: Object.freeze(Object.fromEntries(
    EVENT_CATEGORIES.map((entry) => [entry.id, entry.weight]),
  )),
  /**
   * Coverage term: log1p(numArticles) normalized against the largest count in
   * the SAME window, so a quiet window still spreads across the range. `floor`
   * keeps a thinly-covered event visible rather than zero.
   */
  coverage: Object.freeze({ enabled: true, floor: 0.15 }),
  /**
   * Goldstein term: CAMEO's own -10..+10 conflict/cooperation intensity, which
   * the export ships per row. -10 (most conflictual) maps to 1, +10 to the
   * floor. This is the one term that reads the event itself rather than how
   * much it was written about.
   */
  goldstein: Object.freeze({ enabled: true, floor: 0.25 }),
  /**
   * Reserved. `AvgTone` is available per row but is largely redundant with
   * Goldstein and measures article sentiment rather than event intensity.
   */
  tone: Object.freeze({ enabled: false, floor: 0.5 }),
  /** Output range is 0..scale. */
  scale: 100,
});

/**
 * Score one record on 0..`scale`.
 *
 * @param {object} record Parsed record with `category`, `numArticles`, `goldstein`.
 * @param {object} [context] Scoring context.
 * @param {number} [context.maxArticles=0] Largest article count in the same window.
 * @param {object} [context.weights=EVENT_SEVERITY_WEIGHTS] Weight table override.
 * @returns {number} Integer in [0, weights.scale].
 */
export function scoreEventSeverity(record, {
  maxArticles = 0,
  weights = EVENT_SEVERITY_WEIGHTS,
} = {}) {
  const scale = Number.isFinite(weights?.scale) ? weights.scale : 100;

  let coverage = 1;
  if (weights?.coverage?.enabled !== false) {
    const count = Number(record?.numArticles);
    const ceiling = Number(maxArticles);
    const floor = Number(weights?.coverage?.floor) || 0;
    const normalized = Number.isFinite(count) && count > 0 && Number.isFinite(ceiling) && ceiling > 1
      ? Math.log1p(count) / Math.log1p(ceiling)
      : 0;
    coverage = floor + (1 - floor) * Math.max(0, Math.min(1, normalized));
  }

  let goldstein = 1;
  if (weights?.goldstein?.enabled === true) {
    const value = Number(record?.goldstein);
    const floor = Number(weights?.goldstein?.floor) || 0;
    // -10 (most conflictual) -> 1, +10 (most cooperative) -> floor.
    const normalized = Number.isFinite(value)
      ? Math.max(0, Math.min(1, (10 - value) / 20))
      : 0.5;
    goldstein = floor + (1 - floor) * normalized;
  }

  let tone = 1;
  if (weights?.tone?.enabled === true) {
    const value = Number(record?.tone);
    const floor = Number(weights?.tone?.floor) || 0;
    const normalized = Number.isFinite(value)
      ? Math.max(0, Math.min(1, (0 - value) / 20))
      : 0.5;
    tone = floor + (1 - floor) * normalized;
  }

  const categoryWeight = Number(weights?.category?.[record?.category]);
  const weight = Number.isFinite(categoryWeight) ? categoryWeight : 1;
  const score = scale * weight * coverage * goldstein * tone;
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
 * Dedupe ranking for classified records: most severe wins, then best covered,
 * then lowest id so the choice is deterministic.
 *
 * @param {object} a Candidate.
 * @param {object} b Incumbent.
 * @returns {number} Positive when `a` should survive over `b`.
 */
function severityDedupeRank(a, b) {
  const severity = (a?.severity ?? 0) - (b?.severity ?? 0);
  if (severity !== 0) return severity;
  const articles = (a?.numArticles ?? 0) - (b?.numArticles ?? 0);
  if (articles !== 0) return articles;
  return String(b?.id ?? '').localeCompare(String(a?.id ?? ''));
}

/**
 * Attach a category and a severity to parsed export records.
 *
 * Records whose root code names no category are DROPPED rather than bucketed
 * into a default — an unrecognized CAMEO code is an unknown, and rendering it
 * under a label that does not fit is worse than not rendering it.
 *
 * Scoring is normalized across the whole window rather than per category:
 * unlike the GEO version, one slice stream has one scale, so a single ranked
 * set is both simpler and correct.
 *
 * Dedupe runs AFTER scoring, and the survivor of a collapsed group is the MOST
 * SEVERE row, not the best-covered one. This ordering is load-bearing: one
 * article routinely yields several different coded events at one place, and
 * ranking that group by article volume drops a protest in favour of the
 * consultation reported alongside it. Article volume only breaks severity
 * ties. Pass `dedupe: false` to score without collapsing.
 *
 * @param {Array<object>} records Records from `parseExportTsv`.
 * @param {object} [options]
 * @param {object} [options.weights] Weight table override.
 * @param {boolean} [options.dedupe=true] Collapse one article at one place.
 * @returns {Array<object>} Records with `category` and `severity`, severity desc.
 */
export function classifyEventRecords(records, {
  weights = EVENT_SEVERITY_WEIGHTS,
  dedupe = true,
} = {}) {
  const input = Array.isArray(records) ? records : [];
  let maxArticles = 0;
  for (const record of input) {
    const count = Number(record?.numArticles);
    if (Number.isFinite(count) && count > maxArticles) maxArticles = count;
  }

  const out = [];
  for (const record of input) {
    const category = categoryForRootCode(record?.rootCode);
    if (!category) continue;
    const scored = { ...record, category };
    scored.severity = scoreEventSeverity(scored, { maxArticles, weights });
    scored.place = cleanText(record?.place, MAX_PLACE_CHARS) || null;
    out.push(scored);
  }
  const collapsed = dedupe ? dedupeExportRecords(out, { rank: severityDedupeRank }) : out;
  collapsed.sort((a, b) => b.severity - a.severity || String(a.id).localeCompare(String(b.id)));
  return collapsed;
}

/**
 * Normalize a requested category filter into a canonical, non-empty id list.
 *
 * An empty or fully invalid request means the DEFAULT set, not "everything":
 * `diplomacy` is off by default and a filter that selects nothing would blank
 * the layer.
 *
 * @param {*} categories Requested ids.
 * @returns {Array<string>} Canonical-order category ids.
 */
export function normalizeEventCategories(categories) {
  const requested = new Set(
    (Array.isArray(categories) ? categories : [])
      .map((value) => String(value || '').trim().toLowerCase())
      .filter((value) => CATEGORY_BY_ID.has(value)),
  );
  if (requested.size === 0) return [...EVENT_DEFAULT_CATEGORY_IDS];
  return EVENT_CATEGORY_IDS.filter((id) => requested.has(id));
}

/**
 * Encode a category set as the share-link option value: category `code`
 * letters in canonical order. No `.` or `_`, which the `lo` grammar in
 * `layerState.js` reserves as separators.
 * @param {*} categories Category ids.
 * @returns {string} Encoded value.
 */
export function encodeEventCategories(categories) {
  return normalizeEventCategories(categories)
    .map((id) => CATEGORY_BY_ID.get(id).code)
    .join('');
}

/**
 * Decode a share-link category value, tolerating retired codes.
 *
 * Three outcomes, deliberately distinct:
 *   - a known active code contributes its category;
 *   - a RETIRED code (`p`/`h`/`e`/`d`, the GKG-theme grammar) is DROPPED, and
 *     the rest of the link still applies;
 *   - anything else returns null, rejecting the assignment per the codec's
 *     fail-closed rule.
 *
 * A link naming only retired categories decodes to the default set rather than
 * to nothing — an old `disaster`-only link should show the default globe, not
 * a blank one.
 *
 * @param {*} value Encoded value.
 * @returns {?Array<string>} Category ids, or null when invalid.
 */
export function decodeEventCategories(value) {
  const raw = String(value ?? '');
  if (!/^[a-z]{1,8}$/.test(raw)) return null;
  const ids = new Set();
  const seen = new Set();
  for (const code of raw) {
    if (seen.has(code)) return null;
    seen.add(code);
    if (RETIRED_CATEGORY_CODES.has(code)) continue;
    const spec = CATEGORY_BY_CODE.get(code);
    if (!spec) return null;
    ids.add(spec.id);
  }
  if (ids.size === 0) return [...EVENT_DEFAULT_CATEGORY_IDS];
  return EVENT_CATEGORY_IDS.filter((id) => ids.has(id));
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
 * @param {*} value Id array, encoded code string, or null/undefined for default.
 * @returns {?Array<string>} Canonical ids, or null when the value is unusable.
 */
export function coerceEventCategories(value) {
  if (value === null || value === undefined) return [...EVENT_DEFAULT_CATEGORY_IDS];
  if (Array.isArray(value)) return normalizeEventCategories(value);
  if (typeof value === 'string') return decodeEventCategories(value);
  return null;
}

/**
 * Choose which records to render, under the active category filter and the
 * layer's entity budget.
 *
 * The filter is applied BEFORE the cap so that narrowing to one category
 * yields that category's own depth rather than whatever survived a global
 * ranking.
 *
 * @param {Array<object>} records Classified records.
 * @param {object} [options]
 * @param {Array<string>} [options.categories] Active category ids (default set).
 * @param {number} [options.maxEntities=Infinity] Entity budget.
 * @returns {Array<object>} Render records, severity desc then id asc.
 */
export function selectEventsForRender(records, { categories, maxEntities = Infinity } = {}) {
  const active = new Set(normalizeEventCategories(categories));
  const selected = [];
  for (const record of Array.isArray(records) ? records : []) {
    if (!active.has(record?.category)) continue;
    const spec = CATEGORY_BY_ID.get(record.category);
    selected.push({
      ...record,
      categoryLabel: spec.label,
      color: spec.color,
      severity: Number.isFinite(record.severity) ? record.severity : 0,
    });
  }
  selected.sort((a, b) => b.severity - a.severity || String(a.id).localeCompare(String(b.id)));
  const cap = Number.isFinite(maxEntities) ? Math.max(0, Math.floor(maxEntities)) : Infinity;
  // Annotate AFTER the cap: a sibling that did not survive the entity budget is
  // not on screen, so naming it would explain a repetition the viewer cannot see.
  return annotateSharedArticles(cap === Infinity ? selected : selected.slice(0, cap));
}

/**
 * Mark records that share a source article with another RENDERED record.
 *
 * One article routinely produces events at several places — 37% of markers in
 * the reference slice share an article with at least one other, and the groups
 * span continents (a single Guardian piece placed events in both Seoul and
 * Kyiv). Because GKG entities are per ARTICLE, every member of such a group
 * gets identical entity text, so without a signal two markers a hemisphere
 * apart read the same names and look like a rendering bug.
 *
 * Grouping is over the RENDERED set, not the whole window, because the
 * confusion the annotation answers is specifically "why do these two markers I
 * can see say the same thing".
 *
 * @param {Array<object>} selected Records about to be rendered.
 * @returns {Array<object>} The same records, with `sharedArticle` where it applies.
 */
export function annotateSharedArticles(selected) {
  const byUrl = new Map();
  for (const record of Array.isArray(selected) ? selected : []) {
    const url = String(record?.url || '');
    if (!url) continue;
    if (!byUrl.has(url)) byUrl.set(url, []);
    byUrl.get(url).push(record);
  }
  for (const group of byUrl.values()) {
    if (group.length < 2) continue;
    for (const record of group) {
      record.sharedArticle = {
        count: group.length,
        places: group
          .filter((other) => other !== record)
          .map((other) => String(other.place || '').split(',')[0].trim())
          .filter(Boolean),
      };
    }
  }
  return selected;
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
