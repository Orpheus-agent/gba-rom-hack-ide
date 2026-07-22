/**
 * propose_pokedex_entry - Phase 3.42.
 *
 * Rewrites a species' 32-byte gPokedexEntries record + allocates a
 * fresh description string for it. Targets DPE/CFRU-extended ROMs
 * but works on any Gen-3 cart whose gPokedexEntries follows the
 * pret canonical layout.
 */

import { z } from 'zod';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import type {
  AgentPatchEdit,
  AgentPatchProposal,
  BinaryWriteBytesEdit,
} from '@rom-editor/shared';
import { rom as romApi, species as speciesApi, text as textApi } from '@rom-introspection/engine';
import { readManifest } from '../../scan/manifest-io.js';
import type { ToolContext } from '../types.js';
import { proposePatch, ProposePatchError } from './propose-patch.js';

export const PROPOSE_POKEDEX_ENTRY_TOOL_NAME = 'propose_pokedex_entry';

export const PROPOSE_POKEDEX_ENTRY_DESCRIPTION =
  'Rewrite a species\' Pokédex entry (32-byte struct) + allocate the\n' +
  'description text. Works on vanilla, CFRU, and CFRU+DPE ROMs.\n\n' +
  'Inputs:\n' +
  '  - `speciesId`: u16.\n' +
  '  - `categoryName`: 1-11 ASCII chars (e.g. "SEED", "FLAME").\n' +
  '  - `height`: decimeters (0..999 = 0..99.9 m).\n' +
  '  - `weight`: hectograms (0..9999 = 0..999.9 kg).\n' +
  '  - `description`: multi-line flavor text (encoded via Gen-3 codec\n' +
  '    + allocated in fresh ROM space).\n' +
  '  - `pokemonScale` / `pokemonOffset` / `trainerScale` / `trainerOffset`:\n' +
  '    u16 sprite-display parameters (typical: scale 256..512, offset 0..30).';

const u16 = z.number().int().min(0).max(0xffff);
const dexValue = z.number().int().min(0).max(9999);

export const proposePokedexEntryInputShape = {
  speciesId: u16,
  categoryName: z.string().min(1).max(11),
  height: dexValue,
  weight: dexValue,
  description: z.string().min(1).max(2000),
  pokemonScale: u16.optional(),
  pokemonOffset: u16.optional(),
  trainerScale: u16.optional(),
  trainerOffset: u16.optional(),
  descriptionStr: z.string().max(500).optional(),
} as const;

export interface ProposePokedexEntryResult {
  readonly proposal: AgentPatchProposal | null;
  readonly speciesId: number;
  readonly entryOffset: number | null;
  readonly descriptionOffset: number | null;
  readonly bytesWritten: number;
  readonly message: string;
}

function emptyResult(speciesId: number, message: string): ProposePokedexEntryResult {
  return { proposal: null, speciesId, entryOffset: null, descriptionOffset: null, bytesWritten: 0, message };
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

/** Encode flavor text in Gen-3 charset via the engine's namespace export. */
function encodeGen3FlavorText(text: string): Uint8Array {
  return textApi.encodeString(text);
}

export async function proposePokedexEntry(
  ctx: ToolContext,
  args: {
    speciesId: number;
    categoryName: string;
    height: number;
    weight: number;
    description: string;
    pokemonScale?: number;
    pokemonOffset?: number;
    trainerScale?: number;
    trainerOffset?: number;
    descriptionStr?: string;
  },
  deps: { fetchFn?: typeof fetch } = {},
): Promise<ProposePokedexEntryResult> {
  void await readManifest(ctx.projectRoot);
  const rom = await findRomFile(ctx.projectRoot);
  if (!rom) return emptyResult(args.speciesId, `No .gba in ${ctx.projectRoot}`);

  const romBytes = new Uint8Array(rom.bytes);
  const table = speciesApi.scanPokedexTable(romBytes);
  if (!table) return emptyResult(args.speciesId, 'Could not locate gPokedexEntries.');
  if (args.speciesId >= table.entryCount) {
    return emptyResult(
      args.speciesId,
      `speciesId ${String(args.speciesId)} is past the table end (${String(table.entryCount)} entries).`,
    );
  }

  const entryOffset = table.tableStart + args.speciesId * 32;
  const oldEntryBytes = new Uint8Array(rom.bytes.subarray(entryOffset, entryOffset + 32));

  // Allocate description text.
  let descBytes: Uint8Array;
  try {
    descBytes = encodeGen3FlavorText(args.description);
  } catch (e) {
    return emptyResult(args.speciesId, `Failed to encode description: ${e instanceof Error ? e.message : String(e)}`);
  }
  const descAlloc = romApi.findFreeRomSpace(romBytes, descBytes.length);
  if (!descAlloc) return emptyResult(args.speciesId, 'No free ROM space for description.');

  // Build the new entry.
  const newEntry = speciesApi.encodePokedexEntry({
    categoryName: args.categoryName,
    height: args.height,
    weight: args.weight,
    descriptionOffset: descAlloc.offset,
    unusedDescriptionOffset: null,
    pokemonScale: args.pokemonScale ?? 256,
    pokemonOffset: args.pokemonOffset ?? 0,
    trainerScale: args.trainerScale ?? 256,
    trainerOffset: args.trainerOffset ?? 0,
  });

  const edits: AgentPatchEdit[] = [
    {
      kind: 'binary_write_bytes',
      offset: descAlloc.offset,
      beforeBytes: bytesToHex(new Uint8Array(descBytes.length).fill(descAlloc.fillByte)),
      afterBytes: bytesToHex(descBytes),
      requireFreeSlot: true,
      note: `Pokédex description for species ${String(args.speciesId)}`,
    } satisfies BinaryWriteBytesEdit,
    {
      kind: 'binary_write_bytes',
      offset: entryOffset,
      beforeBytes: bytesToHex(oldEntryBytes),
      afterBytes: bytesToHex(newEntry),
      note: `gPokedexEntries[${String(args.speciesId)}]`,
    } satisfies BinaryWriteBytesEdit,
  ];

  const description = args.descriptionStr ?? `Set Pokédex entry for species ${String(args.speciesId)} ("${args.categoryName}")`;
  let proposal: AgentPatchProposal;
  try {
    proposal = await proposePatch(ctx, { description, edits }, deps);
  } catch (e) {
    if (e instanceof ProposePatchError) return emptyResult(args.speciesId, `Failed: ${e.message}`);
    throw e;
  }
  return {
    proposal,
    speciesId: args.speciesId,
    entryOffset,
    descriptionOffset: descAlloc.offset,
    bytesWritten: 32 + descBytes.length,
    message: `Pokédex entry for species ${String(args.speciesId)}: ${args.categoryName} Pokémon, ${String(args.height / 10).slice(0, 4)}m / ${String(args.weight / 10).slice(0, 4)}kg.`,
  };
}
