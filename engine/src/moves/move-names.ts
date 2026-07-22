/**
 * Move name table parser + signature scanner - Phase UW-2 / Category 4
 * substrate (iter 73 / UW-2-T7).
 *
 * The Gen-3 `gMoveNames` table is a packed array of fixed 13-byte slots
 * (12 chars max + 0xFF terminator slot). Slot 0 is the "-" placeholder
 * (MOVE_NONE); slots 1+ are POUND, KARATE CHOP, DOUBLE SLAP, COMET
 * PUNCH, MEGA PUNCH, etc.
 *
 * Per PD 4/PD 5 (universality first; no FireRed/Emerald-only path):
 * the scanner uses a signature-driven approach that searches for the
 * canonical POUND (move ID 1) + KARATE CHOP (move ID 2) pair at the
 * documented 13-byte stride. This catches hacks that have relocated the
 * table (vanilla offsets aren't baked).
 *
 * Mirrors the ability-names pattern (iter 71) - same shape, different
 * signature pair.
 *
 * PD 13: this module is the canonical SSOT for move-name reading.
 *
 * Pairing with iter 68's moves-system detector: that detector finds
 * the gBattleMoves struct table (binary data - power, type, accuracy,
 * pp, etc.). This one finds the parallel gMoveNames string table
 * (decoded text names). Together they give a complete view of the
 * moves subsystem.
 */

import { decodeString, encodeString, STRING_TERMINATOR } from '../text/codec.js';

/** Size of one move-name slot in bytes (12 chars + terminator). */
export const MOVE_NAME_SLOT_BYTES = 13;

/** Minimum number of slots a real move-names table must have for the
 *  validator to accept it. Vanilla = 355 (354 moves + Struggle); even
 *  shrunk hacks rarely drop below 200. 50 is a defensive floor against
 *  incidental matches. */
export const MOVE_NAMES_MIN_VALID_SLOTS = 50;

/** Maximum slots we ever attempt to read in a single call (defensive cap
 *  for hacks claiming an enormous move list - Radical Red has ~800). */
export const MOVE_NAMES_READ_CAP = 2048;

/** Placeholder character byte (Gen-3 codec '-' = 0xAE). */
export const MOVE_PLACEHOLDER_BYTE = 0xae;

/**
 * Read `count` move name slots starting at `offset`. Decoding stops if
 * a slot extends past the buffer end (returns fewer than `count` entries
 * in that case).
 */
export function readMoveNamesAt(
  romBytes: Uint8Array,
  offset: number,
  count: number,
): string[] {
  const cappedCount = Math.min(count, MOVE_NAMES_READ_CAP);
  const names: string[] = [];
  for (let i = 0; i < cappedCount; i++) {
    const slotStart = offset + i * MOVE_NAME_SLOT_BYTES;
    if (slotStart + MOVE_NAME_SLOT_BYTES > romBytes.length) break;
    names.push(decodeString(romBytes, slotStart, MOVE_NAME_SLOT_BYTES));
  }
  return names;
}

/**
 * Validate that the decoded `names` look like a real Gen-3 move table:
 * enough entries, and ≥ 60% of the first 20 real moves (skipping the
 * placeholder at idx 0) decode as plausible names - 3+ consecutive
 * uppercase A-Z chars OR multi-word pattern like "KARATE CHOP",
 * "DOUBLE SLAP", "MEGA PUNCH". Empty / overly-long / all-? entries
 * are rejected.
 */
export function validateMoveNames(names: ReadonlyArray<string>): boolean {
  if (names.length < MOVE_NAMES_MIN_VALID_SLOTS) return false;
  let goodCount = 0;
  let checkedCount = 0;
  const sampleEnd = Math.min(21, names.length);
  for (let i = 1; i < sampleEnd; i++) {
    checkedCount++;
    const name = names[i]!;
    if (name.length === 0) continue;
    if (name.length > 12) continue;
    if (name.includes('??')) continue;
    if (name.split('').every((c) => c === '?')) continue;
    // Accept names with ≥3 contiguous A-Z (e.g. POUND, GROWL) OR
    // multi-word pattern with internal space (e.g. "KARATE CHOP",
    // "DOUBLE SLAP", "MEGA PUNCH").
    if (/[A-Z]{3,}/.test(name) || /[A-Z]+ [A-Z]+/.test(name)) goodCount++;
  }
  return checkedCount > 0 && goodCount >= Math.ceil(checkedCount * 0.6);
}

/**
 * Best-effort signature scan for `gMoveNames` in any Gen-3 Pokémon ROM.
 * Searches for the encoded `POUND` bytes (move ID 1) followed by the
 * encoded `KARATE CHOP` bytes (move ID 2) at the documented 13-byte
 * stride (one slot later). Returns the table START offset (placeholder
 * slot 0) or `null` if not found.
 *
 * PD 5: the only Pokémon-specific assumption is the literal byte
 * sequences for "POUND" + "KARATE CHOP". Both are universally present in
 * every Gen-3 Pokémon ROM (and every hack that keeps the Gen-1 move
 * order, which is essentially all of them - even Radical Red retains
 * POUND as move ID 1).
 *
 * For ROMs without these moves at the canonical IDs, scan returns null.
 */
export function findMoveNamesTable(romBytes: Uint8Array): number | null {
  const needle = encodeString('POUND'); // 5 bytes (without terminator)
  const karate = encodeString('KARATE CHOP'); // 11 bytes (without terminator)
  const search = Buffer.isBuffer(romBytes) ? romBytes : Buffer.from(romBytes);

  let searchStart = 0;
  while (searchStart < romBytes.length - 32) {
    const found = search.indexOf(Buffer.from(needle), searchStart);
    if (found < 0) return null;
    // POUND slot starts at `found` (= move ID 1 slot start).
    // Table start is therefore `found - 13`.
    const tableStart = found - MOVE_NAME_SLOT_BYTES;
    if (tableStart < 0) {
      searchStart = found + 1;
      continue;
    }
    // KARATE CHOP slot should start at `tableStart + 26`.
    const karateStart = tableStart + 2 * MOVE_NAME_SLOT_BYTES;
    if (
      karateStart + karate.length <= romBytes.length &&
      bytesEqual(romBytes, karateStart, karate)
    ) {
      // Validate placeholder slot shape at tableStart: should be ≥1
      // dash byte followed by a terminator within the 13-byte slot.
      // MOVE_NONE name is just "-" in vanilla (some hacks use "---").
      let dashCount = 0;
      let terminated = false;
      for (let i = 0; i < MOVE_NAME_SLOT_BYTES; i++) {
        const b = romBytes[tableStart + i]!;
        if (b === MOVE_PLACEHOLDER_BYTE) dashCount++;
        else if (b === STRING_TERMINATOR) {
          terminated = true;
          break;
        } else {
          // Any non-dash non-terminator byte before terminator breaks
          // the placeholder pattern.
          dashCount = 0;
          break;
        }
      }
      if (dashCount >= 1 && terminated) {
        return tableStart;
      }
    }
    searchStart = found + 1;
  }
  return null;
}

function bytesEqual(haystack: Uint8Array, offset: number, needle: Uint8Array): boolean {
  if (offset + needle.length > haystack.length) return false;
  for (let i = 0; i < needle.length; i++) {
    if (haystack[offset + i] !== needle[i]) return false;
  }
  return true;
}
