import { describe, expect, it } from 'vitest';
import type { RgbColor, TilesetData } from '../scan/tileset-render.js';
import {
  buildVocabularyFromTilesets,
  fitImageToVocabulary,
  stitchGridToRgba,
} from './reference-fit.js';

/* A minimal synthetic tileset: 4 solid-colour 8×8 tiles (index 0..3) and 4
 * metatiles whose layer-0 is a single tile (layer-1 transparent). Metatile 3
 * deliberately duplicates metatile 0 (both red) to exercise dup handling. */
function solidTile(nibble: number): Buffer {
  return Buffer.alloc(32, ((nibble << 4) | nibble) & 0xff);
}
function solidMetatile(layer0TileId: number): Buffer {
  const b = Buffer.alloc(16, 0);
  for (let sub = 0; sub < 4; sub++) {
    b[sub * 2] = layer0TileId & 0xff;
    b[sub * 2 + 1] = (layer0TileId >> 8) & 0xff;
  }
  // layer 1 (bytes 8..15) left 0 → tile 0 → index 0 → transparent
  return b;
}
function makeTileset(): TilesetData {
  const tiles = Buffer.concat([solidTile(0), solidTile(1), solidTile(2), solidTile(3)]);
  const metatiles = Buffer.concat([
    solidMetatile(1), // m0 = red
    solidMetatile(2), // m1 = green
    solidMetatile(3), // m2 = blue
    solidMetatile(1), // m3 = red (dup of m0)
  ]);
  const pal0: RgbColor[] = [
    { r: 0, g: 0, b: 0 }, // 0 = black/transparent
    { r: 255, g: 0, b: 0 }, // 1 = red
    { r: 0, g: 255, b: 0 }, // 2 = green
    { r: 0, g: 0, b: 255 }, // 3 = blue
  ];
  const palettes: RgbColor[][] = [pal0];
  while (palettes.length < 16) palettes.push([]);
  return { tiles, metatiles, palettes };
}

describe('reference-fit', () => {
  it('builds a vocabulary with one entry per metatile and buckets duplicates by hash', () => {
    const vocab = buildVocabularyFromTilesets(makeTileset(), null);
    expect(vocab.primaryCount).toBe(4);
    expect(vocab.entries.length).toBe(4);
    // m0 and m3 are identical red → same hash bucket.
    const redHash = vocab.entries[0]!.hash;
    expect(vocab.byHash.get(redHash)).toEqual([0, 3]);
  });

  it('round-trips an exact render pixel-for-pixel (every cell an exact match)', () => {
    const vocab = buildVocabularyFromTilesets(makeTileset(), null);
    const cols = 2;
    const rows = 2;
    const grid = [0, 1, 2, 3]; // red, green, blue, red
    const ref = stitchGridToRgba(grid, cols, rows, vocab);

    const fit = fitImageToVocabulary(ref.pixels, ref.width, ref.height, vocab);
    expect(fit.cols).toBe(2);
    expect(fit.rows).toBe(2);
    expect(fit.exactCells).toBe(4);
    expect(fit.approxCells).toBe(0);
    expect(fit.worstError).toBe(0);

    // Reconstruction must be byte-identical to the reference.
    const recon = stitchGridToRgba(fit.grid, fit.cols, fit.rows, vocab);
    expect(Buffer.from(recon.pixels)).toEqual(Buffer.from(ref.pixels));
    // The red cells may resolve to id 0 OR its duplicate 3 - both are red.
    expect([0, 3]).toContain(fit.grid[0]);
    expect(fit.grid[1]).toBe(1);
    expect(fit.grid[2]).toBe(2);
    expect([0, 3]).toContain(fit.grid[3]);
  });

  it('falls back to the nearest metatile when a cell is not an exact match', () => {
    const vocab = buildVocabularyFromTilesets(makeTileset(), null);
    const ref = stitchGridToRgba([0, 1], 2, 1, vocab); // red | green
    // Darken the red cell slightly (still closest to red, not green/blue).
    const pixels = Uint8ClampedArray.from(ref.pixels);
    for (let y = 0; y < 16; y++) {
      for (let x = 0; x < 16; x++) {
        const i = (y * ref.width + x) * 4;
        pixels[i] = Math.max(0, pixels[i]! - 40); // R: 255 → 215
      }
    }
    const fit = fitImageToVocabulary(pixels, ref.width, ref.height, vocab);
    expect(fit.approxCells).toBe(1); // the perturbed red cell
    expect(fit.exactCells).toBe(1); // the untouched green cell
    expect(fit.cells[0]!.exact).toBe(false);
    expect(fit.cells[0]!.error).toBeGreaterThan(0);
    // Nearest is still a red metatile (0 or its dup 3), not green.
    expect([0, 3]).toContain(fit.grid[0]);
    expect(fit.grid[1]).toBe(1);
  });
});
