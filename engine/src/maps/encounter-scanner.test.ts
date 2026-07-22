import { describe, expect, it } from 'vitest';
import { GBA_ROM_BASE_ADDRESS } from '../pointers/index.js';
import {
  WILD_ENCOUNTERS_SENTINEL_MAP_GROUP,
  WILD_POKEMON_HEADER_STRUCT_SIZE_BYTES as REC,
} from './encounters.js';
import { scanWildEncountersTable } from './encounter-scanner.js';

/** Plant N consecutive valid headers + optional sentinel at `tableAt`. */
function plantTable(args: {
  bufferSize?: number;
  tableAt: number;
  /** Records: each provides at least mapGroup/mapNum. land/water etc.
   *  pointers default to a plausible target inside the buffer. */
  records: Array<{ mapGroup: number; mapNum: number }>;
  sentinel?: boolean;
  /** Optional ROM file offset for land mons that all records share. */
  landMonsAt?: number;
}): Buffer {
  const buf = Buffer.alloc(args.bufferSize ?? 0x4000);
  const landMonsAt = args.landMonsAt ?? 0x800;
  const landPtr = (GBA_ROM_BASE_ADDRESS + landMonsAt) >>> 0;

  for (let i = 0; i < args.records.length; i++) {
    const r = args.records[i]!;
    const off = args.tableAt + i * REC;
    buf[off + 0x00] = r.mapGroup;
    buf[off + 0x01] = r.mapNum;
    buf.writeUInt16LE(0, off + 0x02);
    buf.writeUInt32LE(landPtr, off + 0x04);
    // water/rockSmash/fishing left as NULL (0).
  }

  if (args.sentinel) {
    const off = args.tableAt + args.records.length * REC;
    buf[off + 0x00] = WILD_ENCOUNTERS_SENTINEL_MAP_GROUP;
    buf[off + 0x01] = 0;
    buf.writeUInt16LE(0, off + 0x02);
    buf.writeUInt32LE(0, off + 0x04);
  }
  return buf;
}

describe('scanWildEncountersTable - happy paths', () => {
  it('finds a 3-record sentinel-terminated table', () => {
    const buf = plantTable({
      tableAt: 0x200,
      records: [
        { mapGroup: 0, mapNum: 0 },
        { mapGroup: 0, mapNum: 1 },
        { mapGroup: 1, mapNum: 0 },
      ],
      sentinel: true,
    });
    const r = scanWildEncountersTable(buf);
    expect(r).not.toBeNull();
    if (r !== null) {
      expect(r.tableStart).toBe(0x200);
      expect(r.headerCount).toBe(3);
      expect(r.sentinelTerminated).toBe(true);
      // Extent = 3 records + 1 sentinel = 4 × 20 = 80 bytes
      expect(r.tableEndExclusive).toBe(0x200 + 4 * REC);
      expect(r.headers).toHaveLength(3);
      expect(r.headers[0]?.mapGroup).toBe(0);
      expect(r.headers[2]?.mapGroup).toBe(1);
    }
  });

  it('finds a table without a sentinel (run ends on parse failure)', () => {
    const buf = plantTable({
      tableAt: 0x100,
      records: [
        { mapGroup: 0, mapNum: 0 },
        { mapGroup: 0, mapNum: 1 },
        { mapGroup: 0, mapNum: 2 },
      ],
      sentinel: false,
    });
    // The bytes after the table are 0-fill - that parses as
    // all_pointers_null, not as sentinel, so sentinelTerminated=false.
    const r = scanWildEncountersTable(buf);
    expect(r).not.toBeNull();
    if (r !== null) {
      expect(r.headerCount).toBe(3);
      expect(r.sentinelTerminated).toBe(false);
      expect(r.tableEndExclusive).toBe(0x100 + 3 * REC);
    }
  });

  it('result + headers array are frozen', () => {
    const buf = plantTable({
      tableAt: 0x200,
      records: [
        { mapGroup: 0, mapNum: 0 },
        { mapGroup: 0, mapNum: 1 },
        { mapGroup: 0, mapNum: 2 },
      ],
      sentinel: true,
    });
    const r = scanWildEncountersTable(buf);
    if (r !== null) {
      expect(Object.isFrozen(r)).toBe(true);
      expect(Object.isFrozen(r.headers)).toBe(true);
    }
  });
});

describe('scanWildEncountersTable - rejection cases', () => {
  it('returns null when no run meets minHeadersInTable', () => {
    // Only 2 valid records, default min is 3.
    const buf = plantTable({
      tableAt: 0x100,
      records: [
        { mapGroup: 0, mapNum: 0 },
        { mapGroup: 0, mapNum: 1 },
      ],
      sentinel: true,
    });
    expect(scanWildEncountersTable(buf)).toBeNull();
  });

  it('returns null for an empty buffer', () => {
    expect(scanWildEncountersTable(new Uint8Array(0))).toBeNull();
  });

  it('honors minHeadersInTable=2 option', () => {
    const buf = plantTable({
      tableAt: 0x100,
      records: [
        { mapGroup: 0, mapNum: 0 },
        { mapGroup: 0, mapNum: 1 },
      ],
      sentinel: true,
    });
    const r = scanWildEncountersTable(buf, { minHeadersInTable: 2 });
    expect(r).not.toBeNull();
    if (r !== null) expect(r.headerCount).toBe(2);
  });

  it('throws on invalid minHeadersInTable=0', () => {
    expect(() =>
      scanWildEncountersTable(new Uint8Array(100), { minHeadersInTable: 0 }),
    ).toThrow();
  });

  it('throws when maxHeadersInTable < minHeadersInTable', () => {
    expect(() =>
      scanWildEncountersTable(new Uint8Array(100), {
        minHeadersInTable: 3,
        maxHeadersInTable: 2,
      }),
    ).toThrow();
  });
});

describe('scanWildEncountersTable - first-match-wins ordering', () => {
  it('picks the EARLIEST run when two tables exist', () => {
    // Plant table A at 0x200 (3 records + sentinel) and table B at 0x800.
    const buf = plantTable({
      bufferSize: 0x4000,
      tableAt: 0x200,
      records: [
        { mapGroup: 0, mapNum: 0 },
        { mapGroup: 0, mapNum: 1 },
        { mapGroup: 1, mapNum: 0 },
      ],
      sentinel: true,
    });
    // Manually graft a second table at 0x800.
    const landPtr = (GBA_ROM_BASE_ADDRESS + 0x800) >>> 0;
    for (let i = 0; i < 3; i++) {
      const off = 0x800 + i * REC;
      buf[off + 0x00] = 5;
      buf[off + 0x01] = i;
      buf.writeUInt16LE(0, off + 0x02);
      buf.writeUInt32LE(landPtr, off + 0x04);
    }
    const r = scanWildEncountersTable(buf);
    expect(r).not.toBeNull();
    if (r !== null) expect(r.tableStart).toBe(0x200);
  });
});
