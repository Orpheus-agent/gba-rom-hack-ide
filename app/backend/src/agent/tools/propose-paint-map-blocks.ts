/**
 * propose_paint_map_blocks - Phase 3.9.
 *
 * Paints a rectangle of metatiles onto an existing map's block grid.
 * The block grid is a `width × height` u16 array (low 10 bits = metatile
 * id, upper bits = collision/elevation/behavior override) pointed at by
 * MapLayout.primaryBlocksOffset.
 *
 * Two fill modes:
 *
 *   - **uniform**: every cell in the rect gets the same `fillBlockId`.
 *   - **explicit**: `blockIds` provides one u16 per cell, in row-major
 *     order. Length must equal `rect.w * rect.h`.
 *
 * The tool rewrites the blocks-array bytes IN PLACE - no relocation
 * (the array doesn't change size; only the cells inside the rect
 * change). The full blocks array is read pre-paint + written
 * post-paint so the propose proposal's before/after pair is a clean
 * diff the user can review.
 *
 * Templates: a `templateId` mode is reserved for Phase 3.9b (small
 * libraries like "2×3 house", "tree row of 4", "fountain" that the
 * agent can drop in at a position). For now the agent composes
 * those by hand via uniform/explicit modes.
 */

import { z } from 'zod';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import type {
  AgentPatchEdit,
  AgentPatchProposal,
  BinaryWriteBytesEdit,
} from '@rom-editor/shared';
import { readManifest } from '../../scan/manifest-io.js';
import type { ToolContext } from '../types.js';
import { proposePatch, ProposePatchError } from './propose-patch.js';

export const PROPOSE_PAINT_MAP_BLOCKS_TOOL_NAME = 'propose_paint_map_blocks';

export const PROPOSE_PAINT_MAP_BLOCKS_DESCRIPTION =
  'Paint a rectangle of metatiles onto an existing map. The rect is\n' +
  'specified in tile coordinates (top-left origin, 0-indexed).\n\n' +
  'Inputs:\n' +
  '  - `mapId`: the map id (e.g. `binary_map_3_19`).\n' +
  '  - `rect`: { x, y, w, h } - top-left and size in tiles.\n' +
  '  - `mode`: \'uniform\' or \'explicit\'.\n' +
  '  - `fillBlockId` (uniform mode): u16 metatile id to paint every\n' +
  '    cell in the rect.\n' +
  '  - `blockIds` (explicit mode): array of u16, length = w × h, row-\n' +
  '    major.\n\n' +
  'Each u16 cell stores the metatile id in the low 10 bits and\n' +
  'collision / elevation / behavior override bits in the upper 6 bits.\n' +
  'For plain terrain painting, just pass the metatile id (upper bits\n' +
  'default 0 = no collision override / ground level).\n\n' +
  'The tool does NOT relocate the array (the size doesn\'t change);\n' +
  'it writes the new bytes in place. Refuses if rect extends past the\n' +
  'map\'s dimensions.';

const u16 = z.number().int().min(0).max(0xffff);

export const proposePaintMapBlocksInputShape = {
  mapId: z.string().min(1),
  rect: z.object({
    x: z.number().int().min(0),
    y: z.number().int().min(0),
    w: z.number().int().min(1),
    h: z.number().int().min(1),
  }),
  mode: z.enum(['uniform', 'explicit']),
  fillBlockId: u16.optional(),
  blockIds: z.array(u16).optional(),
  description: z.string().max(500).optional(),
} as const;

export interface ProposePaintMapBlocksResult {
  readonly proposal: AgentPatchProposal | null;
  readonly mapId: string | null;
  readonly cellsPainted: number;
  readonly bytesWritten: number;
  readonly message: string;
}

function emptyResult(message: string): ProposePaintMapBlocksResult {
  return { proposal: null, mapId: null, cellsPainted: 0, bytesWritten: 0, message };
}

function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += bytes[i]!.toString(16).padStart(2, '0');
  return out;
}

async function findRomFile(
  projectRoot: string,
): Promise<{ path: string; bytes: Buffer } | null> {
  try {
    const entries = await fsp.readdir(projectRoot, { withFileTypes: true });
    for (const e of entries) {
      if (e.isFile() && e.name.toLowerCase().endsWith('.gba')) {
        const p = path.join(projectRoot, e.name);
        const bytes = await fsp.readFile(p);
        return { path: p, bytes };
      }
    }
  } catch {
    return null;
  }
  return null;
}

export async function proposePaintMapBlocks(
  ctx: ToolContext,
  args: {
    mapId: string;
    rect: { x: number; y: number; w: number; h: number };
    mode: 'uniform' | 'explicit';
    fillBlockId?: number;
    blockIds?: ReadonlyArray<number>;
    description?: string;
  },
  deps: { fetchFn?: typeof fetch } = {},
): Promise<ProposePaintMapBlocksResult> {
  if (args.mode === 'uniform' && typeof args.fillBlockId !== 'number') {
    return emptyResult('uniform mode requires fillBlockId.');
  }
  if (args.mode === 'explicit' && !Array.isArray(args.blockIds)) {
    return emptyResult('explicit mode requires blockIds.');
  }
  const expectedCells = args.rect.w * args.rect.h;
  if (args.mode === 'explicit' && args.blockIds!.length !== expectedCells) {
    return emptyResult(
      `explicit blockIds length (${String(args.blockIds!.length)}) must equal rect.w × rect.h (${String(expectedCells)}).`,
    );
  }

  const manifest = await readManifest(ctx.projectRoot);
  if (!manifest) return emptyResult('No manifest. Open + scan a project first.');
  const rom = await findRomFile(ctx.projectRoot);
  if (!rom) return emptyResult(`No .gba in ${ctx.projectRoot}`);

  const map = manifest.maps.find((m) => m.id === args.mapId);
  if (!map) return emptyResult(`Map "${args.mapId}" not found in manifest.`);
  const width = map.dimensions.width;
  const height = map.dimensions.height;
  const blocksOffset = map.metadata?.['binaryRomPrimaryBlocksOffset'];
  if (typeof blocksOffset !== 'number' || blocksOffset < 0) {
    return emptyResult(
      `Map "${args.mapId}" has no binaryRomPrimaryBlocksOffset in its manifest metadata. Re-scan the project - this metadata is required to locate the block array on disk.`,
    );
  }

  // Bounds-check the rect.
  if (args.rect.x + args.rect.w > width || args.rect.y + args.rect.h > height) {
    return emptyResult(
      `Rect (${String(args.rect.x)},${String(args.rect.y)},${String(args.rect.w)}×${String(args.rect.h)}) extends past map dimensions ${String(width)}×${String(height)}.`,
    );
  }

  // Read the current blocks array (width × height × 2 bytes).
  const totalBytes = width * height * 2;
  const oldBytes = new Uint8Array(rom.bytes.subarray(blocksOffset, blocksOffset + totalBytes));
  if (oldBytes.length !== totalBytes) {
    return emptyResult(
      `Failed to read full blocks array - wanted ${String(totalBytes)} bytes at 0x${blocksOffset.toString(16)}, got ${String(oldBytes.length)}.`,
    );
  }

  // Build a copy with the rect overwritten.
  const newBytes = new Uint8Array(oldBytes);
  const fill = args.fillBlockId ?? 0;
  let cellsPainted = 0;
  for (let dy = 0; dy < args.rect.h; dy++) {
    for (let dx = 0; dx < args.rect.w; dx++) {
      const mapX = args.rect.x + dx;
      const mapY = args.rect.y + dy;
      const cellIdx = mapY * width + mapX;
      const byteOff = cellIdx * 2;
      const blockId =
        args.mode === 'uniform' ? fill : args.blockIds![dy * args.rect.w + dx]!;
      newBytes[byteOff + 0] = blockId & 0xff;
      newBytes[byteOff + 1] = (blockId >>> 8) & 0xff;
      cellsPainted++;
    }
  }

  const edits: AgentPatchEdit[] = [
    {
      kind: 'binary_write_bytes',
      offset: blocksOffset,
      beforeBytes: bytesToHex(oldBytes),
      afterBytes: bytesToHex(newBytes),
      note: `paint ${String(cellsPainted)} cells (${String(args.rect.w)}×${String(args.rect.h)}) on ${args.mapId}`,
    } satisfies BinaryWriteBytesEdit,
  ];

  const description =
    args.description ??
    `Paint ${String(cellsPainted)} cells on ${args.mapId} (rect ${String(args.rect.x)},${String(args.rect.y)}, ${String(args.rect.w)}×${String(args.rect.h)})`;
  let proposal: AgentPatchProposal;
  try {
    proposal = await proposePatch(ctx, { description, edits }, deps);
  } catch (e) {
    if (e instanceof ProposePatchError) return emptyResult(`Failed to register proposal: ${e.message}`);
    throw e;
  }
  return {
    proposal,
    mapId: args.mapId,
    cellsPainted,
    bytesWritten: totalBytes,
    message: `Painted ${String(cellsPainted)} cells on ${args.mapId}.`,
  };
}
