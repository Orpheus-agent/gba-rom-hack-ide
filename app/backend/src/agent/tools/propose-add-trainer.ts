/**
 * propose_add_trainer - claim a new slot in the gTrainers table.
 *
 * Gen-3 trainers live in a flat array of 40-byte Trainer structs
 * (`gTrainers`, see `engine/src/trainers/trainer.ts`). The array has no
 * explicit count field - the engine just indexes it by trainerId, and
 * the engine's hardcoded LDR references to `gTrainers` make table-level
 * relocation impractical without rewriting ASM.
 *
 * The conservative + always-safe path: append a 40-byte struct in-place
 * iff the slot immediately past the last existing trainer is fill bytes
 * (0xFF/0x00). Vanilla FRLG has 743 trainers and the slot after them is
 * always fill, so this works on every untouched ROM and on most hacks.
 *
 * The new trainer's party (1..6 members, 8 or 16 bytes per member per
 * partyFlags) is allocated in fresh free-ROM space and its pointer is
 * stored in the trainer struct's `partyPointer` (+0x24).
 *
 * Emits:
 *   - 1× `binary_write_bytes` for the party array (free-space mode)
 *   - 1× `binary_write_bytes` for the 40-byte trainer struct (free-space
 *     mode, appended at tableEndExclusive)
 *
 * Returns the new trainerId (= old trainer count) so the caller can
 * chain `propose_add_script_for_trainer` to bind this trainer to an
 * ObjectEvent's script.
 */

import { z } from 'zod';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import type {
  AgentPatchEdit,
  AgentPatchProposal,
  BinaryWriteBytesEdit,
  ProjectManifest,
} from '@rom-editor/shared';
import { rom as romApi, text as textApi } from '@rom-introspection/engine';
import { readManifest } from '../../scan/manifest-io.js';
import type { ToolContext } from '../types.js';
import { proposePatch, ProposePatchError } from './propose-patch.js';

export const PROPOSE_ADD_TRAINER_TOOL_NAME = 'propose_add_trainer';

export const PROPOSE_ADD_TRAINER_DESCRIPTION =
  "Add a brand-new trainer to the Gen-3 gTrainers table. The new " +
  "trainer gets a freshly-allocated party array (1..6 Pokémon) and is " +
  "appended past the last existing trainer struct. The append is " +
  "rejected when the bytes immediately past the table are not free " +
  "(0xFF/0x00) - the engine's hardcoded LDR references to gTrainers " +
  "make table-level relocation impractical from here.\n\n" +
  "Inputs:\n" +
  "  - `name`: trainer's display name (≤ 11 ASCII chars; Gen-3 text " +
  "    codec encodes it + appends a 0xFF terminator).\n" +
  "  - `trainerClass`: u8 - index into gTrainerClassNames (default 0).\n" +
  "  - `party`: array of 1..6 party members `{ speciesId, level, " +
  "    moveIds?, heldItemId? }`. `moveIds` triggers CUSTOM_MOVES " +
  "    partyFlag (16-byte members); `heldItemId` triggers HELD_ITEM\n" +
  "    partyFlag.\n" +
  "  - `aiFlags`: optional u16 (default 7 = check_bad_move +\n" +
  "    try_to_faint + check_viability; the vanilla \"smart trainer\"\n" +
  "    bundle).\n" +
  "  - `encounterMusic`: optional u8 (default 0). High bit (0x80) = female.\n" +
  "  - `trainerPic`: optional u8 - index into gTrainerFrontPicTable.\n" +
  "  - `doubleBattle`: optional bool (default false).\n" +
  "  - `items`: optional length-4 u16 array (held items the AI uses\n" +
  "    during battle - only meaningful when HELD_ITEM partyFlag set).\n\n" +
  "Returns the new trainerId so the caller can bind it to an NPC via " +
  "propose_add_script_for_trainer.";

const u8 = z.number().int().min(0).max(0xff);
const u16 = z.number().int().min(0).max(0xffff);
const speciesIdSchema = z.number().int().min(1).max(2047);
const u8Level = z.number().int().min(1).max(100);

const partyMemberSchema = z.object({
  speciesId: speciesIdSchema,
  level: u8Level,
  iv: u16.optional(),
  heldItemId: u16.optional(),
  moveIds: z.array(u16).length(4).optional(),
});

export const proposeAddTrainerInputShape = {
  name: z.string().min(1).max(11),
  trainerClass: u8.optional(),
  party: z.array(partyMemberSchema).min(1).max(6),
  aiFlags: u16.optional(),
  encounterMusic: u8.optional(),
  trainerPic: u16.optional(),
  doubleBattle: z.boolean().optional(),
  items: z.array(u16).length(4).optional(),
  isFemale: z.boolean().optional(),
  description: z.string().min(1).max(500).optional(),
} as const;

export interface ProposeAddTrainerResult {
  readonly proposal: AgentPatchProposal | null;
  readonly newTrainerId: number | null;
  readonly newTrainerStructOffset: number | null;
  readonly newPartyOffset: number | null;
  readonly tableStart: number | null;
  readonly tableEndExclusive: number | null;
  readonly oldTrainerCount: number;
  readonly newTrainerCount: number;
  readonly message: string;
}

const TRAINER_STRUCT_SIZE = 40;
const TRAINER_NAME_FIELD_LENGTH = 12;
const PARTY_MEMBER_SIZE_NO_MOVES = 8;
const PARTY_MEMBER_SIZE_WITH_MOVES = 16;
const F_CUSTOM_MOVES = 0x01;
const F_HELD_ITEM = 0x02;
const GBA_ROM_BASE = 0x08000000;

class InBatchAllocator {
  private readonly working: Uint8Array;
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

function bytesToHex(bytes: Uint8Array | Buffer): string {
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i]!.toString(16).padStart(2, '0');
  }
  return out;
}

/** Locate the trainer table by walking `manifest.trainers[]`'s
 *  `structFileOffset` metadata. Returns null when no trainers carry the
 *  offset (decomp project) or the offsets aren't contiguous. */
function locateTrainerTable(
  manifest: ProjectManifest,
): { tableStart: number; tableEndExclusive: number; trainerCount: number } | null {
  const offsets: number[] = [];
  for (const t of manifest.trainers) {
    const meta = t.metadata ?? {};
    const off = meta['structFileOffset'];
    if (typeof off === 'number' && Number.isFinite(off) && off > 0) {
      offsets.push(off);
    }
  }
  if (offsets.length === 0) return null;
  offsets.sort((a, b) => a - b);
  // Sanity check: contiguous, stride 40.
  for (let i = 1; i < offsets.length; i++) {
    if (offsets[i]! - offsets[i - 1]! !== TRAINER_STRUCT_SIZE) {
      // Non-contiguous offsets - the lifter ordering may not be insertion
      // order, but the trainer scanner only ever produces a contiguous
      // run. If we hit this branch the manifest is unusual; bail.
      return null;
    }
  }
  const tableStart = offsets[0]!;
  const tableEndExclusive = offsets[offsets.length - 1]! + TRAINER_STRUCT_SIZE;
  return { tableStart, tableEndExclusive, trainerCount: offsets.length };
}

/** Encode an ASCII trainer name into the 12-byte Gen-3 name field
 *  (terminator 0xFF, padded with 0xFF). */
function encodeTrainerName(name: string): Uint8Array {
  // The Gen-3 text codec encodes ASCII letters/digits/spaces. The
  // codec throws on unencodable chars - surface that to the caller.
  const encoded = textApi.encodeString(name);
  if (encoded.length > TRAINER_NAME_FIELD_LENGTH - 1) {
    throw new Error(
      `Trainer name "${name}" encodes to ${String(encoded.length)} bytes; the 12-byte name field needs room for a 0xFF terminator (max 11 chars).`,
    );
  }
  const out = new Uint8Array(TRAINER_NAME_FIELD_LENGTH).fill(0xff);
  out.set(encoded, 0);
  // 0xFF terminator already in place from fill.
  return out;
}

interface NormalizedPartyMember {
  speciesId: number;
  level: number;
  iv: number;
  heldItemId: number;
  moveIds: readonly number[];
}

/** Encode a single party member to its kind-appropriate struct. */
function encodePartyMember(
  m: NormalizedPartyMember,
  hasCustomMoves: boolean,
  hasHeldItem: boolean,
): Uint8Array {
  const size = hasCustomMoves ? PARTY_MEMBER_SIZE_WITH_MOVES : PARTY_MEMBER_SIZE_NO_MOVES;
  const out = new Uint8Array(size);
  // iv u16 @ +0
  out[0] = m.iv & 0xff;
  out[1] = (m.iv >>> 8) & 0xff;
  // level u16 @ +2 (engine writes u16 but uses only low byte; 0..100)
  out[2] = m.level & 0xff;
  out[3] = (m.level >>> 8) & 0xff;
  // species u16 @ +4
  out[4] = m.speciesId & 0xff;
  out[5] = (m.speciesId >>> 8) & 0xff;
  // u16 @ +6: heldItem when HELD_ITEM flag, else padding
  const sixSeven = hasHeldItem ? m.heldItemId : 0;
  out[6] = sixSeven & 0xff;
  out[7] = (sixSeven >>> 8) & 0xff;
  if (hasCustomMoves) {
    // moves[4] u16 each @ +8..+15
    for (let i = 0; i < 4; i++) {
      const move = m.moveIds[i] ?? 0;
      out[8 + i * 2] = move & 0xff;
      out[8 + i * 2 + 1] = (move >>> 8) & 0xff;
    }
  }
  return out;
}

/** Build the full party array bytes for the new trainer. */
function buildPartyBytes(
  members: ReadonlyArray<NormalizedPartyMember>,
  hasCustomMoves: boolean,
  hasHeldItem: boolean,
): Uint8Array {
  const memberSize = hasCustomMoves ? PARTY_MEMBER_SIZE_WITH_MOVES : PARTY_MEMBER_SIZE_NO_MOVES;
  const out = new Uint8Array(members.length * memberSize);
  for (let i = 0; i < members.length; i++) {
    out.set(encodePartyMember(members[i]!, hasCustomMoves, hasHeldItem), i * memberSize);
  }
  return out;
}

/** Build a 40-byte Trainer struct. Layout per
 *  `engine/src/trainers/trainer.ts` (TRAINER_STRUCT_SIZE_BYTES=40):
 *
 *   +0x00 u8       partyFlags
 *   +0x01 u8       trainerClass
 *   +0x02 u8       encounterMusic_gender (top bit = female)
 *   +0x03 u8       trainerPic
 *   +0x04 u8[12]   trainerName (0xFF terminator + pad)
 *   +0x10 u16[4]   items
 *   +0x18 u8       doubleBattle (0 or 1)
 *   +0x19 u8[3]    padding (0)
 *   +0x1c u32      aiFlags
 *   +0x20 u8       partySize
 *   +0x21 u8[3]    padding (0)
 *   +0x24 u32      partyPointer (GBA pointer)
 */
function buildTrainerStruct(args: {
  partyFlags: number;
  trainerClass: number;
  encounterMusicGender: number;
  trainerPic: number;
  trainerNameBytes: Uint8Array;
  items: ReadonlyArray<number>;
  doubleBattle: boolean;
  aiFlags: number;
  partySize: number;
  partyPointerOffset: number;
}): Uint8Array {
  const out = new Uint8Array(TRAINER_STRUCT_SIZE);
  out[0x00] = args.partyFlags & 0xff;
  out[0x01] = args.trainerClass & 0xff;
  out[0x02] = args.encounterMusicGender & 0xff;
  out[0x03] = args.trainerPic & 0xff;
  out.set(args.trainerNameBytes.subarray(0, TRAINER_NAME_FIELD_LENGTH), 0x04);
  for (let i = 0; i < 4; i++) {
    const item = args.items[i] ?? 0;
    out[0x10 + i * 2] = item & 0xff;
    out[0x10 + i * 2 + 1] = (item >>> 8) & 0xff;
  }
  out[0x18] = args.doubleBattle ? 1 : 0;
  // +0x19..+0x1b: padding (already 0)
  const ai = args.aiFlags >>> 0;
  out[0x1c] = ai & 0xff;
  out[0x1d] = (ai >>> 8) & 0xff;
  out[0x1e] = (ai >>> 16) & 0xff;
  out[0x1f] = (ai >>> 24) & 0xff;
  out[0x20] = args.partySize & 0xff;
  // +0x21..+0x23: padding (already 0)
  const ptr = (args.partyPointerOffset + GBA_ROM_BASE) >>> 0;
  out[0x24] = ptr & 0xff;
  out[0x25] = (ptr >>> 8) & 0xff;
  out[0x26] = (ptr >>> 16) & 0xff;
  out[0x27] = (ptr >>> 24) & 0xff;
  return out;
}

function isAllFill(bytes: Uint8Array, start: number, length: number): boolean {
  if (start + length > bytes.length) return false;
  for (let i = 0; i < length; i++) {
    const b = bytes[start + i]!;
    if (b !== 0xff && b !== 0x00) return false;
  }
  return true;
}

export async function proposeAddTrainer(
  ctx: ToolContext,
  args: {
    name: string;
    trainerClass?: number;
    party: ReadonlyArray<{
      speciesId: number;
      level: number;
      iv?: number;
      heldItemId?: number;
      moveIds?: number[];
    }>;
    aiFlags?: number;
    encounterMusic?: number;
    trainerPic?: number;
    doubleBattle?: boolean;
    items?: number[];
    isFemale?: boolean;
    description?: string;
  },
  deps: { fetchFn?: typeof fetch } = {},
): Promise<ProposeAddTrainerResult> {
  const empty: Omit<ProposeAddTrainerResult, 'message'> = {
    proposal: null,
    newTrainerId: null,
    newTrainerStructOffset: null,
    newPartyOffset: null,
    tableStart: null,
    tableEndExclusive: null,
    oldTrainerCount: 0,
    newTrainerCount: 0,
  };

  const manifest = await readManifest(ctx.projectRoot);
  if (!manifest) {
    return { ...empty, message: `No manifest at '${ctx.projectRoot}/.editor/manifest.json'. Open + scan a project first.` };
  }
  const table = locateTrainerTable(manifest);
  if (!table) {
    return {
      ...empty,
      message: `No trainer table located in manifest.trainers[] metadata (expected ${String(manifest.trainers.length)} trainers with structFileOffset). This may not be a binary-rom workspace, or the trainer-scanner didn't run.`,
    };
  }

  const rom = await findRomFile(ctx.projectRoot);
  if (!rom) {
    return { ...empty, ...table, oldTrainerCount: table.trainerCount, message: `No .gba ROM found at '${ctx.projectRoot}'.` };
  }

  // Check the 40 bytes immediately past the last existing trainer are
  // free (0xFF/0x00). If not, we'd need to relocate the entire table - 
  // not practical without rewriting hardcoded engine references.
  const appendOffset = table.tableEndExclusive;
  if (!isAllFill(rom.bytes, appendOffset, TRAINER_STRUCT_SIZE)) {
    return {
      ...empty,
      ...table,
      oldTrainerCount: table.trainerCount,
      message:
        `Cannot append a new trainer: the 40 bytes at 0x${appendOffset.toString(16)} (immediately past the last existing trainer) are not free ` +
        `(0xFF/0x00). Relocating the whole gTrainers table would require rewriting every hardcoded LDR reference in engine ASM, which this ` +
        `tool deliberately does not attempt. Workaround: free space at that offset by other means before re-running.`,
    };
  }

  // Derive partyFlags from the requested members.
  let hasCustomMoves = false;
  let hasHeldItem = false;
  for (const m of args.party) {
    if (m.moveIds !== undefined) hasCustomMoves = true;
    if (m.heldItemId !== undefined && m.heldItemId !== 0) hasHeldItem = true;
  }
  const partyFlags =
    (hasCustomMoves ? F_CUSTOM_MOVES : 0) | (hasHeldItem ? F_HELD_ITEM : 0);

  const normalizedParty: NormalizedPartyMember[] = args.party.map((m) => ({
    speciesId: m.speciesId,
    level: m.level,
    iv: m.iv ?? 0,
    heldItemId: m.heldItemId ?? 0,
    moveIds: m.moveIds ?? [0, 0, 0, 0],
  }));

  const partyBytes = buildPartyBytes(normalizedParty, hasCustomMoves, hasHeldItem);

  // Encode the trainer name.
  let trainerNameBytes: Uint8Array;
  try {
    trainerNameBytes = encodeTrainerName(args.name);
  } catch (e) {
    return {
      ...empty,
      ...table,
      oldTrainerCount: table.trainerCount,
      message: `Failed to encode trainer name: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  // Allocate party bytes in free ROM space.
  const allocator = new InBatchAllocator(rom.bytes);
  const partyOffset = allocator.allocate(partyBytes.length);
  if (partyOffset === null) {
    return {
      ...empty,
      ...table,
      oldTrainerCount: table.trainerCount,
      message: `No free ROM space for ${String(partyBytes.length)} bytes (party array, ${String(normalizedParty.length)} members × ${String(hasCustomMoves ? 16 : 8)}).`,
    };
  }

  // Build the 40-byte trainer struct.
  const encounterMusicGender =
    ((args.encounterMusic ?? 0) & 0x7f) | (args.isFemale ? 0x80 : 0);
  const trainerStructBytes = buildTrainerStruct({
    partyFlags,
    trainerClass: args.trainerClass ?? 0,
    encounterMusicGender,
    trainerPic: args.trainerPic ?? 0,
    trainerNameBytes,
    items: args.items ?? [0, 0, 0, 0],
    doubleBattle: args.doubleBattle ?? false,
    aiFlags: args.aiFlags ?? 0x07,
    partySize: normalizedParty.length,
    partyPointerOffset: partyOffset,
  });

  // Emit edits.
  const edits: AgentPatchEdit[] = [];

  // 1. Write the party array in free space. beforeBytes uses the
  //    allocator's fillByte (0xff on vanilla padding, 0x00 on
  //    CFRU-zeroed free runs) so the apply guard matches disk state.
  edits.push({
    kind: 'binary_write_bytes',
    offset: partyOffset,
    beforeBytes: bytesToHex(new Uint8Array(partyBytes.length).fill(allocator.fillByteAt(partyOffset))),
    afterBytes: bytesToHex(partyBytes),
    requireFreeSlot: true,
    note: `allocate party for new trainer "${args.name}" (${String(normalizedParty.length)} members)`,
  } satisfies BinaryWriteBytesEdit);

  // 2. Append the 40-byte trainer struct at tableEndExclusive.
  //    appendOffset is past the existing table - same fill-state caveat.
  edits.push({
    kind: 'binary_write_bytes',
    offset: appendOffset,
    beforeBytes: bytesToHex(new Uint8Array(TRAINER_STRUCT_SIZE).fill(allocator.fillByteAt(appendOffset))),
    afterBytes: bytesToHex(trainerStructBytes),
    requireFreeSlot: true,
    note: `append new trainer "${args.name}" (id=${String(table.trainerCount)}) to gTrainers @ 0x${appendOffset.toString(16)}`,
  } satisfies BinaryWriteBytesEdit);

  // The new trainer's id is just its index in the array - the table
  // has no count field; the engine indexes by id directly.
  const newTrainerId = table.trainerCount;

  const description =
    args.description ??
    `Add trainer "${args.name}" (id=${String(newTrainerId)}, class=${String(args.trainerClass ?? 0)}, party size ${String(normalizedParty.length)})`;

  let proposal: AgentPatchProposal;
  try {
    proposal = await proposePatch(ctx, { description, edits }, deps);
  } catch (e) {
    if (e instanceof ProposePatchError) {
      return {
        ...empty,
        ...table,
        oldTrainerCount: table.trainerCount,
        newTrainerCount: table.trainerCount + 1,
        newTrainerId,
        newTrainerStructOffset: appendOffset,
        newPartyOffset: partyOffset,
        message: `Failed to register proposal: ${e.message}`,
      };
    }
    throw e;
  }

  return {
    proposal,
    newTrainerId,
    newTrainerStructOffset: appendOffset,
    newPartyOffset: partyOffset,
    tableStart: table.tableStart,
    tableEndExclusive: appendOffset + TRAINER_STRUCT_SIZE,
    oldTrainerCount: table.trainerCount,
    newTrainerCount: table.trainerCount + 1,
    message:
      `Proposed adding trainer "${args.name}" as id ${String(newTrainerId)} (gTrainers grows from ${String(table.trainerCount)} to ${String(table.trainerCount + 1)} entries). ` +
      `Party allocated at 0x${partyOffset.toString(16)}. Review the diff and click Apply.`,
  };
}

