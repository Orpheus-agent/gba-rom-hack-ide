/**
 * Gen-3 WildPokemonInfo + WildPokemon slot parsers - Phase 8 P8-T3.
 *
 * Per pret/pokefirered (src/data/wild_encounters.json + struct
 * WildPokemonInfo) and pret/pokeemerald, each `WildPokemonHeader`
 * pointer (P5-T6) targets a `WildPokemonInfo` struct:
 *
 *   struct WildPokemonInfo {
 *     u8 encounterRate;            // 0x00 - 0..MAX; vanilla typically ≤100
 *     u8 _pad[3];                  // 0x01..0x03 - must be 0
 *     WildPokemon *slots;          // 0x04 - ROM pointer (or NULL = no slots)
 *   };  // 8 bytes
 *
 *   struct WildPokemon {
 *     u8 minLevel;                 // 0x00 - 1..100
 *     u8 maxLevel;                 // 0x01 - minLevel..100
 *     u16 species;                 // 0x02 - index into gBaseStats
 *   };  // 4 bytes
 *
 * Slot counts per encounter kind (FireRed/Emerald vanilla):
 *   land:      12 slots
 *   water:      5 slots
 *   rockSmash:  5 slots
 *   fishing:   10 slots  (old rod 2 + good rod 3 + super rod 5)
 *
 * Heavy hacks and expansion frameworks (CFRU, Inclement Emerald) may
 * extend slot counts. P8-T3 accepts caller-supplied per-kind slot
 * counts (PD 5 universality: no baked assumption that 12 land slots
 * is the only legal layout) but defaults to the vanilla counts so the
 * detector works without per-ROM configuration.
 *
 * Detection signature for WildPokemonInfo:
 *   - encounterRate ≤ WILD_ENCOUNTER_RATE_MAX (default 200)
 *   - 3 padding bytes at 0x01/0x02/0x03 all 0
 *   - slots pointer either NULL or a valid in-ROM 0x08000000..0x09FFFFFF
 *
 * Detection signature for WildPokemon slot:
 *   - minLevel ∈ [1, WILD_POKEMON_LEVEL_MAX] (default 100)
 *   - maxLevel ∈ [minLevel, WILD_POKEMON_LEVEL_MAX]
 *   - species ∈ [1, WILD_POKEMON_SPECIES_MAX] (default 2048 - heavy
 *     hacks expand dex; 411 vanilla species + room for expansion)
 *
 * PD 5: structural-only - no baked offsets; the entire detection
 * chain is driven by header pointers discovered by P5-T6 and
 * dereferenced through the same loader-resolved ROM bytes.
 */

import { GBA_ROM_BASE_ADDRESS } from '../pointers/index.js';

export const WILD_POKEMON_INFO_STRUCT_SIZE_BYTES = 8;
export const WILD_POKEMON_SLOT_SIZE_BYTES = 4;
/** Highest plausible encounterRate. Vanilla typically ≤100; heavy
 *  hacks may exceed; cap at 200 still rejects 0xFF garbage. */
export const WILD_ENCOUNTER_RATE_MAX = 200;
/** Highest plausible Pokémon level. Vanilla cap is 100; same in hacks. */
export const WILD_POKEMON_LEVEL_MAX = 100;
/** Highest plausible species index. Vanilla 411; CFRU/expansion
 *  frameworks expand the dex; 2048 captures known heavy hacks. */
export const WILD_POKEMON_SPECIES_MAX = 2048;

/** Vanilla Gen-3 slot counts per encounter kind. Operator-supplied
 *  hacks with expanded counts override these per-kind. */
export const VANILLA_LAND_SLOT_COUNT = 12;
export const VANILLA_WATER_SLOT_COUNT = 5;
export const VANILLA_ROCK_SMASH_SLOT_COUNT = 5;
export const VANILLA_FISHING_SLOT_COUNT = 10;

/** ROM pointer base/limit (32 MiB cartridge). */
const GBA_ROM_POINTER_UPPER = 0x09ffffff;

export interface WildPokemon {
  /** Min level for this slot (inclusive). */
  readonly minLevel: number;
  /** Max level for this slot (inclusive). */
  readonly maxLevel: number;
  /** Species index - references `species:S` graph nodes from P8-T1. */
  readonly species: number;
  /** ROM file offset of this 4-byte slot. */
  readonly fileOffset: number;
}

export interface WildPokemonInfo {
  /** 0..200 typically; vanilla ≤100. */
  readonly encounterRate: number;
  /** Resolved ROM file offset of the slots array, or null if NULL. */
  readonly slotsOffset: number | null;
  /** Number of slots successfully parsed (may be < requested count if
   *  the run terminated early). */
  readonly slotCount: number;
  /** Parsed slots, in order. */
  readonly slots: ReadonlyArray<WildPokemon>;
  /** ROM file offset of this WildPokemonInfo struct's first byte. */
  readonly fileOffset: number;
}

export type WildPokemonInfoParseFailure =
  | { kind: 'too_short'; bytesAvailable: number; bytesRequired: number }
  | { kind: 'implausible_encounter_rate'; observed: number; max: number }
  | { kind: 'nonzero_padding'; pad1: number; pad2: number; pad3: number }
  | { kind: 'invalid_slots_pointer'; rawAddress: number };

export type WildPokemonInfoParseResult =
  | { ok: true; info: WildPokemonInfo }
  | { ok: false; failure: WildPokemonInfoParseFailure };

export type WildPokemonParseFailure =
  | { kind: 'too_short'; bytesAvailable: number; bytesRequired: number }
  | { kind: 'invalid_level'; field: 'minLevel' | 'maxLevel'; observed: number; max: number }
  | { kind: 'inverted_level_range'; minLevel: number; maxLevel: number }
  | { kind: 'invalid_species'; observed: number; max: number }
  | { kind: 'zero_species' };

export type WildPokemonParseResult =
  | { ok: true; slot: WildPokemon }
  | { ok: false; failure: WildPokemonParseFailure };

export interface ParseWildPokemonInfoOptions {
  /** Number of slots to walk after dereferencing the slots pointer.
   *  Defaults to the caller-supplied count for the encounter kind. */
  readonly slotCount: number;
  /** Override max species index. Default `WILD_POKEMON_SPECIES_MAX`. */
  readonly speciesMax?: number;
  /** Override max encounter rate. Default `WILD_ENCOUNTER_RATE_MAX`. */
  readonly encounterRateMax?: number;
}

/** Parse a single 4-byte WildPokemon slot. */
export function parseWildPokemon(
  bytes: Uint8Array,
  offset: number,
  opts?: { readonly speciesMax?: number },
): WildPokemonParseResult {
  const speciesMax = opts?.speciesMax ?? WILD_POKEMON_SPECIES_MAX;
  if (offset < 0 || offset + WILD_POKEMON_SLOT_SIZE_BYTES > bytes.length) {
    return {
      ok: false,
      failure: {
        kind: 'too_short',
        bytesAvailable: Math.max(0, bytes.length - offset),
        bytesRequired: WILD_POKEMON_SLOT_SIZE_BYTES,
      },
    };
  }
  const minLevel = bytes[offset + 0x00] ?? 0;
  const maxLevel = bytes[offset + 0x01] ?? 0;
  const species = readUint16Le(bytes, offset + 0x02);

  if (minLevel === 0 || minLevel > WILD_POKEMON_LEVEL_MAX) {
    return {
      ok: false,
      failure: { kind: 'invalid_level', field: 'minLevel', observed: minLevel, max: WILD_POKEMON_LEVEL_MAX },
    };
  }
  if (maxLevel === 0 || maxLevel > WILD_POKEMON_LEVEL_MAX) {
    return {
      ok: false,
      failure: { kind: 'invalid_level', field: 'maxLevel', observed: maxLevel, max: WILD_POKEMON_LEVEL_MAX },
    };
  }
  if (maxLevel < minLevel) {
    return { ok: false, failure: { kind: 'inverted_level_range', minLevel, maxLevel } };
  }
  if (species === 0) {
    return { ok: false, failure: { kind: 'zero_species' } };
  }
  if (species > speciesMax) {
    return { ok: false, failure: { kind: 'invalid_species', observed: species, max: speciesMax } };
  }
  return {
    ok: true,
    slot: Object.freeze({ minLevel, maxLevel, species, fileOffset: offset }),
  };
}

/** Parse an 8-byte WildPokemonInfo at `offset` and dereference its
 *  slots pointer to walk `opts.slotCount` consecutive WildPokemon
 *  slots. */
export function parseWildPokemonInfo(
  bytes: Uint8Array,
  offset: number,
  opts: ParseWildPokemonInfoOptions,
): WildPokemonInfoParseResult {
  const slotCount = opts.slotCount;
  const speciesMax = opts.speciesMax ?? WILD_POKEMON_SPECIES_MAX;
  const encounterRateMax = opts.encounterRateMax ?? WILD_ENCOUNTER_RATE_MAX;
  if (!Number.isInteger(slotCount) || slotCount < 1) {
    throw new Error(`slotCount must be a positive integer, got ${String(slotCount)}`);
  }
  if (offset < 0 || offset + WILD_POKEMON_INFO_STRUCT_SIZE_BYTES > bytes.length) {
    return {
      ok: false,
      failure: {
        kind: 'too_short',
        bytesAvailable: Math.max(0, bytes.length - offset),
        bytesRequired: WILD_POKEMON_INFO_STRUCT_SIZE_BYTES,
      },
    };
  }

  const encounterRate = bytes[offset + 0x00] ?? 0;
  const pad1 = bytes[offset + 0x01] ?? 0;
  const pad2 = bytes[offset + 0x02] ?? 0;
  const pad3 = bytes[offset + 0x03] ?? 0;
  const slotsPtrRaw = readUint32Le(bytes, offset + 0x04);

  if (pad1 !== 0 || pad2 !== 0 || pad3 !== 0) {
    return { ok: false, failure: { kind: 'nonzero_padding', pad1, pad2, pad3 } };
  }
  if (encounterRate > encounterRateMax) {
    return {
      ok: false,
      failure: { kind: 'implausible_encounter_rate', observed: encounterRate, max: encounterRateMax },
    };
  }

  let slotsOffset: number | null;
  if (slotsPtrRaw === 0) {
    slotsOffset = null;
  } else {
    if (slotsPtrRaw < GBA_ROM_BASE_ADDRESS || slotsPtrRaw > GBA_ROM_POINTER_UPPER) {
      return { ok: false, failure: { kind: 'invalid_slots_pointer', rawAddress: slotsPtrRaw } };
    }
    const candidate = slotsPtrRaw - GBA_ROM_BASE_ADDRESS;
    if (candidate < 0 || candidate >= bytes.length) {
      return { ok: false, failure: { kind: 'invalid_slots_pointer', rawAddress: slotsPtrRaw } };
    }
    slotsOffset = candidate;
  }

  const slots: WildPokemon[] = [];
  if (slotsOffset !== null) {
    for (let i = 0; i < slotCount; i++) {
      const slotOffset = slotsOffset + i * WILD_POKEMON_SLOT_SIZE_BYTES;
      const r = parseWildPokemon(bytes, slotOffset, { speciesMax });
      if (!r.ok) break;
      slots.push(r.slot);
    }
  }

  return {
    ok: true,
    info: Object.freeze({
      encounterRate,
      slotsOffset,
      slotCount: slots.length,
      slots: Object.freeze(slots),
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
