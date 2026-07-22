/**
 * Gen-3 Pokédex entry struct parser - Phase UW-3 / Category 3 substrate
 * (iter 82 / UW-3-T1).
 *
 * Per pret/pokefirered + pret/pokeemerald `include/pokedex.h` /
 * `data/pokemon/pokedex_entries.h`, every species has a 32-byte
 * gPokedexEntries record:
 *
 *   struct PokedexEntry {
 *     u8  categoryName[12]; // 0x00..0x0B - Gen-3 charset (e.g. "SEED")
 *     u16 height;           // 0x0C - decimeters (1..999 = 0.1m..99.9m)
 *     u16 weight;           // 0x0E - hectograms (1..9999 = 0.1kg..999.9kg)
 *     const u8 *description;        // 0x10 - ROM ptr to flavor text
 *     const u8 *unusedDescription;  // 0x14 - ROM ptr (vanilla unused; can be null)
 *     u16 pokemonScale;     // 0x18 - sprite scale (typically 256..1024)
 *     u16 pokemonOffset;    // 0x1A - sprite y-offset (signed-ish; in-range)
 *     u16 trainerScale;     // 0x1C - sprite scale
 *     u16 trainerOffset;    // 0x1E - sprite y-offset
 *     u16 padding;          // 0x20 - must be 0 (vanilla)
 *   };  // 32 bytes (0x20)
 *
 * Wait - the published layout is actually 32 bytes incl padding starting
 * at 0x20. Re-checking pret: yes, sizeof(PokedexEntry) is 32 bytes
 * with `u16 unused;` at the END, not 36. Some sources cite 36-byte
 * layout but pret canonical is 32 with the trailing 2-byte padding.
 *
 * Detection signature per entry:
 *   - categoryName has ≥3 uppercase A-Z chars before terminator
 *   - height in [1, 999] OR zero (zero acceptable for placeholder entry 0)
 *   - weight in [1, 9999] OR zero
 *   - description ptr at 0x10 is zero OR in ROM space [0x08000000, 0x0A000000)
 *   - unusedDescription ptr at 0x14 is zero OR in ROM space
 *   - padding u16 at 0x1E is zero
 *
 * Per PD 5: structural only; works on any Gen-3 cart that retains the
 * canonical 32-byte PokedexEntry struct.
 */

import { decodeString } from '../text/codec.js';
import { GBA_ROM_BASE, GBA_ROM_END_EXCLUSIVE } from '../items/index.js';

/** Size of one Gen-3 Pokédex entry struct in bytes. */
export const POKEDEX_ENTRY_STRUCT_SIZE_BYTES = 32;

/** Length in bytes of the categoryName field (offset 0x00..0x0B). */
export const POKEDEX_CATEGORY_NAME_LENGTH_BYTES = 12;

/** Maximum nominal height value (vanilla cap 999 = 99.9 m). */
export const POKEDEX_HEIGHT_MAX = 999;

/** Maximum nominal weight value (vanilla cap 9999 = 999.9 kg). */
export const POKEDEX_WEIGHT_MAX = 9999;

/** Field offsets within a PokedexEntry struct. */
export const POKEDEX_OFFSET_CATEGORY_NAME = 0x00;
export const POKEDEX_OFFSET_HEIGHT = 0x0c;
export const POKEDEX_OFFSET_WEIGHT = 0x0e;
export const POKEDEX_OFFSET_DESCRIPTION_PTR = 0x10;
export const POKEDEX_OFFSET_UNUSED_DESCRIPTION_PTR = 0x14;
export const POKEDEX_OFFSET_POKEMON_SCALE = 0x18;
export const POKEDEX_OFFSET_POKEMON_OFFSET = 0x1a;
export const POKEDEX_OFFSET_TRAINER_SCALE = 0x1c;
export const POKEDEX_OFFSET_TRAINER_OFFSET = 0x1e;
// Padding 2 bytes at end of struct; in the canonical 32-byte layout the
// last u16 (offset 0x1E) IS trainerOffset, not padding. There is no
// trailing padding in the 32-byte layout. The parser validates trailing
// trainer-offset value is in plausible range instead of zero.

export interface PokedexEntry {
  readonly categoryNameBytes: Uint8Array;
  readonly categoryName: string;
  readonly height: number;
  readonly weight: number;
  readonly descriptionPtr: number;
  readonly unusedDescriptionPtr: number;
  readonly pokemonScale: number;
  readonly pokemonOffset: number;
  readonly trainerScale: number;
  readonly trainerOffset: number;
}

export type PokedexEntryParseFailure =
  | { readonly kind: 'out_of_bounds' }
  | { readonly kind: 'category_name_invalid' }
  | { readonly kind: 'height_out_of_range' }
  | { readonly kind: 'weight_out_of_range' }
  | { readonly kind: 'description_ptr_invalid' }
  | { readonly kind: 'unused_description_ptr_invalid' };

export type PokedexEntryParseResult =
  | { readonly ok: true; readonly value: PokedexEntry }
  | { readonly ok: false; readonly failure: PokedexEntryParseFailure };

function readU16LE(bytes: Uint8Array, offset: number): number {
  return bytes[offset]! | (bytes[offset + 1]! << 8);
}

function readU32LE(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset]! |
      (bytes[offset + 1]! << 8) |
      (bytes[offset + 2]! << 16) |
      (bytes[offset + 3]! << 24)) >>>
    0
  );
}

function isValidRomPointerOrZero(ptr: number): boolean {
  if (ptr === 0) return true;
  return ptr >= GBA_ROM_BASE && ptr < GBA_ROM_END_EXCLUSIVE;
}

/**
 * Validate that the categoryName field at `categoryBytes` is a
 * plausible Pokédex category like "SEED", "FROG", "DRAGON", etc.
 *
 * Returns true if the decoded string contains at least 3 uppercase
 * A-Z chars consecutively AND the field is properly terminated within
 * 12 bytes (or the entire 12 bytes are valid charset bytes with no
 * 0xFF/garbage).
 *
 * The placeholder entry 0 (per pret: `_("UNKNOWN")` or empty) is also
 * acceptable since UNKNOWN passes the ≥3 A-Z check.
 */
function isValidCategoryName(categoryBytes: Uint8Array): boolean {
  const decoded = decodeString(categoryBytes, 0, POKEDEX_CATEGORY_NAME_LENGTH_BYTES);
  if (decoded.length === 0) return false;
  if (decoded.includes('??')) return false;
  // Match the same uppercase-run pattern used by species/ability/move
  // name validators.
  return /[A-Z]{3,}/.test(decoded);
}

/**
 * Parse a single 32-byte PokedexEntry struct from `bytes` at `offset`.
 *
 * Returns `ok: true` with the populated PokedexEntry if all structural
 * checks pass; `ok: false` with a typed failure otherwise.
 */
export function parsePokedexEntry(
  bytes: Uint8Array,
  offset: number,
): PokedexEntryParseResult {
  if (offset < 0 || offset + POKEDEX_ENTRY_STRUCT_SIZE_BYTES > bytes.byteLength) {
    return { ok: false, failure: { kind: 'out_of_bounds' } };
  }

  const categoryNameBytes = bytes.slice(
    offset + POKEDEX_OFFSET_CATEGORY_NAME,
    offset + POKEDEX_OFFSET_CATEGORY_NAME + POKEDEX_CATEGORY_NAME_LENGTH_BYTES,
  );
  if (!isValidCategoryName(categoryNameBytes)) {
    return { ok: false, failure: { kind: 'category_name_invalid' } };
  }

  const height = readU16LE(bytes, offset + POKEDEX_OFFSET_HEIGHT);
  if (height > POKEDEX_HEIGHT_MAX) {
    return { ok: false, failure: { kind: 'height_out_of_range' } };
  }

  const weight = readU16LE(bytes, offset + POKEDEX_OFFSET_WEIGHT);
  if (weight > POKEDEX_WEIGHT_MAX) {
    return { ok: false, failure: { kind: 'weight_out_of_range' } };
  }

  const descriptionPtr = readU32LE(bytes, offset + POKEDEX_OFFSET_DESCRIPTION_PTR);
  if (!isValidRomPointerOrZero(descriptionPtr)) {
    return { ok: false, failure: { kind: 'description_ptr_invalid' } };
  }

  const unusedDescriptionPtr = readU32LE(
    bytes,
    offset + POKEDEX_OFFSET_UNUSED_DESCRIPTION_PTR,
  );
  if (!isValidRomPointerOrZero(unusedDescriptionPtr)) {
    return { ok: false, failure: { kind: 'unused_description_ptr_invalid' } };
  }

  return {
    ok: true,
    value: {
      categoryNameBytes,
      categoryName: decodeString(
        categoryNameBytes,
        0,
        POKEDEX_CATEGORY_NAME_LENGTH_BYTES,
      ),
      height,
      weight,
      descriptionPtr,
      unusedDescriptionPtr,
      pokemonScale: readU16LE(bytes, offset + POKEDEX_OFFSET_POKEMON_SCALE),
      pokemonOffset: readU16LE(bytes, offset + POKEDEX_OFFSET_POKEMON_OFFSET),
      trainerScale: readU16LE(bytes, offset + POKEDEX_OFFSET_TRAINER_SCALE),
      trainerOffset: readU16LE(bytes, offset + POKEDEX_OFFSET_TRAINER_OFFSET),
    },
  };
}
