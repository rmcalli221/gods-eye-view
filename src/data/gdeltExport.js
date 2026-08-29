/**
 * GDELT 2.0 Event Database export parser — TSV rows to event records.
 *
 * PURE MODULE — no Cesium, no Node built-ins, no I/O. It is imported by BOTH
 * the `/api/events` dev/preview proxy in `vite.config.js` and the globe layer,
 * so proxy and renderer can never disagree about a record's shape. Same split
 * as `firmsCsv.js` <-> `firmsHeatmap.js` and `tomtomTiles.js` <-> `traffic.js`:
 * the config cannot import a module that pulls in the Cesium bundle.
 *
 * This module owns THE WIRE FORMAT only — the 61 columns, the three code
 * systems, and the precision rules. It deliberately assigns no category and no
 * severity: that is presentation policy and lives in `eventsFeed.js`. Mixing
 * the two is what made the previous GEO 2.0 version impossible to re-target.
 *
 * Upstream: http://data.gdeltproject.org/gdeltv2/YYYYMMDDHHMMSS.export.CSV.zip
 * published every 15 minutes on the quarter hour, UTC. A static file server,
 * not a query API — see `docs/PHASE1-DECISIONS.md` §1 for why the GEO 2.0
 * query API was abandoned.
 *
 * VERIFIED AGAINST REAL DATA: the column map below is pinned by
 * `gdeltExport.test.mjs` against `src/data/fixtures/gdelt-export-sample.tsv`,
 * 209 real rows. See `docs/PHASE1-DECISIONS.md` §5 for the verification route.
 */

/** Columns in one export row. A row with any other count is rejected. */
export const EXPORT_COLUMN_COUNT = 61;

/**
 * Zero-based column indices, by name.
 *
 * EVERY field access in this module goes through this map. A bare
 * `fields[56]` is banned: the failure mode of an off-by-one here is not a
 * crash but a plausible-looking marker at the wrong actor's coordinates, which
 * no amount of downstream validation can detect. `gdeltExport.test.mjs` pins
 * each index below by name against real rows.
 *
 * Three different code systems appear in one row and they are not
 * interchangeable — see `COUNTRY_CODE_SCHEMES` below.
 */
export const COL = Object.freeze({
  GLOBAL_EVENT_ID: 0,
  SQLDATE: 1,
  MONTH_YEAR: 2,
  YEAR: 3,
  FRACTION_DATE: 4,

  ACTOR1_CODE: 5,
  ACTOR1_NAME: 6,
  ACTOR1_COUNTRY_CODE: 7,

  ACTOR2_CODE: 15,
  ACTOR2_NAME: 16,
  ACTOR2_COUNTRY_CODE: 17,

  IS_ROOT_EVENT: 25,
  EVENT_CODE: 26,
  EVENT_BASE_CODE: 27,
  EVENT_ROOT_CODE: 28,
  QUAD_CLASS: 29,
  GOLDSTEIN_SCALE: 30,
  NUM_MENTIONS: 31,
  NUM_SOURCES: 32,
  NUM_ARTICLES: 33,
  AVG_TONE: 34,

  ACTOR1_GEO_TYPE: 35,
  ACTOR1_GEO_FULLNAME: 36,
  ACTOR1_GEO_LAT: 40,
  ACTOR1_GEO_LONG: 41,

  ACTOR2_GEO_TYPE: 43,
  ACTOR2_GEO_FULLNAME: 44,
  ACTOR2_GEO_LAT: 48,
  ACTOR2_GEO_LONG: 49,

  // The ACTION geography is where the event HAPPENED. Actor1/Actor2 geography
  // is where those actors are based, which is frequently a different continent
  // — a US State Department statement about Gaza carries Actor1 in Washington.
  // Plotting an actor's coordinates would put events on the wrong side of the
  // world while looking entirely reasonable.
  ACTION_GEO_TYPE: 51,
  ACTION_GEO_FULLNAME: 52,
  ACTION_GEO_COUNTRY_CODE: 53,
  ACTION_GEO_ADM1_CODE: 54,
  ACTION_GEO_ADM2_CODE: 55,
  ACTION_GEO_LAT: 56,
  ACTION_GEO_LONG: 57,
  ACTION_GEO_FEATURE_ID: 58,

  DATE_ADDED: 59,
  SOURCE_URL: 60,
});

/**
 * Which coding scheme each country-ish column uses. Documented as data because
 * getting it wrong is silent: FIPS `CH` is China and ISO `CH` is Switzerland,
 * so an ISO lookup renders Chinese events in the Alps and Austrian events in
 * Australia.
 *
 * The split is GDELT's documented design, not an inference: gdeltproject.org's
 * data page states that CAMEO country codes are used in the Actor fields while
 * FIPS country codes are used in the Geo fields. Confirmed independently
 * against real rows in `docs/PHASE1-DECISIONS.md` §5(a).
 */
export const COUNTRY_CODE_SCHEMES = Object.freeze({
  [COL.ACTION_GEO_COUNTRY_CODE]: 'FIPS-10-4',
  [COL.ACTOR1_COUNTRY_CODE]: 'CAMEO-3',
  [COL.ACTOR2_COUNTRY_CODE]: 'CAMEO-3',
});

/**
 * `ActionGeo_Type` values, from the codebook.
 *
 * Types 1, 2 and 5 STILL CARRY a lat/long — the centroid of the country or
 * state — with a blank numeric FeatureID. They are not missing data; they are
 * data at a precision a point marker cannot honestly represent.
 */
export const GEO_TYPE = Object.freeze({
  NONE: 0,
  COUNTRY: 1,
  US_STATE: 2,
  US_CITY: 3,
  WORLD_CITY: 4,
  WORLD_STATE: 5,
});

/** Geo types precise enough to plot as a point. See `docs/PHASE1-DECISIONS.md` §5(b). */
export const PLOTTABLE_GEO_TYPES = Object.freeze([GEO_TYPE.US_CITY, GEO_TYPE.WORLD_CITY]);

/** Default upstream base. Overridable so tests never touch the network. */
export const EXPORT_BASE_URL = 'http://data.gdeltproject.org/gdeltv2/';

/** One publish window. GDELT emits on the quarter hour, UTC. */
export const SLICE_MS = 900_000;

/** Longest place label retained. */
const MAX_PLACE_CHARS = 120;

/** Coordinate rounding for the dedupe key (~110 m). */
const DEDUPE_DECIMALS = 3;

/**
 * Why a row was dropped. Every rejection is counted under one of these so the
 * proxy can log the funnel and a shrinking window has a stated cause rather
 * than looking like upstream going quiet.
 */
export const REJECT_REASONS = Object.freeze([
  'wrong_field_count',
  'no_geo',
  'low_precision',
  'bad_url',
  'bad_date',
]);

/** A zeroed rejection tally. */
function emptyRejected() {
  const out = {};
  for (const reason of REJECT_REASONS) out[reason] = 0;
  return out;
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

/** Finite number, or null. Blank strings are null, not 0. */
function num(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Non-negative integer, or null. */
function int(value) {
  const parsed = num(value);
  return parsed === null ? null : Math.trunc(parsed);
}

/**
 * `DATEADDED` (YYYYMMDDHHMMSS, UTC) to epoch ms.
 *
 * Built through `Date.UTC` rather than `new Date(string)`: the latter reads a
 * bare numeric string as neither ISO nor UTC and would silently shift the whole
 * window by the host's offset. There is deliberately no local-timezone path in
 * this module.
 *
 * @param {*} value Raw DATEADDED value.
 * @returns {?number} Epoch ms, or null when unparseable.
 */
export function parseDateAdded(value) {
  const raw = String(value ?? '').trim();
  if (!/^\d{14}$/.test(raw)) return null;
  const year = Number(raw.slice(0, 4));
  const month = Number(raw.slice(4, 6));
  const day = Number(raw.slice(6, 8));
  const hour = Number(raw.slice(8, 10));
  const minute = Number(raw.slice(10, 12));
  const second = Number(raw.slice(12, 14));
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  if (hour > 23 || minute > 59 || second > 59) return null;
  const ms = Date.UTC(year, month - 1, day, hour, minute, second);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * `SQLDATE` (YYYYMMDD, UTC) to epoch ms at midnight.
 *
 * This is the date of the EVENT DESCRIBED, extracted from article text — not
 * the ingest time and not the publication date. It can precede the article by
 * days or years. Never present it as "when this was reported".
 *
 * @param {*} value Raw SQLDATE value.
 * @returns {?number} Epoch ms at UTC midnight, or null.
 */
export function parseSqlDate(value) {
  const raw = String(value ?? '').trim();
  if (!/^\d{8}$/.test(raw)) return null;
  const year = Number(raw.slice(0, 4));
  const month = Number(raw.slice(4, 6));
  const day = Number(raw.slice(6, 8));
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const ms = Date.UTC(year, month - 1, day);
  return Number.isFinite(ms) ? ms : null;
}

/** Two-digit zero pad. */
function pad2(value) {
  return String(value).padStart(2, '0');
}

/**
 * Format epoch ms as a slice key (YYYYMMDDHHMMSS), floored to the quarter hour.
 * @param {number} ms Epoch ms.
 * @returns {?string} Slice key, or null for a non-finite input.
 */
export function sliceKeyForTime(ms) {
  const value = Number(ms);
  if (!Number.isFinite(value)) return null;
  const floored = Math.floor(value / SLICE_MS) * SLICE_MS;
  const date = new Date(floored);
  return `${date.getUTCFullYear()}${pad2(date.getUTCMonth() + 1)}${pad2(date.getUTCDate())}`
    + `${pad2(date.getUTCHours())}${pad2(date.getUTCMinutes())}${pad2(date.getUTCSeconds())}`;
}

/**
 * Slice key a `DATEADDED` value belongs to.
 * @param {*} value Raw DATEADDED value.
 * @returns {?string} Slice key, or null.
 */
export function sliceKeyFromDateAdded(value) {
  const ms = parseDateAdded(value);
  return ms === null ? null : sliceKeyForTime(ms);
}

/**
 * The slice key `steps` windows before `key`.
 * @param {string} key Slice key.
 * @param {number} [steps=1] Windows to step back.
 * @returns {?string} Earlier slice key, or null when `key` is unparseable.
 */
export function previousSliceKey(key, steps = 1) {
  const ms = parseDateAdded(key);
  if (ms === null) return null;
  const back = Math.max(0, Math.floor(Number(steps) || 0));
  return sliceKeyForTime(ms - back * SLICE_MS);
}

/**
 * Deterministic export URL for one slice.
 *
 * Used for BACKFILL only. The newest slice is discovered from
 * `lastupdate.txt`, never built from the local clock: GDELT's publish time
 * drifts and a 404 on the current quarter hour is normal.
 *
 * @param {string|number|Date} slice Slice key, epoch ms, or Date.
 * @param {string} [base=EXPORT_BASE_URL] Upstream base URL.
 * @returns {?string} Absolute URL, or null when the slice is unusable.
 */
export function exportUrlForSlice(slice, base = EXPORT_BASE_URL) {
  let key = null;
  if (slice instanceof Date) key = sliceKeyForTime(slice.getTime());
  else if (typeof slice === 'number') key = sliceKeyForTime(slice);
  else key = /^\d{14}$/.test(String(slice ?? '').trim()) ? String(slice).trim() : null;
  if (!key) return null;
  return `${String(base).replace(/\/*$/, '/')}${key}.export.CSV.zip`;
}

/**
 * Parse `lastupdate.txt` and return the newest export URL.
 *
 * Format is three lines of `size hash url`, one each for the export, mentions,
 * and GKG files. Only the `.export.CSV.zip` line is ours; the other two are
 * matched by the same shape and must not be picked up by accident.
 *
 * @param {*} text Raw body.
 * @returns {?{url: string, slice: string, size: ?number}} Newest slice, or null.
 */
export function parseLastUpdate(text) {
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 3) continue;
    const url = parts[parts.length - 1];
    const match = /\/(\d{14})\.export\.CSV\.zip$/i.exec(url);
    if (!match) continue;
    const parsed = safeHttpUrl(url);
    if (!parsed) continue;
    return { url: parsed.href, slice: match[1], size: int(parts[0]) };
  }
  return null;
}

/**
 * Parse one export row into a record, or null when a drop rule rejects it.
 *
 * @param {string} line One tab-separated row, without its line terminator.
 * @param {object} [options]
 * @param {boolean} [options.requirePrecise=true] Drop country/state centroids.
 * @param {(reason: string) => void} [options.onReject] Rejection-reason sink.
 * @returns {?object} Record, or null.
 */
export function parseExportRow(line, { requirePrecise = true, onReject } = {}) {
  const reject = (reason) => {
    if (typeof onReject === 'function') onReject(reason);
    return null;
  };

  const text = String(line ?? '').replace(/\r$/, '');
  if (!text) return reject('wrong_field_count');
  const fields = text.split('\t');
  if (fields.length !== EXPORT_COLUMN_COUNT) return reject('wrong_field_count');

  const geoType = int(fields[COL.ACTION_GEO_TYPE]);
  const lat = num(fields[COL.ACTION_GEO_LAT]);
  const lon = num(fields[COL.ACTION_GEO_LONG]);
  if (geoType === null || geoType === GEO_TYPE.NONE) return reject('no_geo');
  if (lat === null || lon === null) return reject('no_geo');
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return reject('no_geo');
  if (requirePrecise && !PLOTTABLE_GEO_TYPES.includes(geoType)) return reject('low_precision');

  const url = safeHttpUrl(fields[COL.SOURCE_URL]);
  if (!url) return reject('bad_url');

  const ingestedAt = parseDateAdded(fields[COL.DATE_ADDED]);
  if (ingestedAt === null) return reject('bad_date');

  const eventDate = parseSqlDate(fields[COL.SQLDATE]);
  // Gap between the day GDELT ingested the row and the day it says the event
  // happened. Rare (1.4% of the fixture) but not negligible: a marker for an
  // event dated a year ago must not read as "happening now".
  const retrospectiveDays = eventDate === null
    ? null
    : Math.max(0, Math.round((Math.floor(ingestedAt / 86_400_000) * 86_400_000 - eventDate) / 86_400_000));

  return {
    id: String(fields[COL.GLOBAL_EVENT_ID] ?? '').trim(),
    lat,
    lon,
    place: cleanText(fields[COL.ACTION_GEO_FULLNAME], MAX_PLACE_CHARS) || null,
    geoPrecision: geoType,
    countryFips: cleanText(fields[COL.ACTION_GEO_COUNTRY_CODE], 8) || null,
    ingestedAt,
    // The raw YYYYMMDDHHMMSS as served, kept so a caller can derive the slice
    // key a row belongs to without re-deriving it from epoch ms.
    rawDateAdded: String(fields[COL.DATE_ADDED] ?? '').trim(),
    eventDate,
    retrospectiveDays,
    rootCode: cleanText(fields[COL.EVENT_ROOT_CODE], 4) || null,
    quadClass: int(fields[COL.QUAD_CLASS]),
    goldstein: num(fields[COL.GOLDSTEIN_SCALE]),
    tone: num(fields[COL.AVG_TONE]),
    numArticles: int(fields[COL.NUM_ARTICLES]),
    numMentions: int(fields[COL.NUM_MENTIONS]),
    numSources: int(fields[COL.NUM_SOURCES]),
    isRoot: int(fields[COL.IS_ROOT_EVENT]) === 1,
    url: url.href,
    domain: url.hostname.replace(/^www\./, ''),
  };
}

/**
 * Parse a whole export file.
 *
 * Returns a rejection tally alongside the records rather than only the
 * survivors, so a window that shrinks has a stated cause. Tolerates CRLF, a
 * trailing newline, and blank lines; the export ships no header row.
 *
 * @param {*} text Decoded file contents.
 * @param {object} [options]
 * @param {boolean} [options.requirePrecise=true] Drop country/state centroids.
 * @returns {{records: Array<object>, rejected: object, total: number}} Parse result.
 */
export function parseExportTsv(text, { requirePrecise = true } = {}) {
  const rejected = emptyRejected();
  const records = [];
  let total = 0;
  for (const line of String(text ?? '').split('\n')) {
    if (!line.trim()) continue;
    total += 1;
    const record = parseExportRow(line, {
      requirePrecise,
      onReject: (reason) => { rejected[reason] += 1; },
    });
    if (record) records.push(record);
  }
  return { records, rejected, total };
}

/** Deterministic dedupe key: one article at one place is one event. */
function dedupeKey(record) {
  return `${record.url}|${record.lat.toFixed(DEDUPE_DECIMALS)},${record.lon.toFixed(DEDUPE_DECIMALS)}`;
}

/**
 * Collapse rows that describe the same article at the same place.
 *
 * NOT an optimisation — a correctness requirement. One well-covered story
 * routinely generates several rows (the fixture carries 209 rows for far fewer
 * distinct articles), and without this a single story renders as a cluster of
 * stacked markers that reads as several separate incidents.
 *
 * WHICH ROW SURVIVES IS POLICY, NOT WIRE FORMAT, so it is injectable. One
 * article commonly yields several DIFFERENT coded events at one place — a
 * meeting and a demand, or a protest and a statement — and collapsing them by
 * article volume alone silently discards the more serious one whenever the
 * duller one was better covered. This module has no notion of severity, so it
 * defaults to article volume and lets `eventsFeed.js` pass a ranking that
 * knows about categories.
 *
 * Ties break on the lowest `GLOBALEVENTID`, so the choice is deterministic and
 * testable rather than dependent on input order. `duplicates` is retained so
 * the UI can say "5 reports" instead of drawing five markers.
 *
 * @param {Array<object>} records Parsed records.
 * @param {object} [options]
 * @param {(a: object, b: object) => number} [options.rank] Positive when `a`
 *   should survive over `b`. Defaults to article volume, then lowest id.
 * @returns {Array<object>} Deduplicated records, each with a `duplicates` count.
 */
export function defaultDedupeRank(a, b) {
  const articles = (a?.numArticles ?? 0) - (b?.numArticles ?? 0);
  if (articles !== 0) return articles;
  return String(b?.id ?? '').localeCompare(String(a?.id ?? ''));
}

export function dedupeExportRecords(records, { rank = defaultDedupeRank } = {}) {
  const byKey = new Map();
  const passthrough = [];
  for (const record of Array.isArray(records) ? records : []) {
    if (!record) continue;
    // A record with no usable coordinate cannot form a location key. Collapsing
    // is not this function's licence to DISCARD — dropping is the drop rules'
    // job, and a silent loss here would be invisible to the rejection funnel.
    if (!Number.isFinite(record.lat) || !Number.isFinite(record.lon)) {
      passthrough.push({ ...record, duplicates: 1 });
      continue;
    }
    const key = dedupeKey(record);
    const held = byKey.get(key);
    if (!held) {
      byKey.set(key, { ...record, duplicates: 1 });
      continue;
    }
    held.duplicates += 1;
    if (rank(record, held) > 0) {
      byKey.set(key, { ...record, duplicates: held.duplicates });
    }
  }
  return [...byKey.values(), ...passthrough];
}
