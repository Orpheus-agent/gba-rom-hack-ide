/**
 * Gen-3 tileset graphics fetcher - Phase UX-C.2.
 *
 * Given a parsed Tileset struct (or its tiles/palettes/metatiles
 * offsets), this module fetches + decodes the full graphics payload
 * needed to render the tileset's metatiles:
 *
 *   1. Tiles: follow `tilesOffset` → LZ77-decompress when `isCompressed`
 *      → decode each 32-byte block as one 8×8 4bpp tile → return
 *      `Uint8Array(64)[]` of palette-indexed tile pixels.
 *
 *   2. Palettes: follow `palettesOffset` → read 16 consecutive 32-byte
 *      palette blocks (16 palettes × 32 bytes each = 512 bytes total)
 *      → convert each to `Uint32Array(16)` RGBA via bgr555ToRgba.
 *
 *   3. Metatile attributes: follow `metatilesOffset` → read 16 bytes
 *      per metatile (4 layer-0 + 4 layer-1 u16 attributes) → decode each
 *      into 8 MetatileTileSpec entries.
 *
 * The result is a fully self-describing structure that the backend's
 * binary-rom-tileset route serializes (or renders to PNG via a separate
 * frontend helper). PD 13: every byte read here was already accounted
 * for by the existing engine substrate (LZ77 reader + tile-pixels module
 * from Phase C.1); this module just orchestrates them.
 *
 * Defensive: graceful degradation on truncation / decode failure (returns
 * partial result with `truncated: true` rather than throwing - caller
 * decides what to surface).
 */

import { readLz77 } from '../compression/index.js';
import {
  PALETTE_4BPP_SIZE_BYTES,
  TILE_4BPP_SIZE_BYTES,
  bgr555ToRgba,
  decode4bppTile,
  decodeMetatile,
  type MetatileTileSpec,
} from '../graphics/index.js';

/** Number of palettes in a Gen-3 tileset's palette block - 16 palettes
 *  × 32 bytes each = 512 bytes. (Vanilla uses 6 for primary + 6 for
 *  secondary, but the block always reserves 16 slots.) */
export const TILESET_PALETTES_PER_BLOCK = 16;

/** Bytes per single metatile in the metatiles table (4 layer-0 +
 *  4 layer-1 u16 attributes). */
export const METATILE_ATTRIBUTES_SIZE_BYTES = 16;

/** Maximum tiles per tileset before bailing (vanilla primary ~640, hacks
 *  up to ~1024; cap above gives slack). */
export const TILESET_MAX_TILES = 2048;

/** Maximum metatiles per tileset (vanilla primary ~512). */
export const TILESET_MAX_METATILES = 2048;

export interface TilesetGraphics {
  /** Decoded tile pixels, one Uint8Array(64) per tile. */
  readonly tiles: ReadonlyArray<Uint8Array>;
  /** 16 decoded palettes, each Uint32Array(16) of RGBA u32. */
  readonly palettes: ReadonlyArray<Uint32Array>;
  /** Per-metatile decoded layer-0 + layer-1 specs. */
  readonly metatiles: ReadonlyArray<{
    readonly layer0: ReadonlyArray<MetatileTileSpec>;
    readonly layer1: ReadonlyArray<MetatileTileSpec>;
  }>;
  /** True when one or more inputs decoded partially (e.g. LZ77 stream
   *  truncated, metatile attributes ran out of buffer). */
  readonly truncated: boolean;
  /** Bytes successfully decoded for the tile sheet (post-decompression). */
  readonly tileBytesDecoded: number;
  /** Metatile count actually decoded (≤ requested cap). */
  readonly metatileCount: number;
}

export interface FetchTilesetGraphicsOptions {
  /** Override metatile count to decode (default: walk until end of
   *  buffer or TILESET_MAX_METATILES, whichever first). */
  readonly maxMetatiles?: number;
  /** Override tile count to decode (default: walk all decompressed
   *  tile bytes / 32). */
  readonly maxTiles?: number;
}

export interface FetchTilesetGraphicsArgs {
  readonly rom: Uint8Array;
  /** Slot at Tileset+0x04. NULL → returns empty tiles array. */
  readonly tilesOffset: number | null;
  /** Slot at Tileset+0x08. NULL → returns empty palettes array. */
  readonly palettesOffset: number | null;
  /** Slot at Tileset+0x0C (FireRed) or Tileset+0x10 (Emerald varies).
   *  NULL → returns empty metatiles array. */
  readonly metatilesOffset: number | null;
  /** From Tileset+0x00 - drives LZ77 decompression of the tile bytes. */
  readonly isCompressed: boolean;
}

/**
 * Decode the tileset graphics referenced by the given offsets.
 *
 * On NULL tilesOffset: returns empty `tiles[]`. Same for palettes +
 * metatiles. This is correct for tileset slots that vary across forks
 * (e.g. FireRed callback fn at slot 0x10 vs Emerald metatileAttributes
 * - the caller decides which slot to pass as metatilesOffset).
 */
export function fetchTilesetGraphics(
  args: FetchTilesetGraphicsArgs,
  opts?: FetchTilesetGraphicsOptions,
): TilesetGraphics {
  const tiles: Uint8Array[] = [];
  const palettes: Uint32Array[] = [];
  const metatiles: TilesetGraphics['metatiles'][number][] = [];
  let truncated = false;
  let tileBytesDecoded = 0;

  // 1. Tiles.
  if (args.tilesOffset !== null && args.tilesOffset >= 0 && args.tilesOffset < args.rom.length) {
    let tileBytes: Uint8Array;
    if (args.isCompressed) {
      const lz = readLz77(args.rom, args.tilesOffset);
      if (lz.ok) {
        tileBytes = lz.decompressedBytes;
      } else {
        // LZ77 failure → empty tile sheet + flag truncated.
        truncated = true;
        tileBytes = new Uint8Array(0);
      }
    } else {
      // Uncompressed - read up to TILESET_MAX_TILES tiles' worth.
      const maxTileSheet = TILESET_MAX_TILES * TILE_4BPP_SIZE_BYTES;
      const end = Math.min(args.rom.length, args.tilesOffset + maxTileSheet);
      tileBytes = args.rom.subarray(args.tilesOffset, end);
    }
    tileBytesDecoded = tileBytes.length;
    const tileCap = opts?.maxTiles ?? TILESET_MAX_TILES;
    const tileCount = Math.min(
      Math.floor(tileBytes.length / TILE_4BPP_SIZE_BYTES),
      tileCap,
    );
    for (let i = 0; i < tileCount; i++) {
      try {
        tiles.push(decode4bppTile(tileBytes, i * TILE_4BPP_SIZE_BYTES));
      } catch {
        truncated = true;
        break;
      }
    }
  }

  // 2. Palettes. Always read 16 × 32 bytes = 512.
  if (
    args.palettesOffset !== null &&
    args.palettesOffset >= 0 &&
    args.palettesOffset + TILESET_PALETTES_PER_BLOCK * PALETTE_4BPP_SIZE_BYTES <= args.rom.length
  ) {
    for (let i = 0; i < TILESET_PALETTES_PER_BLOCK; i++) {
      const palStart = args.palettesOffset + i * PALETTE_4BPP_SIZE_BYTES;
      const palBytes = args.rom.subarray(palStart, palStart + PALETTE_4BPP_SIZE_BYTES);
      try {
        palettes.push(bgr555ToRgba(palBytes));
      } catch {
        truncated = true;
        // Push an empty palette so palettes[N] index alignment stays
        // intact for downstream lookups.
        palettes.push(new Uint32Array(16));
      }
    }
  } else if (
    args.palettesOffset !== null &&
    args.palettesOffset >= 0 &&
    args.palettesOffset < args.rom.length
  ) {
    // Partial palette block - read as many full 32-byte palettes as we
    // can before EOF; flag truncated.
    truncated = true;
    const available = args.rom.length - args.palettesOffset;
    const completePalettes = Math.floor(available / PALETTE_4BPP_SIZE_BYTES);
    for (let i = 0; i < completePalettes; i++) {
      const palStart = args.palettesOffset + i * PALETTE_4BPP_SIZE_BYTES;
      const palBytes = args.rom.subarray(palStart, palStart + PALETTE_4BPP_SIZE_BYTES);
      palettes.push(bgr555ToRgba(palBytes));
    }
    while (palettes.length < TILESET_PALETTES_PER_BLOCK) {
      palettes.push(new Uint32Array(16));
    }
  }

  // 3. Metatile attributes.
  if (
    args.metatilesOffset !== null &&
    args.metatilesOffset >= 0 &&
    args.metatilesOffset < args.rom.length
  ) {
    const metatileCap = opts?.maxMetatiles ?? TILESET_MAX_METATILES;
    const available = args.rom.length - args.metatilesOffset;
    const possible = Math.floor(available / METATILE_ATTRIBUTES_SIZE_BYTES);
    const count = Math.min(possible, metatileCap);
    for (let i = 0; i < count; i++) {
      try {
        metatiles.push(
          decodeMetatile(args.rom, args.metatilesOffset + i * METATILE_ATTRIBUTES_SIZE_BYTES),
        );
      } catch {
        truncated = true;
        break;
      }
    }
    if (count < possible) {
      // Hit the cap before EOF - not technically truncated since the
      // user requested this cap, but flag for honesty.
      // (Skipped - only flag truncation on genuine errors.)
    }
  }

  return {
    tiles: Object.freeze(tiles),
    palettes: Object.freeze(palettes),
    metatiles: Object.freeze(metatiles),
    truncated,
    tileBytesDecoded,
    metatileCount: metatiles.length,
  };
}
