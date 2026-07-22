/**
 * Gen-3 level-up learnset parser - Phase 8 P8-T5.
 *
 * Per pret/pokefirered (src/data/pokemon/level_up_learnsets.h) and
 * pret/pokeemerald, each species has a level-up learnset stored as a
 * terminator-delimited u16 array. Each u16 packs:
 *
 *   bits 15..9 (7 bits)  = level   (0..127)
 *   bits  8..0 (9 bits)  = move id (0..511 vanilla; heavy hacks expand)
 *
 *   Terminator: 0xFFFF (LEVEL_UP_END)
 *
 *   Example (vanilla Bulbasaur):
 *     {
 *       LEVEL_UP_MOVE( 1, MOVE_TACKLE),
 *       LEVEL_UP_MOVE( 1, MOVE_GROWL),
 *       LEVEL_UP_MOVE( 7, MOVE_LEECH_SEED),
 *       LEVEL_UP_MOVE(10, MOVE_VINE_WHIP),
 *       ...
 *       LEVEL_UP_END,
 *     };
 *
 * The arrays are pointed at by `gLevelUpLearnsets[NUM_SPECIES]`, a
 * flat u32 ROM-pointer table (one entry per species). The pointer
 * table is what we scan for structurally (P8-T5 scanner); each
 * pointed-at byte range is then parsed by this module.
 *
 * Detection signature for a single entry u16:
 *   - level ∈ [0, LEARNSET_LEVEL_MAX] (default 100; vanilla cap)
 *   - move ∈ [1, LEARNSET_MOVE_MAX] (default 1024; vanilla 354,
 *     heavy hacks ~700 - 1024 covers known frameworks while still
 *     rejecting random 0xFFFE values which would look like move 510
 *     paired with level 127 (borderline plausible but suspicious).
 *
 * Detection signature for the full per-species array:
 *   - reads u16 entries until hitting LEARNSET_TERMINATOR (0xFFFF)
 *     OR a u16 fails the entry signature
 *   - acceptable result: at least the terminator (empty learnset
 *     = `{LEVEL_UP_END}` - vanilla SPECIES_NONE works this way)
 *   - failing result: read more than LEARNSET_MAX_ENTRIES without
 *     hitting terminator (probably not a real learnset)
 *
 * PD 5: structural-only - no baked offsets; works on any Gen-3 cart
 * whose learnset entry layout retains the published bit-packing.
 */

export const LEARNSET_TERMINATOR = 0xffff;
export const LEARNSET_LEVEL_MAX = 100;
/** Highest plausible move id PER THE FORMAT. The 9-bit move field
 *  physically tops at 511; heavy hacks beyond this require a
 *  different on-disk packing (16-bit moves + separate level byte
 *  per CFRU's `LEVEL_UP_MOVE_END_FLAG` extension) which would be a
 *  separate detector. Vanilla FireRed uses ~354 moves. */
export const LEARNSET_MOVE_MAX = 511;
/** Hard cap on entries per species. Vanilla maxes ~20 entries;
 *  heavy hacks ~50; 128 is absurdly generous. A run > 128 without
 *  a terminator is essentially certainly not a learnset. */
export const LEARNSET_MAX_ENTRIES = 128;
/** Bit shift to extract level from a packed entry. */
export const LEARNSET_LEVEL_SHIFT = 9;
/** Bit mask to extract move id from a packed entry. */
export const LEARNSET_MOVE_MASK = 0x1ff;

export interface LearnsetEntry {
  /** Level at which the move is learned (0..LEARNSET_LEVEL_MAX). */
  readonly level: number;
  /** Move id (1..LEARNSET_MOVE_MAX). */
  readonly move: number;
  /** Raw 16-bit packed value (mostly for debugging / round-trip). */
  readonly raw: number;
}

export interface Learnset {
  /** Parsed entries in array order. May be empty (some species
   *  have no level-up moves, just the terminator). */
  readonly entries: ReadonlyArray<LearnsetEntry>;
  /** ROM file offset of the array's first u16. */
  readonly fileOffset: number;
  /** ROM file offset of the terminator 0xFFFF. */
  readonly terminatorOffset: number;
  /** Total byte length: (entries.length + 1) × 2 (entries + terminator). */
  readonly byteLength: number;
}

export type LearnsetEntryParseFailure =
  | { kind: 'too_short'; bytesAvailable: number; bytesRequired: number }
  | { kind: 'implausible_level'; observed: number; max: number }
  | { kind: 'implausible_move'; observed: number; max: number; min: number }
  | { kind: 'zero_move' };

export type LearnsetEntryParseResult =
  | { ok: true; entry: LearnsetEntry }
  | { ok: false; failure: LearnsetEntryParseFailure };

export type LearnsetArrayParseFailure =
  | { kind: 'too_short'; bytesAvailable: number; bytesRequired: number }
  | { kind: 'no_terminator'; entriesRead: number; maxEntries: number }
  | {
      kind: 'invalid_entry';
      entryIndex: number;
      entryRaw: number;
      entryFailure: LearnsetEntryParseFailure;
    };

export type LearnsetArrayParseResult =
  | { ok: true; learnset: Learnset }
  | { ok: false; failure: LearnsetArrayParseFailure };

export interface ParseLearnsetArrayOptions {
  readonly levelMax?: number;
  readonly moveMax?: number;
  readonly maxEntries?: number;
}

/** Parse a single 16-bit packed learnset entry. */
export function parseLearnsetEntry(
  raw: number,
  opts?: { readonly levelMax?: number; readonly moveMax?: number },
): LearnsetEntryParseResult {
  const levelMax = opts?.levelMax ?? LEARNSET_LEVEL_MAX;
  const moveMax = opts?.moveMax ?? LEARNSET_MOVE_MAX;
  const level = (raw >>> LEARNSET_LEVEL_SHIFT) & 0x7f;
  const move = raw & LEARNSET_MOVE_MASK;
  if (move === 0) {
    return { ok: false, failure: { kind: 'zero_move' } };
  }
  if (level > levelMax) {
    return {
      ok: false,
      failure: { kind: 'implausible_level', observed: level, max: levelMax },
    };
  }
  if (move > moveMax) {
    return {
      ok: false,
      failure: { kind: 'implausible_move', observed: move, max: moveMax, min: 1 },
    };
  }
  return {
    ok: true,
    entry: Object.freeze({ level, move, raw }),
  };
}

/** Parse a terminator-delimited learnset array starting at `offset`. */
export function parseLearnsetArray(
  bytes: Uint8Array,
  offset: number,
  opts?: ParseLearnsetArrayOptions,
): LearnsetArrayParseResult {
  const levelMax = opts?.levelMax ?? LEARNSET_LEVEL_MAX;
  const moveMax = opts?.moveMax ?? LEARNSET_MOVE_MAX;
  const maxEntries = opts?.maxEntries ?? LEARNSET_MAX_ENTRIES;
  if (offset < 0 || offset + 2 > bytes.length) {
    return {
      ok: false,
      failure: {
        kind: 'too_short',
        bytesAvailable: Math.max(0, bytes.length - offset),
        bytesRequired: 2,
      },
    };
  }

  const entries: LearnsetEntry[] = [];
  let cursor = offset;
  while (entries.length < maxEntries) {
    if (cursor + 2 > bytes.length) {
      return {
        ok: false,
        failure: {
          kind: 'too_short',
          bytesAvailable: bytes.length - cursor,
          bytesRequired: 2,
        },
      };
    }
    const raw = readUint16Le(bytes, cursor);
    if (raw === LEARNSET_TERMINATOR) {
      return {
        ok: true,
        learnset: Object.freeze({
          entries: Object.freeze(entries),
          fileOffset: offset,
          terminatorOffset: cursor,
          byteLength: cursor - offset + 2,
        }),
      };
    }
    const r = parseLearnsetEntry(raw, { levelMax, moveMax });
    if (!r.ok) {
      return {
        ok: false,
        failure: {
          kind: 'invalid_entry',
          entryIndex: entries.length,
          entryRaw: raw,
          entryFailure: r.failure,
        },
      };
    }
    entries.push(r.entry);
    cursor += 2;
  }
  return {
    ok: false,
    failure: { kind: 'no_terminator', entriesRead: entries.length, maxEntries },
  };
}

function readUint16Le(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8)) >>> 0;
}
