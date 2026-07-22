/**
 * Wild-encounters table scanner.
 *
 * The Gen-3 wild-encounters table (e.g. `gWildMonHeaders` in pret/
 * pokefirered) is a flat run of 20-byte WildPokemonHeader records
 * terminated by a sentinel (mapGroup = 0xFF). The exact ROM offset
 * varies per cart - we find it by structural scanning, not baked
 * offsets (PD 5).
 *
 * Algorithm: walk the ROM at 4-byte stride; at every position try to
 * parse a WildPokemonHeader. If it parses, greedily walk consecutive
 * records (each 20 bytes apart) until parse fails. A run of ≥
 * `minHeadersInTable` valid records (default 3) qualifies as the
 * table. The first such run wins (real Gen-3 carts have exactly one
 * encounters table per region/world).
 *
 * The greedy walk INCLUDES the sentinel record in the table extent - 
 * the table's byte range is start..(start + (N+1)×20) when the run
 * ended at a sentinel - but only the N valid records make it into the
 * report.
 *
 * Performance: ~50 ms for a 16 MiB ROM (one parse-attempt per 4-byte
 * position, fast rejection at the mapGroup/padding checks).
 */

import {
  WILD_POKEMON_HEADER_STRUCT_SIZE_BYTES,
  parseWildPokemonHeader,
  type WildPokemonHeader,
} from './encounters.js';

export interface WildEncountersTable {
  /** Start offset of the first record in the table. */
  readonly tableStart: number;
  /** End offset (exclusive) - covers all records + the sentinel if hit. */
  readonly tableEndExclusive: number;
  /** Number of valid (non-sentinel) records found. */
  readonly headerCount: number;
  /** Each parsed WildPokemonHeader, in table order. */
  readonly headers: ReadonlyArray<WildPokemonHeader>;
  /** Whether the run was terminated by a sentinel (mapGroup=0xFF) vs
   *  just failing to parse the next record. Real Gen-3 tables always
   *  terminate at a sentinel; missing one suggests the table runs into
   *  unrelated bytes (less certain detection). */
  readonly sentinelTerminated: boolean;
}

export interface ScanWildEncountersOptions {
  /** Minimum records to claim a run is the encounter table. Default 3. */
  readonly minHeadersInTable?: number;
  /** Cap on records walked per candidate - stops at this many even if
   *  parses keep succeeding. Default 4096 (vanilla Gen-3 has ~500
   *  records; this absurdly-generous cap handles even random hacks). */
  readonly maxHeadersInTable?: number;
}

/**
 * Find the wild-encounters table by scanning. Returns null when no
 * convincing run of WildPokemonHeader records exists.
 */
export function scanWildEncountersTable(
  bytes: Uint8Array,
  opts?: ScanWildEncountersOptions,
): WildEncountersTable | null {
  const minHeadersInTable = opts?.minHeadersInTable ?? 3;
  const maxHeadersInTable = opts?.maxHeadersInTable ?? 4096;
  if (!Number.isInteger(minHeadersInTable) || minHeadersInTable < 1) {
    throw new Error(
      `minHeadersInTable must be a positive integer, got ${String(minHeadersInTable)}`,
    );
  }
  if (
    !Number.isInteger(maxHeadersInTable) ||
    maxHeadersInTable < minHeadersInTable
  ) {
    throw new Error(
      `maxHeadersInTable must be >= minHeadersInTable, got ${String(maxHeadersInTable)}`,
    );
  }

  // RT-1.7: scan ALL 4-byte-aligned positions, keep the LONGEST
  // qualifying run. Pre-RT-1.7 the scanner accepted the FIRST run of
  // ≥3 records - that picked up tiny 3-entry false positives on heavy
  // hacks (Unbound, Radical Red) and never reached the real ~500-entry
  // table further into the ROM. Longest-wins replicates the species/
  // region-map fix from RT-1.1/RT-1.2.
  let best: WildEncountersTable | null = null;
  const stride = 4;
  const limit = bytes.length - WILD_POKEMON_HEADER_STRUCT_SIZE_BYTES;
  for (let candidateStart = 0; candidateStart <= limit; candidateStart += stride) {
    // Fast pre-check on padding (bytes 2-3) - almost every random
    // position has non-zero bytes here. This early-rejection keeps
    // worst-case scan time linear.
    if (bytes[candidateStart + 0x02] !== 0 || bytes[candidateStart + 0x03] !== 0) {
      continue;
    }
    const headers: WildPokemonHeader[] = [];
    let sentinelTerminated = false;
    let cursor = candidateStart;

    while (headers.length < maxHeadersInTable) {
      if (cursor + WILD_POKEMON_HEADER_STRUCT_SIZE_BYTES > bytes.length) break;
      const r = parseWildPokemonHeader(bytes, cursor);
      if (r.ok) {
        headers.push(r.header);
        cursor += WILD_POKEMON_HEADER_STRUCT_SIZE_BYTES;
        continue;
      }
      // Sentinel? Include it in the byte range and stop.
      if (r.failure.kind === 'sentinel') {
        sentinelTerminated = true;
        cursor += WILD_POKEMON_HEADER_STRUCT_SIZE_BYTES;
      }
      break;
    }

    if (headers.length >= minHeadersInTable) {
      const candidate: WildEncountersTable = Object.freeze({
        tableStart: candidateStart,
        tableEndExclusive: cursor,
        headerCount: headers.length,
        headers: Object.freeze(headers),
        sentinelTerminated,
      });
      if (best === null || candidate.headerCount > best.headerCount) {
        best = candidate;
      }
      // Skip past this run to avoid re-discovery at sub-stride offsets.
      candidateStart = cursor - stride;
    }
  }
  return best;
}
