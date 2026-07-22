import { describe, expect, it } from 'vitest';
import {
  SAVE_DATA_TOTAL_SIZE_BYTES,
  SAVE_SECTOR_COUNT,
  SAVE_SECTOR_DATA_SIZE_BYTES,
  SAVE_SECTOR_FOOTER_MAGIC,
  SAVE_SECTOR_FOOTER_SIZE_BYTES,
  SAVE_SECTOR_SIZE_BYTES,
  findAllSaveSectorFooterMagic,
  findSaveSectorFooterMagic,
} from './save-data.js';

const MAGIC_LE = Uint8Array.of(0x25, 0x20, 0x01, 0x08);

describe('Gen-3 save-data constants', () => {
  it('exposes the canonical sector-size constants', () => {
    expect(SAVE_SECTOR_SIZE_BYTES).toBe(4096);
    expect(SAVE_SECTOR_DATA_SIZE_BYTES).toBe(0xff8);
    expect(SAVE_SECTOR_FOOTER_SIZE_BYTES).toBe(0x10);
    expect(SAVE_SECTOR_COUNT).toBe(14);
    expect(SAVE_DATA_TOTAL_SIZE_BYTES).toBe(14 * 4096);
    expect(SAVE_SECTOR_FOOTER_MAGIC).toBe(0x08012025);
  });
});

describe('findSaveSectorFooterMagic', () => {
  it('returns null when the magic is not present', () => {
    const buf = new Uint8Array(8 * 1024);
    for (let i = 0; i < buf.length; i++) buf[i] = (i * 13 + 7) % 256;
    // ensure the magic doesn't appear accidentally
    for (let i = 0; i + 3 < buf.length; i++) {
      if (buf[i] === 0x25 && buf[i + 1] === 0x20 && buf[i + 2] === 0x01 && buf[i + 3] === 0x08) {
        buf[i] = 0;
      }
    }
    expect(findSaveSectorFooterMagic(buf)).toBeNull();
  });

  it('returns the offset when the magic is planted past the cartridge header', () => {
    const buf = new Uint8Array(8 * 1024);
    const offset = 0x800;
    buf.set(MAGIC_LE, offset);
    expect(findSaveSectorFooterMagic(buf)).toBe(offset);
  });

  it('ignores the magic when it appears inside the cartridge header (0..0xBF)', () => {
    const buf = new Uint8Array(8 * 1024);
    buf.set(MAGIC_LE, 0x80); // inside header
    expect(findSaveSectorFooterMagic(buf)).toBeNull();
  });

  it('returns the FIRST occurrence when multiple are present', () => {
    const buf = new Uint8Array(8 * 1024);
    buf.set(MAGIC_LE, 0x800);
    buf.set(MAGIC_LE, 0x1000);
    buf.set(MAGIC_LE, 0x1800);
    expect(findSaveSectorFooterMagic(buf)).toBe(0x800);
  });

  it('returns null on a buffer smaller than 4 bytes after the header', () => {
    const buf = new Uint8Array(0xc0);
    expect(findSaveSectorFooterMagic(buf)).toBeNull();
  });
});

describe('findAllSaveSectorFooterMagic', () => {
  it('returns an empty array when not found', () => {
    const buf = new Uint8Array(8 * 1024);
    for (let i = 0; i < buf.length; i++) buf[i] = (i * 13 + 7) % 256;
    for (let i = 0; i + 3 < buf.length; i++) {
      if (buf[i] === 0x25 && buf[i + 1] === 0x20 && buf[i + 2] === 0x01 && buf[i + 3] === 0x08) {
        buf[i] = 0;
      }
    }
    expect(findAllSaveSectorFooterMagic(buf)).toEqual([]);
  });

  it('returns all occurrences in ascending order', () => {
    const buf = new Uint8Array(8 * 1024);
    buf.set(MAGIC_LE, 0x1800);
    buf.set(MAGIC_LE, 0x800);
    buf.set(MAGIC_LE, 0x1000);
    const offs = findAllSaveSectorFooterMagic(buf);
    expect(offs).toEqual([0x800, 0x1000, 0x1800]);
  });

  it('skips occurrences inside the cartridge header', () => {
    const buf = new Uint8Array(8 * 1024);
    buf.set(MAGIC_LE, 0x50); // inside header
    buf.set(MAGIC_LE, 0x800);
    const offs = findAllSaveSectorFooterMagic(buf);
    expect(offs).toEqual([0x800]);
  });

  it('handles a buffer with a single occurrence', () => {
    const buf = new Uint8Array(8 * 1024);
    buf.set(MAGIC_LE, 0xc00);
    const offs = findAllSaveSectorFooterMagic(buf);
    expect(offs).toEqual([0xc00]);
  });
});
