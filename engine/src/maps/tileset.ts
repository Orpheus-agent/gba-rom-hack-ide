/**
 * Gen-3 Tileset header parser.
 *
 * Each tileset in vanilla Gen-3, decomp builds, and the typical hacks
 * is described by a 24-byte struct in ROM:
 *
 *   struct Tileset {
 *     u8 isCompressed;       // 0x00 - 0 or 1
 *     u8 isSecondary;        // 0x01 - 0 (primary) or 1 (secondary)
 *     u8 padding[2];         // 0x02 - both bytes are 0 in vanilla
 *     void *tilesPtr;        // 0x04 - pointer to tile graphics
 *     void *palettesPtr;     // 0x08 - pointer to palette data
 *     void *metatilesPtr;    // 0x0C - pointer to metatile bytes (8 bytes/metatile)
 *     void *slot10Ptr;       // 0x10 - FireRed: callback fn / Emerald: metatileAttributes
 *     void *slot14Ptr;       // 0x14 - FireRed: metatileAttributes / Emerald: callback fn
 *   };  // 24 bytes
 *
 * The slot meanings at 0x10 / 0x14 swap between FireRed and Emerald
 * (and hacks built on each retain their parent layout). Rather than
 * baking a family-specific interpretation (PD 5), we expose all 5
 * pointer slots positionally - `tilesPtr`, `palettesPtr`,
 * `metatilesPtr`, `slot10Ptr`, `slot14Ptr` - and let consumers cross-
 * reference with the family detector + heuristics (e.g. ROM-pointer-
 * to-thumb-code vs. ROM-pointer-to-data) when they need to disambiguate
 * callback vs metatileAttributes.
 *
 * Structural validation:
 *  - `isCompressed` and `isSecondary` are each 0 or 1 (booleans).
 *  - Padding bytes at 0x02..0x03 are both 0.
 *  - Each of the 5 pointer slots is NULL (raw 0) OR a valid in-ROM
 *    address (high byte 0x08/0x09, target inside `bytes`).
 *  - At least one of `tilesPtr` and `palettesPtr` is non-NULL (a real
 *    tileset must point at SOMETHING).
 */

import { GBA_ROM_BASE_ADDRESS } from '../pointers/index.js';

/** Bytes per Tileset header struct (Gen-3 FireRed + Emerald). */
export const TILESET_STRUCT_SIZE_BYTES = 24;

export interface TilesetParsed {
  readonly isCompressed: boolean;
  readonly isSecondary: boolean;
  readonly tilesOffset: number | null; // slot 0x04
  readonly palettesOffset: number | null; // slot 0x08
  readonly metatilesOffset: number | null; // slot 0x0C
  /** Slot at offset 0x10. FireRed: tileset callback fn (ARM code).
   *  Emerald: metatileAttributes data pointer. */
  readonly slot10Offset: number | null;
  /** Slot at offset 0x14. FireRed: metatileAttributes data pointer.
   *  Emerald: tileset callback fn (ARM code). */
  readonly slot14Offset: number | null;
  /** File offset of this Tileset struct's first byte. */
  readonly fileOffset: number;
}

export type TilesetParseFailure =
  | { kind: 'too_short'; bytesAvailable: number; bytesRequired: number }
  | { kind: 'implausible_is_compressed'; observed: number }
  | { kind: 'implausible_is_secondary'; observed: number }
  | { kind: 'nonzero_padding'; observedByte1: number; observedByte2: number }
  | { kind: 'invalid_pointer'; slot: TilesetSlot; rawAddress: number }
  | { kind: 'all_data_pointers_null' };

export type TilesetSlot = 'tiles' | 'palettes' | 'metatiles' | 'slot10' | 'slot14';

export type TilesetParseResult =
  | { ok: true; tileset: TilesetParsed }
  | { ok: false; failure: TilesetParseFailure };

/**
 * Parse 24 bytes at `offset` as a Gen-3 Tileset struct. Returns ok=true
 * only when the structural constraints are satisfied.
 */
export function parseTileset(bytes: Uint8Array, offset: number): TilesetParseResult {
  if (offset < 0 || offset + TILESET_STRUCT_SIZE_BYTES > bytes.length) {
    return {
      ok: false,
      failure: {
        kind: 'too_short',
        bytesAvailable: Math.max(0, bytes.length - offset),
        bytesRequired: TILESET_STRUCT_SIZE_BYTES,
      },
    };
  }

  const isCompressedByte = bytes[offset + 0x00] ?? 0;
  const isSecondaryByte = bytes[offset + 0x01] ?? 0;
  const pad1 = bytes[offset + 0x02] ?? 0;
  const pad2 = bytes[offset + 0x03] ?? 0;

  if (isCompressedByte !== 0 && isCompressedByte !== 1) {
    return {
      ok: false,
      failure: { kind: 'implausible_is_compressed', observed: isCompressedByte },
    };
  }
  if (isSecondaryByte !== 0 && isSecondaryByte !== 1) {
    return {
      ok: false,
      failure: { kind: 'implausible_is_secondary', observed: isSecondaryByte },
    };
  }
  if (pad1 !== 0 || pad2 !== 0) {
    return {
      ok: false,
      failure: { kind: 'nonzero_padding', observedByte1: pad1, observedByte2: pad2 },
    };
  }

  const resolve = (
    slot: TilesetSlot,
    ptrOffset: number,
  ):
    | { ok: true; fileOffset: number | null }
    | { ok: false; failure: TilesetParseFailure } => {
    const raw = readUint32Le(bytes, ptrOffset);
    if (raw === 0) return { ok: true, fileOffset: null };
    const high = (raw >>> 24) & 0xff;
    if (high !== 0x08 && high !== 0x09) {
      return { ok: false, failure: { kind: 'invalid_pointer', slot, rawAddress: raw } };
    }
    const target = raw - GBA_ROM_BASE_ADDRESS;
    if (target < 0 || target >= bytes.length) {
      return { ok: false, failure: { kind: 'invalid_pointer', slot, rawAddress: raw } };
    }
    return { ok: true, fileOffset: target };
  };

  const tiles = resolve('tiles', offset + 0x04);
  if (!tiles.ok) return { ok: false, failure: tiles.failure };
  const palettes = resolve('palettes', offset + 0x08);
  if (!palettes.ok) return { ok: false, failure: palettes.failure };
  const metatiles = resolve('metatiles', offset + 0x0c);
  if (!metatiles.ok) return { ok: false, failure: metatiles.failure };
  const slot10 = resolve('slot10', offset + 0x10);
  if (!slot10.ok) return { ok: false, failure: slot10.failure };
  const slot14 = resolve('slot14', offset + 0x14);
  if (!slot14.ok) return { ok: false, failure: slot14.failure };

  if (tiles.fileOffset === null && palettes.fileOffset === null) {
    return { ok: false, failure: { kind: 'all_data_pointers_null' } };
  }

  return {
    ok: true,
    tileset: Object.freeze({
      isCompressed: isCompressedByte === 1,
      isSecondary: isSecondaryByte === 1,
      tilesOffset: tiles.fileOffset,
      palettesOffset: palettes.fileOffset,
      metatilesOffset: metatiles.fileOffset,
      slot10Offset: slot10.fileOffset,
      slot14Offset: slot14.fileOffset,
      fileOffset: offset,
    }),
  };
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
