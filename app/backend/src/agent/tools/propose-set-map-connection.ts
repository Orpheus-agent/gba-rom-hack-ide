/**
 * propose_set_map_connection - Phase 3.10.
 *
 * Adds a new MapConnection entry to a map's connections array. If the
 * map currently has no connections envelope (connectionsOffset is
 * NULL in its header), the tool allocates a fresh 8-byte envelope +
 * 12-byte connection array; otherwise it grows the existing array via
 * the relocate-and-repoint pattern.
 *
 * Direction enum (per pret/pokefirered):
 *   1 = down, 2 = up, 3 = left, 4 = right, 5 = dive, 6 = emerge.
 *
 * Tile offset along the shared edge (signed). For DOWN/UP, this is the
 * horizontal tile offset of the destination map relative to the
 * source. For LEFT/RIGHT, it's the vertical offset.
 */

import { z } from 'zod';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import type {
  AgentPatchEdit,
  AgentPatchProposal,
  BinaryWriteBytesEdit,
  BinaryRewritePointerEdit,
} from '@rom-editor/shared';
import { maps as mapsApi, rom as romApi } from '@rom-introspection/engine';
import { readManifest } from '../../scan/manifest-io.js';
import type { ToolContext } from '../types.js';
import { proposePatch, ProposePatchError } from './propose-patch.js';

export const PROPOSE_SET_MAP_CONNECTION_TOOL_NAME = 'propose_set_map_connection';

export const PROPOSE_SET_MAP_CONNECTION_DESCRIPTION =
  'Wire a directional connection from one map to another (e.g. Route 1\n' +
  'south → Pallet Town).\n\n' +
  'Inputs:\n' +
  '  - `mapId`: the source map id.\n' +
  '  - `direction`: \'down\'|\'up\'|\'left\'|\'right\'|\'dive\'|\'emerge\'.\n' +
  '  - `offset`: s32 tile offset along the shared edge (typically -7..+7).\n' +
  '  - `destMapGroup`, `destMapNum`: the destination map\'s group + num.\n\n' +
  'Grows the connections array via the relocate-and-repoint pattern.';

const u8 = z.number().int().min(0).max(0xff);
const s32 = z.number().int().min(-0x80000000).max(0x7fffffff);

const DIRECTION_MAP: Readonly<Record<string, number>> = {
  down: 1, up: 2, left: 3, right: 4, dive: 5, emerge: 6,
};

export const proposeSetMapConnectionInputShape = {
  mapId: z.string().min(1),
  direction: z.enum(['down', 'up', 'left', 'right', 'dive', 'emerge']),
  offset: s32,
  destMapGroup: u8,
  destMapNum: u8,
  description: z.string().max(500).optional(),
} as const;

export interface ProposeSetMapConnectionResult {
  readonly proposal: AgentPatchProposal | null;
  readonly mapId: string | null;
  readonly newConnectionCount: number;
  readonly bytesAllocated: number;
  readonly message: string;
}

function emptyResult(message: string): ProposeSetMapConnectionResult {
  return { proposal: null, mapId: null, newConnectionCount: 0, bytesAllocated: 0, message };
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

class Allocator {
  private readonly working: Uint8Array;
  private readonly allocs: Array<{ offset: number; bytes: Uint8Array; tag: string; fillByte: number }> = [];
  constructor(rom: Uint8Array) { this.working = new Uint8Array(rom); }
  alloc(bytes: Uint8Array, tag: string): number | null {
    const r = romApi.findFreeRomSpace(this.working, bytes.length);
    if (!r) return null;
    for (let i = 0; i < bytes.length; i++) this.working[r.offset + i] = 0xaa;
    this.allocs.push({ offset: r.offset, bytes, tag, fillByte: r.fillByte });
    return r.offset;
  }
  drain(): ReadonlyArray<{ offset: number; bytes: Uint8Array; tag: string; fillByte: number }> {
    return this.allocs;
  }
  total(): number { return this.allocs.reduce((s, a) => s + a.bytes.length, 0); }
}

export async function proposeSetMapConnection(
  ctx: ToolContext,
  args: {
    mapId: string;
    direction: 'down' | 'up' | 'left' | 'right' | 'dive' | 'emerge';
    offset: number;
    destMapGroup: number;
    destMapNum: number;
    description?: string;
  },
  deps: { fetchFn?: typeof fetch } = {},
): Promise<ProposeSetMapConnectionResult> {
  const manifest = await readManifest(ctx.projectRoot);
  if (!manifest) return emptyResult('No manifest. Open + scan a project first.');
  const rom = await findRomFile(ctx.projectRoot);
  if (!rom) return emptyResult(`No .gba in ${ctx.projectRoot}`);

  const map = manifest.maps.find((m) => m.id === args.mapId);
  if (!map) return emptyResult(`Map "${args.mapId}" not found in manifest.`);
  const mapHeaderOffset = map.metadata?.['mapHeaderOffset'];
  if (typeof mapHeaderOffset !== 'number') {
    return emptyResult(`Map "${args.mapId}" missing mapHeaderOffset in metadata. Re-scan.`);
  }

  // Read existing connections (if any) from the parsed result.
  const existing: ReadonlyArray<{ direction: number; offset: number; destMapGroup: number; destMapNum: number }> = map.connections
    ? map.connections.map((c) => ({
        direction: c.direction,
        offset: c.offset,
        destMapGroup: c.destMapGroup,
        destMapNum: c.destMapNum,
      }))
    : [];

  // Build the new connections list (existing + new entry).
  const direction = DIRECTION_MAP[args.direction]!;
  const newConnections = [
    ...existing,
    { direction, offset: args.offset, destMapGroup: args.destMapGroup, destMapNum: args.destMapNum },
  ];

  // Encode the new array + a fresh envelope.
  const allocator = new Allocator(new Uint8Array(rom.bytes));
  const newArrayBytes = mapsApi.encodeMapConnectionsArray(newConnections);
  const newArrayOffset = allocator.alloc(newArrayBytes, 'connections-array');
  if (newArrayOffset === null) return emptyResult('No free ROM space for new connections array.');

  const newHeaderBytes = mapsApi.encodeMapConnectionsHeader(newConnections.length, newArrayOffset);
  const newHeaderOffset = allocator.alloc(newHeaderBytes, 'connections-envelope');
  if (newHeaderOffset === null) return emptyResult('No free ROM space for new connections envelope.');

  const edits: AgentPatchEdit[] = [];
  for (const a of allocator.drain()) {
    edits.push({
      kind: 'binary_write_bytes',
      offset: a.offset,
      beforeBytes: bytesToHex(new Uint8Array(a.bytes.length).fill(a.fillByte)),
      afterBytes: bytesToHex(a.bytes),
      requireFreeSlot: true,
      note: `allocate ${String(a.bytes.length)} bytes: ${a.tag}`,
    } satisfies BinaryWriteBytesEdit);
  }

  // Rewrite the map header's connectionsPointer @ +0x0C.
  const oldConnectionsPtrTarget = map.connections && map.connections[0]
    ? readU32LE(rom.bytes, mapHeaderOffset + 0x0c) - 0x08000000
    : 0; // header had NULL; we'll rewrite that NULL via binary_write_bytes.
  if (map.connections && map.connections[0]) {
    // Existing pointer rewrite path.
    edits.push({
      kind: 'binary_rewrite_pointer',
      pointerOffset: mapHeaderOffset + 0x0c,
      beforeTargetOffset: oldConnectionsPtrTarget,
      afterTargetOffset: newHeaderOffset,
      note: `repoint ${args.mapId} connectionsPtr to new envelope`,
    } satisfies BinaryRewritePointerEdit);
  } else {
    // Was NULL - write the new pointer over 4 zero bytes.
    const newPtr = (newHeaderOffset + 0x08000000) >>> 0;
    const ptrBytes = new Uint8Array(4);
    ptrBytes[0] = newPtr & 0xff;
    ptrBytes[1] = (newPtr >>> 8) & 0xff;
    ptrBytes[2] = (newPtr >>> 16) & 0xff;
    ptrBytes[3] = (newPtr >>> 24) & 0xff;
    edits.push({
      kind: 'binary_write_bytes',
      offset: mapHeaderOffset + 0x0c,
      beforeBytes: '00000000',
      afterBytes: bytesToHex(ptrBytes),
      note: `set ${args.mapId} connectionsPointer (was NULL)`,
    } satisfies BinaryWriteBytesEdit);
  }

  const description =
    args.description ??
    `Add ${args.direction} connection from ${args.mapId} to ${String(args.destMapGroup)}.${String(args.destMapNum)} @ offset ${String(args.offset)}`;
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
    newConnectionCount: newConnections.length,
    bytesAllocated: allocator.total(),
    message: `${args.mapId} now has ${String(newConnections.length)} connection(s).`,
  };
}

function readU32LE(buf: Buffer, offset: number): number {
  return (buf[offset]! | (buf[offset + 1]! << 8) | (buf[offset + 2]! << 16) | (buf[offset + 3]! << 24)) >>> 0;
}
