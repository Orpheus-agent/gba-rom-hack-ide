/**
 * gMapGroups outer-table detector.
 *
 * The Gen-3 `gMapGroups` global is a pointer-to-pointer-table: each
 * entry is a pointer to a per-group inner table of MapHeader pointers.
 * The outer table's index is the map group; the inner table's index is
 * the map number. Warps and connections use those two numbers, so this
 * detector is what turns "bank 3 map 5" into a real map node.
 *
 * Vanilla FireRed stores all inner groups as slices of one large flat
 * pointer table, then stores the outer table immediately after it. That
 * means a valid outer entry often points inside a discovered map-pointer
 * table, not only at the table's first byte.
 */

import {
  GBA_ROM_BASE_ADDRESS,
  discoverPointers,
  findPointerTables,
  type PointerTable,
} from '../pointers/index.js';

export interface MapGroupsOuterTable {
  /** Start offset of the outer pointer table. */
  readonly tableStart: number;
  /** Per-group entry: which inner-map-table this group's pointer references. */
  readonly groups: ReadonlyArray<{
    readonly groupIndex: number;
    readonly innerTableStart: number;
  }>;
}

export interface MapGroupsInnerTableRange {
  readonly tableStart: number;
  readonly tableEndExclusive: number;
}

export type MapGroupsInnerTableRef = number | MapGroupsInnerTableRange;

interface OuterTableEntry {
  readonly sourceOffset: number;
  readonly targetOffset: number;
}

interface OuterTableCandidate {
  readonly tableStart: number;
  readonly entries: ReadonlyArray<OuterTableEntry>;
  readonly matches: number;
  readonly matchFraction: number;
}

/**
 * Find the outer gMapGroups pointer table given discovered inner map
 * tables or ranges that contain inner group starts. Returns null when no
 * convincing candidate exists.
 */
export function findMapGroupsOuterTable(
  bytes: Uint8Array,
  innerTableRefs: ReadonlyArray<MapGroupsInnerTableRef>,
): MapGroupsOuterTable | null {
  if (innerTableRefs.length === 0) return null;

  const matcher = makeInnerTableMatcher(innerTableRefs);
  const pointers = discoverPointers(bytes);
  const minTableLength = Math.max(2, Math.min(3, innerTableRefs.length));
  const tables = findPointerTables(pointers, { minTableLength });

  let bestCandidate: OuterTableCandidate | null = null;
  for (const table of tables) {
    bestCandidate = chooseBetterOuterTableCandidate(
      bestCandidate,
      candidateFromPointerTable(table, matcher),
    );
  }

  // FireRed's outer table can be embedded in a larger pointer run. Scan
  // for a strict consecutive sub-run whose targets are group starts.
  for (const candidate of scanEmbeddedOuterTableRuns(bytes, matcher, minTableLength)) {
    bestCandidate = chooseBetterOuterTableCandidate(bestCandidate, candidate);
  }

  if (bestCandidate === null) return null;

  const groups = bestCandidate.entries.map((p, i) => ({
    groupIndex: i,
    innerTableStart: p.targetOffset,
  }));

  return Object.freeze({
    tableStart: bestCandidate.tableStart,
    groups: Object.freeze(groups),
  });
}

function candidateFromPointerTable(
  table: PointerTable,
  matcher: (targetOffset: number) => boolean,
): OuterTableCandidate | null {
  let matches = 0;
  for (const p of table.entries) {
    if (matcher(p.targetOffset)) matches++;
  }
  const matchFraction = matches / table.entries.length;
  if (matchFraction < 0.5 || matches < 1) return null;
  return {
    tableStart: table.start,
    entries: Object.freeze(
      table.entries.map((p) => ({
        sourceOffset: p.sourceOffset,
        targetOffset: p.targetOffset,
      })),
    ),
    matches,
    matchFraction,
  };
}

function chooseBetterOuterTableCandidate(
  current: OuterTableCandidate | null,
  next: OuterTableCandidate | null,
): OuterTableCandidate | null {
  if (next === null) return current;
  if (current === null) return next;
  if (next.matches !== current.matches) {
    return next.matches > current.matches ? next : current;
  }
  if (next.matchFraction !== current.matchFraction) {
    return next.matchFraction > current.matchFraction ? next : current;
  }
  return next.tableStart < current.tableStart ? next : current;
}

function scanEmbeddedOuterTableRuns(
  bytes: Uint8Array,
  matcher: (targetOffset: number) => boolean,
  minTableLength: number,
): OuterTableCandidate[] {
  const candidates: OuterTableCandidate[] = [];
  let run: OuterTableEntry[] = [];

  const flush = (): void => {
    if (run.length >= minTableLength) {
      candidates.push({
        tableStart: run[0]!.sourceOffset,
        entries: Object.freeze([...run]),
        matches: run.length,
        matchFraction: 1,
      });
    }
    run = [];
  };

  for (let sourceOffset = 0; sourceOffset + 4 <= bytes.length; sourceOffset += 4) {
    const targetOffset = readRomPointerTargetOffset(bytes, sourceOffset);
    if (targetOffset !== null && matcher(targetOffset)) {
      run.push({ sourceOffset, targetOffset });
    } else {
      flush();
    }
  }
  flush();

  return candidates;
}

function makeInnerTableMatcher(
  refs: ReadonlyArray<MapGroupsInnerTableRef>,
): (targetOffset: number) => boolean {
  const exactStarts = new Set<number>();
  const ranges: MapGroupsInnerTableRange[] = [];
  for (const ref of refs) {
    if (typeof ref === 'number') {
      exactStarts.add(ref);
      continue;
    }
    if (ref.tableEndExclusive <= ref.tableStart) continue;
    exactStarts.add(ref.tableStart);
    ranges.push(ref);
  }

  return (targetOffset: number): boolean => {
    if (exactStarts.has(targetOffset)) return true;
    for (const range of ranges) {
      if (
        targetOffset >= range.tableStart &&
        targetOffset < range.tableEndExclusive &&
        (targetOffset - range.tableStart) % 4 === 0
      ) {
        return true;
      }
    }
    return false;
  };
}

function readRomPointerTargetOffset(bytes: Uint8Array, offset: number): number | null {
  const rawAddress =
    ((bytes[offset] ?? 0) |
      ((bytes[offset + 1] ?? 0) << 8) |
      ((bytes[offset + 2] ?? 0) << 16) |
      ((bytes[offset + 3] ?? 0) << 24)) >>>
    0;
  const targetOffset = rawAddress - GBA_ROM_BASE_ADDRESS;
  if (targetOffset < 0 || targetOffset >= bytes.length) return null;
  return targetOffset;
}
