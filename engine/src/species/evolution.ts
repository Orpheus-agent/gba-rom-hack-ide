/**
 * Gen-3 Evolution + per-species evolution block parsers - Phase 8 P8-T4.
 *
 * Per pret/pokefirered (src/data/pokemon/evolution.h + include/
 * constants/pokemon.h) and pret/pokeemerald, every species has a
 * fixed 5-entry slot block in `gEvolutionTable`. Each slot is an
 * 8-byte `Evolution` struct:
 *
 *   struct Evolution {
 *     u16 method;          // 0x00 - EVO_* method code
 *     u16 param;           // 0x02 - method-dependent (level, item, etc.)
 *     u16 targetSpecies;   // 0x04 - species index post-evolution
 *     u16 _padding;        // 0x06 - must be 0
 *   };  // 8 bytes
 *
 *   // gEvolutionTable[species][5]: 40 bytes per species.
 *
 * EVO_NONE (method == 0) marks an empty slot - vanilla species like
 * Tauros or legendaries have ALL 5 slots EVO_NONE (block is all-zero
 * = legitimate "no evolutions").
 *
 * Vanilla method codes (FireRed/Emerald, include/constants/pokemon.h):
 *   EVO_NONE                = 0
 *   EVO_FRIENDSHIP          = 1
 *   EVO_FRIENDSHIP_DAY      = 2
 *   EVO_FRIENDSHIP_NIGHT    = 3
 *   EVO_LEVEL               = 4
 *   EVO_TRADE               = 5
 *   EVO_TRADE_ITEM          = 6
 *   EVO_ITEM                = 7
 *   EVO_LEVEL_ATK_GT_DEF    = 8
 *   EVO_LEVEL_ATK_EQ_DEF    = 9
 *   EVO_LEVEL_ATK_LT_DEF    = 10
 *   EVO_LEVEL_SILCOON       = 11
 *   EVO_LEVEL_CASCOON       = 12
 *   EVO_LEVEL_NINJASK       = 13
 *   EVO_LEVEL_SHEDINJA      = 14
 *   EVO_BEAUTY              = 15
 *
 * CFRU + expansion frameworks add Mega-stone / item-hold / move-known
 * / map-based methods extending the range. Cap at 50 to tolerate
 * heavy hacks while still rejecting random 0xFFFF garbage as method.
 *
 * Detection signature for a single Evolution slot:
 *   - method ≤ EVOLUTION_METHOD_MAX (50)
 *   - targetSpecies ≤ EVOLUTION_SPECIES_MAX (2048)
 *   - padding (0x06..0x07) == 0
 *   - if method == 0 (EVO_NONE), the entire 8 bytes MUST be 0
 *     (this catches garbage that happens to have method=0)
 *
 * Per-species block (40 bytes) accepts a block iff every one of the
 * 5 slots passes the slot signature. An all-zero block (every slot
 * EVO_NONE) is the most common case in vanilla - legitimate.
 *
 * False-positive rate per random 40-byte slice: combined slot
 * signature + per-block 5×8 alignment + species-id bounds yields
 * <1e-15 per slice. A run of ≥ 8 consecutive valid blocks is
 * essentially certain to be the real gEvolutionTable.
 *
 * PD 5: structural-only - no baked offsets; works on any Gen-3 cart
 * whose Evolution struct retains the published layout.
 */

export const EVOLUTION_STRUCT_SIZE_BYTES = 8;
export const EVOLUTION_SLOTS_PER_SPECIES = 5;
export const EVOLUTION_BLOCK_SIZE_BYTES =
  EVOLUTION_SLOTS_PER_SPECIES * EVOLUTION_STRUCT_SIZE_BYTES; // 40
/** Highest plausible method code. Vanilla maxes 15; expansion
 *  frameworks add Mega / item-hold / move-known / map-based methods
 *  but rarely exceed ~30. 50 caps random 0xFFFF as method. */
export const EVOLUTION_METHOD_MAX = 50;
/** Highest plausible target species index. Vanilla 411; CFRU /
 *  expansion 700+; 2048 captures known heavy hacks. */
export const EVOLUTION_SPECIES_MAX = 2048;

/** Code 0 = EVO_NONE - the empty-slot marker. */
export const EVO_NONE = 0;

export interface Evolution {
  readonly method: number;
  readonly param: number;
  readonly targetSpecies: number;
  /** True iff method == 0 AND the rest of the slot is zero. */
  readonly isEmpty: boolean;
  /** ROM file offset of this 8-byte slot. */
  readonly fileOffset: number;
}

export interface EvolutionBlock {
  /** All 5 slots (some/all may be empty per `isEmpty`). */
  readonly slots: ReadonlyArray<Evolution>;
  /** Slots filtered to method != EVO_NONE. */
  readonly populatedSlots: ReadonlyArray<Evolution>;
  /** ROM file offset of this 40-byte per-species block. */
  readonly fileOffset: number;
}

export type EvolutionParseFailure =
  | { kind: 'too_short'; bytesAvailable: number; bytesRequired: number }
  | { kind: 'implausible_method'; observed: number; max: number }
  | { kind: 'implausible_species'; observed: number; max: number }
  | { kind: 'nonzero_padding'; observedPadding: number }
  | { kind: 'malformed_empty_slot'; method: number; param: number; targetSpecies: number };

export type EvolutionParseResult =
  | { ok: true; evolution: Evolution }
  | { ok: false; failure: EvolutionParseFailure };

export type EvolutionBlockParseFailure =
  | { kind: 'too_short'; bytesAvailable: number; bytesRequired: number }
  | {
      kind: 'slot_failure';
      slotIndex: number;
      slotFailure: EvolutionParseFailure;
    };

export type EvolutionBlockParseResult =
  | { ok: true; block: EvolutionBlock }
  | { ok: false; failure: EvolutionBlockParseFailure };

/** Parse a single 8-byte Evolution slot. */
export function parseEvolutionSlot(
  bytes: Uint8Array,
  offset: number,
): EvolutionParseResult {
  if (offset < 0 || offset + EVOLUTION_STRUCT_SIZE_BYTES > bytes.length) {
    return {
      ok: false,
      failure: {
        kind: 'too_short',
        bytesAvailable: Math.max(0, bytes.length - offset),
        bytesRequired: EVOLUTION_STRUCT_SIZE_BYTES,
      },
    };
  }

  const method = readUint16Le(bytes, offset + 0x00);
  const param = readUint16Le(bytes, offset + 0x02);
  const targetSpecies = readUint16Le(bytes, offset + 0x04);
  const padding = readUint16Le(bytes, offset + 0x06);

  // 1. Padding always 0.
  if (padding !== 0) {
    return { ok: false, failure: { kind: 'nonzero_padding', observedPadding: padding } };
  }
  // 2. method bound.
  if (method > EVOLUTION_METHOD_MAX) {
    return {
      ok: false,
      failure: { kind: 'implausible_method', observed: method, max: EVOLUTION_METHOD_MAX },
    };
  }
  // 3. species bound (0 = SPECIES_NONE = legitimate for EVO_NONE slots).
  if (targetSpecies > EVOLUTION_SPECIES_MAX) {
    return {
      ok: false,
      failure: { kind: 'implausible_species', observed: targetSpecies, max: EVOLUTION_SPECIES_MAX },
    };
  }
  // 4. EVO_NONE → param and targetSpecies must also be 0.
  if (method === EVO_NONE) {
    if (param !== 0 || targetSpecies !== 0) {
      return {
        ok: false,
        failure: { kind: 'malformed_empty_slot', method, param, targetSpecies },
      };
    }
  } else {
    // Non-empty slot - must have a valid post-evolution species (≥ 1).
    if (targetSpecies === 0) {
      return {
        ok: false,
        failure: { kind: 'malformed_empty_slot', method, param, targetSpecies },
      };
    }
  }

  return {
    ok: true,
    evolution: Object.freeze({
      method,
      param,
      targetSpecies,
      isEmpty: method === EVO_NONE,
      fileOffset: offset,
    }),
  };
}

/** Parse a per-species evolution block (5 × Evolution = 40 bytes). */
export function parseEvolutionBlock(
  bytes: Uint8Array,
  offset: number,
): EvolutionBlockParseResult {
  if (offset < 0 || offset + EVOLUTION_BLOCK_SIZE_BYTES > bytes.length) {
    return {
      ok: false,
      failure: {
        kind: 'too_short',
        bytesAvailable: Math.max(0, bytes.length - offset),
        bytesRequired: EVOLUTION_BLOCK_SIZE_BYTES,
      },
    };
  }

  const slots: Evolution[] = [];
  for (let i = 0; i < EVOLUTION_SLOTS_PER_SPECIES; i++) {
    const slotOffset = offset + i * EVOLUTION_STRUCT_SIZE_BYTES;
    const r = parseEvolutionSlot(bytes, slotOffset);
    if (!r.ok) {
      return { ok: false, failure: { kind: 'slot_failure', slotIndex: i, slotFailure: r.failure } };
    }
    slots.push(r.evolution);
  }

  const populatedSlots = slots.filter((s) => !s.isEmpty);
  return {
    ok: true,
    block: Object.freeze({
      slots: Object.freeze(slots),
      populatedSlots: Object.freeze(populatedSlots),
      fileOffset: offset,
    }),
  };
}

function readUint16Le(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8)) >>> 0;
}
