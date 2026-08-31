# Changelog

This changelog records public product changes. For the authoritative description
of current runtime behavior, see [`docs/CURRENT-STATE.md`](docs/CURRENT-STATE.md).

## [Unreleased] — 2026-08-24

### Added

- Political Events markers now respond to hover: the marker enlarges and a card
  appears above it with the category and its description, place, source domain,
  coverage count, and a badge when the event is dated before GDELT ingested it.
  The card is drawn on the existing world-overlay card lane — no new UI surface.
- A single click now opens the source article, replacing the previous
  select-then-click-again interaction. The safeguard that made two stages
  necessary is kept explicitly: a click that ends a camera drag over a marker
  opens nothing.

### Fixed

- Political Events markers no longer render through the globe. Events on the
  far side of the planet were drawn over the near side — Asia visible with the
  camera over North America — because the markers are always-on-top
  (`disableDepthTestDistance`, so a marker is never swallowed by the terrain it
  stands on) and nothing else occluded them. They are now horizon-culled
  against an ellipsoid occluder, the same pass the radio, CCTV, flights, and
  FIRMS layers already run, in both map stacks. The cull runs during camera
  movement as well as on settle, so the far side clears while dragging and
  through zoom inertia rather than only on release.

### Changed

- Moved the events layer off the GDELT GEO 2.0 query API and onto the GDELT 2.0
  Event Database 15-minute export, and renamed it **World Events → Political
  Events** to match what the data actually is. GEO 2.0 answered identical
  requests with 404, an empty 200, or no response at all, non-deterministically,
  and was unreachable from Node entirely; the export is a static file host and
  is reachable. The layer now shows CAMEO-coded political interactions between
  two actors.
- Replaced the five GKG-theme categories with five CAMEO ones — **conflict,
  unrest, coercion, dissent, diplomacy** — derived from `EventRootCode` alone
  and partitioning roots 01–20 exactly. `diplomacy` is off by default at
  roughly 70% of any window.
- **Retired the humanitarian, economic, and disaster categories.** CAMEO has no
  code for any of them, so they cannot be reproduced from this source and are
  not faked. Natural disasters are already covered, with better data, by the
  earthquakes (USGS) and FIRMS active-fire layers. `DATA_SOURCES.md` states
  plainly what this source does and does not cover.
- Share links issued under the old category grammar still work: the retired
  codes (`p`, `h`, `e`, `d`) are dropped from an incoming link rather than
  reused, so an old link loses a category it named instead of silently
  selecting a different one, and the rest of the link still applies.
- Marker size now encodes a **CAMEO intensity index** — Goldstein
  conflict/cooperation scale, article volume, and a per-category weight —
  replacing the coverage-only index. It is still labelled as an intensity and
  coverage measure, not a severity, casualty, or damage assessment.
- Only city-precision events are plotted. Country and state centroids, which
  the export also carries coordinates for, are dropped rather than drawn as
  points that would assert a precision the data does not have.
- `/api/events` keeps a rolling window of 15-minute export slices (default 4 h,
  `GDELT_WINDOW_SLICES`) instead of issuing five queries per refresh: the
  newest slice is served immediately and the window is deepened in the
  background. Steady-state upstream traffic drops to about 96 requests a day.
  Retires `GDELT_EVENTS_TIMESPAN`; adds `GDELT_WINDOW_SLICES` and
  `GDELT_EXPORT_BASE`.

### Added

- Added a geolocated Political Events layer sourced from the GDELT 2.0 Event
  Database (keyless): markers on the globe for CAMEO-coded political
  interactions over a rolling window, with per-category filter chips, a colour
  legend, and click-through to the source article. Marker size encodes a CAMEO
  intensity index, labelled as intensity and coverage rather than as a
  severity, casualty, or damage assessment. Coordinates are city centroids
  resolved from article text, so the layer feeds no detection surface.
- Added the `/api/events` dev/preview proxy: a rolling ring of 15-minute export
  slices, a 15-minute memory and disk cache, a daily upstream-request budget
  governor, serve-stale on upstream failure, and sanitized errors. Archives are
  read and the window is reduced server-side, so no archive handling and no
  unreduced window reaches the browser.
- Added honest aircraft identity narration: callsign, operator, registration,
  type, and route come only from selected-contact context, and missing operator,
  route, or type enrichment is named explicitly.
- Added local, publication-compatible copies of the two README PNGs, with source
  records and third-party-license boundaries in `docs/media/README.md`.
- Added regression coverage for aircraft identity narration and optional-key
  loading feedback.

### Changed

- First-run presentation now opens with Detection `DENSE` at 75%, `ELASTIC`
  allocation, Fade 7%, Outside 1%, scope feather 11%, and aircraft 3D models in
  `PROXIMITY`. Stored state and share links still override these baselines.
- The 17 selected README GIFs remain unchanged and are documented separately
  from the two owner-published PNGs.
- Bundled datacenter and dam snapshots now omit contact-oriented fields and
  note values containing email or phone identifiers. Feature geometry, names,
  operator/capacity/river metadata, counts, and ODbL terms are unchanged.
- Public documentation and the L9 release matrix no longer reference non-public
  planning material or repository history.

### Fixed

- A missing optional FIRMS key no longer turns the complete Environmental
  mission into `LOAD FAILED`. The FIRMS row still reports `KEY REQUIRED`, while
  earthquakes continue to load. Real lifecycle and fetch failures retain
  failure priority.
- The mapped-installations layer retries after an unavailable request when it is
  enabled or the camera settles.
- Aircraft trails attach to the rendered aircraft transform and remain near the
  rear center across headings. Parked aircraft do not draw a moving head
  segment.
- Grounded aircraft keep validated floor evidence through temporary terrain
  outages and wait for measured photoreal-surface evidence before a 3D model
  takes over from its billboard.
- Cockpit altitude uses aviation MSL data rather than Cesium render height.

### Security

- Production transitive dependencies resolve to patched DOMPurify and
  protobufjs releases without changing the Cesium version or application APIs.
- Production dependency audit reports no known advisories; remaining audit
  findings are confined to development and QA tooling.

## [Unreleased] — 2026-08-23

### Added

- Added a first-run mission launcher for Contacts, Space Missions,
  Environmental, and manual exploration.
- Added terrain-validity gating and bounded last-known placement for grounded
  aircraft models.

### Changed

- Environmental consistently presents both earthquakes and NASA FIRMS fires,
  with honest optional-key degradation.
- The tracked aircraft trail acceptance bar is visual: roughly rear-center,
  stable across headings, with minor hull overlap allowed and no conspicuous
  top, bottom, or lateral projection.

## [Unreleased] — 2026-08-18 to 2026-08-22

### Added

- Added the four-source Map Source tray, share-link v2 state, cockpit/context
  voice parity, MSL altitude readouts, and close-range tracked aircraft models.
- Added the L9 release-candidate matrix, AIS feed watchdog, voice cost controls,
  satellite classes, and the shared world-overlay host.
- Added deterministic first-run, map-source, floor, overlay, tracking, and
  aircraft-model regression harnesses.

### Changed

- Consolidated world labels, cards, tracked readouts, CCTV thumbnails, cable
  labels, mission labels, and detection presentation under shared allocation and
  lifecycle rules.
- Reduced idle rendering through the render governor and explicit scope mask.
- Improved cockpit layout, context restoration, keyless feed honesty, and
  aircraft 2D/3D handoffs.

### Fixed

- Fixed degenerate depth picks, map-source restore states, route-camera motion,
  bright-ground label readability, grounded display flooring, and cross-layer
  tracking cleanup.
- Fixed stale overlay callbacks, parked-idle render leaks, cable-label sweep
  starvation, and several share-link state conflicts.

## [Unreleased] — 2026-08-02 to 2026-08-16

### Added

- Added Global Context modes, Cockpit briefing surfaces, Radio context,
  satellite mission replay, and real per-class aircraft models with adjacent
  provenance records.
- Added a shared screen-space overlay system with bounded allocation for labels,
  cards, callouts, detection brackets, and selected-object presentation.

### Changed

- Unified right-side product controls and responsive cockpit/map layouts.
- Migrated public-safe neighborhood geometry to DataSF and tightened safe local
  development defaults.
- Improved proxy resilience, annotation outline bounds, CCTV enable pacing,
  contact de-emphasis, and deterministic visual stacking.

## [Unreleased] — July 2026

### Added

- Added live NASA FIRMS fires, optional live TomTom traffic, Caltrans and TfL
  CCTV packs, CCTV viewsheds and direct-manipulation calibration, citywide CCTV
  cards, Natural Earth regions, analyst queries, and voice routing QA.
- Added the end-to-end vertical-datum system for aircraft, vessels, CCTV,
  annotations, trails, and terrain-aware rendering.
- Added aircraft class silhouettes, path-derived display heading, ADSBDB
  enrichment, cached CelesTrak TLE lookup, and next-ISS-pass prediction.

### Fixed

- Fixed elevated-airport aircraft placement, vessel sea-surface placement,
  close-zoom FIRMS anchors, antimeridian region framing, annotation resolution,
  cross-layer tracking ownership, and CCTV projection lifecycle issues.

## [Unreleased] — June 2026

### Added

- Added OpenAI Realtime voice control, scene-aware entity context, viewport image
  grounding, the AI HUD summary, live AIS vessels, infrastructure layers, map
  source switching, free-text navigation, and server-side data proxies.
- Added hybrid map annotations, 3D aircraft, panoptic detection, tracking
  harnesses, and public data attribution.
- Added MIT source licensing, security guidance, contribution guidance, data
  source notices, and third-party asset boundaries.

### Changed

- Removed the experimental AI video-edit style and retained seven deterministic
  visual styles.
- Moved Realtime text-history trimming to the server-side retention policy while
  keeping only the latest viewport image in conversation context.

## [0.7.0] — 2026-02-18

- Added the Bikeshare Pulse layer and panoptic label improvements.
- Improved tracked-item boxes, post-render alignment, and CCTV projection
  quality.
- Removed the experimental shift-drag CCTV calibration interaction.

## [0.6.0] — 2026-02-10

- Added the initial multi-layer 3D globe experience, visual styles, live
  aircraft, satellites, earthquakes, CCTV, traffic, FIRMS, infrastructure, and
  performance controls.
- Added entity inspection, tracking, scenes, keyboard controls, and shareable
  views.

## [0.1.0] — 2026-02-09

- Initial project version.
