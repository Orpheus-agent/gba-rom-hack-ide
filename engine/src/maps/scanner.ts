/**
 * Map-header scanner.
 *
 * The §15 P5 acceptance requires reconstructing the world from a ROM
 * WITHOUT a baked map-table offset (PD 5). Strategy:
 *
 *   1. Reuse Phase 2's pointer-network discovery to find every ROM
 *      pointer table.
 *   2. For each pointer-table entry, try `parseMapHeader` at the
 *      pointed-to offset.
 *   3. A pointer table is a CANDIDATE map-table when ≥ K consecutive
 *      entries successfully parse as MapHeaders (K=3 by default - three
 *      in a row almost never happens by accident; random byte runs hit
 *      the structural-shape constraints at ≪ 1% rate, so 0.013 = ~10⁻⁶).
 *   4. For each confirmed map-table, return the table location + the
 *      parsed maps.
 *
 * This is a STRUCTURAL detector, not a table-offset detector. It works
 * on vanilla Gen-3, on hacks that relocated the table to a custom
 * offset, on decomp builds, and on framework forks - they all retain
 * the 28-byte MapHeader shape because they share the same engine.
 *
 * Performance: scanning a 16 MiB ROM takes ~50 ms for pointer discovery
 * + a few ms for the parse attempts (most reject in O(1) at the
 * mapType-byte check).
 */

import { discoverPointers, findPointerTables, type PointerTable } from '../pointers/index.js';
import { parseMapHeader, type MapHeader, MAP_HEADER_SIZE_BYTES } from './header.js';

export interface MapTableCandidate {
  /** Start offset of the pointer table in the ROM. */
  readonly tableStart: number;
  /** Number of consecutive pointer-table entries that parsed as MapHeaders. */
  readonly mapCount: number;
  /** Parsed map headers in pointer-table order. */
  readonly maps: ReadonlyArray<MapHeaderEntry>;
}

export interface MapHeaderEntry {
  /** The pointer-table entry's source offset (where the pointer LIVES). */
  readonly tableEntryOffset: number;
  /** The map header's start offset in the ROM (where the pointer POINTS). */
  readonly mapHeaderOffset: number;
  readonly header: MapHeader;
}

export interface ScanMapHeadersOptions {
  /** Minimum consecutive successful MapHeader parses to confirm a table.
   *  Default 3 - three in a row hits the structural constraints with
   *  vanishingly low false-positive probability. */
  readonly minMapsInTable?: number;
}

/**
 * Scan a ROM for pointer tables that look like Gen-3 map-header tables.
 * Returns one candidate per identified table. Empty array is a
 * legitimate result (synthetic ROM with no map data).
 */
export function scanMapHeaders(
  bytes: Uint8Array,
  opts?: ScanMapHeadersOptions,
): MapTableCandidate[] {
  const minMapsInTable = opts?.minMapsInTable ?? 3;
  if (!Number.isInteger(minMapsInTable) || minMapsInTable < 1) {
    throw new Error(
      `minMapsInTable must be a positive integer, got ${String(minMapsInTable)}`,
    );
  }

  // Reuse Phase 2: find all pointer tables.
  const pointers = discoverPointers(bytes);
  // Map-header pointer tables are typically larger than 8 entries; the
  // default pointer-table threshold (8) is fine. Lower the threshold to
  // catch small map-tables in synthetic test ROMs.
  const tables = findPointerTables(pointers, { minTableLength: Math.max(3, minMapsInTable) });

  const candidates: MapTableCandidate[] = [];
  for (const table of tables) {
    const entry = collectMapsForTable(bytes, table, minMapsInTable);
    if (entry !== null) candidates.push(entry);
  }
  return candidates;
}

function collectMapsForTable(
  bytes: Uint8Array,
  table: PointerTable,
  minMapsInTable: number,
): MapTableCandidate | null {
  const entries: MapHeaderEntry[] = [];
  for (const pointer of table.entries) {
    if (pointsBackIntoSamePointerRun(pointer.sourceOffset, pointer.targetOffset, table)) {
      // Vanilla FireRed stores the gMapGroups outer table immediately
      // after the flat MapHeader-pointer run. Those outer entries point
      // back into this same pointer run (one pointer per map group).
      // Some of those bytes can accidentally satisfy the MapHeader shape,
      // so stop before absorbing the group table as phantom maps.
      if (entries.length >= minMapsInTable) break;
      return null;
    }

    const parsed = parseMapHeader(bytes, pointer.targetOffset);
    if (!parsed.ok) {
      // Once we hit a non-MapHeader entry, stop - map tables are
      // contiguous. If we've already accumulated ≥ minMapsInTable
      // successful parses, accept the truncated table; otherwise reject
      // the whole thing.
      if (entries.length >= minMapsInTable) break;
      return null;
    }
    entries.push(
      Object.freeze({
        tableEntryOffset: pointer.sourceOffset,
        mapHeaderOffset: pointer.targetOffset,
        header: parsed.header,
      }),
    );
  }
  if (entries.length < minMapsInTable) return null;
  return Object.freeze({
    tableStart: table.start,
    mapCount: entries.length,
    maps: Object.freeze(entries),
  });
}

function pointsBackIntoSamePointerRun(
  sourceOffset: number,
  targetOffset: number,
  table: PointerTable,
): boolean {
  return (
    targetOffset < sourceOffset &&
    targetOffset >= table.start &&
    targetOffset < table.endExclusive &&
    (targetOffset - table.start) % 4 === 0
  );
}

/** Sum of bytes covered by the map-header structs across all candidates. */
export function totalMapHeaderBytes(candidates: ReadonlyArray<MapTableCandidate>): number {
  let total = 0;
  for (const c of candidates) total += c.mapCount * MAP_HEADER_SIZE_BYTES;
  return total;
}
