import { describe, expect, it } from 'vitest';
import {
  COLORS_PER_PALETTE,
  PALETTE_BANK_BYTES,
  PALETTE_BYTES,
  PALETTE_MIN_DISTINCT_COLORS,
  PALETTE_SCAN_MAX_REGIONS,
  isValidPaletteRegion,
  scanPaletteRegions,
} from './palette.js';

/** Plant a synthetic palette at `offset`: 16 distinct BGR555 colors
 *  with bit 15 = 0 in every u16. */
function plantPalette(buf: Uint8Array, offset: number, seed = 0): void {
  for (let i = 0; i < COLORS_PER_PALETTE; i++) {
    const colorIndex = (seed + i) & 0x7fff; // bit 15 = 0
    buf[offset + i * 2] = colorIndex & 0xff;
    buf[offset + i * 2 + 1] = (colorIndex >> 8) & 0x7f; // ensure bit 7 of hi byte = 0
  }
}

describe('GBA palette constants', () => {
  it('exposes the canonical palette format constants', () => {
    expect(PALETTE_BYTES).toBe(32);
    expect(COLORS_PER_PALETTE).toBe(16);
    expect(PALETTE_BANK_BYTES).toBe(256);
    expect(PALETTE_MIN_DISTINCT_COLORS).toBeGreaterThanOrEqual(3);
    expect(PALETTE_SCAN_MAX_REGIONS).toBeGreaterThanOrEqual(1024);
  });
});

describe('isValidPaletteRegion', () => {
  it('returns true for a planted palette with distinct colors', () => {
    const buf = new Uint8Array(64);
    plantPalette(buf, 0, 0x100);
    expect(isValidPaletteRegion(buf, 0)).toBe(true);
  });

  // Phase H-RC4: the validator now tolerates up to 2 colors with bit
  // 15 set per 16-color palette (was 0). This matches how heavy hack
  // ROMs sometimes leave stray high bits on a few colors after their
  // linker stitches palette source files together.
  it('returns true when up to 2 colors have bit 15 set (hack tolerance)', () => {
    const buf = new Uint8Array(64);
    plantPalette(buf, 0, 0x100);
    buf[0 + 3 * 2 + 1] = 0x80 | (buf[0 + 3 * 2 + 1]! & 0x7f);
    buf[0 + 7 * 2 + 1] = 0x80 | (buf[0 + 7 * 2 + 1]! & 0x7f);
    expect(isValidPaletteRegion(buf, 0)).toBe(true);
  });

  it('returns false when ≥3 colors have bit 15 set (still rejects noise)', () => {
    const buf = new Uint8Array(64);
    plantPalette(buf, 0, 0x100);
    buf[0 + 2 * 2 + 1] = 0x80 | (buf[0 + 2 * 2 + 1]! & 0x7f);
    buf[0 + 5 * 2 + 1] = 0x80 | (buf[0 + 5 * 2 + 1]! & 0x7f);
    buf[0 + 9 * 2 + 1] = 0x80 | (buf[0 + 9 * 2 + 1]! & 0x7f);
    expect(isValidPaletteRegion(buf, 0)).toBe(false);
  });

  it('returns false for an all-zero region (no distinct colors)', () => {
    const buf = new Uint8Array(64);
    // All zeros - only 1 distinct color = 0x0000.
    expect(isValidPaletteRegion(buf, 0)).toBe(false);
  });

  it('returns false for a flat single-color region', () => {
    const buf = new Uint8Array(64);
    for (let i = 0; i < COLORS_PER_PALETTE; i++) {
      buf[i * 2] = 0x42;
      buf[i * 2 + 1] = 0x21;
    }
    // 1 distinct color = 0x2142.
    expect(isValidPaletteRegion(buf, 0)).toBe(false);
  });

  it('returns false for out-of-bounds offset', () => {
    const buf = new Uint8Array(20); // < 32 bytes
    expect(isValidPaletteRegion(buf, 0)).toBe(false);
  });

  it('accepts exactly PALETTE_MIN_DISTINCT_COLORS distinct colors', () => {
    const buf = new Uint8Array(64);
    // 16 colors but only 3 distinct values, none with bit 15 set.
    for (let i = 0; i < COLORS_PER_PALETTE; i++) {
      const colorIndex = i % PALETTE_MIN_DISTINCT_COLORS;
      const colorValue = (colorIndex + 1) * 0x100; // 0x100, 0x200, 0x300 (bit 15 = 0)
      buf[i * 2] = colorValue & 0xff;
      buf[i * 2 + 1] = (colorValue >> 8) & 0x7f;
    }
    expect(isValidPaletteRegion(buf, 0)).toBe(true);
  });
});

describe('scanPaletteRegions', () => {
  it('returns empty array when no palettes are present', () => {
    // Garbage-fill with bytes that have bit 7 set every other byte - 
    // ensures bit 15 = 1 in every u16, failing validation.
    const buf = new Uint8Array(64 * 1024);
    for (let i = 0; i < buf.length; i++) {
      buf[i] = (i % 2 === 1) ? 0x80 | ((i * 13) % 128) : (i * 7) % 256;
    }
    const result = scanPaletteRegions(buf);
    expect(result.regionCount).toBe(0);
  });

  it('finds a single planted palette past the cartridge header', () => {
    const buf = new Uint8Array(2048);
    // Fill with bytes that fail validation (bit 15 = 1 in every u16).
    for (let i = 0; i < buf.length; i++) {
      buf[i] = i % 2 === 1 ? 0x80 : 0;
    }
    plantPalette(buf, 0x200, 0x100);
    const result = scanPaletteRegions(buf);
    expect(result.regionCount).toBe(1);
    expect(result.regionOffsets).toEqual([0x200]);
  });

  it('finds many planted palettes in a palette-bank-like layout', () => {
    const buf = new Uint8Array(4096);
    for (let i = 0; i < buf.length; i++) {
      buf[i] = i % 2 === 1 ? 0x80 : 0;
    }
    // Plant 8 palettes back-to-back at 0x200 (a palette bank).
    for (let i = 0; i < 8; i++) {
      plantPalette(buf, 0x200 + i * PALETTE_BYTES, 0x100 + i * 32);
    }
    const result = scanPaletteRegions(buf);
    expect(result.regionCount).toBe(8);
    for (let i = 0; i < 8; i++) {
      expect(result.regionOffsets).toContain(0x200 + i * PALETTE_BYTES);
    }
  });

  it('ignores palettes planted inside the cartridge header (0..0xBF)', () => {
    const buf = new Uint8Array(2048);
    for (let i = 0; i < buf.length; i++) {
      buf[i] = i % 2 === 1 ? 0x80 : 0;
    }
    plantPalette(buf, 0x40, 0x100); // inside header
    const result = scanPaletteRegions(buf);
    expect(result.regionCount).toBe(0);
  });

  it('returns offsets in ascending order', () => {
    const buf = new Uint8Array(4096);
    for (let i = 0; i < buf.length; i++) {
      buf[i] = i % 2 === 1 ? 0x80 : 0;
    }
    plantPalette(buf, 0x800, 0x100);
    plantPalette(buf, 0x200, 0x200);
    plantPalette(buf, 0x400, 0x300);
    const result = scanPaletteRegions(buf);
    expect(result.regionOffsets).toEqual([0x200, 0x400, 0x800]);
  });
});
