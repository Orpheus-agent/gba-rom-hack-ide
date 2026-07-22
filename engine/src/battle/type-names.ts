/**
 * Type name table parser + signature scanner - Phase UW-3 / Category 4
 * substrate (iter 83 / UW-3-T2).
 *
 * The Gen-3 `gTypeNames` table is a packed array of fixed 7-byte slots
 * (6 chars max + 0xFF terminator slot). Slot 0 is "NORMAL", slot 1 is
 * "FIGHT" (FIGHTING shortened to fit), slot 2 is "FLYING", etc.
 * Vanilla Gen-3 has 18 types: NORMAL / FIGHT / FLYING / POISON /
 * GROUND / ROCK / BUG / GHOST / STEEL / ??? / FIRE / WATER / GRASS /
 * ELECTR / PSYCHC / ICE / DRAGON / DARK.
 *
 * Per PD 4/PD 5: signature-driven; scanner searches for the canonical
 * NORMAL (type ID 0) + FIGHT (type ID 1) pair at the documented 7-byte
 * stride. Both encode to pure ASCII via the engine text codec, so the
 * encoder's strict "ASCII-only" guard is satisfied. Both names are
 * universal across every Gen-3 Pokémon ROM.
 *
 * Mirrors the ability-names (iter 71) + move-names (iter 73) +
 * species-names (iter 59) pattern.
 *
 * Complements iter 69's `typeChartSystemDetector` - the matchup table
 * stores type IDs (numbers); this detector finds the parallel string
 * table that decodes those IDs to human names.
 */

import { decodeString, encodeString, STRING_TERMINATOR } from '../text/codec.js';

/** Size of one type-name slot in bytes (6 chars + terminator). */
export const TYPE_NAME_SLOT_BYTES = 7;

/** Minimum number of slots a real type-names table must have. Vanilla
 *  Gen-3 = 18 types. Even cut-down hacks rarely drop below 15. Set to
 *  10 as a defensive floor - incidental "NORMAL"+"FIGHT" matches are
 *  extremely unlikely in random ROM bytes. */
export const TYPE_NAMES_MIN_VALID_SLOTS = 10;

/** Cap on slots read in a single call. */
export const TYPE_NAMES_READ_CAP = 256;

/**
 * Read `count` type name slots starting at `offset`.
 */
export function readTypeNamesAt(
  romBytes: Uint8Array,
  offset: number,
  count: number,
): string[] {
  const cappedCount = Math.min(count, TYPE_NAMES_READ_CAP);
  const names: string[] = [];
  for (let i = 0; i < cappedCount; i++) {
    const slotStart = offset + i * TYPE_NAME_SLOT_BYTES;
    if (slotStart + TYPE_NAME_SLOT_BYTES > romBytes.length) break;
    names.push(decodeString(romBytes, slotStart, TYPE_NAME_SLOT_BYTES));
  }
  return names;
}

/**
 * Validate that `names` look like a real Gen-3 type table: enough
 * entries (≥10) and ≥60% of the first 10 entries decode as plausible
 * type-name-shaped strings (≥3 uppercase A-Z chars).
 */
export function validateTypeNames(names: ReadonlyArray<string>): boolean {
  if (names.length < TYPE_NAMES_MIN_VALID_SLOTS) return false;
  let goodCount = 0;
  let checkedCount = 0;
  const sampleEnd = Math.min(10, names.length);
  for (let i = 0; i < sampleEnd; i++) {
    checkedCount++;
    const name = names[i]!;
    if (name.length === 0) continue;
    if (name.length > 6) continue;
    if (name.includes('??')) continue;
    if (name.split('').every((c) => c === '?')) continue;
    if (/[A-Z]{3,}/.test(name)) goodCount++;
  }
  return checkedCount > 0 && goodCount >= Math.ceil(checkedCount * 0.6);
}

/**
 * Best-effort signature scan for `gTypeNames`. Searches for the
 * encoded NORMAL (type ID 0) + FIGHT (type ID 1) pair at 7-byte
 * stride. Returns the table start offset or null.
 *
 * PD 5: NORMAL is Gen-3 type ID 0 in EVERY Pokémon ROM; FIGHT is
 * type ID 1 (shortened "FIGHTING" to fit the 6-char slot). Both are
 * pure ASCII and universal across every Gen-3 cart including all
 * hacks.
 */
export function findTypeNamesTable(romBytes: Uint8Array): number | null {
  const needle = encodeString('NORMAL'); // 6 bytes
  const fight = encodeString('FIGHT'); // 5 bytes
  const search = Buffer.isBuffer(romBytes) ? romBytes : Buffer.from(romBytes);

  let searchStart = 0;
  while (searchStart < romBytes.length - 16) {
    const found = search.indexOf(Buffer.from(needle), searchStart);
    if (found < 0) return null;
    // NORMAL slot starts at `found` (= type ID 0). FIGHT slot should
    // start at `found + 7` (type ID 1).
    const fightStart = found + TYPE_NAME_SLOT_BYTES;
    if (
      fightStart + fight.length <= romBytes.length &&
      bytesEqual(romBytes, fightStart, fight)
    ) {
      // Verify NORMAL slot is properly terminated within 7 bytes.
      // For NORMAL (6 bytes), the 7th byte (slot offset 6) must be
      // STRING_TERMINATOR.
      if (romBytes[found + 6] === STRING_TERMINATOR) {
        return found;
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
