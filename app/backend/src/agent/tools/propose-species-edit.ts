import { z } from 'zod';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import type {
  AgentPatchEdit,
  AgentPatchProposal,
  BinaryWriteBytesEdit,
  ProjectManifest,
  SpeciesEntry,
} from '@rom-editor/shared';
import { readManifest } from '../../scan/manifest-io.js';
import type { ToolContext } from '../types.js';
import { proposePatch, ProposePatchError } from './propose-patch.js';

export const PROPOSE_SPECIES_EDIT_TOOL_NAME = 'propose_species_edit';

export const PROPOSE_SPECIES_EDIT_DESCRIPTION =
  "Edit a single species's 28-byte BaseStats struct - stats, types, " +
  'abilities, growth rate, gender ratio, items, egg groups, etc. The ' +
  'tool reads the current bytes at the species\'s sourceFileOffset, ' +
  'applies the requested field changes, and emits a binary_write_bytes ' +
  'patch proposal. The user reviews + clicks Apply in the AgentPanel.\n\n' +
  'Common use:\n' +
  '  - "make Mewtwo even stronger" → propose_species_edit({ speciesIndex: 150, ' +
  'fields: { baseHP: 200, baseAttack: 200, baseSpAttack: 200 } })\n' +
  '  - "give Bulbasaur Levitate as ability 2" → propose_species_edit({ ' +
  'speciesIndex: 1, fields: { ability2: 26 } })\n' +
  '  - "make Charizard pure Dragon" → propose_species_edit({ speciesIndex: 6, ' +
  'fields: { type1: 16, type2: 16 } }) (type indices: NORMAL=0, FIRE=10, ' +
  'WATER=11, GRASS=12, ELECTRIC=13, PSYCHIC=14, ICE=15, DRAGON=16, DARK=17)\n\n' +
  'Only the supplied fields are mutated; everything else keeps its current ' +
  'value (read from the live ROM at apply time). Pass speciesIndex from the ' +
  'manifest.species[N].speciesIndex field (1 = BULBASAUR in vanilla FRLG ' +
  'ordering; 0 = SPECIES_NONE placeholder).';

/** Field offsets within the 28-byte BaseStats struct. Mirrors
 *  engine/src/species/base-stats.ts's ITEM_OFFSET_* constants. */
const FIELD_OFFSETS = {
  baseHP: 0x00,
  baseAttack: 0x01,
  baseDefense: 0x02,
  baseSpeed: 0x03,
  baseSpAttack: 0x04,
  baseSpDefense: 0x05,
  type1: 0x06,
  type2: 0x07,
  catchRate: 0x08,
  expYield: 0x09,
  item1: 0x0c,
  item2: 0x0e,
  genderRatio: 0x10,
  eggCycles: 0x11,
  friendship: 0x12,
  growthRate: 0x13,
  eggGroup1: 0x14,
  eggGroup2: 0x15,
  ability1: 0x16,
  ability2: 0x17,
  safariZoneFleeRate: 0x18,
} as const;

const SPECIES_STRUCT_SIZE = 28;

/** u8 field schema - 0..255 inclusive. */
const u8 = z.number().int().min(0).max(255);
/** u16 field schema (item ids). */
const u16 = z.number().int().min(0).max(0xffff);

export const proposeSpeciesEditInputShape = {
  speciesIndex: z.number().int().nonnegative(),
  fields: z
    .object({
      baseHP: u8.optional(),
      baseAttack: u8.optional(),
      baseDefense: u8.optional(),
      baseSpeed: u8.optional(),
      baseSpAttack: u8.optional(),
      baseSpDefense: u8.optional(),
      type1: u8.optional(),
      type2: u8.optional(),
      catchRate: u8.optional(),
      expYield: u8.optional(),
      item1: u16.optional(),
      item2: u16.optional(),
      genderRatio: u8.optional(),
      eggCycles: u8.optional(),
      friendship: u8.optional(),
      growthRate: u8.optional(),
      eggGroup1: u8.optional(),
      eggGroup2: u8.optional(),
      ability1: u8.optional(),
      ability2: u8.optional(),
      safariZoneFleeRate: u8.optional(),
    })
    .refine((obj) => Object.keys(obj).length > 0, {
      message: 'At least one field must be provided.',
    }),
  description: z.string().min(1).max(500).optional(),
} as const;

type SpeciesEditFields = {
  baseHP?: number; baseAttack?: number; baseDefense?: number; baseSpeed?: number;
  baseSpAttack?: number; baseSpDefense?: number; type1?: number; type2?: number;
  catchRate?: number; expYield?: number; item1?: number; item2?: number;
  genderRatio?: number; eggCycles?: number; friendship?: number; growthRate?: number;
  eggGroup1?: number; eggGroup2?: number; ability1?: number; ability2?: number;
  safariZoneFleeRate?: number;
};

export interface ProposeSpeciesEditResult {
  readonly proposal: AgentPatchProposal | null;
  readonly speciesIndex: number;
  readonly speciesName?: string;
  readonly changedFields: ReadonlyArray<string>;
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

function findSpecies(manifest: ProjectManifest, speciesIndex: number): SpeciesEntry | null {
  for (const s of manifest.species ?? []) {
    if (s.speciesIndex === speciesIndex) return s;
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

export async function proposeSpeciesEdit(
  ctx: ToolContext,
  args: { speciesIndex: number; fields: SpeciesEditFields; description?: string },
  deps: { fetchFn?: typeof fetch } = {},
): Promise<ProposeSpeciesEditResult> {
  const manifest = await readManifest(ctx.projectRoot);
  if (!manifest) {
    return {
      proposal: null,
      speciesIndex: args.speciesIndex,
      changedFields: [],
      message: `No manifest at '${ctx.projectRoot}/.editor/manifest.json'. Scan the project first.`,
    };
  }
  const species = findSpecies(manifest, args.speciesIndex);
  if (!species) {
    return {
      proposal: null,
      speciesIndex: args.speciesIndex,
      changedFields: [],
      message: `Species index ${args.speciesIndex} not in manifest.species[]. The detector found ${manifest.species?.length ?? 0} species; check that the index is in range.`,
    };
  }
  const rom = await findRomBytes(ctx.projectRoot);
  if (!rom) {
    return {
      proposal: null,
      speciesIndex: args.speciesIndex,
      speciesName: species.name,
      changedFields: [],
      message: `No .gba ROM found at '${ctx.projectRoot}'. Species edits need the live ROM bytes to read before/after.`,
    };
  }

  const offset = species.sourceFileOffset;
  if (offset < 0 || offset + SPECIES_STRUCT_SIZE > rom.bytes.length) {
    return {
      proposal: null,
      speciesIndex: args.speciesIndex,
      speciesName: species.name,
      changedFields: [],
      message: `Species offset 0x${offset.toString(16)} runs past end of ROM (length 0x${rom.bytes.length.toString(16)}).`,
    };
  }

  // Snapshot current 28 bytes; clone for mutation.
  const beforeBytes = Buffer.from(rom.bytes.subarray(offset, offset + SPECIES_STRUCT_SIZE));
  const afterBytes = Buffer.from(beforeBytes);

  const changedFields: string[] = [];
  const fields = args.fields;
  // u8 single-byte fields.
  for (const [name, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    const fieldOffset = FIELD_OFFSETS[name as keyof typeof FIELD_OFFSETS];
    if (fieldOffset === undefined) continue;
    if (name === 'item1' || name === 'item2') {
      // u16 LE fields.
      afterBytes[fieldOffset] = value & 0xff;
      afterBytes[fieldOffset + 1] = (value >>> 8) & 0xff;
    } else {
      afterBytes[fieldOffset] = value & 0xff;
    }
    changedFields.push(name);
  }

  if (changedFields.length === 0) {
    return {
      proposal: null,
      speciesIndex: args.speciesIndex,
      speciesName: species.name,
      changedFields: [],
      message: 'No fields provided to edit.',
    };
  }

  // Check it's actually a no-op-ed difference.
  if (beforeBytes.equals(afterBytes)) {
    return {
      proposal: null,
      speciesIndex: args.speciesIndex,
      speciesName: species.name,
      changedFields: [],
      message: `All requested values already match the current bytes - no change needed.`,
    };
  }

  const edit: BinaryWriteBytesEdit = {
    kind: 'binary_write_bytes',
    offset,
    beforeBytes: bytesToHex(beforeBytes, 0, SPECIES_STRUCT_SIZE),
    afterBytes: bytesToHex(afterBytes, 0, SPECIES_STRUCT_SIZE),
    note: `edit species #${args.speciesIndex} (${species.name ?? 'unnamed'}): ${changedFields.join(', ')}`,
  };
  const edits: AgentPatchEdit[] = [edit];

  const description =
    args.description ??
    `Edit ${species.name ?? `species #${args.speciesIndex}`}: ${changedFields.join(', ')}`;

  let proposal: AgentPatchProposal;
  try {
    proposal = await proposePatch(ctx, { description, edits }, deps);
  } catch (e) {
    if (e instanceof ProposePatchError) {
      return {
        proposal: null,
        speciesIndex: args.speciesIndex,
        speciesName: species.name,
        changedFields,
        message: `Failed to register proposal: ${e.message}`,
      };
    }
    throw e;
  }

  return {
    proposal,
    speciesIndex: args.speciesIndex,
    speciesName: species.name,
    changedFields,
    message: `Proposed editing ${species.name ?? `species #${args.speciesIndex}`} - ${changedFields.length} field${changedFields.length === 1 ? '' : 's'} changed (${changedFields.join(', ')}). Review the diff and click Apply.`,
  };
}
