import { describe, expect, it } from 'vitest';
import {
  GBA_ROM_BASE_ADDRESS,
  GBA_ROM_END_ADDRESS_EXCLUSIVE,
  discoverPointers,
  isProbableRomPointer,
} from './discovery.js';

/** Helper: build a Buffer with a single GBA pointer at the given offset. */
function bufferWithPointer(args: {
  bufferSize: number;
  pointerAt: number;
  pointsToOffset: number;
}): Buffer {
  const buf = Buffer.alloc(args.bufferSize);
  const addr = (GBA_ROM_BASE_ADDRESS + args.pointsToOffset) >>> 0;
  buf.writeUInt32LE(addr, args.pointerAt);
  return buf;
}

describe('isProbableRomPointer', () => {
  it('accepts a real LE ARM pointer at high byte 0x08', () => {
    const buf = bufferWithPointer({ bufferSize: 256, pointerAt: 0, pointsToOffset: 0x80 });
    expect(isProbableRomPointer(buf, 0)).toBe(true);
  });

  it('accepts a real LE ARM pointer at high byte 0x09 (requires >16 MiB buffer)', () => {
    // 0x09xxxxxx is the second 16 MiB half of GBA cartridge address space.
    // A ROM with that pointer must actually be ≥ 16 MiB + targetOffset for
    // the discovery target-bounds check to accept it.
    const buf = Buffer.alloc(17 * 1024 * 1024);
    buf.writeUInt32LE((0x09000000 + 0x40) >>> 0, 0);
    expect(isProbableRomPointer(buf, 0)).toBe(true);
  });

  it('rejects pointers with non-08/09 high byte', () => {
    const buf = Buffer.alloc(256);
    buf.writeUInt32LE(0x02000000, 0); // EWRAM, not ROM
    expect(isProbableRomPointer(buf, 0)).toBe(false);
  });

  it('rejects pointers whose target is past the buffer length', () => {
    const buf = Buffer.alloc(256);
    buf.writeUInt32LE((GBA_ROM_BASE_ADDRESS + 1024) >>> 0, 0);
    expect(isProbableRomPointer(buf, 0)).toBe(false);
  });

  it('rejects pointers at end-of-buffer (4 bytes needed)', () => {
    const buf = Buffer.alloc(4);
    buf.writeUInt32LE((GBA_ROM_BASE_ADDRESS + 0) >>> 0, 0);
    expect(isProbableRomPointer(buf, 1)).toBe(false); // only 3 bytes left
  });

  it('rejects negative offsets', () => {
    expect(isProbableRomPointer(Buffer.alloc(16), -1)).toBe(false);
  });

  it('rejects values right at 0x0A000000 (just past ROM region)', () => {
    const buf = Buffer.alloc(256);
    buf.writeUInt32LE(GBA_ROM_END_ADDRESS_EXCLUSIVE, 0);
    expect(isProbableRomPointer(buf, 0)).toBe(false);
  });
});

describe('discoverPointers', () => {
  it('returns empty array for an all-zero buffer', () => {
    const buf = Buffer.alloc(1024);
    expect(discoverPointers(buf)).toEqual([]);
  });

  it('finds a single planted pointer', () => {
    const buf = bufferWithPointer({ bufferSize: 256, pointerAt: 16, pointsToOffset: 100 });
    const ptrs = discoverPointers(buf);
    expect(ptrs).toHaveLength(1);
    expect(ptrs[0]?.sourceOffset).toBe(16);
    expect(ptrs[0]?.targetOffset).toBe(100);
    expect(ptrs[0]?.rawAddress).toBe(GBA_ROM_BASE_ADDRESS + 100);
  });

  it('respects stride=4 by default (does not find a pointer at offset 1)', () => {
    // Plant a pointer-shaped 4 bytes at offset 1 (mis-aligned). The scanner
    // should not detect it because it only inspects 4-aligned positions.
    const buf = Buffer.alloc(64);
    buf.writeUInt32LE((GBA_ROM_BASE_ADDRESS + 32) >>> 0, 1);
    expect(discoverPointers(buf)).toEqual([]);
  });

  it('honors a custom stride=1 (finds the mis-aligned pointer)', () => {
    const buf = Buffer.alloc(64);
    buf.writeUInt32LE((GBA_ROM_BASE_ADDRESS + 32) >>> 0, 1);
    const ptrs = discoverPointers(buf, { stride: 1 });
    expect(ptrs).toHaveLength(1);
    expect(ptrs[0]?.sourceOffset).toBe(1);
  });

  it('finds many pointers in a synthetic dense table', () => {
    const tableLen = 32;
    const buf = Buffer.alloc(tableLen * 4 + 256);
    for (let i = 0; i < tableLen; i++) {
      buf.writeUInt32LE((GBA_ROM_BASE_ADDRESS + 100 + i) >>> 0, i * 4);
    }
    const ptrs = discoverPointers(buf);
    expect(ptrs).toHaveLength(tableLen);
    expect(ptrs[0]?.sourceOffset).toBe(0);
    expect(ptrs[tableLen - 1]?.sourceOffset).toBe((tableLen - 1) * 4);
  });

  it('throws on invalid stride', () => {
    expect(() => discoverPointers(Buffer.alloc(16), { stride: 0 })).toThrow();
    expect(() => discoverPointers(Buffer.alloc(16), { stride: 1.5 })).toThrow();
  });

  it('throws on invalid window bounds', () => {
    expect(() =>
      discoverPointers(Buffer.alloc(16), { startOffset: -1 }),
    ).toThrow();
    expect(() =>
      discoverPointers(Buffer.alloc(16), { endOffsetExclusive: 100 }),
    ).toThrow();
    expect(() =>
      discoverPointers(Buffer.alloc(16), { startOffset: 10, endOffsetExclusive: 5 }),
    ).toThrow();
  });

  it('windowing limits the scan range', () => {
    const buf = Buffer.alloc(256);
    buf.writeUInt32LE((GBA_ROM_BASE_ADDRESS + 0x40) >>> 0, 0x00);
    buf.writeUInt32LE((GBA_ROM_BASE_ADDRESS + 0x40) >>> 0, 0x80);
    const all = discoverPointers(buf);
    expect(all).toHaveLength(2);
    const second = discoverPointers(buf, { startOffset: 0x40 });
    expect(second).toHaveLength(1);
    expect(second[0]?.sourceOffset).toBe(0x80);
  });

  it('scales linearly with input size (smoke perf)', () => {
    // 1 MiB buffer of zeros with 100 pointers planted at regular intervals.
    const buf = Buffer.alloc(1024 * 1024);
    for (let i = 0; i < 100; i++) {
      buf.writeUInt32LE((GBA_ROM_BASE_ADDRESS + 4096) >>> 0, i * 4096);
    }
    const start = Date.now();
    const ptrs = discoverPointers(buf);
    const elapsed = Date.now() - start;
    expect(ptrs.length).toBe(100);
    expect(elapsed).toBeLessThan(500); // generous budget; typical is < 50 ms
  });
});
