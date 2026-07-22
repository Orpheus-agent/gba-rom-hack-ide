/**
 * Gen-3 TrainerPartyMember struct parser - iter 107 / UW-3-T26.
 *
 * Per pret/pokefirered + pret/pokeemerald, each trainer's party is a
 * variable-length array of party-member structs. The struct size + shape
 * depends on the trainer's `partyFlags` byte (bits 0+1):
 *
 *   bit 0 = F_TRAINER_PARTY_CUSTOM_MOVESET (each member has 4 custom moves)
 *   bit 1 = F_TRAINER_PARTY_HELD_ITEM      (each member has a held item)
 *
 * The 4 variants:
 *
 *   kind 0 (flags == 0):  struct TrainerMonNoItemDefaultMoves {
 *     u16 iv;          // 0x00 - IV value 0..255 (compacted to all 6 stats)
 *     u16 level;       // 0x02 - 1..100
 *     u16 species;     // 0x04 - species id
 *     u16 padding;     // 0x06 - 0
 *   };  // 8 bytes
 *
 *   kind 1 (flags == 2 = held item only):  struct TrainerMonItemDefaultMoves {
 *     u16 iv;          // 0x00
 *     u16 level;       // 0x02
 *     u16 species;     // 0x04
 *     u16 heldItem;    // 0x06 - item id
 *   };  // 8 bytes
 *
 *   kind 2 (flags == 1 = custom moves only):  struct TrainerMonNoItemCustomMoves {
 *     u16 iv;          // 0x00
 *     u16 level;       // 0x02
 *     u16 species;     // 0x04
 *     u16 padding;     // 0x06 - 0
 *     u16 moves[4];    // 0x08..0x0F - 4 move ids (0 if unused)
 *   };  // 16 bytes
 *
 *   kind 3 (flags == 3 = both):  struct TrainerMonItemCustomMoves {
 *     u16 iv;          // 0x00
 *     u16 level;       // 0x02
 *     u16 species;     // 0x04
 *     u16 heldItem;    // 0x06
 *     u16 moves[4];    // 0x08..0x0F
 *   };  // 16 bytes
 *
 * PD 5: structural-only - no baked species/move/item counts; works on
 * vanilla + every hack that retains the 4-variant layout.
 *
 * Validation per parsed member:
 *   - level in [1, 100] (engine spec; some Gen-3 hacks raise the cap but
 *     vanilla caps at 100 and trainer parties never exceed it)
 *   - iv ≤ 255 (vanilla spec; IV compaction byte)
 *   - species ≤ 2000 (cap covers Radical Red 800+, Unbound 1000+; rejects
 *     obviously-corrupt random bytes)
 *   - moves[i] ≤ 2000 (same cap reasoning)
 */

export const PARTY_MEMBER_SIZE_BYTES_NO_MOVES = 8;
export const PARTY_MEMBER_SIZE_BYTES_WITH_MOVES = 16;

/** Highest plausible species id (covers Radical Red + Unbound; rejects
 *  random garbage). */
export const PARTY_MEMBER_SPECIES_MAX = 2000;

/** Highest plausible level. */
export const PARTY_MEMBER_LEVEL_MAX = 100;

/** Highest plausible IV-compaction byte. */
export const PARTY_MEMBER_IV_MAX = 255;

/** Per the 4 variants. */
export type TrainerPartyMemberKind = 0 | 1 | 2 | 3;

export interface TrainerPartyMemberParsed {
  readonly iv: number;
  readonly level: number;
  readonly species: number;
  /** Held item id (0 when no held item; absent flag = field zero/padding). */
  readonly heldItem: number;
  /** 4 move ids in order (all 0 when no custom moveset). */
  readonly moves: ReadonlyArray<number>;
  /** Absolute file offset of this member struct. */
  readonly fileOffset: number;
  /** Member-struct kind (matches partyFlags 0..3). */
  readonly kind: TrainerPartyMemberKind;
}

export type TrainerPartyMemberParseFailure =
  | { readonly kind: 'too_short'; readonly bytesAvailable: number; readonly bytesRequired: number }
  | { readonly kind: 'invalid_level'; readonly observed: number; readonly max: number }
  | { readonly kind: 'invalid_iv'; readonly observed: number; readonly max: number }
  | { readonly kind: 'invalid_species'; readonly observed: number; readonly max: number }
  | { readonly kind: 'invalid_move'; readonly slot: number; readonly observed: number; readonly max: number }
  | { readonly kind: 'invalid_party_flags'; readonly observed: number };

export type TrainerPartyMemberParseResult =
  | { readonly ok: true; readonly member: TrainerPartyMemberParsed }
  | { readonly ok: false; readonly failure: TrainerPartyMemberParseFailure };

/** Compute the per-member struct size given the trainer's partyFlags. */
export function partyMemberStructSize(partyFlags: number): number {
  // bit 0 (custom moves) doubles the struct size; bit 1 (held item) does
  // not affect size (held item occupies what was padding in kind 0).
  return (partyFlags & 0x01) !== 0
    ? PARTY_MEMBER_SIZE_BYTES_WITH_MOVES
    : PARTY_MEMBER_SIZE_BYTES_NO_MOVES;
}

function readU16LE(bytes: Uint8Array, offset: number): number {
  return bytes[offset]! | (bytes[offset + 1]! << 8);
}

/** Parse one party-member struct at `bytes[offset..offset + size]`.
 *  `partyFlags` (0..3) selects the struct variant. */
export function parseTrainerPartyMember(
  bytes: Uint8Array,
  offset: number,
  partyFlags: number,
): TrainerPartyMemberParseResult {
  if (partyFlags < 0 || partyFlags > 3) {
    return { ok: false, failure: { kind: 'invalid_party_flags', observed: partyFlags } };
  }
  const structSize = partyMemberStructSize(partyFlags);
  if (offset < 0 || offset + structSize > bytes.length) {
    return {
      ok: false,
      failure: {
        kind: 'too_short',
        bytesAvailable: Math.max(0, bytes.length - offset),
        bytesRequired: structSize,
      },
    };
  }
  const iv = readU16LE(bytes, offset + 0x00);
  if (iv > PARTY_MEMBER_IV_MAX) {
    return { ok: false, failure: { kind: 'invalid_iv', observed: iv, max: PARTY_MEMBER_IV_MAX } };
  }
  const level = readU16LE(bytes, offset + 0x02);
  if (level < 1 || level > PARTY_MEMBER_LEVEL_MAX) {
    return {
      ok: false,
      failure: { kind: 'invalid_level', observed: level, max: PARTY_MEMBER_LEVEL_MAX },
    };
  }
  const species = readU16LE(bytes, offset + 0x04);
  if (species > PARTY_MEMBER_SPECIES_MAX) {
    return {
      ok: false,
      failure: { kind: 'invalid_species', observed: species, max: PARTY_MEMBER_SPECIES_MAX },
    };
  }
  // heldItem field overlaps padding when bit 1 is clear - it's 0 in that
  // case. When bit 1 is set, it's a real item id (still uncapped - items
  // span 0..~1500 in heavy hacks).
  const heldItemFieldRaw = readU16LE(bytes, offset + 0x06);
  const hasHeldItem = (partyFlags & 0x02) !== 0;
  const heldItem = hasHeldItem ? heldItemFieldRaw : 0;
  // moves[4] present when bit 0 is set.
  const hasMoves = (partyFlags & 0x01) !== 0;
  const moves: number[] = [];
  if (hasMoves) {
    for (let i = 0; i < 4; i++) {
      const m = readU16LE(bytes, offset + 0x08 + i * 2);
      if (m > PARTY_MEMBER_SPECIES_MAX) {
        return {
          ok: false,
          failure: { kind: 'invalid_move', slot: i, observed: m, max: PARTY_MEMBER_SPECIES_MAX },
        };
      }
      moves.push(m);
    }
  }
  return {
    ok: true,
    member: {
      iv,
      level,
      species,
      heldItem,
      moves: Object.freeze(moves),
      fileOffset: offset,
      kind: partyFlags as TrainerPartyMemberKind,
    },
  };
}

/** Convenience: parse `partySize` consecutive members starting at
 *  `arrayStartOffset`. Bails on first parse failure and returns what was
 *  successfully parsed plus the failure reason. */
export function parseTrainerPartyArray(
  bytes: Uint8Array,
  arrayStartOffset: number,
  partyFlags: number,
  partySize: number,
): {
  readonly members: ReadonlyArray<TrainerPartyMemberParsed>;
  readonly failureAtIndex: number | null;
  readonly failureReason: TrainerPartyMemberParseFailure | null;
} {
  const structSize = partyMemberStructSize(partyFlags);
  const members: TrainerPartyMemberParsed[] = [];
  for (let i = 0; i < partySize; i++) {
    const memberOffset = arrayStartOffset + i * structSize;
    const r = parseTrainerPartyMember(bytes, memberOffset, partyFlags);
    if (!r.ok) {
      return {
        members: Object.freeze(members),
        failureAtIndex: i,
        failureReason: r.failure,
      };
    }
    members.push(r.member);
  }
  return {
    members: Object.freeze(members),
    failureAtIndex: null,
    failureReason: null,
  };
}
