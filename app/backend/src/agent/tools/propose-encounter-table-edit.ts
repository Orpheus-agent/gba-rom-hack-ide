/**
 * WP-C1 - Encounter table editing beyond per-slot species/level.
 *
 * Gen-3 wild encounters live in two binary regions per (map, kind):
 *   1. WildPokemonInfo struct (8 bytes):
 *        +0x00 u8   encounterRate     (0..100 - % chance per step)
 *        +0x01 u8[3] padding
 *        +0x04 u32  *wildPokemon       (pointer to slot array)
 *   2. WildPokemon slot array (4 bytes × N):
 *        +0x00 u8   minLevel
 *        +0x01 u8   maxLevel
 *        +0x02 u16  species
 *
 * The slot COUNT (N) is hard-coded in the game's encounter algorithm
 * (land=12, water=5, fishing=10, rockSmash=5 in vanilla). So we CAN'T
 * "add a slot" without an ARM-asm patch - the engine loop bound won't
 * read past position N-1. What we CAN do:
 *
 *   • Edit the encounter rate (a single u8 write at infoFileOffset+0).
 *     Lets users say "wild encounters are 30% on Route 1" instead of
 *     the vanilla 25.
 *
 *   • Reorder slots (a single permuted (slotCount × 4)-byte write at
 *     slotsFileOffset). Each slot index has a fixed engine-defined
 *     spawn weight, so reordering effectively changes rarity - moving
 *     a Pokémon from slot 11 (1%) to slot 0 (20%) makes it 20× more
 *     common.
 *
 *   • Bulk-replace species (rewrite all slots' species fields with a
 *     single target - handy for challenge runs like "Magikarp-only").
 *
 * All three ops fit cleanly in a single binary_write_bytes edit (no
 * allocation, no pointer rewriting, fully reversible via the existing
 * patch-applier op-log). Pattern mirrors propose-script-edit.ts:
 * a pure `computeEncounterTableEdit()` half + a wrapping
 * `proposeEncounterTableEdit()` for the AI proposal flow.
 */

import { z } from 'zod';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import type {
  AgentPatchEdit,
  AgentPatchProposal,
  BinaryWriteBytesEdit,
  EncounterSlot,
  EncounterTable,
  ProjectManifest,
} from '@rom-editor/shared';
import { readManifest } from '../../scan/manifest-io.js';
import type { ToolContext } from '../types.js';
import { proposePatch, ProposePatchError } from './propose-patch.js';

export const PROPOSE_ENCOUNTER_TABLE_EDIT_TOOL_NAME = 'propose_encounter_table_edit';

export const PROPOSE_ENCOUNTER_TABLE_EDIT_DESCRIPTION =
  "Edit a wild-encounter table's overall rate, reorder its slots, or " +
  "bulk-replace every slot's species. Each op is a single binary_write_bytes " +
  'edit (no allocation, no pointer rewriting).\n\n' +
  "Gen-3 slot counts are hard-coded in the engine (land=12, water=5, " +
  'fishing=10, rockSmash=5). Each slot index has a fixed engine spawn ' +
  'weight, so reordering = changing rarity. Adding or removing slots ' +
  "isn't possible without ARM patches and is not supported.\n\n" +
  'Operations:\n' +
  '  setRate - write a new encounterRate (0..100) to WildPokemonInfo[0].\n' +
  '                Example: { encounterTableId, op:"setRate", encounterRate:30 }\n' +
  '  reorder - write a permutation of the existing slots. `slotOrder` is\n' +
  '                a permutation of [0..slotCount-1] indicating the new order.\n' +
  '                Example: swap slots 0 and 11 (the rarest with the commonest):\n' +
  '                { encounterTableId, op:"reorder", slotOrder:[11,1,2,3,4,5,6,7,8,9,10,0] }\n' +
  '  bulkReplaceSpecies - set every slot to a target species (preserve levels).\n' +
  '                Example: Magikarp-only Route 1:\n' +
  '                { encounterTableId, op:"bulkReplaceSpecies", speciesId:129 }\n\n' +
  'Find the encounterTableId by calling `list_entities({ kind: "encounterTable" })` ' +
  'or `read_map` on the map of interest.';

const reorderSchema = z.object({
  encounterTableId: z.string().min(1),
  op: z.literal('reorder'),
  slotOrder: z.array(z.number().int().nonnegative()).min(1).max(64),
  description: z.string().min(1).max(500).optional(),
});

const setRateSchema = z.object({
  encounterTableId: z.string().min(1),
  op: z.literal('setRate'),
  encounterRate: z.number().int().min(0).max(100),
  description: z.string().min(1).max(500).optional(),
});

const bulkSchema = z.object({
  encounterTableId: z.string().min(1),
  op: z.literal('bulkReplaceSpecies'),
  speciesId: z.number().int().min(1).max(0xffff),
  description: z.string().min(1).max(500).optional(),
});

export const proposeEncounterTableEditInputSchema = z.union([
  reorderSchema,
  setRateSchema,
  bulkSchema,
]);

export type ProposeEncounterTableEditArgs = z.infer<typeof proposeEncounterTableEditInputSchema>;

/** Flat MCP-server shape: all op-specific fields optional + checked at
 *  runtime in computeEncounterTableEdit. The MCP SDK's `inputSchema:`
 *  accepts a raw shape and wraps it in z.object internally; it doesn't
 *  accept discriminated unions directly. */
export const proposeEncounterTableEditInputShape = {
  encounterTableId: z.string().min(1),
  op: z.enum(['setRate', 'reorder', 'bulkReplaceSpecies']),
  encounterRate: z.number().int().min(0).max(100).optional(),
  slotOrder: z.array(z.number().int().nonnegative()).min(1).max(64).optional(),
  speciesId: z.number().int().min(1).max(0xffff).optional(),
  description: z.string().min(1).max(500).optional(),
} as const;

/** Normalise the flat MCP shape into the discriminated union the
 *  compute function expects. Throws if op-specific fields are missing. */
export function normaliseEncounterTableEditArgs(args: {
  encounterTableId: string;
  op: 'setRate' | 'reorder' | 'bulkReplaceSpecies';
  encounterRate?: number;
  slotOrder?: ReadonlyArray<number>;
  speciesId?: number;
  description?: string;
}): ProposeEncounterTableEditArgs {
  if (args.op === 'setRate') {
    if (typeof args.encounterRate !== 'number') {
      throw new Error('op=setRate requires encounterRate (0..100)');
    }
    return {
      encounterTableId: args.encounterTableId,
      op: 'setRate',
      encounterRate: args.encounterRate,
      ...(args.description ? { description: args.description } : {}),
    };
  }
  if (args.op === 'reorder') {
    if (!Array.isArray(args.slotOrder)) {
      throw new Error('op=reorder requires slotOrder (array of slot indices)');
    }
    return {
      encounterTableId: args.encounterTableId,
      op: 'reorder',
      slotOrder: args.slotOrder,
      ...(args.description ? { description: args.description } : {}),
    };
  }
  if (typeof args.speciesId !== 'number') {
    throw new Error('op=bulkReplaceSpecies requires speciesId');
  }
  return {
    encounterTableId: args.encounterTableId,
    op: 'bulkReplaceSpecies',
    speciesId: args.speciesId,
    ...(args.description ? { description: args.description } : {}),
  };
}

export interface EncounterTableEditComputeResult {
  readonly edits: ReadonlyArray<AgentPatchEdit>;
  readonly description: string;
  readonly encounterTableId: string;
  readonly mapId: string | null;
  readonly op: ProposeEncounterTableEditArgs['op'];
}

export type ComputeEncounterTableEditOutcome =
  | { ok: true; result: EncounterTableEditComputeResult }
  | { ok: false; code: string; message: string };

export interface ProposeEncounterTableEditResult {
  readonly proposal: AgentPatchProposal | null;
  readonly encounterTableId: string;
  readonly mapId: string | null;
  readonly op: ProposeEncounterTableEditArgs['op'];
  readonly message: string;
}

const SLOT_STRUCT_SIZE = 4;

function bytesToHex(bytes: Uint8Array | Buffer, start: number, length: number): string {
  let s = '';
  for (let i = 0; i < length; i++) {
    s += bytes[start + i]!.toString(16).padStart(2, '0');
  }
  return s;
}

function findTable(manifest: ProjectManifest, id: string): EncounterTable | null {
  for (const t of manifest.encounterTables) {
    if (t.id === id) return t;
  }
  return null;
}

async function findRomBytes(
  projectRoot: string,
): Promise<{ absPath: string; bytes: Buffer } | null> {
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

function speciesIndexOf(slot: EncounterSlot): number | null {
  const m = /^species_(\d+)$/.exec(slot.speciesId);
  if (!m) return null;
  const n = Number.parseInt(m[1]!, 10);
  return Number.isFinite(n) ? n : null;
}

/** Build a permuted (count × 4)-byte buffer from the existing slot
 *  bytes in `rom` per `slotOrder`. slotOrder[i] = the source slot index
 *  to place at position i. Returns null if any source slot is missing
 *  a fileOffset (decomp project) or runs off the end of the ROM. */
function buildReorderBytes(
  rom: Buffer,
  table: EncounterTable,
  slotOrder: ReadonlyArray<number>,
): { ok: true; bytes: Buffer } | { ok: false; reason: string } {
  if (slotOrder.length !== table.slots.length) {
    return {
      ok: false,
      reason: `slotOrder length ${slotOrder.length} ≠ table slot count ${table.slots.length}`,
    };
  }
  // Validate permutation (every index 0..N-1 appears exactly once).
  const seen = new Set<number>();
  for (const idx of slotOrder) {
    if (idx < 0 || idx >= table.slots.length) {
      return {
        ok: false,
        reason: `slotOrder contains out-of-range index ${idx} (table has ${table.slots.length} slots)`,
      };
    }
    if (seen.has(idx)) {
      return {
        ok: false,
        reason: `slotOrder contains duplicate index ${idx} - must be a permutation of [0..${table.slots.length - 1}]`,
      };
    }
    seen.add(idx);
  }
  const out = Buffer.alloc(table.slots.length * SLOT_STRUCT_SIZE);
  for (let i = 0; i < slotOrder.length; i++) {
    const src = table.slots[slotOrder[i]!]!;
    if (src.fileOffset === undefined || src.fileOffset < 0) {
      return {
        ok: false,
        reason: `slot ${slotOrder[i]} has no fileOffset (decomp project - reorder requires binary ROM)`,
      };
    }
    if (src.fileOffset + SLOT_STRUCT_SIZE > rom.length) {
      return {
        ok: false,
        reason: `slot ${slotOrder[i]} at 0x${src.fileOffset.toString(16)} runs past end of ROM`,
      };
    }
    rom.copy(out, i * SLOT_STRUCT_SIZE, src.fileOffset, src.fileOffset + SLOT_STRUCT_SIZE);
  }
  return { ok: true, bytes: out };
}

/** Build a (count × 4)-byte buffer that's a copy of the existing slot
 *  array with every slot's species replaced by `targetSpeciesId`.
 *  Levels are preserved. */
function buildBulkReplaceBytes(
  rom: Buffer,
  table: EncounterTable,
  targetSpeciesId: number,
): { ok: true; bytes: Buffer } | { ok: false; reason: string } {
  const out = Buffer.alloc(table.slots.length * SLOT_STRUCT_SIZE);
  for (let i = 0; i < table.slots.length; i++) {
    const src = table.slots[i]!;
    if (src.fileOffset === undefined || src.fileOffset < 0) {
      return {
        ok: false,
        reason: `slot ${i} has no fileOffset (decomp project - bulk replace requires binary ROM)`,
      };
    }
    if (src.fileOffset + SLOT_STRUCT_SIZE > rom.length) {
      return {
        ok: false,
        reason: `slot ${i} at 0x${src.fileOffset.toString(16)} runs past end of ROM`,
      };
    }
    rom.copy(out, i * SLOT_STRUCT_SIZE, src.fileOffset, src.fileOffset + SLOT_STRUCT_SIZE);
    // Overwrite species (u16 LE at +2).
    out[i * SLOT_STRUCT_SIZE + 2] = targetSpeciesId & 0xff;
    out[i * SLOT_STRUCT_SIZE + 3] = (targetSpeciesId >>> 8) & 0xff;
  }
  return { ok: true, bytes: out };
}

/** Pure half: read manifest + ROM, build the edits array. No I/O side
 *  effects beyond reading. Used by both the agent flow and the direct-
 *  apply route. */
export async function computeEncounterTableEdit(
  projectRoot: string,
  args: ProposeEncounterTableEditArgs,
): Promise<ComputeEncounterTableEditOutcome> {
  const manifest = await readManifest(projectRoot);
  if (!manifest) {
    return {
      ok: false,
      code: 'missing_manifest',
      message: `No manifest at '${projectRoot}/.editor/manifest.json' - open the project once before editing.`,
    };
  }
  const table = findTable(manifest, args.encounterTableId);
  if (!table) {
    return {
      ok: false,
      code: 'unknown_table',
      message: `Encounter table '${args.encounterTableId}' not in manifest (${manifest.encounterTables.length} tables indexed).`,
    };
  }
  const rom = await findRomBytes(projectRoot);
  if (!rom) {
    return {
      ok: false,
      code: 'no_rom_file',
      message: `No .gba ROM found at '${projectRoot}'.`,
    };
  }

  if (args.op === 'setRate') {
    if (table.infoFileOffset === undefined) {
      return {
        ok: false,
        code: 'missing_offset',
        message:
          'EncounterTable has no infoFileOffset metadata - re-scan the project to populate it (older manifests do not include this).',
      };
    }
    if (table.infoFileOffset + 1 > rom.bytes.length) {
      return {
        ok: false,
        code: 'out_of_bounds',
        message: `infoFileOffset 0x${table.infoFileOffset.toString(16)} runs past end of ROM.`,
      };
    }
    const currentRate = rom.bytes[table.infoFileOffset]!;
    if (currentRate === args.encounterRate) {
      return {
        ok: false,
        code: 'no_op',
        message: `Rate is already ${args.encounterRate}.`,
      };
    }
    const edit: BinaryWriteBytesEdit = {
      kind: 'binary_write_bytes',
      offset: table.infoFileOffset,
      beforeBytes: currentRate.toString(16).padStart(2, '0'),
      afterBytes: (args.encounterRate & 0xff).toString(16).padStart(2, '0'),
      note: `encounter table ${args.encounterTableId}: set encounter rate ${currentRate}→${args.encounterRate}`,
    };
    return {
      ok: true,
      result: {
        edits: [edit],
        description:
          args.description ??
          `Set encounter rate on ${table.mapId ?? args.encounterTableId} to ${args.encounterRate}%`,
        encounterTableId: args.encounterTableId,
        mapId: table.mapId,
        op: 'setRate',
      },
    };
  }

  if (args.op === 'reorder') {
    if (table.slotsFileOffset === undefined) {
      return {
        ok: false,
        code: 'missing_offset',
        message:
          'EncounterTable has no slotsFileOffset metadata - re-scan the project to populate it (older manifests do not include this).',
      };
    }
    const built = buildReorderBytes(rom.bytes, table, args.slotOrder);
    if (!built.ok) {
      return { ok: false, code: 'invalid_reorder', message: built.reason };
    }
    const totalLen = table.slots.length * SLOT_STRUCT_SIZE;
    if (table.slotsFileOffset + totalLen > rom.bytes.length) {
      return {
        ok: false,
        code: 'out_of_bounds',
        message: `slotsFileOffset 0x${table.slotsFileOffset.toString(16)} + ${totalLen}B runs past end of ROM.`,
      };
    }
    const beforeBytes = Buffer.from(
      rom.bytes.subarray(table.slotsFileOffset, table.slotsFileOffset + totalLen),
    );
    if (beforeBytes.equals(built.bytes)) {
      return {
        ok: false,
        code: 'no_op',
        message: 'Reorder produced identical slot bytes (identity permutation?).',
      };
    }
    const edit: BinaryWriteBytesEdit = {
      kind: 'binary_write_bytes',
      offset: table.slotsFileOffset,
      beforeBytes: bytesToHex(beforeBytes, 0, totalLen),
      afterBytes: bytesToHex(built.bytes, 0, totalLen),
      note: `encounter table ${args.encounterTableId}: reorder slots → [${args.slotOrder.join(',')}]`,
    };
    return {
      ok: true,
      result: {
        edits: [edit],
        description:
          args.description ??
          `Reorder encounter slots on ${table.mapId ?? args.encounterTableId}`,
        encounterTableId: args.encounterTableId,
        mapId: table.mapId,
        op: 'reorder',
      },
    };
  }

  if (args.op === 'bulkReplaceSpecies') {
    if (table.slotsFileOffset === undefined) {
      return {
        ok: false,
        code: 'missing_offset',
        message:
          'EncounterTable has no slotsFileOffset metadata - re-scan the project to populate it (older manifests do not include this).',
      };
    }
    if (table.slots.length === 0) {
      return {
        ok: false,
        code: 'empty_table',
        message: 'Table has no slots to replace.',
      };
    }
    // Phase 4.2A - surface the species NAME everywhere a human reads
    // this proposal: error messages, the edit's `note`, and the
    // proposal description. Falls back to "species ${id}" when the
    // manifest's speciesNames table doesn't carry an entry for this id
    // (decomp projects without the lifter, or fresh CFRU-added species).
    const speciesName =
      manifest.speciesNames?.find((s) => s.speciesIndex === args.speciesId)?.name ??
      `species ${String(args.speciesId)}`;
    // Skip the op when every slot already has the target species.
    const allMatch = table.slots.every((s) => speciesIndexOf(s) === args.speciesId);
    if (allMatch) {
      return {
        ok: false,
        code: 'no_op',
        message: `Every slot is already ${speciesName}.`,
      };
    }
    const built = buildBulkReplaceBytes(rom.bytes, table, args.speciesId);
    if (!built.ok) {
      return { ok: false, code: 'invalid_bulk', message: built.reason };
    }
    const totalLen = table.slots.length * SLOT_STRUCT_SIZE;
    const beforeBytes = Buffer.from(
      rom.bytes.subarray(table.slotsFileOffset, table.slotsFileOffset + totalLen),
    );
    const edit: BinaryWriteBytesEdit = {
      kind: 'binary_write_bytes',
      offset: table.slotsFileOffset,
      beforeBytes: bytesToHex(beforeBytes, 0, totalLen),
      afterBytes: bytesToHex(built.bytes, 0, totalLen),
      note: `encounter table ${args.encounterTableId}: bulk-replace species → ${speciesName} (id ${String(args.speciesId)}, levels preserved)`,
    };
    return {
      ok: true,
      result: {
        edits: [edit],
        description:
          args.description ??
          `Replace every species on ${table.mapId ?? args.encounterTableId}'s encounter table with ${speciesName}`,
        encounterTableId: args.encounterTableId,
        mapId: table.mapId,
        op: 'bulkReplaceSpecies',
      },
    };
  }

  return {
    ok: false,
    code: 'bad_op',
    message: `Unknown op '${(args as { op: string }).op}'`,
  };
}

/** Agent-flow wrapper. Computes the edit, then registers a proposal so
 *  the user can review/apply via the existing AI agent UI. */
export async function proposeEncounterTableEdit(
  ctx: ToolContext,
  args: ProposeEncounterTableEditArgs,
  deps: { fetchFn?: typeof fetch } = {},
): Promise<ProposeEncounterTableEditResult> {
  const computed = await computeEncounterTableEdit(ctx.projectRoot, args);
  if (!computed.ok) {
    return {
      proposal: null,
      encounterTableId: args.encounterTableId,
      mapId: null,
      op: args.op,
      message: computed.message,
    };
  }
  let proposal: AgentPatchProposal;
  try {
    proposal = await proposePatch(
      ctx,
      { description: computed.result.description, edits: [...computed.result.edits] },
      deps,
    );
  } catch (e) {
    if (e instanceof ProposePatchError) {
      return {
        proposal: null,
        encounterTableId: args.encounterTableId,
        mapId: computed.result.mapId,
        op: args.op,
        message: `Failed to register proposal: ${e.message}`,
      };
    }
    throw e;
  }
  return {
    proposal,
    encounterTableId: args.encounterTableId,
    mapId: computed.result.mapId,
    op: args.op,
    message: `Proposed ${args.op} for encounter table ${args.encounterTableId}. Review the diff and click Apply.`,
  };
}
