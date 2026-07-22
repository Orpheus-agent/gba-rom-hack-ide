import { z } from 'zod';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import type {
  AgentPatchEdit,
  AgentPatchProposal,
  BinaryWriteBytesEdit,
  EncounterTable,
  ProjectManifest,
} from '@rom-editor/shared';
import { readManifest } from '../../scan/manifest-io.js';
import type { ToolContext } from '../types.js';
import { proposePatch, ProposePatchError } from './propose-patch.js';

export const PROPOSE_ENCOUNTER_EDIT_TOOL_NAME = 'propose_encounter_edit';

export const PROPOSE_ENCOUNTER_EDIT_DESCRIPTION =
  "Edit one or more wild-encounter slots on a specific map's encounter " +
  'table. Each slot is a 4-byte { u8 minLevel; u8 maxLevel; u16 species } ' +
  'record. The tool reads each affected slot, applies partial field ' +
  'mutation, and emits a binary_write_bytes proposal per slot.\n\n' +
  'Common use:\n' +
  '  - "make Route 1 spawn level-25 Mewtwo instead of level-2 Pidgey" → ' +
  'propose_encounter_edit({ encounterTableId: "encTable_2_0_land", ' +
  'slots: [{ slotIndex: 0, speciesId: 150, minLevel: 25, maxLevel: 25 }] })\n' +
  '  - "double the level on every Route 22 grass slot" → load the table, ' +
  'loop slots: [{ slotIndex: 0, minLevel: cur*2, maxLevel: cur*2 }, ...] }\n' +
  '  - "swap all wild Pidgeys for Pikachus" → identify slots with ' +
  'speciesId=16 and rewrite to speciesId=25.\n\n' +
  'Find the encounterTableId by calling `list_entities({ kind: ' +
  '"encounterTable" })` or `read_map` on the map of interest. Each ' +
  'EncounterTable has a `slots[]` array; pass the slotIndex 0-based.\n\n' +
  'Field bounds:\n' +
  '  speciesId: 1..2047 (species index - 1=BULBASAUR; species 0 = ' +
  'SPECIES_NONE is reserved)\n' +
  '  minLevel, maxLevel: 1..100, with maxLevel >= minLevel\n' +
  '  (If only one of min/max is supplied, the other keeps its current ' +
  'value.)';

const SLOT_STRUCT_SIZE = 4;

const slotSchema = z.object({
  slotIndex: z.number().int().nonnegative(),
  speciesId: z.number().int().min(1).max(2047).optional(),
  minLevel: z.number().int().min(1).max(100).optional(),
  maxLevel: z.number().int().min(1).max(100).optional(),
}).refine(
  (s) =>
    s.speciesId !== undefined || s.minLevel !== undefined || s.maxLevel !== undefined,
  { message: 'Each slot must change at least one of speciesId/minLevel/maxLevel.' },
);

export const proposeEncounterEditInputShape = {
  encounterTableId: z.string().min(1),
  slots: z.array(slotSchema).min(1).max(40),
  description: z.string().min(1).max(500).optional(),
} as const;

type SlotEdit = {
  slotIndex: number;
  speciesId?: number;
  minLevel?: number;
  maxLevel?: number;
};

export interface ProposeEncounterEditResult {
  readonly proposal: AgentPatchProposal | null;
  readonly encounterTableId: string;
  readonly mapId?: string | null;
  readonly editedSlotCount: number;
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

function findEncounterTable(manifest: ProjectManifest, id: string): EncounterTable | null {
  for (const t of manifest.encounterTables) {
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

export async function proposeEncounterEdit(
  ctx: ToolContext,
  args: { encounterTableId: string; slots: SlotEdit[]; description?: string },
  deps: { fetchFn?: typeof fetch } = {},
): Promise<ProposeEncounterEditResult> {
  const manifest = await readManifest(ctx.projectRoot);
  if (!manifest) {
    return {
      proposal: null,
      encounterTableId: args.encounterTableId,
      editedSlotCount: 0,
      skipped: [],
      message: `No manifest at '${ctx.projectRoot}/.editor/manifest.json'.`,
    };
  }
  const table = findEncounterTable(manifest, args.encounterTableId);
  if (!table) {
    return {
      proposal: null,
      encounterTableId: args.encounterTableId,
      editedSlotCount: 0,
      skipped: [],
      message: `Encounter table '${args.encounterTableId}' not in manifest.encounterTables[] (${manifest.encounterTables.length} tables total). Use list_entities({ kind: 'encounterTable' }) to discover valid ids.`,
    };
  }
  const rom = await findRomBytes(ctx.projectRoot);
  if (!rom) {
    return {
      proposal: null,
      encounterTableId: args.encounterTableId,
      mapId: table.mapId,
      editedSlotCount: 0,
      skipped: [],
      message: `No .gba ROM found at '${ctx.projectRoot}'.`,
    };
  }

  const edits: AgentPatchEdit[] = [];
  const skipped: { slotIndex: number; reason: string }[] = [];

  for (const slotEdit of args.slots) {
    const slot = table.slots[slotEdit.slotIndex];
    if (!slot) {
      skipped.push({
        slotIndex: slotEdit.slotIndex,
        reason: `slot ${slotEdit.slotIndex} out of range (table has ${table.slots.length} slots)`,
      });
      continue;
    }
    if (slot.fileOffset === undefined || slot.fileOffset < 0) {
      skipped.push({
        slotIndex: slotEdit.slotIndex,
        reason: 'slot has no fileOffset (likely a decomp project - use replace_in_file instead)',
      });
      continue;
    }
    const offset = slot.fileOffset;
    if (offset + SLOT_STRUCT_SIZE > rom.bytes.length) {
      skipped.push({
        slotIndex: slotEdit.slotIndex,
        reason: `offset 0x${offset.toString(16)} runs past end of ROM`,
      });
      continue;
    }

    const beforeBytes = Buffer.from(rom.bytes.subarray(offset, offset + SLOT_STRUCT_SIZE));
    const afterBytes = Buffer.from(beforeBytes);

    // Validate min/max consistency. If only one is provided, use the
    // existing value for the other.
    const currentMin = beforeBytes[0]!;
    const currentMax = beforeBytes[1]!;
    const newMin = slotEdit.minLevel ?? currentMin;
    const newMax = slotEdit.maxLevel ?? currentMax;
    if (newMax < newMin) {
      skipped.push({
        slotIndex: slotEdit.slotIndex,
        reason: `inverted level range: maxLevel ${newMax} < minLevel ${newMin}`,
      });
      continue;
    }

    if (slotEdit.minLevel !== undefined) afterBytes[0] = slotEdit.minLevel & 0xff;
    if (slotEdit.maxLevel !== undefined) afterBytes[1] = slotEdit.maxLevel & 0xff;
    if (slotEdit.speciesId !== undefined) {
      afterBytes[2] = slotEdit.speciesId & 0xff;
      afterBytes[3] = (slotEdit.speciesId >>> 8) & 0xff;
    }

    if (beforeBytes.equals(afterBytes)) {
      skipped.push({
        slotIndex: slotEdit.slotIndex,
        reason: 'values already match the current bytes',
      });
      continue;
    }

    const edit: BinaryWriteBytesEdit = {
      kind: 'binary_write_bytes',
      offset,
      beforeBytes: bytesToHex(beforeBytes, 0, SLOT_STRUCT_SIZE),
      afterBytes: bytesToHex(afterBytes, 0, SLOT_STRUCT_SIZE),
      note: `encounter table ${args.encounterTableId} slot ${slotEdit.slotIndex}: minL=${afterBytes[0]} maxL=${afterBytes[1]} species=${(afterBytes[2]! | (afterBytes[3]! << 8))}`,
    };
    edits.push(edit);
  }

  if (edits.length === 0) {
    return {
      proposal: null,
      encounterTableId: args.encounterTableId,
      mapId: table.mapId,
      editedSlotCount: 0,
      skipped,
      message: `No editable slots - all ${args.slots.length} entries were skipped (${skipped.length} reasons listed in result.skipped[]).`,
    };
  }

  const description =
    args.description ??
    `Edit ${edits.length} encounter slot${edits.length === 1 ? '' : 's'} on ${table.mapId ?? args.encounterTableId}`;

  let proposal: AgentPatchProposal;
  try {
    proposal = await proposePatch(ctx, { description, edits }, deps);
  } catch (e) {
    if (e instanceof ProposePatchError) {
      return {
        proposal: null,
        encounterTableId: args.encounterTableId,
        mapId: table.mapId,
        editedSlotCount: edits.length,
        skipped,
        message: `Failed to register proposal: ${e.message}`,
      };
    }
    throw e;
  }

  return {
    proposal,
    encounterTableId: args.encounterTableId,
    mapId: table.mapId,
    editedSlotCount: edits.length,
    skipped,
    message: `Proposed editing ${edits.length} encounter slot${edits.length === 1 ? '' : 's'} on ${table.mapId ?? args.encounterTableId}${skipped.length > 0 ? ` (${skipped.length} skipped)` : ''}. Review the diff and click Apply.`,
  };
}
