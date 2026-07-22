/**
 * Pointer-table detection.
 *
 * A Pokémon-family ROM contains many pointer tables - arrays of 32-bit
 * pointers stored contiguously (stride 4) that index into other data
 * regions (species name table, trainer table, map header table, script
 * table, etc.). They're how the engine implements polymorphism without
 * inheritance: code reads the table by index, then dereferences.
 *
 * Structural recognition: a "table" is a run of N consecutive pointers
 * at stride 4 (the natural ARM word alignment for pointer arrays). Without
 * any Pokémon-specific knowledge we can find these by walking the
 * discovered-pointers list and grouping consecutive entries whose
 * sourceOffset deltas are exactly 4.
 *
 * Threshold tuning: short runs (≤ ~6 entries) are usually ARM literal
 * pools - the assembler emits 32-bit constants right after a function so
 * a `LDR rN, [PC, #imm]` can load them. The constants OFTEN look like ROM
 * pointers because ARM code does PC-relative addressing into ROM data.
 * Real data tables are typically 16+ entries. We default `minTableLength`
 * to 8 - catches most real tables, rejects most literal pools. Operators
 * needing tighter discrimination can pass their own threshold.
 */

import type { RomPointer } from './discovery.js';

export interface PointerTable {
  /** First byte of the table within the ROM file. */
  readonly start: number;
  /** Exclusive end (= start + length * 4). */
  readonly endExclusive: number;
  /** Number of entries (= consecutive pointers). */
  readonly length: number;
  /** The discovered pointers in source-offset order. */
  readonly entries: ReadonlyArray<RomPointer>;
}

export interface FindPointerTablesOptions {
  /** Minimum length to consider a run a "table" (default 8). */
  readonly minTableLength?: number;
}

/**
 * Group `pointers` into pointer tables - runs of consecutive entries at
 * sourceOffset stride 4. Pointers do NOT need to be pre-sorted; this
 * function sorts a copy.
 *
 * Returns tables in ascending start-offset order. Empty array when no run
 * reaches `minTableLength`.
 */
export function findPointerTables(
  pointers: ReadonlyArray<RomPointer>,
  opts?: FindPointerTablesOptions,
): PointerTable[] {
  const minTableLength = opts?.minTableLength ?? 8;
  if (!Number.isInteger(minTableLength) || minTableLength < 2) {
    throw new Error(
      `minTableLength must be an integer ≥ 2, got ${String(minTableLength)}`,
    );
  }
  if (pointers.length === 0) return [];

  const sorted = [...pointers].sort((a, b) => a.sourceOffset - b.sourceOffset);
  const tables: PointerTable[] = [];

  let runStart = 0;
  for (let i = 1; i <= sorted.length; i++) {
    const prev = sorted[i - 1];
    const cur = i < sorted.length ? sorted[i] : undefined;
    const stillConsecutive =
      cur !== undefined &&
      prev !== undefined &&
      cur.sourceOffset - prev.sourceOffset === 4;
    if (!stillConsecutive) {
      const runLength = i - runStart;
      if (runLength >= minTableLength) {
        const entries = sorted.slice(runStart, i);
        const startEntry = entries[0]!;
        const lastEntry = entries[entries.length - 1]!;
        tables.push(
          Object.freeze({
            start: startEntry.sourceOffset,
            endExclusive: lastEntry.sourceOffset + 4,
            length: runLength,
            entries: Object.freeze(entries),
          }),
        );
      }
      runStart = i;
    }
  }
  return tables;
}
