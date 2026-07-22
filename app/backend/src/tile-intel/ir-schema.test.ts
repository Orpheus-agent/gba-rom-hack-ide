/**
 * Phase 8A-1 - Tile-Intel IR Zod schema parity tests.
 *
 * Walks the schema on a hand-crafted minimal-and-full example to
 * verify the runtime parser stays in lock-step with the static
 * TypeScript interfaces in `@rom-editor/shared/tile-intel-ir`.
 */

import { describe, expect, it } from 'vitest';
import type {
  TileIntelIRCorpus,
  TileIntelIRMetatile,
  TileIntelIRPalette,
  TileIntelIRTile,
  TileIntelIRTileset,
} from '@rom-editor/shared';
import {
  emptyIRCorpus,
  irCorpusSchema,
  parseIRCorpus,
  safeParseIRCorpus,
} from './ir-schema.js';

const REPEAT_ZERO_64 = '0'.repeat(64); // 32 bytes of 0x00 - valid bgr555Hex
const SHA_256_FIXED = 'a'.repeat(64);
const PHASH_FIXED = 'b'.repeat(16);
const PIXEL_BYTES_FIXED = '0'.repeat(128); // 64 bytes all index 0 (blank)

function makePalette(): TileIntelIRPalette {
  return {
    paletteIndex: 0,
    bgr555Hex: REPEAT_ZERO_64,
    medianCut5: ['#000000'],
    dominantHue: null,
    luminanceAvg: 0,
  };
}

function makeTile(): TileIntelIRTile {
  return {
    tileIndex: 0,
    pixelBytesHex: PIXEL_BYTES_FIXED,
    pixelHashHex: SHA_256_FIXED,
    paletteNeutralHashHex: SHA_256_FIXED,
    phashHex: PHASH_FIXED,
    isBlank: true,
    isHorizontallySymmetric: true,
    isVerticallySymmetric: true,
  };
}

function makeMetatile(): TileIntelIRMetatile {
  return {
    metatileIndex: 0,
    attrRawHex: '00000000',
    behaviorId: 0,
    terrainType: 0,
    encounterType: 0,
    layerType: 0,
    composition: [
      { layer: 0, quad: 0, tileIndex: 0, hflip: false, vflip: false, paletteIndex: 0 },
      { layer: 0, quad: 1, tileIndex: 0, hflip: false, vflip: false, paletteIndex: 0 },
      { layer: 0, quad: 2, tileIndex: 0, hflip: false, vflip: false, paletteIndex: 0 },
      { layer: 0, quad: 3, tileIndex: 0, hflip: false, vflip: false, paletteIndex: 0 },
      { layer: 1, quad: 0, tileIndex: 0, hflip: false, vflip: false, paletteIndex: 0 },
      { layer: 1, quad: 1, tileIndex: 0, hflip: false, vflip: false, paletteIndex: 0 },
      { layer: 1, quad: 2, tileIndex: 0, hflip: false, vflip: false, paletteIndex: 0 },
      { layer: 1, quad: 3, tileIndex: 0, hflip: false, vflip: false, paletteIndex: 0 },
    ],
    renderedHashHex: SHA_256_FIXED,
    phashHex: PHASH_FIXED,
  };
}

function makeTileset(): TileIntelIRTileset {
  return {
    slug: 'pret-frlg-primary-pallet',
    displayName: 'Pallet primary',
    source: 'pret-firered',
    sourceCommit: 'abcdef0123456789',
    attribution: 'Public domain via pret/pokefirered (MIT)',
    licenseSpdx: 'MIT',
    family: 'frlg',
    isSecondary: false,
    isCompressed: true,
    tileCount: 1,
    metatileCount: 1,
    palettes: [makePalette()],
    tiles: [makeTile()],
    metatiles: [makeMetatile()],
  };
}

function makeCorpus(): TileIntelIRCorpus {
  return {
    schemaVersion: 1,
    generatedAtUtc: '2026-05-27T00:00:00Z',
    source: 'pret-firered',
    toolingVersion: '8A-1',
    tilesets: [makeTileset()],
    mapAdjacencies: [
      {
        mapSlug: 'pret-frlg-pallet-town',
        primaryTilesetSlug: 'pret-frlg-primary-pallet',
        secondaryTilesetSlug: 'pret-frlg-secondary-pallet',
        width: 20,
        height: 20,
        observations: [
          {
            tilesetSlugA: 'pret-frlg-primary-pallet',
            metatileIndexA: 0,
            tilesetSlugB: 'pret-frlg-primary-pallet',
            metatileIndexB: 1,
            direction: 2, // east
            frequency: 47,
          },
        ],
      },
    ],
  };
}

describe('tile-intel IR Zod schema', () => {
  it('parses a hand-crafted valid corpus and preserves shape', () => {
    const corpus = makeCorpus();
    const parsed = parseIRCorpus(corpus);
    expect(parsed).toEqual(corpus);
  });

  it('rejects a corpus with the wrong schema version', () => {
    const bad = { ...makeCorpus(), schemaVersion: 2 };
    expect(() => parseIRCorpus(bad)).toThrow();
  });

  it('rejects a metatile with the wrong composition length', () => {
    const corpus = makeCorpus();
    const broken = {
      ...corpus,
      tilesets: [
        {
          ...corpus.tilesets[0]!,
          metatiles: [
            {
              ...corpus.tilesets[0]!.metatiles[0]!,
              composition: corpus.tilesets[0]!.metatiles[0]!.composition.slice(0, 4),
            },
          ],
        },
      ],
    };
    expect(() => parseIRCorpus(broken)).toThrow();
  });

  it('rejects a tile with non-128-char pixelBytesHex', () => {
    const corpus = makeCorpus();
    const broken = {
      ...corpus,
      tilesets: [
        {
          ...corpus.tilesets[0]!,
          tiles: [{ ...corpus.tilesets[0]!.tiles[0]!, pixelBytesHex: '00' }],
        },
      ],
    };
    expect(() => parseIRCorpus(broken)).toThrow();
  });

  it('rejects a slug with uppercase letters', () => {
    const corpus = makeCorpus();
    const broken = {
      ...corpus,
      tilesets: [{ ...corpus.tilesets[0]!, slug: 'Pret-frlg-primary-pallet' }],
    };
    expect(() => parseIRCorpus(broken)).toThrow();
  });

  it('accepts a slug with underscores (matches pret directory names)', () => {
    const corpus = makeCorpus();
    const ok = {
      ...corpus,
      tilesets: [{ ...corpus.tilesets[0]!, slug: 'pret-frlg-secondary-pallet_town' }],
    };
    expect(() => parseIRCorpus(ok)).not.toThrow();
  });

  it('safeParse surfaces structured errors instead of throwing', () => {
    const broken = { ...makeCorpus(), schemaVersion: 99 };
    const result = safeParseIRCorpus(broken);
    expect(result.success).toBe(false);
  });

  it('emptyIRCorpus produces a valid corpus', () => {
    const empty = emptyIRCorpus('pret-firered', 'test');
    expect(empty.tilesets).toHaveLength(0);
    expect(empty.mapAdjacencies).toHaveLength(0);
    expect(irCorpusSchema.safeParse(empty).success).toBe(true);
  });

  it('emptyIRCorpus generates an ISO-8601 timestamp by default', () => {
    const empty = emptyIRCorpus('user', 'test');
    expect(empty.generatedAtUtc).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  });
});
