/**
 * Ability name table parser + signature scanner - Phase UW-2 / Category 4
 * substrate (iter 71 / UW-2-T5).
 *
 * The Gen-3 `gAbilityNames` table is a packed array of fixed 13-byte slots
 * (12 chars max + 0xFF terminator slot). Slot 0 is the "---" placeholder
 * (ABILITY_NONE); slots 1+ are STENCH, DRIZZLE, SPEED BOOST, BATTLE
 * ARMOR, etc.
 *
 * Per PD 4/PD 5 (universality first; no FireRed/Emerald-only path):
 * the scanner uses a signature-driven approach that searches for the
 * canonical STENCH (ability ID 1) + DRIZZLE (ability ID 2) pair at the
 * documented 13-byte stride. This catches hacks that have relocated the
 * table (vanilla offsets aren't baked).
 *
 * Mirrors the species-names pattern (iter 59) - same shape, different
 * slot size + signature pair.
 *
 * PD 13: this module is the canonical SSOT for ability-name reading.
 */

import { decodeString, encodeString, STRING_TERMINATOR } from '../text/codec.js';

/** Size of one ability-name slot in bytes (12 chars + terminator). */
export const ABILITY_NAME_SLOT_BYTES = 13;

/** Minimum number of slots a real ability-names table must have for the
 *  validator to accept it. Vanilla = 78; even shrunk hacks rarely drop
 *  below 60. 30 is a defensive floor against incidental matches. */
export const ABILITY_NAMES_MIN_VALID_SLOTS = 30;

/** Maximum slots we ever attempt to read in a single call (defensive cap
 *  for hacks claiming an enormous ability list). */
export const ABILITY_NAMES_READ_CAP = 1024;

/** Placeholder character byte (Gen-3 codec '-' = 0xAE). */
export const ABILITY_PLACEHOLDER_BYTE = 0xae;

/**
 * Read `count` ability name slots starting at `offset`. Decoding stops if
 * a slot extends past the buffer end (returns fewer than `count` entries
 * in that case).
 */
export function readAbilityNamesAt(
  romBytes: Uint8Array,
  offset: number,
  count: number,
): string[] {
  const cappedCount = Math.min(count, ABILITY_NAMES_READ_CAP);
  const names: string[] = [];
  for (let i = 0; i < cappedCount; i++) {
    const slotStart = offset + i * ABILITY_NAME_SLOT_BYTES;
    if (slotStart + ABILITY_NAME_SLOT_BYTES > romBytes.length) break;
    names.push(decodeString(romBytes, slotStart, ABILITY_NAME_SLOT_BYTES));
  }
  return names;
}

/**
 * Validate that the decoded `names` look like a real Gen-3 ability table:
 * enough entries, and ≥ 60% of the first 20 real abilities (skipping the
 * placeholder at idx 0) decode as plausible names - 3+ consecutive
 * uppercase A-Z chars OR an uppercase + space + uppercase pattern (for
 * multi-word abilities like "SPEED BOOST", "BATTLE ARMOR"). Empty / overly-
 * long / all-? entries are rejected.
 */
export function validateAbilityNames(names: ReadonlyArray<string>): boolean {
  if (names.length < ABILITY_NAMES_MIN_VALID_SLOTS) return false;
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
    // Accept names with ≥3 contiguous A-Z (e.g. STENCH) OR multi-word
    // pattern with internal space (e.g. "SPEED BOOST").
    if (/[A-Z]{3,}/.test(name) || /[A-Z]+ [A-Z]+/.test(name)) goodCount++;
  }
  return checkedCount > 0 && goodCount >= Math.ceil(checkedCount * 0.6);
}

/**
 * Best-effort signature scan for `gAbilityNames` in any Gen-3 ROM.
 * Searches for the encoded `STENCH` bytes (ability ID 1) followed by the
 * encoded `DRIZZLE` bytes (ability ID 2) at the documented 13-byte
 * stride (one slot later). Returns the table START offset (placeholder
 * slot 0) or `null` if not found.
 *
 * PD 5: the only Pokémon-specific assumption is the literal byte
 * sequences for "STENCH" + "DRIZZLE". Both are universally present in
 * every Gen-3 Pokémon ROM (and every hack that keeps the Gen-3 ability
 * set, which is essentially all of them - even Radical Red retains
 * STENCH as ability ID 1 even though it's reclassified).
 *
 * For ROMs without these abilities at the canonical IDs, scan returns
 * null.
 */
export function findAbilityNamesTable(romBytes: Uint8Array): number | null {
  const needle = encodeString('STENCH'); // 6 bytes (without terminator)
  const drizzle = encodeString('DRIZZLE'); // 7 bytes (without terminator)
  const search = Buffer.isBuffer(romBytes) ? romBytes : Buffer.from(romBytes);

  let searchStart = 0;
  while (searchStart < romBytes.length - 32) {
    const found = search.indexOf(Buffer.from(needle), searchStart);
    if (found < 0) return null;
    // STENCH slot starts at `found` (= ability ID 1 slot start).
    // Table start is therefore `found - 13`.
    const tableStart = found - ABILITY_NAME_SLOT_BYTES;
    if (tableStart < 0) {
      searchStart = found + 1;
      continue;
    }
    // DRIZZLE slot should start at `tableStart + 26`.
    const drizzleStart = tableStart + 2 * ABILITY_NAME_SLOT_BYTES;
    if (
      drizzleStart + drizzle.length <= romBytes.length &&
      bytesEqual(romBytes, drizzleStart, drizzle)
    ) {
      // Validate placeholder slot shape at tableStart: should be ≥2
      // dashes followed by a terminator within the 13-byte slot.
      let dashCount = 0;
      let terminated = false;
      for (let i = 0; i < ABILITY_NAME_SLOT_BYTES; i++) {
        const b = romBytes[tableStart + i]!;
        if (b === ABILITY_PLACEHOLDER_BYTE) dashCount++;
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
      if (dashCount >= 2 && terminated) {
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
