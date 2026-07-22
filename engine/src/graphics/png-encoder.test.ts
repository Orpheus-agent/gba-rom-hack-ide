import { describe, expect, it } from 'vitest';
import { decodePng } from './png-decoder.js';
import { encodeRgbaPng, PngEncodeError } from './png-encoder.js';

describe('encodeRgbaPng (Phase 4.2C)', () => {
  it('produces bytes that start with the PNG signature', () => {
    const pixels = new Uint8Array(4 * 4 * 4); // 4×4 RGBA
    const bytes = encodeRgbaPng(pixels, 4, 4);
    expect(Array.from(bytes.subarray(0, 8))).toEqual([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]);
  });

  it('round-trips RGBA pixels through the decoder', () => {
    // 2×2 RGBA: (R,G,B,A) per pixel
    const pixels = new Uint8Array([
      0xff, 0x00, 0x00, 0xff,  0x00, 0xff, 0x00, 0xff,
      0x00, 0x00, 0xff, 0xff,  0xff, 0xff, 0xff, 0x80,
    ]);
    const png = encodeRgbaPng(pixels, 2, 2);
    const decoded = decodePng(png);
    expect(decoded.width).toBe(2);
    expect(decoded.height).toBe(2);
    expect(decoded.colorType).toBe(6);
    expect(decoded.bitDepth).toBe(8);
    expect(Array.from(decoded.pixels)).toEqual(Array.from(pixels));
  });

  it('round-trips a 64×64 sprite-sized RGBA payload', () => {
    const w = 64;
    const h = 64;
    const pixels = new Uint8Array(w * h * 4);
    // Fill with a deterministic pattern.
    for (let i = 0; i < pixels.length; i++) pixels[i] = (i * 31) & 0xff;
    const png = encodeRgbaPng(pixels, w, h);
    const decoded = decodePng(png);
    expect(decoded.width).toBe(w);
    expect(decoded.height).toBe(h);
    expect(Array.from(decoded.pixels)).toEqual(Array.from(pixels));
  });

  it('rejects pixel counts that do not match the declared dimensions', () => {
    expect(() => encodeRgbaPng(new Uint8Array(15), 2, 2)).toThrow(PngEncodeError);
    expect(() => encodeRgbaPng(new Uint8Array(17), 2, 2)).toThrow(PngEncodeError);
  });

  it('rejects non-positive dimensions', () => {
    expect(() => encodeRgbaPng(new Uint8Array(0), 0, 0)).toThrow(PngEncodeError);
    expect(() => encodeRgbaPng(new Uint8Array(0), -1, 1)).toThrow(PngEncodeError);
  });

  it('handles a single-pixel image', () => {
    const pixels = new Uint8Array([0xab, 0xcd, 0xef, 0xff]);
    const png = encodeRgbaPng(pixels, 1, 1);
    const decoded = decodePng(png);
    expect(decoded.width).toBe(1);
    expect(decoded.height).toBe(1);
    expect(Array.from(decoded.pixels)).toEqual([0xab, 0xcd, 0xef, 0xff]);
  });
});
