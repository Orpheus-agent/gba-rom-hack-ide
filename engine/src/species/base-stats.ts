/**
 * Gen-3 BaseStats struct parser.
 *
 * Per pret/pokefirered + pret/pokeemerald, every species (vanilla 411,
 * heavy-hack expanded ROMs up to ~700+) has a 28-byte BaseStats entry
 * in a flat `gBaseStats` array. Layout:
 *
 *   struct BaseStats {
 *     u8  baseHP;                       // 0x00
 *     u8  baseAttack;                   // 0x01
 *     u8  baseDefense;                  // 0x02
 *     u8  baseSpeed;                    // 0x03
 *     u8  baseSpAttack;                 // 0x04
 *     u8  baseSpDefense;                // 0x05
 *     u8  type1;                        // 0x06 - 0..17 in vanilla
 *     u8  type2;                        // 0x07 - 0..17
 *     u8  catchRate;                    // 0x08
 *     u8  expYield;                     // 0x09
 *     u8  evYieldBits_low;              // 0x0A (HP/Atk/Def/Spd in 2-bit fields)
 *     u8  evYieldBits_high;             // 0x0B (SpAtk/SpDef in 2-bit fields, top 4 bits = 0 padding_A)
 *     u16 item1;                        // 0x0C
 *     u16 item2;                        // 0x0E
 *     u8  genderRatio;                  // 0x10
 *     u8  eggCycles;                    // 0x11
 *     u8  friendship;                   // 0x12
 *     u8  growthRate;                   // 0x13 - 0..5 (6 vanilla growth rates)
 *     u8  eggGroup1;                    // 0x14 - 0..14
 *     u8  eggGroup2;                    // 0x15 - 0..14
 *     u8  ability1;                     // 0x16
 *     u8  ability2;                     // 0x17
 *     u8  safariZoneFleeRate;           // 0x18
 *     u8  bodyColorAndNoFlip;           // 0x19 (low 7 = bodyColor, top 1 = noFlip)
 *     u8  paddingB[0];                  // 0x1A - always 0
 *     u8  paddingB[1];                  // 0x1B - always 0
 *   };  // 28 bytes
 *
 * Detection signature: type1/type2 ≤17, growthRate ≤5, eggGroup1/2 ≤14,
 * abilities ≤200 (vanilla 76; heavy-hacks expand), padding bytes 0x1A
 * and 0x1B both ZERO (this is the strongest single signal - random ROM
 * bytes hit this only ~0.0015% of the time), evYield padding_A bits 4..7
 * of 0x0B also 0, AND at least one stat (HP/Atk/Def/etc.) non-zero.
 *
 * False-positive rate per random 28-byte slice: < 1 in 10^9 thanks to
 * the combined padding + type + growth + egg-group + non-all-zero
 * constraints.
 *
 * PD 5: structural-only - no baked species-table offsets; works on any
 * Gen-3 cart whose BaseStats struct retains the published layout.
 */

export const BASE_STATS_STRUCT_SIZE_BYTES = 28;
/** Highest plausible type byte. Vanilla Gen-3 has 18 types (0..17). */
export const BASE_STATS_TYPE_MAX = 17;
/** Highest plausible growthRate byte. Vanilla Gen-3 has 6 growth rates. */
export const BASE_STATS_GROWTH_RATE_MAX = 5;
/** Highest plausible eggGroup byte. Vanilla Gen-3 has 16 egg groups
 *  (0..15 inclusive). EGG_GROUP_UNDISCOVERED is 15 and is used by
 *  every legendary + baby Pokémon - rejecting 15 would drop ~30 vanilla
 *  entries (Mewtwo, Mew, Lugia, Ho-Oh, Articuno, Zapdos, Moltres, all
 *  legendaries, etc.). RT-1.2 bumped this from 14 → 15. */
export const BASE_STATS_EGG_GROUP_MAX = 15;
/** Highest plausible ability byte. Vanilla 76; heavy hacks expand. */
export const BASE_STATS_ABILITY_MAX = 200;

export interface BaseStats {
  readonly baseHP: number;
  readonly baseAttack: number;
  readonly baseDefense: number;
  readonly baseSpeed: number;
  readonly baseSpAttack: number;
  readonly baseSpDefense: number;
  readonly type1: number;
  readonly type2: number;
  readonly catchRate: number;
  readonly expYield: number;
  readonly item1: number;
  readonly item2: number;
  readonly genderRatio: number;
  readonly eggCycles: number;
  readonly friendship: number;
  readonly growthRate: number;
  readonly eggGroup1: number;
  readonly eggGroup2: number;
  readonly ability1: number;
  readonly ability2: number;
  readonly safariZoneFleeRate: number;
  /** ROM file offset of this BaseStats struct's first byte. */
  readonly fileOffset: number;
}

export type BaseStatsParseFailure =
  | { kind: 'too_short'; bytesAvailable: number; bytesRequired: number }
  | { kind: 'implausible_type'; field: 'type1' | 'type2'; observed: number; max: number }
  | { kind: 'implausible_growth_rate'; observed: number; max: number }
  | {
      kind: 'implausible_egg_group';
      field: 'eggGroup1' | 'eggGroup2';
      observed: number;
      max: number;
    }
  | {
      kind: 'implausible_ability';
      field: 'ability1' | 'ability2';
      observed: number;
      max: number;
    }
  | {
      kind: 'nonzero_padding';
      paddingB0: number;
      paddingB1: number;
      paddingAUpper4: number;
    }
  | { kind: 'all_zero_stats' };

export type BaseStatsParseResult =
  | { ok: true; baseStats: BaseStats }
  | { ok: false; failure: BaseStatsParseFailure };

/** Parse 28 bytes at `offset` as a Gen-3 BaseStats struct. */
export function parseBaseStats(bytes: Uint8Array, offset: number): BaseStatsParseResult {
  if (offset < 0 || offset + BASE_STATS_STRUCT_SIZE_BYTES > bytes.length) {
    return {
      ok: false,
      failure: {
        kind: 'too_short',
        bytesAvailable: Math.max(0, bytes.length - offset),
        bytesRequired: BASE_STATS_STRUCT_SIZE_BYTES,
      },
    };
  }

  const baseHP = bytes[offset + 0x00] ?? 0;
  const baseAttack = bytes[offset + 0x01] ?? 0;
  const baseDefense = bytes[offset + 0x02] ?? 0;
  const baseSpeed = bytes[offset + 0x03] ?? 0;
  const baseSpAttack = bytes[offset + 0x04] ?? 0;
  const baseSpDefense = bytes[offset + 0x05] ?? 0;
  const type1 = bytes[offset + 0x06] ?? 0;
  const type2 = bytes[offset + 0x07] ?? 0;
  const catchRate = bytes[offset + 0x08] ?? 0;
  const expYield = bytes[offset + 0x09] ?? 0;
  // evYield bits: u16 at 0x0A,0x0B. Upper 4 bits of 0x0B = padding_A must be 0.
  const evYieldByte0 = bytes[offset + 0x0a] ?? 0;
  const evYieldByte1 = bytes[offset + 0x0b] ?? 0;
  const paddingAUpper4 = (evYieldByte1 >> 4) & 0x0f;
  const item1 = readUint16Le(bytes, offset + 0x0c);
  const item2 = readUint16Le(bytes, offset + 0x0e);
  const genderRatio = bytes[offset + 0x10] ?? 0;
  const eggCycles = bytes[offset + 0x11] ?? 0;
  const friendship = bytes[offset + 0x12] ?? 0;
  const growthRate = bytes[offset + 0x13] ?? 0;
  const eggGroup1 = bytes[offset + 0x14] ?? 0;
  const eggGroup2 = bytes[offset + 0x15] ?? 0;
  const ability1 = bytes[offset + 0x16] ?? 0;
  const ability2 = bytes[offset + 0x17] ?? 0;
  const safariZoneFleeRate = bytes[offset + 0x18] ?? 0;
  // bodyColor+noFlip at 0x19 (no constraint to check).
  const paddingB0 = bytes[offset + 0x1a] ?? 0;
  const paddingB1 = bytes[offset + 0x1b] ?? 0;

  // 1. Padding check FIRST (cheapest + strongest signal).
  if (paddingB0 !== 0 || paddingB1 !== 0 || paddingAUpper4 !== 0) {
    return {
      ok: false,
      failure: { kind: 'nonzero_padding', paddingB0, paddingB1, paddingAUpper4 },
    };
  }
  // 2. Type bytes.
  if (type1 > BASE_STATS_TYPE_MAX) {
    return {
      ok: false,
      failure: { kind: 'implausible_type', field: 'type1', observed: type1, max: BASE_STATS_TYPE_MAX },
    };
  }
  if (type2 > BASE_STATS_TYPE_MAX) {
    return {
      ok: false,
      failure: { kind: 'implausible_type', field: 'type2', observed: type2, max: BASE_STATS_TYPE_MAX },
    };
  }
  // 3. Growth rate.
  if (growthRate > BASE_STATS_GROWTH_RATE_MAX) {
    return {
      ok: false,
      failure: {
        kind: 'implausible_growth_rate',
        observed: growthRate,
        max: BASE_STATS_GROWTH_RATE_MAX,
      },
    };
  }
  // 4. Egg groups.
  if (eggGroup1 > BASE_STATS_EGG_GROUP_MAX) {
    return {
      ok: false,
      failure: {
        kind: 'implausible_egg_group',
        field: 'eggGroup1',
        observed: eggGroup1,
        max: BASE_STATS_EGG_GROUP_MAX,
      },
    };
  }
  if (eggGroup2 > BASE_STATS_EGG_GROUP_MAX) {
    return {
      ok: false,
      failure: {
        kind: 'implausible_egg_group',
        field: 'eggGroup2',
        observed: eggGroup2,
        max: BASE_STATS_EGG_GROUP_MAX,
      },
    };
  }
  // 5. Abilities.
  if (ability1 > BASE_STATS_ABILITY_MAX) {
    return {
      ok: false,
      failure: {
        kind: 'implausible_ability',
        field: 'ability1',
        observed: ability1,
        max: BASE_STATS_ABILITY_MAX,
      },
    };
  }
  if (ability2 > BASE_STATS_ABILITY_MAX) {
    return {
      ok: false,
      failure: {
        kind: 'implausible_ability',
        field: 'ability2',
        observed: ability2,
        max: BASE_STATS_ABILITY_MAX,
      },
    };
  }
  // 6. At least one stat non-zero (rejects zero-fill).
  const statSum =
    baseHP + baseAttack + baseDefense + baseSpeed + baseSpAttack + baseSpDefense;
  if (statSum === 0) {
    return { ok: false, failure: { kind: 'all_zero_stats' } };
  }

  return {
    ok: true,
    baseStats: Object.freeze({
      baseHP,
      baseAttack,
      baseDefense,
      baseSpeed,
      baseSpAttack,
      baseSpDefense,
      type1,
      type2,
      catchRate,
      expYield,
      item1,
      item2,
      genderRatio,
      eggCycles,
      friendship,
      growthRate,
      eggGroup1,
      eggGroup2,
      ability1,
      ability2,
      safariZoneFleeRate,
      fileOffset: offset,
    }),
  };
  // evYield bytes are stored but not exposed (per-stat 2-bit fields
  // are §15 Phase 8 deeper-task work).
  void evYieldByte0; // suppress unused
}

function readUint16Le(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8)) >>> 0;
}
