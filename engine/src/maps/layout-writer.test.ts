import { describe, it, expect } from 'vitest';
import { parseMapLayout } from './layout.js';
import {
  encodeBlockGrid,
  encodeBorderBlocks,
  encodeMapLayout,
  MapLayoutEncodeError,
} from './layout-writer.js';

describe('encodeMapLayout', () => {
  it('round-trips the parser', () => {
    const spec = {
      width: 32,
      height: 24,
      borderBlocksOffset: 0x100000,
      primaryBlocksOffset: 0x100008,
      primaryTilesetOffset: 0x100600,
      secondaryTilesetOffset: 0x100618,
    } as const;
    const bytes = encodeMapLayout(spec);
    expect(bytes.length).toBe(24);
    const buf = new Uint8Array(0x200000);
    buf.set(bytes, 0);
    const parsed = parseMapLayout(buf, 0);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.layout.width).toBe(32);
      expect(parsed.layout.height).toBe(24);
      expect(parsed.layout.borderBlocksOffset).toBe(0x100000);
      expect(parsed.layout.primaryBlocksOffset).toBe(0x100008);
      expect(parsed.layout.primaryTilesetOffset).toBe(0x100600);
      expect(parsed.layout.secondaryTilesetOffset).toBe(0x100618);
    }
  });

  it('rejects out-of-range dimensions', () => {
    expect(() =>
      encodeMapLayout({
        width: 0,
        height: 10,
        borderBlocksOffset: null,
        primaryBlocksOffset: null,
        primaryTilesetOffset: null,
        secondaryTilesetOffset: null,
      }),
    ).toThrow(MapLayoutEncodeError);
    expect(() =>
      encodeMapLayout({
        width: 10,
        height: 9999,
        borderBlocksOffset: null,
        primaryBlocksOffset: null,
        primaryTilesetOffset: null,
        secondaryTilesetOffset: null,
      }),
    ).toThrow(MapLayoutEncodeError);
  });
});

describe('encodeBlockGrid', () => {
  it('packs u16 block ids in little-endian order', () => {
    const bytes = encodeBlockGrid(2, 2, [0x0001, 0x0002, 0xabcd, 0x1234]);
    expect(Array.from(bytes)).toEqual([0x01, 0x00, 0x02, 0x00, 0xcd, 0xab, 0x34, 0x12]);
  });

  it('rejects size mismatch', () => {
    expect(() => encodeBlockGrid(2, 2, [1, 2, 3])).toThrow(/expected 4 entries/);
  });

  it('rejects out-of-range block id', () => {
    expect(() => encodeBlockGrid(1, 1, [0x10000])).toThrow(/u16/);
  });
});

describe('encodeBorderBlocks', () => {
  it('packs the 2×2 border (vanilla FRLG)', () => {
    const bytes = encodeBorderBlocks([0x01, 0x02, 0x03, 0x04]);
    expect(bytes.length).toBe(8);
    expect(Array.from(bytes)).toEqual([0x01, 0x00, 0x02, 0x00, 0x03, 0x00, 0x04, 0x00]);
  });

  it('packs the 3×3 border (RSE)', () => {
    const bytes = encodeBorderBlocks([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(bytes.length).toBe(18);
  });

  it('rejects an empty border', () => {
    expect(() => encodeBorderBlocks([])).toThrow(/≥ 1 entry/);
  });
});
