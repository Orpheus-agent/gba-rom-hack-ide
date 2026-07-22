import { describe, it, expect } from 'vitest';
import { decode4bppTile } from './tile-pixels.js';
import {
  encode4bppTile,
  encode4bppTileSheet,
  pixelGridToTiles,
  TileEncodeError,
} from './tile-pixels-encoder.js';

describe('encode4bppTile', () => {
  it('round-trips with decode4bppTile for an arbitrary pattern', () => {
    const pixels = new Uint8Array(64);
    for (let i = 0; i < 64; i++) pixels[i] = i & 0x0f;
    const bytes = encode4bppTile(pixels);
    expect(bytes.length).toBe(32);
    const decoded = decode4bppTile(bytes, 0);
    expect(Array.from(decoded)).toEqual(Array.from(pixels));
  });

  it('packs low + high nibble correctly', () => {
    // pixel[0]=3, pixel[1]=A → byte = (A << 4) | 3 = 0xA3
    const pixels = new Uint8Array(64);
    pixels[0] = 0x3;
    pixels[1] = 0xa;
    const bytes = encode4bppTile(pixels);
    expect(bytes[0]).toBe(0xa3);
  });

  it('rejects pixel arrays of the wrong length', () => {
    expect(() => encode4bppTile(new Uint8Array(63))).toThrow(TileEncodeError);
    expect(() => encode4bppTile(new Uint8Array(65))).toThrow(TileEncodeError);
  });

  it('rejects palette indices out of range', () => {
    const pixels = new Uint8Array(64);
    pixels[0] = 16;
    expect(() => encode4bppTile(pixels)).toThrow(TileEncodeError);
  });
});

describe('encode4bppTileSheet', () => {
  it('encodes N tiles contiguously', () => {
    const t1 = new Uint8Array(64).fill(1);
    const t2 = new Uint8Array(64).fill(2);
    const sheet = encode4bppTileSheet([t1, t2]);
    expect(sheet.length).toBe(64);
    // First tile encoded as all 0x11s (low=1, high=1)
    for (let i = 0; i < 32; i++) expect(sheet[i]).toBe(0x11);
    for (let i = 32; i < 64; i++) expect(sheet[i]).toBe(0x22);
  });
});

describe('pixelGridToTiles', () => {
  it('slices a 16x16 image into 4 tiles in row-major tile order', () => {
    // Build a 16×16 indexed grid where each tile is filled with its
    // tile index (0..3).
    const grid = new Uint8Array(16 * 16);
    for (let ty = 0; ty < 2; ty++) {
      for (let tx = 0; tx < 2; tx++) {
        const tileIdx = ty * 2 + tx;
        for (let py = 0; py < 8; py++) {
          for (let px = 0; px < 8; px++) {
            grid[(ty * 8 + py) * 16 + (tx * 8 + px)] = tileIdx;
          }
        }
      }
    }
    const tiles = pixelGridToTiles(grid, 16, 16);
    expect(tiles).toHaveLength(4);
    for (let t = 0; t < 4; t++) {
      for (let i = 0; i < 64; i++) {
        expect(tiles[t]![i]).toBe(t);
      }
    }
  });

  it('rejects non-multiple-of-8 dimensions', () => {
    expect(() => pixelGridToTiles(new Uint8Array(7 * 8), 7, 8)).toThrow(TileEncodeError);
  });

  it('rejects mismatched buffer size', () => {
    expect(() => pixelGridToTiles(new Uint8Array(50), 16, 16)).toThrow(TileEncodeError);
  });
});
