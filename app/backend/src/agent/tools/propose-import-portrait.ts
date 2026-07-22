/**
 * propose_import_portrait - Phase 3.16.
 *
 * Imports a 32×32 portrait / mugshot (16 tiles) used in pre-battle
 * cutscenes (Elite Four, gym leader intros) + in CFRU's dialogue
 * portrait system if the user has it enabled.
 *
 * Same machinery as the trainer-sprite tool, smaller dimensions
 * + LZ77 compression defaulting to true.
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
import type { ToolContext } from '../types.js';
import { proposePatch, ProposePatchError } from './propose-patch.js';
import {
  bytesToHex,
  prepareSpriteFromClone,
  prepareSpriteFromPng,
  SpriteImportError,
} from './_sprite-import-helpers.js';

export const PROPOSE_IMPORT_PORTRAIT_TOOL_NAME = 'propose_import_portrait';

export const PROPOSE_IMPORT_PORTRAIT_DESCRIPTION =
  'Import a 32×32 portrait / mugshot. Used by pre-battle intros + the\n' +
  'CFRU portrait dialogue system when enabled.\n\n' +
  'Inputs:\n' +
  '  - `mode`: \'png\' | \'clone\' | \'auto\'.\n' +
  '  - `pngPath` (png mode): PNG must be exactly 32×32.\n' +
  '  - `sourcePortraitTilesOffset` / `sourcePortraitPaletteOffset`\n' +
  '    (clone mode).\n' +
  '  - `sourceCompressed` (clone): true if source is LZ77.\n' +
  '  - `recolorMap` (clone): optional.\n' +
  '  - `compress`: default true.\n\n' +
  'Returns the tile + palette file offsets so the agent can wire them\n' +
  'into the portrait pointer table.';

const u32 = z.number().int().min(0);
const u16 = z.number().int().min(0).max(0xffff);

export const proposeImportPortraitInputShape = {
  mode: z.enum(['png', 'clone', 'auto']),
  pngPath: z.string().optional(),
  sourcePortraitTilesOffset: u32.optional(),
  sourcePortraitPaletteOffset: u32.optional(),
  sourceCompressed: z.boolean().optional(),
  recolorMap: z.array(z.tuple([u16, u16])).max(16).optional(),
  compress: z.boolean().optional(),
  description: z.string().max(500).optional(),
} as const;

export interface ProposeImportPortraitResult {
  readonly proposal: AgentPatchProposal | null;
  readonly tilesOffset: number | null;
  readonly paletteOffset: number | null;
  readonly tileCount: number;
  readonly message: string;
}

function emptyResult(message: string): ProposeImportPortraitResult {
  return { proposal: null, tilesOffset: null, paletteOffset: null, tileCount: 0, message };
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

export async function proposeImportPortrait(
  ctx: ToolContext,
  args: {
    mode: 'png' | 'clone' | 'auto';
    pngPath?: string;
    sourcePortraitTilesOffset?: number;
    sourcePortraitPaletteOffset?: number;
    sourceCompressed?: boolean;
    recolorMap?: Array<readonly [number, number]>;
    compress?: boolean;
    description?: string;
  },
  deps: { fetchFn?: typeof fetch } = {},
): Promise<ProposeImportPortraitResult> {
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
        expectedSize: { widthPx: 32, heightPx: 32 },
      });
    } else if (args.mode === 'clone' || args.mode === 'auto') {
      if (args.sourcePortraitTilesOffset === undefined || args.sourcePortraitPaletteOffset === undefined) {
        return emptyResult('clone mode requires sourcePortraitTilesOffset + sourcePortraitPaletteOffset');
      }
      const recolorMap = new Map<number, number>();
      if (args.recolorMap) for (const [f, t] of args.recolorMap) recolorMap.set(f, t);
      prepared = prepareSpriteFromClone({
        romBytes: new Uint8Array(rom.bytes),
        sourceTilesOffset: args.sourcePortraitTilesOffset,
        sourcePaletteOffset: args.sourcePortraitPaletteOffset,
        tileCount: 16,
        sourceCompressed: args.sourceCompressed ?? true,
        compress: args.compress ?? true,
        recolorMap,
      });
    } else {
      return emptyResult('mode must be png/clone/auto');
    }
  } catch (e) {
    if (e instanceof SpriteImportError) return emptyResult(`Portrait import failed: ${e.message}`);
    return emptyResult(`Portrait import failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  const romBytes = new Uint8Array(rom.bytes);
  const tileBytes = prepared.tilesCompressed ?? prepared.tilesUncompressed;
  const tilesAlloc = romApi.findFreeRomSpace(romBytes, tileBytes.length);
  if (!tilesAlloc) return emptyResult('No free ROM space for tiles.');
  const working = new Uint8Array(romBytes);
  for (let i = 0; i < tileBytes.length; i++) working[tilesAlloc.offset + i] = 0xaa;
  const paletteAlloc = romApi.findFreeRomSpace(working, prepared.palette.length);
  if (!paletteAlloc) return emptyResult('No free ROM space for palette.');

  const edits: AgentPatchEdit[] = [
    {
      kind: 'binary_write_bytes',
      offset: tilesAlloc.offset,
      beforeBytes: bytesToHex(new Uint8Array(tileBytes.length).fill(0xff)),
      afterBytes: bytesToHex(tileBytes),
      requireFreeSlot: true,
      note: `Portrait tiles (${prepared.tilesCompressed ? 'LZ77' : 'raw'}, 16 tiles)`,
    } satisfies BinaryWriteBytesEdit,
    {
      kind: 'binary_write_bytes',
      offset: paletteAlloc.offset,
      beforeBytes: bytesToHex(new Uint8Array(prepared.palette.length).fill(0xff)),
      afterBytes: bytesToHex(prepared.palette),
      requireFreeSlot: true,
      note: 'Portrait palette',
    } satisfies BinaryWriteBytesEdit,
  ];

  const description = args.description ?? `Import portrait (${args.mode}): 32×32 + palette`;
  let proposal: AgentPatchProposal;
  try {
    proposal = await proposePatch(ctx, { description, edits }, deps);
  } catch (e) {
    if (e instanceof ProposePatchError) return emptyResult(`Failed: ${e.message}`);
    throw e;
  }
  return {
    proposal,
    tilesOffset: tilesAlloc.offset,
    paletteOffset: paletteAlloc.offset,
    tileCount: prepared.tileCount,
    message: `Portrait imported: tiles @0x${tilesAlloc.offset.toString(16)}, palette @0x${paletteAlloc.offset.toString(16)}.`,
  };
}
