/**
 * Gen-3 MapLayout struct encoder (Phase 3.1).
 *
 * Inverse of `parseMapLayout` - produces the 24-byte MapLayout struct
 * + (separately) the bytes for the primary blocks array and border
 * blocks. The caller picks file offsets via the free-space registry
 * (Phase 3.2) and concatenates the result.
 *
 * The blocks array is a `width * height` `u16` array - each entry is a
 * block id (low 10 bits) + collision/elevation/behavior-override bits
 * (upper 6 bits, varies by family). The encoder writes them little-
 * endian; the caller is responsible for the bit composition.
 *
 * Border blocks are a small `borderWidth * borderHeight` `u16` array.
 * Vanilla FRLG borders are 2×2 (8 bytes); RSE borders are 3×3 (18
 * bytes). The encoder accepts arbitrary dimensions; the parser at 0x18
 * reads borderWidth/borderHeight from the layout struct, but vanilla
 * carts leave those bytes zero - we mirror the parser and write zeros
 * by default.
 */

import { GBA_ROM_BASE_ADDRESS } from '../pointers/index.js';
import {
  MAP_LAYOUT_MAX_DIMENSION,
  MAP_LAYOUT_MIN_DIMENSION,
  MAP_LAYOUT_STRUCT_SIZE_BYTES,
} from './layout.js';

export interface MapLayoutSpec {
  /** s32 - map width in metatiles ([1, 1024] per the parser bounds). */
  readonly width: number;
  /** s32 - map height in metatiles. */
  readonly height: number;
  /** File offset of the border-blocks array; null encodes NULL. */
  readonly borderBlocksOffset: number | null;
  /** File offset of the primary blocks array (width*height u16). */
  readonly primaryBlocksOffset: number | null;
  /** File offset of the primary Tileset struct (24 bytes). */
  readonly primaryTilesetOffset: number | null;
  /** File offset of the secondary Tileset struct. */
  readonly secondaryTilesetOffset: number | null;
}

export class MapLayoutEncodeError extends Error {
  readonly field: string;
  constructor(field: string, message: string) {
    super(`MapLayoutEncodeError: ${field}: ${message}`);
    this.name = 'MapLayoutEncodeError';
    this.field = field;
  }
}

/** Encode the 24-byte MapLayout struct. */
export function encodeMapLayout(spec: MapLayoutSpec): Uint8Array {
  if (
    !Number.isInteger(spec.width) ||
    spec.width < MAP_LAYOUT_MIN_DIMENSION ||
    spec.width > MAP_LAYOUT_MAX_DIMENSION
  ) {
    throw new MapLayoutEncodeError(
      'width',
      `must be an integer in [${String(MAP_LAYOUT_MIN_DIMENSION)}, ${String(MAP_LAYOUT_MAX_DIMENSION)}]; got ${String(spec.width)}`,
    );
  }
  if (
    !Number.isInteger(spec.height) ||
    spec.height < MAP_LAYOUT_MIN_DIMENSION ||
    spec.height > MAP_LAYOUT_MAX_DIMENSION
  ) {
    throw new MapLayoutEncodeError(
      'height',
      `must be an integer in [${String(MAP_LAYOUT_MIN_DIMENSION)}, ${String(MAP_LAYOUT_MAX_DIMENSION)}]; got ${String(spec.height)}`,
    );
  }
  const out = new Uint8Array(MAP_LAYOUT_STRUCT_SIZE_BYTES);
  writeS32Le(out, 0x00, spec.width);
  writeS32Le(out, 0x04, spec.height);
  writePointer(out, 0x08, spec.borderBlocksOffset, 'borderBlocksOffset');
  writePointer(out, 0x0c, spec.primaryBlocksOffset, 'primaryBlocksOffset');
  writePointer(out, 0x10, spec.primaryTilesetOffset, 'primaryTilesetOffset');
  writePointer(out, 0x14, spec.secondaryTilesetOffset, 'secondaryTilesetOffset');
  return out;
}

/**
 * Encode a primary-blocks u16 array. `blockIds` length must be
 * `width * height`. Returns the packed little-endian byte array.
 *
 * Each entry is a u16 block id (low 10 bits typically; the caller is
 * responsible for any collision/elevation/behavior-override bits in
 * the upper bits - we don't validate, just write the value).
 */
export function encodeBlockGrid(
  width: number,
  height: number,
  blockIds: ReadonlyArray<number>,
): Uint8Array {
  const expected = width * height;
  if (blockIds.length !== expected) {
    throw new MapLayoutEncodeError(
      'blockIds',
      `expected ${String(expected)} entries (width × height = ${String(width)} × ${String(height)}); got ${String(blockIds.length)}`,
    );
  }
  const out = new Uint8Array(expected * 2);
  for (let i = 0; i < expected; i++) {
    const v = blockIds[i]!;
    if (!Number.isInteger(v) || v < 0 || v > 0xffff) {
      throw new MapLayoutEncodeError('blockIds[' + String(i) + ']', `must be a u16 in [0, 0xFFFF]; got ${String(v)}`);
    }
    out[i * 2 + 0] = v & 0xff;
    out[i * 2 + 1] = (v >>> 8) & 0xff;
  }
  return out;
}

/**
 * Encode a border-blocks u16 array. Vanilla FRLG borders are 2×2 = 4
 * entries (8 bytes); RSE borders are 3×3 = 9 entries (18 bytes).
 */
export function encodeBorderBlocks(borderBlocks: ReadonlyArray<number>): Uint8Array {
  if (borderBlocks.length === 0) {
    throw new MapLayoutEncodeError('borderBlocks', 'must have ≥ 1 entry');
  }
  const out = new Uint8Array(borderBlocks.length * 2);
  for (let i = 0; i < borderBlocks.length; i++) {
    const v = borderBlocks[i]!;
    if (!Number.isInteger(v) || v < 0 || v > 0xffff) {
      throw new MapLayoutEncodeError('borderBlocks[' + String(i) + ']', `must be a u16; got ${String(v)}`);
    }
    out[i * 2 + 0] = v & 0xff;
    out[i * 2 + 1] = (v >>> 8) & 0xff;
  }
  return out;
}

function writeS32Le(out: Uint8Array, byteOffset: number, value: number): void {
  // Encode as unsigned LE; for the values the parser accepts ([1, 1024])
  // the sign bit is always 0.
  const u = value >>> 0;
  out[byteOffset + 0] = u & 0xff;
  out[byteOffset + 1] = (u >>> 8) & 0xff;
  out[byteOffset + 2] = (u >>> 16) & 0xff;
  out[byteOffset + 3] = (u >>> 24) & 0xff;
}

function writePointer(
  out: Uint8Array,
  byteOffset: number,
  fileOffset: number | null,
  field: string,
): void {
  if (fileOffset === null) {
    out[byteOffset + 0] = 0;
    out[byteOffset + 1] = 0;
    out[byteOffset + 2] = 0;
    out[byteOffset + 3] = 0;
    return;
  }
  if (!Number.isInteger(fileOffset) || fileOffset < 0 || fileOffset > 0x01ffffff) {
    throw new MapLayoutEncodeError(field, `file offset must fit in 25 bits; got ${String(fileOffset)}`);
  }
  const ptr = (fileOffset + GBA_ROM_BASE_ADDRESS) >>> 0;
  out[byteOffset + 0] = ptr & 0xff;
  out[byteOffset + 1] = (ptr >>> 8) & 0xff;
  out[byteOffset + 2] = (ptr >>> 16) & 0xff;
  out[byteOffset + 3] = (ptr >>> 24) & 0xff;
}
