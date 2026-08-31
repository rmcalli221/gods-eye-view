/**
 * GDELT 2.0 GKG parsing — per-article named entities, joined to events by URL.
 *
 * PURE MODULE — no Cesium, no Node built-ins, no I/O, same contract as
 * `gdeltExport.js`. Imported by both the `/api/events` proxy and the browser
 * layer so neither can disagree about the shape.
 *
 * WHY THIS EXISTS. The Event Database has no article headline, and neither does
 * the GKG: a direct probe of a real file found 27 columns and no title field.
 * What the GKG does carry is per-article PERSONS and ORGANIZATIONS, which give
 * a marker-specific card line where the category description is identical for
 * every event in its category. That is "who is in this story", NOT a headline,
 * and nothing here should be presented as one. See `docs/ROADMAP.md`.
 *
 * THE JOIN. GKG rows are per ARTICLE, keyed by the article URL, which is
 * exactly the export's `SOURCEURL`. Measured on a real slice: 100% of plottable
 * events join to a GKG row, and 98.5% of them carry at least one person or
 * organization.
 *
 * COST. A GKG slice is ~5.3 MB against the export's ~67 KB — 79x — and the file
 * is flat and unindexed, so there is no way to read one article's row without
 * downloading all of it. That is why the fetch is lazy per SLICE and gated off
 * by default; see `gdeltEventsProxy()` in `vite.config.js`.
 */

/** Columns in one GKG row, as observed on a real file. */
export const GKG_COLUMN_COUNT = 27;

/**
 * Zero-based indices for the columns this module reads.
 *
 * ONLY THE OBSERVED COLUMNS ARE NAMED. A direct field dump of a real GKG row
 * identified these six; the other 21 columns are deliberately left unnamed
 * rather than filled in from recall, which is the mistake that produced a 404
 * documentation path and an invented file size earlier in this work. Anything
 * added here needs the same first-party confirmation.
 */
export const GKG_COL = Object.freeze({
  /** col 5 — the article URL. Joins to the export's SOURCEURL exactly. */
  DOCUMENT_IDENTIFIER: 4,
  /** col 8 — theme codes. Read but NOT rendered; see `parseGkgRow`. */
  THEMES: 7,
  /** col 12 — extracted person names, lowercased by GDELT. */
  PERSONS: 11,
  /** col 14 — extracted organization names, lowercased by GDELT. */
  ORGANIZATIONS: 13,
  /** col 16 — comma-separated tone vector; the first value is average tone. */
  TONE: 15,
  /** col 23 — quotations, `offset|length||text`. NOT used: an extracted quote
   * is not a caption, and the offsets make it unreliable to present. */
  QUOTATIONS: 22,
});

/** Longest entity name retained; anything longer is extraction noise. */
const MAX_ENTITY_CHARS = 60;
/** Entities kept per kind per article. The card has room for a couple. */
const MAX_ENTITIES_PER_KIND = 4;

/**
 * Split one GKG list field into names.
 *
 * GKG list fields are `;`-separated, and several of them append a character
 * offset to each entry as `name,offset`. Taking the part before the first
 * comma handles both the offset form and the plain form, at the cost of
 * truncating a name that genuinely contains a comma — which is the right
 * trade, since a trailing offset rendered into a card reads as corruption.
 *
 * @param {*} value Raw field value.
 * @returns {Array<string>} Cleaned names, deduplicated, order preserved.
 */
export function splitGkgList(value) {
  const seen = new Set();
  const out = [];
  for (const part of String(value ?? '').split(';')) {
    const name = part.split(',')[0].replace(/\s+/g, ' ').trim();
    if (!name || name.length > MAX_ENTITY_CHARS) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
    if (out.length >= MAX_ENTITIES_PER_KIND) break;
  }
  return out;
}

/**
 * Parse one GKG row into the fields this layer uses.
 *
 * Themes are parsed but deliberately NOT surfaced: they are ALL_CAPS internal
 * taxonomy codes (`TAX_POLITICAL_PARTY_REPUBLICAN`, `EPU_*`, `WB_*`) whose
 * readable labels are the same unlicensed third-party table problem as the
 * CAMEO leaf codes (`docs/PHASE1-DECISIONS.md` §14), and far noisier than the
 * entity fields. They are kept in the record so a future decision has them
 * without another parser change.
 *
 * @param {string} line One tab-separated GKG row.
 * @returns {?{url: string, persons: Array<string>, organizations: Array<string>,
 *   themes: Array<string>, tone: ?number}} Record, or null when unusable.
 */
export function parseGkgRow(line) {
  const text = String(line ?? '').replace(/\r$/, '');
  if (!text) return null;
  const fields = text.split('\t');
  // Rows shorter than the last column we read cannot be used. The count is not
  // required to be exactly GKG_COLUMN_COUNT: trailing empty fields are
  // routinely dropped, and rejecting on that would discard usable rows.
  if (fields.length <= GKG_COL.TONE) return null;
  const url = String(fields[GKG_COL.DOCUMENT_IDENTIFIER] ?? '').trim();
  if (!url) return null;

  const toneRaw = String(fields[GKG_COL.TONE] ?? '').split(',')[0].trim();
  const tone = toneRaw === '' ? null : Number(toneRaw);
  return {
    url,
    persons: splitGkgList(fields[GKG_COL.PERSONS]),
    organizations: splitGkgList(fields[GKG_COL.ORGANIZATIONS]),
    themes: splitGkgList(fields[GKG_COL.THEMES]),
    tone: Number.isFinite(tone) ? tone : null,
  };
}

/**
 * Build a URL-keyed entity map from a whole GKG file.
 *
 * `wantedUrls` is not an optimisation, it is the memory contract: a GKG slice
 * is ~5.3 MB and describes every article GDELT saw in that window, while a
 * slice's events reference only a few hundred of them. Retaining the rest
 * would hold megabytes per slice in the ring for nothing.
 *
 * @param {*} text Decoded GKG file contents.
 * @param {object} [options]
 * @param {?Set<string>} [options.wantedUrls=null] Restrict to these URLs.
 * @returns {{entities: Map<string, object>, rows: number, matched: number}} Result.
 */
export function parseGkgEntities(text, { wantedUrls = null } = {}) {
  const entities = new Map();
  let rows = 0;
  let matched = 0;
  for (const line of String(text ?? '').split('\n')) {
    if (!line.trim()) continue;
    rows += 1;
    const record = parseGkgRow(line);
    if (!record) continue;
    if (wantedUrls && !wantedUrls.has(record.url)) continue;
    matched += 1;
    // First row wins. GDELT can emit an article more than once within a window;
    // taking the first keeps the join deterministic.
    if (!entities.has(record.url)) entities.set(record.url, record);
  }
  return { entities, rows, matched };
}

/**
 * Whether a parsed GKG record carries anything worth rendering.
 * @param {?object} record Parsed record.
 * @returns {boolean} True when at least one person or organization is present.
 */
export function hasRenderableEntities(record) {
  return Boolean(record
    && ((record.persons && record.persons.length) || (record.organizations && record.organizations.length)));
}
