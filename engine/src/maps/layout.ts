/**
 * Gen-3 MapLayout struct parser.
 *
 * Per pret/pokefirered + pret/pokeemerald, each MapHeader's
 * mapLayoutPointer at header offset 0x00 points at a MapLayout struct.
 * The Ruby/Sapphire variant is 24 bytes; FireRed/LeafGreen + Emerald
 * additionally store 8-bit borderWidth/borderHeight at offset 0x18/0x19,
 * giving 28 bytes. We parse the first 24 bytes (the core shape every
 * Gen-3 cart shares) and treat the extra bytes as opaque - surfacing
 * them in coverage but not interpreting borderWidth/borderHeight.
 *
 *   struct MapLayout (24 bytes, all little-endian):
 *     s32   width;              // 0x00 - typical 8..256, vanilla max ~80
 *     s32   height;             // 0x04 - typical 8..256
 *     void *borderBlocksPtr;    // 0x08 - pointer to border-block tile data
 *     void *primaryBlocksPtr;   // 0x0C - pointer to the actual map tile-block array
 *     void *primaryTilesetPtr;  // 0x10 - pointer to primary Tileset struct
 *     void *secondaryTilesetPtr;// 0x14 - pointer to secondary Tileset struct
 *
 * PD 5: structural-only detection. No baked offsets to specific carts;
 * validates by struct shape (plausible dimensions + valid in-ROM pointers).
 */

import { GBA_ROM_BASE_ADDRESS } from '../pointers/index.js';

export const MAP_LAYOUT_STRUCT_SIZE_BYTES = 24;
/** Plausible upper bound for map dimensions in any Gen-3 cart variant.
 *  Vanilla maps top around 80×80; hacks rarely exceed 256×256. 1024 gives
 *  generous headroom while rejecting random 0xFFFFFFFF garbage. */
export const MAP_LAYOUT_MAX_DIMENSION = 1024;
/** Lower bound - any positive integer is plausible; 0 means "empty map"
 *  which doesn't happen in real carts. */
export const MAP_LAYOUT_MIN_DIMENSION = 1;

export interface MapLayout {
  readonly width: number;
  readonly height: number;
  readonly borderBlocksOffset: number | null;
  readonly primaryBlocksOffset: number | null;
  readonly primaryTilesetOffset: number | null;
  readonly secondaryTilesetOffset: number | null;
  /** ROM offset where this MapLayout struct lives. */
  readonly fileOffset: number;
}

export type MapLayoutParseFailure =
  | { kind: 'too_short'; bytesAvailable: number; bytesRequired: number }
  | { kind: 'implausible_dimensions'; observedWidth: number; observedHeight: number; minAllowed: number; maxAllowed: number }
  | { kind: 'invalid_pointer'; field: 'borderBlocks' | 'primaryBlocks' | 'primaryTileset' | 'secondaryTileset'; rawAddress: number };

export type MapLayoutParseResult =
  | { ok: true; layout: MapLayout }
  | { ok: false; failure: MapLayoutParseFailure };

/**
 * Try to parse 24 bytes at `offset` as a Gen-3 MapLayout struct.
 *
 * Validates:
 *   - width + height both in [1, 1024]
 *   - each of the 4 pointers is NULL OR a valid GBA-ROM pointer
 *     landing inside the same ROM
 *
 * Returns ok:false with typed failure on any constraint violation.
 */
export function parseMapLayout(bytes: Uint8Array, offset: number): MapLayoutParseResult {
  if (offset < 0 || offset + MAP_LAYOUT_STRUCT_SIZE_BYTES > bytes.length) {
    return {
      ok: false,
      failure: {
        kind: 'too_short',
        bytesAvailable: Math.max(0, bytes.length - offset),
        bytesRequired: MAP_LAYOUT_STRUCT_SIZE_BYTES,
      },
    };
  }

  const width = readInt32Le(bytes, offset + 0x00);
  const height = readInt32Le(bytes, offset + 0x04);
  if (
    width < MAP_LAYOUT_MIN_DIMENSION ||
    width > MAP_LAYOUT_MAX_DIMENSION ||
    height < MAP_LAYOUT_MIN_DIMENSION ||
    height > MAP_LAYOUT_MAX_DIMENSION
  ) {
    return {
      ok: false,
      failure: {
        kind: 'implausible_dimensions',
        observedWidth: width,
        observedHeight: height,
        minAllowed: MAP_LAYOUT_MIN_DIMENSION,
        maxAllowed: MAP_LAYOUT_MAX_DIMENSION,
      },
    };
  }

  const fields = [
    { name: 'borderBlocks' as const, ptrOffset: 0x08 },
    { name: 'primaryBlocks' as const, ptrOffset: 0x0c },
    { name: 'primaryTileset' as const, ptrOffset: 0x10 },
    { name: 'secondaryTileset' as const, ptrOffset: 0x14 },
  ];
  const resolved: Record<string, number | null> = {};
  for (const f of fields) {
    const ptr = readPointer(bytes, offset + f.ptrOffset);
    if (ptr === null) {
      return {
        ok: false,
        failure: {
          kind: 'invalid_pointer',
          field: f.name,
          rawAddress: readUint32Le(bytes, offset + f.ptrOffset),
        },
      };
    }
    if (ptr.fileOffset !== null && ptr.fileOffset >= bytes.length) {
      return {
        ok: false,
        failure: {
          kind: 'invalid_pointer',
          field: f.name,
          rawAddress: ptr.rawAddress,
        },
      };
    }
    resolved[f.name] = ptr.fileOffset;
  }

  return {
    ok: true,
    layout: Object.freeze({
      width,
      height,
      borderBlocksOffset: resolved.borderBlocks ?? null,
      primaryBlocksOffset: resolved.primaryBlocks ?? null,
      primaryTilesetOffset: resolved.primaryTileset ?? null,
      secondaryTilesetOffset: resolved.secondaryTileset ?? null,
      fileOffset: offset,
    }),
  };
}

function readPointer(
  bytes: Uint8Array,
  offset: number,
): { rawAddress: number; fileOffset: number | null } | null {
  if (offset + 4 > bytes.length) return null;
  const rawAddress = readUint32Le(bytes, offset);
  if (rawAddress === 0) return { rawAddress: 0, fileOffset: null };
  const highByte = (rawAddress >>> 24) & 0xff;
  if (highByte !== 0x08 && highByte !== 0x09) return null;
  return { rawAddress, fileOffset: rawAddress - GBA_ROM_BASE_ADDRESS };
}

function readInt32Le(bytes: Uint8Array, offset: number): number {
  const u = readUint32Le(bytes, offset);
  return u >= 0x80000000 ? u - 0x100000000 : u;
}

function readUint32Le(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] ?? 0) |
      ((bytes[offset + 1] ?? 0) << 8) |
      ((bytes[offset + 2] ?? 0) << 16) |
      ((bytes[offset + 3] ?? 0) << 24)) >>>
    0
  );
}
