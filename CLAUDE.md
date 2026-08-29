# God's Eye View — fork working notes

Fork of `bilawalsidhu/gods-eye-view`. Goal: add live geolocated events,
denser CCTV, markets overlays, and extra infrastructure layers without
breaking the existing globe, cockpit, or voice experience.

Upstream is MIT and actively maintained — keep changes clean enough to
upstream as PRs.

## Read before changing runtime behavior

- `docs/CURRENT-STATE.md` — authoritative runtime reference. Read first.
- `CONTRIBUTING.md` — architecture, style, PR rules.
- `SECURITY.md` — proxy and key handling rules.
- `docs/PERFORMANCE.md` and `docs/KNOWN-ISSUES.md` before perf work.

## Commands

```bash
./scripts/dev-fresh.sh     # dev server on localhost:4173
npm run build
npm test                   # scripts/run-unit-tests.mjs
npm run test:track         # requires dev server running
```

All three must stay green. Never mark work done without running them.

Node 24.14.x or 26.x (enforced by `package.json` engines).

## Architecture rules

- **No framework.** Vanilla ES modules + CesiumJS + Vite.
- **UI lives in `src/ui.js`. Layer logic lives in `src/data/<layer>.js`.**
  Never mix them.
- Each layer is one self-contained module in `src/data/` providing a layer
  object with `id, name, icon, source, updateInterval` and
  `init(viewer) / enable(viewer) / disable(viewer) / update(viewer)`. Most
  modules default-export a singleton object literal (flights, cctv, radio,
  satellites, traffic, ...); a module needing per-instance config exports a
  factory instead (`createEarthquakesLayer`, `createFirmsHeatmapLayer`,
  `createLocalGeoJsonLayer`, `createTeleGeographySubmarineCableLayer`) and
  either default-exports one constructed instance or is constructed in
  `src/data/localLayers.js`. Register the instance in `src/main.js`.
- Those four lifecycle methods are REQUIRED — `DataLayerManager` calls them
  unguarded. Each also receives an options object carrying an `AbortSignal`
  (`update(viewer, { signal })`); honour it in long fetches, ignore it
  otherwise. Any of them may be async, and returning `false` rejects the
  lifecycle transition rather than settling it.
- **`destroy(viewer)` takes the viewer** — it is what removes the layer's data
  sources from it. The manager calls it only when present, so it is optional
  in principle, but every registered layer implements it and one without it
  leaks its entities on teardown. May be async; `false` rejects teardown.
- `getStats()` is guarded the same way (absent → `{ count: 0, lastUpdate: null }`)
  yet every registered layer implements it: it is what feeds the control-chip
  feed state through `layerFeedState()` in `src/data/manager.js`. Return at
  least `{ count, lastUpdate, error }`.
  `getDetectableObjects({ mode, maxCount, seed })` is the genuinely optional
  one — implement it only for layers whose entities detection should label.
- `src/data/earthquakes.js` is the cleanest reference. Read it before
  writing a new layer.
- Register the layer in `LAYER_STATE_REGISTRY` in `src/data/layerState.js`
  as `{ id, token, disposition }`. `token` is one unused letter and owns
  URL share-link ordering. Taken: a b c d e f g i m n q r s t u w x.
  Free: h j k l o p v y z.
- Register attribution in `src/data/dataCredits.js`.
- Voice tools: declared server-side in `GEV_REALTIME_TOOLS`
  (`vite.config.js`), executed client-side in `src/voice/gevActions.js`.
  Keep the tool surface tight; only confirm what actually happened.

## Data and secrets

- **Secrets never reach the browser.** Anything needing a private key goes
  through a Vite dev-server proxy in `vite.config.js`. The only key the
  client sees is the restricted Google Maps key.
- New proxies follow the existing pattern: memory + disk cache, rate/budget
  governor, serve stale on upstream failure, sanitized error responses (no
  upstream error text). Model on the FIRMS or CelesTrak proxy.
- `vite.config.js` is ~7,400 lines. Read the specific proxy being modeled,
  not the whole file.
- **Fetch data at runtime; do not bundle datasets we can't redistribute.**
- Every new source gets a `DATA_SOURCES.md` entry with license and
  attribution, in the same PR.
- No scraping of sources whose terms forbid it. No paywalled or private
  data. Never present public-data inference as authoritative intelligence.

## CCTV rules (strict)

- The proxy fetches **only server-registered upstream URLs**. Never accept
  a client-supplied URL. No runtime "add a camera" UI.
- Pin image URLs to the official upstream origin, the way the TfL fetcher
  pins to the JamCams bucket.
- Source packs are server-side fetcher functions in `vite.config.js`
  (Austin / Caltrans / TfL). The `config/cctv_sources.*.json` files ship
  empty and are populated via `CCTV_SOURCES_FILE` / `CCTV_SOURCES_JSON`.
- Density is capped by env (`CCTV_*_MAX_SOURCES`, `CCTV_CALTRANS_DISTRICTS`).
  Try raising caps before adding packs — measure frame time first.
- New packs need coordinates + attribution + registered frame URLs, and
  must not degrade 3D projection, calibration, or viewshed quality.

## Code style

- 2-space indent, single quotes, semicolons, ES modules.
- JSDoc on exported/public functions.
- Match surrounding code: naming, idiom, comment density.
- Log with the existing prefix convention: `[Data:Earthquakes]`, `[firms-proxy]`.
- Every new module in `src/data/` gets a sibling `<name>.test.mjs`.
- Small commits, conventional prefixes (`feat:`, `fix:`, `perf:`, `docs:`).

## Working agreement

- Use Plan mode for anything touching more than one file. Wait for approval.
- One phase per branch: events → CCTV → markets → infrastructure.
- Update `docs/CURRENT-STATE.md` and `CHANGELOG.md` when runtime behavior
  changes.
- If a data source's terms are unclear, stop and ask rather than guessing.
