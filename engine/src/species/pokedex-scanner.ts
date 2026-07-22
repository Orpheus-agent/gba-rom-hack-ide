/**
 * Gen-3 gPokedexEntries table scanner - Phase UW-3 / Category 3
 * substrate (iter 82 / UW-3-T1).
 *
 * Scans ROM for the gPokedexEntries table - an array of 32-byte
 * PokedexEntry structs indexed by NATIONAL_DEX number (entry 0 is a
 * placeholder; entries 1..N are real species).
 *
 * Strategy:
 *   1. Linear-scan 4-byte-aligned offsets past the cartridge header.
 *   2. At each position try `parsePokedexEntry`. If it succeeds AND
 *      the next 9 records also parse (= 10 consecutive valid records),
 *      that's the table anchor.
 *   3. From the anchor, walk forward in 32-byte strides counting
 *      valid records. Stop on first parse failure.
 *   4. Track the LONGEST run across all candidates.
 *   5. Require ≥ POKEDEX_SCAN_MIN_RECORDS for confident detection
 *      (vanilla FRLG has 411 entries; even cut-down hacks rarely
 *      drop below 200; 100 is a defensive floor).
 *
 * Skips cartridge header (0..0xBF).
 *
 * PD 12 honored: returns the LONGEST run; doesn't silently absorb
 * multiple candidate tables.
 */

import {
  POKEDEX_ENTRY_STRUCT_SIZE_BYTES,
  parsePokedexEntry,
} from './pokedex-entry.js';

/** Minimum records required for confident Pokédex-table detection. */
export const POKEDEX_SCAN_MIN_RECORDS = 100;

/** Max records walked from any single anchor (defensive cap). */
export const POKEDEX_SCAN_MAX_RECORDS = 4096;

/** How many records must parse consecutively to confirm an anchor (vs
 *  a stray run of valid-looking bytes). */
const POKEDEX_ANCHOR_CONFIRMATION_COUNT = 10;

const CARTRIDGE_HEADER_END = 0xc0;

export interface PokedexTable {
  /** Absolute byte offset of the first record (entry 0 placeholder). */
  readonly tableStart: number;
  /** Absolute byte offset one past the last record. */
  readonly tableEndExclusive: number;
  /** Number of records found. */
  readonly entryCount: number;
}

export interface PokedexScanOptions {
  readonly minRecords?: number;
  readonly maxRecords?: number;
}

/**
 * Find the longest valid gPokedexEntries table. Returns null if no
 * run reaches the min-records threshold.
 */
export function scanPokedexTable(
  bytes: Uint8Array,
  options: PokedexScanOptions = {},
): PokedexTable | null {
  const minRecords = options.minRecords ?? POKEDEX_SCAN_MIN_RECORDS;
  const maxRecords = options.maxRecords ?? POKEDEX_SCAN_MAX_RECORDS;

  if (
    bytes.byteLength <
    CARTRIDGE_HEADER_END + minRecords * POKEDEX_ENTRY_STRUCT_SIZE_BYTES
  ) {
    return null;
  }

  let best: PokedexTable | null = null;
  const limit = bytes.byteLength - POKEDEX_ENTRY_STRUCT_SIZE_BYTES;

  for (let p = CARTRIDGE_HEADER_END; p <= limit; p += 4) {
    // Anchor confirmation: require N consecutive valid records starting
    // at p. This filters out stray "looks-like-a-Pokédex-entry" windows
    // (very rare given the multi-field validator but cheap to guard).
    let confirmed = true;
    for (let i = 0; i < POKEDEX_ANCHOR_CONFIRMATION_COUNT; i++) {
      const recordOffset = p + i * POKEDEX_ENTRY_STRUCT_SIZE_BYTES;
      if (recordOffset + POKEDEX_ENTRY_STRUCT_SIZE_BYTES > bytes.byteLength) {
        confirmed = false;
        break;
      }
      const r = parsePokedexEntry(bytes, recordOffset);
      if (!r.ok) {
        confirmed = false;
        break;
      }
    }
    if (!confirmed) continue;

    // Walk forward to find the run length.
    let count = POKEDEX_ANCHOR_CONFIRMATION_COUNT;
    let cursor = p + POKEDEX_ANCHOR_CONFIRMATION_COUNT * POKEDEX_ENTRY_STRUCT_SIZE_BYTES;
    while (
      cursor + POKEDEX_ENTRY_STRUCT_SIZE_BYTES <= bytes.byteLength &&
      count < maxRecords
    ) {
      const r = parsePokedexEntry(bytes, cursor);
      if (!r.ok) break;
      count++;
      cursor += POKEDEX_ENTRY_STRUCT_SIZE_BYTES;
    }

    if (count < minRecords) {
      // Skip past this run to avoid re-anchoring inside it.
      p = cursor;
      continue;
    }

    const candidate: PokedexTable = {
      tableStart: p,
      tableEndExclusive: p + count * POKEDEX_ENTRY_STRUCT_SIZE_BYTES,
      entryCount: count,
    };
    if (best === null || candidate.entryCount > best.entryCount) {
      best = candidate;
    }
    p = cursor;
  }

  return best;
}
