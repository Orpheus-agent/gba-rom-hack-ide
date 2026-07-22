/**
 * Phase 8A-1 - Zod runtime schema for the Tile-Intel IR.
 *
 * The TypeScript interfaces in `@rom-editor/shared/tile-intel-ir`
 * describe the IR statically; this file describes it at runtime.
 * Used by:
 *   • the corpus builder (`scripts/build-tile-intel-corpus.mjs`) to
 *     validate its own output before writing - catches authoring
 *     bugs that would otherwise surface only on Python ingest.
 *   • the eventual `POST /v1/ingest/json-corpus` Node-side wrapper
 *     when it streams IR to the sidecar.
 *   • a CI parity check (Phase 8A-3) that diffs this schema's JSON
 *     Schema export against the Pydantic-generated JSON Schema in
 *     `tile-intel-svc/`.
 *
 * Keep this file in lock-step with `tile-intel-ir.ts`. The unit test
 * (`ir-schema.test.ts`) round-trips a hand-crafted example to
 * verify shape parity.
 */

import { z } from 'zod';
import type {
  TileIntelIRCorpus,
  TileIntelIRSource,
  TileIntelIRFamily,
  TileIntelIRDirection,
} from '@rom-editor/shared';

/** A non-empty lowercase hex string (any length, any even count of
 *  hex chars, no whitespace). The corpus builder always writes hex
 *  lowercase. */
const hexString = z
  .string()
  .regex(/^[0-9a-f]+$/u, 'expected lowercase hex string');

/** A non-empty lowercase hex string with EXACTLY 64 chars (sha256). */
const sha256Hex = z
  .string()
  .length(64)
  .regex(/^[0-9a-f]+$/u, 'expected 64-char lowercase sha256 hex');

/** An 8-char hex pHash (representing a u64). */
const phashHex = z
  .string()
  .length(16)
  .regex(/^[0-9a-f]+$/u, 'expected 16-char lowercase u64 hex');

const irSource: z.ZodType<TileIntelIRSource> = z.enum([
  'pret-firered',
  'pret-emerald',
  'cfru',
  'dpe',
  'essentials',
  'community',
  'user',
]);

const irFamily: z.ZodType<TileIntelIRFamily> = z.enum([
  'frlg',
  'rse',
  // Phase 8E - non-gen3 communities (atomic tiles, empty composition).
  'essentials',
  'community',
]);

const irDirection: z.ZodType<TileIntelIRDirection> = z.union([
  z.literal(0),
  z.literal(1),
  z.literal(2),
  z.literal(3),
  z.literal(4),
  z.literal(5),
  z.literal(6),
  z.literal(7),
]);

const irMetatileSlot = z.object({
  layer: z.union([z.literal(0), z.literal(1)]),
  quad: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]),
  tileIndex: z.number().int().min(0).max(0x3ff),
  hflip: z.boolean(),
  vflip: z.boolean(),
  paletteIndex: z.number().int().min(0).max(15),
});

const irMetatile = z.object({
  metatileIndex: z.number().int().min(0).max(0x3ff),
  attrRawHex: hexString,
  behaviorId: z.number().int().min(0).max(0x1ff),
  terrainType: z.number().int().min(0).max(0x1f),
  encounterType: z.number().int().min(0).max(0x7),
  layerType: z.number().int().min(0).max(0x3),
  // Either empty (Phase 8E atomic non-gen3 tile) or exactly 8 slots
  // (gen-3 2-layer × 4-quad composition).
  composition: z
    .array(irMetatileSlot)
    .max(8)
    .refine((arr) => arr.length === 0 || arr.length === 8, {
      message: 'composition must be empty (atomic) or exactly 8 slots (gen-3)',
    }),
  renderedHashHex: sha256Hex,
  phashHex,
});

const irTile = z.object({
  tileIndex: z.number().int().min(0).max(0x3ff),
  // 64 bytes palette-indexed = 128 hex chars
  pixelBytesHex: z.string().length(128).regex(/^[0-9a-f]+$/u),
  pixelHashHex: sha256Hex,
  paletteNeutralHashHex: sha256Hex,
  phashHex,
  isBlank: z.boolean(),
  isHorizontallySymmetric: z.boolean(),
  isVerticallySymmetric: z.boolean(),
});

const irPalette = z.object({
  paletteIndex: z.number().int().min(0).max(15),
  // 32 bytes BGR555 = 64 hex chars
  bgr555Hex: z.string().length(64).regex(/^[0-9a-f]+$/u),
  medianCut5: z
    .array(z.string().regex(/^#[0-9a-f]{6}$/iu))
    .min(1)
    .max(5),
  dominantHue: z.number().int().min(0).max(359).nullable(),
  luminanceAvg: z.number().int().min(0).max(255),
});

const irTileset = z.object({
  slug: z
    .string()
    .min(1)
    .max(120)
    .regex(
      /^[a-z0-9][a-z0-9_-]*$/u,
      'slug must be lowercase, alphanumeric + hyphens + underscores, starting with letter or digit',
    ),
  displayName: z.string().min(1).max(200),
  source: irSource,
  sourceCommit: z.string().min(7).max(64).nullable(),
  attribution: z.string().min(1).max(500),
  licenseSpdx: z.string().min(1).max(64),
  family: irFamily,
  isSecondary: z.boolean(),
  isCompressed: z.boolean(),
  tileCount: z.number().int().min(0).max(0x400),
  metatileCount: z.number().int().min(0).max(0x400),
  palettes: z.array(irPalette).max(16),
  tiles: z.array(irTile).max(0x400),
  metatiles: z.array(irMetatile).max(0x400),
});

const irAdjacencyObservation = z.object({
  tilesetSlugA: z.string().min(1).max(120),
  metatileIndexA: z.number().int().min(0).max(0x3ff),
  tilesetSlugB: z.string().min(1).max(120),
  metatileIndexB: z.number().int().min(0).max(0x3ff),
  direction: irDirection,
  frequency: z.number().int().min(1).max(1_000_000),
});

const irPatternCell = z.object({
  tilesetSlug: z.string().min(1).max(120),
  metatileIndex: z.number().int().min(0).max(0x3ff),
});

const irPattern = z.object({
  shape: z.literal('3x3'),
  width: z.number().int().min(1).max(8),
  height: z.number().int().min(1).max(8),
  cells: z.array(irPatternCell),
  frequency: z.number().int().min(1).max(1_000_000),
});

const irMapAdjacency = z.object({
  mapSlug: z.string().min(1).max(200),
  primaryTilesetSlug: z.string().min(1).max(120),
  secondaryTilesetSlug: z.string().min(1).max(120),
  width: z.number().int().min(1).max(1024),
  height: z.number().int().min(1).max(1024),
  observations: z.array(irAdjacencyObservation),
  patterns: z.array(irPattern).optional(),
});

/** Top-level corpus schema. Keep this exported - `irCorpusSchema.parse()`
 *  is the single entry point used by the corpus builder + ingest path. */
export const irCorpusSchema = z.object({
  schemaVersion: z.literal(1),
  generatedAtUtc: z.string().datetime({ offset: false }),
  source: irSource,
  toolingVersion: z.string().min(1).max(64),
  tilesets: z.array(irTileset),
  mapAdjacencies: z.array(irMapAdjacency),
}) satisfies z.ZodType<TileIntelIRCorpus>;

/** Convenience parser. Throws z.ZodError on invalid input. */
export function parseIRCorpus(value: unknown): TileIntelIRCorpus {
  return irCorpusSchema.parse(value) as TileIntelIRCorpus;
}

/** Lenient validator - returns SafeParseReturnType so the caller can
 *  surface multi-error reports without throwing. */
export function safeParseIRCorpus(value: unknown) {
  return irCorpusSchema.safeParse(value);
}

/** Construct an empty IR corpus (no tilesets, no maps) for the named
 *  source. Used by the corpus-builder skeleton and by tests. */
export function emptyIRCorpus(
  source: TileIntelIRSource,
  toolingVersion: string,
  generatedAtUtc: string = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
): TileIntelIRCorpus {
  return {
    schemaVersion: 1,
    generatedAtUtc,
    source,
    toolingVersion,
    tilesets: [],
    mapAdjacencies: [],
  };
}
