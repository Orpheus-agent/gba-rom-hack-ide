/**
 * Gen-3 Type Effectiveness Chart scanner - Phase UW-2 / Category 4
 * substrate (iter 69 / UW-2-T3).
 *
 * Scans a ROM image for the gTypeEffectiveness table by anchoring on the
 * `0xFF 0xFF 0x00` end-table sentinel and walking BACKWARD by 3-byte
 * triplets, accepting each valid (matchup | foresight separator) triplet.
 *
 * Strategy:
 *   1. Find every byte offset where bytes[i]=0xFF && bytes[i+1]=0xFF
 *      && bytes[i+2]=0x00 (end-table sentinel candidate).
 *   2. For each candidate, walk backward in 3-byte steps. Stop when
 *      `parseTypeMatchup` returns a failure or when we've walked back
 *      to offset 0.
 *   3. Track the longest valid run (greatest matchup+separator count).
 *   4. Require ≥ TYPE_CHART_SCAN_MIN_TRIPLETS for confident detection
 *      (vanilla Gen-3 tables have ~107 triplets - well above the floor).
 *
 * Skips the GBA cartridge header (offset 0..0xBF) where these byte
 * patterns are common in fixed-marker / Nintendo-logo regions.
 *
 * PD 12 honored: returns the LONGEST run found; if multiple terminators
 * yield runs above the threshold, only the longest is kept. Multiple
 * candidate tables are NOT silently absorbed - caller can re-scan with
 * a higher minimum if needed.
 */

import {
  TYPE_MATCHUP_SIZE_BYTES,
  TYPE_CHART_ENDTABLE_SENTINEL,
  parseTypeMatchup,
  type TypeMatchup,
} from './type-chart.js';

/** Minimum triplets (matchups + separators) required to be confident. */
export const TYPE_CHART_SCAN_MIN_TRIPLETS = 30;

/** Cartridge-header skip - `parseTypeMatchup` never matches in 0..0xBF
 *  for vanilla, but skipping makes scanner output deterministic across
 *  ROMs whose header bytes happen to align coincidentally. */
const CARTRIDGE_HEADER_END = 0xc0;

export interface TypeChartTable {
  /** Absolute byte offset of the first triplet in the run. */
  readonly tableStart: number;
  /** Absolute byte offset one past the end-table sentinel (so the
   *  end-table triplet is included). */
  readonly tableEndExclusive: number;
  /** Count of all triplets (matchups + foresight separators + end-table). */
  readonly tripletCount: number;
  /** Count of (matchup-kind) triplets only - i.e. real type effectiveness
   *  rules. Vanilla FireRed: ~107; LeafGreen: ~107; Emerald: similar. */
  readonly matchupCount: number;
  /** True if the table contained a foresight separator (0xFE 0xFE 0x00). */
  readonly hasForesightSeparator: boolean;
  /** Iter 97 (UW-3-T16) - parsed matchup triplets in table order
   *  (first matchup at index 0). Empty for foresight separators and
   *  the end-table sentinel which are filtered out here. Lifter-
   *  consumed by app/backend/src/scan/binary-rom-registry.ts. */
  readonly matchups: ReadonlyArray<TypeMatchup>;
}

export interface TypeChartScanOptions {
  /** Minimum triplets required (default = TYPE_CHART_SCAN_MIN_TRIPLETS). */
  readonly minTriplets?: number;
}

/**
 * Find the longest valid gTypeEffectiveness table in `bytes`. Returns
 * `null` if no run reaches the min-triplets threshold.
 */
export function scanTypeChart(
  bytes: Uint8Array,
  options: TypeChartScanOptions = {},
): TypeChartTable | null {
  const minTriplets = options.minTriplets ?? TYPE_CHART_SCAN_MIN_TRIPLETS;
  if (bytes.byteLength < CARTRIDGE_HEADER_END + minTriplets * TYPE_MATCHUP_SIZE_BYTES) {
    return null;
  }

  let best: TypeChartTable | null = null;

  // Find candidate end-table sentinels by linear scan.
  for (let i = CARTRIDGE_HEADER_END; i + 2 < bytes.byteLength; i++) {
    if (
      bytes[i] !== TYPE_CHART_ENDTABLE_SENTINEL ||
      bytes[i + 1] !== TYPE_CHART_ENDTABLE_SENTINEL ||
      bytes[i + 2] !== 0
    ) {
      continue;
    }

    // Found an end-table candidate at offset i. Walk backward.
    const tableEndExclusive = i + TYPE_MATCHUP_SIZE_BYTES;
    let tripletCount = 1; // count the end-table sentinel itself
    let matchupCount = 0;
    let hasForesight = false;
    // Iter 97 - accumulate parsed matchups in backward order; reverse
    // before returning so the consumer sees table order (matchup #0
    // first).
    const matchupsBackward: TypeMatchup[] = [];
    let cursor = i - TYPE_MATCHUP_SIZE_BYTES;

    while (cursor >= CARTRIDGE_HEADER_END) {
      const result = parseTypeMatchup(bytes, cursor);
      if (!result.ok) break;
      if (result.value.kind === 'matchup') {
        matchupCount++;
        matchupsBackward.push(result.value);
      } else if (result.value.kind === 'foresight_separator') {
        hasForesight = true;
      } else {
        // Another end_table inside the run - stop here; this is a
        // second table starting where the current one began.
        break;
      }
      tripletCount++;
      cursor -= TYPE_MATCHUP_SIZE_BYTES;
    }

    // tableStart = cursor + TYPE_MATCHUP_SIZE_BYTES (cursor stopped one
    // step too far back).
    const tableStart = cursor + TYPE_MATCHUP_SIZE_BYTES;

    if (tripletCount < minTriplets) continue;

    const candidate: TypeChartTable = {
      tableStart,
      tableEndExclusive,
      tripletCount,
      matchupCount,
      hasForesightSeparator: hasForesight,
      matchups: Object.freeze([...matchupsBackward].reverse()),
    };

    if (best === null || candidate.tripletCount > best.tripletCount) {
      best = candidate;
    }
  }

  return best;
}
