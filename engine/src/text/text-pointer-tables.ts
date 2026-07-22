/**
 * Gen-3 text-pointer-table scanner.
 *
 * Many Gen-3 game-content tables are arrays of u32 pointers, each
 * pointing to a Gen-3-encoded text string in ROM (terminated by 0xFF):
 *   - gMoveDescriptions     (~177 entries vanilla, ≥500 in expansion hacks)
 *   - gAbilityDescriptions  (~76 entries vanilla, ≥200 in expansion hacks)
 *   - gItemDescriptions     (~376 entries vanilla)
 *   - gPokedexEntries[].descriptionText pointer (followed via iter 82's
 *     pokedex-system; this scanner finds the flat description arrays
 *     directly)
 *   - dialogue / sign / NPC text pointer tables
 *
 * Detection approach (PD 5 - no baked offsets, universal across all
 * Gen-3 family carts incl. heavy hacks that have relocated tables):
 *  - 4-byte stride anchor scan over the ROM.
 *  - At each candidate, greedy-walk consecutive u32 pointers.
 *  - Per-pointer validity:
 *      • pointer is in ROM space (0x08000000-0x09FFFFFF)
 *      • resolved file offset is within romByteLength
 *      • decoded text at that offset has ≥3 valid Gen-3 chars before
 *        the 0xFF terminator, terminator found within MAX_TEXT_LEN
 *  - Anchor confirmation: ANCHOR_CONFIRMATION_ENTRIES consecutive
 *    valid pointers required to claim a table.
 *  - Forward-walk continues until validation fails N times in a row
 *    OR MAX_ENTRIES_PER_TABLE reached.
 *  - After accepting a table, scanning resumes PAST the table (not
 *    inside it) - multiple tables per ROM are common.
 *
 * Per PD 1: typed failure paths; never returns empty-as-success.
 * Per PD 12: each detected table's first 8 decoded strings are
 *   surfaced so the editor can show them as identification context.
 * Per PD 16: tables aren't named (could be moves/items/abilities/
 *   dialogue) - the editor displays the sample strings so operators
 *   can identify them by content.
 */

import { GBA_ROM_BASE_ADDRESS, GBA_ROM_END_ADDRESS_EXCLUSIVE } from '../pointers/index.js';
import { STRING_TERMINATOR, decodeString } from './codec.js';
import { classifyTextTable, type TextTableClassification } from './text-table-classifier.js';

/** Minimum consecutive valid pointers to claim an anchor candidate. */
export const TEXT_POINTER_TABLE_ANCHOR_CONFIRMATION_ENTRIES = 10;

/** Minimum entries in a run to accept it as a text-pointer table. */
export const TEXT_POINTER_TABLE_MIN_VALID_ENTRIES = 10;

/** Per-pointer cap on bytes walked looking for the 0xFF terminator. */
export const TEXT_POINTER_TABLE_MAX_TEXT_LEN = 256;

/** Min printable chars (not '?') a string must decode to be valid. */
export const TEXT_POINTER_TABLE_MIN_PRINTABLE_CHARS = 3;

/** Cap on entries walked per candidate table (vanilla item-desc has ~376). */
export const TEXT_POINTER_TABLE_MAX_ENTRIES_PER_TABLE = 4096;

/** Cap on total tables surfaced from one scan (prevents pathological
 *  outputs on misclassified hacks). */
export const TEXT_POINTER_TABLE_MAX_TABLES_PER_SCAN = 16;

export interface TextPointerTable {
  /** ROM file offset where the pointer table starts. */
  readonly tableOffset: number;
  /** Exclusive end offset (tableOffset + entryCount * 4). */
  readonly tableEndExclusive: number;
  /** Number of valid pointer entries in the table. */
  readonly entryCount: number;
  /** First 8 decoded strings, for editor preview / identification. */
  readonly sampleStrings: ReadonlyArray<string>;
  /** Iter 90 (UW-3-T9) - content-based classification of this table's
   *  probable kind (ability_descriptions / move_descriptions /
   *  item_descriptions / pokedex_flavor_text / dialogue /
   *  unknown_text_table) with confidence + signals. */
  readonly classification: TextTableClassification;
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

/**
 * Validate a u32 candidate as a pointer to a Gen-3-encoded text
 * string. Returns the decoded string on success, null otherwise.
 *
 * Validation:
 *   - pointer in ROM space
 *   - file offset within romByteLength
 *   - terminator (0xFF) found within MAX_TEXT_LEN bytes
 *   - decoded string has ≥MIN_PRINTABLE_CHARS non-'?' chars
 */
function validateTextPointer(
  bytes: Uint8Array,
  pointerOffset: number,
): string | null {
  if (pointerOffset + 4 > bytes.length) return null;
  const rawAddr = readUint32Le(bytes, pointerOffset);
  if (rawAddr < GBA_ROM_BASE_ADDRESS || rawAddr >= GBA_ROM_END_ADDRESS_EXCLUSIVE) {
    return null;
  }
  const targetOffset = rawAddr - GBA_ROM_BASE_ADDRESS;
  if (targetOffset < 0 || targetOffset >= bytes.length) return null;

  // Locate the 0xFF terminator (or reject if not found within MAX_TEXT_LEN).
  let terminatorPos = -1;
  for (let i = 0; i < TEXT_POINTER_TABLE_MAX_TEXT_LEN; i++) {
    const idx = targetOffset + i;
    if (idx >= bytes.length) break;
    if (bytes[idx] === STRING_TERMINATOR) {
      terminatorPos = i;
      break;
    }
  }
  if (terminatorPos < 0) return null;

  // Decode + count printable chars.
  const decoded = decodeString(bytes, targetOffset, TEXT_POINTER_TABLE_MAX_TEXT_LEN);
  let printableCount = 0;
  for (const ch of decoded) {
    if (ch !== '?') printableCount++;
    if (printableCount >= TEXT_POINTER_TABLE_MIN_PRINTABLE_CHARS) break;
  }
  if (printableCount < TEXT_POINTER_TABLE_MIN_PRINTABLE_CHARS) return null;
  return decoded;
}

/**
 * Anchor-confirm a candidate: the first ANCHOR_CONFIRMATION_ENTRIES
 * consecutive u32 pointers starting at `candidateOffset` must all
 * resolve to valid text.
 */
function confirmAnchor(bytes: Uint8Array, candidateOffset: number): boolean {
  for (let i = 0; i < TEXT_POINTER_TABLE_ANCHOR_CONFIRMATION_ENTRIES; i++) {
    if (validateTextPointer(bytes, candidateOffset + i * 4) === null) return false;
  }
  return true;
}

/**
 * Once anchored, greedy-walk forward collecting valid text pointers
 * until MAX_CONSECUTIVE_BAD invalid pointers in a row OR the entry cap
 * is reached. Returns the validated entries (each with its decoded
 * string).
 */
function walkTable(
  bytes: Uint8Array,
  tableStart: number,
): ReadonlyArray<string> {
  const MAX_CONSECUTIVE_BAD = 3;
  const strings: string[] = [];
  let consecutiveBad = 0;

  for (let i = 0; i < TEXT_POINTER_TABLE_MAX_ENTRIES_PER_TABLE; i++) {
    const pointerOffset = tableStart + i * 4;
    const decoded = validateTextPointer(bytes, pointerOffset);
    if (decoded === null) {
      consecutiveBad++;
      if (consecutiveBad >= MAX_CONSECUTIVE_BAD) break;
      continue;
    }
    consecutiveBad = 0;
    strings.push(decoded);
  }
  return strings;
}

/**
 * Scan the ROM for all text-pointer tables. Returns at most
 * MAX_TABLES_PER_SCAN tables, sorted by entryCount descending so the
 * editor surfaces the largest (most useful) tables first.
 *
 * Strategy:
 *  - 4-byte stride scan past 0xC0 header skip.
 *  - First anchor-confirmed candidate that produces ≥MIN_VALID_ENTRIES
 *    on the forward walk is accepted as a table.
 *  - After accepting, scanning resumes past the table's end (so we
 *    don't re-detect overlapping false anchors inside the same table).
 *  - Continue until end-of-ROM or MAX_TABLES_PER_SCAN tables found.
 */
export function findTextPointerTables(bytes: Uint8Array): ReadonlyArray<TextPointerTable> {
  const limit = bytes.length - TEXT_POINTER_TABLE_ANCHOR_CONFIRMATION_ENTRIES * 4;
  if (limit <= 0xc0) return Object.freeze([]);

  const tables: TextPointerTable[] = [];
  let candidate = 0xc0;
  while (
    candidate <= limit &&
    tables.length < TEXT_POINTER_TABLE_MAX_TABLES_PER_SCAN
  ) {
    if (!confirmAnchor(bytes, candidate)) {
      candidate += 4;
      continue;
    }
    const strings = walkTable(bytes, candidate);
    if (strings.length < TEXT_POINTER_TABLE_MIN_VALID_ENTRIES) {
      candidate += 4;
      continue;
    }
    const entryCount = strings.length;
    const tableEndExclusive = candidate + entryCount * 4;
    const sampleStrings = Object.freeze(strings.slice(0, 8));
    const classification = classifyTextTable({ entryCount, sampleStrings });
    tables.push(
      Object.freeze({
        tableOffset: candidate,
        tableEndExclusive,
        entryCount,
        sampleStrings,
        classification,
      }),
    );
    // Skip past the accepted table to avoid overlap re-detection.
    candidate = tableEndExclusive;
  }

  // Sort by entryCount desc so the editor sees the most populated
  // tables first (typically item descriptions > move descriptions >
  // ability descriptions > smaller dialogue tables).
  const sorted = [...tables].sort((a, b) => b.entryCount - a.entryCount);
  return Object.freeze(sorted);
}
