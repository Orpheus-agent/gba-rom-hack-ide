/**
 * Gen-3 overworld-sprite image decoder - iter 111 / Phase E substrate.
 *
 * Given the file offset of an ObjectEventGraphicsInfo struct (already
 * detected + exposed by iter-101's overworld_sprites_system as
 * OverworldSpriteInfo.structFileOffset), this module follows the
 * struct's `images` pointer at offset 0x1C, reads the first
 * SpriteFrameImage, decodes the raw 4bpp tile data, and returns a
 * width×height grid of palette indices ready for palette application.
 *
 * Per pret/pokefirered include/sprite.h:
 *
 *   struct SpriteFrameImage {
 *     const void *data;  // 0x00 - raw 4bpp tile bytes (NOT LZ77;
 *                        //         OW sprites use uncompressed tiles)
 *     u16 size;          // 0x04 - bytes per frame (= width*height/2)
 *   };  // 8 bytes per frame
 *
 * For each frame, tiles are laid out row-major as 8×8 px blocks:
 *   For a (W × H) sprite, tile layout is (W/8) × (H/8). Tile 0 is the
 *   top-left 8×8 block; tile 1 is the next 8×8 to its right; once a
 *   row of (W/8) tiles is filled, the next row begins.
 *
 * This module returns ONLY the palette-index grid (no palette
 * resolution yet - caller must pair with a palette block to render
 * RGBA). Phase E's frontend integration will fetch this + apply
 * palette 0 as a baseline (similar to Phase C's tile sheet limitation).
 *
 * PD 5 universal - works on every Gen-3 cart with the OW sprite
 * struct convention. PD 16 hack-aware: hacks expand OW sprite roster +
 * may use custom sizes; the decoder reads width/height from the struct
 * itself rather than baking vanilla sprite dimensions.
 */

import { TILE_4BPP_SIZE_BYTES, decode4bppTile } from '../graphics/index.js';

/** Bytes per SpriteFrameImage struct. */
export const SPRITE_FRAME_IMAGE_SIZE_BYTES = 8;

/** Offset within ObjectEventGraphicsInfo where the `images` pointer lives. */
export const OBJECT_EVENT_GRAPHICS_IMAGES_PTR_OFFSET = 0x1c;

/** Offset of width (s16) within the struct. */
const STRUCT_WIDTH_OFFSET = 0x08;
/** Offset of height (s16). */
const STRUCT_HEIGHT_OFFSET = 0x0a;

/** GBA ROM pointer base + bounds. */
const GBA_ROM_BASE = 0x08000000;
const GBA_ROM_END_EXCLUSIVE = 0x0a000000;

/** Max sprite dimension (pixels) we'll decode. Defensive cap; vanilla
 *  OW sprites top out at 64x64 (Lugia-equivalent shadow sprite). */
const SPRITE_DIMENSION_MAX = 256;

export type OverworldSpriteImageFailure =
  | { readonly kind: 'struct_too_short'; readonly bytesAvailable: number }
  | { readonly kind: 'invalid_images_pointer'; readonly observed: number }
  | { readonly kind: 'invalid_frame_data_pointer'; readonly observed: number }
  | { readonly kind: 'implausible_dimensions'; readonly width: number; readonly height: number }
  | { readonly kind: 'frame_data_truncated'; readonly bytesNeeded: number; readonly bytesAvailable: number };

export type OverworldSpriteImageResult =
  | { readonly ok: true; readonly image: OverworldSpriteImage }
  | { readonly ok: false; readonly failure: OverworldSpriteImageFailure };

export interface OverworldSpriteImage {
  /** Sprite width in pixels (from struct + 0x08). */
  readonly width: number;
  /** Sprite height in pixels (from struct + 0x0A). */
  readonly height: number;
  /** Palette index per pixel, row-major (length = width * height).
   *  Caller applies a 16-color palette to render RGBA. Palette index 0
   *  is conventionally transparent. */
  readonly pixelIndices: Uint8Array;
  /** Tile count = (width/8) × (height/8). */
  readonly tileCount: number;
  /** File offset of the raw tile bytes (after pointer following). */
  readonly tileDataFileOffset: number;
  /** Frame size in bytes from the SpriteFrameImage. */
  readonly frameSizeBytes: number;
}

function readU16LE(bytes: Uint8Array, offset: number): number {
  return bytes[offset]! | (bytes[offset + 1]! << 8);
}

function readS16LE(bytes: Uint8Array, offset: number): number {
  const v = readU16LE(bytes, offset);
  return v < 0x8000 ? v : v - 0x10000;
}

function readU32LE(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset]! |
      (bytes[offset + 1]! << 8) |
      (bytes[offset + 2]! << 16) |
      (bytes[offset + 3]! << 24)) >>>
    0
  );
}

function ptrToFileOffset(ptr: number, romByteLength: number): number {
  if (ptr < GBA_ROM_BASE || ptr >= GBA_ROM_END_EXCLUSIVE) return -1;
  const off = ptr - GBA_ROM_BASE;
  if (off >= romByteLength) return -1;
  return off;
}

/**
 * Decode a single OW sprite frame's image bytes into a palette-index
 * grid. Reads:
 *   1. The ObjectEventGraphicsInfo struct at `structFileOffset` to get
 *      width, height, and the `images` ROM pointer at +0x1C.
 *   2. The Nth SpriteFrameImage (default 0 = idle south) at
 *      `*images + frameIndex × 8`: data pointer + frame size.
 *   3. `size` bytes of raw 4bpp tile data at the data pointer's file
 *      offset, decoded as (width/8) × (height/8) tiles in row-major
 *      order via the existing tile-pixels decoder.
 *
 * Returns the palette-index grid (NOT yet palette-applied - caller
 * provides the palette per the per-sprite paletteSlotBits field
 * exposed by OverworldSpriteInfo). Index 0 conventionally transparent
 * per GBA 4bpp convention.
 *
 * Defensive: typed failure on pointer-out-of-range / dimension
 * implausibility / data truncation. Never throws.
 */
export function decodeOverworldSpriteImage(
  rom: Uint8Array,
  structFileOffset: number,
  frameIndex = 0,
): OverworldSpriteImageResult {
  // 1. Read struct header for width, height, and images pointer.
  if (
    structFileOffset < 0 ||
    structFileOffset + OBJECT_EVENT_GRAPHICS_IMAGES_PTR_OFFSET + 4 > rom.length
  ) {
    return {
      ok: false,
      failure: {
        kind: 'struct_too_short',
        bytesAvailable: Math.max(0, rom.length - structFileOffset),
      },
    };
  }
  const width = readS16LE(rom, structFileOffset + STRUCT_WIDTH_OFFSET);
  const height = readS16LE(rom, structFileOffset + STRUCT_HEIGHT_OFFSET);
  if (
    width <= 0 ||
    height <= 0 ||
    width > SPRITE_DIMENSION_MAX ||
    height > SPRITE_DIMENSION_MAX ||
    width % 8 !== 0 ||
    height % 8 !== 0
  ) {
    return {
      ok: false,
      failure: { kind: 'implausible_dimensions', width, height },
    };
  }
  const imagesPtr = readU32LE(rom, structFileOffset + OBJECT_EVENT_GRAPHICS_IMAGES_PTR_OFFSET);
  const imagesFileOffset = ptrToFileOffset(imagesPtr, rom.length);
  if (imagesFileOffset < 0) {
    return {
      ok: false,
      failure: { kind: 'invalid_images_pointer', observed: imagesPtr },
    };
  }

  // 2. Read the Nth SpriteFrameImage (data ptr + frame size).
  const frameStart = imagesFileOffset + frameIndex * SPRITE_FRAME_IMAGE_SIZE_BYTES;
  if (frameStart + SPRITE_FRAME_IMAGE_SIZE_BYTES > rom.length) {
    return {
      ok: false,
      failure: {
        kind: 'frame_data_truncated',
        bytesNeeded: SPRITE_FRAME_IMAGE_SIZE_BYTES,
        bytesAvailable: rom.length - frameStart,
      },
    };
  }
  const dataPtr = readU32LE(rom, frameStart + 0x00);
  const dataFileOffset = ptrToFileOffset(dataPtr, rom.length);
  if (dataFileOffset < 0) {
    return {
      ok: false,
      failure: { kind: 'invalid_frame_data_pointer', observed: dataPtr },
    };
  }
  const frameSize = readU16LE(rom, frameStart + 0x04);

  // 3. Validate frame size vs. dimensions.
  const tilesWide = width / 8;
  const tilesTall = height / 8;
  const expectedBytes = tilesWide * tilesTall * TILE_4BPP_SIZE_BYTES;
  // Some OW sprites declare a frameSize covering multiple sub-frames
  // (e.g. shadow sprites). Use whichever is smaller of the declared
  // frameSize and the dimensions-derived size - defensive.
  const decodableBytes = Math.min(frameSize === 0 ? expectedBytes : frameSize, expectedBytes);
  if (dataFileOffset + decodableBytes > rom.length) {
    return {
      ok: false,
      failure: {
        kind: 'frame_data_truncated',
        bytesNeeded: decodableBytes,
        bytesAvailable: rom.length - dataFileOffset,
      },
    };
  }

  // 4. Decode tiles + arrange row-major into the pixel grid.
  const pixelIndices = new Uint8Array(width * height);
  for (let ty = 0; ty < tilesTall; ty++) {
    for (let tx = 0; tx < tilesWide; tx++) {
      const tileIndex = ty * tilesWide + tx;
      const tileOff = dataFileOffset + tileIndex * TILE_4BPP_SIZE_BYTES;
      // Defensive: if this specific tile is past EOF, leave it as
      // transparent (zeros) rather than throwing.
      if (tileOff + TILE_4BPP_SIZE_BYTES > rom.length) break;
      const tilePixels = decode4bppTile(rom, tileOff);
      // Blit the 8×8 tile pixels into the sprite-grid at (tx*8, ty*8).
      const dx = tx * 8;
      const dy = ty * 8;
      for (let py = 0; py < 8; py++) {
        for (let px = 0; px < 8; px++) {
          pixelIndices[(dy + py) * width + (dx + px)] = tilePixels[py * 8 + px]!;
        }
      }
    }
  }

  return {
    ok: true,
    image: {
      width,
      height,
      pixelIndices,
      tileCount: tilesWide * tilesTall,
      tileDataFileOffset: dataFileOffset,
      frameSizeBytes: frameSize,
    },
  };
}

/**
 * Apply a 16-color RGBA palette to a decoded sprite image, returning
 * a Uint32Array of RGBA pixels in row-major order. Palette index 0 →
 * 0x00000000 (transparent) per GBA 4bpp convention; other indices →
 * the matching palette entry. Indices ≥ palette.length render as
 * fully transparent (defensive).
 */
export function applyPaletteToOverworldSprite(
  image: OverworldSpriteImage,
  palette: Uint32Array,
): Uint32Array {
  const out = new Uint32Array(image.width * image.height);
  for (let i = 0; i < image.pixelIndices.length; i++) {
    const palIdx = image.pixelIndices[i]!;
    if (palIdx === 0 || palIdx >= palette.length) {
      out[i] = 0; // transparent
    } else {
      out[i] = palette[palIdx]!;
    }
  }
  return out;
}
