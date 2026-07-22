/**
 * Gen-3 wild encounters - WildPokemonHeader parser.
 *
 * Per pret/pokefirered + pret/pokeemerald, wild encounters for each
 * map are stored as a flat array of 20-byte WildPokemonHeader records
 * (e.g. `gWildMonHeaders`). The array is terminated by a sentinel
 * record (mapGroup = 0xFF). Each non-sentinel record describes the
 * encounters for one map:
 *
 *   struct WildPokemonHeader {
 *     u8 mapGroup;                       // 0x00 (sentinel = 0xFF)
 *     u8 mapNum;                         // 0x01
 *     u16 _padding;                      // 0x02
 *     void *landMonsInfoPtr;             // 0x04 - grass encounters
 *     void *waterMonsInfoPtr;            // 0x08 - surf encounters
 *     void *rockSmashMonsInfoPtr;        // 0x0C - rock smash
 *     void *fishingMonsInfoPtr;          // 0x10 - fishing
 *   };
 *
 * P5-T6 scope: detect the table + per-map records + which encounter
 * KINDS are populated. Per-pokemon species + level decoding is §15
 * Phase 8 work (full encounter system detection).
 *
 * PD 5: structural-only detection. Validates record shape (plausible
 * mapGroup/mapNum bytes, zero padding, ≥1 valid in-ROM pointer).
 */

import { GBA_ROM_BASE_ADDRESS } from '../pointers/index.js';

export const WILD_POKEMON_HEADER_STRUCT_SIZE_BYTES = 20;
export const WILD_ENCOUNTERS_SENTINEL_MAP_GROUP = 0xff;
/** Plausible upper bound on (mapGroup, mapNum) bytes. Real Gen-3 carts
 *  have ≤ 50 groups; setting 200 captures heavy hacks while rejecting
 *  random 0xFF/0xFE garbage. The sentinel 0xFF is checked separately. */
const PLAUSIBLE_MAP_GROUP_MAX = 200;
const PLAUSIBLE_MAP_NUM_MAX = 200;

export type EncounterKind = 'land' | 'water' | 'rockSmash' | 'fishing';

export interface WildPokemonHeader {
  readonly mapGroup: number;
  readonly mapNum: number;
  readonly landMonsOffset: number | null;
  readonly waterMonsOffset: number | null;
  readonly rockSmashMonsOffset: number | null;
  readonly fishingMonsOffset: number | null;
  /** ROM file offset of this header. */
  readonly fileOffset: number;
}

export type WildPokemonHeaderParseFailure =
  | { kind: 'too_short'; bytesAvailable: number; bytesRequired: number }
  | { kind: 'sentinel'; mapGroup: number }
  | { kind: 'implausible_map_indices'; mapGroup: number; mapNum: number }
  | { kind: 'nonzero_padding'; observedPadding: number }
  | { kind: 'all_pointers_null' }
  | { kind: 'invalid_pointer'; field: EncounterKind; rawAddress: number };

export type WildPokemonHeaderParseResult =
  | { ok: true; header: WildPokemonHeader }
  | { ok: false; failure: WildPokemonHeaderParseFailure };

/**
 * Parse 20 bytes at `offset` as a WildPokemonHeader. Returns failure
 * type 'sentinel' when the record is the table terminator (mapGroup =
 * 0xFF) so the scanner can stop cleanly.
 */
export function parseWildPokemonHeader(
  bytes: Uint8Array,
  offset: number,
): WildPokemonHeaderParseResult {
  if (offset < 0 || offset + WILD_POKEMON_HEADER_STRUCT_SIZE_BYTES > bytes.length) {
    return {
      ok: false,
      failure: {
        kind: 'too_short',
        bytesAvailable: Math.max(0, bytes.length - offset),
        bytesRequired: WILD_POKEMON_HEADER_STRUCT_SIZE_BYTES,
      },
    };
  }

  const mapGroup = bytes[offset + 0x00] ?? 0;
  const mapNum = bytes[offset + 0x01] ?? 0;
  const padding = readUint16Le(bytes, offset + 0x02);

  // Sentinel terminator.
  if (mapGroup === WILD_ENCOUNTERS_SENTINEL_MAP_GROUP) {
    return { ok: false, failure: { kind: 'sentinel', mapGroup } };
  }

  if (mapGroup > PLAUSIBLE_MAP_GROUP_MAX || mapNum > PLAUSIBLE_MAP_NUM_MAX) {
    return {
      ok: false,
      failure: { kind: 'implausible_map_indices', mapGroup, mapNum },
    };
  }
  if (padding !== 0) {
    return { ok: false, failure: { kind: 'nonzero_padding', observedPadding: padding } };
  }

  // Resolve each of the 4 encounter-kind pointers.
  const resolve = (
    field: EncounterKind,
    ptrOffset: number,
  ): { ok: true; fileOffset: number | null } | { ok: false; failure: WildPokemonHeaderParseFailure } => {
    if (ptrOffset + 4 > bytes.length) {
      return { ok: true, fileOffset: null };
    }
    const raw = readUint32Le(bytes, ptrOffset);
    if (raw === 0) return { ok: true, fileOffset: null };
    const highByte = (raw >>> 24) & 0xff;
    if (highByte !== 0x08 && highByte !== 0x09) {
      return { ok: false, failure: { kind: 'invalid_pointer', field, rawAddress: raw } };
    }
    const fileOffset = raw - GBA_ROM_BASE_ADDRESS;
    if (fileOffset >= bytes.length) {
      return { ok: false, failure: { kind: 'invalid_pointer', field, rawAddress: raw } };
    }
    return { ok: true, fileOffset };
  };

  const landR = resolve('land', offset + 0x04);
  if (!landR.ok) return { ok: false, failure: landR.failure };
  const waterR = resolve('water', offset + 0x08);
  if (!waterR.ok) return { ok: false, failure: waterR.failure };
  const rockSmashR = resolve('rockSmash', offset + 0x0c);
  if (!rockSmashR.ok) return { ok: false, failure: rockSmashR.failure };
  const fishingR = resolve('fishing', offset + 0x10);
  if (!fishingR.ok) return { ok: false, failure: fishingR.failure };

  // Require at least one non-null pointer - otherwise it's not a real
  // WildPokemonHeader, just zero-fill that happens to have small bytes
  // at offset 0x00/0x01.
  const populatedFields = [
    landR.fileOffset,
    waterR.fileOffset,
    rockSmashR.fileOffset,
    fishingR.fileOffset,
  ].filter((o) => o !== null);
  if (populatedFields.length === 0) {
    return { ok: false, failure: { kind: 'all_pointers_null' } };
  }

  return {
    ok: true,
    header: Object.freeze({
      mapGroup,
      mapNum,
      landMonsOffset: landR.fileOffset,
      waterMonsOffset: waterR.fileOffset,
      rockSmashMonsOffset: rockSmashR.fileOffset,
      fishingMonsOffset: fishingR.fileOffset,
      fileOffset: offset,
    }),
  };
}

function readUint16Le(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8)) >>> 0;
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
