import { describe, it, expect } from 'vitest';
import { parseTileset } from './tileset.js';
import { encodeTileset, TilesetEncodeError } from './tileset-writer.js';

describe('encodeTileset', () => {
  it('round-trips a primary uncompressed tileset', () => {
    const spec = {
      isCompressed: false,
      isSecondary: false,
      tilesOffset: 0x100000,
      palettesOffset: 0x100100,
      metatilesOffset: 0x100200,
      slot10Offset: 0x100300,
      slot14Offset: 0x100400,
    } as const;
    const bytes = encodeTileset(spec);
    expect(bytes.length).toBe(24);
    const buf = new Uint8Array(0x200000);
    buf.set(bytes, 0);
    const parsed = parseTileset(buf, 0);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.tileset.isCompressed).toBe(false);
      expect(parsed.tileset.isSecondary).toBe(false);
      expect(parsed.tileset.tilesOffset).toBe(0x100000);
      expect(parsed.tileset.palettesOffset).toBe(0x100100);
      expect(parsed.tileset.metatilesOffset).toBe(0x100200);
      expect(parsed.tileset.slot10Offset).toBe(0x100300);
      expect(parsed.tileset.slot14Offset).toBe(0x100400);
    }
  });

  it('round-trips a secondary compressed tileset with null slots', () => {
    const spec = {
      isCompressed: true,
      isSecondary: true,
      tilesOffset: 0x100000,
      palettesOffset: 0x100100,
      metatilesOffset: null,
      slot10Offset: null,
      slot14Offset: null,
    } as const;
    const bytes = encodeTileset(spec);
    const buf = new Uint8Array(0x200000);
    buf.set(bytes, 0);
    const parsed = parseTileset(buf, 0);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.tileset.isCompressed).toBe(true);
      expect(parsed.tileset.isSecondary).toBe(true);
      expect(parsed.tileset.metatilesOffset).toBeNull();
      expect(parsed.tileset.slot10Offset).toBeNull();
    }
  });

  it('rejects the all-data-pointers-null case (parser would reject too)', () => {
    expect(() =>
      encodeTileset({
        isCompressed: false,
        isSecondary: false,
        tilesOffset: null,
        palettesOffset: null,
        metatilesOffset: null,
        slot10Offset: null,
        slot14Offset: null,
      }),
    ).toThrow(TilesetEncodeError);
  });

  it('writes zeros for the padding bytes at 0x02/0x03', () => {
    const bytes = encodeTileset({
      isCompressed: true,
      isSecondary: false,
      tilesOffset: 0x100000,
      palettesOffset: 0x100100,
      metatilesOffset: null,
      slot10Offset: null,
      slot14Offset: null,
    });
    expect(bytes[0x02]).toBe(0);
    expect(bytes[0x03]).toBe(0);
  });
});
