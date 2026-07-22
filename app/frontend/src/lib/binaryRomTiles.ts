/**
 * Phase UX-C.4 + iter 112 + Phase F (semantic-world plan §1.2)
 * frontend helper for composing binary-ROM tile pixels with
 * PER-METATILE-TILE PALETTE RESOLUTION.
 *
 * The Gen-3 4bpp metatile system stores each composing tile with its
 * own paletteIndex (4 bits of the metatile attribute). Different tiles
 * within the SAME metatile can use DIFFERENT palettes - that's how
 * vanilla houses get magenta roofs while the surrounding grass uses
 * the green palette, etc.
 *
 * The original Phase C.3+C.4 shipped a palette-0-prebaked tile sheet
 * (one RGBA byte sequence regardless of metatile spec). That worked
 * for tiles that happened to use palette 0, but tiles assigned
 * palettes 1-15 rendered with palette 0's colors → many came out as
 * BLACK (when palette 0's matching index is empty/transparent) - the
 * operator screenshot's "most of the tiles are just black" complaint.
 *
 * Fix iter 112: backend serves the tile sheet as RAW palette indices
 * + 16 decoded palettes; we look up the matching palette by
 * spec.paletteIndex and apply per-pixel - correct RGBA per tile.
 *
 * Phase F fix (semantic-world plan §1.2): the original fetch loaded
 * only the PRIMARY tileset. Gen-3 maps composite primary + secondary,
 * and metatiles in the secondary range used random/garbage palettes
 * because the primary's response only carried 7 (FRLG) or 6 (RSE)
 * valid palette slots - the rest of its 16-slot return are bytes that
 * happen to follow the palette block in ROM. With the secondary
 * fetched separately and the two merged at the fixed boundaries below,
 * secondary metatiles render with their actual palettes and tiles.
 */

import type {
  BinaryRomMapDataResponseLike,
  BinaryRomTilesetResponseLike,
  MetatileSpecRaw,
} from '../api';

const PIXELS_PER_TILE = 64;
const TILE_WIDTH = 8;
const PIXELS_PER_METATILE = 256;
const METATILE_WIDTH = 16;

/** Gen-3 family-specific primary/secondary tileset boundaries. */
export interface TilesetBoundaries {
  /** Palette slots 0..numPalsInPrimary-1 come from the primary tileset;
   *  slots numPalsInPrimary..15 come from the secondary tileset. */
  readonly numPalsInPrimary: number;
  /** Tile indices 0..numTilesInPrimary-1 come from the primary tileset;
   *  indices ≥ numTilesInPrimary come from the secondary tileset
   *  (shifted by -numTilesInPrimary into the secondary's tile sheet). */
  readonly numTilesInPrimary: number;
  /** Metatile IDs 0..numMetatilesInPrimary-1 come from the primary
   *  tileset's metatileSpecs; IDs ≥ numMetatilesInPrimary come from
   *  the secondary's metatileSpecs (shifted by -numMetatilesInPrimary). */
  readonly numMetatilesInPrimary: number;
}

/** FireRed / LeafGreen (BPRE / BPGE). Source: pokefirered
 *  include/global.fieldmap.h. */
export const TILESET_BOUNDARIES_FRLG: TilesetBoundaries = Object.freeze({
  numPalsInPrimary: 7,
  numTilesInPrimary: 640,
  numMetatilesInPrimary: 640,
});

/** Ruby / Sapphire / Emerald (AXVE / AXPE / BPEE). Source:
 *  pokeemerald include/global.fieldmap.h. */
export const TILESET_BOUNDARIES_RSE: TilesetBoundaries = Object.freeze({
  numPalsInPrimary: 6,
  numTilesInPrimary: 512,
  numMetatilesInPrimary: 512,
});

/** Pick boundaries from a 4-byte GBA game code. Falls back to FRLG
 *  when the code is unknown - vanilla FRLG hacks dominate the corpus. */
export function tilesetBoundariesForGameCode(
  gameCode: string | null,
): TilesetBoundaries {
  if (gameCode === null) return TILESET_BOUNDARIES_FRLG;
  switch (gameCode) {
    case 'BPRE':
    case 'BPGE':
      return TILESET_BOUNDARIES_FRLG;
    case 'AXVE':
    case 'AXPE':
    case 'BPEE':
      return TILESET_BOUNDARIES_RSE;
    default:
      return TILESET_BOUNDARIES_FRLG;
  }
}

/** The Real Game Editor Push - auto-detect primary/secondary tileset
 *  boundaries from the actual primary-tileset response instead of
 *  hardcoded FRLG/RSE defaults. CFRU and Unbound relocate these
 *  boundaries (Unbound's primary often carries more metatiles than
 *  vanilla FRLG's 640) and the hardcoded values caused metatiles in
 *  the secondary range to either render with wrong tiles (boundary
 *  off-by-N) or as missing/black cells.
 *
 *  The backend response carries the actual tile/metatile counts of THIS tileset.
 *  Palette counts are not authoritative yet because the backend returns
 *  a full 16-slot palette block for every tileset. Detection priority:
 *
 *    1. Use primary tile/metatile counts when present and plausible
 *    2. Use game-code palette defaults (FRLG / RSE)
 *
 *  Plausibility check: a primary tileset realistically has 1..1024
 *  metatiles and 1..1024 tiles. Anything outside
 *  those bounds is treated as a likely garbage / unparseable response
 *  and falls back to game-code defaults.
 */
export function tilesetBoundariesForRom(
  primary: BinaryRomTilesetResponseLike | null,
  gameCode: string | null,
): TilesetBoundaries {
  const fallback = tilesetBoundariesForGameCode(gameCode);
  if (primary === null) return fallback;
  const numTilesInPrimary = primary.tileCount;
  const numMetatilesInPrimary = primary.metatileSpecs.length;
  if (
    numTilesInPrimary >= 1 &&
    numTilesInPrimary <= 1024 &&
    numMetatilesInPrimary >= 1 &&
    numMetatilesInPrimary <= 1024
  ) {
    return {
      numPalsInPrimary: fallback.numPalsInPrimary,
      numTilesInPrimary,
      numMetatilesInPrimary,
    };
  }
  return fallback;
}

/** Decode the base64 raw-indices tile sheet → array of Uint8Array(64)
 *  palette-index arrays, one per tile. Falls back to deriving indices
 *  from the legacy RGBA-pre-baked sheet (with palette 0) when the
 *  backend hasn't been updated to serve tileSheetIndices yet - old
 *  cached responses don't break. */
function decodeTileSheetIndices(
  tileset: BinaryRomTilesetResponseLike,
): Uint8Array[] {
  // Preferred path: raw palette indices, 64 bytes per tile.
  if (tileset.tileSheetIndices) {
    const binary = atob(tileset.tileSheetIndices);
    const buf = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) buf[i] = binary.charCodeAt(i);
    const tiles: Uint8Array[] = [];
    for (let i = 0; i < tileset.tileCount; i++) {
      const start = i * PIXELS_PER_TILE;
      tiles.push(buf.subarray(start, start + PIXELS_PER_TILE));
    }
    return tiles;
  }
  // Legacy fallback: derive indices from the RGBA sheet by matching
  // each pixel against palette 0. Imperfect - only works when palette
  // 0 has distinct colors per index - but keeps stale-cache responses
  // rendering rather than crashing.
  const binary = atob(tileset.tileSheetRgba);
  const buf = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) buf[i] = binary.charCodeAt(i);
  const palette0 = tileset.palettes[0] ?? [];
  const tiles: Uint8Array[] = [];
  for (let i = 0; i < tileset.tileCount; i++) {
    const indices = new Uint8Array(PIXELS_PER_TILE);
    for (let p = 0; p < PIXELS_PER_TILE; p++) {
      const off = (i * PIXELS_PER_TILE + p) * 4;
      const a = buf[off + 3] ?? 0;
      if (a === 0) {
        indices[p] = 0;
        continue;
      }
      // Pack RGBA back to u32 + scan palette 0 for a match. O(16) per
      // pixel but only used in the legacy path.
      const r = buf[off] ?? 0;
      const g = buf[off + 1] ?? 0;
      const b = buf[off + 2] ?? 0;
      const rgba = (a << 24) | (b << 16) | (g << 8) | r;
      let found = 0;
      for (let pi = 1; pi < palette0.length; pi++) {
        if (palette0[pi] === rgba) {
          found = pi;
          break;
        }
      }
      indices[p] = found;
    }
    tiles.push(indices);
  }
  return tiles;
}

/** Apply hflip + vflip to a 64-byte palette-index tile. Returns a
 *  fresh Uint8Array; identity case returns the input unchanged. */
function flipTileIndices(
  tile: Uint8Array,
  hflip: boolean,
  vflip: boolean,
): Uint8Array {
  if (!hflip && !vflip) return tile;
  const out = new Uint8Array(PIXELS_PER_TILE);
  for (let y = 0; y < TILE_WIDTH; y++) {
    const srcY = vflip ? TILE_WIDTH - 1 - y : y;
    for (let x = 0; x < TILE_WIDTH; x++) {
      const srcX = hflip ? TILE_WIDTH - 1 - x : x;
      out[y * TILE_WIDTH + x] = tile[srcY * TILE_WIDTH + srcX]!;
    }
  }
  return out;
}

/** Compose one 16×16 metatile from layer0 + layer1 specs + the
 *  pre-decoded tile palette-index sheet + the per-metatile palette
 *  set. Returns a Uint32Array(256) of RGBA u32 values in row-major
 *  order (matches mapEditorScene's metatilePixels expectation).
 *
 *  Per-pixel palette application:
 *    For each layer's 4 tile quadrants, look up the spec's
 *    paletteIndex'th palette in the palettes array, then apply that
 *    palette to each pixel of the (flipped) tile's indices. Layer 0
 *    is opaque (every pixel rendered, even index 0); layer 1 respects
 *    transparency (index 0 = let layer 0 show through).
 *
 *  Out-of-range tileIndex / paletteIndex → transparent pixels (defensive). */
function composeMetatilePixels(
  layer0: ReadonlyArray<MetatileSpecRaw>,
  layer1: ReadonlyArray<MetatileSpecRaw>,
  tileIndices: Uint8Array[],
  palettes: ReadonlyArray<ReadonlyArray<number>>,
): Uint32Array {
  const out = new Uint32Array(PIXELS_PER_METATILE);
  const outU8 = new Uint8ClampedArray(out.buffer);

  function blitTile(
    spec: MetatileSpecRaw,
    quadrant: number,
    respectTransparency: boolean,
  ): void {
    const tile = tileIndices[spec.tileIndex];
    if (!tile) return;
    const palette = palettes[spec.paletteIndex];
    if (!palette) return;
    const flipped = flipTileIndices(tile, spec.hflip, spec.vflip);
    const dx = (quadrant % 2) * TILE_WIDTH;
    const dy = Math.floor(quadrant / 2) * TILE_WIDTH;
    for (let py = 0; py < TILE_WIDTH; py++) {
      for (let px = 0; px < TILE_WIDTH; px++) {
        const palIdx = flipped[py * TILE_WIDTH + px]!;
        if (palIdx === 0 && respectTransparency) continue;
        // Palette entry is a u32 from the backend bgr555ToRgba pipeline.
        // For layer 0's index-0 pixels: render the palette's actual
        // index-0 color (which bgr555ToRgba already zeroed) so layer
        // 0 ground tiles render as transparent at index-0 pixels - 
        // matches pret behavior where the GBA BG color shows through.
        // For non-transparent pixels: apply the palette entry as RGBA.
        const rgba = palette[palIdx] ?? 0;
        const dstOff = ((dy + py) * METATILE_WIDTH + (dx + px)) * 4;
        // Layer 0 paints even palette-index-0 pixels (BG color), but
        // since bgr555ToRgba returns 0 for index 0, those pixels stay
        // transparent - that's the GBA BG color slot. To match what
        // operators expect (solid ground tiles), promote layer-0
        // index-0 to opaque using palette[0]'s underlying color. We
        // don't have that color (backend transmits it as 0); so for
        // layer 0 index 0 paint a dim charcoal so the ground reads
        // as something rather than punching through to canvas black.
        if (palIdx === 0 && !respectTransparency) {
          outU8[dstOff] = 32;
          outU8[dstOff + 1] = 32;
          outU8[dstOff + 2] = 32;
          outU8[dstOff + 3] = 0xff;
          continue;
        }
        outU8[dstOff] = rgba & 0xff;
        outU8[dstOff + 1] = (rgba >> 8) & 0xff;
        outU8[dstOff + 2] = (rgba >> 16) & 0xff;
        outU8[dstOff + 3] = (rgba >> 24) & 0xff;
      }
    }
  }

  // Layer 0 - opaque fill.
  for (let q = 0; q < 4; q++) blitTile(layer0[q]!, q, false);
  // Layer 1 - transparent composite.
  for (let q = 0; q < 4; q++) blitTile(layer1[q]!, q, true);

  return out;
}

/**
 * Top-level entrypoint: given the tileset + map-data responses, returns
 * a Map<metatileId, Uint32Array(256)> of composed pixel data ready to
 * hand to mapEditorScene.options.metatilePixels.
 *
 * Only metatiles referenced by the map's cells are composed (skips
 * unused entries to save work on large tilesets).
 *
 * SINGLE-TILESET MODE - composeBinaryRomMetatilePixels:
 *   Used when only the primary tileset response is available (legacy
 *   path or maps that don't carry a secondary). All metatile IDs are
 *   looked up in `tileset.metatileSpecs` directly; palettes 7-15 (FRLG)
 *   or 6-15 (RSE) carry whatever bytes happen to follow the primary's
 *   palette block in ROM - usually garbage, so metatiles assigned
 *   those palette indices render in wrong colors. Use the dual variant
 *   below for correctness on real maps.
 */
export function composeBinaryRomMetatilePixels(
  tileset: BinaryRomTilesetResponseLike,
  mapData: BinaryRomMapDataResponseLike,
): Map<number, Uint32Array> {
  const tileIndices = decodeTileSheetIndices(tileset);
  const usedIds = new Set<number>();
  for (const cell of mapData.cells) usedIds.add(cell.metatileId);
  const out = new Map<number, Uint32Array>();
  for (const id of usedIds) {
    const spec = tileset.metatileSpecs[id];
    if (!spec) continue;
    out.set(id, composeMetatilePixels(spec.layer0, spec.layer1, tileIndices, tileset.palettes));
  }
  return out;
}

/**
 * DUAL-TILESET MODE - Phase F (semantic-world plan §1.2).
 *
 * Composes metatile pixels from a primary + secondary tileset pair,
 * merging at the Gen-3 family-specific boundaries:
 *   - palettes: primary[0..N-1] ⊕ secondary[N..15]   where N = numPalsInPrimary
 *   - tiles:    primary[0..T-1] ⊕ secondary[0..]      shifted to [T..1023]
 *               where T = numTilesInPrimary
 *   - metatiles: primary[0..M-1] ⊕ secondary[0..]     shifted to [M..1023]
 *               where M = numMetatilesInPrimary
 *
 * Without this merge, metatiles whose IDs are ≥ numMetatilesInPrimary
 * have no spec (silently skipped → blank), and metatiles in the primary
 * range that reference palette indices ≥ numPalsInPrimary render with
 * the wrong colors (palette block garbage that follows the primary's
 * actual palettes in ROM).
 */
export function composeBinaryRomMetatilePixelsDual(
  primary: BinaryRomTilesetResponseLike,
  secondary: BinaryRomTilesetResponseLike | null,
  mapData: BinaryRomMapDataResponseLike,
  boundaries: TilesetBoundaries,
): Map<number, Uint32Array> {
  // Single-tileset fallback when the map has no secondary or the fetch
  // failed - keep partial rendering working.
  if (secondary === null) {
    return composeBinaryRomMetatilePixels(primary, mapData);
  }

  const primaryTiles = decodeTileSheetIndices(primary);
  const secondaryTiles = decodeTileSheetIndices(secondary);

  // Unified tile sheet: indices < numTilesInPrimary → primary, ≥ → secondary.
  const mergedTiles: Uint8Array[] = new Array(
    boundaries.numTilesInPrimary + secondaryTiles.length,
  );
  for (let i = 0; i < boundaries.numTilesInPrimary; i++) {
    mergedTiles[i] = primaryTiles[i] ?? new Uint8Array(PIXELS_PER_TILE);
  }
  for (let i = 0; i < secondaryTiles.length; i++) {
    mergedTiles[boundaries.numTilesInPrimary + i] = secondaryTiles[i]!;
  }

  // Unified palettes: slots < numPalsInPrimary → primary[i],
  // slots ≥ numPalsInPrimary → secondary[i - numPalsInPrimary].
  //
  // Phase G-RC1 fix (semantic-world plan §G.1): each tileset's palettes
  // array in the API response is indexed FROM 0 in that tileset's OWN
  // ROM palette block. The secondary tileset's palette block contains
  // ~6 palettes for runtime slots numPalsInPrimary..15, starting at
  // index 0 of the response - not at index 7. Reading secondary[7]
  // directly was returning post-block garbage, which composeMetatile
  // then treated as transparent/null → metatiles rendered solid black.
  const mergedPalettes: ReadonlyArray<number>[] = new Array(16);
  for (let i = 0; i < 16; i++) {
    if (i < boundaries.numPalsInPrimary) {
      mergedPalettes[i] = primary.palettes[i] ?? [];
    } else {
      mergedPalettes[i] = secondary.palettes[i - boundaries.numPalsInPrimary] ?? [];
    }
  }

  // Per-cell metatile lookup table that picks the right tileset's spec.
  const usedIds = new Set<number>();
  for (const cell of mapData.cells) usedIds.add(cell.metatileId);
  const out = new Map<number, Uint32Array>();
  for (const id of usedIds) {
    const spec =
      id < boundaries.numMetatilesInPrimary
        ? primary.metatileSpecs[id]
        : secondary.metatileSpecs[id - boundaries.numMetatilesInPrimary];
    if (!spec) continue;
    out.set(
      id,
      composeMetatilePixels(spec.layer0, spec.layer1, mergedTiles, mergedPalettes),
    );
  }
  return out;
}

/** Phase T.1 - diagnostic for "why is this tile rendering black?". After
 *  composeBinaryRomMetatilePixels(Dual) returns, any metatile id used by
 *  the map but absent from the pixels map renders as a black/blank
 *  cell. Tracking those ids surfaces broken composition - usually a
 *  secondary tileset boundary mismatch (CFRU relocates the boundary;
 *  Unbound runs custom layouts) or a metatile spec the lifter couldn't
 *  decode (unknown layer mode bits).
 *
 *  Returns the set of (used but missing) metatile ids in ascending
 *  order so callers can deduplicate, count, or surface them in a
 *  diagnostic overlay. Order is stable for snapshot tests.
 */
export function computeMissingMetatiles(
  pixels: ReadonlyMap<number, Uint32Array>,
  mapData: BinaryRomMapDataResponseLike,
): ReadonlyArray<number> {
  const missing = new Set<number>();
  for (const cell of mapData.cells) {
    if (!pixels.has(cell.metatileId)) missing.add(cell.metatileId);
  }
  return Array.from(missing).sort((a, b) => a - b);
}
