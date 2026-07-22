/**
 * propose_create_item - Phase 3.32.
 *
 * Sets an item in gItems by overwriting a specific 44-byte slot.
 * Used to add new key items (Cosmog-key-item, Resonance amulets,
 * etc.) or to repurpose unused slots.
 *
 * In-place rewrite (no relocation). Description allocated separately
 * in fresh ROM space + pointer rewritten in the slot.
 *
 * Field-use + battle-use function pointers default to NULL - the
 * agent + user wire those via CFRU source edits if the item needs to
 * DO something (most key items just sit in the bag).
 */

import { z } from 'zod';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import type {
  AgentPatchEdit,
  AgentPatchProposal,
  BinaryWriteBytesEdit,
} from '@rom-editor/shared';
import {
  items as itemsApi,
  rom as romApi,
  text as textApi,
} from '@rom-introspection/engine';
import type { ToolContext } from '../types.js';
import { proposePatch, ProposePatchError } from './propose-patch.js';

export const PROPOSE_CREATE_ITEM_TOOL_NAME = 'propose_create_item';

export const PROPOSE_CREATE_ITEM_DESCRIPTION =
  'Set an item in gItems (44-byte slot per item).\n\n' +
  'Inputs:\n' +
  '  - `itemId`: u16 - slot in gItems.\n' +
  '  - `name`: 1-13 chars (slot is 14 bytes + 0xFF terminator).\n' +
  '  - `price`: u16 (0 = no price / key item).\n' +
  '  - `holdEffect`: u8 (0 = no hold effect).\n' +
  '  - `holdEffectParam`: u8.\n' +
  '  - `description`: in-game flavor text (max ~200 chars Gen-3 charset).\n' +
  '  - `pocket`: u8 (1 = Items, 2 = Key Items, 3 = Poké Balls, …).\n' +
  '  - `importance`: u8 (1 for key items / 0 for regular).';

const u8 = z.number().int().min(0).max(0xff);
const u16 = z.number().int().min(0).max(0xffff);
const u32 = z.number().int().min(0).max(0xffffffff);

export const proposeCreateItemInputShape = {
  itemId: u16,
  name: z.string().min(1).max(13),
  price: u16,
  holdEffect: u8.optional(),
  holdEffectParam: u8.optional(),
  description: z.string().min(1).max(200),
  pocket: u8,
  importance: u8.optional(),
  secondaryId: u32.optional(),
  type: u8.optional(),
  notes: z.string().max(500).optional(),
} as const;

export interface ProposeCreateItemResult {
  readonly proposal: AgentPatchProposal | null;
  readonly itemId: number;
  readonly slotOffset: number | null;
  readonly descriptionOffset: number | null;
  readonly bytesWritten: number;
  readonly message: string;
}

function emptyResult(itemId: number, message: string): ProposeCreateItemResult {
  return { proposal: null, itemId, slotOffset: null, descriptionOffset: null, bytesWritten: 0, message };
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

const GBA_ROM_BASE = 0x08000000;

/** Encode a 44-byte gItems struct from a spec. */
function encodeItemStruct(
  spec: {
    itemId: number;
    name: string;
    price: number;
    holdEffect: number;
    holdEffectParam: number;
    descriptionOffset: number;
    pocket: number;
    importance: number;
    secondaryId: number;
    type: number;
  },
): Uint8Array {
  const out = new Uint8Array(itemsApi.ITEM_STRUCT_SIZE_BYTES);
  // Name at offset 0x00 - 14 bytes incl 0xFF terminator.
  const nameEncoded = textApi.encodeString(spec.name.toUpperCase());
  for (let i = 0; i < itemsApi.ITEM_NAME_LENGTH_BYTES; i++) {
    out[itemsApi.ITEM_OFFSET_NAME + i] = i < nameEncoded.length ? nameEncoded[i]! : 0xff;
  }
  // itemId u16 at 0x0E
  out[itemsApi.ITEM_OFFSET_ITEM_ID + 0] = spec.itemId & 0xff;
  out[itemsApi.ITEM_OFFSET_ITEM_ID + 1] = (spec.itemId >>> 8) & 0xff;
  // price u16 at 0x10
  out[itemsApi.ITEM_OFFSET_PRICE + 0] = spec.price & 0xff;
  out[itemsApi.ITEM_OFFSET_PRICE + 1] = (spec.price >>> 8) & 0xff;
  // holdEffect u8 at 0x12
  out[itemsApi.ITEM_OFFSET_HOLD_EFFECT] = spec.holdEffect & 0xff;
  // holdEffectParam u8 at 0x13
  out[itemsApi.ITEM_OFFSET_HOLD_EFFECT_PARAM] = spec.holdEffectParam & 0xff;
  // descriptionPtr u32 at 0x14
  const descPtr = (spec.descriptionOffset + GBA_ROM_BASE) >>> 0;
  out[itemsApi.ITEM_OFFSET_DESCRIPTION_PTR + 0] = descPtr & 0xff;
  out[itemsApi.ITEM_OFFSET_DESCRIPTION_PTR + 1] = (descPtr >>> 8) & 0xff;
  out[itemsApi.ITEM_OFFSET_DESCRIPTION_PTR + 2] = (descPtr >>> 16) & 0xff;
  out[itemsApi.ITEM_OFFSET_DESCRIPTION_PTR + 3] = (descPtr >>> 24) & 0xff;
  // importance u8 at 0x18
  out[itemsApi.ITEM_OFFSET_IMPORTANCE] = spec.importance & 0xff;
  // unk19 at 0x19 - 0
  // pocket u8 at 0x1A
  out[itemsApi.ITEM_OFFSET_POCKET] = spec.pocket & 0xff;
  // type u8 at 0x1B
  out[itemsApi.ITEM_OFFSET_TYPE] = spec.type & 0xff;
  // field-use-func ptr u32 at 0x1C - NULL
  // battleUsage u32 at 0x20 - 0
  // battle-use-func ptr u32 at 0x24 - NULL
  // secondaryId u8 at 0x28
  out[itemsApi.ITEM_OFFSET_SECONDARY_ID] = spec.secondaryId & 0xff;
  return out;
}

export async function proposeCreateItem(
  ctx: ToolContext,
  args: {
    itemId: number;
    name: string;
    price: number;
    holdEffect?: number;
    holdEffectParam?: number;
    description: string;
    pocket: number;
    importance?: number;
    secondaryId?: number;
    type?: number;
    notes?: string;
  },
  deps: { fetchFn?: typeof fetch } = {},
): Promise<ProposeCreateItemResult> {
  const rom = await findRomFile(ctx.projectRoot);
  if (!rom) return emptyResult(args.itemId, `No .gba in ${ctx.projectRoot}`);
  const romBytes = new Uint8Array(rom.bytes);
  const itemsTable = itemsApi.scanItemsTable(romBytes);
  if (!itemsTable) return emptyResult(args.itemId, 'Could not locate gItems table.');
  if (args.itemId >= itemsTable.itemCount) {
    return emptyResult(args.itemId, `itemId ${String(args.itemId)} is past the table end (${String(itemsTable.itemCount)} items).`);
  }

  const slotOffset = itemsTable.tableStart + args.itemId * itemsApi.ITEM_STRUCT_SIZE_BYTES;
  const oldSlot = new Uint8Array(rom.bytes.subarray(slotOffset, slotOffset + itemsApi.ITEM_STRUCT_SIZE_BYTES));

  // Allocate description text.
  const descBytes = textApi.encodeString(args.description);
  const descAlloc = romApi.findFreeRomSpace(romBytes, descBytes.length);
  if (!descAlloc) return emptyResult(args.itemId, 'No free ROM space for description.');

  // Encode the new item struct.
  const newSlot = encodeItemStruct({
    itemId: args.itemId,
    name: args.name,
    price: args.price,
    holdEffect: args.holdEffect ?? 0,
    holdEffectParam: args.holdEffectParam ?? 0,
    descriptionOffset: descAlloc.offset,
    pocket: args.pocket,
    importance: args.importance ?? 0,
    secondaryId: args.secondaryId ?? 0,
    type: args.type ?? 0,
  });

  const edits: AgentPatchEdit[] = [
    {
      kind: 'binary_write_bytes',
      offset: descAlloc.offset,
      beforeBytes: bytesToHex(new Uint8Array(descBytes.length).fill(descAlloc.fillByte)),
      afterBytes: bytesToHex(descBytes),
      requireFreeSlot: true,
      note: `Item description for "${args.name}"`,
    } satisfies BinaryWriteBytesEdit,
    {
      kind: 'binary_write_bytes',
      offset: slotOffset,
      beforeBytes: bytesToHex(oldSlot),
      afterBytes: bytesToHex(newSlot),
      note: `gItems[${String(args.itemId)}] = "${args.name}"`,
    } satisfies BinaryWriteBytesEdit,
  ];
  const description = args.notes ?? `Create item ${String(args.itemId)} = "${args.name}" (${String(args.price)}¥, pocket ${String(args.pocket)})`;
  let proposal: AgentPatchProposal;
  try {
    proposal = await proposePatch(ctx, { description, edits }, deps);
  } catch (e) {
    if (e instanceof ProposePatchError) return emptyResult(args.itemId, `Failed: ${e.message}`);
    throw e;
  }
  return {
    proposal,
    itemId: args.itemId,
    slotOffset,
    descriptionOffset: descAlloc.offset,
    bytesWritten: itemsApi.ITEM_STRUCT_SIZE_BYTES + descBytes.length,
    message: `Item ${String(args.itemId)} "${args.name}" written @ 0x${slotOffset.toString(16)}; description @ 0x${descAlloc.offset.toString(16)}.`,
  };
}
