# Test fixtures

- `tomtom-flow-austin-12-935-1686.pbf` — one real TomTom traffic-flow vector
  tile (Mapbox Vector Tile protobuf, layer `"Traffic flow"`), downtown Austin
  z12 x935 y1686, captured 2026-07-16 from
  `api.tomtom.com/traffic/map/4/tile/flow/relative/12/935/1686.pbf`
  (22,980 bytes). Used ONLY by `src/data/flowTiles.test.mjs` to pin MVT
  decoding offline — it is a point-in-time congestion snapshot, not a bundled
  data layer, and is never served to the app. © TomTom.

- `gdelt-geo-conflict-sample.json`, `gdelt-geo-disaster-sample.json`,
  `gdelt-geo-empty.json`, `gdelt-geo-malformed.json` — **SYNTHETIC AND
  UNVERIFIED AGAINST REAL DATA.** These are not captures. They were hand-built
  on 2026-08-28 from GDELT's *published documentation* for the GEO 2.0
  endpoint (`api.gdeltproject.org/api/v2/geo/geo?format=GeoJSON&mode=PointData`)
  in an environment with no network route to that host, so no live response was
  ever observed. They pin `src/data/eventsFeed.js` parser behaviour — coordinate
  validation, article-link extraction from `properties.html`, the empty and
  malformed branches — and nothing else. Specifically UNCONFIRMED: the real
  markup inside `properties.html` (tag shape, escaping, `<br>` vs `<br />`),
  whether `count` is always present, and the upstream error-body shape. Replace
  these with a real capture when one is available; if the live markup differs,
  `extractArticleLinks` degrades to zero articles rather than to wrong ones.
  The sample text is invented and the domains are `example.*` reserved names —
  no real headline, URL, or publisher appears here.
