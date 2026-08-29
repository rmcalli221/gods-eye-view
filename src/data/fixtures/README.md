# Test fixtures

- `tomtom-flow-austin-12-935-1686.pbf` — one real TomTom traffic-flow vector
  tile (Mapbox Vector Tile protobuf, layer `"Traffic flow"`), downtown Austin
  z12 x935 y1686, captured 2026-07-16 from
  `api.tomtom.com/traffic/map/4/tile/flow/relative/12/935/1686.pbf`
  (22,980 bytes). Used ONLY by `src/data/flowTiles.test.mjs` to pin MVT
  decoding offline — it is a point-in-time congestion snapshot, not a bundled
  data layer, and is never served to the app. © TomTom.

- `firms-viirs-noaa20-sample.csv` — NASA FIRMS VIIRS NOAA-20 active-fire rows,
  used by `src/data/firmsCsv.test.mjs`.

## GDELT 2.0 Event Database export

- `gdelt-export-sample.tsv` — **REAL DATA.** 209 rows from the
  `20260829004500` 15-minute export
  (`data.gdeltproject.org/gdeltv2/20260829004500.export.CSV.zip`), UTF-8, LF
  line endings, no BOM, 61 tab-separated columns, no header row — the format
  as served, once decompressed.

  Sampled with a **stride across the whole file**, not `head`. This matters:
  the file is ordered by `GlobalEventID` ascending and GDELT's backdated rows
  sort to the front, so a head sample systematically over-represents them. An
  earlier 50-row head sample of this same export produced a materially wrong
  picture of the feed — 78% verbal cooperation against 63% here, 44%
  `CONSULT` against 22%, and 30% backdated rows against 1.4%. See
  `docs/PHASE1-DECISIONS.md` §4 and §10.

  `GLOBALEVENTID` spans 1320453556–1320454596 (1,041 ids across 209 retained
  rows). `DATEADDED` is `20260829004500` on every row — it is the export
  file's own timestamp, identical for every record in the file.

- `gdelt-export-slice.export.CSV.zip` — the 209 rows above, in a ZIP container
  named the way GDELT names them, with the member file
  `20260829004500.export.CSV`. Standard local file header: general-purpose
  bit 3 clear, compressed and uncompressed sizes present.

- `gdelt-export-datadesc.export.CSV.zip` — 3 rows in a ZIP written to an
  **unseekable stream**, which sets general-purpose bit 3 and zeroes the
  local-header sizes, moving them into a trailing data descriptor — the
  container variant that would break a reader trusting the local header. GDELT
  does not currently emit this shape (see below); the fixture pins the reader's
  defensive path against it.

  **Provenance of both archives.** GDELT's own `.zip` files could not be
  fetched here — `data.gdeltproject.org` is blocked by this environment's
  egress proxy (HTTP 403). They were built from the real TSV above with
  Python's `zipfile`, a **different implementation from the reader under
  test**, and independently validated with `unzip -t`. Reproduce with the
  script in `docs/PHASE1-DECISIONS.md` §11.

  A real export has since been checked off-sandbox: single entry, local
  signature `504B0304`, flags `0000`, EOCD `06054B50` — **no data descriptor,
  no Zip64**. So GDELT writes the shape `gdelt-export-slice…zip` pins, and
  `gdelt-export-datadesc…zip` covers a variant GDELT does not currently emit.
  That fixture is kept deliberately: a streamed writer is a normal thing for a
  publisher to adopt without notice, and the failure mode if GDELT did would be
  a silently empty file rather than an error.

- `gdelt-export-edge.tsv` — hand-built, five rows, **CRLF line endings** and a
  trailing blank line, derived from a real row so the 61-column layout cannot
  drift. Each row exercises one drop rule: a UTF-8 multibyte place name
  (`Bogotá`) that must survive decoding; a 60-field short row; an `ftp://`
  `SOURCEURL`; `ActionGeo_Type` `0` with blank coordinates; and
  `ActionGeo_Type` `1` carrying a country centroid with FIPS `AU`, which means
  **Austria**, not Australia. These test *our* drop rules, not GDELT's format,
  so hand-building is appropriate.

Drop-rule edge cases that need no byte-level fidelity are derived in
`gdeltExport.test.mjs` by mutating one field of a real row, rather than by
hand-typing 61 columns — a hand-typed row drifts from the real layout, which
is the exact failure the column-index tests exist to catch.
