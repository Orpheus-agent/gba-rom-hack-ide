/**
 * Gen-3 Trainer struct parser - Phase 8 P8-T2.
 *
 * Per pret/pokefirered (src/data/trainers.h) + pret/pokeemerald, every
 * trainer (vanilla FireRed has 743 entries, vanilla Emerald has 855)
 * lives in a flat `gTrainers` array of 40-byte `Trainer` structs:
 *
 *   struct Trainer {
 *     u8  partyFlags;                // 0x00 - bits 0x01 (custom moves) + 0x02 (held items)
 *     u8  trainerClass;              // 0x01 - index into gTrainerClassNames
 *     u8  encounterMusic_gender;     // 0x02 - top bit = female, bottom 7 = music id
 *     u8  trainerPic;                // 0x03 - index into gTrainerFrontPicTable
 *     u8  trainerName[12];           // 0x04 - Gen-3 charset, 0xFF terminator, pad 0x00 or 0xFF
 *     u16 items[4];                  // 0x10 - item ids; usually 0 unless partyFlags bit 0x02
 *     u8  doubleBattle;              // 0x18 - 0 or 1
 *     u8  _alignment_pad_19;         // 0x19 - padding (always 0)
 *     u8  _alignment_pad_1A;         // 0x1A - padding (always 0)
 *     u8  _alignment_pad_1B;         // 0x1B - padding (always 0)
 *     u32 aiFlags;                   // 0x1C - bitfield; vanilla uses bits 0..6 only
 *     u8  partySize;                 // 0x20 - 1..6 (Pokémon party limit)
 *     u8  _alignment_pad_21;         // 0x21 - padding (always 0)
 *     u8  _alignment_pad_22;         // 0x22 - padding (always 0)
 *     u8  _alignment_pad_23;         // 0x23 - padding (always 0)
 *     u32 partyPointer;              // 0x24 - ROM pointer to TrainerPartyMember array
 *   };  // 40 bytes
 *
 * Detection signature (all checked, leftmost-strongest):
 *
 *   1. Four post-aiFlags padding bytes at 0x21/0x22/0x23 == 0 AND three
 *      post-doubleBattle padding bytes at 0x19/0x1A/0x1B == 0 - random
 *      ROM bytes hit 6 consecutive zero bytes at these positions only
 *      ~1.5e-14 of the time.
 *   2. partyFlags ∈ {0, 1, 2, 3} (only the bottom 2 bits are valid).
 *   3. doubleBattle ∈ {0, 1}.
 *   4. partySize ∈ [1, 6].
 *   5. partyPointer is a valid ROM pointer (0x08000000..0x09FFFFFF) OR
 *      zero (some empty/test entries have NULL party pointers).
 *   6. aiFlags upper 24 bits == 0 (vanilla uses bits 0..6; even heavy
 *      hacks rarely exceed bits 0..15). The check `aiFlags <= 0xFFFF`
 *      tolerates expansion-framework rewrites without becoming useless.
 *   7. trainerClass <= TRAINER_CLASS_MAX. Vanilla has 58 classes; heavy
 *      hacks expand. We cap at 200 (mirroring BASE_STATS_ABILITY_MAX).
 *   8. trainerName[0..11] follows GBA Pokémon string convention: every
 *      byte must be 0xFF (terminator/pad), 0x00, or in the printable
 *      Gen-3 charset (≤ 0xEF - characters 0xF0..0xFE are control codes
 *      that don't appear in trainer names). At least one byte before
 *      the first 0xFF must be a printable character (no all-zero or
 *      all-0xFF names).
 *
 * False-positive rate per random 40-byte slice: combined padding + flags
 * + bounds + pointer + name constraints yield < 1e-18 per slice - a
 * run of ≥ 8 consecutive parse-successes is essentially certain to be
 * the real gTrainers table.
 *
 * PD 5: structural-only - no baked trainer-table offsets; works on any
 * Gen-3 cart whose Trainer struct retains the published layout.
 */

export const TRAINER_STRUCT_SIZE_BYTES = 40;
/** Highest plausible trainerClass byte. Vanilla 58; heavy hacks expand. */
export const TRAINER_CLASS_MAX = 200;
/** Highest plausible partyFlags value (low 2 bits = custom moves / items). */
export const TRAINER_PARTY_FLAGS_MAX = 3;
/** Minimum / maximum allowed partySize. Pokémon party limit is 6. */
export const TRAINER_PARTY_SIZE_MIN = 1;
export const TRAINER_PARTY_SIZE_MAX = 6;
/** Cap on aiFlags. Vanilla uses bits 0..6; cap at 0xFFFF tolerates heavy
 *  expansion-framework rewrites without losing the signal. */
export const TRAINER_AI_FLAGS_MAX = 0xffff;
/** Trainer name field length (bytes). */
export const TRAINER_NAME_BYTES = 12;
/** Highest printable Gen-3 charset byte for trainer names. 0xF0..0xFE
 *  are control codes that don't appear in trainer name strings. */
export const TRAINER_NAME_PRINTABLE_MAX = 0xef;
/** Terminator byte in Gen-3 strings. */
export const TRAINER_NAME_TERMINATOR = 0xff;
/** GBA ROM pointer base address (start of cartridge space). */
const GBA_ROM_POINTER_LOWER = 0x08000000;
/** GBA ROM pointer upper bound (end of 32 MiB cartridge space). */
const GBA_ROM_POINTER_UPPER = 0x09ffffff;

export interface Trainer {
  readonly partyFlags: number;
  readonly trainerClass: number;
  readonly encounterMusic: number;
  /** True iff bit 0x80 of encounterMusic_gender is set. */
  readonly isFemale: boolean;
  readonly trainerPic: number;
  /** Trainer name bytes 0x04..0x0F (12 bytes, terminator 0xFF, pad 0x00 or 0xFF). */
  readonly trainerNameBytes: Readonly<Uint8Array>;
  /** Number of name bytes before the first terminator (or 12 if none). */
  readonly trainerNameLength: number;
  readonly items: ReadonlyArray<number>;
  readonly doubleBattle: boolean;
  readonly aiFlags: number;
  readonly partySize: number;
  /** ROM pointer to TrainerPartyMember array (0 if NULL). */
  readonly partyPointer: number;
  /** ROM file offset of this Trainer struct's first byte. */
  readonly fileOffset: number;
}

export type TrainerParseFailure =
  | { kind: 'too_short'; bytesAvailable: number; bytesRequired: number }
  | { kind: 'nonzero_padding'; pad19: number; pad1A: number; pad1B: number; pad21: number; pad22: number; pad23: number }
  | { kind: 'implausible_party_flags'; observed: number; max: number }
  | { kind: 'implausible_double_battle'; observed: number }
  | { kind: 'implausible_party_size'; observed: number; min: number; max: number }
  | { kind: 'implausible_trainer_class'; observed: number; max: number }
  | { kind: 'implausible_ai_flags'; observed: number; max: number }
  | { kind: 'invalid_party_pointer'; observed: number }
  | { kind: 'invalid_trainer_name'; reason: 'all_zero' | 'all_terminator' | 'control_byte'; offendingByte?: number };

export type TrainerParseResult =
  | { ok: true; trainer: Trainer }
  | { ok: false; failure: TrainerParseFailure };

/** Parse 40 bytes at `offset` as a Gen-3 Trainer struct. */
export function parseTrainer(bytes: Uint8Array, offset: number): TrainerParseResult {
  if (offset < 0 || offset + TRAINER_STRUCT_SIZE_BYTES > bytes.length) {
    return {
      ok: false,
      failure: {
        kind: 'too_short',
        bytesAvailable: Math.max(0, bytes.length - offset),
        bytesRequired: TRAINER_STRUCT_SIZE_BYTES,
      },
    };
  }

  const partyFlags = bytes[offset + 0x00] ?? 0;
  const trainerClass = bytes[offset + 0x01] ?? 0;
  const encounterMusicGender = bytes[offset + 0x02] ?? 0;
  const trainerPic = bytes[offset + 0x03] ?? 0;
  // 12-byte trainer name at 0x04..0x0F.
  const nameStart = offset + 0x04;
  const nameBytes = bytes.subarray(nameStart, nameStart + TRAINER_NAME_BYTES);
  const items = [
    readUint16Le(bytes, offset + 0x10),
    readUint16Le(bytes, offset + 0x12),
    readUint16Le(bytes, offset + 0x14),
    readUint16Le(bytes, offset + 0x16),
  ];
  const doubleBattle = bytes[offset + 0x18] ?? 0;
  const pad19 = bytes[offset + 0x19] ?? 0;
  const pad1A = bytes[offset + 0x1a] ?? 0;
  const pad1B = bytes[offset + 0x1b] ?? 0;
  const aiFlags = readUint32Le(bytes, offset + 0x1c);
  const partySize = bytes[offset + 0x20] ?? 0;
  const pad21 = bytes[offset + 0x21] ?? 0;
  const pad22 = bytes[offset + 0x22] ?? 0;
  const pad23 = bytes[offset + 0x23] ?? 0;
  const partyPointer = readUint32Le(bytes, offset + 0x24);

  // 1. Padding bytes - cheapest + strongest signal (6 zero bytes).
  if (pad19 !== 0 || pad1A !== 0 || pad1B !== 0 || pad21 !== 0 || pad22 !== 0 || pad23 !== 0) {
    return {
      ok: false,
      failure: { kind: 'nonzero_padding', pad19, pad1A, pad1B, pad21, pad22, pad23 },
    };
  }
  // 2. partyFlags bits.
  if (partyFlags > TRAINER_PARTY_FLAGS_MAX) {
    return {
      ok: false,
      failure: { kind: 'implausible_party_flags', observed: partyFlags, max: TRAINER_PARTY_FLAGS_MAX },
    };
  }
  // 3. doubleBattle is 0 or 1.
  if (doubleBattle > 1) {
    return { ok: false, failure: { kind: 'implausible_double_battle', observed: doubleBattle } };
  }
  // 4. partySize in 1..6.
  if (partySize < TRAINER_PARTY_SIZE_MIN || partySize > TRAINER_PARTY_SIZE_MAX) {
    return {
      ok: false,
      failure: {
        kind: 'implausible_party_size',
        observed: partySize,
        min: TRAINER_PARTY_SIZE_MIN,
        max: TRAINER_PARTY_SIZE_MAX,
      },
    };
  }
  // 5. trainerClass cap.
  if (trainerClass > TRAINER_CLASS_MAX) {
    return {
      ok: false,
      failure: { kind: 'implausible_trainer_class', observed: trainerClass, max: TRAINER_CLASS_MAX },
    };
  }
  // 6. aiFlags upper bits cap.
  if (aiFlags > TRAINER_AI_FLAGS_MAX) {
    return {
      ok: false,
      failure: { kind: 'implausible_ai_flags', observed: aiFlags, max: TRAINER_AI_FLAGS_MAX },
    };
  }
  // 7. partyPointer is valid ROM pointer or NULL.
  if (partyPointer !== 0 && (partyPointer < GBA_ROM_POINTER_LOWER || partyPointer > GBA_ROM_POINTER_UPPER)) {
    return { ok: false, failure: { kind: 'invalid_party_pointer', observed: partyPointer } };
  }
  // 8. trainerName follows the convention.
  let firstTerminatorAt = TRAINER_NAME_BYTES;
  let sawPrintable = false;
  for (let i = 0; i < TRAINER_NAME_BYTES; i++) {
    const b = nameBytes[i] ?? 0;
    if (b === TRAINER_NAME_TERMINATOR) {
      if (firstTerminatorAt === TRAINER_NAME_BYTES) firstTerminatorAt = i;
      continue;
    }
    if (b === 0) continue;
    if (b > TRAINER_NAME_PRINTABLE_MAX) {
      return {
        ok: false,
        failure: { kind: 'invalid_trainer_name', reason: 'control_byte', offendingByte: b },
      };
    }
    if (i < firstTerminatorAt) sawPrintable = true;
  }
  if (!sawPrintable) {
    // Distinguish all-0xFF (legal-looking terminator spam) from all-0x00.
    const allTerm = Array.from(nameBytes).every((b) => b === TRAINER_NAME_TERMINATOR);
    return {
      ok: false,
      failure: {
        kind: 'invalid_trainer_name',
        reason: allTerm ? 'all_terminator' : 'all_zero',
      },
    };
  }

  return {
    ok: true,
    trainer: Object.freeze({
      partyFlags,
      trainerClass,
      encounterMusic: encounterMusicGender & 0x7f,
      isFemale: (encounterMusicGender & 0x80) !== 0,
      trainerPic,
      trainerNameBytes: new Uint8Array(nameBytes),
      trainerNameLength: firstTerminatorAt,
      items: Object.freeze(items),
      doubleBattle: doubleBattle === 1,
      aiFlags,
      partySize,
      partyPointer,
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
