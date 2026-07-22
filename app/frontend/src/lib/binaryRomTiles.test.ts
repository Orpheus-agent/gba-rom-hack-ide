import { describe, expect, it } from 'vitest';
import {
  composeBinaryRomMetatilePixels,
  composeBinaryRomMetatilePixelsDual,
  computeMissingMetatiles,
  TILESET_BOUNDARIES_FRLG,
  TILESET_BOUNDARIES_RSE,
  tilesetBoundariesForGameCode,
  tilesetBoundariesForRom,
} from './binaryRomTiles';
import type {
  BinaryRomMapDataResponseLike,
  BinaryRomTilesetResponseLike,
  MetatileSpecRaw,
} from '../api';

/** Build a `BinaryRomTilesetResponseLike` with `tileCount` tiles:
 *  tile 0 is fully transparent (palette index 0), tile 1+ are filled
 *  with palette index 1 (visible). This shape lets metatile specs put
 *  the visible tile in layer 0 and a transparent passthrough in layer 1
 *  (vanilla "no top layer" pattern). */
function makeTileset(args: {
  tileCount: number;
  palettes: ReadonlyArray<ReadonlyArray<number>>;
  metatileSpecs: ReadonlyArray<{
    layer0: ReadonlyArray<MetatileSpecRaw>;
    layer1: ReadonlyArray<MetatileSpecRaw>;
  }>;
}): BinaryRomTilesetResponseLike {
  const buf = new Uint8Array(args.tileCount * 64);
  // Tile 0 stays all-zero (transparent at palette index 0).
  // Tiles 1..tileCount-1 fill with palette index 1.
  for (let i = 1; i < args.tileCount; i++) {
    buf.fill(1, i * 64, (i + 1) * 64);
  }
  let binary = '';
  for (let i = 0; i < buf.length; i++) binary += String.fromCharCode(buf[i]!);
  const tileSheetIndices = btoa(binary);
  return {
    tileCount: args.tileCount,
    palettes: args.palettes,
    tileSheetIndices,
    tileSheetRgba: '',
    metatileSpecs: args.metatileSpecs,
    truncated: false,
  };
}

/** Empty layer-1 spec: tile 0 (transparent) + palette 0. Mirrors the
 *  vanilla "no top layer" metatile encoding. */
const EMPTY_LAYER1: ReadonlyArray<MetatileSpecRaw> = Object.freeze([
  Object.freeze({ tileIndex: 0, hflip: false, vflip: false, paletteIndex: 0 }),
  Object.freeze({ tileIndex: 0, hflip: false, vflip: false, paletteIndex: 0 }),
  Object.freeze({ tileIndex: 0, hflip: false, vflip: false, paletteIndex: 0 }),
  Object.freeze({ tileIndex: 0, hflip: false, vflip: false, paletteIndex: 0 }),
]);

/** A 16-palette array where every palette has the same single non-zero
 *  RGBA value at index 1. Palette indices 0 stay transparent (0). */
function makePalettes(uniqueRgbaPerSlot: number[]): ReadonlyArray<ReadonlyArray<number>> {
  return uniqueRgbaPerSlot.map((rgba) => {
    const out = new Array(16).fill(0);
    out[1] = rgba;
    return out;
  });
}

function makeFlatSpec(
  tileIndex: number,
  paletteIndex: number,
): { layer0: ReadonlyArray<MetatileSpecRaw>; layer1: ReadonlyArray<MetatileSpecRaw> } {
  const spec: MetatileSpecRaw = { tileIndex, hflip: false, vflip: false, paletteIndex };
  return {
    layer0: [spec, spec, spec, spec],
    layer1: EMPTY_LAYER1,
  };
}

describe('tilesetBoundariesForGameCode', () => {
  it('returns FRLG for BPRE / BPGE', () => {
    expect(tilesetBoundariesForGameCode('BPRE')).toBe(TILESET_BOUNDARIES_FRLG);
    expect(tilesetBoundariesForGameCode('BPGE')).toBe(TILESET_BOUNDARIES_FRLG);
  });
  it('returns RSE for AXVE / AXPE / BPEE', () => {
    expect(tilesetBoundariesForGameCode('AXVE')).toBe(TILESET_BOUNDARIES_RSE);
    expect(tilesetBoundariesForGameCode('AXPE')).toBe(TILESET_BOUNDARIES_RSE);
    expect(tilesetBoundariesForGameCode('BPEE')).toBe(TILESET_BOUNDARIES_RSE);
  });
  it('falls back to FRLG on null / unknown', () => {
    expect(tilesetBoundariesForGameCode(null)).toBe(TILESET_BOUNDARIES_FRLG);
    expect(tilesetBoundariesForGameCode('XXXX')).toBe(TILESET_BOUNDARIES_FRLG);
  });
});

describe('tilesetBoundariesForRom', () => {
  it('derives tile/metatile boundaries but keeps the game-code palette split', () => {
    // Simulate an Unbound/CFRU primary with relocated boundaries:
    // 800 tiles, 800 metatiles, 8 returned palettes (different from vanilla
    // 640/640/7). The backend currently returns a full palette block, so the
    // palette split remains the FRLG runtime boundary.
    const primary = makeTileset({
      tileCount: 800,
      palettes: makePalettes(new Array(8).fill(0xff0000ff)),
      metatileSpecs: new Array(800).fill(0).map(() => makeFlatSpec(0, 0)),
    });
    const boundaries = tilesetBoundariesForRom(primary, 'BPRE');
    expect(boundaries.numTilesInPrimary).toBe(800);
    expect(boundaries.numMetatilesInPrimary).toBe(800);
    expect(boundaries.numPalsInPrimary).toBe(7);
  });
  it('matches vanilla FRLG counts exactly when given a vanilla-shape primary', () => {
    const primary = makeTileset({
      tileCount: 640,
      palettes: makePalettes(new Array(7).fill(0xff0000ff)),
      metatileSpecs: new Array(640).fill(0).map(() => makeFlatSpec(0, 0)),
    });
    const boundaries = tilesetBoundariesForRom(primary, 'BPRE');
    expect(boundaries.numTilesInPrimary).toBe(640);
    expect(boundaries.numMetatilesInPrimary).toBe(640);
    expect(boundaries.numPalsInPrimary).toBe(7);
  });
  it('falls back to game-code defaults when primary is null', () => {
    expect(tilesetBoundariesForRom(null, 'BPRE')).toBe(TILESET_BOUNDARIES_FRLG);
    expect(tilesetBoundariesForRom(null, 'BPEE')).toBe(TILESET_BOUNDARIES_RSE);
    expect(tilesetBoundariesForRom(null, null)).toBe(TILESET_BOUNDARIES_FRLG);
  });
  it('falls back to game-code defaults when primary counts are implausible (zero)', () => {
    const primary = makeTileset({
      tileCount: 0,
      palettes: [],
      metatileSpecs: [],
    });
    expect(tilesetBoundariesForRom(primary, 'BPRE')).toBe(TILESET_BOUNDARIES_FRLG);
  });
  it('does not let the response palette count override the runtime split', () => {
    const primary = makeTileset({
      tileCount: 100,
      palettes: makePalettes(new Array(20).fill(0xff0000ff)),
      metatileSpecs: new Array(100).fill(0).map(() => makeFlatSpec(0, 0)),
    });
    const boundaries = tilesetBoundariesForRom(primary, 'BPRE');
    expect(boundaries.numPalsInPrimary).toBe(7);
  });
});

describe('composeBinaryRomMetatilePixelsDual', () => {
  it('falls back to single-tileset compose when secondary is null', () => {
    // Primary tile 1 paints palette index 1. Palette 0 index 1 = red.
    const red = 0xff0000ff;
    const primary = makeTileset({
      tileCount: 2,
      palettes: makePalettes([red, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
      metatileSpecs: [makeFlatSpec(1, 0)],
    });
    const mapData: BinaryRomMapDataResponseLike = {
      width: 1,
      height: 1,
      cells: [{ metatileId: 0, collision: 0, elevation: 0 }],
    };
    const out = composeBinaryRomMetatilePixelsDual(
      primary,
      null,
      mapData,
      TILESET_BOUNDARIES_FRLG,
    );
    expect(out.size).toBe(1);
    const pixels = out.get(0)!;
    // Every pixel of the 16x16 metatile should be the red color.
    expect(pixels[0]).toBe(red);
    expect(pixels[255]).toBe(red);
  });

  it('routes primary-range metatile IDs to primary specs + tiles', () => {
    const red = 0xff0000ff;
    const blue = 0xffff0000;
    const primary = makeTileset({
      tileCount: 2,
      palettes: makePalettes([red, 0, 0, 0, 0, 0, 0, blue, 0, 0, 0, 0, 0, 0, 0, 0]),
      metatileSpecs: [makeFlatSpec(1, 0)],
    });
    // Secondary's tile 1 (unified index 641) paints palette index 1.
    const secondary = makeTileset({
      tileCount: 2,
      palettes: makePalettes([0, 0, 0, 0, 0, 0, 0, blue, 0, 0, 0, 0, 0, 0, 0, 0]),
      metatileSpecs: [makeFlatSpec(641, 7)],
    });
    const mapData: BinaryRomMapDataResponseLike = {
      width: 1,
      height: 1,
      cells: [{ metatileId: 0, collision: 0, elevation: 0 }], // primary range
    };
    const out = composeBinaryRomMetatilePixelsDual(
      primary,
      secondary,
      mapData,
      TILESET_BOUNDARIES_FRLG,
    );
    const pixels = out.get(0)!;
    // metatileId 0 → primary spec → tile 1, palette 0 → red.
    expect(pixels[0]).toBe(red);
  });

  it('routes secondary-range metatile IDs to secondary specs + tiles', () => {
    const red = 0xff0000ff;
    const blue = 0xffff0000;
    const primary = makeTileset({
      tileCount: 2,
      palettes: makePalettes([red, 0, 0, 0, 0, 0, 0, blue, 0, 0, 0, 0, 0, 0, 0, 0]),
      metatileSpecs: [makeFlatSpec(1, 0)],
    });
    // Secondary's metatile 0 (cell metatileId 640) references unified
    // tile index 641 (= secondary's own tile 1, since tile 0 is the
    // transparent slot reserved for the empty-layer-1 pattern).
    // Phase G-RC1: secondary's palette response is 0-indexed FROM its
    // own ROM block, so its first palette (= runtime slot 7) lives at
    // secondary.palettes[0], not secondary.palettes[7].
    const secondary = makeTileset({
      tileCount: 2,
      palettes: makePalettes([blue, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
      metatileSpecs: [makeFlatSpec(641, 7)],
    });
    const mapData: BinaryRomMapDataResponseLike = {
      width: 1,
      height: 1,
      // Metatile id 640 = secondary-range first metatile.
      cells: [{ metatileId: 640, collision: 0, elevation: 0 }],
    };
    const out = composeBinaryRomMetatilePixelsDual(
      primary,
      secondary,
      mapData,
      TILESET_BOUNDARIES_FRLG,
    );
    const pixels = out.get(640)!;
    // Secondary metatile uses palette 7 (blue).
    expect(pixels[0]).toBe(blue);
  });

  it('takes palettes 0..numPalsInPrimary-1 from primary, rest from secondary', () => {
    const red = 0xff0000ff;
    const green = 0xff00ff00;
    const blue = 0xffff0000;
    // Primary: palette 6 = red.
    // Secondary: palette 6 = blue (should be IGNORED - primary owns 6 in FRLG since
    // numPalsInPrimary=7 means slots 0..6 are primary).
    const primaryPals = new Array(16).fill(0).map((_, i) => {
      const p = new Array(16).fill(0);
      if (i === 6) p[1] = red;
      if (i === 7) p[1] = green; // should NOT be used - primary's slot 7 is past its valid range
      return p;
    });
    // Phase G-RC1: secondary's palette response is indexed FROM 0 in its
    // own ROM block. Its first authoritative palette (= runtime slot 7
    // in FRLG, since numPalsInPrimary=7) lives at secondary[0], NOT
    // secondary[7]. The merged palette logic reads
    // secondary[i - numPalsInPrimary] for i ≥ numPalsInPrimary.
    const secondaryPals = new Array(16).fill(0).map((_, i) => {
      const p = new Array(16).fill(0);
      if (i === 0) p[1] = blue; // SHOULD be used → merged slot 7
      if (i === 7) p[1] = 0xdeadbeef; // garbage past the secondary's real block
      return p;
    });
    const primary = makeTileset({
      tileCount: 2,
      palettes: primaryPals,
      // Both metatiles use the visible tile 1; palettes differ.
      metatileSpecs: [makeFlatSpec(1, 6), makeFlatSpec(1, 7)],
    });
    const secondary = makeTileset({
      tileCount: 2,
      palettes: secondaryPals,
      metatileSpecs: [],
    });
    const mapData: BinaryRomMapDataResponseLike = {
      width: 1,
      height: 2,
      cells: [
        { metatileId: 0, collision: 0, elevation: 0 }, // palette 6 from primary
        { metatileId: 1, collision: 0, elevation: 0 }, // palette 7 from secondary
      ],
    };
    const out = composeBinaryRomMetatilePixelsDual(
      primary,
      secondary,
      mapData,
      TILESET_BOUNDARIES_FRLG,
    );
    expect(out.get(0)![0]).toBe(red); // primary slot 6 wins
    expect(out.get(1)![0]).toBe(blue); // secondary slot 7 wins (primary slot 7 = green ignored)
  });
});

describe('composeBinaryRomMetatilePixels (single-tileset legacy)', () => {
  it('still composes when only one tileset is available', () => {
    const red = 0xff0000ff;
    const primary = makeTileset({
      tileCount: 2,
      palettes: makePalettes([red, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
      metatileSpecs: [makeFlatSpec(1, 0)],
    });
    const mapData: BinaryRomMapDataResponseLike = {
      width: 1,
      height: 1,
      cells: [{ metatileId: 0, collision: 0, elevation: 0 }],
    };
    const out = composeBinaryRomMetatilePixels(primary, mapData);
    expect(out.size).toBe(1);
    expect(out.get(0)![0]).toBe(red);
  });
});

describe('computeMissingMetatiles (Phase T.1)', () => {
  it('returns an empty list when every used metatile id is in the pixels map', () => {
    const pixels = new Map<number, Uint32Array>([
      [0, new Uint32Array(256)],
      [5, new Uint32Array(256)],
    ]);
    const mapData: BinaryRomMapDataResponseLike = {
      width: 2,
      height: 1,
      cells: [
        { metatileId: 0, collision: 0, elevation: 0 },
        { metatileId: 5, collision: 0, elevation: 0 },
      ],
    };
    expect(computeMissingMetatiles(pixels, mapData)).toEqual([]);
  });

  it('surfaces used metatile ids that have no composed pixels (black tiles)', () => {
    const pixels = new Map<number, Uint32Array>([[0, new Uint32Array(256)]]);
    const mapData: BinaryRomMapDataResponseLike = {
      width: 4,
      height: 1,
      cells: [
        { metatileId: 0, collision: 0, elevation: 0 }, // present
        { metatileId: 642, collision: 0, elevation: 0 }, // missing
        { metatileId: 1023, collision: 0, elevation: 0 }, // missing
        { metatileId: 642, collision: 0, elevation: 0 }, // duplicate; dedup
      ],
    };
    expect(computeMissingMetatiles(pixels, mapData)).toEqual([642, 1023]);
  });

  it('returns ids in ascending order regardless of map iteration order', () => {
    const pixels = new Map<number, Uint32Array>();
    const mapData: BinaryRomMapDataResponseLike = {
      width: 3,
      height: 1,
      cells: [
        { metatileId: 99, collision: 0, elevation: 0 },
        { metatileId: 1, collision: 0, elevation: 0 },
        { metatileId: 50, collision: 0, elevation: 0 },
      ],
    };
    expect(computeMissingMetatiles(pixels, mapData)).toEqual([1, 50, 99]);
  });
});
