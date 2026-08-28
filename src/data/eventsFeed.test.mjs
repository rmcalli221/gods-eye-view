// src/data/eventsFeed.test.mjs
// Fixture-driven tests for the pure GDELT GEO 2.0 parser, severity table, and
// category codec. NO NETWORK: every input is a committed fixture under
// src/data/fixtures/ built from GDELT's documented response shape and marked
// unverified against live data in that directory's README.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  EVENT_CATEGORIES,
  EVENT_CATEGORY_IDS,
  EVENT_MAX_ARTICLES,
  EVENT_SEVERITY_MODEL,
  EVENT_SEVERITY_WEIGHTS,
  decodeEventCategories,
  encodeEventCategories,
  eventCategory,
  eventMarkerPixelSize,
  extractArticleLinks,
  mergeCategoryResults,
  normalizeEventCategories,
  parseGeoFeatureCollection,
  scoreCategoryRecords,
  scoreEventSeverity,
  selectEventsForRender,
} from './eventsFeed.js';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const fixture = (name) => JSON.parse(readFileSync(path.join(FIXTURES, name), 'utf8'));

const CONFLICT = fixture('gdelt-geo-conflict-sample.json');
const DISASTER = fixture('gdelt-geo-disaster-sample.json');
const EMPTY = fixture('gdelt-geo-empty.json');
const MALFORMED = fixture('gdelt-geo-malformed.json');

// ── Category table ──────────────────────────────────────────────────────────

test('category table covers the five product categories with unique ids and codes', () => {
  assert.deepEqual(
    [...EVENT_CATEGORY_IDS].sort(),
    ['conflict', 'disaster', 'economic', 'humanitarian', 'political'],
  );
  assert.equal(new Set(EVENT_CATEGORIES.map((c) => c.code)).size, EVENT_CATEGORIES.length);
  for (const category of EVENT_CATEGORIES) {
    assert.match(category.code, /^[a-z]$/, `${category.id} code is one lowercase letter`);
    assert.ok(category.query.length > 0, `${category.id} carries a GDELT query`);
    assert.match(category.color, /^#[0-9a-f]{6}$/i, `${category.id} colour is a hex triplet`);
    assert.ok(category.weight > 0 && category.weight <= 1, `${category.id} weight in (0,1]`);
  }
  assert.equal(eventCategory('conflict').label, 'CONFLICT');
  assert.equal(eventCategory('nope'), null);
  assert.equal(eventCategory(undefined), null);
});

// ── Parser ──────────────────────────────────────────────────────────────────

test('parser rejects a malformed payload with null, and reports an empty feed as []', () => {
  // The null/[] distinction is load-bearing: the proxy serves stale for null
  // (not GeoJSON) and caches [] (a genuinely quiet category).
  assert.equal(parseGeoFeatureCollection(MALFORMED, { category: 'conflict' }), null);
  assert.equal(parseGeoFeatureCollection(null, { category: 'conflict' }), null);
  assert.equal(parseGeoFeatureCollection('a string', { category: 'conflict' }), null);
  assert.equal(parseGeoFeatureCollection({ features: 'nope' }, { category: 'conflict' }), null);
  assert.deepEqual(parseGeoFeatureCollection(EMPTY, { category: 'conflict' }), []);
});

test('parser rejects an unknown category rather than emitting unclassifiable records', () => {
  assert.equal(parseGeoFeatureCollection(CONFLICT, { category: 'markets' }), null);
  assert.equal(parseGeoFeatureCollection(CONFLICT, {}), null);
});

test('parser drops features with absent, non-numeric, or out-of-range coordinates', () => {
  const records = parseGeoFeatureCollection(CONFLICT, { category: 'conflict' });
  assert.equal(records.length, 4, 'three invalid-geometry features are dropped');
  for (const record of records) {
    assert.ok(Number.isFinite(record.lat) && record.lat >= -90 && record.lat <= 90);
    assert.ok(Number.isFinite(record.lon) && record.lon >= -180 && record.lon <= 180);
  }
  assert.ok(!records.some((r) => r.place === 'Out Of Range Longitude'));
  assert.ok(!records.some((r) => r.place === 'Non Numeric Coordinate'));
  assert.ok(!records.some((r) => r.place === 'No Geometry At All'));
});

test('parser produces a stable, deterministic id per category and location', () => {
  const first = parseGeoFeatureCollection(CONFLICT, { category: 'conflict' });
  const second = parseGeoFeatureCollection(CONFLICT, { category: 'conflict' });
  assert.deepEqual(first.map((r) => r.id), second.map((r) => r.id));
  assert.equal(first[0].id, 'evt:conflict:49.981,36.230');
});

test('parser maps a missing count to null rather than NaN or zero', () => {
  const records = parseGeoFeatureCollection(CONFLICT, { category: 'conflict' });
  const countless = records.find((r) => r.place === 'Location With No Count Field');
  assert.equal(countless.count, null);
  assert.equal(records[0].count, 42);
});

test('parser output is JSON-safe with no undefined or NaN fields', () => {
  const records = parseGeoFeatureCollection(CONFLICT, { category: 'conflict' });
  assert.deepEqual(JSON.parse(JSON.stringify(records)), records);
  for (const record of records) {
    for (const [key, value] of Object.entries(record)) {
      assert.notEqual(value, undefined, `${key} must not be undefined`);
      if (typeof value === 'number') assert.ok(Number.isFinite(value), `${key} must be finite`);
    }
  }
});

test('parser honours maxRecords', () => {
  assert.equal(parseGeoFeatureCollection(CONFLICT, { category: 'conflict', maxRecords: 2 }).length, 2);
  assert.deepEqual(parseGeoFeatureCollection(CONFLICT, { category: 'conflict', maxRecords: 0 }), []);
});

// ── Article-link extraction (highest-risk parse) ─────────────────────────────

test('article extraction keeps http(s) links only and rejects other schemes', () => {
  const records = parseGeoFeatureCollection(CONFLICT, { category: 'conflict' });
  const london = records.find((r) => r.place === 'London, United Kingdom');
  assert.equal(london.articles.length, 1, 'the javascript: anchor is dropped');
  assert.equal(london.articles[0].url, 'https://example-news.org/c/7');
  assert.equal(
    extractArticleLinks('<a href="ftp://example.org/x">FTP</a>').length,
    0,
  );
  assert.equal(
    extractArticleLinks('<a href="data:text/html,<b>x</b>">Data</a>').length,
    0,
  );
});

test('article extraction dedupes, decodes entities, strips tags, and caps at the article limit', () => {
  const records = parseGeoFeatureCollection(CONFLICT, { category: 'conflict' });
  const kharkiv = records[0];
  assert.equal(kharkiv.articles.length, EVENT_MAX_ARTICLES, 'a fifth anchor is beyond the cap');
  assert.equal(new Set(kharkiv.articles.map((a) => a.url)).size, kharkiv.articles.length);
  assert.equal(kharkiv.articles[2].title, 'Aid convoy rerouted & delayed');
  assert.equal(kharkiv.articles[1].domain, 'another-outlet.example', 'www. is stripped');
  assert.equal(
    extractArticleLinks('<a href="https://e.example/1"><b>Bold</b> headline</a>')[0].title,
    'Bold headline',
  );
});

test('article extraction returns [] for absent, empty, or link-free html', () => {
  assert.deepEqual(extractArticleLinks(undefined), []);
  assert.deepEqual(extractArticleLinks(''), []);
  assert.deepEqual(extractArticleLinks('<b>7 Articles</b><br />no anchors here'), []);
  assert.deepEqual(extractArticleLinks('<a href="https://e.example/1">Title</a>', 0), []);
});

test('article extraction is not stateful across calls (global regex lastIndex)', () => {
  const html = '<a href="https://e.example/1">One</a><a href="https://e.example/2">Two</a>';
  assert.deepEqual(extractArticleLinks(html), extractArticleLinks(html));
  assert.equal(extractArticleLinks(html).length, 2);
});

// ── Severity ────────────────────────────────────────────────────────────────

test('severity model is the declared coverage index, and its weight table is frozen', () => {
  assert.equal(EVENT_SEVERITY_MODEL, 'coverage-index');
  assert.equal(EVENT_SEVERITY_WEIGHTS.coverage.enabled, true);
  assert.equal(EVENT_SEVERITY_WEIGHTS.tone.enabled, false, 'GEO GeoJSON carries no tone');
  assert.ok(Object.isFrozen(EVENT_SEVERITY_WEIGHTS));
  assert.ok(Object.isFrozen(EVENT_SEVERITY_WEIGHTS.category));
  for (const id of EVENT_CATEGORY_IDS) {
    assert.ok(Number.isFinite(EVENT_SEVERITY_WEIGHTS.category[id]), `${id} has a weight`);
  }
});

test('severity is zero without a usable count and never leaves 0..100', () => {
  assert.equal(scoreEventSeverity({ category: 'conflict', count: null }, { maxCount: 40 }), 0);
  assert.equal(scoreEventSeverity({ category: 'conflict', count: 0 }, { maxCount: 40 }), 0);
  assert.equal(scoreEventSeverity({ category: 'conflict', count: NaN }, { maxCount: 40 }), 0);
  assert.equal(scoreEventSeverity({}, {}), 0);
  const top = scoreEventSeverity({ category: 'conflict', count: 9_999 }, { maxCount: 1 });
  assert.ok(top >= 0 && top <= 100, 'clamped even when count exceeds the fetch maximum');
});

test('severity rises monotonically with count inside one category', () => {
  const score = (count) => scoreEventSeverity({ category: 'conflict', count }, { maxCount: 100 });
  const series = [1, 5, 20, 60, 100].map(score);
  for (let i = 1; i < series.length; i += 1) {
    assert.ok(series[i] >= series[i - 1], `severity must not fall from ${series[i - 1]} to ${series[i]}`);
  }
  assert.equal(score(100), 100, 'the fetch maximum in the heaviest category tops the scale');
});

test('category weight orders equal coverage across categories', () => {
  const at = (category) => scoreEventSeverity({ category, count: 50 }, { maxCount: 50 });
  assert.ok(at('conflict') > at('disaster'));
  assert.ok(at('disaster') > at('humanitarian'));
  assert.ok(at('humanitarian') > at('political'));
  assert.ok(at('political') > at('economic'));
});

test('the coverage floor keeps the least-covered location in a category visible', () => {
  const lowest = scoreEventSeverity({ category: 'conflict', count: 1 }, { maxCount: 5_000 });
  assert.ok(lowest > 0, 'a single-article location still scores above zero');
});

test('a disabled tone term is inert, and enabling it applies the band multiplier', () => {
  const base = scoreEventSeverity(
    { category: 'conflict', count: 50, toneBand: 'severe' },
    { maxCount: 50 },
  );
  const toneOn = scoreEventSeverity(
    { category: 'conflict', count: 50, toneBand: 'baseline' },
    {
      maxCount: 50,
      weights: {
        ...EVENT_SEVERITY_WEIGHTS,
        tone: { enabled: true, bands: { severe: 1, elevated: 0.75, baseline: 0.5 } },
      },
    },
  );
  assert.equal(base, 100, 'the shipped model ignores toneBand entirely');
  assert.equal(toneOn, 50, 'switching the table on is the only change needed');
});

test('per-category scoring normalizes against that category own maximum', () => {
  const scored = scoreCategoryRecords([
    { id: 'a', category: 'conflict', count: 10 },
    { id: 'b', category: 'conflict', count: 100 },
  ]);
  assert.equal(scored[1].severity, 100);
  assert.ok(scored[0].severity < scored[1].severity);
  assert.deepEqual(scoreCategoryRecords([]), []);
  assert.deepEqual(scoreCategoryRecords(null), []);
});

// ── Merge and dedupe ────────────────────────────────────────────────────────

function scoredGroups() {
  return [
    {
      category: 'conflict',
      records: scoreCategoryRecords(parseGeoFeatureCollection(CONFLICT, { category: 'conflict' })),
    },
    {
      category: 'disaster',
      records: scoreCategoryRecords(parseGeoFeatureCollection(DISASTER, { category: 'disaster' })),
    },
  ];
}

test('merge deduplicates a shared location and keeps both categories with their own detail', () => {
  const merged = mergeCategoryResults(scoredGroups());
  const kharkiv = merged.find((r) => r.id === 'evt:49.981,36.230');
  assert.deepEqual(kharkiv.categories, ['conflict', 'disaster'], 'canonical category order');
  assert.equal(kharkiv.byCategory.conflict.count, 42);
  assert.equal(kharkiv.byCategory.disaster.count, 4);
  assert.notDeepEqual(
    kharkiv.byCategory.conflict.articles,
    kharkiv.byCategory.disaster.articles,
    'each category keeps its own article links',
  );
  assert.equal(
    kharkiv.severity,
    Math.max(kharkiv.byCategory.conflict.severity, kharkiv.byCategory.disaster.severity),
  );
  assert.equal(merged.filter((r) => r.id === 'evt:49.981,36.230').length, 1);
});

test('merge sorts by severity then id, and maxPoints bounds the payload', () => {
  const merged = mergeCategoryResults(scoredGroups());
  for (let i = 1; i < merged.length; i += 1) {
    assert.ok(merged[i - 1].severity >= merged[i].severity);
  }
  assert.equal(mergeCategoryResults(scoredGroups(), { maxPoints: 2 }).length, 2);
  assert.deepEqual(mergeCategoryResults(scoredGroups(), { maxPoints: 0 }), []);
  assert.deepEqual(mergeCategoryResults(null), []);
  assert.deepEqual(mergeCategoryResults([{ category: 'markets', records: [{ lat: 1, lon: 1 }] }]), []);
});

// ── Category filter codec ───────────────────────────────────────────────────

test('normalizing an empty or fully invalid filter means all categories, never none', () => {
  assert.deepEqual(normalizeEventCategories([]), [...EVENT_CATEGORY_IDS]);
  assert.deepEqual(normalizeEventCategories(null), [...EVENT_CATEGORY_IDS]);
  assert.deepEqual(normalizeEventCategories(['markets', 'cctv']), [...EVENT_CATEGORY_IDS]);
  assert.deepEqual(normalizeEventCategories(['CONFLICT', ' disaster ']), ['conflict', 'disaster']);
  assert.deepEqual(normalizeEventCategories(['disaster', 'conflict']), ['conflict', 'disaster']);
});

test('category codec round-trips in canonical order and rejects malformed values', () => {
  assert.equal(encodeEventCategories(['disaster', 'conflict']), 'cd');
  assert.equal(encodeEventCategories([]), 'cphed');
  assert.deepEqual(decodeEventCategories('cd'), ['conflict', 'disaster']);
  assert.deepEqual(decodeEventCategories('dc'), ['conflict', 'disaster'], 'order-insensitive');
  assert.deepEqual(decodeEventCategories(encodeEventCategories([])), [...EVENT_CATEGORY_IDS]);
  for (const bad of ['', 'z', 'cz', 'cc', 'cphedx', 'c.d', 'c_d', '1', null, undefined]) {
    assert.equal(decodeEventCategories(bad), null, `rejects ${JSON.stringify(bad)}`);
  }
});

// ── Render selection ────────────────────────────────────────────────────────

test('render selection applies the category filter BEFORE the entity budget', () => {
  // The point of the per-category proxy cap: filtering to one category must
  // yield that category's own depth, not whatever survived a global ranking.
  const records = Array.from({ length: 40 }, (_, index) => ({
    id: `evt:${index}`,
    lat: index * 0.1,
    lon: index * 0.1,
    place: `P${index}`,
    // 35 high-severity conflict points, 5 low-severity disaster points.
    categories: index < 35 ? ['conflict'] : ['disaster'],
    byCategory: index < 35
      ? { conflict: { count: 100, severity: 90, articles: [] } }
      : { disaster: { count: 2, severity: 9, articles: [] } },
    severity: index < 35 ? 90 : 9,
  }));
  const disasterOnly = selectEventsForRender(records, {
    categories: ['disaster'],
    maxEntities: 10,
  });
  assert.equal(disasterOnly.length, 5, 'all five disaster points survive a 10-entity budget');
  assert.ok(disasterOnly.every((r) => r.category === 'disaster'));

  const capped = selectEventsForRender(records, { maxEntities: 10 });
  assert.equal(capped.length, 10);
  assert.ok(capped.every((r) => r.category === 'conflict'), 'unfiltered, severity ranks');
});

test('render selection picks the highest-severity active category for colour and links', () => {
  const merged = mergeCategoryResults(scoredGroups());
  const [kharkiv] = selectEventsForRender(merged, { categories: ['conflict', 'disaster'] })
    .filter((r) => r.id === 'evt:49.981,36.230');
  assert.equal(kharkiv.category, 'conflict', 'conflict outscores disaster here');
  assert.equal(kharkiv.color, eventCategory('conflict').color);
  assert.equal(kharkiv.categoryLabel, 'CONFLICT');
  assert.equal(kharkiv.count, 42);
  assert.ok(kharkiv.articles.every((a) => a.url.startsWith('https://')));

  const [asDisaster] = selectEventsForRender(merged, { categories: ['disaster'] })
    .filter((r) => r.id === 'evt:49.981,36.230');
  assert.equal(asDisaster.category, 'disaster', 'the filter forces the disaster view');
  assert.equal(asDisaster.count, 4);
  assert.equal(asDisaster.articles[0].url, 'https://weather.example/x/1');
});

test('render selection drops records with no active category and tolerates junk', () => {
  assert.deepEqual(selectEventsForRender(null), []);
  assert.deepEqual(selectEventsForRender([{ id: 'x', lat: 0, lon: 0, categories: [] }]), []);
  assert.deepEqual(
    selectEventsForRender([{ id: 'x', lat: 0, lon: 0, categories: ['conflict'] }]),
    [],
    'a category with no byCategory detail is not renderable',
  );
});

test('marker pixel size scales with severity and stays bounded', () => {
  assert.equal(eventMarkerPixelSize({ severity: 0 }), 6);
  assert.equal(eventMarkerPixelSize({ severity: 100 }), 16);
  assert.ok(eventMarkerPixelSize({ severity: 50 }) > eventMarkerPixelSize({ severity: 10 }));
  assert.equal(eventMarkerPixelSize({}), 6, 'a missing severity is the floor, not NaN');
  assert.equal(eventMarkerPixelSize({ severity: 5_000 }), 16, 'clamped');
});
