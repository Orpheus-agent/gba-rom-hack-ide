/**
 * Gen-3 Type Effectiveness Chart parser - Phase UW-2 / Category 4 substrate.
 *
 * Per pret/pokefirered + pret/pokeemerald `src/data/battle_main.c`
 * (sTypeEffectivenessTable / gTypeEffectiveness), Gen-3 stores type
 * effectiveness as a flat array of 3-byte triplets:
 *
 *   struct TypeMatchup {
 *     u8 attackerType;   // 0..17, or 0xFE foresight separator, or 0xFF terminator
 *     u8 defenderType;   // 0..17, or 0xFE foresight separator, or 0xFF terminator
 *     u8 effectiveness;  // ×10 multiplier: 0=immune, 5=resisted 0.5x, 10=neutral 1x,
 *                        //                 20=super 2x, 40=super² 4x (rare)
 *   };  // 3 bytes
 *
 * The table contains ONLY non-neutral matchups (absence ⇒ 1.0x). Vanilla
 * Gen-3 has ~106 real matchup triplets, then a single foresight separator
 * (0xFE 0xFE 0x00), then a handful of post-foresight matchups (ghost-typed
 * defenders becoming hittable by Normal/Fighting), then the terminator
 * (0xFF 0xFF 0x00).
 *
 * The published encoding values per pret:
 *   #define TYPE_x0_00   0   //  0.0x  (immune)
 *   #define TYPE_x0_50   5   //  0.5x
 *   #define TYPE_x1_00  10   //  1.0x  (rare - not normally stored)
 *   #define TYPE_x2_00  20   //  2.0x
 *   #define TYPE_FORESIGHT  0xFE
 *   #define TYPE_ENDTABLE   0xFF
 *
 * Detection signature per triplet:
 *   - attacker in [0..17] AND defender in [0..17] AND effectiveness in {0,5,20}
 *     (the "real matchup" form - covers ~99% of entries)
 *   - OR (attacker==0xFE AND defender==0xFE AND effectiveness==0) - foresight separator
 *   - OR (attacker==0xFF AND defender==0xFF AND effectiveness==0) - table terminator
 *
 * Per-triplet false-positive rate from random bytes:
 *   18*18 = 324 valid (a,d) combos out of 256² = 65536 ⇒ ~0.49% pair probability
 *   * 4/256 valid effectiveness bytes ⇒ ~0.0077% per triplet
 *   Run of ≥30 valid triplets in a row from random bytes ≈ 10⁻¹²² - vanishingly unlikely.
 *
 * PD 5: structural-only - no baked offsets; works on any Gen-3 cart whose
 * type chart retains the published 3-byte triplet shape.
 */

/** Size in bytes of one TypeMatchup triplet. */
export const TYPE_MATCHUP_SIZE_BYTES = 3;

/** Highest valid Gen-3 type ID (0..17 = 18 types). */
export const TYPE_CHART_TYPE_MAX = 17;

/** Sentinel byte introducing the foresight (post-foresight rules) section. */
export const TYPE_CHART_FORESIGHT_SENTINEL = 0xfe;

/** Sentinel byte marking end-of-table. */
export const TYPE_CHART_ENDTABLE_SENTINEL = 0xff;

/** Effectiveness byte values seen in vanilla Gen-3 tables. */
export const TYPE_CHART_EFFECTIVENESS_IMMUNE = 0;
export const TYPE_CHART_EFFECTIVENESS_NOT_VERY = 5;
export const TYPE_CHART_EFFECTIVENESS_NORMAL = 10;
export const TYPE_CHART_EFFECTIVENESS_SUPER = 20;

const VALID_EFFECTIVENESS_VALUES = new Set([
  TYPE_CHART_EFFECTIVENESS_IMMUNE,
  TYPE_CHART_EFFECTIVENESS_NOT_VERY,
  TYPE_CHART_EFFECTIVENESS_NORMAL,
  TYPE_CHART_EFFECTIVENESS_SUPER,
]);

/** Kind of one parsed triplet - distinguishes real matchups from sentinels. */
export type TypeMatchupKind = 'matchup' | 'foresight_separator' | 'end_table';

export interface TypeMatchup {
  readonly kind: TypeMatchupKind;
  readonly attackerType: number;
  readonly defenderType: number;
  readonly effectiveness: number;
}

export type TypeMatchupParseFailure =
  | { readonly kind: 'attacker_out_of_range' }
  | { readonly kind: 'defender_out_of_range' }
  | { readonly kind: 'effectiveness_out_of_range' }
  | { readonly kind: 'malformed_sentinel' }
  | { readonly kind: 'out_of_bounds' };

export type TypeMatchupParseResult =
  | { readonly ok: true; readonly value: TypeMatchup }
  | { readonly ok: false; readonly failure: TypeMatchupParseFailure };

/**
 * Parse a single 3-byte triplet from `bytes` starting at `offset`.
 *
 * Recognizes three forms: a real (attacker, defender, effectiveness) matchup
 * with all three fields in their valid ranges; the foresight separator
 * (0xFE 0xFE 0x00); the end-table sentinel (0xFF 0xFF 0x00).
 *
 * All other byte combinations return an `ok: false` failure with a typed
 * `kind`, so the scanner can stop the walk at the first invalid triplet
 * without false-positive absorption.
 */
export function parseTypeMatchup(
  bytes: Uint8Array,
  offset: number,
): TypeMatchupParseResult {
  if (offset < 0 || offset + TYPE_MATCHUP_SIZE_BYTES > bytes.byteLength) {
    return { ok: false, failure: { kind: 'out_of_bounds' } };
  }
  const attackerType = bytes[offset]!;
  const defenderType = bytes[offset + 1]!;
  const effectiveness = bytes[offset + 2]!;

  // End-table sentinel.
  if (attackerType === TYPE_CHART_ENDTABLE_SENTINEL) {
    if (defenderType !== TYPE_CHART_ENDTABLE_SENTINEL || effectiveness !== 0) {
      return { ok: false, failure: { kind: 'malformed_sentinel' } };
    }
    return {
      ok: true,
      value: { kind: 'end_table', attackerType, defenderType, effectiveness },
    };
  }

  // Foresight separator sentinel.
  if (attackerType === TYPE_CHART_FORESIGHT_SENTINEL) {
    if (
      defenderType !== TYPE_CHART_FORESIGHT_SENTINEL ||
      effectiveness !== 0
    ) {
      return { ok: false, failure: { kind: 'malformed_sentinel' } };
    }
    return {
      ok: true,
      value: {
        kind: 'foresight_separator',
        attackerType,
        defenderType,
        effectiveness,
      },
    };
  }

  // Real matchup.
  if (attackerType > TYPE_CHART_TYPE_MAX) {
    return { ok: false, failure: { kind: 'attacker_out_of_range' } };
  }
  if (defenderType > TYPE_CHART_TYPE_MAX) {
    return { ok: false, failure: { kind: 'defender_out_of_range' } };
  }
  if (!VALID_EFFECTIVENESS_VALUES.has(effectiveness)) {
    return { ok: false, failure: { kind: 'effectiveness_out_of_range' } };
  }
  return {
    ok: true,
    value: { kind: 'matchup', attackerType, defenderType, effectiveness },
  };
}
