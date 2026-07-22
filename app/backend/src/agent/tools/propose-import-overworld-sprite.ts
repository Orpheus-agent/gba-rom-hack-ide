/**
 * propose_import_overworld_sprite - Phase 3.14.
 *
 * Imports a 16×16 (4-frame walking sprite) overworld character into
 * fresh ROM space + (for first cut) returns the allocated bytes +
 * pointer offsets so the agent can WIRE them into
 * gObjectEventGraphicsInfoPointers manually via propose_patch.
 *
 * Full table-grow integration (replacing or appending a slot in the
 * pointer table) is deferred to phase 3.14b - the gObjectEvent
 * GraphicsInfo struct is variable-length and the safe path is for
 * the agent to compose the final stitch.
 */

import { z } from 'zod';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import type {
  AgentPatchEdit,
  AgentPatchProposal,
  BinaryWriteBytesEdit,
} from '@rom-editor/shared';
import { rom as romApi } from '@rom-introspection/engine';
import { readManifest } from '../../scan/manifest-io.js';
import type { ToolContext } from '../types.js';
import { proposePatch, ProposePatchError } from './propose-patch.js';
import {
  bytesToHex,
  prepareSpriteFromClone,
  prepareSpriteFromPng,
  SpriteImportError,
} from './_sprite-import-helpers.js';

export const PROPOSE_IMPORT_OVERWORLD_SPRITE_TOOL_NAME = 'propose_import_overworld_sprite';

export const PROPOSE_IMPORT_OVERWORLD_SPRITE_DESCRIPTION =
  'Import an overworld sprite (4-frame walking animation, 16×16 each).\n\n' +
  'Inputs:\n' +
  '  - `mode`: \'png\' | \'clone\' | \'auto\'.\n' +
  '  - `pngPath` (png mode): path relative to .editor/assets/ OR\n' +
  '    absolute. Expected layout: 4-frame sprite sheet, 16 wide × 64\n' +
  '    tall (4 frames stacked) for a single direction; OR 64 wide × 16\n' +
  '    tall (4 frames side by side).\n' +
  '  - `sourceSpriteTilesOffset` (clone mode): file offset of the\n' +
  '    source sprite\'s tile data.\n' +
  '  - `sourceSpritePaletteOffset` (clone mode): file offset of the\n' +
  '    palette.\n' +
  '  - `sourceTileCount` (clone mode): number of tiles to copy.\n' +
  '  - `sourceCompressed` (clone mode): true if source is LZ77.\n' +
  '  - `recolorMap` (clone mode): optional list of\n' +
  '    {oldBgr555, newBgr555} replacements.\n' +
  '  - `compress`: true to LZ77 the output tiles (CFRU OW sprites are\n' +
  '    typically uncompressed; default false).\n\n' +
  'Returns the allocated tilesOffset + paletteOffset so the agent can\n' +
  'wire them into gObjectEventGraphicsInfoPointers via a follow-up\n' +
  'propose_patch.';

const u32 = z.number().int().min(0);
const u16 = z.number().int().min(0).max(0xffff);

export const proposeImportOverworldSpriteInputShape = {
  mode: z.enum(['png', 'clone', 'auto']),
  pngPath: z.string().optional(),
  sourceSpriteTilesOffset: u32.optional(),
  sourceSpritePaletteOffset: u32.optional(),
  sourceTileCount: z.number().int().min(1).max(64).optional(),
  sourceCompressed: z.boolean().optional(),
  recolorMap: z.array(z.tuple([u16, u16])).max(16).optional(),
  compress: z.boolean().optional(),
  description: z.string().max(500).optional(),
} as const;

export interface ProposeImportOverworldSpriteResult {
  readonly proposal: AgentPatchProposal | null;
  readonly tilesOffset: number | null;
  readonly paletteOffset: number | null;
  readonly tileCount: number;
  readonly compressedBytes: number | null;
  readonly uncompressedBytes: number;
  readonly message: string;
}

function emptyResult(message: string): ProposeImportOverworldSpriteResult {
  return {
    proposal: null,
    tilesOffset: null,
    paletteOffset: null,
    tileCount: 0,
    compressedBytes: null,
    uncompressedBytes: 0,
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

export async function proposeImportOverworldSprite(
  ctx: ToolContext,
  args: {
    mode: 'png' | 'clone' | 'auto';
    pngPath?: string;
    sourceSpriteTilesOffset?: number;
    sourceSpritePaletteOffset?: number;
    sourceTileCount?: number;
    sourceCompressed?: boolean;
    recolorMap?: Array<readonly [number, number]>;
    compress?: boolean;
    description?: string;
  },
  deps: { fetchFn?: typeof fetch } = {},
): Promise<ProposeImportOverworldSpriteResult> {
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
        compress: args.compress ?? false,
        expectedSize: null,
      });
    } else if (args.mode === 'clone' || args.mode === 'auto') {
      if (
        args.sourceSpriteTilesOffset === undefined ||
        args.sourceSpritePaletteOffset === undefined ||
        args.sourceTileCount === undefined
      ) {
        return emptyResult('clone mode requires sourceSpriteTilesOffset + sourceSpritePaletteOffset + sourceTileCount');
      }
      const recolorMap = new Map<number, number>();
      if (args.recolorMap) for (const [from, to] of args.recolorMap) recolorMap.set(from, to);
      prepared = prepareSpriteFromClone({
        romBytes: new Uint8Array(rom.bytes),
        sourceTilesOffset: args.sourceSpriteTilesOffset,
        sourcePaletteOffset: args.sourceSpritePaletteOffset,
        tileCount: args.sourceTileCount,
        sourceCompressed: args.sourceCompressed ?? false,
        compress: args.compress ?? false,
        recolorMap,
      });
    } else {
      return emptyResult('mode must be \'png\', \'clone\', or \'auto\'');
    }
  } catch (e) {
    if (e instanceof SpriteImportError) return emptyResult(`Sprite import failed: ${e.message}`);
    return emptyResult(`Sprite import failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Allocate space.
  const romBytes = new Uint8Array(rom.bytes);
  const tileBytes = prepared.tilesCompressed ?? prepared.tilesUncompressed;
  const tilesAlloc = romApi.findFreeRomSpace(romBytes, tileBytes.length);
  if (!tilesAlloc) return emptyResult(`No free ROM space for ${String(tileBytes.length)} tile bytes.`);
  // Mark allocated region to avoid overlap with palette alloc.
  const working = new Uint8Array(romBytes);
  for (let i = 0; i < tileBytes.length; i++) working[tilesAlloc.offset + i] = 0xaa;
  const paletteAlloc = romApi.findFreeRomSpace(working, prepared.palette.length);
  if (!paletteAlloc) return emptyResult('No free ROM space for the palette.');

  const edits: AgentPatchEdit[] = [
    {
      kind: 'binary_write_bytes',
      offset: tilesAlloc.offset,
      beforeBytes: bytesToHex(new Uint8Array(tileBytes.length).fill(0xff)),
      afterBytes: bytesToHex(tileBytes),
      requireFreeSlot: true,
      note: `OW sprite tiles (${prepared.tilesCompressed ? 'LZ77' : 'uncompressed'}, ${String(prepared.tileCount)} tiles)`,
    } satisfies BinaryWriteBytesEdit,
    {
      kind: 'binary_write_bytes',
      offset: paletteAlloc.offset,
      beforeBytes: bytesToHex(new Uint8Array(prepared.palette.length).fill(0xff)),
      afterBytes: bytesToHex(prepared.palette),
      requireFreeSlot: true,
      note: `OW sprite palette (BGR555 × 16 colors)`,
    } satisfies BinaryWriteBytesEdit,
  ];

  const description = args.description ?? `Import overworld sprite (${args.mode}): ${String(prepared.tileCount)} tiles + palette`;
  let proposal: AgentPatchProposal;
  try {
    proposal = await proposePatch(ctx, { description, edits }, deps);
  } catch (e) {
    if (e instanceof ProposePatchError) return emptyResult(`Failed to register proposal: ${e.message}`);
    throw e;
  }
  return {
    proposal,
    tilesOffset: tilesAlloc.offset,
    paletteOffset: paletteAlloc.offset,
    tileCount: prepared.tileCount,
    compressedBytes: prepared.tilesCompressed ? prepared.tilesCompressed.length : null,
    uncompressedBytes: prepared.tilesUncompressed.length,
    message:
      `OW sprite imported: ${String(prepared.tileCount)} tiles @ 0x${tilesAlloc.offset.toString(16)}, palette @ 0x${paletteAlloc.offset.toString(16)}. ` +
      `Wire into gObjectEventGraphicsInfoPointers via propose_patch.`,
  };
}
