import { describe, expect, it } from 'vitest';
import { GBA_ROM_BASE_ADDRESS } from '../pointers/index.js';
import { findMapGroupsOuterTable } from './groups.js';

describe('findMapGroupsOuterTable', () => {
  it('returns null for empty innerTableStarts', () => {
    expect(findMapGroupsOuterTable(new Uint8Array(1024), [])).toBeNull();
  });

  it('returns null when no pointer table matches', () => {
    const buf = new Uint8Array(1024);
    // Plant random pointers that don't match any inner-table start.
    for (let i = 0; i < 4; i++) {
      buf[i * 4 + 3] = 0x08;
      buf[i * 4 + 2] = 0x00;
      buf[i * 4 + 1] = (i * 0x20) & 0xff;
      buf[i * 4] = 0;
    }
    expect(findMapGroupsOuterTable(buf, [0xff0, 0xfe0])).toBeNull();
  });

  it('finds an outer table when its entries match inner-table starts', () => {
    const buf = Buffer.alloc(16 * 1024);
    // Plant 3 inner-table starts at known offsets (we don't need real
    // pointer tables there - findMapGroupsOuterTable only matches by
    // outer-table entries POINTING at those offsets).
    const innerStarts = [0x1000, 0x2000, 0x3000];
    // Plant the outer table at 0x100: 3 consecutive pointers pointing
    // at 0x1000 / 0x2000 / 0x3000.
    for (let i = 0; i < 3; i++) {
      buf.writeUInt32LE((GBA_ROM_BASE_ADDRESS + innerStarts[i]!) >>> 0, 0x100 + i * 4);
    }
    // Plant a 5th pointer just so the run extends past 3 for the
    // findPointerTables min-length check. Use one of the inner starts so
    // matchFraction stays high.
    buf.writeUInt32LE((GBA_ROM_BASE_ADDRESS + 0x1000) >>> 0, 0x100 + 3 * 4);
    buf.writeUInt32LE((GBA_ROM_BASE_ADDRESS + 0x1000) >>> 0, 0x100 + 4 * 4);

    const r = findMapGroupsOuterTable(buf, innerStarts);
    expect(r).not.toBeNull();
    if (r !== null) {
      expect(r.tableStart).toBe(0x100);
      expect(r.groups.length).toBe(5);
      expect(r.groups[0]?.groupIndex).toBe(0);
      expect(r.groups[0]?.innerTableStart).toBe(0x1000);
      expect(r.groups[1]?.groupIndex).toBe(1);
      expect(r.groups[1]?.innerTableStart).toBe(0x2000);
    }
  });

  it('finds FireRed-style outer entries that point inside a flat map table range', () => {
    const buf = Buffer.alloc(16 * 1024);
    const innerTableRange = { tableStart: 0x1000, tableEndExclusive: 0x1100 };
    // The real FRLG gMapGroups entries point to group starts within the
    // flat MapHeader pointer table, not to independently discovered
    // table starts.
    for (const [i, target] of [0x1000, 0x1010, 0x1040].entries()) {
      buf.writeUInt32LE((GBA_ROM_BASE_ADDRESS + target) >>> 0, 0x200 + i * 4);
    }

    const r = findMapGroupsOuterTable(buf, [innerTableRange]);
    expect(r).not.toBeNull();
    if (r !== null) {
      expect(r.tableStart).toBe(0x200);
      expect(r.groups.map((g) => g.groupIndex)).toEqual([0, 1, 2]);
      expect(r.groups.map((g) => g.innerTableStart)).toEqual([0x1000, 0x1010, 0x1040]);
    }
  });

  it('rejects a table where < 50% of entries match', () => {
    const buf = Buffer.alloc(16 * 1024);
    const innerStarts = [0x1000];
    // Plant a 5-entry pointer table where only 1 entry matches.
    buf.writeUInt32LE((GBA_ROM_BASE_ADDRESS + 0x1000) >>> 0, 0x100 + 0 * 4);
    buf.writeUInt32LE((GBA_ROM_BASE_ADDRESS + 0x500) >>> 0, 0x100 + 1 * 4);
    buf.writeUInt32LE((GBA_ROM_BASE_ADDRESS + 0x600) >>> 0, 0x100 + 2 * 4);
    buf.writeUInt32LE((GBA_ROM_BASE_ADDRESS + 0x700) >>> 0, 0x100 + 3 * 4);
    buf.writeUInt32LE((GBA_ROM_BASE_ADDRESS + 0x800) >>> 0, 0x100 + 4 * 4);
    expect(findMapGroupsOuterTable(buf, innerStarts)).toBeNull();
  });

  it('prefers the candidate with the most matching entries', () => {
    const buf = Buffer.alloc(16 * 1024);
    const innerStarts = [0x1000, 0x2000, 0x3000];

    // Candidate A at 0x100: 3 of 3 entries match (100%).
    buf.writeUInt32LE((GBA_ROM_BASE_ADDRESS + 0x1000) >>> 0, 0x100 + 0 * 4);
    buf.writeUInt32LE((GBA_ROM_BASE_ADDRESS + 0x2000) >>> 0, 0x100 + 1 * 4);
    buf.writeUInt32LE((GBA_ROM_BASE_ADDRESS + 0x3000) >>> 0, 0x100 + 2 * 4);

    // Candidate B at 0x200: 2 of 3 entries match (66%).
    buf.writeUInt32LE((GBA_ROM_BASE_ADDRESS + 0x1000) >>> 0, 0x200 + 0 * 4);
    buf.writeUInt32LE((GBA_ROM_BASE_ADDRESS + 0x2000) >>> 0, 0x200 + 1 * 4);
    buf.writeUInt32LE((GBA_ROM_BASE_ADDRESS + 0x9999) >>> 0, 0x200 + 2 * 4);

    const r = findMapGroupsOuterTable(buf, innerStarts);
    expect(r?.tableStart).toBe(0x100);
  });

  it('freezes returned MapGroupsOuterTable + groups array', () => {
    const buf = Buffer.alloc(16 * 1024);
    const innerStarts = [0x1000, 0x2000, 0x3000];
    for (let i = 0; i < 3; i++) {
      buf.writeUInt32LE((GBA_ROM_BASE_ADDRESS + innerStarts[i]!) >>> 0, 0x100 + i * 4);
    }
    const r = findMapGroupsOuterTable(buf, innerStarts);
    if (r !== null) {
      expect(Object.isFrozen(r)).toBe(true);
      expect(Object.isFrozen(r.groups)).toBe(true);
    }
  });
});
