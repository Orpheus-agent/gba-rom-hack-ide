/**
 * Phase 8A-1 - Tile-Intel Intermediate Representation (IR).
 *
 * The CANONICAL shape that crosses the Node ↔ Python boundary for the
 * tileset-intelligence subsystem. The Python sidecar NEVER parses
 * Gen-3 ROM bytes; instead, the Node-side `scripts/build-tile-intel-corpus.mjs`
 * uses the existing `@rom-introspection/engine` parsers
 * (`parseTileset`, `fetchTilesetGraphics`, `parseMetatileAttributes`,
 * `decodeMetatile`) to emit JSON in this shape. The sidecar consumes
 * only that JSON.
 *
 * This discipline is the difference between "tile-intel is a library
 * the editor uses" and "tile-intel is a parallel codebase that drifts
 * from the engine over time." A CI step compares the Zod schema's
 * JSON Schema export (`app/backend/src/tile-intel/ir-schema.ts`)
 * against the Pydantic-generated JSON Schema in the sidecar; drift
 * breaks CI.
 *
 * All multi-byte numeric fields that would otherwise be opaque are
 * carried as lowercase hex strings (`'4a2f00'`) rather than numbers,
 * so the IR is unambiguous when humans hand-inspect a corpus file
 * and so the JSON parsers on either side don't lose precision for
 * very large offsets.
 *
 * --- Scope (Phase 8) ---
 *  IR carries enough information for the sidecar to:
 *   • upsert tilesets / palettes / tiles / metatiles
 *   • derive metatile-attribute-driven tags (terrain, encounter, etc.)
 *   • compute adjacency rules from observed maps
 *   • compute style fingerprints (palette median-cut, content pHash)
 *  IR does NOT carry: rendered RGBA images (sidecar renders locally
 *  from `composition` + `palettes`), CLIP embeddings (sidecar
 *  computes), source-game scripts, or anything that isn't tileset/
 *  metatile/map-adjacency.
 */

/** The schema version of this IR. Bumped only on breaking changes.
 *  The sidecar's `/v1/ingest/json-corpus` endpoint rejects IRs whose
 *  major version it doesn't recognize. */
export const TILE_INTEL_IR_SCHEMA_VERSION = 1 as const;
export type TileIntelIRSchemaVersion = typeof TILE_INTEL_IR_SCHEMA_VERSION;

/** Where did this tileset come from? Used for both attribution + the
 *  global/project scope split - `pret` / `pret-emerald` / `cfru` /
 *  `dpe` are GLOBAL (everyone benefits from the same vanilla data);
 *  `essentials` / `community` / `user` are PROJECT or USER scope. */
export type TileIntelIRSource =
  | 'pret-firered'
  | 'pret-emerald'
  | 'cfru'
  | 'dpe'
  | 'essentials'
  | 'community'
  | 'user';

/** Either FRLG-style metatile attributes (4 bytes carrying behavior +
 *  terrain + encounter + layer) or RSE-style (2 bytes; no terrain or
 *  encounter). The sidecar uses `family` to decide how to parse
 *  `attrRawHex` AFTER ingest if it ever needs to re-derive - but the
 *  Node side has already done the parse and reflects the parsed
 *  fields directly. */
/**
 * Phase 8E extension - added `'essentials'` for Pokémon Essentials
 * stock tilesets (32-px tiles, palette extracted from indexed-mode
 * PNGs) and `'community'` for hand-picked community packs
 * (grid-inferred via Phase 8E-2). Both are atomic - their
 * metatiles carry an empty `composition` because they aren't
 * decomposable into a 4-tile gen-3 structure.
 */
export type TileIntelIRFamily = 'frlg' | 'rse' | 'essentials' | 'community';

/** Cardinal + diagonal directions, used for adjacency observations.
 *  N=0 numbering matches the existing `engine/src/scripts/encoder.ts`
 *  cardinal convention so the sidecar's enum mirrors the editor's. */
export type TileIntelIRDirection = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;
//                                  N=0 NE=1 E=2 SE=3 S=4 SW=5 W=6 NW=7

/** One tile composition slot inside a metatile. Mirrors the engine's
 *  `MetatileTileSpec` (engine/src/graphics/tile-pixels.ts) shape. */
export interface TileIntelIRMetatileSlot {
  /** Layer: 0 = under the player, 1 = over the player. */
  readonly layer: 0 | 1;
  /** Quadrant within the 2×2 metatile. 0=NW, 1=NE, 2=SW, 3=SE. */
  readonly quad: 0 | 1 | 2 | 3;
  /** Tile-table index this quadrant pulls from. 0..1023. */
  readonly tileIndex: number;
  /** Horizontal flip applied to the source tile before rendering. */
  readonly hflip: boolean;
  /** Vertical flip applied to the source tile before rendering. */
  readonly vflip: boolean;
  /** Palette block (0..15) this quadrant uses. */
  readonly paletteIndex: number;
}

/** One metatile in a tileset. The sidecar's `metatiles` Postgres
 *  rows are 1:1 with this shape (renormalized into columns). */
export interface TileIntelIRMetatile {
  /** 0..1023 within the parent tileset. Stable across re-runs of the
   *  corpus builder for the same source-tree commit. */
  readonly metatileIndex: number;
  /** Lowercase hex of the raw attribute bytes (4 hex pairs for FRLG,
   *  2 for RSE). Carried so the sidecar can re-derive parsed fields
   *  on schema bumps without going back to the source. */
  readonly attrRawHex: string;
  /** Parsed metatile-behavior enum (0..511 for FRLG, 0..255 for RSE). */
  readonly behaviorId: number;
  /** Parsed terrain-type byte (0..31, FRLG only; 0 on RSE). */
  readonly terrainType: number;
  /** Parsed encounter-type byte (0..7, FRLG only; 0 on RSE). */
  readonly encounterType: number;
  /** Parsed layer-type byte (0..3). */
  readonly layerType: number;
  /** 8 slots - layer 0 quads (NW/NE/SW/SE) then layer 1 quads. The
   *  order is canonical (sidecar relies on it for diffing). */
  readonly composition: ReadonlyArray<TileIntelIRMetatileSlot>;
  /** sha256 hex of the rendered 16×16 RGBA frame, computed by the
   *  Node side after composing the metatile with its palettes. Used
   *  for visual dedup + as a cache key in Qdrant payloads. */
  readonly renderedHashHex: string;
  /** 64-bit perceptual hash (8 hex chars) of the rendered metatile.
   *  Cheap fuzzy-match without a vector DB. */
  readonly phashHex: string;
}

/** One 8×8 tile in a tileset's tile-table. */
export interface TileIntelIRTile {
  /** 0..1023 within the parent tileset. */
  readonly tileIndex: number;
  /** Lowercase hex of the 64-byte palette-indexed pixel buffer.
   *  Hex (not base64) keeps the corpus human-readable. */
  readonly pixelBytesHex: string;
  /** sha256 hex of `pixelBytesHex` - content hash. */
  readonly pixelHashHex: string;
  /** sha256 hex AFTER normalising palette indices (so the same
   *  graphic under different palettes deduplicates). */
  readonly paletteNeutralHashHex: string;
  /** 64-bit perceptual hash (8 hex chars). */
  readonly phashHex: string;
  /** True when every pixel is the transparent index 0. */
  readonly isBlank: boolean;
  /** True when the tile is mirror-symmetric horizontally (used by
   *  the structural-tag heuristics in Phase 8C-2). */
  readonly isHorizontallySymmetric: boolean;
  /** True when the tile is mirror-symmetric vertically. */
  readonly isVerticallySymmetric: boolean;
}

/** One palette block. 16 colors, BGR555 encoded (2 bytes per color =
 *  32 bytes total). */
export interface TileIntelIRPalette {
  /** 0..15 within the parent tileset. */
  readonly paletteIndex: number;
  /** Lowercase hex of the raw 32-byte BGR555 buffer. */
  readonly bgr555Hex: string;
  /** Top-5 dominant colors as `#rrggbb` (median-cut centroids). Used
   *  for style-similarity fingerprinting. */
  readonly medianCut5: ReadonlyArray<string>;
  /** Dominant hue in [0, 360) HSV degrees, or null when the palette
   *  is grayscale (max saturation < 0.05). */
  readonly dominantHue: number | null;
  /** Average luminance in [0, 255] across all 16 colors. */
  readonly luminanceAvg: number;
}

/** A complete tileset record. */
export interface TileIntelIRTileset {
  /** Stable slug used as the cross-language primary key. Pattern:
   *  `<source>-<family>-<is-secondary><readable-name>`, e.g.
   *  `pret-frlg-primary-pallet` or `cfru-frlg-secondary-mt-ember`. */
  readonly slug: string;
  /** Human-readable display name, surfaced in the frontend library. */
  readonly displayName: string;
  /** Where this tileset came from. */
  readonly source: TileIntelIRSource;
  /** When `source` references a git repo (pret*, cfru, dpe), the
   *  commit SHA the corpus builder resolved at scrape time. */
  readonly sourceCommit: string | null;
  /** Free-form attribution string. Always carried; "Public domain
   *  via pret/pokefirered (MIT)" for vanilla, hand-authored for
   *  curated community packs. */
  readonly attribution: string;
  /** SPDX license identifier when known; `'unknown'` otherwise. */
  readonly licenseSpdx: string;
  /** Gen-3 family this tileset's attribute layout follows. */
  readonly family: TileIntelIRFamily;
  /** True for secondary tilesets (map-specific). False for primaries
   *  (shared across many maps). */
  readonly isSecondary: boolean;
  /** True when the tile data was LZ77-compressed in ROM. The corpus
   *  builder has already decompressed it; the field is preserved for
   *  attribution + downstream tools that care. */
  readonly isCompressed: boolean;
  /** Length of `tiles` - denormalized for query convenience. */
  readonly tileCount: number;
  /** Length of `metatiles` - denormalized. */
  readonly metatileCount: number;
  /** The 16 palette blocks. */
  readonly palettes: ReadonlyArray<TileIntelIRPalette>;
  /** The tile-table. */
  readonly tiles: ReadonlyArray<TileIntelIRTile>;
  /** The metatile composition table. */
  readonly metatiles: ReadonlyArray<TileIntelIRMetatile>;
}

/** One co-occurrence observation between two metatiles, in a specific
 *  direction, on a specific map. Aggregated by the sidecar into
 *  `adjacency_observations` rows keyed by
 *  `(metatile_a, metatile_b, direction, source_corpus)`. */
export interface TileIntelIRAdjacencyObservation {
  /** Tileset slug of metatile A. (a, b) tiles may belong to different
   *  tilesets when a map uses primary + secondary. */
  readonly tilesetSlugA: string;
  /** Metatile index of A (0..1023). */
  readonly metatileIndexA: number;
  /** Tileset slug of metatile B. */
  readonly tilesetSlugB: string;
  /** Metatile index of B (0..1023). */
  readonly metatileIndexB: number;
  /** Direction FROM A TO B. N=0, NE=1, …, NW=7. */
  readonly direction: TileIntelIRDirection;
  /** Number of times this (a, b, direction) was observed on this map.
   *  Aggregated server-side across maps in the same corpus. */
  readonly frequency: number;
}

/** A single 3×3 (or other shape) multi-cell pattern observed in a
 *  map. Cells are listed in row-major order (NW to SE, NW→NE→...
 *  along each row). Phase 8C-4 uses this for L-shape / transition /
 *  corner detection that pairwise adjacency rules can't capture. */
export interface TileIntelIRPatternCell {
  readonly tilesetSlug: string;
  readonly metatileIndex: number;
}

export interface TileIntelIRPattern {
  /** Pattern dimensions. Phase 8C-4 only emits `'3x3'`; future
   *  phases may emit `'2x2'`, `'L-NE'`, etc. */
  readonly shape: '3x3';
  /** Width and height in cells. For '3x3' both are 3. */
  readonly width: number;
  readonly height: number;
  /** Cells in row-major order; length = width × height. */
  readonly cells: ReadonlyArray<TileIntelIRPatternCell>;
  /** How many times this exact pattern appears on the source map. */
  readonly frequency: number;
}

/** One map's adjacency observations. The sidecar uses this to attribute
 *  the rule corpus by source (vanilla pret vs. user project). */
export interface TileIntelIRMapAdjacency {
  /** Stable map slug, e.g. `pret-frlg-route-1`. */
  readonly mapSlug: string;
  /** Primary tileset slug (always present for a Gen-3 map). */
  readonly primaryTilesetSlug: string;
  /** Secondary tileset slug (always present for a Gen-3 map). */
  readonly secondaryTilesetSlug: string;
  /** Map width in metatiles. */
  readonly width: number;
  /** Map height in metatiles. */
  readonly height: number;
  /** All observed co-occurrences on this map. The corpus builder
   *  aggregates within-map so each (a, b, direction) tuple appears
   *  at most once with `frequency` carrying the count. */
  readonly observations: ReadonlyArray<TileIntelIRAdjacencyObservation>;
  /** Multi-cell patterns mined from this map (Phase 8C-4). Optional
   * - older corpora emitted before 8C-4 don't carry this field. */
  readonly patterns?: ReadonlyArray<TileIntelIRPattern>;
}

/** A complete corpus emitted by `scripts/build-tile-intel-corpus.mjs`.
 *  The file at `app/backend/src/assets/tile-intel-corpus/<source>.json`
 *  has this top-level shape. */
export interface TileIntelIRCorpus {
  /** IR schema version. Always equal to `TILE_INTEL_IR_SCHEMA_VERSION`. */
  readonly schemaVersion: TileIntelIRSchemaVersion;
  /** ISO 8601 UTC timestamp of when the corpus was generated. */
  readonly generatedAtUtc: string;
  /** Source this corpus is keyed by - one corpus file per source so
   *  vanilla updates don't churn community-pack files. */
  readonly source: TileIntelIRSource;
  /** Tooling version for traceability ("8A-1"). Free-form. */
  readonly toolingVersion: string;
  /** All tilesets harvested from this source. */
  readonly tilesets: ReadonlyArray<TileIntelIRTileset>;
  /** All map adjacency observations harvested from this source.
   *  Empty when the source doesn't ship maps (e.g. a community
   *  tileset pack without accompanying map data). */
  readonly mapAdjacencies: ReadonlyArray<TileIntelIRMapAdjacency>;
}
