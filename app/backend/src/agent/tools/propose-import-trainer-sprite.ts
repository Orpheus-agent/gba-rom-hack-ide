/**
 * propose_import_trainer_sprite - Phase 3.15.
 *
 * Imports a 64×64 trainer battle-front sprite (8×8 tiles = 64 tiles).
 * Mirrors propose_import_overworld_sprite but with the 64×64
 * dimensional check + LZ77 compression defaulting to true (trainer
 * sprites are typically compressed in vanilla).
 *
 * Returns the allocated tile + palette offsets. The agent wires
 * them into gTrainerFrontPicTable / gTrainerFrontPicPaletteTable
 * via a follow-up propose_patch (the trainer-pic tables are class-
 * indexed; the agent picks which class slot to reuse or extend).
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

export const PROPOSE_IMPORT_TRAINER_SPRITE_TOOL_NAME = 'propose_import_trainer_sprite';

export const PROPOSE_IMPORT_TRAINER_SPRITE_DESCRIPTION =
  'Import a 64×64 trainer battle-front sprite into fresh ROM space.\n\n' +
  'Inputs:\n' +
  '  - `mode`: \'png\' | \'clone\' | \'auto\'.\n' +
  '  - `pngPath` (png mode): PNG must be exactly 64×64.\n' +
  '  - `sourceTrainerTilesOffset` / `sourceTrainerPaletteOffset`\n' +
  '    (clone mode).\n' +
  '  - `sourceCompressed` (clone): true if source is LZ77.\n' +
  '  - `recolorMap` (clone): optional [oldBgr555, newBgr555] tuples.\n' +
  '  - `compress`: default true (vanilla trainer pics are compressed).\n\n' +
  'Returns tile + palette file offsets so the agent can wire them into\n' +
  'gTrainerFrontPicTable / gTrainerFrontPicPaletteTable.';

const u32 = z.number().int().min(0);
const u16 = z.number().int().min(0).max(0xffff);

export const proposeImportTrainerSpriteInputShape = {
  mode: z.enum(['png', 'clone', 'auto']),
  pngPath: z.string().optional(),
  sourceTrainerTilesOffset: u32.optional(),
  sourceTrainerPaletteOffset: u32.optional(),
  sourceCompressed: z.boolean().optional(),
  recolorMap: z.array(z.tuple([u16, u16])).max(16).optional(),
  compress: z.boolean().optional(),
  description: z.string().max(500).optional(),
} as const;

export interface ProposeImportTrainerSpriteResult {
  readonly proposal: AgentPatchProposal | null;
  readonly tilesOffset: number | null;
  readonly paletteOffset: number | null;
  readonly tileCount: number;
  readonly compressedBytes: number | null;
  readonly message: string;
}

function emptyResult(message: string): ProposeImportTrainerSpriteResult {
  return { proposal: null, tilesOffset: null, paletteOffset: null, tileCount: 0, compressedBytes: null, message };
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

export async function proposeImportTrainerSprite(
  ctx: ToolContext,
  args: {
    mode: 'png' | 'clone' | 'auto';
    pngPath?: string;
    sourceTrainerTilesOffset?: number;
    sourceTrainerPaletteOffset?: number;
    sourceCompressed?: boolean;
    recolorMap?: Array<readonly [number, number]>;
    compress?: boolean;
    description?: string;
  },
  deps: { fetchFn?: typeof fetch } = {},
): Promise<ProposeImportTrainerSpriteResult> {
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
        expectedSize: { widthPx: 64, heightPx: 64 },
      });
    } else if (args.mode === 'clone' || args.mode === 'auto') {
      if (args.sourceTrainerTilesOffset === undefined || args.sourceTrainerPaletteOffset === undefined) {
        return emptyResult('clone mode requires sourceTrainerTilesOffset + sourceTrainerPaletteOffset');
      }
      const recolorMap = new Map<number, number>();
      if (args.recolorMap) for (const [f, t] of args.recolorMap) recolorMap.set(f, t);
      prepared = prepareSpriteFromClone({
        romBytes: new Uint8Array(rom.bytes),
        sourceTilesOffset: args.sourceTrainerTilesOffset,
        sourcePaletteOffset: args.sourceTrainerPaletteOffset,
        tileCount: 64, // 8×8 = 64 tiles
        sourceCompressed: args.sourceCompressed ?? true,
        compress: args.compress ?? true,
        recolorMap,
      });
    } else {
      return emptyResult('mode must be png/clone/auto');
    }
  } catch (e) {
    if (e instanceof SpriteImportError) return emptyResult(`Sprite import failed: ${e.message}`);
    return emptyResult(`Sprite import failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  const romBytes = new Uint8Array(rom.bytes);
  const tileBytes = prepared.tilesCompressed ?? prepared.tilesUncompressed;
  const tilesAlloc = romApi.findFreeRomSpace(romBytes, tileBytes.length);
  if (!tilesAlloc) return emptyResult(`No free ROM space for ${String(tileBytes.length)} tile bytes.`);
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
      note: `Trainer sprite tiles (${prepared.tilesCompressed ? 'LZ77' : 'raw'}, 64 tiles)`,
    } satisfies BinaryWriteBytesEdit,
    {
      kind: 'binary_write_bytes',
      offset: paletteAlloc.offset,
      beforeBytes: bytesToHex(new Uint8Array(prepared.palette.length).fill(0xff)),
      afterBytes: bytesToHex(prepared.palette),
      requireFreeSlot: true,
      note: 'Trainer sprite palette',
    } satisfies BinaryWriteBytesEdit,
  ];

  const description = args.description ?? `Import trainer sprite (${args.mode}): 64×64 + palette`;
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
    message: `Trainer sprite imported: tiles @0x${tilesAlloc.offset.toString(16)}, palette @0x${paletteAlloc.offset.toString(16)}. Wire into gTrainerFrontPicTable via propose_patch.`,
  };
}
