// src/data/eventsFeed.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseExportTsv } from './gdeltExport.js';
import {
  EVENT_CATEGORIES,
  annotateSharedArticles,
  EVENT_CATEGORY_IDS,
  EVENT_DEFAULT_CATEGORY_IDS,
  EVENT_SEVERITY_MODEL,
  EVENT_SEVERITY_WEIGHTS,
  RETIRED_CATEGORY_CODES,
  categoryForRootCode,
  classifyEventRecords,
  coerceEventCategories,
  decodeEventCategories,
  encodeEventCategories,
  eventCategory,
  eventMarkerPixelSize,
  normalizeEventCategories,
  scoreEventSeverity,
  selectEventsForRender,
} from './eventsFeed.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SAMPLE = fs.readFileSync(
  path.join(__dirname, 'fixtures', 'gdelt-export-sample.tsv'),
  'utf8',
);

const classifiedFixture = () => classifyEventRecords(parseExportTsv(SAMPLE).records);

const ALL_ROOTS = Array.from({ length: 20 }, (_, i) => String(i + 1).padStart(2, '0'));

test('the five categories partition CAMEO roots 01-20 totally and disjointly', () => {
  const seen = new Map();
  for (const spec of EVENT_CATEGORIES) {
    for (const root of spec.roots) {
      assert.ok(!seen.has(root), `root ${root} claimed by both ${seen.get(root)} and ${spec.id}`);
      seen.set(root, spec.id);
    }
  }
  for (const root of ALL_ROOTS) {
    assert.ok(seen.has(root), `root ${root} belongs to some category`);
    assert.equal(categoryForRootCode(root), seen.get(root));
  }
  assert.equal(seen.size, 20, 'exactly the 20 CAMEO roots, no invented ones');
});

// The defect this table was rewritten to fix. The original mapping keyed
// `conflict` on `rootCode in {18,19,20} OR quadClass === 4`; because QuadClass
// is a coarsening of the root code, every root-17 row is also quadClass 4, so
// `conflict` absorbed all of them and `coercion` could never match anything.
test('COERCE lands in coercion, not swallowed by conflict', () => {
  assert.equal(categoryForRootCode('17'), 'coercion');
  assert.equal(categoryForRootCode('15'), 'coercion');
  assert.equal(categoryForRootCode('16'), 'coercion');
  assert.equal(categoryForRootCode('13'), 'coercion');
  assert.equal(categoryForRootCode('19'), 'conflict');
  assert.equal(categoryForRootCode('14'), 'unrest');

  const byCategory = new Map();
  for (const record of classifiedFixture()) {
    byCategory.set(record.category, (byCategory.get(record.category) || 0) + 1);
  }
  // Every category draws real rows from the real fixture. An always-empty
  // category is exactly the dishonest-UI outcome this model exists to avoid.
  for (const id of EVENT_CATEGORY_IDS) {
    assert.ok(byCategory.get(id) > 0, `${id} matches real rows (got ${byCategory.get(id) || 0})`);
  }
});

test('an unknown or blank root code lands nowhere rather than in a default bucket', () => {
  for (const value of ['', null, undefined, '99', '00', 'xx', '21']) {
    assert.equal(categoryForRootCode(value), null, `rejects ${JSON.stringify(value)}`);
  }
  // A one-character code is zero-padded, matching how GDELT writes them.
  assert.equal(categoryForRootCode('4'), 'diplomacy');
  assert.equal(categoryForRootCode('04'), 'diplomacy');
});

test('classification drops unknown roots instead of rendering them mislabelled', () => {
  const records = [
    { id: '1', rootCode: '19', numArticles: 4, goldstein: -9 },
    { id: '2', rootCode: '99', numArticles: 4, goldstein: 0 },
  ];
  const out = classifyEventRecords(records);
  assert.equal(out.length, 1);
  assert.equal(out[0].id, '1');
  assert.equal(out[0].category, 'conflict');
});

test('every fixture record classifies and carries a severity', () => {
  const records = classifiedFixture();
  assert.ok(records.length > 0);
  for (const record of records) {
    assert.ok(EVENT_CATEGORY_IDS.includes(record.category));
    assert.ok(Number.isInteger(record.severity));
    assert.ok(record.severity >= 0 && record.severity <= 100);
  }
  // Sorted most-severe first, so a server-side cap keeps the top of the ranking.
  for (let i = 1; i < records.length; i += 1) {
    assert.ok(records[i - 1].severity >= records[i].severity);
  }
});

test('severity rises with conflict intensity and with coverage', () => {
  const context = { maxArticles: 100 };
  const base = { category: 'conflict', numArticles: 10, goldstein: 0 };
  const conflictual = scoreEventSeverity({ ...base, goldstein: -10 }, context);
  const cooperative = scoreEventSeverity({ ...base, goldstein: 10 }, context);
  assert.ok(conflictual > cooperative, 'Goldstein term orders by conflict intensity');

  const wellCovered = scoreEventSeverity({ ...base, numArticles: 100 }, context);
  const thinlyCovered = scoreEventSeverity({ ...base, numArticles: 1 }, context);
  assert.ok(wellCovered > thinlyCovered, 'coverage term orders by article volume');

  const violent = scoreEventSeverity({ ...base, category: 'conflict' }, context);
  const chatter = scoreEventSeverity({ ...base, category: 'diplomacy' }, context);
  assert.ok(violent > chatter, 'category weight orders by CAMEO class');
});

test('severity is bounded and never NaN on missing fields', () => {
  for (const record of [{}, { category: 'conflict' }, { numArticles: 'x', goldstein: 'y' }, null]) {
    const score = scoreEventSeverity(record, { maxArticles: 50 });
    assert.ok(Number.isInteger(score), `integer for ${JSON.stringify(record)}`);
    assert.ok(score >= 0 && score <= 100);
  }
});

test('the severity model is named and each term can be switched off', () => {
  assert.equal(EVENT_SEVERITY_MODEL, 'cameo-intensity');
  assert.equal(EVENT_SEVERITY_WEIGHTS.tone.enabled, false);
  assert.equal(EVENT_SEVERITY_WEIGHTS.goldstein.enabled, true);
  assert.equal(EVENT_SEVERITY_WEIGHTS.coverage.enabled, true);

  const flat = { ...EVENT_SEVERITY_WEIGHTS, coverage: { enabled: false }, goldstein: { enabled: false } };
  const record = { category: 'conflict', numArticles: 1, goldstein: 10 };
  assert.equal(scoreEventSeverity(record, { maxArticles: 100, weights: flat }), 100);
});

test('diplomacy is off by default because it is most of the feed', () => {
  assert.deepEqual([...EVENT_DEFAULT_CATEGORY_IDS], ['conflict', 'unrest', 'coercion', 'dissent']);
  assert.ok(!EVENT_DEFAULT_CATEGORY_IDS.includes('diplomacy'));
  assert.deepEqual(normalizeEventCategories([]), [...EVENT_DEFAULT_CATEGORY_IDS]);
  assert.deepEqual(normalizeEventCategories(null), [...EVENT_DEFAULT_CATEGORY_IDS]);
  assert.deepEqual(coerceEventCategories(undefined), [...EVENT_DEFAULT_CATEGORY_IDS]);

  // And it really is the bulk of a window, which is why.
  const records = classifiedFixture();
  const diplomacy = records.filter((record) => record.category === 'diplomacy').length;
  assert.ok(diplomacy / records.length > 0.5, `diplomacy dominates (${diplomacy}/${records.length})`);
});

test('category codes round-trip through the share-link codec', () => {
  for (const spec of EVENT_CATEGORIES) {
    assert.equal(encodeEventCategories([spec.id]), spec.code);
    assert.deepEqual(decodeEventCategories(spec.code), [spec.id]);
  }
  assert.equal(encodeEventCategories(['diplomacy', 'conflict']), 'cy');
  assert.deepEqual(decodeEventCategories('cy'), ['conflict', 'diplomacy']);
  // Canonical order regardless of request order — the durable value must
  // compare by ===, so it cannot depend on how the chips were clicked.
  assert.equal(encodeEventCategories(['dissent', 'conflict']), encodeEventCategories(['conflict', 'dissent']));
});

test('retired GKG codes are dropped, not reinterpreted', () => {
  assert.deepEqual([...RETIRED_CATEGORY_CODES].sort(), ['d', 'e', 'h', 'p']);
  // No retired letter may be reused by an active category — that is what would
  // make an old link silently select something it never asked for.
  for (const spec of EVENT_CATEGORIES) {
    assert.ok(!RETIRED_CATEGORY_CODES.has(spec.code), `${spec.id} does not reuse ${spec.code}`);
  }
  // An old conflict+disaster link keeps conflict and loses disaster.
  assert.deepEqual(decodeEventCategories('cd'), ['conflict']);
  // An old humanitarian+economic link named nothing that still exists, so it
  // falls back to the default view rather than blanking the layer.
  assert.deepEqual(decodeEventCategories('he'), [...EVENT_DEFAULT_CATEGORY_IDS]);
  assert.deepEqual(decodeEventCategories('cphed'), ['conflict']);
});

test('the codec still fails closed on genuinely invalid values', () => {
  for (const value of ['', 'z', 'cz', 'cc', 'C', 'c.', 'c_y', '1', 'abcdefghi', null, undefined]) {
    assert.equal(decodeEventCategories(value), null, `rejects ${JSON.stringify(value)}`);
  }
  assert.equal(coerceEventCategories(42), null);
  assert.equal(coerceEventCategories({}), null);
});

test('the filter is applied before the entity budget', () => {
  const records = [
    { id: 'a', category: 'diplomacy', severity: 90 },
    { id: 'b', category: 'diplomacy', severity: 80 },
    { id: 'c', category: 'conflict', severity: 10 },
  ];
  // A global ranking would have spent the budget on diplomacy and returned
  // nothing for a conflict-only filter.
  const selected = selectEventsForRender(records, { categories: ['conflict'], maxEntities: 2 });
  assert.equal(selected.length, 1);
  assert.equal(selected[0].id, 'c');
  assert.equal(selected[0].categoryLabel, 'CONFLICT');
  assert.equal(selected[0].color, eventCategory('conflict').color);

  const capped = selectEventsForRender(records, { categories: EVENT_CATEGORY_IDS, maxEntities: 2 });
  assert.deepEqual(capped.map((record) => record.id), ['a', 'b']);
});

test('render selection is stable when severities tie', () => {
  const records = [
    { id: 'b2', category: 'conflict', severity: 50 },
    { id: 'a1', category: 'conflict', severity: 50 },
  ];
  assert.deepEqual(
    selectEventsForRender(records, { categories: ['conflict'] }).map((r) => r.id),
    ['a1', 'b2'],
  );
});

test('marker size scales with severity and is bounded', () => {
  assert.equal(eventMarkerPixelSize({ severity: 0 }), 6);
  assert.equal(eventMarkerPixelSize({ severity: 100 }), 16);
  assert.equal(eventMarkerPixelSize({ severity: 200 }), 16);
  assert.equal(eventMarkerPixelSize({ severity: -5 }), 6);
  assert.equal(eventMarkerPixelSize({}), 6);
});

test('markers sharing a source article are annotated with their siblings', () => {
  // One article routinely places events at several spots — 37% of markers in
  // the reference slice — and GKG entities are per ARTICLE, so those markers
  // would otherwise show identical names with nothing explaining why.
  const records = [
    { id: '1', url: 'https://x/a', place: 'Seoul, South Korea' },
    { id: '2', url: 'https://x/a', place: 'Kyiv, Ukraine' },
    { id: '3', url: 'https://x/a', place: 'Papamoa, Bay of Plenty' },
    { id: '4', url: 'https://x/b', place: 'Toledo, Ohio' },
  ];
  annotateSharedArticles(records);
  assert.equal(records[0].sharedArticle.count, 3);
  assert.deepEqual(records[0].sharedArticle.places, ['Kyiv', 'Papamoa']);
  assert.deepEqual(records[1].sharedArticle.places, ['Seoul', 'Papamoa']);
  // A record is never listed as its own sibling.
  for (const record of records.slice(0, 3)) {
    assert.ok(!record.sharedArticle.places.includes(String(record.place).split(',')[0]));
  }
  assert.equal(records[3].sharedArticle, undefined, 'a lone article is not annotated');
});

test('annotation runs after the cap, so it never names an off-screen sibling', () => {
  // "Same report as Memphis" is only meaningful if Memphis is actually drawn.
  const records = [
    { id: 'a', category: 'conflict', severity: 90, url: 'https://x/a', place: 'Shelby County' },
    { id: 'b', category: 'conflict', severity: 10, url: 'https://x/a', place: 'Memphis' },
  ];
  const both = selectEventsForRender(records, { categories: ['conflict'] });
  assert.equal(both[0].sharedArticle.count, 2);

  const capped = selectEventsForRender(records, { categories: ['conflict'], maxEntities: 1 });
  assert.equal(capped.length, 1);
  assert.equal(capped[0].sharedArticle, undefined, 'the sibling did not survive the budget');
});

test('annotation tolerates records with no URL', () => {
  const records = [{ id: '1', place: 'A' }, { id: '2', place: 'B' }];
  assert.doesNotThrow(() => annotateSharedArticles(records));
  assert.equal(records[0].sharedArticle, undefined);
  assert.doesNotThrow(() => annotateSharedArticles(null));
});
