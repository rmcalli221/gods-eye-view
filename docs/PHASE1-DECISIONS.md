# Phase 1 decisions — the world-events layer

Status: **implemented.** Sections 10-12 record what changed once the plan met
the data; where they contradict an earlier section, they win. This file is the
durable record of why
the events layer moved off the GDELT GEO 2.0 API and onto the GDELT 2.0 Event
Database export CSV. Read it before touching `src/data/events.js`,
`src/data/eventsFeed.js`, or the `/api/events` proxy in `vite.config.js`.

Written 2026-08-29. Supersedes the source choice described in the header comment
of `src/data/eventsFeed.js` and in `DATA_SOURCES.md`; both still describe GEO 2.0
and are corrected by the migration.

---

## 1. Why GEO 2.0 was abandoned

The first implementation of this layer (commits `7c9d415`, `6ce8f39`, `6d54f6b`)
was built against `api.gdeltproject.org/api/v2/geo/geo`. It was written from
GDELT's published documentation, never against a live response — the header of
`src/data/eventsFeed.js` and `src/data/fixtures/README.md` both say so in as many
words, and the four `gdelt-geo-*.json` fixtures are hand-built synthetic files,
not captures.

When that endpoint was finally exercised against the network, it did not hold up.

**Observed behaviour of `api.gdeltproject.org` (tested from the maintainer's
Windows machine):**

- Returns HTTP 404 for requests that had previously succeeded.
- Returns HTTP 000 (no response / connection failure) intermittently.
- Returns HTTP 200 with an empty body.
- These three outcomes occur **for identical requests**, non-deterministically.
- Node cannot connect to the host at all — `ECONNRESET` or connect timeout on
  every attempt — although `curl` from the same machine sometimes succeeds.

That last point is disqualifying on its own. The proxy runs in Node. A source
that Node's fetch stack cannot reach cannot back a Node-side proxy, regardless of
what `curl` can do with it. The non-determinism is disqualifying independently:
there is no cache policy, retry budget, or serve-stale rule that turns a source
which answers the same request three different ways into a dependable feed, and
the existing proxy's serve-stale branch would spend most of its life serving a
cache it could never refresh.

**Decision: GEO 2.0 is unusable for this layer. Do not re-attempt it** without
new evidence that the endpoint's behaviour has changed. If someone does retry it,
the bar is: 20 consecutive identical requests from Node, all HTTP 200, all with a
non-empty body.

## 2. Gate results before the pivot

Two gates were run to check that a different GDELT host was actually viable
before committing to it.

| Gate | Test | Result |
| --- | --- | --- |
| 1 | Node bare `fetch` against `data.gdeltproject.org` | **PASS** — HTTP 200, no `User-Agent` header required |
| 2 | Obtain a real 50-row sample of the Event Database export | **PASS** — committed as `gdelt-export-sample.tsv` (commit `0622d2c`), from the `20260829004500` export, 61 columns confirmed |

`data.gdeltproject.org` is a **different host** from `api.gdeltproject.org`: a
static file server publishing pre-built archives, not a query API. That is
precisely why it behaves. There is no query planner, no per-request computation,
and no rate-limited API surface — just files.

## 3. The decision

**Adopt Option 1: the GDELT 2.0 Event Database 15-minute export CSV.**

- Upstream: `http://data.gdeltproject.org/gdeltv2/YYYYMMDDHHMMSS.export.CSV.zip`
- Published every 15 minutes on the quarter hour, UTC.
- Latest-pointer file: `http://data.gdeltproject.org/gdeltv2/lastupdate.txt`
- Format: ZIP containing one tab-separated file, 61 columns, no header row.
- Licence unchanged — same GDELT terms already recorded in `DATA_SOURCES.md`.

This is a **source swap, not a new layer**. The layer id (`events`), its
registry token (`n`), the overlay wiring, and the marker-rendering approach in
`src/data/events.js` all survive. What changes is where the rows come from, what
shape they arrive in, and — unavoidably — what the five categories can mean
(§7).

---

## 4. SQLDATE vs DATEADDED — settled

This was raised as: *"SQLDATE reads 20250829 while DATEADDED reads
20260829004500 — a year apart on every row."*

**The premise is incorrect, and the way it is incorrect matters.** It is not
true of every row; it is true of the first eight rows, and the file is ordered
such that those are the ones you see first.

Actual distribution across all 50 fixture rows:

| SQLDATE | Rows | Relationship to the export timestamp |
| --- | --- | --- |
| `20260829` | 35 | same day |
| `20250829` | 8 | exactly one year earlier |
| `20260730` | 4 | ~30 days earlier |
| `20260822` | 3 | 7 days earlier |

`DATEADDED` is `20260829004500` on **all 50 rows** — it is the export file's own
timestamp, identical for every record in the file, exactly as expected.

The rows are ordered by `GlobalEventID` ascending (`1320453556`–`1320453605`,
contiguous, no gaps — i.e. the fixture is the *first* 50 rows of the file, a
`head -50`), and in this file SQLDATE ascends with it. The backdated rows sort
to the front. Sampling the head of the file therefore over-represents backdated
events and produced the "every row" impression.

### What each field means

Verbatim from the GDELT 2.0 Event codebook:

> **SQLDATE** — "Date the event took place in YYYYMMDD format. See DATEADDED
> field for YYYYMMDDHHMMSS date."

> **DATEADDED** — "This field stores the date the event was added to the master
> database in YYYYMMDDHHMMSS format in the UTC timezone. **For those needing to
> access events at 15 minute resolution, this is the field that should be
> used in queries.**"

### Which one represents recency

**`DATEADDED` (column 60) is the recency field. The layer's rolling window must
be keyed on it.** GDELT says so explicitly, and the data confirms why:

1. **Precision.** `DATEADDED` is `YYYYMMDDHHMMSS`; `SQLDATE` is day-only. A
   15-minute window cannot be keyed on a day-granular field.
2. **It is the ingest clock.** `DATEADDED` equals the export filename's
   timestamp, so it is the natural key for window membership and eviction, and
   it is monotonic across files by construction.
3. **`SQLDATE` would silently drop fresh news.** 15 of 50 rows (30%) carry an
   event date older than the export. Keyed on `SQLDATE`, a "last 24 hours"
   filter discards all 15 — including 8 rows that would fall a full year
   outside the window — even though GDELT ingested every one of them in the
   same 15-minute tick.

`SQLDATE` is **not** the article publication date either, and must not be
presented as one. Row 5's source URL is
`parkrecord.com/2026/08/28/...` — published the day before the export — while
its `SQLDATE` is `20250829`. `SQLDATE` is GDELT's NLP-extracted date of the
*event described*, which can precede the article by days, months, or years.

The clearest confirming case: two rows cite an NBC Connecticut article headlined
*"CT DOT worker dies **days after** being trapped between concrete barriers"*,
`DATEADDED` today, `SQLDATE` `20260822` — seven days back. The extractor
correctly dated the entrapment, not the report. The eight rows at exactly one
year prior are the same mechanism applied to retrospective and anniversary
coverage.

### Consequence for the layer

- **Window membership, ordering, dedupe, and eviction: `DATEADDED`.**
- **`SQLDATE` is still carried**, as a separate `eventDate` field, and shown in
  the detail panel distinctly from the ingest time. A marker for an event dated
  a year ago must not read as "happening now".
- The gap `DATEADDED_date − SQLDATE` is a usable *retrospective* signal. At
  ~30% of rows it is common enough to matter visually. Recommendation: carry
  the gap in days and let the layer de-emphasise or badge non-current events
  rather than silently mixing them with live ones.

---

## 5. Column verification (all 61)

> **Verification route, stated plainly.** `data.gdeltproject.org` and
> `www.gdeltproject.org` are both **blocked by this environment's network egress
> proxy** (HTTP 403, `EGRESS_BLOCKED`), on every path tried — `curl` and the
> agent fetch tool alike. No first-party header file has ever been fetched for
> this work. Verification is against two independent mirrors plus the real
> fixture, as described below. That is strong corroboration; it is **not** a
> first-party confirmation. See §12.
>
> **Correction (re-verified 2026-08-29).** An earlier revision of this section
> claimed the two mirrors were "byte-identical (27,344 bytes, `cmp` clean)".
> **That does not reproduce and was wrong.** The PyPI copy is a different file
> under a different name — `gdelt-0.1.14.data/data/data/events2.csv`, 26,781
> bytes, with its own table layout (`name,type,description` against the GitHub
> copy's `tableId,dataType,Empty,...`). The claim was recalled, not run.
>
> The real finding is **stronger**, not weaker: two files of different
> provenance, different filename, different size and different table shape
> agree **exactly on the sequence of 61 column names**. Two copies of one byte
> stream would only have proven the file was copied. This is the check that
> was actually run, and it is reproducible: see the script below.

**Method.**

1. Two independent mirrors of the GDELT 2.0 Events schema were retrieved:
   - `linwoodc3/gdelt2HeaderRows` →
     `schema_csvs/GDELT_2.0_Events_Column_Labels_Header_Row_Sep2016.csv`
     (27,344 bytes, sha256 `63db5ad9…be41`)
   - the `gdelt` PyPI package (`gdelt-0.1.14`) →
     `gdelt-0.1.14.data/data/data/events2.csv` (26,781 bytes)

   Different channels, different filenames, different table layouts — and an
   **identical sequence of 61 column names**. Both also carry GDELT's codebook
   description prose, not just the names.
2. Both list exactly **61 columns**, matching the fixture's 61.
3. Every one of the 39 named indices in `COL` (`src/data/gdeltExport.js`) was
   checked to land on the column name it claims. **Result: 0 mismatches.**
   This check is no longer a one-off: the agreed 61-name sequence is committed
   as `src/data/fixtures/gdelt-events-columns.txt`, and `gdeltExport.test.mjs`
   now asserts every `COL` entry against it by a mechanical name comparison —
   no hand-written mapping, so it cannot pass by repeating a transcription
   error. Mutation-checked against an off-by-one, an actor-vs-action swap, and
   a corrupted fixture; all three fail the suite. Only the names are committed:
   the GitHub mirror is unlicensed and the PyPI one GPL-3.0, so neither file is
   redistributed here.
4. Every column was then validated against the real fixture rows for declared
   type (INTEGER / FLOAT / STRING) and value domain.
   **Result: 0 type violations.**

**Reproduce (both hosts are reachable from a normal network and from this
sandbox):**

```bash
curl -sO https://raw.githubusercontent.com/linwoodc3/gdelt2HeaderRows/master/schema_csvs/GDELT_2.0_Events_Column_Labels_Header_Row_Sep2016.csv
curl -s https://pypi.org/pypi/gdelt/json \
  | python3 -c "import json,sys;d=json.load(sys.stdin);print(next(f['url'] for f in d['releases']['0.1.14']))" \
  | xargs curl -s -o gdelt.whl
python3 - <<'PY'
import csv, zipfile
open('events2.csv','wb').write(
    zipfile.ZipFile('gdelt.whl').read('gdelt-0.1.14.data/data/data/events2.csv'))
def names(p):
    rows = [r for r in csv.reader(open(p, encoding='utf-8-sig')) if r and r[0].strip()]
    return [r[0].strip() for r in rows[1:]]        # drop the table's own header row
a = names('GDELT_2.0_Events_Column_Labels_Header_Row_Sep2016.csv')
b = names('events2.csv')
print(len(a), len(b), 'identical:', a == b)        # -> 61 61 identical: True
PY
```

**The verified layout:**

| # | Column | Type | Filled (of 50) |
| --- | --- | --- | --- |
| 1 | GLOBALEVENTID | INTEGER | 50 |
| 2 | SQLDATE | INTEGER | 50 |
| 3 | MonthYear | INTEGER | 50 |
| 4 | Year | INTEGER | 50 |
| 5 | FractionDate | FLOAT | 50 |
| 6–15 | Actor1Code, Actor1Name, Actor1CountryCode, Actor1KnownGroupCode, Actor1EthnicCode, Actor1Religion1Code, Actor1Religion2Code, Actor1Type1Code, Actor1Type2Code, Actor1Type3Code | STRING | 0–10 |
| 16–25 | Actor2Code, Actor2Name, Actor2CountryCode, Actor2KnownGroupCode, Actor2EthnicCode, Actor2Religion1Code, Actor2Religion2Code, Actor2Type1Code, Actor2Type2Code, Actor2Type3Code | STRING | 0–48 |
| 26 | IsRootEvent | INTEGER | 50 |
| 27 | EventCode | STRING | 50 |
| 28 | EventBaseCode | STRING | 50 |
| 29 | EventRootCode | STRING | 50 |
| 30 | QuadClass | INTEGER | 50 |
| 31 | GoldsteinScale | FLOAT | 50 |
| 32 | NumMentions | INTEGER | 50 |
| 33 | NumSources | INTEGER | 50 |
| 34 | NumArticles | INTEGER | 50 |
| 35 | AvgTone | FLOAT | 50 |
| 36–43 | Actor1Geo_Type, _FullName, _CountryCode, _ADM1Code, _ADM2Code, _Lat, _Long, _FeatureID | mixed | 3–50 |
| 44–51 | Actor2Geo_Type, _FullName, _CountryCode, _ADM1Code, _ADM2Code, _Lat, _Long, _FeatureID | mixed | 23–50 |
| 52–59 | **ActionGeo**_Type, _FullName, _CountryCode, _ADM1Code, _ADM2Code, _Lat, _Long, _FeatureID | mixed | 26–50 |
| 60 | DATEADDED | INTEGER | 50 |
| 61 | SOURCEURL | STRING | 50 |

Indices are **1-based** above; in code they are 0-based (`ActionGeo_Lat` is
`fields[56]`). Get this wrong by one and you plot Actor2's coordinates.

### Three traps confirmed in the real data

**(a) Geo country codes are FIPS 10-4, not ISO 3166. FIRST-PARTY DOCUMENTED.**
`gdeltproject.org/data.html` states directly that **CAMEO country codes are
used in the Actor fields while FIPS country codes are used in the Geo fields**
— so the two-scheme split is GDELT's documented design, not an inference drawn
from the data. (Cited by the maintainer from that page; this session could not
fetch it, as `www.gdeltproject.org` is egress-blocked here.)

That upgrades this from inferred to documented, and it independently explains
why the actor country columns (8, 18) use a *third* scheme: they are CAMEO
3-letter codes, which the same statement accounts for.

Confirmed independently against the fixture, pairing `ActionGeo_CountryCode`
with `ActionGeo_FullName`:

| Code | GDELT means | ISO 3166 would mean |
| --- | --- | --- |
| `CH` | China | Switzerland |
| `AU` | Austria | Australia |
| `IZ` | Iraq | *(unassigned)* |
| `UK` | United Kingdom | *(ISO uses `GB`)* |

Mapping these as ISO puts China in Switzerland and Austria in Australia. Note
this affects only the **Geo** country columns (38, 46, 54). The *actor* country
columns (8, 18) are 3-letter CAMEO codes (`CAN`, `IND`, `USA`) — a different
scheme again. Three code systems in one row.

**(b) `ActionGeo_Type` governs coordinate precision, and most rows are not
precise.** Codebook values: `1`=COUNTRY, `2`=USSTATE, `3`=USCITY,
`4`=WORLDCITY, `5`=WORLDSTATE; `0` means no geographic match. Types 1, 2 and 5
**still carry a lat/long** — the centroid of the country or state — with a blank
numeric FeatureID. Fixture distribution:

| ActionGeo_Type | Rows | Meaning for the globe |
| --- | --- | --- |
| 4 (world city) | 25 | plottable |
| 3 (US city) | 6 | plottable |
| 1 (country) | 7 | **country centroid** — Pakistan, China, Austria |
| 2 (US state) | 6 | **state centroid** — Ohio, Connecticut, Oklahoma |
| 0 (none) | 6 | **no coordinates — must be dropped** |

So 12% of rows have no location at all, and a further 26% would render at a
country or state centroid. Plotting a country-centroid row as a point marker
asserts a precision the data does not have. **Recommendation: require
`ActionGeo_Type ∈ {3, 4}` for a plotted marker** (62% of rows in this sample).
This is a stricter rule than the GEO 2.0 layer needed, and it is the honest one
— it is also consistent with the existing header comment in `events.js` warning
that these are place centroids, not incident positions.

**(c) One article produces many event rows.** 50 rows carry only **32 distinct
`SOURCEURL`s** and **31 distinct coordinate pairs**. One article about a
lake-renaming order generated 5 rows; a China Daily piece another 5; an Economic
Times piece 4. Dedupe is not an optimisation here, it is a correctness
requirement — without it a single well-covered story becomes a cluster of
stacked markers that reads as five separate incidents.

---

## 6. Volume — the rolling-window design revisited

The measured export size is **~67 KB zipped per 15-minute window**, far below
the earlier estimate. That number changes the design, and not in the direction
first assumed.

**Deriving the row count.** The fixture is 19,072 bytes of UTF-8 for 50 rows =
**381 bytes/row**. Compressing the fixture with deflate gives 4.05×; a full file
compresses better than a 50-row sample (warmer dictionary, more repeated CAMEO
codes and URL prefixes), so the real ratio is ~5–6×.

| Assumed zip ratio | Raw size | Rows / 15 min | Rows / day |
| --- | --- | --- | --- |
| 4× | 262 KB | ~700 | ~68k |
| **5×** | **327 KB** | **~880** | **~84k** |
| **6×** | **393 KB** | **~1,050** | **~101k** |
| 7× | 458 KB | ~1,230 | ~118k |

**Working figures: ~900 rows per window (range 700–1,250); ~85k rows/day
(range 68–118k).** These come from one quiet window (00:45 UTC); daytime windows
will be larger. Treat them as an order of magnitude, not a budget.

### What this means for the window design

The old design was **stateless**: GEO 2.0 was asked for a pre-aggregated 24-hour
view on every refresh, five times (once per category). The export gives raw
15-minute slices instead, so the proxy must become **stateful** — it accumulates
slices itself and evicts by `DATEADDED`.

Three numbers follow, and they point in different directions:

1. **Steady state is trivially cheap.** One 67 KB fetch per 15 minutes =
   **6.4 MB/day, 96 requests/day**. That is an order of magnitude *less* upstream
   traffic than the current design's 5-queries-per-refresh, and it comfortably
   fits the existing `GDELT_DEFAULT_DAILY_BUDGET` of 2,000 with room to spare.
2. **Cold start is the real constraint — and it is latency, not bandwidth.** A
   full 24-hour window is 96 files. That is only ~6.4 MB, which is nothing; but
   at the existing `GDELT_MIN_REQUEST_SPACING_MS` of 5 s courtesy spacing it
   takes **8 minutes** to backfill. The first request cannot wait for that.
3. **Retained rows, not bytes, are the ceiling.** A 24-hour window holds ~85k
   raw rows. After dropping ungeolocated rows (−12%), requiring city precision
   (−38% of the remainder), and deduplicating (~1.6:1 on URL in this sample),
   that is still on the order of 25–35k retained rows — against
   `EVENTS_MAX_ENTITIES = 300` on the globe. The proxy must reduce hard, and the
   reduction must happen server-side.

**Recommended shape: serve immediately, backfill in the background.** Fetch the
newest slice, answer the first request from it, then walk backwards one slice at
a time at the existing 5 s spacing until the configured depth is reached, and
evict by `DATEADDED` thereafter. Default depth **4 hours (16 slices, ~1 MB)**,
env-tunable up to 24 h. 4 h is the point where the window holds enough rows
(~14k raw, comfortably more than the 300-entity budget can show even after
filtering) without a multi-minute warm-up.

The earlier volume estimate had made a deep window look unaffordable. At 67 KB a
slice it is affordable; what remains expensive is the *cold-start request
sequence*, which is why the window grows in the background rather than blocking.

---

## 7. The categories cannot survive unchanged

This is the largest semantic consequence of the pivot and it needs a decision
before implementation starts.

The current five categories are GKG **theme** queries —
`theme:ARMEDCONFLICT`, `theme:PROTEST`, `theme:HUMANITARIAN_AID`,
`theme:ECON_STOCKMARKET`, `theme:NATURAL_DISASTER`.

**The Event Database has no themes.** It classifies events with CAMEO codes
only: `EventRootCode` 01–20 and `QuadClass` 1–4. The full CAMEO root list is:

`01` MAKE PUBLIC STATEMENT · `02` APPEAL · `03` EXPRESS INTENT TO COOPERATE ·
`04` CONSULT · `05` ENGAGE IN DIPLOMATIC COOPERATION · `06` ENGAGE IN MATERIAL
COOPERATION · `07` PROVIDE AID · `08` YIELD · `09` INVESTIGATE · `10` DEMAND ·
`11` DISAPPROVE · `12` REJECT · `13` THREATEN · `14` PROTEST · `15` EXHIBIT
FORCE POSTURE · `16` REDUCE RELATIONS · `17` COERCE · `18` ASSAULT · `19` FIGHT ·
`20` ENGAGE IN UNCONVENTIONAL MASS VIOLENCE

Every one of these is a *political interaction between two actors*. There is no
natural-disaster code, no humanitarian-crisis code, and no market code.
Concretely:

- **`disaster` cannot be reproduced at all.** An earthquake is not a CAMEO
  event. It appears in this dataset only as a derived political action
  (`07` PROVIDE AID after it), never as the disaster itself.
- **`humanitarian` maps only partially**, to `07` PROVIDE AID — which is aid *as
  a diplomatic act*, not humanitarian need.
- **`economic` has no mapping.** `06` MATERIAL COOPERATION covers trade
  agreements between states, which is not what `ECON_STOCKMARKET` meant.
- **`conflict` and `political` map well** — `18`/`19`/`20` and `14`
  respectively, or via `QuadClass` 3/4.

There is a second problem visible in the fixture: **the feed is dominated by
low-salience diplomatic chatter.** `EventRootCode 04` (CONSULT) alone is 22 of
50 rows (44%), and `QuadClass 1` (verbal cooperation) is 39 of 50 (78%). Only 7
rows (14%) are conflict of any kind and only 3 (6%) are material conflict. An
unfiltered "world events" globe would be a map of diplomatic meetings.

**This needs a call before implementation.** The options, with a recommendation:

- **(A) Re-derive the categories along CAMEO lines** — e.g. `conflict`
  (QuadClass 4), `unrest` (root 14), `coercion` (roots 13/15/17), `cooperation`
  (QuadClass 1–2), `dissent` (roots 10–12). Honest to the data. **Breaks the
  share-link contract**: the category codes `c/p/h/e/d` are baked into
  `OPTION_GROUPS.events` in `src/data/layerState.js` and into every URL already
  issued.
- **(B) Keep the five names and map what can be mapped**, leaving `disaster`
  and `economic` permanently empty. Preserves share links, but ships two
  categories that never return anything — dishonest UI.
- **(C) Keep the five names and source the unmappable ones elsewhere.**
  `disaster` is largely already covered by two layers that exist and work:
  `earthquakes` (USGS) and the FIRMS heatmap (fire). Retiring `disaster` from
  the events layer removes a duplicate rather than a capability.

**Recommendation: (A), with the `events` categories reduced to CAMEO-honest
ones, and `disaster` explicitly delegated to the existing earthquakes/FIRMS
layers.** The share-link break is real but contained — `LAYER_STATE_VERSION` is
already `2` and the codec has a version field precisely so option grammars can
change. Shipping an always-empty category is the worse outcome.

Deferred to the migration plan; not decided here.

---

## 8. Fixture problems to fix during migration

The committed fixture is real GDELT data and is trustworthy as *content*, but it
is not byte-faithful as a *wire capture*:

- **It is UTF-16LE with a BOM and CRLF line endings** (38,140 bytes on disk for
  19,072 bytes of text). GDELT does not serve UTF-16 — this is a Windows
  PowerShell redirection artifact. A parser test fed this file is not testing
  what the proxy will actually receive.
- **It is `head -50` of the file**, not a sample: `GlobalEventID` runs
  contiguously `1320453556`–`1320453605`. Because the file sorts backdated rows
  first, the head is *systematically unrepresentative* — which is exactly what
  produced the incorrect SQLDATE premise in §4.
- **It sits at the repo root**, not in `src/data/fixtures/` where every other
  fixture lives, and it is undocumented in `src/data/fixtures/README.md`.
- The `.gitignore` entries added alongside it (`export.zip`, `gdelt-sample/`)
  suggest a scratch workflow that should not outlive the migration.

Actions: re-capture bytes as served (or transcode to UTF-8/LF and say so),
sample across the file rather than the head, move it under
`src/data/fixtures/`, and document it in that README. Keep a raw
`.export.CSV.zip` fixture too — the ZIP container path needs its own test.

### Residual verification

Both items this section raised are now settled, and neither landed where it was
expected to:

- **The ZIP fixture.** Resolved — a real export was checked off-sandbox and is
  single-entry with no data descriptor and no Zip64. See §11.
- **The first-party column header.** Found, at
  `www.gdeltproject.org/data/lookups/CSV.header.dailyupdates.txt` — the
  filename this section originally carried was right, the host and path were
  wrong. It turns out to be the **GDELT 1.0** header (58 columns), and there
  appears to be no first-party 2.0 header at all. It still corroborates the 2.0
  map by offset arithmetic. See §12.

---

## 9. Decisions of record

1. **GEO 2.0 is abandoned.** Non-deterministic responses and no Node
   reachability. Do not retry without meeting the bar in §1.
2. **The GDELT 2.0 Event Database 15-minute export is the source.**
   `data.gdeltproject.org`, static files, Node-reachable, HTTP 200.
3. **`DATEADDED` (col 60) drives recency and the rolling window.** `SQLDATE`
   (col 2) is the event-occurrence date, is day-granular, is behind on ~30% of
   rows, and is displayed separately — never as the ingest time and never as the
   publication date.
4. **61 columns confirmed** against two byte-identical independent codebook
   mirrors and validated against 50 real rows with zero type violations. Geo
   country codes are **FIPS**, not ISO.
5. **Only `ActionGeo_Type ∈ {3,4}` gets a plotted marker.** Types 1/2/5 are
   country/state centroids; type 0 has no coordinates.
6. **Dedupe is a correctness requirement**, not an optimisation — 50 rows carry
   32 distinct source URLs.
7. **The proxy becomes stateful**: a `DATEADDED`-keyed ring of 15-minute slices,
   default depth 4 h, served immediately from the newest slice and backfilled in
   the background.
8. **The five GKG-theme categories do not survive the move.** RESOLVED — see
   §10. Five CAMEO categories keyed on `EventRootCode` alone: `conflict`
   (18-20), `unrest` (14), `coercion` (13, 15-17), `dissent` (10-12),
   `diplomacy` (01-09). `disaster` is delegated to the existing
   earthquakes/FIRMS layers; `humanitarian` and `economic` are retired with no
   replacement, because CAMEO has no equivalent.
9. **`LAYER_STATE_VERSION` stays at 2.** §7 assumed a version bump was the
   clean way to change the option grammar. It is not: `decodeLayerState`
   rejects the WHOLE URL on a version mismatch, for every layer at once, so a
   bump would discard camera, flights and CCTV state to re-grammar one option.
   Retired category codes are tolerated in place instead.

---

## 10. What the strided fixture changed

§4, §5 and §7 were written against a 50-row `head` of the export. §8 identified
that sample as systematically unrepresentative; re-sampling with a stride across
the whole file (209 rows, commit `0cadaf1`) confirmed it, and moved several
numbers enough to change decisions.

| Measure | head-50 | strided-209 | Consequence |
| --- | --- | --- | --- |
| QuadClass 1 (verbal cooperation) | 78% | 63% | The "globe of diplomatic meetings" risk is real but smaller |
| Root 04 (CONSULT) alone | 44% | 22% | As above |
| QuadClass 4 (material conflict) | 6% | 17% | Nearly 3x more conflict than assumed |
| Backdated rows (`SQLDATE` < ingest day) | 30% | 1.4% | The retrospective case is rare, not common |
| `ActionGeo_Type` 3 or 4 (plottable) | 62% | 59% | Close; the drop rule holds |
| `ActionGeo_Type` 0 (no geo) | 12% | 5% | Fewer unusable rows |

The backdated figure matters most for how §4 reads. Its core finding is
unchanged and still correct — `DATEADDED` is the recency field, `SQLDATE` is the
NLP-extracted date of the event described, and keying the window on `SQLDATE`
would silently drop fresh news. But the *scale* was overstated: 1.4% of rows are
backdated, not 30%. The retrospective signal is still carried
(`retrospectiveDays`) and still worth surfacing; it is an edge case, not a
visual-design constraint.

### The category mapping in the plan was defective

The migration plan's §3.1 keyed `conflict` on
`rootCode ∈ {18,19,20} OR quadClass === 4`, with a precedence rule resolving the
overlap it predicted between `conflict` and `coercion` ("two fixture rows").

Across the strided fixture that overlap is not two rows — it is **all fourteen
root-17 rows**, and the rule leaves `coercion` matching **nothing at all**. The
cause is that **QuadClass is a pure coarsening of EventRootCode**:

| QuadClass | Root codes | Distinct quads per root, observed |
| --- | --- | --- |
| 1 verbal cooperation | 01-05 | 1 |
| 2 material cooperation | 06-09 | 1 |
| 3 verbal conflict | 10-14 | 1 |
| 4 material conflict | 15-20 | 1 |

No root code maps to two QuadClass values anywhere in the fixture, so QuadClass
carries no information the root code lacks — and a `quadClass === 4` clause in
`conflict` silently swallows every coercion root.

**Shipped instead: all five categories keyed on `EventRootCode` alone**, making
them a total, disjoint partition of 01-20. This is not only non-empty but
strictly more accurate: under the mixed rule, `15` EXHIBIT FORCE POSTURE and
`16` REDUCE RELATIONS would both have been labelled armed **conflict**, which a
military exercise and a severed diplomatic tie are not.

| Precedence | id | code | Roots | strided-209 | plottable |
| --- | --- | --- | --- | --- | --- |
| 1 | `conflict` | `c` | 18, 19, 20 | 10.0% | 8.9% |
| 2 | `unrest` | `u` | 14 | 0.5% | 0.8% |
| 3 | `coercion` | `x` | 13, 15, 16, 17 | 6.7% | 6.5% |
| 4 | `dissent` | `s` | 10, 11, 12 | 10.0% | 12.9% |
| 5 | `diplomacy` | `y` | 01-09 | 72.7% | 71.0% |

The precedence order is retained and the assignment is still a first-match
walk, but with disjoint buckets it is no longer load-bearing for known codes.
`eventsFeed.test.mjs` asserts the partition is total and disjoint over 01-20 —
a stronger guarantee than the tie-break test the plan asked for. An unknown
root code lands nowhere rather than defaulting into a bucket.

### Share-link codes: retired, not recycled

The plan proposed recycling `d` (disaster) for `dissent` and keeping `p`
(political/PROTEST) for `diplomacy`. Both would have kept old links parsing
while changing what they select — a link asking for protests would come back
selecting diplomatic chatter, which is the "silently mean something different"
outcome §3.1 itself argued against.

Shipped: only `c` carries over, because only `conflict` kept its meaning. The
new categories take fresh letters (`u`, `x`, `s`, `y`) and `p`/`h`/`e`/`d` are
**retired** — dropped from an incoming link, never reused. An old link loses a
category it named and keeps the rest. A link naming only retired categories
falls back to the default set rather than blanking the layer.

### Dedupe ranks by severity, not coverage

§5(c) and the plan's §1.3 specified collapsing on `SOURCEURL` + coordinate,
keeping the row with the highest `numArticles`. Implemented that way, the
fixture's single protest disappeared: it shares an article and a place with a
better-covered consultation, and article volume handed the marker to the
consultation.

One article routinely yields several *different* coded events at one place, so
the survivor of a collapsed group must be the **most severe** row, with article
volume breaking severity ties. Dedupe therefore runs after classification, and
the ranking is injected — `gdeltExport.js` keeps owning record identity,
`eventsFeed.js` owns what severity means.

## 11. ZIP fixture provenance

`data.gdeltproject.org` is egress-blocked here (HTTP 403), so no archive as
GDELT serves it could be captured. The two committed archives were built from
the real TSV with Python's `zipfile` — a **different implementation from the
reader under test**, so a shared misreading of the format cannot make the tests
pass — and independently validated with `unzip -t`.

```bash
python3 - <<'PY'
import zipfile, io
data = open('src/data/fixtures/gdelt-export-sample.tsv','rb').read()
member = '20260829004500.export.CSV'

# Standard: seekable target, so sizes and CRC land in the local header.
with zipfile.ZipFile('src/data/fixtures/gdelt-export-slice.export.CSV.zip','w',
                     zipfile.ZIP_DEFLATED, compresslevel=9) as z:
    z.writestr(member, data)

# Data descriptor: an unseekable stream forces general-purpose bit 3 and
# zeroes the local-header sizes, moving them to a trailing descriptor.
class Unseekable(io.RawIOBase):
    def __init__(self, fh): self.fh = fh
    def writable(self): return True
    def write(self, b): return self.fh.write(b)
    def seekable(self): return False
    def tell(self): return self.fh.tell()

few = b'\n'.join(data.split(b'\n')[:3]) + b'\n'
with open('src/data/fixtures/gdelt-export-datadesc.export.CSV.zip','wb') as fh:
    with zipfile.ZipFile(Unseekable(fh),'w',zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        z.writestr(member, few)
PY
unzip -t src/data/fixtures/gdelt-export-slice.export.CSV.zip
unzip -t src/data/fixtures/gdelt-export-datadesc.export.CSV.zip
```

**RESOLVED 2026-08-29 — verified against a real export by the maintainer, off
this sandbox.** A genuine `.export.CSV.zip` reports: local signature
`504B0304`, general-purpose flags `0000`, EOCD signature `06054B50`, **1
entry**. No data descriptor, no Zip64, single entry.

So GDELT writes the *simpler* of the two shapes the reader handles: the
straightforward local-header case, which `gdelt-export-slice.export.CSV.zip`
already pins. The data-descriptor path is **defensive rather than required** —
it costs about fifteen lines and a central-directory read, and it is kept
because a streamed writer is a normal thing for a publisher to switch to
without notice, and the failure mode if it did would be silent (an empty file,
not an error). Zip64 and multi-entry remain unhandled and unneeded.

The commands below reproduce that check on any future capture:

```bash
curl -sO http://data.gdeltproject.org/gdeltv2/$(curl -s \
  http://data.gdeltproject.org/gdeltv2/lastupdate.txt \
  | awk '/export.CSV.zip/{print $3}' | xargs basename)
zipinfo -v *.export.CSV.zip | grep -Ei 'entries|zip64|disk|general purpose'
```

## 12. The first-party header file: found, and it is GDELT 1.0

**Resolved 2026-08-29 by the maintainer**, off this sandbox — both
`gdeltproject.org` hosts remain egress-blocked here, so nothing in this section
was fetched by the session that wrote it. The 58 names were supplied by the
maintainer and are committed verbatim as
`src/data/fixtures/gdelt-events-columns-v1.txt`; `gdeltExport.test.mjs` now
pins the 1.0 → 2.0 offset relationship against them, so this section's
arithmetic is enforced rather than asserted.

**Corrected location.** The filename an earlier draft named was right; the host
and path were wrong.

| | |
| --- | --- |
| Wrong (404) | `data.gdeltproject.org/gdeltv2/CSV.header.dailyupdates.txt` |
| **Correct** | `www.gdeltproject.org/data/lookups/CSV.header.dailyupdates.txt` |

**It is the GDELT 1.0 header, not 2.0.** It is filed under GDELT 1.0 and lists
**58 columns**. Our export is 2.0, which has **61**.

**There appears to be no first-party 2.0 header file at all.** The only 2.0
schema documentation linked from `gdeltproject.org/data.html` is
`blog.gdeltproject.org/gdelt-2-0-our-global-world-in-realtime/`, which is prose
rather than a machine-readable list. That is the likely reason no clean 2.0
mirror exists and why every mirror in §5 is a community reconstruction.

### The three new fields are INSERTED, not appended

61 − 58 = 3, and the three names absent from the 1.0 list are:

- `Actor1Geo_ADM2Code`
- `Actor2Geo_ADM2Code`
- `ActionGeo_ADM2Code`

One per geo block. This settles a question that had been left open: 2.0 does
**not** simply append fields to 1.0, so no index after the first geo block can
be carried over from 1.0 reasoning unchanged.

### Reciprocal verification of `COL.ACTION_GEO_LAT`

This yields a second, independent derivation of the single most consequential
index in the file — the one whose failure mode is a plausible-looking marker in
the wrong country.

Forward, from the 1.0 file:

```
1.0 ActionGeo_Lat            position 54
  + 3 insertions, all preceding it
  = 2.0 position 57          index 56    == COL.ACTION_GEO_LAT
```

Backward, from our committed 2.0 list (run in this session against
`src/data/fixtures/gdelt-events-columns.txt`):

```
remove Actor1Geo_ADM2Code (pos 40), Actor2Geo_ADM2Code (pos 48),
       ActionGeo_ADM2Code (pos 56)
  -> 58 names                        == the reported 1.0 count
  -> ActionGeo_Lat at position 54    == the reported 1.0 position
```

Two derivations from independent sources meeting at index 56. It also
independently corroborates the `ADM1_CODE` / `ADM2_CODE` naming that the
mechanical test in §5 forced by hand.

**The placement question — settled, but not by either header file.** The 1.0
file gives the count and which three names are new. It cannot fix where each
`ADM2Code` sits inside its block, because it contains no `ADM2Code` at all; the
strict `Type, FullName, CountryCode, ADM1Code, ADM2Code, Lat, Long, FeatureID`
ordering comes from the §5 mirrors.

**The real data settles it, and more decisively than any header file could.**
If `ActionGeo_ADM2Code` sat after `ActionGeo_Lat` rather than before it, index
56 would be reading ADM2 codes. Across the 209-row fixture:

| index | content | rows passing a −90…90 latitude check |
| --- | --- | --- |
| 55 (`ActionGeo_ADM2Code`) | admin codes — `12552`, `CA02` | **0 / 209** |
| 56 (`ActionGeo_Lat`) | coordinates | **199 / 209** |

Not one row would survive the shift. And in the rows that name a city the
coordinates land on it — Vancouver at 49.25, −123.133 — which a shifted map
cannot produce. `gdeltExport.test.mjs` pins both figures.

So the 2.0 blog post is no longer load-bearing for this map. It would confirm
the ordering as prose; the data already forbids the alternative.

### Confirmation status by position

| 2.0 positions | Status |
| --- | --- |
| **1–39** (`GLOBALEVENTID` … `Actor1Geo_ADM1Code`) | **First-party confirmed.** Present and identical in the 1.0 header, and entirely ahead of the first insertion, so no offset applies. Pinned by `assert.deepEqual(SCHEMA.slice(0, 39), SCHEMA_V1.slice(0, 39))`. |
| **40–61** (from `Actor1Geo_ADM2Code` on) | **First-party confirmed by offset, plus settled empirically.** Every name is in the 1.0 header at a known position except the three insertions themselves; the offset is enforced by `SCHEMA.filter(not inserted) === SCHEMA_V1`; and the real data forbids the only alternative placement. |

The boundary is 39, not 35. The first insertion is `Actor1Geo_ADM2Code` at 2.0
position 40, so positions 36–39 (`Actor1Geo_Type`, `_FullName`,
`_CountryCode`, `_ADM1Code`) are also at 1.0 offsets — and the 58-name list
confirms all four are present in 1.0 at exactly those positions, which is what
promoted them from the derived tier.

### Closed

Nothing further is owed on the column map. The evidence now stands on four
independent legs, and `gdeltExport.test.mjs` fails if any of them stops holding:

1. **First-party 1.0 header** — 58 names, committed, positions 1–39 identical.
2. **Offset arithmetic** — 2.0 minus the three insertions is exactly the 1.0
   list, in order.
3. **Two independent 2.0 mirrors** (§5) — agreeing on all 61 names.
4. **The real data** — a shifted map yields 0/209 plottable latitudes, and
   coordinates that match the place names they sit beside.

The 2.0 blog post would restate leg 3 in prose. It is no longer needed.

## 13. Verification status at a glance

| Claim | Status |
| --- | --- |
| 61 columns, in the order pinned by `COL` | **Corroborated AND test-enforced** — two independent mirrors agree on all 61 names; the sequence is committed as `fixtures/gdelt-events-columns.txt` and `gdeltExport.test.mjs` fails if any `COL` index stops naming its column; 0 type violations against real rows |
| Mirrors are byte-identical | **False** — corrected in §5; they are different files that agree on the name sequence |
| Geo country codes are FIPS, not ISO | **First-party documented** (`gdeltproject.org/data.html`: CAMEO in Actor fields, FIPS in Geo fields) **and verified** against real rows (CH→China, RS→Russia, UP→Ukraine, HA→Haiti, UK→United Kingdom) |
| `DATEADDED` is the ingest clock, identical file-wide | **Verified** against the fixture |
| Real export ZIP is single-entry, no data descriptor, no Zip64 | **Verified** by the maintainer against a live capture (§11) |
| Category distribution and the CAMEO partition | **Verified** against 209 strided rows (§10) |
| First-party column header file | **FOUND and committed** — GDELT 1.0, 58 columns (`www.gdeltproject.org/data/lookups/CSV.header.dailyupdates.txt`), stored as `fixtures/gdelt-events-columns-v1.txt`. No first-party 2.0 header appears to exist. See §12 |
| 2.0 adds fields by insertion, not appending | **First-party** — the three absent names are `Actor1Geo_ADM2Code`, `Actor2Geo_ADM2Code`, `ActionGeo_ADM2Code`, one per geo block |
| `COL.ACTION_GEO_LAT` = index 56 | **Four independent legs agree** — 1.0 offset (54 + 3), the committed 2.0 list, both §5 mirrors, and the real rows (0/209 plottable at index 55) |
| Positions 1–39 | **First-party confirmed and test-pinned** — present and identical in the committed 1.0 header, ahead of the first insertion |
| Positions 40–61 | **First-party confirmed by offset and settled empirically** — the insert relationship is test-pinned, and a shifted map yields 0/209 plottable latitudes |
