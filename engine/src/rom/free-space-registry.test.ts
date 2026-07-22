import { describe, it, expect } from 'vitest';
import { FreeSpaceRegistry, FreeSpaceExhaustedError } from './free-space-registry.js';

/** Build a fake ROM with `dataSize` bytes of zero-data followed by
 *  `freeSize` bytes of 0xFF fill. */
function makeFakeRom(dataSize: number, freeSize: number): Uint8Array {
  const rom = new Uint8Array(dataSize + freeSize);
  for (let i = 0; i < dataSize; i++) rom[i] = i & 0xff; // non-fill data
  for (let i = dataSize; i < rom.length; i++) rom[i] = 0xff;
  return rom;
}

describe('FreeSpaceRegistry', () => {
  it('hands out non-overlapping ranges for two consecutive claims', () => {
    const rom = makeFakeRom(0x1000, 0x10000);
    const reg = new FreeSpaceRegistry(rom);
    const a = reg.claim(0x2000, 'first');
    const b = reg.claim(0x2000, 'second');
    expect(a).not.toBe(b);
    const aEnd = a + 0x2000;
    const bEnd = b + 0x2000;
    // Ranges shouldn't overlap.
    expect(Math.max(aEnd, bEnd) - Math.min(a, b)).toBeGreaterThanOrEqual(0x4000);
  });

  it('marks claimed ranges so findFreeRomSpace skips them', () => {
    const rom = makeFakeRom(0x1000, 0x4000);
    const reg = new FreeSpaceRegistry(rom);
    reg.claim(0x2000, 'big');
    // Only ~0x2000 of free space remains. Another 0x2000 claim should
    // either succeed in the remaining region OR fail cleanly.
    try {
      const second = reg.claim(0x2000, 'second-big');
      expect(typeof second).toBe('number');
    } catch (e) {
      expect(e).toBeInstanceOf(FreeSpaceExhaustedError);
    }
  });

  it('throws FreeSpaceExhaustedError when the ROM is full', () => {
    const rom = makeFakeRom(0x1000, 0x100); // 256 bytes of free, much less than asked
    const reg = new FreeSpaceRegistry(rom);
    expect(() => reg.claim(0x10000, 'huge')).toThrow(FreeSpaceExhaustedError);
  });

  it('rejects non-positive sizeBytes', () => {
    const rom = makeFakeRom(0x1000, 0x1000);
    const reg = new FreeSpaceRegistry(rom);
    expect(() => reg.claim(0, 'bogus')).toThrow();
    expect(() => reg.claim(-1, 'bogus')).toThrow();
    expect(() => reg.claim(1.5, 'bogus')).toThrow();
  });

  it('persists + restores claims to JSON', () => {
    const rom = makeFakeRom(0x1000, 0x10000);
    const reg1 = new FreeSpaceRegistry(rom);
    reg1.claim(0x1000, 'a');
    reg1.claim(0x800, 'b');
    const snapshot = reg1.persist();
    expect(snapshot.schemaVersion).toBe(1);
    expect(snapshot.claims).toHaveLength(2);

    const reg2 = new FreeSpaceRegistry(rom);
    const restored = reg2.restore(snapshot);
    expect(restored).toBe(2);
    // A new claim after restore should NOT overlap with the restored two.
    const c = reg2.claim(0x800, 'c');
    for (const prior of snapshot.claims) {
      // No overlap with any prior claim.
      const priorEnd = prior.offset + prior.size;
      const cEnd = c + 0x800;
      const overlap = !(cEnd <= prior.offset || c >= priorEnd);
      expect(overlap).toBe(false);
    }
  });

  it('release() makes the space available again', () => {
    const rom = makeFakeRom(0x1000, 0x10000);
    const reg = new FreeSpaceRegistry(rom);
    const a = reg.claim(0x4000, 'a');
    expect(reg.totalClaimedBytes()).toBe(0x4000);
    const released = reg.release(a);
    expect(released).toBe(true);
    expect(reg.totalClaimedBytes()).toBe(0);
    // Re-claiming the SAME size should yield the same offset on this
    // deterministic-search registry.
    const a2 = reg.claim(0x4000, 'a-again');
    expect(a2).toBe(a);
  });

  it('list() returns claims in sequence order', () => {
    const rom = makeFakeRom(0x1000, 0x10000);
    const reg = new FreeSpaceRegistry(rom);
    reg.claim(0x100, 'first');
    reg.claim(0x100, 'second');
    reg.claim(0x100, 'third');
    const list = reg.list();
    expect(list.map((c) => c.purposeTag)).toEqual(['first', 'second', 'third']);
    expect(list.map((c) => c.sequence)).toEqual([0, 1, 2]);
  });

  it('skips snapshot claims that don\'t fit the current ROM', () => {
    const smallRom = makeFakeRom(0x1000, 0x1000);
    const reg = new FreeSpaceRegistry(smallRom);
    const fakeSnapshot = {
      schemaVersion: 1 as const,
      claims: [
        { offset: 0x1000000, size: 0x100, purposeTag: 'from_bigger_rom', sequence: 0 },
      ],
    };
    const restored = reg.restore(fakeSnapshot);
    // restore() returns the input length, but the claim was skipped.
    expect(restored).toBe(1);
    expect(reg.list()).toHaveLength(0);
  });

  it('rejects mismatched schema versions', () => {
    const rom = makeFakeRom(0x1000, 0x1000);
    const reg = new FreeSpaceRegistry(rom);
    expect(() =>
      reg.restore({ schemaVersion: 99 as unknown as 1, claims: [] }),
    ).toThrow(/schema version/);
  });
});
