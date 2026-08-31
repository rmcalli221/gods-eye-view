# Roadmap

Phases run one per branch, in the order set out in `CLAUDE.md`:
events → CCTV → markets → infrastructure.

## Next candidate: events feed panel

**Deferred from the events phase (2026-08-29) because it is a UI addition, not
a data-layer one.** Everything else in that phase stayed inside `src/data/`;
this is the first item that would touch the app shell.

A severity-ranked list of current events, in the style of
`monitor-the-situation.com`:

- ranked by the same `cameo-intensity` score the markers use;
- respects the active category filter chips, so the list and the globe never
  disagree about what is shown;
- clicking an item flies the camera to that event and selects it;
- selection round-trips — selecting a marker on the globe highlights its row.

### What it would touch

| File | Why |
| --- | --- |
| `index.html` | New panel markup, in the left panel stack alongside `radio-panel` / `cctv-panel` |
| `src/ui.js` (~10k lines) | Panel registration, collapse state, list rendering, click wiring |
| `style.css` (~9k lines) | Panel and row styling; `space-mission-roster` is the closest existing pattern |
| `src/data/layerState.js` | Possibly a token for panel open/closed, if that should survive a share link |

### What already exists

- `getAnalystRecords()` on the events layer returns render-selected,
  severity-ranked, JSON-safe records that already respect the category filter.
- `flyToWorldTarget()` in `src/worldFocus.js` is the camera move.
- `contextStore.js` already carries event selection, so the panel and the globe
  can share one selection rather than inventing a second.

### The fiddly part

Selection round-tripping. The layer registers entity context on click and the
panel would need to both read that and drive it, without the two fighting over
who owns the current selection. Worth designing before building.

## Investigated, not built: article headlines on the event card

The hover card currently ends with the category's own description, which is
identical for every event in that category. A real headline — "Philly man
receives life sentence for..." — would be better. Three routes were costed on
2026-08-29; **none produces one**.

### The Event Database has no title, and neither does the GKG

The export carries no headline field. The GKG file from the same 15-minute
family was probed directly: **27 columns, no title field.** Column 5 is the
article URL and **joins to `SOURCEURL` exactly**, so the join itself is sound —
there is simply nothing headline-shaped on the other side of it. Column 23 is
quotations with `offset|length||text` prefixes: an extracted quote, not a
caption, and unreliable.

What the GKG does carry, per article: col 8 themes, col 12 persons, col 14
organizations, col 16 tone.

### Cost of the GKG join

| | per slice | 96 slices/day | 4 h backfill (16) |
| --- | --- | --- | --- |
| export (today) | 67 KB | 6.5 MB | 1.1 MB |
| + GKG | **5,336,697 B (79x)** | **512 MB** | **85 MB** |

**Lazy per-hover is not available.** The GKG is a flat file with no index, so
answering one hover means downloading all 5.34 MB — strictly worse than
per-slice, not better. The only viable shape is **lazy per SLICE**: fetch a
slice's GKG on the first hover of an event belonging to it, cache the joined
subset (~314 URLs, tens of KB), evict with the slice. Env-gated off by default.

### What a GKG blurb would read like

From the one real probed row (persons `george santos`; orgs
`commodity futures trading commission; white house; new york times`):

```
Washington                                 Washington
CONFLICT · intensity 73                    CONFLICT · intensity 73
George Santos                              Assault, fight, unconventional...
Commodity Futures Trading Commission…      nbcphiladelphia.com · 7 reports
nbcphiladelphia.com · 7 reports
        proposed                                  ships today
```

Marker-specific, which the current line is not — but it is "who is in this
story", not a headline. Persons and organizations go on separate card lines;
org names are too long to share one. Themes are excluded: they are ALL_CAPS
internal codes (`TAX_POLITICAL_PARTY_REPUBLICAN`, `EPU_*`) whose readable
labels are the same third-party table problem as the CAMEO leaf codes
(§14), and far noisier.

### Blocking question

**Coverage is unmeasured.** What fraction of plottable events join to a GKG row
carrying at least one person or organization, after discarding entities that
merely repeat the place? A measurement script exists and reuses the layer's own
drop rules. Rough decision line: **≥60% usable** justifies the 5.34 MB lazy
fetch; **below ~40%** gives a card that changes shape unpredictably, which
reads worse than a consistent generic line.

### The other two routes, for the record

- **Fetch each `SOURCEURL` and read its `<title>`.** Turns the proxy into a
  fetcher of arbitrary third-party-controlled URLs — an SSRF surface, needing
  private-range blocking, redirect and byte caps, no cookies. A bulk crawl
  (~5,000 URLs per 4 h window across ~200 domains) is squarely what the
  no-scraping rule in `CLAUDE.md` forbids. A hover-triggered single GET of a
  link already displayed is defensible, but it is a standing policy change and
  should be agreed explicitly, not slipped in with a feature.
- **CAMEO leaf code plus actor fields.** Capped twice: no cleanly-licensed
  code-to-label table (§14), and the actor pair is filled on only 44% of rows
  and frequently generic where present. Best case reads
  `UNITED STATES → THE WHITE HOUSE · Consult` — a coded abstraction, not a
  headline.
