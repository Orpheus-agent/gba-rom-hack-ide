/**
 * propose_set_border_block - Phase 3.11.
 *
 * Rewrites the 2×2 metatile bezel around a map. Vanilla FRLG borders
 * are 8 bytes (4 × u16). Border bytes are written in place; the
 * borderBlocks array doesn't change size.
 */

import { z } from 'zod';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import type {
  AgentPatchEdit,
  AgentPatchProposal,
  BinaryWriteBytesEdit,
} from '@rom-editor/shared';
import { maps as mapsApi } from '@rom-introspection/engine';
import { readManifest } from '../../scan/manifest-io.js';
import type { ToolContext } from '../types.js';
import { proposePatch, ProposePatchError } from './propose-patch.js';

export const PROPOSE_SET_BORDER_BLOCK_TOOL_NAME = 'propose_set_border_block';

export const PROPOSE_SET_BORDER_BLOCK_DESCRIPTION =
  'Rewrite a map\'s 2×2 metatile border (the bezel tiled around the\n' +
  'edge of the playable area).\n\n' +
  'Inputs:\n' +
  '  - `mapId`: the map id.\n' +
  '  - `borderBlockIds`: 4-tuple of u16 (top-left, top-right, bottom-\n' +
  '    left, bottom-right).';

const u16 = z.number().int().min(0).max(0xffff);

export const proposeSetBorderBlockInputShape = {
  mapId: z.string().min(1),
  borderBlockIds: z.tuple([u16, u16, u16, u16]),
  description: z.string().max(500).optional(),
} as const;

export interface ProposeSetBorderBlockResult {
  readonly proposal: AgentPatchProposal | null;
  readonly mapId: string | null;
  readonly bytesWritten: number;
  readonly message: string;
}

function emptyResult(message: string): ProposeSetBorderBlockResult {
  return { proposal: null, mapId: null, bytesWritten: 0, message };
}

function bytesToHex(b: Uint8Array): string {
  let out = '';
  for (let i = 0; i < b.length; i++) out += b[i]!.toString(16).padStart(2, '0');
  return out;
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

export async function proposeSetBorderBlock(
  ctx: ToolContext,
  args: {
    mapId: string;
    borderBlockIds: readonly [number, number, number, number];
    description?: string;
  },
  deps: { fetchFn?: typeof fetch } = {},
): Promise<ProposeSetBorderBlockResult> {
  const manifest = await readManifest(ctx.projectRoot);
  if (!manifest) return emptyResult('No manifest.');
  const rom = await findRomFile(ctx.projectRoot);
  if (!rom) return emptyResult(`No .gba in ${ctx.projectRoot}`);

  const map = manifest.maps.find((m) => m.id === args.mapId);
  if (!map) return emptyResult(`Map "${args.mapId}" not found.`);
  const layoutOffset = map.metadata?.['binaryRomLayoutOffset'];
  if (typeof layoutOffset !== 'number' || layoutOffset < 0) {
    return emptyResult(`Map "${args.mapId}" missing binaryRomLayoutOffset in metadata. Re-scan.`);
  }
  // The borderBlocksPtr is at MapLayout +0x08; we read it from the parsed
  // layout struct or by reading 4 bytes directly.
  const borderPtr = (rom.bytes[layoutOffset + 0x08]! |
    (rom.bytes[layoutOffset + 0x09]! << 8) |
    (rom.bytes[layoutOffset + 0x0a]! << 16) |
    (rom.bytes[layoutOffset + 0x0b]! << 24)) >>> 0;
  if (borderPtr === 0) {
    return emptyResult(`Map "${args.mapId}" has no border-blocks pointer set. Use propose_create_map to allocate one.`);
  }
  const borderOffset = borderPtr - 0x08000000;
  if (borderOffset < 0 || borderOffset + 8 > rom.bytes.length) {
    return emptyResult(`Border pointer 0x${borderPtr.toString(16)} is out of ROM bounds.`);
  }

  const oldBytes = new Uint8Array(rom.bytes.subarray(borderOffset, borderOffset + 8));
  const newBytes = mapsApi.encodeBorderBlocks([...args.borderBlockIds]);

  const edits: AgentPatchEdit[] = [
    {
      kind: 'binary_write_bytes',
      offset: borderOffset,
      beforeBytes: bytesToHex(oldBytes),
      afterBytes: bytesToHex(newBytes),
      note: `set border for ${args.mapId}`,
    } satisfies BinaryWriteBytesEdit,
  ];

  const description = args.description ?? `Set border on ${args.mapId} to [${args.borderBlockIds.join(', ')}]`;
  let proposal: AgentPatchProposal;
  try {
    proposal = await proposePatch(ctx, { description, edits }, deps);
  } catch (e) {
    if (e instanceof ProposePatchError) return emptyResult(`Failed to register proposal: ${e.message}`);
    throw e;
  }
  return { proposal, mapId: args.mapId, bytesWritten: 8, message: `Border set on ${args.mapId}.` };
}
