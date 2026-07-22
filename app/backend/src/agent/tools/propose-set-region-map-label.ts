/**
 * propose_set_region_map_label - Phase 3.29.
 *
 * Sets the x/y/width/height + name of a region-map entry. Used to
 * give new maps a label on the in-game region map (so the player
 * can Fly to them).
 *
 * The name is encoded as a Gen-3 charset string; if its length > the
 * existing name slot, a fresh allocation is made and the name pointer
 * in the entry is repointed.
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
  maps as mapsApi,
  rom as romApi,
  world as worldApi,
} from '@rom-introspection/engine';
import { readManifest } from '../../scan/manifest-io.js';
import type { ToolContext } from '../types.js';
import { proposePatch, ProposePatchError } from './propose-patch.js';

export const PROPOSE_SET_REGION_MAP_LABEL_TOOL_NAME = 'propose_set_region_map_label';

export const PROPOSE_SET_REGION_MAP_LABEL_DESCRIPTION =
  'Set a region-map entry\'s position + name. Used to give a new\n' +
  'map a label on the world map so the player can fly to it.\n\n' +
  'Inputs:\n' +
  '  - `sectionIndex`: u8 - the section id (matches\n' +
  '    MapHeader.regionMapSection). Use a value not currently in use\n' +
  '    by another entry (the scanner exposes the existing entries\n' +
  '    via manifest.regionMap if available; otherwise probe with the\n' +
  '    detection report).\n' +
  '  - `x`, `y`, `width`, `height`: u8 each - position + size on the\n' +
  '    16-tile-wide world map.\n' +
  '  - `name`: 1-12 chars; encoded to Gen-3 charset.\n\n' +
  'The entry is overwritten in place; if the new name exceeds the\n' +
  'existing slot, a fresh allocation + repoint happens automatically.';

const u8 = z.number().int().min(0).max(0xff);

export const proposeSetRegionMapLabelInputShape = {
  sectionIndex: u8,
  x: u8,
  y: u8,
  width: u8,
  height: u8,
  name: z.string().min(1).max(12),
  description: z.string().max(500).optional(),
} as const;

export interface ProposeSetRegionMapLabelResult {
  readonly proposal: AgentPatchProposal | null;
  readonly sectionIndex: number;
  readonly bytesWritten: number;
  readonly message: string;
}

function emptyResult(sectionIndex: number, message: string): ProposeSetRegionMapLabelResult {
  return { proposal: null, sectionIndex, bytesWritten: 0, message };
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

/** Encode a short uppercase string to Gen-3 charset (0xBB..0xD4 = A..Z;
 *  spaces = 0x00; terminator 0xFF). Caller passes already-uppercased
 *  printable ASCII. */
function encodeGen3Text(s: string): Uint8Array {
  const upper = s.toUpperCase();
  const out: number[] = [];
  for (const ch of upper) {
    const code = ch.charCodeAt(0);
    if (code === 0x20) out.push(0x00); // space
    else if (code >= 0x30 && code <= 0x39) out.push(0xa1 + (code - 0x30)); // 0..9
    else if (code >= 0x41 && code <= 0x5a) out.push(0xbb + (code - 0x41)); // A..Z
    else if (code === 0x21) out.push(0xab); // !
    else if (code === 0x2e) out.push(0xad); // .
    else if (code === 0x2c) out.push(0xb8); // ,
    else if (code === 0x27) out.push(0xb4); // '
    else if (code === 0x2d) out.push(0xae); // -
    else out.push(0x00); // unknown → space
  }
  out.push(0xff); // terminator
  return new Uint8Array(out);
}

export async function proposeSetRegionMapLabel(
  ctx: ToolContext,
  args: {
    sectionIndex: number;
    x: number;
    y: number;
    width: number;
    height: number;
    name: string;
    description?: string;
  },
  deps: { fetchFn?: typeof fetch } = {},
): Promise<ProposeSetRegionMapLabelResult> {
  void await readManifest(ctx.projectRoot); // ensure project is scanned
  const rom = await findRomFile(ctx.projectRoot);
  if (!rom) return emptyResult(args.sectionIndex, `No .gba in ${ctx.projectRoot}`);

  // Locate the region-map sections table.
  const romBytes = new Uint8Array(rom.bytes);
  const table = worldApi.scanRegionMapSections(romBytes);
  if (table === null) {
    return emptyResult(
      args.sectionIndex,
      'Could not locate the gRegionMapEntries table. Re-scan the project.',
    );
  }
  if (args.sectionIndex >= table.entryCount) {
    return emptyResult(
      args.sectionIndex,
      `sectionIndex ${String(args.sectionIndex)} is past the table end (${String(table.entryCount)} entries). The table can\'t be grown in-place by this tool; use a section id within range.`,
    );
  }

  const entrySize = table.entrySize;
  const layoutKind = table.layoutKind;
  const entryOffset = table.tableStart + args.sectionIndex * entrySize;

  // Encode the new name.
  const nameBytes = encodeGen3Text(args.name);

  // Decide: write in place over existing name, or allocate fresh.
  const oldEntry = table.sections[args.sectionIndex];
  let nameOffset: number | null = null;
  let nameWriteEdit: AgentPatchEdit | null = null;
  if (oldEntry && oldEntry.nameRomPointer !== 0) {
    const existingOff = oldEntry.nameRomPointer - 0x08000000;
    // Walk to find the existing name's slot size (until 0xFF terminator).
    let slot = 1;
    while (slot < 64 && existingOff + slot - 1 < rom.bytes.length) {
      if (rom.bytes[existingOff + slot - 1] === 0xff) break;
      slot++;
    }
    if (nameBytes.length <= slot) {
      // Fits in place.
      const oldBytes = new Uint8Array(rom.bytes.subarray(existingOff, existingOff + slot));
      const padded = new Uint8Array(slot);
      padded.set(nameBytes, 0);
      for (let i = nameBytes.length; i < slot; i++) padded[i] = 0xff;
      nameWriteEdit = {
        kind: 'binary_write_bytes',
        offset: existingOff,
        beforeBytes: bytesToHex(oldBytes),
        afterBytes: bytesToHex(padded),
        note: `overwrite name "${args.name}" for section ${String(args.sectionIndex)}`,
      } satisfies BinaryWriteBytesEdit;
      nameOffset = existingOff;
    }
  }
  if (nameWriteEdit === null) {
    // Allocate fresh.
    const free = romApi.findFreeRomSpace(romBytes, nameBytes.length);
    if (!free) return emptyResult(args.sectionIndex, 'No free ROM space for new name.');
    nameOffset = free.offset;
    nameWriteEdit = {
      kind: 'binary_write_bytes',
      offset: free.offset,
      beforeBytes: bytesToHex(new Uint8Array(nameBytes.length).fill(free.fillByte)),
      afterBytes: bytesToHex(nameBytes),
      requireFreeSlot: true,
      note: `allocate name "${args.name}" for section ${String(args.sectionIndex)}`,
    } satisfies BinaryWriteBytesEdit;
  }

  // Encode the entry.
  const entryBytes = mapsApi.encodeRegionMapSection(
    { x: args.x, y: args.y, width: args.width, height: args.height, nameOffset },
    layoutKind,
  );
  const oldEntryBytes = new Uint8Array(rom.bytes.subarray(entryOffset, entryOffset + entrySize));
  const entryWriteEdit: AgentPatchEdit = {
    kind: 'binary_write_bytes',
    offset: entryOffset,
    beforeBytes: bytesToHex(oldEntryBytes),
    afterBytes: bytesToHex(entryBytes),
    note: `rewrite region-map section ${String(args.sectionIndex)}: ${args.name}`,
  } satisfies BinaryWriteBytesEdit;

  const description = args.description ?? `Set region-map label ${String(args.sectionIndex)}: ${args.name} @ (${String(args.x)},${String(args.y)}) ${String(args.width)}×${String(args.height)}`;
  let proposal: AgentPatchProposal;
  try {
    proposal = await proposePatch(ctx, { description, edits: [nameWriteEdit, entryWriteEdit] }, deps);
  } catch (e) {
    if (e instanceof ProposePatchError) return emptyResult(args.sectionIndex, `Failed to register proposal: ${e.message}`);
    throw e;
  }
  return {
    proposal,
    sectionIndex: args.sectionIndex,
    bytesWritten: nameBytes.length + entrySize,
    message: `Region-map section ${String(args.sectionIndex)} set to "${args.name}".`,
  };
}
