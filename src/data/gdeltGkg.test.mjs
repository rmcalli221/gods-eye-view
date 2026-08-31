// src/data/gdeltGkg.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  GKG_COLUMN_COUNT,
  GKG_COL,
  hasRenderableEntities,
  parseGkgEntities,
  parseGkgRow,
  splitGkgList,
} from './gdeltGkg.js';
import { parseExportTsv } from './gdeltExport.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const read = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');
const GKG = read('gdelt-gkg-sample.csv');
const EXPORT = read('gdelt-export-sample.tsv');

test('only the columns confirmed by a real field dump are named', () => {
  assert.equal(GKG_COLUMN_COUNT, 27);
  // 1-based in the probe -> 0-based here.
  assert.equal(GKG_COL.DOCUMENT_IDENTIFIER, 4);  // col 5
  assert.equal(GKG_COL.THEMES, 7);               // col 8
  assert.equal(GKG_COL.PERSONS, 11);             // col 12
  assert.equal(GKG_COL.ORGANIZATIONS, 13);       // col 14
  assert.equal(GKG_COL.TONE, 15);                // col 16
  assert.equal(GKG_COL.QUOTATIONS, 22);          // col 23
  // The other 21 columns are deliberately unnamed rather than guessed. Adding
  // one needs the same first-party confirmation these six had.
  assert.equal(Object.keys(GKG_COL).length, 6);
});

test('the join key is the article URL, and it matches the export exactly', () => {
  const { entities } = parseGkgEntities(GKG);
  const exportUrls = new Set(parseExportTsv(EXPORT).records.map((record) => record.url));
  const joined = [...entities.keys()].filter((url) => exportUrls.has(url));
  // Every fixture row but the deliberate stranger is an export URL.
  assert.equal(joined.length, entities.size - 1);
  assert.ok(entities.has('https://example.org/not-in-the-export'), 'the stranger parsed');
  assert.ok(!exportUrls.has('https://example.org/not-in-the-export'), 'but joins nothing');
});

test('wantedUrls is the memory contract, not an optimisation', () => {
  // A GKG slice is ~5.3 MB describing every article in the window; a slice's
  // events reference a few hundred. Retaining the rest would hold megabytes
  // per slice in the ring for nothing.
  const { records } = parseExportTsv(EXPORT);
  const wanted = new Set(records.map((record) => record.url));
  const all = parseGkgEntities(GKG);
  const restricted = parseGkgEntities(GKG, { wantedUrls: wanted });
  assert.ok(restricted.entities.size < all.entities.size);
  assert.ok(!restricted.entities.has('https://example.org/not-in-the-export'));
  for (const url of restricted.entities.keys()) assert.ok(wanted.has(url));
  assert.equal(restricted.rows, all.rows, 'every row is still counted');
  assert.ok(restricted.matched < all.matched, 'but fewer are retained');
});

test('entity names survive the offset suffix GDELT appends', () => {
  assert.deepEqual(splitGkgList('maria hernandez,412; kwame nkrumah,980'),
    ['maria hernandez', 'kwame nkrumah']);
  assert.deepEqual(splitGkgList('european commission,55'), ['european commission']);
  // A trailing offset rendered into a card reads as corruption, which is why
  // the part before the first comma wins even though it truncates a name that
  // genuinely contains one.
  assert.deepEqual(splitGkgList('white house; new york times'),
    ['white house', 'new york times']);
});

test('list parsing is defensive about blanks, dupes and noise', () => {
  assert.deepEqual(splitGkgList(''), []);
  assert.deepEqual(splitGkgList(null), []);
  assert.deepEqual(splitGkgList(';;;'), []);
  assert.deepEqual(splitGkgList('nato; NATO; Nato'), ['nato'], 'case-insensitive dedupe');
  assert.deepEqual(splitGkgList(`${'x'.repeat(200)}; nato`), ['nato'], 'over-long entries dropped');
  assert.equal(splitGkgList('a;b;c;d;e;f;g').length, 4, 'capped per kind');
});

test('a row shorter than the last read column is rejected, not half-parsed', () => {
  assert.equal(parseGkgRow(''), null);
  assert.equal(parseGkgRow('only\tthree\tfields'), null);
  assert.equal(parseGkgRow(new Array(27).fill('').join('\t')), null, 'no URL, no record');
  // But a row that merely drops TRAILING empties is usable — writers do that
  // routinely, and rejecting on field count would discard real rows.
  const short = parseGkgRow(GKG.split('\n')[6]);
  assert.ok(short, 'the 17-field fixture row parses');
  assert.deepEqual(short.persons, ['ada lovelace']);
});

test('the first row for a URL wins, so the join is deterministic', () => {
  // GDELT can emit an article more than once inside a window.
  const { entities } = parseGkgEntities(GKG);
  const first = entities.get(parseGkgRow(GKG.split('\n')[0]).url);
  assert.deepEqual(first.persons, ['george santos']);
  assert.ok(!first.persons.includes('someone else entirely'));
});

test('tone parses to a number, and a blank tone is null not zero', () => {
  const row = parseGkgRow(GKG.split('\n')[0]);
  assert.equal(row.tone, -2.1);
  const blank = new Array(27).fill('');
  blank[GKG_COL.DOCUMENT_IDENTIFIER] = 'https://example.org/a';
  assert.equal(parseGkgRow(blank.join('\t')).tone, null, 'absent tone is not 0');
});

test('renderability is person-or-org, and the empty case is honest about it', () => {
  const { entities } = parseGkgEntities(GKG);
  const rows = [...entities.values()];
  // The fixture carries one deliberately empty row — the ~1.5% of joined
  // events that have no usable entity and must fall back to the category line.
  const empty = rows.filter((record) => !hasRenderableEntities(record));
  assert.equal(empty.length, 1);
  assert.ok(hasRenderableEntities({ persons: ['a'], organizations: [] }));
  assert.ok(hasRenderableEntities({ persons: [], organizations: ['a'] }));
  assert.ok(!hasRenderableEntities({ persons: [], organizations: [] }));
  assert.ok(!hasRenderableEntities(null));
});

test('themes are parsed but not surfaced as copy', () => {
  // They are ALL_CAPS internal codes whose readable labels are the same
  // unlicensed third-party table problem as the CAMEO leaf codes (§14).
  const row = parseGkgRow(GKG.split('\n')[0]);
  assert.ok(row.themes.length > 0, 'carried for a future decision');
  for (const theme of row.themes) {
    assert.match(theme, /^[A-Z0-9_]+$/, 'a code, not prose — never render it raw');
  }
});

test('a blank or unusable file yields nothing rather than throwing', () => {
  for (const input of ['', null, undefined, '\n\n', 'not a gkg file at all']) {
    const { entities } = parseGkgEntities(input);
    assert.equal(entities.size, 0);
  }
});
