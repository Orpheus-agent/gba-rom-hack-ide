import { describe, expect, it } from 'vitest';
import { findPointerTables } from './tables.js';
import type { RomPointer } from './discovery.js';

function pointersAt(starts: number[]): RomPointer[] {
  return starts.map((s) => ({ sourceOffset: s, targetOffset: 1000, rawAddress: 0x08000000 + 1000 }));
}

describe('findPointerTables', () => {
  it('returns empty array for empty input', () => {
    expect(findPointerTables([])).toEqual([]);
  });

  it('returns empty array when no run reaches minTableLength', () => {
    expect(findPointerTables(pointersAt([0, 4, 8]))).toEqual([]); // run of 3, default min=8
  });

  it('finds a single dense run of 8 entries', () => {
    const tables = findPointerTables(pointersAt([0, 4, 8, 12, 16, 20, 24, 28]));
    expect(tables).toHaveLength(1);
    expect(tables[0]?.length).toBe(8);
    expect(tables[0]?.start).toBe(0);
    expect(tables[0]?.endExclusive).toBe(32);
  });

  it('finds multiple tables separated by gaps', () => {
    const ptrs = pointersAt([
      0, 4, 8, 12, 16, 20, 24, 28, // table A (length 8)
      100, // isolated
      200, 204, 208, 212, 216, 220, 224, 228, 232, // table B (length 9)
    ]);
    const tables = findPointerTables(ptrs);
    expect(tables).toHaveLength(2);
    expect(tables[0]?.start).toBe(0);
    expect(tables[0]?.length).toBe(8);
    expect(tables[1]?.start).toBe(200);
    expect(tables[1]?.length).toBe(9);
  });

  it('honors custom minTableLength', () => {
    const ptrs = pointersAt([0, 4, 8, 12]);
    expect(findPointerTables(ptrs, { minTableLength: 4 })).toHaveLength(1);
    expect(findPointerTables(ptrs, { minTableLength: 5 })).toHaveLength(0);
  });

  it('does NOT treat stride-8 pointers as a table', () => {
    expect(findPointerTables(pointersAt([0, 8, 16, 24, 32, 40, 48, 56]))).toEqual([]);
  });

  it('does NOT include runs broken by non-consecutive entries', () => {
    // 4 in a row, gap, 4 more - both runs are below default 8.
    expect(findPointerTables(pointersAt([0, 4, 8, 12, 100, 104, 108, 112]))).toEqual([]);
  });

  it('handles unsorted input by sorting internally', () => {
    const ptrs = pointersAt([28, 0, 12, 8, 24, 16, 4, 20]);
    const tables = findPointerTables(ptrs);
    expect(tables).toHaveLength(1);
    expect(tables[0]?.start).toBe(0);
    expect(tables[0]?.length).toBe(8);
  });

  it('rejects invalid minTableLength', () => {
    expect(() => findPointerTables(pointersAt([0, 4]), { minTableLength: 1 })).toThrow();
    expect(() => findPointerTables(pointersAt([0, 4]), { minTableLength: 1.5 })).toThrow();
  });

  it('freezes returned tables and entries arrays', () => {
    const tables = findPointerTables(pointersAt([0, 4, 8, 12, 16, 20, 24, 28]));
    expect(Object.isFrozen(tables[0])).toBe(true);
    expect(Object.isFrozen(tables[0]!.entries)).toBe(true);
  });
});
