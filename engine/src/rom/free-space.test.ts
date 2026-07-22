import { describe, expect, it } from 'vitest';
import { findFreeRomSpace } from './free-space.js';

describe('findFreeRomSpace', () => {
  it('returns null when ROM is too small to fit the request', () => {
    const bytes = new Uint8Array(0x100);
    expect(findFreeRomSpace(bytes, 1024)).toBeNull();
  });

  it('returns null when the request size is 0 or negative', () => {
    const bytes = new Uint8Array(64 * 1024).fill(0xff);
    expect(findFreeRomSpace(bytes, 0)).toBeNull();
    expect(findFreeRomSpace(bytes, -10)).toBeNull();
  });

  it('finds a run of 0xFF at the end of the ROM', () => {
    const bytes = new Uint8Array(64 * 1024);
    // Plant some "used data" in the first 32 KB.
    for (let i = 0xc0; i < 32 * 1024; i++) bytes[i] = (i & 0xff) || 0x42;
    // Fill the upper half with 0xFF.
    for (let i = 32 * 1024; i < bytes.length; i++) bytes[i] = 0xff;
    const r = findFreeRomSpace(bytes, 1024);
    expect(r).not.toBeNull();
    expect(r!.offset).toBeGreaterThanOrEqual(32 * 1024);
    expect(r!.offset % 4).toBe(0); // alignment
    expect(r!.runLength).toBeGreaterThanOrEqual(1024);
    expect(r!.fillByte).toBe(0xff);
    // Allocation should be in the LATEST run - close to the end.
    expect(r!.offset + 1024).toBeLessThanOrEqual(bytes.length);
  });

  it('finds a run of 0x00 if no 0xFF run is large enough', () => {
    const bytes = new Uint8Array(64 * 1024);
    // No 0xFF padding - fill all with mixed used-looking data + a
    // big 0x00 run in the middle.
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i & 0x7f) || 0x33;
    // Plant a 4096-byte 0x00 run at 0xa000.
    for (let i = 0xa000; i < 0xa000 + 4096; i++) bytes[i] = 0x00;
    const r = findFreeRomSpace(bytes, 2048);
    expect(r).not.toBeNull();
    expect(r!.fillByte).toBe(0x00);
    expect(r!.offset).toBeGreaterThanOrEqual(0xa000);
    expect(r!.offset + 2048).toBeLessThanOrEqual(0xa000 + 4096);
  });

  it('aligns to 4 bytes', () => {
    const bytes = new Uint8Array(64 * 1024).fill(0xff);
    // Plant a single non-fill byte at an offset that would otherwise
    // produce an unaligned candidate.
    bytes[0x100] = 0x42;
    const r = findFreeRomSpace(bytes, 32);
    expect(r).not.toBeNull();
    expect(r!.offset % 4).toBe(0);
  });

  it('skips the cartridge header (offsets < 0xc0)', () => {
    const bytes = new Uint8Array(0x200).fill(0xff);
    // Even though the whole ROM is fill, we shouldn't return an
    // offset < 0xc0.
    const r = findFreeRomSpace(bytes, 32);
    expect(r).not.toBeNull();
    expect(r!.offset).toBeGreaterThanOrEqual(0xc0);
  });

  it('honors a custom minOffset', () => {
    const bytes = new Uint8Array(64 * 1024).fill(0xff);
    // Carve out a "used" region between 0x4000 and 0x8000.
    for (let i = 0x4000; i < 0x8000; i++) bytes[i] = 0x42;
    // Ask only for space past 0x8000.
    const r = findFreeRomSpace(bytes, 128, 0x8000);
    expect(r).not.toBeNull();
    expect(r!.offset).toBeGreaterThanOrEqual(0x8000);
  });

  it('picks the LATEST qualifying run when multiple exist', () => {
    const bytes = new Uint8Array(64 * 1024);
    // Two free runs separated by used data.
    for (let i = 0x1000; i < 0x2000; i++) bytes[i] = 0xff; // 4 KB run
    for (let i = 0x2000; i < 0xe000; i++) bytes[i] = 0x42; // used
    for (let i = 0xe000; i < bytes.length; i++) bytes[i] = 0xff; // 8 KB run
    const r = findFreeRomSpace(bytes, 1024);
    expect(r).not.toBeNull();
    expect(r!.offset).toBeGreaterThanOrEqual(0xe000);
  });
});
