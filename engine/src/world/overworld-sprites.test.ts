import { describe, expect, it } from 'vitest';
import {
  OBJECT_EVENT_GRAPHICS_INFO_SIZE_BYTES,
  OVERWORLD_SPRITES_MIN_ENTRIES,
  scanOverworldSpriteTable,
} from './index.js';

const GBA_ROM_BASE = 0x08000000;

/** Build a valid 36-byte ObjectEventGraphicsInfo struct with the given
 *  seed for varying the per-sprite fields. All pointer fields point to
 *  the same dummy ROM offset (which doesn't need to be valid data - 
 *  the scanner only checks that they're in [0x08000000, 0x0A000000)). */
function buildValidSpriteStruct(seed: number, dummyPtr: number): Uint8Array {
  const buf = new Uint8Array(OBJECT_EVENT_GRAPHICS_INFO_SIZE_BYTES);
  const view = new DataView(buf.buffer);
  view.setUint16(0x00, 0xffff & seed, true); // tileTag (any u16)
  view.setUint16(0x02, 0x1100 + (seed & 0xff), true); // paletteTag
  view.setUint16(0x04, 0x11ff, true); // reflectionPaletteTag (vanilla)
  view.setUint16(0x06, seed & 0x1f, true); // size (≤ 31)
  view.setInt16(0x08, 16, true); // width
  view.setInt16(0x0a, 32, true); // height
  buf[0x0c] = seed & 0xff; // paletteSlot bitfield byte
  buf[0x0d] = seed & 0x07; // tracks (≤ 7)
  // 0x0e/0x0f padding stays zero
  view.setUint32(0x10, dummyPtr, true); // oam (non-zero ROM ptr)
  view.setUint32(0x14, 0, true); // subspriteTables (0 ok)
  view.setUint32(0x18, dummyPtr, true); // anims
  view.setUint32(0x1c, dummyPtr, true); // images (non-zero ROM ptr)
  view.setUint32(0x20, 0, true); // affineAnims (0 ok)
  return buf;
}

/** Build a 100-entry test ROM with the sprite pointer table at
 *  `tableOffset` and the 100 sprite structs packed starting at
 *  `structsOffset`. Returns the bytes + the metadata. */
function buildTestRom(
  romSize: number,
  tableOffset: number,
  structsOffset: number,
  spriteCount: number,
): Uint8Array {
  const bytes = new Uint8Array(romSize);
  // Fill ROM with garbage so the scanner can't false-positive on padding.
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 13 + 7) % 256;
  // Plant the sprite structs.
  for (let i = 0; i < spriteCount; i++) {
    const structOff = structsOffset + i * OBJECT_EVENT_GRAPHICS_INFO_SIZE_BYTES;
    const dummyPtr = GBA_ROM_BASE + structsOffset; // some valid ROM ptr
    bytes.set(buildValidSpriteStruct(i + 1, dummyPtr), structOff);
  }
  // Plant the pointer table.
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < spriteCount; i++) {
    const structOff = structsOffset + i * OBJECT_EVENT_GRAPHICS_INFO_SIZE_BYTES;
    view.setUint32(tableOffset + i * 4, GBA_ROM_BASE + structOff, true);
  }
  return bytes;
}

describe('scanOverworldSpriteTable', () => {
  it('returns null when ROM is too small', () => {
    const bytes = new Uint8Array(500);
    expect(scanOverworldSpriteTable(bytes)).toBeNull();
  });

  it('returns null when no pointer-table run exists', () => {
    const bytes = new Uint8Array(64 * 1024);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 11 + 17) % 256;
    expect(scanOverworldSpriteTable(bytes)).toBeNull();
  });

  it('finds a planted table of 100 sprite entries', () => {
    const bytes = buildTestRom(256 * 1024, 0x4000, 0x10000, 100);
    const result = scanOverworldSpriteTable(bytes);
    expect(result).not.toBeNull();
    expect(result?.tableStart).toBe(0x4000);
    expect(result?.entryCount).toBe(100);
    expect(result?.sprites.length).toBe(100);
  });

  it('parses per-sprite fields (tileTag, paletteTag, size, width, height, tracks)', () => {
    const bytes = buildTestRom(256 * 1024, 0x4000, 0x10000, 100);
    const result = scanOverworldSpriteTable(bytes);
    expect(result).not.toBeNull();
    const sprite0 = result!.sprites[0]!;
    expect(sprite0.width).toBe(16);
    expect(sprite0.height).toBe(32);
    expect(sprite0.size).toBe(1 & 0x1f); // seed=1, size = seed & 0x1f
    expect(sprite0.paletteTag).toBe(0x1100 + 1);
    expect(sprite0.tracks).toBe(1 & 0x07);
  });

  it('respects custom minEntries option', () => {
    const bytes = buildTestRom(64 * 1024, 0x1000, 0x4000, 40);
    expect(scanOverworldSpriteTable(bytes)).toBeNull();
    const lowMin = scanOverworldSpriteTable(bytes, { minEntries: 30 });
    expect(lowMin).not.toBeNull();
    expect(lowMin?.entryCount).toBe(40);
  });

  it('rejects a candidate where width is out of range', () => {
    const bytes = buildTestRom(256 * 1024, 0x4000, 0x10000, 100);
    // Corrupt the first struct's width to 0 (below SPRITE_DIMENSION_MIN).
    new DataView(bytes.buffer).setInt16(0x10000 + 0x08, 0, true);
    // With only 1 invalid struct out of 100, the scanner should bail
    // out at the first invalid entry (current implementation halts on
    // first miss rather than tolerating). So no run starts here; but
    // the scanner can still find a shorter valid run starting AFTER
    // the corrupted struct. Verify that the table-as-planted with 100
    // entries is no longer detected at its exact start.
    const result = scanOverworldSpriteTable(bytes);
    // Could detect a shorter run starting at entry index 1+, which is
    // shorter than 100. Acceptable outcome: either null OR a shorter
    // table starting after the corruption.
    if (result !== null) {
      expect(result.tableStart).not.toBe(0x4000);
    }
  });

  it('rejects when all structs have null OAM pointer (invalid)', () => {
    const bytes = buildTestRom(256 * 1024, 0x4000, 0x10000, 100);
    // Zero out the oam pointer in every struct.
    const view = new DataView(bytes.buffer);
    for (let i = 0; i < 100; i++) {
      view.setUint32(0x10000 + i * OBJECT_EVENT_GRAPHICS_INFO_SIZE_BYTES + 0x10, 0, true);
    }
    expect(scanOverworldSpriteTable(bytes)).toBeNull();
  });

  it('honors the OVERWORLD_SPRITES_MIN_ENTRIES default', () => {
    // Build a 99-entry table - just below the default min of 100.
    const bytes = buildTestRom(128 * 1024, 0x2000, 0x8000, 99);
    expect(scanOverworldSpriteTable(bytes)).toBeNull();
    // Build exactly the default min - should be accepted.
    const bytes2 = buildTestRom(
      128 * 1024,
      0x2000,
      0x8000,
      OVERWORLD_SPRITES_MIN_ENTRIES,
    );
    expect(scanOverworldSpriteTable(bytes2)).not.toBeNull();
  });
});
