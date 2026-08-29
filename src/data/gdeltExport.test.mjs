// src/data/gdeltExport.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  COL,
  EXPORT_BASE_URL,
  EXPORT_COLUMN_COUNT,
  GEO_TYPE,
  PLOTTABLE_GEO_TYPES,
  SLICE_MS,
  dedupeExportRecords,
  exportUrlForSlice,
  parseDateAdded,
  parseExportRow,
  parseExportTsv,
  parseLastUpdate,
  parseSqlDate,
  previousSliceKey,
  sliceKeyForTime,
  sliceKeyFromDateAdded,
} from './gdeltExport.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const readFixture = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');

const SAMPLE = readFixture('gdelt-export-sample.tsv');
const EDGE = readFixture('gdelt-export-edge.tsv');
/** GDELT's own 61 field names, in order. See `fixtures/README.md`. */
const SCHEMA = readFixture('gdelt-events-columns.txt').split('\n').filter(Boolean);
/** GDELT 1.0's 58 field names — first-party, and the offset anchor for the above. */
const SCHEMA_V1 = readFixture('gdelt-events-columns-v1.txt').split('\n').filter(Boolean);
/** The three fields 2.0 inserts into 1.0, one per geo block. */
const V2_INSERTIONS = ['Actor1Geo_ADM2Code', 'Actor2Geo_ADM2Code', 'ActionGeo_ADM2Code'];

const SAMPLE_LINES = SAMPLE.split('\n').filter((line) => line.trim());
/** Raw fields of one row, by GLOBALEVENTID. */
const rowById = (id) => {
  const line = SAMPLE_LINES.find((entry) => entry.split('\t')[0] === id);
  assert.ok(line, `fixture row ${id} present`);
  return { line, fields: line.split('\t') };
};

test('the fixture is 209 real rows of exactly 61 columns, UTF-8 with no BOM', () => {
  assert.equal(SAMPLE_LINES.length, 209);
  assert.ok(!SAMPLE.startsWith('﻿'), 'no BOM — a BOM would corrupt column 1');
  assert.ok(!SAMPLE.includes('\r'), 'LF endings');
  for (const line of SAMPLE_LINES) {
    assert.equal(line.split('\t').length, EXPORT_COLUMN_COUNT);
  }
});

// The regression guard the migration plan calls the highest-risk item: an
// off-by-one here plots the wrong actor's coordinates and looks entirely
// plausible on the globe. Each index is asserted by NAME against a real row.
test('every parsed field reads the column its name claims', () => {
  const { line, fields } = rowById('1320453556');
  const record = parseExportRow(line, { requirePrecise: false });
  assert.ok(record);

  assert.equal(record.id, fields[0]);
  assert.equal(String(record.geoPrecision), fields[51]);
  assert.equal(record.place, fields[52]);
  assert.equal(record.countryFips, fields[53]);
  assert.equal(String(record.lat), fields[56]);
  assert.equal(String(record.lon), fields[57]);
  assert.equal(record.url, fields[60]);
  assert.equal(record.rootCode, fields[28]);
  assert.equal(String(record.quadClass), fields[29]);
  assert.equal(String(record.goldstein), fields[30]);
  assert.equal(String(record.numMentions), fields[31]);
  assert.equal(String(record.numSources), fields[32]);
  assert.equal(String(record.numArticles), fields[33]);
  assert.equal(String(record.tone), fields[34]);
  assert.equal(record.isRoot, fields[25] === '1');
});

test('the committed column list is GDELT\'s 61 names, in order', () => {
  assert.equal(SCHEMA.length, EXPORT_COLUMN_COUNT);
  assert.equal(SCHEMA.length, 61);
  assert.equal(new Set(SCHEMA).size, 61, 'no duplicate names');
  // Spot-anchor the ends and the block that matters most, so a wholesale
  // corruption of the fixture cannot pass by being internally consistent.
  assert.equal(SCHEMA[0], 'GLOBALEVENTID');
  assert.equal(SCHEMA[1], 'SQLDATE');
  assert.equal(SCHEMA[59], 'DATEADDED');
  assert.equal(SCHEMA[60], 'SOURCEURL');
  assert.deepEqual(SCHEMA.slice(51, 59), [
    'ActionGeo_Type', 'ActionGeo_FullName', 'ActionGeo_CountryCode',
    'ActionGeo_ADM1Code', 'ActionGeo_ADM2Code', 'ActionGeo_Lat',
    'ActionGeo_Long', 'ActionGeo_FeatureID',
  ]);
});

// The regression guard that makes the column map a test failure rather than a
// documentation claim. Every entry in COL is checked against GDELT's own field
// name at that index.
//
// The comparison is MECHANICAL — lowercase, drop underscores — with no
// hand-written constant-to-name table anywhere. That is the point: a table
// written by hand can encode the same transcription error twice and agree with
// itself. Here the only way COL.ACTION_GEO_LAT can sit at index 56 is if
// GDELT's 57th field really is ActionGeo_Lat.
test('every COL constant names the column it indexes', () => {
  const normalize = (value) => String(value).toLowerCase().replaceAll('_', '');
  const entries = Object.entries(COL);
  assert.ok(entries.length >= 39, 'the map is populated');
  for (const [constant, index] of entries) {
    assert.ok(
      Number.isInteger(index) && index >= 0 && index < EXPORT_COLUMN_COUNT,
      `COL.${constant} = ${index} is inside the 61-column range`,
    );
    assert.equal(
      normalize(SCHEMA[index]),
      normalize(constant),
      `COL.${constant} is index ${index}, which GDELT calls "${SCHEMA[index]}"`,
    );
  }
});

test('no two COL constants claim the same column', () => {
  const indices = Object.values(COL);
  assert.equal(new Set(indices).size, indices.length);
});

test('the real fixture has exactly as many columns as the schema names', () => {
  for (const line of SAMPLE_LINES) {
    assert.equal(line.split('\t').length, SCHEMA.length);
  }
});

// GDELT publishes no first-party 2.0 header, but it does publish a 1.0 one
// (www.gdeltproject.org/data/lookups/CSV.header.dailyupdates.txt). 2.0 differs
// from it by exactly three INSERTED fields, so the 1.0 file anchors the 2.0
// map by offset — an independent route to the same indices the mirrors give.
test('the 2.0 column list is the first-party 1.0 list plus three inserted fields', () => {
  assert.equal(SCHEMA_V1.length, 58);
  assert.equal(SCHEMA.length - SCHEMA_V1.length, V2_INSERTIONS.length);
  for (const name of V2_INSERTIONS) {
    assert.ok(SCHEMA.includes(name), `2.0 has ${name}`);
    assert.ok(!SCHEMA_V1.includes(name), `1.0 does not have ${name}`);
  }
  // The whole relationship in one assertion: strip the insertions from 2.0 and
  // what remains must be the first-party 1.0 list, exactly and in order.
  assert.deepEqual(SCHEMA.filter((name) => !V2_INSERTIONS.includes(name)), SCHEMA_V1);
});

test('positions 1-39 are unshifted between 1.0 and 2.0', () => {
  // The first insertion is Actor1Geo_ADM2Code at 2.0 index 39, so everything
  // before it carries 1.0 offsets unchanged and is first-party twice over.
  assert.equal(SCHEMA.indexOf('Actor1Geo_ADM2Code'), 39);
  assert.deepEqual(SCHEMA.slice(0, 39), SCHEMA_V1.slice(0, 39));
  assert.equal(SCHEMA[38], 'Actor1Geo_ADM1Code');
  assert.notEqual(SCHEMA[39], SCHEMA_V1[39], 'and they diverge from 40 onward');
});

test('ActionGeo_Lat derives to the same index from 1.0 as from the 2.0 mirrors', () => {
  const v1Index = SCHEMA_V1.indexOf('ActionGeo_Lat');
  assert.equal(v1Index, 53, '1.0 position 54');
  // Every insertion precedes it, so the offset is the full count.
  const precedingInsertions = V2_INSERTIONS
    .filter((name) => SCHEMA.indexOf(name) < SCHEMA.indexOf('ActionGeo_Lat')).length;
  assert.equal(precedingInsertions, 3);
  assert.equal(v1Index + precedingInsertions, COL.ACTION_GEO_LAT);
  assert.equal(COL.ACTION_GEO_LAT, 56);
});

// The 1.0 file constrains where the ADM2Code fields go but cannot fix it: it
// contains no ADM2Code at all. The mirrors put each one between its ADM1Code
// and its Lat. THE REAL DATA SETTLES IT, and far more decisively than either
// header file — a one-column shift is not merely unconventional, it is
// impossible against these rows.
test('a one-column shift is impossible: index 55 holds no plottable latitude', () => {
  const plausibleLat = (value) => {
    const text = String(value ?? '').trim();
    if (!text) return false;
    const parsed = Number(text);
    return Number.isFinite(parsed) && parsed >= -90 && parsed <= 90;
  };
  let atLat = 0;
  let atAdm2 = 0;
  for (const line of SAMPLE_LINES) {
    const fields = line.split('\t');
    if (plausibleLat(fields[COL.ACTION_GEO_LAT])) atLat += 1;
    if (plausibleLat(fields[COL.ACTION_GEO_LAT - 1])) atAdm2 += 1;
  }
  assert.equal(atLat, 199, 'the mapped column really does hold latitudes');
  assert.equal(atAdm2, 0, 'the column before it holds none — ADM2 codes, not coordinates');
});

test('coordinates come from ActionGeo, never from an actor geography', () => {
  // This row's action is Washington DC while Actor1 sits on Lake Ontario —
  // reading the actor columns would place a US domestic event in Canada.
  const { line, fields } = rowById('1320453786');
  const record = parseExportRow(line);
  assert.ok(record);
  assert.match(record.place, /^Washington, District of Columbia/);
  assert.equal(record.lat, Number(fields[COL.ACTION_GEO_LAT]));
  assert.equal(record.lon, Number(fields[COL.ACTION_GEO_LONG]));
  assert.notEqual(record.lat, Number(fields[COL.ACTOR1_GEO_LAT]));
  assert.notEqual(record.lon, Number(fields[COL.ACTOR1_GEO_LONG]));
});

test('geo country codes are FIPS 10-4, and FIPS disagrees with ISO on real rows', () => {
  // Every pair below is a code whose ISO 3166 meaning is a different country
  // (or no country). Reading these as ISO renders China in Switzerland.
  const expected = [
    ['CH', /China/],   // ISO CH is Switzerland
    ['RS', /Russia/],  // ISO RS is Serbia
    ['UP', /Ukraine/], // unassigned in ISO
    ['HA', /Haiti/],   // ISO for Haiti is HT
    ['UK', /United Kingdom/], // ISO uses GB
  ];
  const { records } = parseExportTsv(SAMPLE, { requirePrecise: false });
  for (const [fips, namePattern] of expected) {
    const hit = records.find((record) => record.countryFips === fips);
    assert.ok(hit, `fixture carries a ${fips} row`);
    assert.match(hit.place, namePattern, `FIPS ${fips} is ${namePattern}`);
  }
});

test('DATEADDED is identical across the file and is the ingest clock', () => {
  const { records } = parseExportTsv(SAMPLE, { requirePrecise: false });
  const stamps = new Set(records.map((record) => record.ingestedAt));
  assert.equal(stamps.size, 1, 'one export file carries one DATEADDED');
  assert.equal([...stamps][0], Date.UTC(2026, 7, 29, 0, 45, 0));
});

test('SQLDATE is carried separately and can trail DATEADDED by a year', () => {
  // The premise that SQLDATE and DATEADDED are a year apart on EVERY row came
  // from a head sample. Across the strided fixture only three rows are
  // backdated at all — but those three must still parse and be flagged.
  const { line } = rowById('1320453556');
  const record = parseExportRow(line);
  assert.equal(record.eventDate, Date.UTC(2025, 7, 29));
  assert.equal(record.ingestedAt, Date.UTC(2026, 7, 29, 0, 45, 0));
  assert.equal(record.retrospectiveDays, 365);

  const { records } = parseExportTsv(SAMPLE, { requirePrecise: false });
  const backdated = records.filter((record) => record.retrospectiveDays > 0);
  assert.equal(backdated.length, 3);
  const sameDay = records.filter((record) => record.retrospectiveDays === 0);
  assert.equal(sameDay.length, records.length - 3);
});

test('date parsing is UTC regardless of the host timezone', () => {
  const original = process.env.TZ;
  try {
    process.env.TZ = 'Pacific/Kiritimati'; // UTC+14, the far side of the date line
    assert.equal(parseDateAdded('20260829004500'), Date.UTC(2026, 7, 29, 0, 45, 0));
    assert.equal(parseSqlDate('20260829'), Date.UTC(2026, 7, 29));
    assert.equal(sliceKeyForTime(Date.UTC(2026, 7, 29, 0, 45, 0)), '20260829004500');
  } finally {
    if (original === undefined) delete process.env.TZ;
    else process.env.TZ = original;
  }
});

test('malformed dates are rejected rather than coerced', () => {
  for (const bad of ['', '2026082900450', '202608290045000', '20261329004500', '20260832004500', '20260829254500', 'abcdefghijklmn']) {
    assert.equal(parseDateAdded(bad), null, `rejects ${JSON.stringify(bad)}`);
  }
  for (const bad of ['', '2026082', '202608291', '20261329', '20260832']) {
    assert.equal(parseSqlDate(bad), null, `rejects ${JSON.stringify(bad)}`);
  }
});

test('each drop rule fires with its own reason, derived from a real row', () => {
  // Edge rows are MUTATED FROM A REAL ROW rather than hand-typed: a hand-typed
  // 61-column row drifts from the real layout, which is the exact failure the
  // column-index tests exist to catch.
  const { fields } = rowById('1320453786');
  const withField = (index, value) => {
    const copy = fields.slice();
    copy[index] = value;
    return copy.join('\t');
  };
  const reasonFor = (line, options) => {
    let reason = null;
    const record = parseExportRow(line, { ...options, onReject: (value) => { reason = value; } });
    assert.equal(record, null);
    return reason;
  };

  assert.equal(reasonFor(fields.slice(0, 60).join('\t')), 'wrong_field_count');
  assert.equal(reasonFor([...fields, 'extra'].join('\t')), 'wrong_field_count');
  assert.equal(reasonFor(withField(COL.ACTION_GEO_TYPE, '0')), 'no_geo');
  assert.equal(reasonFor(withField(COL.ACTION_GEO_LAT, '')), 'no_geo');
  assert.equal(reasonFor(withField(COL.ACTION_GEO_LAT, '91.5')), 'no_geo');
  assert.equal(reasonFor(withField(COL.ACTION_GEO_LONG, '181')), 'no_geo');
  assert.equal(reasonFor(withField(COL.ACTION_GEO_TYPE, '1')), 'low_precision');
  assert.equal(reasonFor(withField(COL.ACTION_GEO_TYPE, '2')), 'low_precision');
  assert.equal(reasonFor(withField(COL.ACTION_GEO_TYPE, '5')), 'low_precision');
  assert.equal(reasonFor(withField(COL.SOURCE_URL, 'ftp://example.org/x')), 'bad_url');
  assert.equal(reasonFor(withField(COL.SOURCE_URL, 'javascript:alert(1)')), 'bad_url');
  assert.equal(reasonFor(withField(COL.SOURCE_URL, '')), 'bad_url');
  assert.equal(reasonFor(withField(COL.DATE_ADDED, 'not-a-date')), 'bad_date');

  // A country centroid is data, not an error — it is dropped only because a
  // point marker cannot honestly represent it, so the rule is switchable.
  assert.ok(parseExportRow(withField(COL.ACTION_GEO_TYPE, '1'), { requirePrecise: false }));
});

test('only city-precision rows survive the default filter', () => {
  const strict = parseExportTsv(SAMPLE);
  const loose = parseExportTsv(SAMPLE, { requirePrecise: false });
  assert.equal(strict.total, 209);
  assert.equal(loose.total, 209);
  for (const record of strict.records) {
    assert.ok(PLOTTABLE_GEO_TYPES.includes(record.geoPrecision));
  }
  assert.equal(strict.records.length, 124);
  assert.equal(strict.rejected.no_geo, 10);          // ActionGeo_Type 0
  assert.equal(strict.rejected.low_precision, 75);   // types 1, 2 and 5
  assert.equal(strict.rejected.no_geo + strict.rejected.low_precision + strict.records.length, 209);
  assert.equal(loose.records.length, 199);
  assert.equal(GEO_TYPE.NONE, 0);
});

test('the edge fixture survives CRLF, multibyte text, and a trailing blank line', () => {
  assert.ok(EDGE.includes('\r\n'), 'fixture really is CRLF');
  const { records, rejected, total } = parseExportTsv(EDGE);
  assert.equal(total, 5, 'the trailing blank line is not counted as a row');

  assert.equal(records.length, 1);
  const [record] = records;
  assert.equal(record.place, 'Bogotá, Distrito Especial, Colombia');
  assert.ok(!record.place.includes('\r'), 'CR is stripped, not carried into a field');
  assert.equal(record.lat, 4.60971);

  assert.equal(rejected.wrong_field_count, 1);
  assert.equal(rejected.bad_url, 1);
  assert.equal(rejected.no_geo, 1);
  assert.equal(rejected.low_precision, 1);
});

test('a trailing CR never survives into the last column', () => {
  const { fields } = rowById('1320453786');
  const record = parseExportRow(`${fields.join('\t')}\r`);
  assert.ok(record);
  assert.ok(!record.url.endsWith('\r'));
  assert.equal(record.url, fields[COL.SOURCE_URL]);
});

test('dedupe collapses one article at one place and counts what it collapsed', () => {
  const { records } = parseExportTsv(SAMPLE);
  const deduped = dedupeExportRecords(records);
  assert.equal(records.length, 124);
  assert.equal(deduped.length, 91);
  assert.equal(
    deduped.reduce((sum, record) => sum + record.duplicates, 0),
    124,
    'every input row is accounted for in a duplicates count',
  );
  assert.ok(deduped.some((record) => record.duplicates > 1), 'the fixture really does contain duplicates');
});

test('dedupe is deterministic and independent of input order', () => {
  const base = {
    lat: 10, lon: 20, url: 'https://example.org/a', place: 'X', ingestedAt: 1, geoPrecision: 4,
  };
  const rows = [
    { ...base, id: '300', numArticles: 5 },
    { ...base, id: '100', numArticles: 9 },
    { ...base, id: '200', numArticles: 9 },
  ];
  const forward = dedupeExportRecords(rows);
  const reverse = dedupeExportRecords(rows.slice().reverse());
  assert.equal(forward.length, 1);
  assert.equal(reverse.length, 1);
  // Highest numArticles wins; the id tie-break makes the choice reproducible.
  assert.equal(forward[0].id, '100');
  assert.equal(reverse[0].id, '100');
  assert.equal(forward[0].duplicates, 3);
  assert.equal(reverse[0].duplicates, 3);
});

test('distinct places from the same article are not collapsed together', () => {
  const rows = [
    { id: '1', lat: 10, lon: 20, url: 'https://example.org/a', numArticles: 1 },
    { id: '2', lat: 40, lon: 50, url: 'https://example.org/a', numArticles: 1 },
  ];
  assert.equal(dedupeExportRecords(rows).length, 2);
});

test('slice keys floor to the quarter hour and step backwards', () => {
  assert.equal(sliceKeyForTime(Date.UTC(2026, 7, 29, 0, 52, 13)), '20260829004500');
  assert.equal(sliceKeyForTime(Date.UTC(2026, 7, 29, 0, 45, 0)), '20260829004500');
  assert.equal(sliceKeyFromDateAdded('20260829004500'), '20260829004500');
  assert.equal(previousSliceKey('20260829004500'), '20260829003000');
  assert.equal(previousSliceKey('20260829004500', 3), '20260829000000');
  // Across a UTC midnight, which is where a naive local-time step would slip.
  assert.equal(previousSliceKey('20260829000000'), '20260828234500');
  assert.equal(previousSliceKey('not-a-key'), null);
  assert.equal(SLICE_MS, 900_000);
});

test('export URLs are built from a slice key, never from a bare guess', () => {
  assert.equal(
    exportUrlForSlice('20260829004500'),
    'http://data.gdeltproject.org/gdeltv2/20260829004500.export.CSV.zip',
  );
  assert.equal(
    exportUrlForSlice(Date.UTC(2026, 7, 29, 0, 52, 0)),
    `${EXPORT_BASE_URL}20260829004500.export.CSV.zip`,
  );
  assert.equal(
    exportUrlForSlice('20260829004500', 'http://localhost:9/gdeltv2'),
    'http://localhost:9/gdeltv2/20260829004500.export.CSV.zip',
  );
  assert.equal(exportUrlForSlice('nonsense'), null);
});

test('lastupdate.txt yields the export line and ignores mentions and GKG', () => {
  const body = [
    '229194 8c2a9d1e0f3b4c5d6e7f8091a2b3c4d5 http://data.gdeltproject.org/gdeltv2/20260829004500.mentions.CSV.zip',
    '67421 1a2b3c4d5e6f708192a3b4c5d6e7f809 http://data.gdeltproject.org/gdeltv2/20260829004500.export.CSV.zip',
    '1180233 fedcba9876543210fedcba9876543210 http://data.gdeltproject.org/gdeltv2/20260829004500.gkg.csv.zip',
  ].join('\n');
  const parsed = parseLastUpdate(body);
  assert.equal(parsed.slice, '20260829004500');
  assert.match(parsed.url, /\.export\.CSV\.zip$/);
  assert.equal(parsed.size, 67421);

  assert.equal(parseLastUpdate(''), null);
  assert.equal(parseLastUpdate('garbage'), null);
  // A non-http scheme must not be followed even if the shape matches.
  assert.equal(parseLastUpdate('1 x file:///etc/20260829004500.export.CSV.zip'), null);
});

test('a blank or unusable body yields no records rather than throwing', () => {
  for (const input of ['', null, undefined, '\n\n', 'not a tsv at all']) {
    const { records } = parseExportTsv(input);
    assert.deepEqual(records, []);
  }
});

test('dedupe collapses, but never silently discards, a record it cannot key', () => {
  // Dropping belongs to the drop rules, where it is counted in the funnel.
  // A silent loss inside dedupe would be invisible to every caller.
  const rows = [
    { id: '1', lat: 10, lon: 20, url: 'https://example.org/a', numArticles: 1 },
    { id: '2', url: 'https://example.org/b', numArticles: 1 },
  ];
  const out = dedupeExportRecords(rows);
  assert.equal(out.length, 2);
  assert.deepEqual(out.map((record) => record.id).sort(), ['1', '2']);
  for (const record of out) assert.equal(record.duplicates, 1);
});
