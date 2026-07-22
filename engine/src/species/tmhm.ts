/**
 * Gen-3 TM/HM compatibility bitfield parser - Phase 8 P8-T6.
 *
 * Per pret/pokefirered (src/data/pokemon/tmhm_learnsets.h) and
 * pret/pokeemerald, every species has a single 64-bit bitfield
 * entry in `gTMHMLearnsets[NUM_SPECIES]`. Each set bit means "this
 * species can learn TM/HM number `bit_index`":
 *
 *   const u64 gTMHMLearnsets[NUM_SPECIES] = {
 *     [SPECIES_NONE]      = 0,
 *     [SPECIES_BULBASAUR] = TMHM_LEARNSET(TMHM(TM06_TOXIC) | TMHM(TM09_BULLET_SEED) | ...),
 *     [SPECIES_MEW]       = ULLBITFIELD_ALL_TMS_HMS,  // every bit 0..57
 *     ...
 *   };
 *
 * TM/HM index layout (vanilla):
 *   bits  0..49  → TM01..TM50  (50 TMs)
 *   bits 50..57  → HM01..HM08  (8 HMs)
 *   bits 58..63  → unused (always 0 in vanilla)
 *
 * Detection signature for a single 8-byte (u64 little-endian) slot:
 *   - Upper 6 bits (TMHM_UPPER_RESERVED_BITS shift) must be 0 - 
 *     this is the strongest single signal. Random 8 bytes hit
 *     "top 6 bits zero" with probability 1/64.
 *   - Bottom 58 bits set count (popcount) ≤ TMHM_MAX_SET_BITS (58).
 *     Always trivially true given the format, but explicit.
 *
 * Pre-table-acceptance signal (run-level): the table is contiguous
 * per-species. Require ≥ N consecutive slots all passing AND
 * ≥ M slots with ≥ 1 bit set (to defeat zero-fill matching).
 *
 * Vanilla Mew has all 58 TM/HM bits set (Universal Pokémon design);
 * Magikarp has 0 (it can't learn any). Both legitimate.
 *
 * PD 5: structural-only - no baked offsets; works on any Gen-3 cart
 * where the gTMHMLearnsets format is the published u64-per-species
 * layout.
 */

export const TMHM_STRUCT_SIZE_BYTES = 8;
/** Number of bits per TM/HM slot used in vanilla Gen-3. Bits 58..63
 *  are always 0 because vanilla has 50 TMs + 8 HMs = 58 entries. */
export const TMHM_USED_BIT_COUNT = 58;
/** Number of TM/HM bits expected to be zero at the high end of each
 *  u64 slot. Equals 64 - 58 = 6 in vanilla. */
export const TMHM_RESERVED_BIT_COUNT = 64 - TMHM_USED_BIT_COUNT;
/** Maximum number of TM/HM bits a single species can have set.
 *  Vanilla Mew has all 58. Heavy hacks bump this up to 100+. */
export const TMHM_MAX_SET_BITS = 100;
/** Vanilla TM count (TM01..TM50). */
export const TMHM_TM_COUNT = 50;
/** Vanilla HM count (HM01..HM08). */
export const TMHM_HM_COUNT = 8;

export interface TMHMCompat {
  /** Raw u64 as { low, high } pair (avoids requiring BigInt in
   *  callers). low = bits 0..31, high = bits 32..63. */
  readonly low: number;
  readonly high: number;
  /** Indices of every set bit in the bottom 58. */
  readonly setBitIndices: ReadonlyArray<number>;
  /** Convenience: count of set bits (popcount of bottom 58). */
  readonly setBitCount: number;
  /** Convenience: setBitIndices filtered to [0..49] = TMs. */
  readonly compatibleTmIndices: ReadonlyArray<number>;
  /** Convenience: setBitIndices filtered to [50..57] minus 50 = HMs (0..7). */
  readonly compatibleHmIndices: ReadonlyArray<number>;
  /** ROM file offset of this 8-byte slot. */
  readonly fileOffset: number;
}

export type TMHMParseFailure =
  | { kind: 'too_short'; bytesAvailable: number; bytesRequired: number }
  | { kind: 'reserved_bits_set'; observedHighBits: number }
  | { kind: 'too_many_bits_set'; observed: number; max: number };

export type TMHMParseResult =
  | { ok: true; tmhm: TMHMCompat }
  | { ok: false; failure: TMHMParseFailure };

export interface ParseTMHMOptions {
  readonly maxSetBits?: number;
}

/** Parse 8 bytes at `offset` as a u64 TM/HM compatibility bitfield. */
export function parseTMHMCompat(
  bytes: Uint8Array,
  offset: number,
  opts?: ParseTMHMOptions,
): TMHMParseResult {
  const maxSetBits = opts?.maxSetBits ?? TMHM_MAX_SET_BITS;
  if (offset < 0 || offset + TMHM_STRUCT_SIZE_BYTES > bytes.length) {
    return {
      ok: false,
      failure: {
        kind: 'too_short',
        bytesAvailable: Math.max(0, bytes.length - offset),
        bytesRequired: TMHM_STRUCT_SIZE_BYTES,
      },
    };
  }

  const low = readUint32Le(bytes, offset);
  const high = readUint32Le(bytes, offset + 4);

  // Top 6 bits (bits 58..63) must be 0. In the `high` half-word
  // these are bits 26..31, mask 0xfc000000.
  const observedHighBits = (high >>> (TMHM_USED_BIT_COUNT - 32)) & 0x3f;
  if (observedHighBits !== 0) {
    return { ok: false, failure: { kind: 'reserved_bits_set', observedHighBits } };
  }

  // Count set bits in bottom 58, collect indices.
  const setBitIndices: number[] = [];
  for (let b = 0; b < 32; b++) {
    if (((low >>> b) & 1) === 1) setBitIndices.push(b);
  }
  for (let b = 0; b < TMHM_USED_BIT_COUNT - 32; b++) {
    if (((high >>> b) & 1) === 1) setBitIndices.push(32 + b);
  }

  if (setBitIndices.length > maxSetBits) {
    return {
      ok: false,
      failure: {
        kind: 'too_many_bits_set',
        observed: setBitIndices.length,
        max: maxSetBits,
      },
    };
  }

  const compatibleTmIndices = setBitIndices.filter((b) => b < TMHM_TM_COUNT);
  const compatibleHmIndices = setBitIndices
    .filter((b) => b >= TMHM_TM_COUNT && b < TMHM_USED_BIT_COUNT)
    .map((b) => b - TMHM_TM_COUNT);

  return {
    ok: true,
    tmhm: Object.freeze({
      low,
      high,
      setBitIndices: Object.freeze(setBitIndices),
      setBitCount: setBitIndices.length,
      compatibleTmIndices: Object.freeze(compatibleTmIndices),
      compatibleHmIndices: Object.freeze(compatibleHmIndices),
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
