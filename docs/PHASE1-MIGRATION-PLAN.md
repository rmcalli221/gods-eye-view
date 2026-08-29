# Phase 1 migration plan — GEO 2.0 → Event Database export

Companion to `docs/PHASE1-DECISIONS.md`, which holds the evidence and the
decisions of record. This file is the work plan. **No implementation has
started.** Two items need a maintainer decision before coding begins (§3).

Branch: `feat/events-layer`. The layer already exists end-to-end against the
wrong source; this is a source swap, not a greenfield build.

---

## 0. Scope

**In scope.** Replace the `/api/events` upstream and the feed parser; keep the
layer id, registry token, overlay wiring, marker rendering, and the
proxy's cache / budget / serve-stale skeleton.

**Out of scope.** Marker visuals, the detection opt-out (`events.js`
deliberately implements no `getDetectableObjects()` — that stays), the cockpit
DOC 2.0 headline fallback (a separate, working GDELT use), and Phases 2–4.

**Non-goals worth stating.** Not adding a geocoder — the export ships
coordinates. Not adding the Mentions or GKG tables. Not backfilling history
beyond the configured window.

### What survives, what changes

| Component | Fate |
| --- | --- |
| `src/data/events.js` (layer) | **Mostly survives.** Consumes a record shape; only field names and the category list change. |
| `src/data/eventsFeed.js` | **Largely replaced.** GEO-specific parsing goes; category/severity/codec logic is reshaped. |
| `gdeltEventsProxy()` in `vite.config.js` | **Rewritten upstream half.** Cache/budget/serve-stale skeleton survives; the 5-queries-per-refresh loop becomes a slice accumulator. |
| `src/data/layerState.js` | Touched only if the category codes change (§3.1). |
| The 4 `gdelt-geo-*.json` fixtures | **Deleted** — they are synthetic files for an abandoned endpoint. |
| `events.test.mjs` / `eventsFeed.test.mjs` / `eventsProxy.test.mjs` | 67 tests total; the GEO-shaped ones are rewritten against real fixtures. |

---

## 1. Target architecture

Three modules, following the `firmsCsv.js` ↔ `firmsHeatmap.js` split that
`eventsFeed.js` already cites as its precedent — a pure parser importable by
both `vite.config.js` and the browser layer, so proxy and renderer can never
disagree about a record's shape.

```
src/data/gdeltExport.js     NEW  pure parser: TSV bytes -> event records
                                 no Cesium, no node builtins, no I/O
src/data/eventsFeed.js      REWORKED  categories, severity, render selection,
                                 share-link codec (keeps its current role)
src/data/events.js          MINOR EDITS  Cesium layer
vite.config.js              REWORKED upstream half of gdeltEventsProxy()
```

`gdeltExport.js` is new rather than an edit to `eventsFeed.js` because the two
have different jobs: one owns *the wire format* (61 columns, FIPS codes,
`ActionGeo_Type` precision rules), the other owns *presentation policy*
(categories, severity, entity budget). Mixing them is what made the GEO version
hard to re-target.

### 1.1 `gdeltExport.js` — the parser

Pure functions only. Exported surface:

- `EXPORT_COLUMN_COUNT = 61` and a frozen index map (0-based). Every access goes
  through named constants; no bare `fields[56]` anywhere.
- `parseExportRow(line)` → one record, or `null` for a row that must be dropped.
- `parseExportTsv(text, options)` → `{records, rejected}` with per-reason
  rejection counts, so the proxy can log why a window shrank.
- `exportUrlForSlice(date)` → the deterministic
  `YYYYMMDDHHMMSS.export.CSV.zip` URL.
- `sliceKeyFromDateAdded(value)` / `parseDateAdded(value)` → `DATEADDED` ↔ epoch
  ms, UTC, no local-timezone path.
- `parseSqlDate(value)` → `SQLDATE` ↔ epoch ms (day precision, UTC).

**Record shape** (the proxy→layer contract):

| Field | Source | Note |
| --- | --- | --- |
| `id` | col 1 `GLOBALEVENTID` | globally unique; replaces the synthesised `evt:<cat>:<lat>,<lon>` key |
| `lat`, `lon` | cols 57, 58 `ActionGeo_Lat/Long` | **Action**, not Actor1/Actor2 |
| `place` | col 53 `ActionGeo_FullName` | |
| `geoPrecision` | col 52 `ActionGeo_Type` | 3 or 4 only; see §1.2 |
| `countryFips` | col 54 | **FIPS 10-4**, not ISO — name it so |
| `ingestedAt` | col 60 `DATEADDED` | epoch ms UTC — **the recency field** |
| `eventDate` | col 2 `SQLDATE` | epoch ms UTC, day precision |
| `retrospectiveDays` | derived | `ingestedAt` date − `eventDate`, in days |
| `rootCode` | col 29 `EventRootCode` | CAMEO 01–20 |
| `quadClass` | col 30 | 1–4 |
| `goldstein` | col 31 | −10…+10 |
| `tone` | col 35 `AvgTone` | −100…+100 |
| `numArticles`, `numMentions`, `numSources` | cols 34, 32, 33 | coverage volume |
| `isRoot` | col 26 | lead-paragraph flag |
| `url` | col 61 `SOURCEURL` | `http(s)` only, else record dropped |

`category` is **not** parsed here — it is derived by `eventsFeed.js` from
`rootCode`/`quadClass`, because it is presentation policy (§3.1).

### 1.2 Drop rules, in order

Each has a named rejection reason so the proxy can report the funnel:

1. `wrong_field_count` — not exactly 61 fields.
2. `no_geo` — `ActionGeo_Type` is `0`, or lat/long absent/non-finite/out of
   range.
3. `low_precision` — `ActionGeo_Type ∉ {3, 4}` (country/state centroids).
   **Configurable**, defaulting to on; see `docs/PHASE1-DECISIONS.md` §5(b).
4. `bad_url` — `SOURCEURL` missing or not `http(s)`.
5. `bad_date` — `DATEADDED` unparseable.

Expected survival ≈ **62%** of rows, from the fixture. The proxy logs the funnel
once per refresh under the existing `[gdelt-events-proxy]` prefix.

### 1.3 Dedupe

Not an optimisation — 50 fixture rows carry 32 distinct URLs. Two stages:

- **Within a slice:** collapse on `SOURCEURL` + rounded coordinate, keeping the
  row with the highest `numArticles` (ties → lowest `GLOBALEVENTID`, so the
  choice is deterministic and testable). Retain a `duplicates` count so the UI
  can show "5 reports" rather than 5 markers.
- **Across slices:** `GLOBALEVENTID` is unique and never reappears in a later
  export, so a `Set` of retained ids is enough to make backfill idempotent.
  (The codebook warns ids are *not* reliably ordered by date — use them for
  identity only, never for sorting. Sort by `ingestedAt`.)

---

## 2. The proxy rewrite

`gdeltEventsProxy()` in `vite.config.js`. The cache, disk persistence, daily
budget governor, serve-stale branch, and sanitized error responses **all stay** —
they are correct and already tested. What changes is how a refresh is performed.

### 2.1 From stateless queries to a slice ring

Today: 5 sequential GEO queries per refresh, each returning a 24 h aggregate.
After: a `DATEADDED`-keyed ring buffer of parsed 15-minute slices.

```
state: Map<sliceKey, {ingestedAt, records[]}>   newest-first, evicted by age
```

Refresh:
1. `GET /gdeltv2/lastupdate.txt` → parse the export line for the newest slice
   URL. (Format: three lines, each `size hash url`; take the `.export.CSV.zip`
   one. Do **not** hand-build the newest URL from the local clock — GDELT's
   publish time drifts and a 404 on the current quarter-hour is normal.)
2. If that slice is already held, stop. Otherwise fetch, unzip, parse, insert.
3. Evict slices older than the configured depth.
4. Background: if the ring is shallower than the configured depth, fetch the
   next older slice, spaced by `GDELT_MIN_REQUEST_SPACING_MS`. One slice per
   tick — never a burst.

Older slice URLs are built deterministically by decrementing 15 minutes.
**A 404 on a backfill slice is normal and non-fatal** — GDELT occasionally skips
a window. Record the gap, continue to the next.

### 2.2 New tuning constants

| Constant | Value | Rationale |
| --- | --- | --- |
| `GDELT_EXPORT_BASE` | `http://data.gdeltproject.org/gdeltv2/` | static host, Node-reachable |
| `GDELT_WINDOW_SLICES` | `16` (4 h) | ~14k raw rows; env-tunable to 96 (24 h) |
| `GDELT_SLICE_MS` | `900_000` | 15 min |
| `GDELT_MAX_ZIP_BYTES` | `2 MiB` | a slice is ~67 KB; 30× headroom |
| `GDELT_MAX_INFLATED_BYTES` | `16 MiB` | **zip-bomb guard** — a slice inflates to ~400 KB |
| `GDELT_MIN_REQUEST_SPACING_MS` | `5_000` *(unchanged)* | courtesy spacing |
| `GDELT_DEFAULT_DAILY_BUDGET` | `2_000` *(unchanged)* | steady state is 96/day + backfill |

Retire: `GDELT_DEFAULT_TIMESPAN`, `GDELT_CATEGORY_MAX_POINTS`,
`GDELT_DEFAULT_MAX_POINTS` (the per-category ranking model is GEO-shaped —
replaced by the entity budget in §2.4).

### 2.3 ZIP handling — the one genuine unknown

The export is a ZIP. **The repo has no zip dependency and `vite.config.js` does
not currently import `node:zlib`.** Two options:

- **(a) Hand-parse with `node:zlib.inflateRaw` — recommended.** These are
  single-entry archives: read the local file header at offset 0, skip name and
  extra fields, inflate the rest. ~40 lines, no new dependency, consistent with
  the repo's minimal-dependency rule. **Must handle the data-descriptor case**
  (general-purpose flag bit 3 set → compressed size is `0` in the local header;
  fall back to the central directory at the end of the file). Must also cap
  inflated bytes rather than trusting the header.
- **(b) Add `unzipper`/`adm-zip`.** Simpler, but a runtime dependency for one
  call site in a repo that carries six.

Recommend (a), with the ZIP reader as its own small exported helper in
`vite.config.js` so `eventsProxy.test.mjs` can pin it against a real committed
`.export.CSV.zip` fixture — including a truncated archive and a
declared-size-exceeds-cap archive.

### 2.4 Response shape

`GET /api/events` keeps its envelope; contents change:

```
{fetchedAt, stale, ttlMs, windowSlices, windowFrom, windowTo,
 sliceCount, gaps[], count, funnel:{...}, events:[...]}
```

Reduction happens **server-side**, in this order: window → drop rules → dedupe →
rank by severity → cap. The cap must stay above `EVENTS_MAX_ENTITIES` (300) so
the client's category filter still has depth to choose from; **750 is a
reasonable ceiling** — the same number the old merged cap used, now applied to a
single ranked set rather than five.

Ranking must **not** be per-category the way the GEO version's was: that
existed because five separate upstream queries had incomparable volumes. One
slice stream has one scale, so a single ranked set is both simpler and correct.

`GET /api/events/status` gains `sliceCount`, `windowFrom/To`, and `gaps`.

---

## 3. Decisions needed before coding

### 3.1 The category model — **blocking**

`docs/PHASE1-DECISIONS.md` §7 sets this out: CAMEO has no disaster,
humanitarian, or economic concept, and 78% of rows are verbal cooperation
(`QuadClass 1`), 44% `CONSULT` alone. The existing five theme-based categories
cannot be reproduced.

Recommended mapping — five categories again, so the UI's shape is unchanged:

| Precedence | id | code | Derived from | Fixture yield |
| --- | --- | --- | --- | --- |
| 1 | `conflict` | `c` *(kept)* | `rootCode ∈ {18,19,20}` or `quadClass = 4` | 6% |
| 2 | `unrest` | `u` | `rootCode = 14` (PROTEST) | 0% in sample |
| 3 | `coercion` | `x` | `rootCode ∈ {13,15,17}` | 6% |
| 4 | `dissent` | `d` *(recycled)* | `rootCode ∈ {10,11,12}` | 6% |
| 5 | `diplomacy` | `p` *(kept)* | `quadClass ∈ {1,2}` | 86% |

**The buckets overlap and the order above is a precedence rule, not a
description.** Two fixture rows carry `rootCode 17` (COERCE) with
`quadClass 4` (material conflict) and match both `conflict` and `coercion`;
`diplomacy` is a broad catch-all that would otherwise swallow much of the
feed. Each record gets **exactly one** category, assigned by first match in
precedence order — most severe wins. `gdeltExport.js` must not assign
categories at all (§1.1); this table belongs to `eventsFeed.js` and needs its
own test asserting the two known overlap rows land in `conflict`.

Every one of the 50 fixture rows falls into some bucket, but that is mostly
`diplomacy` absorbing 86% of them — which is why it must default to **off**.

`disaster` is **delegated to the existing `earthquakes` and FIRMS heatmap
layers**, which already cover it with better data. This removes a duplicate, not
a capability. `humanitarian` and `economic` are dropped.

**Cost: the share-link contract breaks.** Category codes live in
`OPTION_GROUPS.events` in `src/data/layerState.js` and in every URL already
issued. `LAYER_STATE_VERSION` is already `2` and the codec has a version field
for exactly this; `coerceEventCategories` should map retired codes (`h`, `e`)
to nothing and keep the link otherwise valid rather than rejecting it whole.

**Alternative if the break is unacceptable:** keep `c/p/h/e/d` as literal codes
and re-point their *meanings*. Preserves old links but makes them silently mean
something different — worse, in my view, than a clean version bump.

### 3.2 Should low-precision rows render at all? — **non-blocking**

Recommendation is no (drop `ActionGeo_Type ∈ {1,2,5}`, −26% of rows). The
alternative is rendering them with a distinct visual that reads as an area, not
a point. Defaulting to the drop and leaving it env-configurable lets this be
revisited without another migration.

---

## 4. Test strategy

Per `CLAUDE.md`, every module in `src/data/` gets a sibling `.test.mjs`.

**New fixtures** (under `src/data/fixtures/`, documented in its README):

1. `gdelt-export-sample.tsv` — the existing 50 rows, **re-encoded UTF-8/LF** and
   moved off the repo root (`docs/PHASE1-DECISIONS.md` §8).
2. `gdelt-export-slice.export.CSV.zip` — one real ZIP as served, for the
   container reader.
3. Small hand-built edge files: wrong field count, `ActionGeo_Type` 0/1/2,
   missing coordinates, non-`http` URL, CRLF endings, a UTF-8 row with accented
   place names, and an empty file. Hand-built is fine here — these test *our*
   drop rules, not GDELT's format.

**Delete** the four `gdelt-geo-*.json` fixtures and the README paragraph
describing them.

**Coverage that must exist:**

- `gdeltExport.test.mjs` — all 61 indices pinned by name against the real
  fixture (this is the regression guard for an off-by-one in the column map);
  each drop rule; `DATEADDED`/`SQLDATE` parsing incl. the year-apart rows;
  UTC correctness with a non-UTC `TZ` set; dedupe determinism.
- `eventsProxy.test.mjs` — ZIP reader incl. data-descriptor, truncated, and
  oversize-inflation cases; slice ring insert/evict; backfill spacing; 404
  gap tolerance; `lastupdate.txt` parsing; serve-stale on upstream failure;
  budget governor (all existing budget tests should survive unchanged).
- `eventsFeed.test.mjs` — category derivation from `rootCode`/`quadClass`;
  severity ranking; share-link codec incl. **retired-code tolerance**.
- `events.test.mjs` — mostly survives; update the record shape and category
  fixtures.

`npm test`, `npm run build`, and `npm run test:track` must all be green before
the branch is done — `CLAUDE.md` is explicit that work is not done otherwise.

---

## 5. Documentation updates (same PR)

- `DATA_SOURCES.md` — replace the **GEO 2.0** row and the "World events layer"
  note with the export source, the window/backfill behaviour, and a restated
  "what these markers are not". The DOC 2.0 row is unrelated and stays.
- `docs/CURRENT-STATE.md` — update the events-layer entry.
- `CHANGELOG.md` — the source swap is user-visible behaviour.
- `.env.example` — retire `GDELT_*_TIMESPAN`/`MAX_POINTS`, add
  `GDELT_WINDOW_SLICES` and the byte caps.
- `src/data/dataCredits.js` — attribution text still says GEO 2.0.
- `src/data/fixtures/README.md` — new fixtures in, GEO fixtures out.
- **`CLAUDE.md`** — its free-token list is stale: it lists `n` as free, but the
  events layer already took `n` in `LAYER_STATE_REGISTRY`. Correct to
  taken `a b c d e f g i m n q r s t u w x`, free `h j k l o p v y z`.
- `.gitignore` — drop the `export.zip` / `gdelt-sample/` scratch entries once
  the fixture workflow is settled.

---

## 6. Sequencing

One concern per commit, conventional prefixes, in an order where each step is
independently reviewable and the tree stays green:

1. `docs:` decisions + this plan. *(this commit)*
2. **Decide §3.1.** Blocking — everything downstream depends on the category model.
3. `test:` re-encode and relocate the fixture; add the ZIP and edge fixtures;
   document them.
4. `feat:` `gdeltExport.js` + `gdeltExport.test.mjs`, standalone and fully
   tested against the fixtures. Nothing wired up yet.
5. `feat:` ZIP reader + slice ring in `gdeltEventsProxy()`; rewrite
   `eventsProxy.test.mjs`. `/api/events` now serves export-shaped records.
6. `feat:` category/severity rework in `eventsFeed.js`; codec tolerance for
   retired codes; update `layerState.js` if §3.1 lands as recommended.
7. `feat:` adapt `events.js` to the new record shape and categories.
8. `test:` delete the GEO fixtures and their tests.
9. `docs:` all of §5.

Steps 4 and 5 are the bulk of the work. Step 4 is the one to get exactly right —
a wrong column index there is a silent, plausible-looking geographic error.

---

## 7. Risks

| Risk | Severity | Mitigation |
| --- | --- | --- |
| Off-by-one in the 61-column map | **High** — silently plots Actor2's coordinates | Named constants only; test pins every index by name against the real fixture |
| FIPS read as ISO | **High** — China renders in Switzerland | Field named `countryFips`; test asserts `CH`→China, `AU`→Austria |
| ZIP data-descriptor case unhandled | Medium — parse fails on some slices | Central-directory fallback; test with a real archive |
| Category model unresolvable | Medium — blocks §3.1 | Escalated now, before coding |
| Cold-start window is thin | Medium — sparse globe on first load | Serve immediately + background backfill; surface `sliceCount` in status |
| Volume figures from one quiet window | Low | 00:45 UTC sample; re-measure at peak before fixing `GDELT_WINDOW_SLICES` |
| GDELT skips a publish window | Low | 404 tolerated, gap recorded, backfill continues |
| Feed is mostly diplomatic chatter | Medium — dull globe | Category filter + severity ranking; `diplomacy` off by default |

### Still owed

The first-party header check in `docs/PHASE1-DECISIONS.md` §8, to be run where
`data.gdeltproject.org` is reachable — it is blocked from the environment this
plan was written in.
