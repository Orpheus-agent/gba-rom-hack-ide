/**
 * Shared sprite/tileset import helpers (Phase 3.13-3.17 internals).
 *
 * The asset-import tools share a common pipeline:
 *
 *   PNG bytes
 *     → decodePng()                  // RGBA pixels
 *     → quantizeRgbaToIndexed()      // 16-color palette + indexed pixels
 *     → pixelGridToTiles()           // row-major 8×8 tiles
 *     → encode4bppTileSheet()        // 32 bytes/tile, contiguous
 *     → (optional) encodeLz77()      // GBA LZ77-compressed
 *     → free-space allocator + binary_write_bytes edits
 *
 * Plus the "clone" mode that copies an existing in-ROM sprite's
 * tile + palette bytes into fresh space (with optional recolor).
 *
 * This module exposes the prepared-bytes pipeline; the per-tool
 * files at propose-import-tileset.ts / propose-import-overworld-
 * sprite.ts / etc. wire the prepared bytes into the appropriate
 * pointer tables.
 */

import { promises as fsp } from 'node:fs';
import path from 'node:path';
import {
  compression as compressionApi,
  graphics as graphicsApi,
} from '@rom-introspection/engine';

export interface PreparedSpriteBytes {
  /** 32-byte BGR555 palette (16 colors). */
  readonly palette: Uint8Array;
  /** Tile-sheet bytes (tile-count × 32) - uncompressed. */
  readonly tilesUncompressed: Uint8Array;
  /** LZ77-compressed tile bytes (only if requested). */
  readonly tilesCompressed: Uint8Array | null;
  /** Number of 8×8 tiles. */
  readonly tileCount: number;
  /** Source PNG dimensions in pixels. */
  readonly widthPx: number;
  readonly heightPx: number;
}

export class SpriteImportError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(`SpriteImportError[${code}]: ${message}`);
    this.name = 'SpriteImportError';
    this.code = code;
  }
}

/** Resolve an asset path. Paths starting with `/` or `<letter>:` are
 *  treated as absolute; everything else is resolved against
 *  `<projectRoot>/.editor/assets/`. */
export function resolveAssetPath(projectRoot: string, supplied: string): string {
  if (path.isAbsolute(supplied)) return supplied;
  return path.join(projectRoot, '.editor', 'assets', supplied);
}

/**
 * Run the full PNG → 4bpp → (optional LZ77) pipeline. Throws
 * SpriteImportError with a structured code on any failure.
 */
export async function prepareSpriteFromPng(opts: {
  readonly projectRoot: string;
  readonly pngPath: string;
  readonly compress: boolean;
  /** Expected width × height in pixels. When supplied, the tool
   *  errors if the PNG doesn't match. Pass null to accept whatever
   *  size the PNG is. */
  readonly expectedSize?: { widthPx: number; heightPx: number } | null;
}): Promise<PreparedSpriteBytes> {
  const absolutePath = resolveAssetPath(opts.projectRoot, opts.pngPath);
  let pngBytes: Buffer;
  try {
    pngBytes = await fsp.readFile(absolutePath);
  } catch {
    throw new SpriteImportError(
      'png_missing',
      `Couldn\'t read PNG at ${absolutePath}. Drop the asset at <projectRoot>/.editor/assets/${path.basename(opts.pngPath)} and rerun.`,
    );
  }
  const decoded = graphicsApi.decodePng(new Uint8Array(pngBytes));
  if (opts.expectedSize) {
    if (decoded.width !== opts.expectedSize.widthPx || decoded.height !== opts.expectedSize.heightPx) {
      throw new SpriteImportError(
        'wrong_size',
        `Expected ${String(opts.expectedSize.widthPx)}×${String(opts.expectedSize.heightPx)} PNG; got ${String(decoded.width)}×${String(decoded.height)}.`,
      );
    }
  }
  if (decoded.width % 8 !== 0 || decoded.height % 8 !== 0) {
    throw new SpriteImportError(
      'bad_dimensions',
      `PNG dimensions must be multiples of 8; got ${String(decoded.width)}×${String(decoded.height)}.`,
    );
  }
  const { palette, indexed } = graphicsApi.quantizeRgbaToIndexed(
    decoded.pixels,
    decoded.width,
    decoded.height,
  );
  const tiles = graphicsApi.pixelGridToTiles(indexed, decoded.width, decoded.height);
  const tilesUncompressed = graphicsApi.encode4bppTileSheet(tiles);
  const tilesCompressed = opts.compress
    ? compressionApi.encodeLz77(tilesUncompressed)
    : null;
  return Object.freeze({
    palette,
    tilesUncompressed,
    tilesCompressed,
    tileCount: tiles.length,
    widthPx: decoded.width,
    heightPx: decoded.height,
  });
}

/** Clone mode: read an existing sprite's tile + palette bytes from
 *  ROM (caller provides offsets + sizes) and return them unchanged
 *  or with a recolor applied to the palette. */
export interface CloneSpriteOpts {
  readonly romBytes: Uint8Array;
  readonly sourceTilesOffset: number;
  readonly sourcePaletteOffset: number;
  readonly tileCount: number;
  /** When true, the source tiles are LZ77-compressed; we decompress
   *  on read + re-compress if compress=true on the output. */
  readonly sourceCompressed: boolean;
  readonly compress: boolean;
  /** Optional recolor: maps source BGR555 u16 → new BGR555 u16. Set
   *  any slot you want to override; unset slots are copied. */
  readonly recolorMap?: ReadonlyMap<number, number>;
}

export function prepareSpriteFromClone(opts: CloneSpriteOpts): PreparedSpriteBytes {
  // Palette: copy 32 bytes; apply recolor map.
  const palette = new Uint8Array(32);
  for (let i = 0; i < 32; i++) palette[i] = opts.romBytes[opts.sourcePaletteOffset + i]!;
  if (opts.recolorMap && opts.recolorMap.size > 0) {
    for (let slot = 0; slot < 16; slot++) {
      const u16 = palette[slot * 2]! | (palette[slot * 2 + 1]! << 8);
      const replacement = opts.recolorMap.get(u16);
      if (replacement !== undefined) {
        palette[slot * 2 + 0] = replacement & 0xff;
        palette[slot * 2 + 1] = (replacement >>> 8) & 0xff;
      }
    }
  }
  // Tiles: read uncompressed or decompress + re-pack.
  let tilesUncompressed: Uint8Array;
  if (opts.sourceCompressed) {
    const r = compressionApi.readLz77(opts.romBytes, opts.sourceTilesOffset);
    if (!r.ok) throw new SpriteImportError('clone_decompress_failed', `failed to decompress source tiles: ${JSON.stringify(r.failure)}`);
    tilesUncompressed = new Uint8Array(r.decompressedBytes);
  } else {
    const size = opts.tileCount * 32;
    tilesUncompressed = new Uint8Array(size);
    for (let i = 0; i < size; i++) tilesUncompressed[i] = opts.romBytes[opts.sourceTilesOffset + i]!;
  }
  const tilesCompressed = opts.compress
    ? compressionApi.encodeLz77(tilesUncompressed)
    : null;
  return Object.freeze({
    palette,
    tilesUncompressed,
    tilesCompressed,
    tileCount: opts.tileCount,
    widthPx: 0,
    heightPx: 0,
  });
}

/** Convert prepared bytes to a hex string for AgentPatchEdit. */
export function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += bytes[i]!.toString(16).padStart(2, '0');
  return out;
}
