import { z } from 'zod';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import type {
  AgentPatchEdit,
  AgentPatchProposal,
  BinaryWriteBytesEdit,
  ItemEntry,
  ProjectManifest,
} from '@rom-editor/shared';
import { readManifest } from '../../scan/manifest-io.js';
import type { ToolContext } from '../types.js';
import { proposePatch, ProposePatchError } from './propose-patch.js';

export const PROPOSE_ITEM_EDIT_TOOL_NAME = 'propose_item_edit';

export const PROPOSE_ITEM_EDIT_DESCRIPTION =
  "Edit a single item's 44-byte Item struct - price, hold-effect, " +
  'importance flag, pocket, usage type, secondary id. The tool reads ' +
  'the current bytes at the item\'s struct offset, applies partial ' +
  'mutation, and emits a binary_write_bytes proposal.\n\n' +
  'For ITEM NAME changes (the 14-byte Gen-3 text field at offset ' +
  '0x00) use `propose_rename` - that path handles Gen-3 text encoding ' +
  'and free-space repointing for length-increasing renames. This tool ' +
  'is for numeric/enum fields only.\n\n' +
  'Common use:\n' +
  '  - "make MASTER BALL cost 1 Pokédollar" → propose_item_edit({ ' +
  'itemIndex: 1, fields: { price: 1 } })\n' +
  '  - "give the EVERSTONE held-effect 18 (some custom effect)" → ' +
  'propose_item_edit({ itemIndex: 24, fields: { holdEffect: 18 } })\n' +
  '  - "move RARE CANDY to the items pocket" → propose_item_edit({ ' +
  'itemIndex: 50, fields: { pocket: 0 } }) (pocket: ITEMS=0, KEY=1, ' +
  'POKEBALLS=2, TM_HM=3, BERRIES=4)\n\n' +
  'Field bounds:\n' +
  '  price: 0..65535 (u16 LE)\n' +
  '  holdEffect, holdEffectParam, importance, pocket, type, ' +
  'secondaryId: 0..255 (u8)\n\n' +
  'Item names + descriptions are intentionally not editable here. The ' +
  '14-byte name slot needs Gen-3 text encoding (use propose_rename); ' +
  'descriptions live at a separate pointer (descriptionPtr at offset ' +
  '0x14) and would need a propose_repoint variant if you want to ' +
  'change the text.';

/** Field offsets within the 44-byte Item struct. Mirrors pret/
 *  pokefirered's include/item.h definition. */
const FIELD_OFFSETS = {
  // 0x00..0x0D: name (14 bytes) - not editable here.
  // 0x0E..0x0F: itemId u16 - locked to record index by invariant.
  price: 0x10, // u16 LE
  holdEffect: 0x12, // u8
  holdEffectParam: 0x13, // u8
  // 0x14..0x17: descriptionPtr u32 - not editable here.
  importance: 0x18, // u8 (0 or 1)
  // 0x19: unk19 - not editable.
  pocket: 0x1a, // u8
  type: 0x1b, // u8
  // 0x1C..0x1F: fieldUseFuncPtr - not editable.
  // 0x20..0x23: battleUsage - not editable.
  // 0x24..0x27: battleUseFuncPtr - not editable.
  secondaryId: 0x28, // u8 (TM/HM number)
  // 0x29..0x2B: padding - must stay 0.
} as const;

const ITEM_STRUCT_SIZE = 44;

const u8 = z.number().int().min(0).max(255);
const u16 = z.number().int().min(0).max(0xffff);

export const proposeItemEditInputShape = {
  itemIndex: z.number().int().nonnegative(),
  fields: z
    .object({
      price: u16.optional(),
      holdEffect: u8.optional(),
      holdEffectParam: u8.optional(),
      importance: u8.optional(),
      pocket: u8.optional(),
      type: u8.optional(),
      secondaryId: u8.optional(),
    })
    .refine((obj) => Object.keys(obj).length > 0, {
      message: 'At least one field must be provided.',
    }),
  description: z.string().min(1).max(500).optional(),
} as const;

type ItemEditFields = {
  price?: number; holdEffect?: number; holdEffectParam?: number;
  importance?: number; pocket?: number; type?: number; secondaryId?: number;
};

export interface ProposeItemEditResult {
  readonly proposal: AgentPatchProposal | null;
  readonly itemIndex: number;
  readonly itemName?: string;
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

function findItem(manifest: ProjectManifest, itemIndex: number): ItemEntry | null {
  for (const it of manifest.items ?? []) {
    if (it.itemIndex === itemIndex) return it;
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

export async function proposeItemEdit(
  ctx: ToolContext,
  args: { itemIndex: number; fields: ItemEditFields; description?: string },
  deps: { fetchFn?: typeof fetch } = {},
): Promise<ProposeItemEditResult> {
  const manifest = await readManifest(ctx.projectRoot);
  if (!manifest) {
    return {
      proposal: null,
      itemIndex: args.itemIndex,
      changedFields: [],
      message: `No manifest at '${ctx.projectRoot}/.editor/manifest.json'. Scan the project first.`,
    };
  }
  const item = findItem(manifest, args.itemIndex);
  if (!item) {
    return {
      proposal: null,
      itemIndex: args.itemIndex,
      changedFields: [],
      message: `Item index ${args.itemIndex} not in manifest.items[]. The detector found ${manifest.items?.length ?? 0} items; check that the index is in range.`,
    };
  }
  const rom = await findRomBytes(ctx.projectRoot);
  if (!rom) {
    return {
      proposal: null,
      itemIndex: args.itemIndex,
      itemName: item.name,
      changedFields: [],
      message: `No .gba ROM found at '${ctx.projectRoot}'.`,
    };
  }

  // Per-item offset: table_start + index * 44.
  const offset = item.sourceTableOffset + args.itemIndex * ITEM_STRUCT_SIZE;
  if (offset < 0 || offset + ITEM_STRUCT_SIZE > rom.bytes.length) {
    return {
      proposal: null,
      itemIndex: args.itemIndex,
      itemName: item.name,
      changedFields: [],
      message: `Item offset 0x${offset.toString(16)} runs past end of ROM (length 0x${rom.bytes.length.toString(16)}).`,
    };
  }

  const beforeBytes = Buffer.from(rom.bytes.subarray(offset, offset + ITEM_STRUCT_SIZE));
  const afterBytes = Buffer.from(beforeBytes);

  const changedFields: string[] = [];
  const fields = args.fields;
  for (const [name, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    const fieldOffset = FIELD_OFFSETS[name as keyof typeof FIELD_OFFSETS];
    if (fieldOffset === undefined) continue;
    if (name === 'price') {
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
      itemIndex: args.itemIndex,
      itemName: item.name,
      changedFields: [],
      message: 'No fields provided to edit.',
    };
  }
  if (beforeBytes.equals(afterBytes)) {
    return {
      proposal: null,
      itemIndex: args.itemIndex,
      itemName: item.name,
      changedFields: [],
      message: 'All requested values already match the current bytes - no change needed.',
    };
  }

  const edit: BinaryWriteBytesEdit = {
    kind: 'binary_write_bytes',
    offset,
    beforeBytes: bytesToHex(beforeBytes, 0, ITEM_STRUCT_SIZE),
    afterBytes: bytesToHex(afterBytes, 0, ITEM_STRUCT_SIZE),
    note: `edit item #${args.itemIndex} (${item.name ?? 'unnamed'}): ${changedFields.join(', ')}`,
  };
  const edits: AgentPatchEdit[] = [edit];

  const description =
    args.description ??
    `Edit ${item.name ?? `item #${args.itemIndex}`}: ${changedFields.join(', ')}`;

  let proposal: AgentPatchProposal;
  try {
    proposal = await proposePatch(ctx, { description, edits }, deps);
  } catch (e) {
    if (e instanceof ProposePatchError) {
      return {
        proposal: null,
        itemIndex: args.itemIndex,
        itemName: item.name,
        changedFields,
        message: `Failed to register proposal: ${e.message}`,
      };
    }
    throw e;
  }

  return {
    proposal,
    itemIndex: args.itemIndex,
    itemName: item.name,
    changedFields,
    message: `Proposed editing ${item.name ?? `item #${args.itemIndex}`} - ${changedFields.length} field${changedFields.length === 1 ? '' : 's'} changed (${changedFields.join(', ')}). Review the diff and click Apply.`,
  };
}
