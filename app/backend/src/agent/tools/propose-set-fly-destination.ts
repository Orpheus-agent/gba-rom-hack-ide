/**
 * propose_set_fly_destination - Phase 3.30.
 *
 * Sets an entry in the sHealLocations / gHealLocations table - the
 * table that maps each SPAWN_* id to (mapGroup, mapNum, x, y). Used
 * to wire a new Fly destination after creating a town.
 *
 * In-place rewrite of a 6-byte slot. Doesn't grow the table (vanilla
 * 13 entries; CFRU may expand a few). Caller specifies the slot
 * INDEX, not a SPAWN_* name - the agent looks up the right index via
 * the scanner.
 */

import { z } from 'zod';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import type {
  AgentPatchEdit,
  AgentPatchProposal,
  BinaryWriteBytesEdit,
} from '@rom-editor/shared';
import { world as worldApi } from '@rom-introspection/engine';
import type { ToolContext } from '../types.js';
import { proposePatch, ProposePatchError } from './propose-patch.js';

export const PROPOSE_SET_FLY_DESTINATION_TOOL_NAME = 'propose_set_fly_destination';

export const PROPOSE_SET_FLY_DESTINATION_DESCRIPTION =
  'Rewrite a heal-locations / fly-destination table entry to point\n' +
  'at a (mapGroup, mapNum, x, y) tuple.\n\n' +
  'Inputs:\n' +
  '  - `spawnIndex`: u8 - slot in the heal-locations table. Read the\n' +
  '    existing slots via the scanner (manifest.regionMap when\n' +
  '    lifted) to pick a free or reusable slot. Vanilla FRLG indices:\n' +
  '    0 = Pallet, 1 = Viridian, 2 = Pewter, …, 12 = Indigo Plateau.\n' +
  '  - `mapGroup`, `mapNum`: u8 each - destination map.\n' +
  '  - `x`, `y`: s16 each - destination tile coords (0..511).';

const u8 = z.number().int().min(0).max(0xff);
const coord = z.number().int().min(0).max(511);

export const proposeSetFlyDestinationInputShape = {
  spawnIndex: u8,
  mapGroup: u8,
  mapNum: u8,
  x: coord,
  y: coord,
  description: z.string().max(500).optional(),
} as const;

export interface ProposeSetFlyDestinationResult {
  readonly proposal: AgentPatchProposal | null;
  readonly spawnIndex: number;
  readonly bytesWritten: number;
  readonly message: string;
}

function emptyResult(spawnIndex: number, message: string): ProposeSetFlyDestinationResult {
  return { proposal: null, spawnIndex, bytesWritten: 0, message };
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

export async function proposeSetFlyDestination(
  ctx: ToolContext,
  args: {
    spawnIndex: number;
    mapGroup: number;
    mapNum: number;
    x: number;
    y: number;
    description?: string;
  },
  deps: { fetchFn?: typeof fetch } = {},
): Promise<ProposeSetFlyDestinationResult> {
  const rom = await findRomFile(ctx.projectRoot);
  if (!rom) return emptyResult(args.spawnIndex, `No .gba in ${ctx.projectRoot}`);

  const romBytes = new Uint8Array(rom.bytes);
  const table = worldApi.scanHealLocations(romBytes);
  if (!table) return emptyResult(args.spawnIndex, 'Could not locate the heal-locations / fly destinations table.');
  if (args.spawnIndex >= table.entries.length) {
    return emptyResult(
      args.spawnIndex,
      `spawnIndex ${String(args.spawnIndex)} is past the table end (${String(table.entries.length)} entries).`,
    );
  }

  const entrySize = 6;
  const entryOffset = table.tableStart + args.spawnIndex * entrySize;
  const oldBytes = new Uint8Array(rom.bytes.subarray(entryOffset, entryOffset + entrySize));
  // Build the new 6 bytes: group u8, mapNum u8, x s16 LE, y s16 LE.
  const newBytes = new Uint8Array(entrySize);
  newBytes[0] = args.mapGroup & 0xff;
  newBytes[1] = args.mapNum & 0xff;
  newBytes[2] = args.x & 0xff;
  newBytes[3] = (args.x >>> 8) & 0xff;
  newBytes[4] = args.y & 0xff;
  newBytes[5] = (args.y >>> 8) & 0xff;

  const edits: AgentPatchEdit[] = [
    {
      kind: 'binary_write_bytes',
      offset: entryOffset,
      beforeBytes: bytesToHex(oldBytes),
      afterBytes: bytesToHex(newBytes),
      note: `set heal-location slot ${String(args.spawnIndex)} → ${String(args.mapGroup)}.${String(args.mapNum)} (${String(args.x)},${String(args.y)})`,
    } satisfies BinaryWriteBytesEdit,
  ];

  const description = args.description ?? `Fly destination ${String(args.spawnIndex)}: map ${String(args.mapGroup)}.${String(args.mapNum)} at (${String(args.x)},${String(args.y)})`;
  let proposal: AgentPatchProposal;
  try {
    proposal = await proposePatch(ctx, { description, edits }, deps);
  } catch (e) {
    if (e instanceof ProposePatchError) return emptyResult(args.spawnIndex, `Failed: ${e.message}`);
    throw e;
  }
  return {
    proposal,
    spawnIndex: args.spawnIndex,
    bytesWritten: entrySize,
    message: `Fly destination ${String(args.spawnIndex)} now points at ${String(args.mapGroup)}.${String(args.mapNum)} (${String(args.x)},${String(args.y)}).`,
  };
}
