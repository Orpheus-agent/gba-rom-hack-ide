/**
 * propose_add_object_event - insert a new ObjectEvent (NPC, trainer-shell,
 * berry tree, etc.) into a map's per-map ObjectEvent array.
 *
 * Gen-3 ObjectEvents live in a contiguous array of 24-byte ObjectEventTemplate
 * structs pointed to by the map's MapEvents struct (count byte at +0x00,
 * array pointer at +0x04). To grow the array we:
 *
 *   1. Read the current array (count × 24 bytes).
 *   2. Build the new 24-byte ObjectEventTemplate.
 *   3. Allocate (count + 1) × 24 bytes in free ROM space.
 *   4. Write old + new bytes there.
 *   5. Rewrite the MapEvents struct's objectEventsPointer @ +0x04.
 *   6. Bump the count byte @ +0x00.
 *   7. Wipe the old array slot to 0xFF so the abandoned bytes don't
 *      confuse future scans.
 *
 * The new ObjectEvent's `scriptOffset` field defaults to NULL - the
 * caller is expected to chain a `propose_add_script_for_trainer` (or
 * `propose_script_edit`) call to attach a script after this one's diff
 * is applied.
 *
 * Mirrors the relocate-and-repoint pattern from `propose-script-edit.ts`
 * (PD 5: structural - works on every Gen-3 base game / hack that retains
 * the published MapEvents layout).
 */

import { z } from 'zod';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import type {
  AgentPatchEdit,
  AgentPatchProposal,
  BinaryWriteBytesEdit,
  BinaryRewritePointerEdit,
  MapNode,
  ProjectManifest,
} from '@rom-editor/shared';
import { rom as romApi } from '@rom-introspection/engine';
import { readManifest } from '../../scan/manifest-io.js';
import type { ToolContext } from '../types.js';
import { proposePatch, ProposePatchError } from './propose-patch.js';

export const PROPOSE_ADD_OBJECT_EVENT_TOOL_NAME = 'propose_add_object_event';

export const PROPOSE_ADD_OBJECT_EVENT_DESCRIPTION =
  "Add a brand-new ObjectEvent (NPC / trainer / sign-NPC / berry tree) " +
  "to a map. Gen-3 maps store their ObjectEvents in a flat array pointed " +
  "to by the map's MapEvents struct; this tool relocates the array to " +
  "fresh free-ROM space with one extra 24-byte slot, writes the new " +
  "ObjectEventTemplate, repoints the MapEvents pointer, and bumps the " +
  "count byte.\n\n" +
  'Inputs:\n' +
  '  - `mapId`: the map id (e.g. `binary_map_3_19` for FRLG Route 1).\n' +
  '  - `x`, `y`: tile coordinates on the map (0-based).\n' +
  '  - `graphicsId`: the OBJ_EVENT_GFX_* byte (0..255).\n' +
  '  - `movementType`: optional. Either a number 0..255 OR a symbolic\n' +
  '    name like `"MOVEMENT_TYPE_FACE_RIGHT"`. Prefer symbolic - the\n' +
  '    numeric values follow pret/pokefirered\'s constants where\n' +
  '    FACE_DOWN=9, FACE_UP=10, FACE_LEFT=11, FACE_RIGHT=12; mixing them\n' +
  '    up is a common source of "NPC faces the wrong way" bugs.\n' +
  '    Default 0 = MOVEMENT_TYPE_NONE (static, facing down at spawn).\n' +
  '  - `elevation`: optional 0..15 (default 3 = ground level on most maps).\n' +
  '  - `trainerType`: optional 0..255 - set to 1 (single-line sight) or 3\n' +
  '    (see-all-directions) to make this a battling trainer. The new NPC\n' +
  '    will only initiate a trainer battle if a trainer-battle script is\n' +
  '    bound to it (use `propose_add_script_for_trainer` after this).\n' +
  '  - `trainerSightRange`: optional 0..255 (default 0). Sight in tiles\n' +
  '    when `trainerType` > 0; ignored otherwise.\n' +
  '  - `flagId`: optional u16 - flag that hides this NPC when set\n' +
  '    (default 0 = always visible).\n' +
  '  - `localId`: optional u8 - explicit local id (default = max existing\n' +
  '    + 1). Must be unique within the map.\n\n' +
  'Returns the new ObjectEvent\'s `localId` + its 24-byte struct file ' +
  'offset so a follow-up `propose_add_script_for_trainer` call can bind ' +
  'a script to it.';

const u8 = z.number().int().min(0).max(0xff);
const u16 = z.number().int().min(0).max(0xffff);
const tileCoord = z.number().int().min(0).max(0x7fff);

/** Movement-type input: number 0..255 OR symbolic name like
 *  "MOVEMENT_TYPE_FACE_RIGHT". String resolution happens at the
 *  function-body layer via {@link resolveMovementType}. */
const movementTypeInput = z.union([u8, z.string().min(1).max(64)]);

export const proposeAddObjectEventInputShape = {
  mapId: z.string().min(1),
  x: tileCoord,
  y: tileCoord,
  graphicsId: u8,
  movementType: movementTypeInput.optional(),
  elevation: u8.optional(),
  trainerType: u8.optional(),
  trainerSightRange: u8.optional(),
  flagId: u16.optional(),
  localId: u8.optional(),
  description: z.string().min(1).max(500).optional(),
} as const;

export interface ProposeAddObjectEventResult {
  readonly proposal: AgentPatchProposal | null;
  readonly mapId: string;
  readonly newLocalId: number | null;
  readonly newObjectEventOffset: number | null;
  readonly oldCount: number;
  readonly newCount: number;
  readonly oldArrayOffset: number | null;
  readonly newArrayOffset: number | null;
  readonly message: string;
}

const OBJECT_EVENT_STRUCT_SIZE = 24;
const GBA_ROM_BASE = 0x08000000;

/** Canonical pret/pokefirered MOVEMENT_TYPE_* mapping. Cited at
 *  `app/frontend/src/lib/displayName.ts:107-168` (the source of truth).
 *  These are the byte values the GBA engine interprets at runtime - 
 *  CFRU's source-side enum renaming does NOT change the runtime
 *  numbering. Hand-aligned with pret's `include/constants/
 *  event_object_movement.h`.
 *
 *  Hot zone (most common; common source of FACE_UP↔FACE_RIGHT mixups):
 *    FACE_DOWN=9, FACE_UP=10, FACE_LEFT=11, FACE_RIGHT=12. */
const MOVEMENT_TYPE_NAME_VALUES: Readonly<Record<string, number>> = Object.freeze({
  MOVEMENT_TYPE_NONE: 0,
  MOVEMENT_TYPE_LOOK_AROUND: 1,
  MOVEMENT_TYPE_WANDER_AROUND: 2,
  MOVEMENT_TYPE_WANDER_LEFT_AND_RIGHT: 3,
  MOVEMENT_TYPE_WANDER_UP_AND_DOWN: 4,
  MOVEMENT_TYPE_WANDER_UP: 5,
  MOVEMENT_TYPE_WANDER_DOWN: 6,
  MOVEMENT_TYPE_WANDER_LEFT: 7,
  MOVEMENT_TYPE_WANDER_RIGHT: 8,
  MOVEMENT_TYPE_FACE_DOWN: 9,
  MOVEMENT_TYPE_FACE_UP: 10,
  MOVEMENT_TYPE_FACE_LEFT: 11,
  MOVEMENT_TYPE_FACE_RIGHT: 12,
  MOVEMENT_TYPE_PLAYER: 13,
  MOVEMENT_TYPE_BERRY_TREE_GROWTH: 14,
  MOVEMENT_TYPE_FACE_DOWN_AND_UP: 15,
  MOVEMENT_TYPE_FACE_LEFT_AND_RIGHT: 16,
  MOVEMENT_TYPE_FACE_UP_AND_LEFT: 17,
  MOVEMENT_TYPE_FACE_UP_AND_RIGHT: 18,
  MOVEMENT_TYPE_FACE_DOWN_AND_LEFT: 19,
  MOVEMENT_TYPE_FACE_DOWN_AND_RIGHT: 20,
  MOVEMENT_TYPE_FACE_DOWN_UP_AND_LEFT: 21,
  MOVEMENT_TYPE_FACE_DOWN_UP_AND_RIGHT: 22,
  MOVEMENT_TYPE_FACE_UP_LEFT_AND_RIGHT: 23,
  MOVEMENT_TYPE_FACE_DOWN_LEFT_AND_RIGHT: 24,
  MOVEMENT_TYPE_ROTATE_COUNTERCLOCKWISE: 25,
  MOVEMENT_TYPE_ROTATE_CLOCKWISE: 26,
  MOVEMENT_TYPE_WALK_UP_AND_DOWN: 27,
  MOVEMENT_TYPE_WALK_DOWN_AND_UP: 28,
  MOVEMENT_TYPE_WALK_LEFT_AND_RIGHT: 29,
  MOVEMENT_TYPE_WALK_RIGHT_AND_LEFT: 30,
  MOVEMENT_TYPE_WALK_IN_PLACE_DOWN: 31,
  MOVEMENT_TYPE_WALK_IN_PLACE_UP: 32,
  MOVEMENT_TYPE_WALK_IN_PLACE_LEFT: 33,
  MOVEMENT_TYPE_WALK_IN_PLACE_RIGHT: 34,
  MOVEMENT_TYPE_JOG_IN_PLACE_DOWN: 35,
  MOVEMENT_TYPE_JOG_IN_PLACE_UP: 36,
  MOVEMENT_TYPE_JOG_IN_PLACE_LEFT: 37,
  MOVEMENT_TYPE_JOG_IN_PLACE_RIGHT: 38,
  MOVEMENT_TYPE_RUN_IN_PLACE_DOWN: 39,
  MOVEMENT_TYPE_RUN_IN_PLACE_UP: 40,
  MOVEMENT_TYPE_RUN_IN_PLACE_LEFT: 41,
  MOVEMENT_TYPE_RUN_IN_PLACE_RIGHT: 42,
  MOVEMENT_TYPE_HIDDEN: 51,
  MOVEMENT_TYPE_TREE_DISGUISE: 52,
  MOVEMENT_TYPE_MOUNTAIN_DISGUISE: 53,
  MOVEMENT_TYPE_COOLTRAINER_DISGUISE: 54,
  MOVEMENT_TYPE_HIDDEN_BOY: 55,
  MOVEMENT_TYPE_HIDDEN_GIRL: 56,
  MOVEMENT_TYPE_BURIED: 60,
});

/** Resolve a movementType input (symbolic name or raw number) to a
 *  byte. Returns `{ value }` on success or `{ error }` with a helpful
 *  diagnostic. Used by {@link proposeAddObjectEvent} at the top of
 *  the function so errors surface before any ROM work happens. */
export function resolveMovementType(
  input: number | string | undefined,
): { value: number } | { error: string } {
  if (input === undefined) return { value: 0 };
  if (typeof input === 'number') {
    if (!Number.isInteger(input) || input < 0 || input > 0xff) {
      return { error: `movementType ${String(input)} is out of range - must be an integer 0..255.` };
    }
    return { value: input };
  }
  // Symbolic name. Accept "MOVEMENT_TYPE_FACE_RIGHT" or just "FACE_RIGHT".
  let normalized = input.trim().toUpperCase().replace(/[\s\-]/g, '_');
  if (!normalized.startsWith('MOVEMENT_TYPE_')) {
    normalized = `MOVEMENT_TYPE_${normalized}`;
  }
  const v = MOVEMENT_TYPE_NAME_VALUES[normalized];
  if (typeof v === 'number') return { value: v };
  return {
    error:
      `Unknown movement type '${input}'. Common values: ` +
      `MOVEMENT_TYPE_NONE (0), MOVEMENT_TYPE_FACE_DOWN (9), ` +
      `MOVEMENT_TYPE_FACE_UP (10), MOVEMENT_TYPE_FACE_LEFT (11), ` +
      `MOVEMENT_TYPE_FACE_RIGHT (12), MOVEMENT_TYPE_LOOK_AROUND (1), ` +
      `MOVEMENT_TYPE_WANDER_AROUND (2). Or pass a number 0..255.`,
  };
}

/** In-batch free-space tracker - claims allocated bytes in a working
 *  copy so consecutive `findFreeRomSpace` calls don't overlap. Mirrors
 *  propose-script-edit.ts's allocator. */
class InBatchAllocator {
  private readonly working: Uint8Array;
  /** Map of allocation start offset → fillByte returned by the
   *  underlying scanner. Used so beforeBytes generation matches what
   *  the applier will see (0xff vs 0x00 in CFRU-zeroed regions). */
  private readonly fillBytes = new Map<number, number>();
  constructor(romBytes: Uint8Array) {
    this.working = new Uint8Array(romBytes);
  }
  allocate(size: number): number | null {
    if (size <= 0) return null;
    const r = romApi.findFreeRomSpace(this.working, size);
    if (!r) return null;
    for (let i = 0; i < size; i++) this.working[r.offset + i] = 0xaa;
    this.fillBytes.set(r.offset, r.fillByte);
    return r.offset;
  }
  /** Get the fillByte the scanner found at the given allocation offset.
   *  Returns 0xff as a safe default for any offset this allocator did
   *  not produce (preserves prior behavior). */
  fillByteAt(offset: number): number {
    return this.fillBytes.get(offset) ?? 0xff;
  }
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

function findMap(manifest: ProjectManifest, id: string): MapNode | null {
  for (const m of manifest.maps) {
    if (m.id === id) return m;
  }
  return null;
}

function bytesToHex(bytes: Uint8Array | Buffer): string {
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i]!.toString(16).padStart(2, '0');
  }
  return out;
}

/** Encode a single 24-byte ObjectEventTemplate. Layout per
 *  `engine/src/maps/events.ts` (OBJECT_EVENT_STRUCT_SIZE_BYTES=24):
 *
 *   +0x00 u8  localId
 *   +0x01 u8  graphicsId
 *   +0x02 u8  inConnection (always 0 for new NPCs)
 *   +0x03 u8  padding (0)
 *   +0x04 s16 x
 *   +0x06 s16 y
 *   +0x08 u8  elevation
 *   +0x09 u8  movementType
 *   +0x0a u8  movementRangeXY (packed nibbles)
 *   +0x0b u8  padding (0)
 *   +0x0c u16 trainerType
 *   +0x0e u16 trainerRange / sight / berry-tree id
 *   +0x10 u32 scriptPointer (NULL = no script)
 *   +0x14 u16 flagId
 *   +0x16 u16 padding (0)
 */
function buildObjectEventBytes(args: {
  localId: number;
  graphicsId: number;
  x: number;
  y: number;
  elevation: number;
  movementType: number;
  trainerType: number;
  trainerSightRange: number;
  flagId: number;
}): Uint8Array {
  const b = new Uint8Array(OBJECT_EVENT_STRUCT_SIZE);
  b[0x00] = args.localId & 0xff;
  b[0x01] = args.graphicsId & 0xff;
  b[0x02] = 0; // inConnection
  b[0x03] = 0; // padding
  b[0x04] = args.x & 0xff;
  b[0x05] = (args.x >>> 8) & 0xff;
  b[0x06] = args.y & 0xff;
  b[0x07] = (args.y >>> 8) & 0xff;
  b[0x08] = args.elevation & 0xff;
  b[0x09] = args.movementType & 0xff;
  // movementRangeXY high nibble = X, low nibble = Y. For trainers the
  // sight range lives in the trainerSightOrBerryTreeId u16 instead, so
  // wander range stays 0 for trainers. Future iter: expose explicitly.
  b[0x0a] = 0;
  b[0x0b] = 0;
  b[0x0c] = args.trainerType & 0xff;
  b[0x0d] = (args.trainerType >>> 8) & 0xff;
  b[0x0e] = args.trainerSightRange & 0xff;
  b[0x0f] = (args.trainerSightRange >>> 8) & 0xff;
  // scriptPointer @ +0x10..+0x13 = NULL - caller binds a script via
  // propose_add_script_for_trainer in a follow-up proposal.
  b[0x10] = 0;
  b[0x11] = 0;
  b[0x12] = 0;
  b[0x13] = 0;
  b[0x14] = args.flagId & 0xff;
  b[0x15] = (args.flagId >>> 8) & 0xff;
  b[0x16] = 0;
  b[0x17] = 0;
  return b;
}

/** Pick the next free localId given the set of already-used ids.
 *  Local IDs in Gen-3 are 1-based (0 is reserved for the player). When
 *  `requested` is supplied, returns it iff free, else null. */
function pickLocalId(used: ReadonlySet<number>, requested?: number): number | null {
  if (requested !== undefined) {
    if (used.has(requested)) return null;
    return requested;
  }
  for (let id = 1; id <= 0xff; id++) {
    if (!used.has(id)) return id;
  }
  return null;
}

/** Read the localId byte at the start of each existing 24-byte
 *  ObjectEventTemplate in the array. */
function readExistingLocalIds(
  romBytes: Uint8Array,
  arrayOffset: number,
  count: number,
): Set<number> {
  const out = new Set<number>();
  for (let i = 0; i < count; i++) {
    const off = arrayOffset + i * OBJECT_EVENT_STRUCT_SIZE;
    if (off >= romBytes.length) break;
    out.add(romBytes[off] ?? 0);
  }
  return out;
}

export async function proposeAddObjectEvent(
  ctx: ToolContext,
  args: {
    mapId: string;
    x: number;
    y: number;
    graphicsId: number;
    movementType?: number | string;
    elevation?: number;
    trainerType?: number;
    trainerSightRange?: number;
    flagId?: number;
    localId?: number;
    description?: string;
  },
  deps: { fetchFn?: typeof fetch } = {},
): Promise<ProposeAddObjectEventResult> {
  const empty: Omit<ProposeAddObjectEventResult, 'message'> = {
    proposal: null,
    mapId: args.mapId,
    newLocalId: null,
    newObjectEventOffset: null,
    oldCount: 0,
    newCount: 0,
    oldArrayOffset: null,
    newArrayOffset: null,
  };

  // Resolve symbolic movementType (e.g. "MOVEMENT_TYPE_FACE_RIGHT") to
  // a byte BEFORE any ROM work, so a typo or unknown name surfaces a
  // clear error instead of writing a bogus value. Numeric input is
  // validated against [0..255] here too.
  const movementResolved = resolveMovementType(args.movementType);
  if ('error' in movementResolved) {
    return { ...empty, message: movementResolved.error };
  }
  const resolvedMovementType = movementResolved.value;

  const manifest = await readManifest(ctx.projectRoot);
  if (!manifest) {
    return { ...empty, message: `No manifest at '${ctx.projectRoot}/.editor/manifest.json'. Open + scan a project first.` };
  }
  const map = findMap(manifest, args.mapId);
  if (!map) {
    return {
      ...empty,
      message: `Map '${args.mapId}' not in manifest.maps[] (${manifest.maps.length} maps). Use list_entities({ kind: 'map' }) to discover valid ids.`,
    };
  }
  const meta = map.metadata ?? {};
  const eventsStructOffset =
    typeof meta['binaryRomMapEventsStructOffset'] === 'number'
      ? (meta['binaryRomMapEventsStructOffset'] as number)
      : -1;
  if (eventsStructOffset <= 0) {
    return {
      ...empty,
      message: `Map '${args.mapId}' has no binary-rom MapEvents struct offset in metadata - either the map has no events table (vanilla empty interior) or this isn't a binary-rom workspace.`,
    };
  }

  const rom = await findRomFile(ctx.projectRoot);
  if (!rom) {
    return { ...empty, message: `No .gba ROM found at '${ctx.projectRoot}'.` };
  }
  if (eventsStructOffset + 0x14 > rom.bytes.length) {
    return {
      ...empty,
      message: `MapEvents struct offset 0x${eventsStructOffset.toString(16)} + 20 runs past end of ROM (length 0x${rom.bytes.length.toString(16)}).`,
    };
  }

  // Read the current ObjectEvent count + array pointer from the MapEvents struct.
  const oldCount = rom.bytes[eventsStructOffset] ?? 0;
  if (oldCount >= 0xff) {
    return {
      ...empty,
      message: `Map '${args.mapId}' already has ${String(oldCount)} ObjectEvents - count byte is at u8 max, cannot add more without restructuring.`,
    };
  }
  const ptrOffset = eventsStructOffset + 0x04;
  const ptrRaw =
    ((rom.bytes[ptrOffset] ?? 0) |
      ((rom.bytes[ptrOffset + 1] ?? 0) << 8) |
      ((rom.bytes[ptrOffset + 2] ?? 0) << 16) |
      ((rom.bytes[ptrOffset + 3] ?? 0) << 24)) >>>
    0;
  const oldArrayOffset = oldCount > 0 ? ptrRaw - GBA_ROM_BASE : null;
  if (oldCount > 0) {
    const highByte = (ptrRaw >>> 24) & 0xff;
    if (highByte !== 0x08 && highByte !== 0x09) {
      return {
        ...empty,
        oldCount,
        message: `Map '${args.mapId}' MapEvents.objectEventsPointer 0x${ptrRaw.toString(16)} is not a valid GBA ROM pointer.`,
      };
    }
    if (oldArrayOffset === null || oldArrayOffset + oldCount * OBJECT_EVENT_STRUCT_SIZE > rom.bytes.length) {
      return {
        ...empty,
        oldCount,
        message: `Map '${args.mapId}' ObjectEvent array 0x${oldArrayOffset!.toString(16)} + ${String(oldCount * OBJECT_EVENT_STRUCT_SIZE)} runs past end of ROM.`,
      };
    }
  }

  const newCount = oldCount + 1;
  const usedLocalIds = oldCount > 0 && oldArrayOffset !== null
    ? readExistingLocalIds(rom.bytes, oldArrayOffset, oldCount)
    : new Set<number>();
  const newLocalId = pickLocalId(usedLocalIds, args.localId);
  if (newLocalId === null) {
    return {
      ...empty,
      oldCount,
      message:
        args.localId !== undefined
          ? `localId ${String(args.localId)} is already in use on map '${args.mapId}'. Omit localId to auto-pick the next free slot.`
          : `Map '${args.mapId}' already uses every localId 1..255 - cannot add another ObjectEvent.`,
    };
  }

  // Build the new ObjectEvent.
  const newEventBytes = buildObjectEventBytes({
    localId: newLocalId,
    graphicsId: args.graphicsId,
    x: args.x,
    y: args.y,
    elevation: args.elevation ?? 3,
    movementType: resolvedMovementType,
    trainerType: args.trainerType ?? 0,
    trainerSightRange: args.trainerSightRange ?? 0,
    flagId: args.flagId ?? 0,
  });

  // Allocate (newCount × 24) bytes in free space for the relocated array.
  const allocator = new InBatchAllocator(rom.bytes);
  const newArrayByteLength = newCount * OBJECT_EVENT_STRUCT_SIZE;
  const newArrayOffset = allocator.allocate(newArrayByteLength);
  if (newArrayOffset === null) {
    return {
      ...empty,
      oldCount,
      oldArrayOffset,
      message: `No free ROM space for ${String(newArrayByteLength)} bytes (relocated ObjectEvent array, ${String(newCount)} entries).`,
    };
  }

  // Assemble the new array contents: old entries verbatim, new entry appended.
  const newArrayBytes = new Uint8Array(newArrayByteLength);
  if (oldCount > 0 && oldArrayOffset !== null) {
    newArrayBytes.set(
      rom.bytes.subarray(oldArrayOffset, oldArrayOffset + oldCount * OBJECT_EVENT_STRUCT_SIZE),
      0,
    );
  }
  newArrayBytes.set(newEventBytes, oldCount * OBJECT_EVENT_STRUCT_SIZE);

  const edits: AgentPatchEdit[] = [];

  // 1. Write the new (relocated) ObjectEvent array into free space.
  //    beforeBytes uses the allocator's actual fillByte so the apply
  //    guard matches what's on disk (CFRU-modernized ROMs may have
  //    0x00 fill instead of 0xff in the chosen free region).
  edits.push({
    kind: 'binary_write_bytes',
    offset: newArrayOffset,
    beforeBytes: bytesToHex(new Uint8Array(newArrayByteLength).fill(allocator.fillByteAt(newArrayOffset))),
    afterBytes: bytesToHex(newArrayBytes),
    requireFreeSlot: true,
    note: `allocate relocated ObjectEvent array (${String(newCount)} entries, ${String(newArrayByteLength)} bytes) for map ${args.mapId}`,
  } satisfies BinaryWriteBytesEdit);

  // 2. Bump the count byte @ MapEvents+0x00.
  edits.push({
    kind: 'binary_write_bytes',
    offset: eventsStructOffset,
    beforeBytes: oldCount.toString(16).padStart(2, '0'),
    afterBytes: newCount.toString(16).padStart(2, '0'),
    note: `bump ObjectEvent count ${String(oldCount)} → ${String(newCount)} for map ${args.mapId}`,
  } satisfies BinaryWriteBytesEdit);

  // 3. Repoint MapEvents.objectEventsPointer @ MapEvents+0x04.
  if (oldCount > 0 && oldArrayOffset !== null) {
    edits.push({
      kind: 'binary_rewrite_pointer',
      pointerOffset: ptrOffset,
      beforeTargetOffset: oldArrayOffset,
      afterTargetOffset: newArrayOffset,
      note: `repoint MapEvents.objectEventsPointer for map ${args.mapId}`,
    } satisfies BinaryRewritePointerEdit);
  } else {
    // Empty-array case: the existing pointer is NULL (0x00000000), not
    // a GBA ROM pointer, so binary_rewrite_pointer (which validates the
    // before as `target + 0x08000000`) would refuse. Fall back to a
    // raw 4-byte write.
    const newPtrLE = new Uint8Array(4);
    const newPtr = (newArrayOffset + GBA_ROM_BASE) >>> 0;
    newPtrLE[0] = newPtr & 0xff;
    newPtrLE[1] = (newPtr >>> 8) & 0xff;
    newPtrLE[2] = (newPtr >>> 16) & 0xff;
    newPtrLE[3] = (newPtr >>> 24) & 0xff;
    const beforePtrBytes = rom.bytes.subarray(ptrOffset, ptrOffset + 4);
    edits.push({
      kind: 'binary_write_bytes',
      offset: ptrOffset,
      beforeBytes: bytesToHex(beforePtrBytes),
      afterBytes: bytesToHex(newPtrLE),
      note: `set MapEvents.objectEventsPointer (was NULL - first ObjectEvent on map ${args.mapId})`,
    } satisfies BinaryWriteBytesEdit);
  }

  // 4. Wipe the abandoned old array slot to 0xFF (purely cosmetic - the
  //    map's pointer no longer references it, but stale data confuses
  //    future scans). Skipped when count was 0.
  if (oldCount > 0 && oldArrayOffset !== null) {
    const oldArrayBytes = rom.bytes.subarray(oldArrayOffset, oldArrayOffset + oldCount * OBJECT_EVENT_STRUCT_SIZE);
    edits.push({
      kind: 'binary_write_bytes',
      offset: oldArrayOffset,
      beforeBytes: bytesToHex(oldArrayBytes),
      afterBytes: bytesToHex(new Uint8Array(oldArrayBytes.length).fill(0xff)),
      note: `clear abandoned ObjectEvent array @ 0x${oldArrayOffset.toString(16)} (relocated for map ${args.mapId})`,
    } satisfies BinaryWriteBytesEdit);
  }

  const description =
    args.description ??
    `Add ObjectEvent (localId=${String(newLocalId)}, gfx=${String(args.graphicsId)}) at (${String(args.x)},${String(args.y)}) on ${args.mapId}`;

  let proposal: AgentPatchProposal;
  try {
    proposal = await proposePatch(ctx, { description, edits }, deps);
  } catch (e) {
    if (e instanceof ProposePatchError) {
      return {
        ...empty,
        oldCount,
        oldArrayOffset,
        newCount,
        newArrayOffset,
        newLocalId,
        newObjectEventOffset: newArrayOffset + oldCount * OBJECT_EVENT_STRUCT_SIZE,
        message: `Failed to register proposal: ${e.message}`,
      };
    }
    throw e;
  }

  const newObjectEventOffset = newArrayOffset + oldCount * OBJECT_EVENT_STRUCT_SIZE;
  return {
    proposal,
    mapId: args.mapId,
    newLocalId,
    newObjectEventOffset,
    oldCount,
    newCount,
    oldArrayOffset,
    newArrayOffset,
    message:
      `Proposed adding ObjectEvent (localId=${String(newLocalId)}) at (${String(args.x)},${String(args.y)}) on ${args.mapId}. ` +
      `Array relocated 0x${(oldArrayOffset ?? 0).toString(16)} → 0x${newArrayOffset.toString(16)} (${String(oldCount)} → ${String(newCount)} entries). ` +
      `Review the diff and click Apply.`,
  };
}
