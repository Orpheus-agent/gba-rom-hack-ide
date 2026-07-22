/**
 * propose_create_map - Phase 3.8.
 *
 * Spawns a brand-new playable map by allocating its full struct family
 * (MapHeader + MapLayout + blocks array + border blocks + empty
 * MapEvents + empty MapScripts) in fresh ROM space, AND wires the new
 * MapHeader pointer into the gMapBankTable's inner group table so the
 * engine's warp / connection systems can resolve (group, mapNum) →
 * MapHeader at runtime.
 *
 * Scope (first cut):
 *   - Existing group only - the target group must already have at
 *     least one map (so the inner table has a known location to grow).
 *     "Add a brand-new group" is a stretch goal handled by a future
 *     companion tool propose_create_map_group.
 *   - Empty events + scripts (caller chains propose_add_object_event
 *     for NPCs / propose_script_edit for scripts).
 *   - Empty connections (caller chains propose_set_map_connection).
 *   - Blocks array filled with `defaultBlockId` (caller chains
 *     propose_paint_map_blocks to paint terrain).
 *   - Border blocks filled with `borderBlockId` (defaults to
 *     defaultBlockId).
 *
 * The tool uses the relocate-and-repoint pattern from
 * propose-add-object-event: every allocation goes through the
 * InBatchAllocator + findFreeRomSpace, every pointer that changes
 * gets a binary_rewrite_pointer edit.
 */

import { z } from 'zod';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import type {
  AgentPatchEdit,
  AgentPatchProposal,
  BinaryWriteBytesEdit,
  BinaryRewritePointerEdit,
  ProjectManifest,
} from '@rom-editor/shared';
import {
  maps as mapsApi,
  rom as romApi,
} from '@rom-introspection/engine';
import { readManifest } from '../../scan/manifest-io.js';
import type { ToolContext } from '../types.js';
import { proposePatch, ProposePatchError } from './propose-patch.js';

export const PROPOSE_CREATE_MAP_TOOL_NAME = 'propose_create_map';

export const PROPOSE_CREATE_MAP_DESCRIPTION =
  'Create a brand-new map. Allocates header + layout + blocks + border ' +
  '+ empty events + empty scripts structs in fresh ROM space and wires ' +
  'the new MapHeader into the gMapBankTable.\n\n' +
  'Inputs:\n' +
  '  - `width`, `height`: map dimensions in metatiles (1..1024 each;\n' +
  '    typical routes are 30×20, towns are 25×30, interiors are 10×10).\n' +
  '  - `mapGroup`: u8 - must reference an existing group (the inner\n' +
  '    table for the group must already exist; "new group" is a future\n' +
  '    enhancement).\n' +
  '  - `mapNum`: u8 - optional. When omitted, the tool assigns the\n' +
  '    lowest unused mapNum within the group.\n' +
  '  - `primaryTilesetOffset`: file offset of an existing primary\n' +
  '    Tileset struct (typically obtained from an existing map\'s\n' +
  '    layout.primaryTilesetOffset).\n' +
  '  - `secondaryTilesetOffset`: file offset of an existing secondary\n' +
  '    Tileset struct.\n' +
  '  - `mapType`: 1..9 (1=Town, 2=City, 3=Route, 4=Underground,\n' +
  '    5=Underwater, 6=Ocean, 7=Mt, 8=Indoor, 9=Secret).\n' +
  '  - `weather`: optional u8 (default 0 = clear).\n' +
  '  - `musicId`: optional u16 (default 0).\n' +
  '  - `regionMapSection`: optional u8 (default 0x58 = NONE - the user\n' +
  '    can call propose_set_region_map_label later).\n' +
  '  - `defaultBlockId`: optional u16 (default 0x001) - the metatile\n' +
  '    id to fill the entire blocks array with. The user can repaint\n' +
  '    with propose_paint_map_blocks.\n' +
  '  - `borderBlockIds`: optional 4-tuple of u16 (default uses\n' +
  '    `defaultBlockId` ×4) - the 2×2 metatile border tiled around\n' +
  '    the map.\n\n' +
  'Returns the new mapId, mapGroup, mapNum, mapHeaderOffset, and\n' +
  'mapLayoutOffset. Follow up with:\n' +
  '  - propose_paint_map_blocks to lay out terrain\n' +
  '  - propose_set_map_connection to wire neighboring maps\n' +
  '  - propose_add_object_event / propose_add_trainer for NPCs\n' +
  '  - propose_script_edit / propose_dialogue_branch_on_var for scripts';

const u8 = z.number().int().min(0).max(0xff);
const u16 = z.number().int().min(0).max(0xffff);
const mapDimension = z.number().int().min(1).max(1024);

export const proposeCreateMapInputShape = {
  width: mapDimension,
  height: mapDimension,
  mapGroup: u8,
  mapNum: u8.optional(),
  primaryTilesetOffset: z.number().int().min(0),
  secondaryTilesetOffset: z.number().int().min(0),
  mapType: z.number().int().min(1).max(9),
  weather: u8.optional(),
  musicId: u16.optional(),
  regionMapSection: u8.optional(),
  defaultBlockId: u16.optional(),
  borderBlockIds: z.tuple([u16, u16, u16, u16]).optional(),
  description: z.string().max(500).optional(),
} as const;

export interface ProposeCreateMapResult {
  readonly proposal: AgentPatchProposal | null;
  readonly mapId: string | null;
  readonly mapGroup: number | null;
  readonly mapNum: number | null;
  readonly mapHeaderOffset: number | null;
  readonly mapLayoutOffset: number | null;
  readonly mapBlocksOffset: number | null;
  readonly mapBorderOffset: number | null;
  readonly mapEventsOffset: number | null;
  readonly innerGroupTableRewriteOffset: number | null;
  readonly bytesAllocated: number;
  readonly message: string;
}

class InBatchAllocator {
  private readonly working: Uint8Array;
  private readonly allocations: { offset: number; size: number; bytes: Uint8Array; tag: string; fillByte: number }[] = [];
  constructor(romBytes: Uint8Array) {
    this.working = new Uint8Array(romBytes);
  }
  allocate(bytes: Uint8Array, tag: string): number | null {
    if (bytes.length <= 0) return null;
    const r = romApi.findFreeRomSpace(this.working, bytes.length);
    if (!r) return null;
    for (let i = 0; i < bytes.length; i++) this.working[r.offset + i] = 0xaa;
    this.allocations.push({ offset: r.offset, size: bytes.length, bytes, tag, fillByte: r.fillByte });
    return r.offset;
  }
  drain(): ReadonlyArray<{ offset: number; bytes: Uint8Array; tag: string; fillByte: number }> {
    return this.allocations.map((a) => ({ offset: a.offset, bytes: a.bytes, tag: a.tag, fillByte: a.fillByte }));
  }
  totalBytes(): number {
    return this.allocations.reduce((sum, a) => sum + a.size, 0);
  }
}

function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += bytes[i]!.toString(16).padStart(2, '0');
  return out;
}

function emptyResult(message: string): ProposeCreateMapResult {
  return {
    proposal: null,
    mapId: null,
    mapGroup: null,
    mapNum: null,
    mapHeaderOffset: null,
    mapLayoutOffset: null,
    mapBlocksOffset: null,
    mapBorderOffset: null,
    mapEventsOffset: null,
    innerGroupTableRewriteOffset: null,
    bytesAllocated: 0,
    message,
  };
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

/** Find the lowest unused mapNum within `mapGroup` by walking
 *  manifest.maps. */
function nextFreeMapNum(manifest: ProjectManifest, mapGroup: number): number {
  const taken = new Set<number>();
  for (const m of manifest.maps) {
    const mg = m.metadata?.['groupIndex'];
    const mn = m.metadata?.['mapNum'];
    if (typeof mg === 'number' && typeof mn === 'number' && mg === mapGroup) {
      taken.add(mn);
    }
  }
  for (let i = 0; i < 256; i++) {
    if (!taken.has(i)) return i;
  }
  throw new Error('every mapNum 0..255 is taken in this group; group is full');
}

/** Find the existing inner-table file offset for a group by inspecting
 *  any map already in that group. Returns the inner-table start offset
 *  (file offset of the first u32 pointer) AND the current entry count
 *  (= max mapNum + 1 in the group). The OUTER table location is
 *  derived from `findMapGroupsOuterTable` (engine-side scanner). */
function inferInnerTableShape(
  manifest: ProjectManifest,
  mapGroup: number,
): { existingEntries: number; estimatedInnerTableLength: number } | null {
  const groupMaps = manifest.maps.filter((m) => m.metadata?.['groupIndex'] === mapGroup);
  if (groupMaps.length === 0) return null;
  let maxMapNum = -1;
  for (const m of groupMaps) {
    const mn = m.metadata?.['mapNum'];
    if (typeof mn === 'number' && mn > maxMapNum) maxMapNum = mn;
  }
  const existingEntries = maxMapNum + 1;
  return { existingEntries, estimatedInnerTableLength: existingEntries };
}

export async function proposeCreateMap(
  ctx: ToolContext,
  args: {
    width: number;
    height: number;
    mapGroup: number;
    mapNum?: number;
    primaryTilesetOffset: number;
    secondaryTilesetOffset: number;
    mapType: number;
    weather?: number;
    musicId?: number;
    regionMapSection?: number;
    defaultBlockId?: number;
    borderBlockIds?: readonly [number, number, number, number];
    description?: string;
  },
  deps: { fetchFn?: typeof fetch } = {},
): Promise<ProposeCreateMapResult> {
  const manifest = await readManifest(ctx.projectRoot);
  if (!manifest) {
    return emptyResult('No manifest. Open + scan a project first.');
  }
  const rom = await findRomFile(ctx.projectRoot);
  if (!rom) {
    return emptyResult(`No .gba in ${ctx.projectRoot}`);
  }

  // Resolve mapNum.
  let mapNum: number;
  try {
    mapNum = args.mapNum ?? nextFreeMapNum(manifest, args.mapGroup);
  } catch (e) {
    return emptyResult(e instanceof Error ? e.message : String(e));
  }
  // Reject if the slot is already taken.
  for (const m of manifest.maps) {
    if (
      m.metadata?.['groupIndex'] === args.mapGroup &&
      m.metadata?.['mapNum'] === mapNum
    ) {
      return emptyResult(
        `Map (group ${String(args.mapGroup)}, num ${String(mapNum)}) is already taken by ${m.id}. Pick a different mapNum or omit it to auto-assign the next free slot.`,
      );
    }
  }

  // Look up the existing inner-table shape so we can grow it.
  const inner = inferInnerTableShape(manifest, args.mapGroup);
  if (inner === null) {
    return emptyResult(
      `Group ${String(args.mapGroup)} has no existing maps - propose_create_map's first cut requires an existing group with at least one map (so the inner table\'s shape can be inferred). Pick a different group, OR add a propose_create_map_group call first (not yet implemented).`,
    );
  }
  // Need at least `mapNum + 1` entries in the new inner table.
  const newInnerTableLen = Math.max(inner.existingEntries, mapNum + 1);

  // Locate the outer gMapBankTable via the engine scanner.
  const outer = mapsApi.findMapGroupsOuterTable(
    new Uint8Array(rom.bytes),
    manifest.maps
      .map((m) => {
        const off = m.metadata?.['mapHeaderOffset'];
        return typeof off === 'number' ? { tableStart: off, tableEndExclusive: off + 28 } : null;
      })
      .filter((x): x is { tableStart: number; tableEndExclusive: number } => x !== null),
  );
  if (outer === null) {
    return emptyResult(
      `Could not locate the gMapBankTable in the ROM. The propose-tool needs the outer table\'s offset to wire the new map\'s pointer into the inner group table. Re-scan the project - if the scanner can\'t find the bank table, this ROM\'s pointer network may have been heavily customised and creating new maps will require a different approach.`,
    );
  }
  const groupEntry = outer.groups.find((g) => g.groupIndex === args.mapGroup);
  if (!groupEntry) {
    return emptyResult(
      `Group ${String(args.mapGroup)} not found in the discovered gMapBankTable (only groups ${outer.groups.map((g) => String(g.groupIndex)).join(', ')} are present).`,
    );
  }
  const oldInnerTableOffset = groupEntry.innerTableStart;
  // We need the existing pointers' bytes so we can copy them into the
  // new inner table.
  const oldInnerTableBytes = new Uint8Array(
    rom.bytes.subarray(
      oldInnerTableOffset,
      oldInnerTableOffset + newInnerTableLen * 4,
    ),
  );

  // Build the map's struct family.
  const allocator = new InBatchAllocator(new Uint8Array(rom.bytes));
  const defaultBlockId = args.defaultBlockId ?? 0x001;
  const borderBlocks = args.borderBlockIds ?? [defaultBlockId, defaultBlockId, defaultBlockId, defaultBlockId];

  // 1. Blocks array (W × H × u16).
  const blockIds = new Array<number>(args.width * args.height).fill(defaultBlockId);
  const blocksBytes = mapsApi.encodeBlockGrid(args.width, args.height, blockIds);
  const blocksOffset = allocator.allocate(blocksBytes, 'blocks');
  if (blocksOffset === null) return emptyResult('No free ROM space for the blocks array.');

  // 2. Border blocks (2×2 u16).
  const borderBytes = mapsApi.encodeBorderBlocks([...borderBlocks]);
  const borderOffset = allocator.allocate(borderBytes, 'border');
  if (borderOffset === null) return emptyResult('No free ROM space for border blocks.');

  // 3. Empty MapEvents struct (8 bytes: count + array pointer; all zero).
  const emptyEventsBytes = new Uint8Array(8);
  const eventsOffset = allocator.allocate(emptyEventsBytes, 'events');
  if (eventsOffset === null) return emptyResult('No free ROM space for events struct.');

  // 4. MapLayout struct (24 bytes).
  const layoutBytes = mapsApi.encodeMapLayout({
    width: args.width,
    height: args.height,
    borderBlocksOffset: borderOffset,
    primaryBlocksOffset: blocksOffset,
    primaryTilesetOffset: args.primaryTilesetOffset,
    secondaryTilesetOffset: args.secondaryTilesetOffset,
  });
  const layoutOffset = allocator.allocate(layoutBytes, 'layout');
  if (layoutOffset === null) return emptyResult('No free ROM space for layout struct.');

  // 5. MapHeader struct (28 bytes).
  const headerBytes = mapsApi.encodeMapHeader({
    mapLayoutOffset: layoutOffset,
    eventsOffset,
    mapScriptsOffset: null,
    connectionsOffset: null,
    musicId: args.musicId ?? 0,
    mapLayoutId: 0,
    regionMapSection: args.regionMapSection ?? 0x58,
    caveOrType: 0,
    weather: args.weather ?? 0,
    mapType: args.mapType,
    flags: 0,
    battleType: 0,
  });
  const headerOffset = allocator.allocate(headerBytes, 'header');
  if (headerOffset === null) return emptyResult('No free ROM space for map header.');

  // 6. New inner group table (newInnerTableLen × 4 bytes).
  const newInnerTableBytes = new Uint8Array(newInnerTableLen * 4);
  newInnerTableBytes.set(oldInnerTableBytes, 0); // copy existing pointers
  // Append / overwrite the slot at mapNum with the new MapHeader pointer.
  const newHeaderPtr = (headerOffset + 0x08000000) >>> 0;
  const newSlotOffset = mapNum * 4;
  newInnerTableBytes[newSlotOffset + 0] = newHeaderPtr & 0xff;
  newInnerTableBytes[newSlotOffset + 1] = (newHeaderPtr >>> 8) & 0xff;
  newInnerTableBytes[newSlotOffset + 2] = (newHeaderPtr >>> 16) & 0xff;
  newInnerTableBytes[newSlotOffset + 3] = (newHeaderPtr >>> 24) & 0xff;
  const newInnerTableOffset = allocator.allocate(newInnerTableBytes, 'innerTable');
  if (newInnerTableOffset === null) return emptyResult('No free ROM space for new inner group table.');

  // Build the edit set.
  const edits: AgentPatchEdit[] = [];

  // a) Write each allocated block. beforeBytes uses the actual fillByte
  //    the allocator found (0xff for vanilla padding, 0x00 for CFRU-zeroed
  //    free runs). Hardcoding 0xff here caused apply failures on
  //    CFRU+DPE-modernized ROMs where the allocator legitimately picks
  //    a 0x00-filled region.
  for (const alloc of allocator.drain()) {
    edits.push({
      kind: 'binary_write_bytes',
      offset: alloc.offset,
      beforeBytes: bytesToHex(new Uint8Array(alloc.bytes.length).fill(alloc.fillByte)),
      afterBytes: bytesToHex(alloc.bytes),
      requireFreeSlot: true,
      note: `allocate ${String(alloc.bytes.length)} bytes for new map: ${alloc.tag}`,
    } satisfies BinaryWriteBytesEdit);
  }

  // b) Rewrite gMapBankTable[group] to point at the new inner table.
  const outerTableEntryOffset = outer.tableStart + args.mapGroup * 4;
  edits.push({
    kind: 'binary_rewrite_pointer',
    pointerOffset: outerTableEntryOffset,
    beforeTargetOffset: oldInnerTableOffset,
    afterTargetOffset: newInnerTableOffset,
    note: `repoint gMapBankTable[${String(args.mapGroup)}] to grown inner table`,
  } satisfies BinaryRewritePointerEdit);

  // c) Wipe the old inner table to 0xFF.
  edits.push({
    kind: 'binary_write_bytes',
    offset: oldInnerTableOffset,
    beforeBytes: bytesToHex(oldInnerTableBytes),
    afterBytes: bytesToHex(new Uint8Array(oldInnerTableBytes.length).fill(0xff)),
    note: `clear old inner group table (group ${String(args.mapGroup)}) at 0x${oldInnerTableOffset.toString(16)}`,
  } satisfies BinaryWriteBytesEdit);

  const description =
    args.description ??
    `Create map ${String(args.mapGroup)}.${String(mapNum)} (${String(args.width)}×${String(args.height)} ${mapTypeName(args.mapType)})`;
  let proposal: AgentPatchProposal;
  try {
    proposal = await proposePatch(ctx, { description, edits }, deps);
  } catch (e) {
    if (e instanceof ProposePatchError) {
      return {
        ...emptyResult(`Failed to register proposal: ${e.message}`),
        mapGroup: args.mapGroup,
        mapNum,
      };
    }
    throw e;
  }

  return {
    proposal,
    mapId: `binary_map_${String(args.mapGroup)}_${String(mapNum)}`,
    mapGroup: args.mapGroup,
    mapNum,
    mapHeaderOffset: headerOffset,
    mapLayoutOffset: layoutOffset,
    mapBlocksOffset: blocksOffset,
    mapBorderOffset: borderOffset,
    mapEventsOffset: eventsOffset,
    innerGroupTableRewriteOffset: newInnerTableOffset,
    bytesAllocated: allocator.totalBytes(),
    message:
      `New map ${String(args.mapGroup)}.${String(mapNum)} (${String(args.width)}×${String(args.height)}): ` +
      `header @0x${headerOffset.toString(16)}, layout @0x${layoutOffset.toString(16)}, ` +
      `blocks @0x${blocksOffset.toString(16)}, ` +
      `${String(allocator.totalBytes())} bytes allocated. ` +
      `Apply the proposal, then call propose_paint_map_blocks to lay out terrain.`,
  };
}

function mapTypeName(mt: number): string {
  switch (mt) {
    case 1: return 'Town';
    case 2: return 'City';
    case 3: return 'Route';
    case 4: return 'Underground';
    case 5: return 'Underwater';
    case 6: return 'Ocean';
    case 7: return 'Mt';
    case 8: return 'Indoor';
    case 9: return 'Secret';
    default: return `type ${String(mt)}`;
  }
}
