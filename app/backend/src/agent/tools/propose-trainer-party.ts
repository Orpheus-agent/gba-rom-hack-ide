import { z } from 'zod';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import type {
  AgentPatchEdit,
  AgentPatchProposal,
  BinaryWriteBytesEdit,
  ProjectManifest,
  Trainer,
} from '@rom-editor/shared';
import { readManifest } from '../../scan/manifest-io.js';
import type { ToolContext } from '../types.js';
import { proposePatch, ProposePatchError } from './propose-patch.js';

export const PROPOSE_TRAINER_PARTY_TOOL_NAME = 'propose_trainer_party';

export const PROPOSE_TRAINER_PARTY_DESCRIPTION =
  "Edit one or more party members of a trainer. The Gen-3 trainer party " +
  'struct is variable-length per the trainer\'s partyFlags bits:\n' +
  '  - partyFlags & 0x01 → CUSTOM_MOVES (16-byte struct with moves[4])\n' +
  '  - partyFlags & 0x02 → HELD_ITEM (struct includes heldItem at +6)\n' +
  'Field offsets in every variant: iv@0 (u16), level@2 (u8), species@4 ' +
  '(u16). heldItem@6 (u16) only when HELD_ITEM. moves@8 (4×u16) only when ' +
  'CUSTOM_MOVES.\n\n' +
  'Find the trainerId via list_entities({ kind: "trainer" }) or look at ' +
  'manifest.trainers[]. Pass slotIndex 0-based (the first party member is ' +
  '0, the last is partySize-1).\n\n' +
  'Common use:\n' +
  '  - "give the rival\'s first Pokémon level 100" → propose_trainer_party({ ' +
  'trainerId: "binary_trainer_5", members: [{ slotIndex: 0, level: 100 }] })\n' +
  '  - "replace gym leader\'s party with all Mewtwos" → loop members with ' +
  'speciesId=150 per slotIndex\n' +
  '  - "give Brock\'s Onix EARTHQUAKE as move 1" → moveIds[0] = 89 (only ' +
  'works on trainers with the CUSTOM_MOVES partyFlag).\n\n' +
  'Field bounds:\n' +
  '  speciesId: 1..2047\n' +
  '  level: 1..100\n' +
  '  iv: 0..65535 (raw IV value byte representation)\n' +
  '  heldItemId: 0..65535 (item index - 0 = no item)\n' +
  '  moveIds: array of exactly 4 numbers in 0..65535 (move indices; ' +
  '0 = no move). Only effective on CUSTOM_MOVES parties.\n\n' +
  'When a slot is skipped (missing fileOffset, wrong partyFlags for the ' +
  'requested fields, etc.) the reason lands in result.skipped[].';

/** partyFlags bit constants per pret/pokefirered. */
const F_CUSTOM_MOVES = 0x01;
const F_HELD_ITEM = 0x02;

/** Field offsets within the per-member struct (relative to the
 *  member's fileOffset). */
const OFF_IV = 0;
const OFF_LEVEL = 2;
const OFF_SPECIES = 4;
const OFF_HELD_ITEM = 6;
const OFF_MOVES = 8;
const MOVE_COUNT = 4;

const u8Level = z.number().int().min(1).max(100);
const u16 = z.number().int().min(0).max(0xffff);
const speciesIdSchema = z.number().int().min(1).max(2047);

// Phase 4.3G - accept either numeric ids or symbolic names. Strings
// are resolved against manifest.speciesNames / moveNames / items
// inside the tool body (the schema only validates SHAPE here).
const speciesIdOrName = z.union([speciesIdSchema, z.string().min(1).max(60)]);
const itemIdOrName = z.union([u16, z.string().min(1).max(60)]);
const moveIdOrName = z.union([u16, z.string().min(1).max(60)]);

const memberSchema = z.object({
  slotIndex: z.number().int().nonnegative(),
  speciesId: speciesIdOrName.optional(),
  level: u8Level.optional(),
  iv: u16.optional(),
  heldItemId: itemIdOrName.optional(),
  moveIds: z.array(moveIdOrName).length(MOVE_COUNT).optional(),
}).refine(
  (m) =>
    m.speciesId !== undefined ||
    m.level !== undefined ||
    m.iv !== undefined ||
    m.heldItemId !== undefined ||
    m.moveIds !== undefined,
  { message: 'Each member edit must change at least one field.' },
);

export const proposeTrainerPartyInputShape = {
  trainerId: z.string().min(1),
  members: z.array(memberSchema).min(1).max(8),
  description: z.string().min(1).max(500).optional(),
} as const;

type MemberEdit = {
  slotIndex: number;
  speciesId?: number | string;
  level?: number;
  iv?: number;
  heldItemId?: number | string;
  moveIds?: (number | string)[];
};

type ResolvedMemberEdit = {
  slotIndex: number;
  speciesId?: number;
  level?: number;
  iv?: number;
  heldItemId?: number;
  moveIds?: number[];
};

/** Resolve a `number | string` input to a numeric id by looking up the
 *  matching name in a manifest lookup table. Names match
 *  case-insensitively + ignoring common prefixes (SPECIES_, MOVE_,
 *  ITEM_). Returns null when the string doesn't resolve.
 *
 *  Strategy: normalize input + each table entry's name to a canonical
 *  form (uppercase, stripped of the kind's prefix), then compare. So
 *  "PIKACHU", "Pikachu", "pikachu", "SPECIES_PIKACHU", "species_pikachu"
 *  all match a table entry named "PIKACHU" or "SPECIES_PIKACHU".
 *
 *  Exported so sibling tools (propose-build-trainer-team) can reuse
 *  the same resolution semantics - Phase 4.3G. */
export function resolveSymbolicId(
  input: number | string,
  table: ReadonlyArray<{ name: string; id: number }>,
  prefix: string,
): number | null {
  if (typeof input === 'number') return input;
  const needle = input.trim();
  if (needle.length === 0) return null;

  const normalize = (s: string): string => {
    const upper = s.toUpperCase();
    return upper.startsWith(prefix) ? upper.slice(prefix.length) : upper;
  };

  const target = normalize(needle);
  const exact = table.find((e) => normalize(e.name) === target);
  if (exact) return exact.id;

  // Substring fallback - helps with "Pidgey" → "PIDGEY-AALOLA" style
  // variants that some hacks introduce. Conservative: only fire when
  // the substring is at least 4 chars to avoid false positives ("HI"
  // matching everything containing those two letters).
  if (target.length >= 4) {
    const sub = table.find((e) => normalize(e.name).includes(target));
    if (sub) return sub.id;
  }
  return null;
}

export interface ProposeTrainerPartyResult {
  readonly proposal: AgentPatchProposal | null;
  readonly trainerId: string;
  readonly trainerName?: string;
  readonly editedMemberCount: number;
  readonly skipped: ReadonlyArray<{ slotIndex: number; reason: string }>;
  readonly message: string;
}

async function findRomBytes(projectRoot: string): Promise<{ absPath: string; bytes: Buffer } | null> {
  try {
    const entries = await fsp.readdir(projectRoot, { withFileTypes: true });
    for (const e of entries) {
      if (e.isFile() && e.name.toLowerCase().endsWith('.gba')) {
        const absPath = path.join(projectRoot, e.name);
        const bytes = await fsp.readFile(absPath);
        return { absPath, bytes };
      }
    }
  } catch {
    return null;
  }
  return null;
}

function findTrainer(manifest: ProjectManifest, id: string): Trainer | null {
  for (const t of manifest.trainers) {
    if (t.id === id) return t;
  }
  return null;
}

function bytesToHex(bytes: Uint8Array | Buffer, start: number, length: number): string {
  let s = '';
  for (let i = 0; i < length; i++) {
    s += bytes[start + i]!.toString(16).padStart(2, '0');
  }
  return s;
}

export async function proposeTrainerParty(
  ctx: ToolContext,
  args: { trainerId: string; members: MemberEdit[]; description?: string },
  deps: { fetchFn?: typeof fetch } = {},
): Promise<ProposeTrainerPartyResult> {
  const manifest = await readManifest(ctx.projectRoot);
  if (!manifest) {
    return {
      proposal: null,
      trainerId: args.trainerId,
      editedMemberCount: 0,
      skipped: [],
      message: `No manifest at '${ctx.projectRoot}/.editor/manifest.json'.`,
    };
  }
  const trainer = findTrainer(manifest, args.trainerId);
  if (!trainer) {
    return {
      proposal: null,
      trainerId: args.trainerId,
      editedMemberCount: 0,
      skipped: [],
      message: `Trainer '${args.trainerId}' not in manifest.trainers[] (${manifest.trainers.length} trainers). Use list_entities({ kind: 'trainer' }) to discover valid ids.`,
    };
  }
  const rom = await findRomBytes(ctx.projectRoot);
  if (!rom) {
    return {
      proposal: null,
      trainerId: args.trainerId,
      trainerName: trainer.name,
      editedMemberCount: 0,
      skipped: [],
      message: `No .gba ROM found at '${ctx.projectRoot}'.`,
    };
  }

  const meta = (trainer.metadata ?? {}) as { partyFlags?: number };
  const partyFlags = typeof meta.partyFlags === 'number' ? meta.partyFlags : 0;
  const hasCustomMoves = (partyFlags & F_CUSTOM_MOVES) !== 0;
  const hasHeldItem = (partyFlags & F_HELD_ITEM) !== 0;
  const structSize = hasCustomMoves ? 16 : 8;

  // Phase 4.3G - resolve any symbolic-string inputs (speciesId,
  // heldItemId, moveIds) against the manifest's name tables before
  // proceeding. Unresolved names append a skipped entry instead of
  // throwing - the caller sees which names failed + can retry.
  const speciesTable = (manifest.speciesNames ?? []).map((n) => ({
    name: n.name,
    id: n.speciesIndex,
  }));
  const moveTable = (manifest.moveNames ?? []).map((n) => ({
    name: n.name,
    id: n.moveIndex,
  }));
  const itemTable = (manifest.items ?? []).map((n) => ({
    name: n.name,
    id: n.itemIndex,
  }));

  const resolvedMembers: ResolvedMemberEdit[] = [];
  const edits: AgentPatchEdit[] = [];
  const skipped: { slotIndex: number; reason: string }[] = [];

  for (const m of args.members) {
    const resolved: ResolvedMemberEdit = { slotIndex: m.slotIndex };
    if (m.level !== undefined) resolved.level = m.level;
    if (m.iv !== undefined) resolved.iv = m.iv;
    if (m.speciesId !== undefined) {
      const id = resolveSymbolicId(m.speciesId, speciesTable, 'SPECIES_');
      if (id === null) {
        skipped.push({
          slotIndex: m.slotIndex,
          reason: `Couldn't resolve species "${String(m.speciesId)}" against manifest.speciesNames.`,
        });
        continue;
      }
      resolved.speciesId = id;
    }
    if (m.heldItemId !== undefined) {
      const id = resolveSymbolicId(m.heldItemId, itemTable, 'ITEM_');
      if (id === null) {
        skipped.push({
          slotIndex: m.slotIndex,
          reason: `Couldn't resolve item "${String(m.heldItemId)}" against manifest.items.`,
        });
        continue;
      }
      resolved.heldItemId = id;
    }
    if (m.moveIds !== undefined) {
      const resolvedMoves: number[] = [];
      let badName: string | null = null;
      for (const mv of m.moveIds) {
        const id = resolveSymbolicId(mv, moveTable, 'MOVE_');
        if (id === null) {
          badName = String(mv);
          break;
        }
        resolvedMoves.push(id);
      }
      if (badName) {
        skipped.push({
          slotIndex: m.slotIndex,
          reason: `Couldn't resolve move "${badName}" against manifest.moveNames.`,
        });
        continue;
      }
      resolved.moveIds = resolvedMoves;
    }
    resolvedMembers.push(resolved);
  }

  for (const memberEdit of resolvedMembers) {
    const member = trainer.party[memberEdit.slotIndex];
    if (!member) {
      skipped.push({
        slotIndex: memberEdit.slotIndex,
        reason: `slot out of range (party has ${trainer.party.length} members)`,
      });
      continue;
    }
    if (member.fileOffset === undefined || member.fileOffset < 0) {
      skipped.push({
        slotIndex: memberEdit.slotIndex,
        reason: 'member has no fileOffset (decomp project or lifter cross-ref missing)',
      });
      continue;
    }
    if (memberEdit.heldItemId !== undefined && !hasHeldItem) {
      skipped.push({
        slotIndex: memberEdit.slotIndex,
        reason: `trainer has no HELD_ITEM partyFlag (partyFlags=0x${partyFlags.toString(16)}); cannot set heldItemId without restructuring the trainer's struct`,
      });
      continue;
    }
    if (memberEdit.moveIds !== undefined && !hasCustomMoves) {
      skipped.push({
        slotIndex: memberEdit.slotIndex,
        reason: `trainer has no CUSTOM_MOVES partyFlag (partyFlags=0x${partyFlags.toString(16)}); cannot set moves without restructuring`,
      });
      continue;
    }

    const offset = member.fileOffset;
    if (offset + structSize > rom.bytes.length) {
      skipped.push({
        slotIndex: memberEdit.slotIndex,
        reason: `offset 0x${offset.toString(16)} + ${structSize} runs past end of ROM`,
      });
      continue;
    }
    const beforeBytes = Buffer.from(rom.bytes.subarray(offset, offset + structSize));
    const afterBytes = Buffer.from(beforeBytes);

    // Apply mutations.
    if (memberEdit.iv !== undefined) {
      afterBytes[OFF_IV] = memberEdit.iv & 0xff;
      afterBytes[OFF_IV + 1] = (memberEdit.iv >>> 8) & 0xff;
    }
    if (memberEdit.level !== undefined) {
      afterBytes[OFF_LEVEL] = memberEdit.level & 0xff;
    }
    if (memberEdit.speciesId !== undefined) {
      afterBytes[OFF_SPECIES] = memberEdit.speciesId & 0xff;
      afterBytes[OFF_SPECIES + 1] = (memberEdit.speciesId >>> 8) & 0xff;
    }
    if (memberEdit.heldItemId !== undefined) {
      afterBytes[OFF_HELD_ITEM] = memberEdit.heldItemId & 0xff;
      afterBytes[OFF_HELD_ITEM + 1] = (memberEdit.heldItemId >>> 8) & 0xff;
    }
    if (memberEdit.moveIds !== undefined && hasCustomMoves) {
      for (let i = 0; i < MOVE_COUNT; i++) {
        const moveId = memberEdit.moveIds[i] ?? 0;
        afterBytes[OFF_MOVES + i * 2] = moveId & 0xff;
        afterBytes[OFF_MOVES + i * 2 + 1] = (moveId >>> 8) & 0xff;
      }
    }

    if (beforeBytes.equals(afterBytes)) {
      skipped.push({
        slotIndex: memberEdit.slotIndex,
        reason: 'values already match current bytes',
      });
      continue;
    }

    const noteFields: string[] = [];
    if (memberEdit.speciesId !== undefined) noteFields.push(`species=${memberEdit.speciesId}`);
    if (memberEdit.level !== undefined) noteFields.push(`level=${memberEdit.level}`);
    if (memberEdit.iv !== undefined) noteFields.push(`iv=${memberEdit.iv}`);
    if (memberEdit.heldItemId !== undefined) noteFields.push(`heldItem=${memberEdit.heldItemId}`);
    if (memberEdit.moveIds !== undefined) noteFields.push(`moves=[${memberEdit.moveIds.join(',')}]`);

    const edit: BinaryWriteBytesEdit = {
      kind: 'binary_write_bytes',
      offset,
      beforeBytes: bytesToHex(beforeBytes, 0, structSize),
      afterBytes: bytesToHex(afterBytes, 0, structSize),
      note: `trainer ${args.trainerId} party[${memberEdit.slotIndex}]: ${noteFields.join(', ')}`,
    };
    edits.push(edit);
  }

  if (edits.length === 0) {
    return {
      proposal: null,
      trainerId: args.trainerId,
      trainerName: trainer.name,
      editedMemberCount: 0,
      skipped,
      message: `No editable members - all ${args.members.length} entries were skipped (see result.skipped[]).`,
    };
  }

  const description =
    args.description ??
    `Edit ${trainer.name ?? args.trainerId} party - ${edits.length} member${edits.length === 1 ? '' : 's'}`;

  let proposal: AgentPatchProposal;
  try {
    proposal = await proposePatch(ctx, { description, edits }, deps);
  } catch (e) {
    if (e instanceof ProposePatchError) {
      return {
        proposal: null,
        trainerId: args.trainerId,
        trainerName: trainer.name,
        editedMemberCount: edits.length,
        skipped,
        message: `Failed to register proposal: ${e.message}`,
      };
    }
    throw e;
  }

  return {
    proposal,
    trainerId: args.trainerId,
    trainerName: trainer.name,
    editedMemberCount: edits.length,
    skipped,
    message: `Proposed editing ${edits.length} party member${edits.length === 1 ? '' : 's'} on ${trainer.name ?? args.trainerId}${skipped.length > 0 ? ` (${skipped.length} skipped)` : ''}. Review the diff and click Apply.`,
  };
}
