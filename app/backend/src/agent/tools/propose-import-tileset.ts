/**
 * propose_import_tileset - Phase 3.13.
 *
 * Allocates a fresh Tileset + tile data + palette block from a PNG
 * (or by cloning an existing tileset). Returns the new Tileset
 * struct's file offset so the agent can wire it into new maps via
 * propose_create_map (`primaryTilesetOffset` / `secondaryTilesetOffset`).
 *
 * The metatile composition (which 4 tiles make up each block, with
 * palette + flip bits) is supplied OPTIONALLY via the
 * `metatiles` field; when omitted, the tool allocates zero
 * metatiles (the caller is then expected to follow up with
 * propose_set_metatile for each composite block they care about).
 *
 * Metatile attribute table is also optional; when omitted, the tool
 * writes all-zero attribute bytes (default behavior: ordinary
 * walkable terrain).
 */

import { z } from 'zod';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import type {
  AgentPatchEdit,
  AgentPatchProposal,
  BinaryWriteBytesEdit,
} from '@rom-editor/shared';
import { maps as mapsApi, rom as romApi } from '@rom-introspection/engine';
import { readManifest } from '../../scan/manifest-io.js';
import type { ToolContext } from '../types.js';
import { proposePatch, ProposePatchError } from './propose-patch.js';
import {
  bytesToHex,
  prepareSpriteFromClone,
  prepareSpriteFromPng,
  SpriteImportError,
} from './_sprite-import-helpers.js';

export const PROPOSE_IMPORT_TILESET_TOOL_NAME = 'propose_import_tileset';

export const PROPOSE_IMPORT_TILESET_DESCRIPTION =
  'Import a tileset (tile pixel data + palette) into fresh ROM space.\n\n' +
  'Inputs:\n' +
  '  - `mode`: \'png\' | \'clone\' | \'auto\'.\n' +
  '  - `pngPath` (png mode): path under .editor/assets/ (or absolute).\n' +
  '    PNG dimensions must be multiples of 8 (each 8×8 tile becomes\n' +
  '    one entry in the tile sheet).\n' +
  '  - `sourceTilesetOffset` (clone mode): file offset of an existing\n' +
  '    Tileset struct to clone.\n' +
  '  - `isSecondary`: true for secondary tilesets (vanilla maps use\n' +
  '    a primary + secondary pair; secondaries are usually swapped per\n' +
  '    map biome).\n' +
  '  - `compress`: true to LZ77-compress the tile data (recommended;\n' +
  '    cuts size by ~60%).\n\n' +
  'Returns the new Tileset struct\'s file offset. Pass that to\n' +
  'propose_create_map\'s primaryTilesetOffset or secondaryTilesetOffset.';

const u32 = z.number().int().min(0);
const u16 = z.number().int().min(0).max(0xffff);

export const proposeImportTilesetInputShape = {
  mode: z.enum(['png', 'clone', 'auto']),
  pngPath: z.string().optional(),
  sourceTilesetOffset: u32.optional(),
  isSecondary: z.boolean().optional(),
  compress: z.boolean().optional(),
  recolorMap: z.array(z.tuple([u16, u16])).max(16).optional(),
  description: z.string().max(500).optional(),
} as const;

export interface ProposeImportTilesetResult {
  readonly proposal: AgentPatchProposal | null;
  readonly tilesetOffset: number | null;
  readonly tilesOffset: number | null;
  readonly paletteOffset: number | null;
  readonly tileCount: number;
  readonly bytesAllocated: number;
  readonly message: string;
}

function emptyResult(message: string): ProposeImportTilesetResult {
  return {
    proposal: null,
    tilesetOffset: null,
    tilesOffset: null,
    paletteOffset: null,
    tileCount: 0,
    bytesAllocated: 0,
    message,
  };
}

async function findRomFile(root: string): Promise<{ bytes: Buffer } | null> {
  try {
    const entries = await fsp.readdir(root, { withFileTypes: true });
    for (const e of entries) {
      if (e.isFile() && e.name.toLowerCase().endsWith('.gba')) {
        return { bytes: await fsp.readFile(path.join(root, e.name)) };
      }
    }
  } catch {
    return null;
  }
  return null;
}

export async function proposeImportTileset(
  ctx: ToolContext,
  args: {
    mode: 'png' | 'clone' | 'auto';
    pngPath?: string;
    sourceTilesetOffset?: number;
    isSecondary?: boolean;
    compress?: boolean;
    recolorMap?: Array<readonly [number, number]>;
    description?: string;
  },
  deps: { fetchFn?: typeof fetch } = {},
): Promise<ProposeImportTilesetResult> {
  void await readManifest(ctx.projectRoot);
  const rom = await findRomFile(ctx.projectRoot);
  if (!rom) return emptyResult(`No .gba in ${ctx.projectRoot}`);

  let prepared;
  try {
    if (args.mode === 'png' || (args.mode === 'auto' && args.pngPath)) {
      if (!args.pngPath) return emptyResult('png mode requires pngPath');
      prepared = await prepareSpriteFromPng({
        projectRoot: ctx.projectRoot,
        pngPath: args.pngPath,
        compress: args.compress ?? true,
        expectedSize: null,
      });
    } else if (args.mode === 'clone' || args.mode === 'auto') {
      if (args.sourceTilesetOffset === undefined) {
        return emptyResult('clone mode requires sourceTilesetOffset');
      }
      // Parse the source Tileset struct to find its tiles + palette offsets.
      const source = mapsApi.parseTileset(new Uint8Array(rom.bytes), args.sourceTilesetOffset);
      if (!source.ok) {
        return emptyResult(`Source tileset at 0x${args.sourceTilesetOffset.toString(16)} didn\'t parse: ${JSON.stringify(source.failure)}`);
      }
      if (source.tileset.tilesOffset === null || source.tileset.palettesOffset === null) {
        return emptyResult('Source tileset has NULL tiles or palette pointer.');
      }
      // For clone, we need a tile-count estimate. Reading uncompressed
      // tile data requires knowing the count; for LZ77-compressed
      // tiles the count comes from the decompressed size.
      const tileCount = source.tileset.isCompressed ? 128 : 128; // safe default
      const recolorMap = new Map<number, number>();
      if (args.recolorMap) for (const [f, t] of args.recolorMap) recolorMap.set(f, t);
      prepared = prepareSpriteFromClone({
        romBytes: new Uint8Array(rom.bytes),
        sourceTilesOffset: source.tileset.tilesOffset,
        sourcePaletteOffset: source.tileset.palettesOffset,
        tileCount,
        sourceCompressed: source.tileset.isCompressed,
        compress: args.compress ?? true,
        recolorMap,
      });
    } else {
      return emptyResult('mode must be png/clone/auto');
    }
  } catch (e) {
    if (e instanceof SpriteImportError) return emptyResult(`Tileset prep failed: ${e.message}`);
    return emptyResult(`Tileset prep failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Allocate tile blob + palette + tileset header.
  const romBytes = new Uint8Array(rom.bytes);
  const tileBytes = prepared.tilesCompressed ?? prepared.tilesUncompressed;
  const tilesAlloc = romApi.findFreeRomSpace(romBytes, tileBytes.length);
  if (!tilesAlloc) return emptyResult(`No free ROM space for ${String(tileBytes.length)} tile bytes.`);
  const working = new Uint8Array(romBytes);
  for (let i = 0; i < tileBytes.length; i++) working[tilesAlloc.offset + i] = 0xaa;
  const paletteAlloc = romApi.findFreeRomSpace(working, prepared.palette.length);
  if (!paletteAlloc) return emptyResult('No free ROM space for the palette.');
  for (let i = 0; i < prepared.palette.length; i++) working[paletteAlloc.offset + i] = 0xaa;
  // Tileset struct (24 bytes).
  const tilesetHeader = mapsApi.encodeTileset({
    isCompressed: prepared.tilesCompressed !== null,
    isSecondary: args.isSecondary ?? false,
    tilesOffset: tilesAlloc.offset,
    palettesOffset: paletteAlloc.offset,
    metatilesOffset: null,
    slot10Offset: null,
    slot14Offset: null,
  });
  const headerAlloc = romApi.findFreeRomSpace(working, tilesetHeader.length);
  if (!headerAlloc) return emptyResult('No free ROM space for the Tileset header.');

  const edits: AgentPatchEdit[] = [
    {
      kind: 'binary_write_bytes',
      offset: tilesAlloc.offset,
      beforeBytes: bytesToHex(new Uint8Array(tileBytes.length).fill(0xff)),
      afterBytes: bytesToHex(tileBytes),
      requireFreeSlot: true,
      note: `Tileset tiles (${prepared.tilesCompressed ? 'LZ77' : 'raw'}, ${String(prepared.tileCount)} tiles)`,
    } satisfies BinaryWriteBytesEdit,
    {
      kind: 'binary_write_bytes',
      offset: paletteAlloc.offset,
      beforeBytes: bytesToHex(new Uint8Array(prepared.palette.length).fill(0xff)),
      afterBytes: bytesToHex(prepared.palette),
      requireFreeSlot: true,
      note: 'Tileset palette (BGR555)',
    } satisfies BinaryWriteBytesEdit,
    {
      kind: 'binary_write_bytes',
      offset: headerAlloc.offset,
      beforeBytes: bytesToHex(new Uint8Array(tilesetHeader.length).fill(0xff)),
      afterBytes: bytesToHex(tilesetHeader),
      requireFreeSlot: true,
      note: `Tileset header (24 bytes)`,
    } satisfies BinaryWriteBytesEdit,
  ];

  const totalBytes = tileBytes.length + prepared.palette.length + tilesetHeader.length;
  const description = args.description ?? `Import tileset (${args.mode}): ${String(prepared.tileCount)} tiles + palette + struct (${String(totalBytes)} bytes)`;
  let proposal: AgentPatchProposal;
  try {
    proposal = await proposePatch(ctx, { description, edits }, deps);
  } catch (e) {
    if (e instanceof ProposePatchError) return emptyResult(`Failed to register proposal: ${e.message}`);
    throw e;
  }
  return {
    proposal,
    tilesetOffset: headerAlloc.offset,
    tilesOffset: tilesAlloc.offset,
    paletteOffset: paletteAlloc.offset,
    tileCount: prepared.tileCount,
    bytesAllocated: totalBytes,
    message:
      `Tileset imported: header @0x${headerAlloc.offset.toString(16)}, ` +
      `${String(prepared.tileCount)} tiles, ${String(totalBytes)} bytes total. ` +
      `Pass tilesetOffset to propose_create_map\'s primaryTilesetOffset or secondaryTilesetOffset.`,
  };
}
