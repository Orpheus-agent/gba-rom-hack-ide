import { describe, expect, it } from 'vitest';
import { TILE_4BPP_SIZE_BYTES } from '../graphics/index.js';
import {
  OBJECT_EVENT_GRAPHICS_IMAGES_PTR_OFFSET,
  SPRITE_FRAME_IMAGE_SIZE_BYTES,
  applyPaletteToOverworldSprite,
  decodeOverworldSpriteImage,
} from './overworld-sprite-image.js';

const GBA_ROM_BASE = 0x08000000;

/** Build a test ROM with a planted ObjectEventGraphicsInfo struct +
 *  SpriteFrameImage + raw 4bpp tile data. Returns the byte buffer +
 *  the offsets. */
function buildTestRom(opts: {
  romSize: number;
  structOffset: number;
  framesOffset: number;
  tileDataOffset: number;
  width: number;
  height: number;
}): Uint8Array {
  const bytes = new Uint8Array(opts.romSize);
  const view = new DataView(bytes.buffer);
  // Struct header: width (s16) + height (s16) at +0x08/+0x0A.
  view.setInt16(opts.structOffset + 0x08, opts.width, true);
  view.setInt16(opts.structOffset + 0x0a, opts.height, true);
  // images pointer at +0x1C.
  view.setUint32(
    opts.structOffset + OBJECT_EVENT_GRAPHICS_IMAGES_PTR_OFFSET,
    GBA_ROM_BASE + opts.framesOffset,
    true,
  );
  // SpriteFrameImage at framesOffset: data ptr + size.
  view.setUint32(opts.framesOffset + 0x00, GBA_ROM_BASE + opts.tileDataOffset, true);
  const tilesWide = opts.width / 8;
  const tilesTall = opts.height / 8;
  const expectedBytes = tilesWide * tilesTall * TILE_4BPP_SIZE_BYTES;
  view.setUint16(opts.framesOffset + 0x04, expectedBytes, true);
  // Plant tile data: each byte = (tileIndex & 0x0F) repeated so the
  // decoded palette index for every pixel of tile N equals N & 0x0F.
  for (let t = 0; t < tilesWide * tilesTall; t++) {
    const idx = t & 0x0f;
    const byte = idx | (idx << 4);
    for (let i = 0; i < TILE_4BPP_SIZE_BYTES; i++) {
      bytes[opts.tileDataOffset + t * TILE_4BPP_SIZE_BYTES + i] = byte;
    }
  }
  return bytes;
}

describe('decodeOverworldSpriteImage', () => {
  it('decodes a 16×32 sprite into 8 tiles × 64 pixels each', () => {
    const bytes = buildTestRom({
      romSize: 32 * 1024,
      structOffset: 0x100,
      framesOffset: 0x200,
      tileDataOffset: 0x400,
      width: 16,
      height: 32,
    });
    const r = decodeOverworldSpriteImage(bytes, 0x100);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.image.width).toBe(16);
      expect(r.image.height).toBe(32);
      expect(r.image.tileCount).toBe(8); // 2×4 tiles
      expect(r.image.pixelIndices.length).toBe(16 * 32);
      // Tile 0 (top-left 8×8) - all pixels should be palette index 0.
      for (let py = 0; py < 8; py++) {
        for (let px = 0; px < 8; px++) {
          expect(r.image.pixelIndices[py * 16 + px]).toBe(0);
        }
      }
      // Tile 1 (top-right 8×8) - all pixels should be palette index 1.
      for (let py = 0; py < 8; py++) {
        for (let px = 8; px < 16; px++) {
          expect(r.image.pixelIndices[py * 16 + px]).toBe(1);
        }
      }
      // Tile 4 (third row left, index 4) - bottom-left at y=16.
      for (let py = 16; py < 24; py++) {
        for (let px = 0; px < 8; px++) {
          expect(r.image.pixelIndices[py * 16 + px]).toBe(4);
        }
      }
    }
  });

  it('decodes a 64×64 sprite (8×8 tiles)', () => {
    const bytes = buildTestRom({
      romSize: 64 * 1024,
      structOffset: 0x100,
      framesOffset: 0x200,
      tileDataOffset: 0x400,
      width: 64,
      height: 64,
    });
    const r = decodeOverworldSpriteImage(bytes, 0x100);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.image.tileCount).toBe(64);
      expect(r.image.pixelIndices.length).toBe(64 * 64);
    }
  });

  it('rejects implausible dimensions (odd width)', () => {
    const bytes = new Uint8Array(1024);
    const view = new DataView(bytes.buffer);
    view.setInt16(0x100 + 0x08, 15, true); // not divisible by 8
    view.setInt16(0x100 + 0x0a, 32, true);
    const r = decodeOverworldSpriteImage(bytes, 0x100);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.kind).toBe('implausible_dimensions');
  });

  it('rejects images pointer out of ROM range', () => {
    const bytes = new Uint8Array(1024);
    const view = new DataView(bytes.buffer);
    view.setInt16(0x100 + 0x08, 16, true);
    view.setInt16(0x100 + 0x0a, 32, true);
    view.setUint32(0x100 + 0x1c, 0xdeadbeef, true); // way out of range
    const r = decodeOverworldSpriteImage(bytes, 0x100);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.kind).toBe('invalid_images_pointer');
  });

  it('rejects out-of-bounds struct offset', () => {
    const bytes = new Uint8Array(16);
    const r = decodeOverworldSpriteImage(bytes, 0x100);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.kind).toBe('struct_too_short');
  });

  it('decodes frame 1 when frameIndex=1', () => {
    // Build with 2 frames: frame 0 covers tile data at 0x400, frame 1 at 0x800.
    const bytes = new Uint8Array(32 * 1024);
    const view = new DataView(bytes.buffer);
    view.setInt16(0x100 + 0x08, 16, true);
    view.setInt16(0x100 + 0x0a, 16, true);
    view.setUint32(0x100 + 0x1c, GBA_ROM_BASE + 0x200, true);
    // Frame 0: data → 0x400, size = 4 tiles × 32 = 128
    view.setUint32(0x200 + 0x00, GBA_ROM_BASE + 0x400, true);
    view.setUint16(0x200 + 0x04, 128, true);
    // Frame 1: data → 0x800, size = 128
    view.setUint32(0x208 + 0x00, GBA_ROM_BASE + 0x800, true);
    view.setUint16(0x208 + 0x04, 128, true);
    // Plant tile data at 0x400 (all 0x11) and at 0x800 (all 0x22).
    for (let i = 0; i < 128; i++) bytes[0x400 + i] = 0x11;
    for (let i = 0; i < 128; i++) bytes[0x800 + i] = 0x22;
    // Frame 0: every pixel should be palette index 1.
    const r0 = decodeOverworldSpriteImage(bytes, 0x100, 0);
    expect(r0.ok).toBe(true);
    if (r0.ok) {
      expect(r0.image.pixelIndices[0]).toBe(1);
      expect(r0.image.tileDataFileOffset).toBe(0x400);
    }
    // Frame 1: every pixel should be palette index 2.
    const r1 = decodeOverworldSpriteImage(bytes, 0x100, 1);
    expect(r1.ok).toBe(true);
    if (r1.ok) {
      expect(r1.image.pixelIndices[0]).toBe(2);
      expect(r1.image.tileDataFileOffset).toBe(0x800);
    }
  });
});

describe('applyPaletteToOverworldSprite', () => {
  it('renders palette index 0 as fully transparent', () => {
    const image = {
      width: 4,
      height: 4,
      pixelIndices: new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
      tileCount: 0,
      tileDataFileOffset: 0,
      frameSizeBytes: 0,
    };
    const palette = new Uint32Array(16);
    palette[0] = 0xff0000ff; // would be red, but index 0 is transparent
    const out = applyPaletteToOverworldSprite(image, palette);
    expect(out.every((p) => p === 0)).toBe(true);
  });

  it('applies palette colors to non-zero indices', () => {
    const image = {
      width: 2,
      height: 2,
      pixelIndices: new Uint8Array([1, 2, 3, 4]),
      tileCount: 0,
      tileDataFileOffset: 0,
      frameSizeBytes: 0,
    };
    const palette = new Uint32Array(16);
    palette[1] = 0xff0000ff; // red
    palette[2] = 0xff00ff00; // green
    palette[3] = 0xffff0000; // blue
    palette[4] = 0xffffffff; // white
    const out = applyPaletteToOverworldSprite(image, palette);
    expect(out[0]).toBe(0xff0000ff);
    expect(out[1]).toBe(0xff00ff00);
    expect(out[2]).toBe(0xffff0000);
    expect(out[3]).toBe(0xffffffff);
  });
});
