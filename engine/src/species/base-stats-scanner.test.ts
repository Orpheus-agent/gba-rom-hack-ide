import { describe, expect, it } from 'vitest';
import { BASE_STATS_STRUCT_SIZE_BYTES as REC } from './base-stats.js';
import { scanBaseStatsTable } from './base-stats-scanner.js';

/** Plant a minimal valid BaseStats record at `at`. Stats default to
 *  Bulbasaur-ish (HP=45, type=GRASS/POISON). */
function plantOne(buf: Buffer, at: number, opts?: { baseHP?: number; type1?: number }): void {
  buf[at + 0x00] = opts?.baseHP ?? 45;
  buf[at + 0x01] = 49;
  buf[at + 0x02] = 49;
  buf[at + 0x03] = 45;
  buf[at + 0x04] = 65;
  buf[at + 0x05] = 65;
  buf[at + 0x06] = opts?.type1 ?? 12; // GRASS
  buf[at + 0x07] = 3; // POISON
  buf[at + 0x08] = 45; // catchRate
  buf[at + 0x09] = 64; // expYield
  buf[at + 0x0a] = 0;
  buf[at + 0x0b] = 0;
  // item1, item2 at 0x0C-0x0F default 0
  buf[at + 0x10] = 31;
  buf[at + 0x11] = 20;
  buf[at + 0x12] = 70;
  buf[at + 0x13] = 3; // growthRate
  buf[at + 0x14] = 1;
  buf[at + 0x15] = 7;
  buf[at + 0x16] = 65; // ability1
  buf[at + 0x17] = 0;
  buf[at + 0x18] = 0;
  buf[at + 0x19] = 6;
  // padding_B at 0x1A, 0x1B default 0
}

describe('scanBaseStatsTable - happy paths', () => {
  it('finds a 10-record table (default min)', () => {
    const buf = Buffer.alloc(0x1000);
    const tableAt = 0x100;
    for (let i = 0; i < 10; i++) plantOne(buf, tableAt + i * REC, { baseHP: 40 + i });
    const r = scanBaseStatsTable(buf);
    expect(r).not.toBeNull();
    if (r !== null) {
      expect(r.tableStart).toBe(tableAt);
      expect(r.speciesCount).toBe(10);
      expect(r.tableEndExclusive).toBe(tableAt + 10 * REC);
      expect(r.records[0]?.baseHP).toBe(40);
      expect(r.records[9]?.baseHP).toBe(49);
    }
  });

  it('finds a 50-record table', () => {
    const buf = Buffer.alloc(0x2000);
    const tableAt = 0x200;
    for (let i = 0; i < 50; i++) plantOne(buf, tableAt + i * REC);
    const r = scanBaseStatsTable(buf);
    expect(r).not.toBeNull();
    if (r !== null) expect(r.speciesCount).toBe(50);
  });

  it('walks until parse fails (run terminates on first invalid record)', () => {
    const buf = Buffer.alloc(0x2000);
    const tableAt = 0x200;
    for (let i = 0; i < 12; i++) plantOne(buf, tableAt + i * REC);
    // Plant an invalid record at slot 12 (type1=99)
    plantOne(buf, tableAt + 12 * REC, { type1: 99 });
    const r = scanBaseStatsTable(buf);
    expect(r).not.toBeNull();
    if (r !== null) expect(r.speciesCount).toBe(12);
  });

  it('result + records are frozen', () => {
    const buf = Buffer.alloc(0x1000);
    for (let i = 0; i < 10; i++) plantOne(buf, 0x100 + i * REC);
    const r = scanBaseStatsTable(buf);
    if (r !== null) {
      expect(Object.isFrozen(r)).toBe(true);
      expect(Object.isFrozen(r.records)).toBe(true);
    }
  });
});

describe('scanBaseStatsTable - rejection cases', () => {
  it('returns null when run < minSpeciesInTable (default 10)', () => {
    const buf = Buffer.alloc(0x1000);
    for (let i = 0; i < 5; i++) plantOne(buf, 0x100 + i * REC);
    // Plant invalid at slot 5
    buf[0x100 + 5 * REC + 0x1a] = 0xff;
    expect(scanBaseStatsTable(buf)).toBeNull();
  });

  it('returns null for empty/zero buffer', () => {
    expect(scanBaseStatsTable(new Uint8Array(0x1000))).toBeNull();
  });

  it('honors minSpeciesInTable=3 option', () => {
    const buf = Buffer.alloc(0x1000);
    for (let i = 0; i < 3; i++) plantOne(buf, 0x100 + i * REC);
    buf[0x100 + 3 * REC + 0x1a] = 0xff;
    const r = scanBaseStatsTable(buf, { minSpeciesInTable: 3 });
    expect(r).not.toBeNull();
    if (r !== null) expect(r.speciesCount).toBe(3);
  });

  it('throws on invalid minSpeciesInTable=0', () => {
    expect(() => scanBaseStatsTable(new Uint8Array(0x1000), { minSpeciesInTable: 0 })).toThrow();
  });

  it('throws when maxSpeciesInTable < minSpeciesInTable', () => {
    expect(() =>
      scanBaseStatsTable(new Uint8Array(0x1000), {
        minSpeciesInTable: 10,
        maxSpeciesInTable: 5,
      }),
    ).toThrow();
  });
});
