/**
 * Gen-3 gTrainerClassNames table parser + structural-only scanner - 
 * Phase UW-3 / Category 6 substrate (iter 84 / UW-3-T3).
 *
 * The Gen-3 `gTrainerClassNames` table holds the human-readable trainer
 * class names ("HIKER", "BUG CATCHER", "BIRD KEEPER", "TEAM AQUA",
 * "{PKMN} TRAINER", etc.) referenced by the trainerClass byte in each
 * Trainer struct. Vanilla FRLG has 107 classes; Emerald has 58;
 * RSE-derived hacks vary.
 *
 * Unlike species-names / ability-names / move-names which have universal
 * canonical name PAIRS (BULBASAUR+IVYSAUR / STENCH+DRIZZLE / POUND+KARATE
 * CHOP), trainer-class names DIVERGE substantially between FRLG and RSE
 * - there is no single pair guaranteed at fixed indices across all
 * Gen-3 carts. This scanner uses STRUCTURAL-only signature detection:
 * find a run of 13-byte slots where each slot contains valid Gen-3
 * ALL-CAPS charset bytes + a 0xFF terminator. Anchor confirmation
 * (10 consecutive valid slots) filters stray valid-looking text runs
 * elsewhere in the ROM.
 *
 * Per PD 5: structural - works on any Gen-3 cart whose trainer-class
 * name table retains the canonical 13-byte slot layout. The structural
 * approach is universal across FRLG / Emerald / RSE / all derived
 * hacks.
 *
 * Mirrors ability-names (iter 71) slot layout but uses
 * structural-anchor instead of signature-pair detection.
 */

import { decodeString } from '../text/codec.js';

/** Size of one trainer-class-name slot in bytes. Per pret/pokefirered
 *  TRAINER_CLASS_NAME_LENGTH = 13 (12 chars + terminator). */
export const TRAINER_CLASS_NAME_SLOT_BYTES = 13;

/** Minimum valid slots in a run to consider this the trainer-class
 *  names table. Emerald has 58; FRLG has 107; even reduced hacks
 *  retain ≥40 most of the time. Set to 30 as a defensive floor. */
export const TRAINER_CLASS_NAMES_MIN_VALID_SLOTS = 30;

/** Number of slots required to consecutively validate before treating
 *  the offset as the anchor (filters stray text runs). */
export const TRAINER_CLASS_NAMES_ANCHOR_CONFIRMATION = 10;

/** Cap on slots read in a single call. */
export const TRAINER_CLASS_NAMES_READ_CAP = 512;

/** Cartridge-header skip. */
const CARTRIDGE_HEADER_END = 0xc0;

/**
 * Read `count` trainer-class name slots starting at `offset`.
 */
export function readTrainerClassNamesAt(
  romBytes: Uint8Array,
  offset: number,
  count: number,
): string[] {
  const cappedCount = Math.min(count, TRAINER_CLASS_NAMES_READ_CAP);
  const names: string[] = [];
  for (let i = 0; i < cappedCount; i++) {
    const slotStart = offset + i * TRAINER_CLASS_NAME_SLOT_BYTES;
    if (slotStart + TRAINER_CLASS_NAME_SLOT_BYTES > romBytes.length) break;
    names.push(decodeString(romBytes, slotStart, TRAINER_CLASS_NAME_SLOT_BYTES));
  }
  return names;
}

/**
 * Validate that a single 13-byte slot decodes as a trainer-class-shaped
 * name: ≥3 uppercase A-Z chars, no garbage, properly terminated within
 * the slot.
 */
function isValidTrainerClassSlot(
  romBytes: Uint8Array,
  slotOffset: number,
): boolean {
  if (slotOffset + TRAINER_CLASS_NAME_SLOT_BYTES > romBytes.byteLength) {
    return false;
  }
  const decoded = decodeString(romBytes, slotOffset, TRAINER_CLASS_NAME_SLOT_BYTES);
  if (decoded.length === 0) return false;
  if (decoded.includes('??')) return false;
  if (decoded.split('').every((c) => c === '?')) return false;
  // Accept single-word ALL-CAPS (HIKER) OR multi-word (BUG CATCHER)
  // OR with brace-substitutions like {PKMN} TRAINER (decoded as "?"
  // for the substitution token - so check for ≥3 contiguous A-Z chars
  // ignoring potential leading "?" substitution markers).
  return /[A-Z]{3,}/.test(decoded);
}

/**
 * Validate that `names` look like a real Gen-3 trainer-class-names
 * table: enough entries + ≥60% of sampled entries are class-name-shaped.
 */
export function validateTrainerClassNames(names: ReadonlyArray<string>): boolean {
  if (names.length < TRAINER_CLASS_NAMES_MIN_VALID_SLOTS) return false;
  let goodCount = 0;
  let checkedCount = 0;
  const sampleEnd = Math.min(20, names.length);
  for (let i = 0; i < sampleEnd; i++) {
    checkedCount++;
    const name = names[i]!;
    if (name.length === 0) continue;
    if (name.length > 12) continue;
    if (name.includes('??')) continue;
    if (name.split('').every((c) => c === '?')) continue;
    if (/[A-Z]{3,}/.test(name) || /[A-Z]+ [A-Z]+/.test(name)) goodCount++;
  }
  return checkedCount > 0 && goodCount >= Math.ceil(checkedCount * 0.6);
}

/**
 * Find the gTrainerClassNames table using structural-only validation.
 * Scans 4-byte-aligned offsets past the cartridge header for a run of
 * `TRAINER_CLASS_NAMES_ANCHOR_CONFIRMATION` consecutive valid slots,
 * then walks forward counting the full run length.
 *
 * Returns the offset of the first valid slot if a run of ≥
 * `TRAINER_CLASS_NAMES_MIN_VALID_SLOTS` slots is found; null otherwise.
 *
 * PD 5: structural - works on any Gen-3 cart.
 */
export function findTrainerClassNamesTable(romBytes: Uint8Array): number | null {
  if (
    romBytes.byteLength <
    CARTRIDGE_HEADER_END +
      TRAINER_CLASS_NAMES_MIN_VALID_SLOTS * TRAINER_CLASS_NAME_SLOT_BYTES
  ) {
    return null;
  }
  const limit = romBytes.byteLength - TRAINER_CLASS_NAME_SLOT_BYTES;
  let best: { offset: number; count: number } | null = null;

  for (let p = CARTRIDGE_HEADER_END; p <= limit; p += 4) {
    // Anchor confirmation: require 10 consecutive valid slots from p.
    let confirmed = true;
    for (let i = 0; i < TRAINER_CLASS_NAMES_ANCHOR_CONFIRMATION; i++) {
      const slotOff = p + i * TRAINER_CLASS_NAME_SLOT_BYTES;
      if (!isValidTrainerClassSlot(romBytes, slotOff)) {
        confirmed = false;
        break;
      }
    }
    if (!confirmed) continue;

    // Walk forward to find run length.
    let count = TRAINER_CLASS_NAMES_ANCHOR_CONFIRMATION;
    let cursor = p + TRAINER_CLASS_NAMES_ANCHOR_CONFIRMATION * TRAINER_CLASS_NAME_SLOT_BYTES;
    while (
      cursor + TRAINER_CLASS_NAME_SLOT_BYTES <= romBytes.byteLength &&
      count < TRAINER_CLASS_NAMES_READ_CAP
    ) {
      if (!isValidTrainerClassSlot(romBytes, cursor)) break;
      count++;
      cursor += TRAINER_CLASS_NAME_SLOT_BYTES;
    }

    if (count >= TRAINER_CLASS_NAMES_MIN_VALID_SLOTS) {
      if (best === null || count > best.count) {
        best = { offset: p, count };
      }
    }
    // Skip past this candidate run to avoid re-anchoring inside it.
    p = cursor;
  }

  return best?.offset ?? null;
}
