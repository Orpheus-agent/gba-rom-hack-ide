import { describe, it, expect } from 'vitest';
import { bgr555ToRgba } from './tile-pixels.js';
import { quantizeRgbaToIndexed, rgbToBgr555 } from './palette-quantizer.js';

/** Build an RGBA buffer where every pixel uses the given RGB. */
function makeSolidRgba(width: number, height: number, r: number, g: number, b: number, a = 255): Uint8Array {
  const out = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    out[i * 4] = r;
    out[i * 4 + 1] = g;
    out[i * 4 + 2] = b;
    out[i * 4 + 3] = a;
  }
  return out;
}

describe('rgbToBgr555', () => {
  it('packs three channels in 5-5-5 LSB order', () => {
    // R=0xFF, G=0, B=0 → r5=31, g5=0, b5=0 → BGR555 = 31
    expect(rgbToBgr555(0xff, 0, 0)).toBe(31);
    // R=0, G=0, B=0xFF → b5=31 << 10 = 31744
    expect(rgbToBgr555(0, 0, 0xff)).toBe(31 << 10);
  });
});

describe('quantizeRgbaToIndexed', () => {
  it('handles a 1-color opaque image by emitting it at index 1', () => {
    const rgba = makeSolidRgba(4, 4, 0xff, 0, 0);
    const { palette, indexed, colorCount } = quantizeRgbaToIndexed(rgba, 4, 4);
    expect(palette.length).toBe(32);
    expect(indexed.length).toBe(16);
    expect(colorCount).toBe(1);
    // Every pixel should map to index 1.
    for (const v of indexed) expect(v).toBe(1);
    // The BGR555 entry at slot 1 should encode red.
    const expected = rgbToBgr555(0xff, 0, 0);
    const actual = palette[2]! | (palette[3]! << 8);
    expect(actual).toBe(expected);
  });

  it('routes transparent pixels to index 0', () => {
    const rgba = new Uint8Array(4 * 4 * 4);
    // Mix of opaque + transparent.
    for (let i = 0; i < 8; i++) {
      rgba[i * 4] = 0xff;
      rgba[i * 4 + 1] = 0xff;
      rgba[i * 4 + 2] = 0xff;
      rgba[i * 4 + 3] = 0; // transparent
    }
    for (let i = 8; i < 16; i++) {
      rgba[i * 4] = 0;
      rgba[i * 4 + 1] = 0xff;
      rgba[i * 4 + 2] = 0;
      rgba[i * 4 + 3] = 0xff; // opaque green
    }
    const { indexed } = quantizeRgbaToIndexed(rgba, 4, 4);
    for (let i = 0; i < 8; i++) expect(indexed[i]).toBe(0);
    for (let i = 8; i < 16; i++) expect(indexed[i]).toBe(1); // first opaque color at slot 1
  });

  it('reduces > 16 distinct colors via median cut', () => {
    // Build a gradient with 32 distinct red values.
    const rgba = new Uint8Array(32 * 4);
    for (let i = 0; i < 32; i++) {
      rgba[i * 4] = i * 8;
      rgba[i * 4 + 1] = 0;
      rgba[i * 4 + 2] = 0;
      rgba[i * 4 + 3] = 0xff;
    }
    const { colorCount, indexed } = quantizeRgbaToIndexed(rgba, 32, 1);
    // Median cut should produce ≤ 15 representatives.
    expect(colorCount).toBeLessThanOrEqual(15);
    // Every pixel got mapped to a valid index.
    for (const v of indexed) {
      expect(v).toBeGreaterThan(0);
      expect(v).toBeLessThanOrEqual(15);
    }
  });

  it('lossless when input has ≤ 15 distinct colors', () => {
    // 5 distinct colors.
    const rgba = new Uint8Array(5 * 4);
    rgba.set([255, 0, 0, 255], 0);
    rgba.set([0, 255, 0, 255], 4);
    rgba.set([0, 0, 255, 255], 8);
    rgba.set([255, 255, 0, 255], 12);
    rgba.set([128, 128, 128, 255], 16);
    const { palette, colorCount } = quantizeRgbaToIndexed(rgba, 5, 1);
    expect(colorCount).toBe(5);
    // Each distinct input color should appear in the palette (lossless).
    const paletteColors = new Set<number>();
    for (let i = 1; i <= 5; i++) {
      const u16 = palette[i * 2]! | (palette[i * 2 + 1]! << 8);
      paletteColors.add(u16);
    }
    expect(paletteColors.has(rgbToBgr555(255, 0, 0))).toBe(true);
    expect(paletteColors.has(rgbToBgr555(0, 255, 0))).toBe(true);
    expect(paletteColors.has(rgbToBgr555(0, 0, 255))).toBe(true);
    expect(paletteColors.has(rgbToBgr555(255, 255, 0))).toBe(true);
    expect(paletteColors.has(rgbToBgr555(128, 128, 128))).toBe(true);
  });

  it('produces a palette decodable by bgr555ToRgba', () => {
    const rgba = makeSolidRgba(4, 4, 0xff, 0xff, 0xff);
    const { palette } = quantizeRgbaToIndexed(rgba, 4, 4);
    // bgr555ToRgba reads the 32-byte palette; should succeed.
    const decoded = bgr555ToRgba(palette);
    expect(decoded.length).toBe(16);
    // Index 0 is always transparent (alpha 0 in the decoded RGBA per
    // the tile-pixels convention).
    expect(decoded[0]).toBe(0);
  });

  it('is deterministic: same input → same palette', () => {
    const rgba = new Uint8Array(64 * 4);
    let s = 0x12345;
    for (let i = 0; i < 64; i++) {
      s = (s * 1103515245 + 12345) >>> 0;
      rgba[i * 4] = (s >> 16) & 0xff;
      rgba[i * 4 + 1] = (s >> 8) & 0xff;
      rgba[i * 4 + 2] = s & 0xff;
      rgba[i * 4 + 3] = 0xff;
    }
    const a = quantizeRgbaToIndexed(rgba, 8, 8);
    const b = quantizeRgbaToIndexed(rgba, 8, 8);
    expect(Array.from(a.palette)).toEqual(Array.from(b.palette));
    expect(Array.from(a.indexed)).toEqual(Array.from(b.indexed));
  });
});
