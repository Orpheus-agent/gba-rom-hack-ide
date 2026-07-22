/**
 * 4bpp tile encoder (Phase 3.3).
 *
 * Inverse of `decode4bppTile`. Takes a 64-entry palette-index array
 * (one byte per pixel; values 0..15) and packs two pixels per byte - 
 * low nibble = left pixel, high nibble = right pixel - into the 32-byte
 * GBA 4bpp format.
 *
 * Throws on out-of-range palette indices (>= 16) so caller catches
 * miscoloring before writing to ROM.
 */

import { PIXELS_PER_TILE, TILE_4BPP_SIZE_BYTES } from './tile-pixels.js';

export class TileEncodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TileEncodeError';
  }
}

/** Encode 64 palette indices (row-major) into 32 bytes of GBA 4bpp. */
export function encode4bppTile(pixels: ArrayLike<number>): Uint8Array {
  if (pixels.length !== PIXELS_PER_TILE) {
    throw new TileEncodeError(
      `encode4bppTile: pixels.length must be ${String(PIXELS_PER_TILE)}; got ${String(pixels.length)}`,
    );
  }
  const out = new Uint8Array(TILE_4BPP_SIZE_BYTES);
  for (let i = 0; i < TILE_4BPP_SIZE_BYTES; i++) {
    const lo = pixels[i * 2]!;
    const hi = pixels[i * 2 + 1]!;
    if (!Number.isInteger(lo) || lo < 0 || lo > 15) {
      throw new TileEncodeError(`encode4bppTile: pixel[${String(i * 2)}]=${String(lo)} not a u4`);
    }
    if (!Number.isInteger(hi) || hi < 0 || hi > 15) {
      throw new TileEncodeError(`encode4bppTile: pixel[${String(i * 2 + 1)}]=${String(hi)} not a u4`);
    }
    out[i] = (lo & 0x0f) | ((hi & 0x0f) << 4);
  }
  return out;
}

/** Encode N tiles laid out contiguously. */
export function encode4bppTileSheet(
  tilesPixels: ReadonlyArray<ArrayLike<number>>,
): Uint8Array {
  const out = new Uint8Array(tilesPixels.length * TILE_4BPP_SIZE_BYTES);
  for (let i = 0; i < tilesPixels.length; i++) {
    const tile = encode4bppTile(tilesPixels[i]!);
    out.set(tile, i * TILE_4BPP_SIZE_BYTES);
  }
  return out;
}

/**
 * Slice a width×height RGBA pixel grid into 8×8 tiles in row-major
 * tile order (tile (0,0) first, then (1,0), …, (Wtiles-1, 0), then
 * (0,1), …). Each returned tile is a Uint8Array of palette indices - 
 * the caller must have indexed the pixels against a 16-color palette
 * first (use `quantizeRgbaToIndexed` from palette-quantizer.ts).
 *
 * `widthPx` and `heightPx` must be multiples of 8.
 */
export function pixelGridToTiles(
  indexedPixels: Uint8Array,
  widthPx: number,
  heightPx: number,
): Uint8Array[] {
  if (widthPx % 8 !== 0 || heightPx % 8 !== 0) {
    throw new TileEncodeError(
      `pixelGridToTiles: dimensions must be multiples of 8; got ${String(widthPx)}×${String(heightPx)}`,
    );
  }
  if (indexedPixels.length !== widthPx * heightPx) {
    throw new TileEncodeError(
      `pixelGridToTiles: indexedPixels.length must equal width*height (${String(widthPx * heightPx)}); got ${String(indexedPixels.length)}`,
    );
  }
  const widthTiles = widthPx / 8;
  const heightTiles = heightPx / 8;
  const tiles: Uint8Array[] = [];
  for (let ty = 0; ty < heightTiles; ty++) {
    for (let tx = 0; tx < widthTiles; tx++) {
      const tile = new Uint8Array(PIXELS_PER_TILE);
      for (let py = 0; py < 8; py++) {
        for (let px = 0; px < 8; px++) {
          const srcX = tx * 8 + px;
          const srcY = ty * 8 + py;
          tile[py * 8 + px] = indexedPixels[srcY * widthPx + srcX]!;
        }
      }
      tiles.push(tile);
    }
  }
  return tiles;
}
