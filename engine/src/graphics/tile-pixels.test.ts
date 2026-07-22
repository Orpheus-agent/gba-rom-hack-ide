import { describe, expect, it } from 'vitest';
import {
  PALETTE_4BPP_SIZE_BYTES,
  PIXELS_PER_METATILE,
  PIXELS_PER_TILE,
  TILE_4BPP_SIZE_BYTES,
  bgr555ToRgba,
  composeMetatile,
  decode4bppTile,
  decodeMetatile,
  decodeMetatileTileAttribute,
} from './tile-pixels.js';

describe('decode4bppTile', () => {
  it('decodes 32 bytes into 64 palette indices, low nibble first', () => {
    const bytes = new Uint8Array(TILE_4BPP_SIZE_BYTES);
    // Byte 0 = 0x21 → low nibble 1, high nibble 2 → pixels[0]=1, pixels[1]=2
    bytes[0] = 0x21;
    bytes[1] = 0x43;
    const pixels = decode4bppTile(bytes, 0);
    expect(pixels.length).toBe(PIXELS_PER_TILE);
    expect(pixels[0]).toBe(0x1);
    expect(pixels[1]).toBe(0x2);
    expect(pixels[2]).toBe(0x3);
    expect(pixels[3]).toBe(0x4);
  });

  it('throws RangeError on out-of-bounds offset', () => {
    const bytes = new Uint8Array(16);
    expect(() => decode4bppTile(bytes, 0)).toThrow(RangeError);
  });
});

describe('bgr555ToRgba', () => {
  it('returns index 0 as fully transparent (0x00000000)', () => {
    const palette = new Uint8Array(PALETTE_4BPP_SIZE_BYTES);
    palette[0] = 0x1f; // pure red BGR555 = 0x001F → R=31,G=0,B=0
    palette[1] = 0x00;
    const rgba = bgr555ToRgba(palette);
    expect(rgba[0]).toBe(0); // index 0 transparent regardless of color bytes
  });

  it('converts pure red BGR555 at index 1 to 0xFF0000FF (alpha+red)', () => {
    const palette = new Uint8Array(PALETTE_4BPP_SIZE_BYTES);
    // Index 0 = some color (will be transparent anyway)
    palette[0] = 0;
    palette[1] = 0;
    // Index 1 = pure red: BGR555 0x001F = 0001 1111 → R=31, G=0, B=0
    palette[2] = 0x1f;
    palette[3] = 0x00;
    const rgba = bgr555ToRgba(palette);
    // R=0xFF, G=0, B=0, A=0xFF → little-endian u32 = 0xFF0000FF
    expect(rgba[1]).toBe(0xff0000ff);
  });

  it('converts pure green BGR555 at index 2 to 0xFF00FF00', () => {
    const palette = new Uint8Array(PALETTE_4BPP_SIZE_BYTES);
    // Index 2 = pure green: BGR555 0x03E0 = 0000 0011 1110 0000 → G=31
    palette[4] = 0xe0;
    palette[5] = 0x03;
    const rgba = bgr555ToRgba(palette);
    // R=0, G=0xFF, B=0, A=0xFF → 0xFF00FF00
    expect(rgba[2]).toBe(0xff00ff00);
  });

  it('converts pure blue BGR555 at index 3 to 0xFFFF0000', () => {
    const palette = new Uint8Array(PALETTE_4BPP_SIZE_BYTES);
    // Index 3 = pure blue: BGR555 0x7C00 → B=31
    palette[6] = 0x00;
    palette[7] = 0x7c;
    const rgba = bgr555ToRgba(palette);
    // R=0, G=0, B=0xFF, A=0xFF → 0xFFFF0000
    expect(rgba[3]).toBe(0xffff0000);
  });

  it('converts white BGR555 0x7FFF to 0xFFFFFFFF', () => {
    const palette = new Uint8Array(PALETTE_4BPP_SIZE_BYTES);
    palette[8] = 0xff;
    palette[9] = 0x7f;
    const rgba = bgr555ToRgba(palette);
    expect(rgba[4]).toBe(0xffffffff);
  });

  it('converts black BGR555 0x0000 to 0xFF000000', () => {
    const palette = new Uint8Array(PALETTE_4BPP_SIZE_BYTES);
    palette[10] = 0;
    palette[11] = 0;
    const rgba = bgr555ToRgba(palette);
    expect(rgba[5]).toBe(0xff000000);
  });

  it('throws on undersized palette', () => {
    expect(() => bgr555ToRgba(new Uint8Array(16))).toThrow(RangeError);
  });
});

describe('decodeMetatileTileAttribute', () => {
  it('extracts tile index, flips, palette index', () => {
    // 0xFC2A:
    //   tileIndex = 0x2A & 0x3FF + (high bits) = 0xFC2A & 0x3FF = 0x22A
    //   hflip = bit 10 → 0xFC2A & 0x0400 = 0x0400 → true? actually no, 0xFC2A bit 10 is 0
    //   Let me re-pick:
    // 0xF42A = 1111 0100 0010 1010
    //   bits 0-9   = 0000101010 = 0x02A
    //   bit 10     = 1 → hflip true
    //   bit 11     = 0 → vflip false
    //   bits 12-15 = 1111 → paletteIndex 15
    const spec = decodeMetatileTileAttribute(0xf42a);
    expect(spec.tileIndex).toBe(0x02a);
    expect(spec.hflip).toBe(true);
    expect(spec.vflip).toBe(false);
    expect(spec.paletteIndex).toBe(15);
  });

  it('handles zero attribute → tile 0, no flips, palette 0', () => {
    const spec = decodeMetatileTileAttribute(0);
    expect(spec.tileIndex).toBe(0);
    expect(spec.hflip).toBe(false);
    expect(spec.vflip).toBe(false);
    expect(spec.paletteIndex).toBe(0);
  });
});

describe('decodeMetatile', () => {
  it('decodes 16 bytes into 4 layer-0 + 4 layer-1 specs', () => {
    const bytes = new Uint8Array(16);
    // Layer 0 tiles 0..3 with indices 1..4, no flips, palette 0
    for (let i = 0; i < 4; i++) {
      const attr = i + 1;
      bytes[i * 2] = attr & 0xff;
      bytes[i * 2 + 1] = (attr >> 8) & 0xff;
    }
    // Layer 1 tiles 4..7 with indices 5..8
    for (let i = 0; i < 4; i++) {
      const attr = i + 5;
      bytes[8 + i * 2] = attr & 0xff;
      bytes[8 + i * 2 + 1] = (attr >> 8) & 0xff;
    }
    const { layer0, layer1 } = decodeMetatile(bytes, 0);
    expect(layer0.map((s) => s.tileIndex)).toEqual([1, 2, 3, 4]);
    expect(layer1.map((s) => s.tileIndex)).toEqual([5, 6, 7, 8]);
  });
});

describe('composeMetatile', () => {
  it('produces 16×16 = 256 pixels', () => {
    const tileSheet = [new Uint8Array(PIXELS_PER_TILE)];
    const palettes = [new Uint32Array(16)];
    const layer0 = Array.from({ length: 4 }, () => ({
      tileIndex: 0,
      hflip: false,
      vflip: false,
      paletteIndex: 0,
    }));
    const layer1 = [...layer0];
    const out = composeMetatile(layer0, layer1, tileSheet, palettes);
    expect(out.length).toBe(PIXELS_PER_METATILE);
  });

  it('composites layer 1 over layer 0 (opaque layer-1 pixels win)', () => {
    // Build a simple tile sheet: tile 0 = all palette index 1, tile 1 =
    // all palette index 2.
    const tile0 = new Uint8Array(PIXELS_PER_TILE).fill(1);
    const tile1 = new Uint8Array(PIXELS_PER_TILE).fill(2);
    const palette = new Uint32Array(16);
    palette[1] = 0xff0000ff; // red
    palette[2] = 0xff00ff00; // green
    // Layer 0: all 4 quadrants use tile 0 (red).
    const layer0 = Array.from({ length: 4 }, () => ({
      tileIndex: 0,
      hflip: false,
      vflip: false,
      paletteIndex: 0,
    }));
    // Layer 1: all 4 quadrants use tile 1 (green) - should fully replace red.
    const layer1 = Array.from({ length: 4 }, () => ({
      tileIndex: 1,
      hflip: false,
      vflip: false,
      paletteIndex: 0,
    }));
    const out = composeMetatile(layer0, layer1, [tile0, tile1], [palette]);
    // Every pixel should be green (layer 1 wins; all index-2 pixels are opaque).
    expect(out.every((p) => p === 0xff00ff00)).toBe(true);
  });

  it('layer 1 palette index 0 lets layer 0 show through', () => {
    // Tile 0 = all index 1 (red). Tile 1 = all index 0 (transparent).
    const tile0 = new Uint8Array(PIXELS_PER_TILE).fill(1);
    const tile1 = new Uint8Array(PIXELS_PER_TILE).fill(0);
    const palette = new Uint32Array(16);
    palette[1] = 0xff0000ff;
    const layer0 = Array.from({ length: 4 }, () => ({
      tileIndex: 0,
      hflip: false,
      vflip: false,
      paletteIndex: 0,
    }));
    const layer1 = Array.from({ length: 4 }, () => ({
      tileIndex: 1,
      hflip: false,
      vflip: false,
      paletteIndex: 0,
    }));
    const out = composeMetatile(layer0, layer1, [tile0, tile1], [palette]);
    // Layer 1 is all-transparent so layer 0's red should still show.
    expect(out.every((p) => p === 0xff0000ff)).toBe(true);
  });

  it('hflip + vflip correctly mirror the tile', () => {
    // Tile 0: top-left pixel = 1, everything else = 0.
    const tile = new Uint8Array(PIXELS_PER_TILE);
    tile[0] = 1;
    const palette = new Uint32Array(16);
    palette[1] = 0xff0000ff;
    // Layer 0 quadrant 0 (top-left) with hflip+vflip → original
    // top-left pixel ends up at bottom-right of the 8×8 tile.
    const layer0 = [
      { tileIndex: 0, hflip: true, vflip: true, paletteIndex: 0 },
      { tileIndex: 0, hflip: false, vflip: false, paletteIndex: 0 },
      { tileIndex: 0, hflip: false, vflip: false, paletteIndex: 0 },
      { tileIndex: 0, hflip: false, vflip: false, paletteIndex: 0 },
    ];
    const layer1 = layer0.map((s) => ({ ...s, tileIndex: 0, paletteIndex: 0 }));
    // Override layer 1 to be fully empty (every pixel transparent).
    const tileEmpty = new Uint8Array(PIXELS_PER_TILE);
    const out = composeMetatile(layer0, layer1, [tile, tileEmpty], [palette]);
    // Original top-left tile, hflipped + vflipped, top-left pixel (x=0, y=0)
    // moves to (x=7, y=7) within that 8×8 quadrant, which is metatile
    // position (7, 7).
    expect(out[7 * 16 + 7]).toBe(0xff0000ff);
    // Original top-left metatile position (0, 0) should now be empty.
    expect(out[0]).toBe(0);
  });
});
