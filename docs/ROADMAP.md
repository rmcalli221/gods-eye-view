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
