import { describe, expect, it } from 'vitest';
import {
  TMHM_HM_COUNT,
  TMHM_MAX_SET_BITS,
  TMHM_RESERVED_BIT_COUNT,
  TMHM_STRUCT_SIZE_BYTES,
  TMHM_TM_COUNT,
  TMHM_USED_BIT_COUNT,
  parseTMHMCompat,
} from './tmhm.js';

/** Write a u64 (as low+high u32 pair) at `at`. */
function writeU64(buf: Buffer, at: number, low: number, high: number): void {
  buf.writeUInt32LE(low >>> 0, at + 0);
  buf.writeUInt32LE(high >>> 0, at + 4);
}

/** Build a u64 from a list of bit indices (0..63). Returns [low, high]. */
function packBits(bits: ReadonlyArray<number>): [number, number] {
  let low = 0, high = 0;
  for (const b of bits) {
    if (b < 32) low |= (1 << b) >>> 0;
    else if (b < 64) high |= (1 << (b - 32)) >>> 0;
  }
  return [low >>> 0, high >>> 0];
}

describe('parseTMHMCompat - happy paths', () => {
  it('parses Bulbasaur-shape bitfield (16 TMs + 1 HM)', () => {
    const buf = Buffer.alloc(0x100);
    const at = 0x10;
    const bits = [5, 8, 9, 10, 16, 19, 21, 26, 31, 36, 42, 44, 45, 46, 53, 54];
    const [low, high] = packBits(bits);
    writeU64(buf, at, low, high);
    const r = parseTMHMCompat(buf, at);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.tmhm.setBitCount).toBe(16);
      expect(r.tmhm.setBitIndices).toEqual(bits);
      expect(r.tmhm.compatibleTmIndices).toEqual(bits.filter((b) => b < 50));
      expect(r.tmhm.compatibleHmIndices).toEqual([3, 4]); // HMs at indices 53, 54 → HM03, HM04
      expect(r.tmhm.fileOffset).toBe(at);
    }
  });

  it('parses all-zero slot (Magikarp / empty species)', () => {
    const buf = Buffer.alloc(0x100);
    const r = parseTMHMCompat(buf, 0x10);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.tmhm.setBitCount).toBe(0);
      expect(r.tmhm.setBitIndices.length).toBe(0);
    }
  });

  it('parses Mew-shape slot (all 58 used bits set, top 6 still 0)', () => {
    const buf = Buffer.alloc(0x100);
    const at = 0x10;
    const bits: number[] = [];
    for (let i = 0; i < TMHM_USED_BIT_COUNT; i++) bits.push(i);
    const [low, high] = packBits(bits);
    writeU64(buf, at, low, high);
    const r = parseTMHMCompat(buf, at);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.tmhm.setBitCount).toBe(58);
      expect(r.tmhm.compatibleTmIndices.length).toBe(50);
      expect(r.tmhm.compatibleHmIndices.length).toBe(8);
    }
  });

  it('result is frozen', () => {
    const buf = Buffer.alloc(0x10);
    buf[0] = 1; // tiniest non-zero
    const r = parseTMHMCompat(buf, 0);
    if (r.ok) {
      expect(Object.isFrozen(r.tmhm)).toBe(true);
      expect(Object.isFrozen(r.tmhm.setBitIndices)).toBe(true);
    }
  });
});

describe('parseTMHMCompat - failure modes', () => {
  it('fails too_short when buffer < 8 bytes', () => {
    const r = parseTMHMCompat(new Uint8Array(4), 0);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.kind).toBe('too_short');
  });

  it('fails reserved_bits_set when bit 58 is set', () => {
    const buf = Buffer.alloc(0x10);
    const [low, high] = packBits([58]);
    writeU64(buf, 0, low, high);
    const r = parseTMHMCompat(buf, 0);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.kind).toBe('reserved_bits_set');
  });

  it('fails reserved_bits_set when any of bits 58..63 is set', () => {
    const buf = Buffer.alloc(0x10);
    const [low, high] = packBits([63]);
    writeU64(buf, 0, low, high);
    const r = parseTMHMCompat(buf, 0);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.kind).toBe('reserved_bits_set');
  });

  it('fails too_many_bits_set when popcount exceeds custom maxSetBits', () => {
    const buf = Buffer.alloc(0x10);
    // 30 bits set
    const bits = Array.from({ length: 30 }, (_, i) => i);
    const [low, high] = packBits(bits);
    writeU64(buf, 0, low, high);
    const r = parseTMHMCompat(buf, 0, { maxSetBits: 10 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.kind).toBe('too_many_bits_set');
  });
});

describe('constants', () => {
  it('struct size = 8, used bits = 58, reserved bits = 6', () => {
    expect(TMHM_STRUCT_SIZE_BYTES).toBe(8);
    expect(TMHM_USED_BIT_COUNT).toBe(58);
    expect(TMHM_RESERVED_BIT_COUNT).toBe(6);
  });
  it('TM count = 50, HM count = 8, max set bits = 100', () => {
    expect(TMHM_TM_COUNT).toBe(50);
    expect(TMHM_HM_COUNT).toBe(8);
    expect(TMHM_MAX_SET_BITS).toBe(100);
  });
});
