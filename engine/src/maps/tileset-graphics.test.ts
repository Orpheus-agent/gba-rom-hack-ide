import { describe, expect, it } from 'vitest';
import { encodeLz77Literal } from '../compression/lz77.js';
import { fetchTilesetGraphics } from './tileset-graphics.js';

describe('fetchTilesetGraphics', () => {
  it('returns empty arrays when all offsets are null', () => {
    const r = fetchTilesetGraphics({
      rom: new Uint8Array(4096),
      tilesOffset: null,
      palettesOffset: null,
      metatilesOffset: null,
      isCompressed: false,
    });
    expect(r.tiles.length).toBe(0);
    expect(r.palettes.length).toBe(0);
    expect(r.metatiles.length).toBe(0);
    expect(r.truncated).toBe(false);
  });

  it('decodes 4 uncompressed tiles + 16 palettes + 2 metatile slots', () => {
    // Build a 4096-byte ROM with:
    //   tiles at 0x100 - 4 tiles × 32 bytes = 128 bytes of pattern data
    //   palettes at 0x400 - 16 × 32 = 512 bytes
    //   metatiles at 0x800 - 2 × 16 = 32 bytes
    const rom = new Uint8Array(4096);
    // Plant 4 tiles with palette-index pattern (just zeros works for shape test).
    for (let i = 0; i < 128; i++) rom[0x100 + i] = (i & 0x0f) | ((i & 0x0f) << 4);
    // Plant 16 palettes (each 32 bytes of varied BGR555 values).
    for (let i = 0; i < 16 * 32; i++) rom[0x400 + i] = i & 0xff;
    // Plant 2 metatiles' worth of attribute bytes.
    for (let i = 0; i < 32; i++) rom[0x800 + i] = i;

    const r = fetchTilesetGraphics({
      rom,
      tilesOffset: 0x100,
      palettesOffset: 0x400,
      metatilesOffset: 0x800,
      isCompressed: false,
    });

    // Uncompressed tile read fills as many full 32-byte tiles as
    // possible from the offset; with rom of 4096 bytes starting at
    // 0x100 we read up to TILESET_MAX_TILES tiles but capped by
    // available bytes. Expect at least the 4 we planted.
    expect(r.tiles.length).toBeGreaterThanOrEqual(4);
    expect(r.palettes.length).toBe(16);
    expect(r.metatiles.length).toBeGreaterThanOrEqual(2);
    expect(r.truncated).toBe(false);
    expect(r.tileBytesDecoded).toBeGreaterThanOrEqual(128);
  });

  it('decompresses LZ77 tile data when isCompressed=true', () => {
    const literalTiles = new Uint8Array(96); // 3 tiles' worth of pattern
    for (let i = 0; i < literalTiles.length; i++) literalTiles[i] = i & 0xff;
    const compressed = encodeLz77Literal(literalTiles);
    const rom = new Uint8Array(2048);
    rom.set(compressed, 0x100);
    // Palettes after the compressed block.
    const palettesStart = 0x100 + compressed.length + 16;
    for (let i = 0; i < 16 * 32; i++) rom[palettesStart + i] = i & 0xff;

    const r = fetchTilesetGraphics({
      rom,
      tilesOffset: 0x100,
      palettesOffset: palettesStart,
      metatilesOffset: null,
      isCompressed: true,
    });
    expect(r.tiles.length).toBe(3);
    expect(r.palettes.length).toBe(16);
    expect(r.truncated).toBe(false);
  });

  it('flags truncated when LZ77 stream is bad', () => {
    const rom = new Uint8Array(256);
    // Plant invalid LZ77 header byte at offset 0x10.
    rom[0x10] = 0xaa; // not 0x10 → readLz77 returns ok=false
    const r = fetchTilesetGraphics({
      rom,
      tilesOffset: 0x10,
      palettesOffset: null,
      metatilesOffset: null,
      isCompressed: true,
    });
    expect(r.tiles.length).toBe(0);
    expect(r.truncated).toBe(true);
  });
});
