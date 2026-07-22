/**
 * propose_import_pokemon_sprite - Phase 3.17.
 *
 * Imports a Pokémon battle sprite (front + optional back + optional
 * shiny palette). Each piece is 64×64 = 64 tiles. The agent supplies
 * one or more of the three components; the tool allocates each
 * independently and returns the offsets so the agent can wire them
 * into gMonFrontPic / gMonBackPic / gMonPaletteTable /
 * gMonShinyPaletteTable.
 *
 * Front sprite + palette: required (per the schema).
 * Back sprite: optional.
 * Shiny palette: optional.
 */

import { z } from 'zod';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import type {
  AgentPatchEdit,
  AgentPatchProposal,
  BinaryWriteBytesEdit,
} from '@rom-editor/shared';
import { rom as romApi } from '@rom-introspection/engine';
import type { ToolContext } from '../types.js';
import { proposePatch, ProposePatchError } from './propose-patch.js';
import {
  bytesToHex,
  prepareSpriteFromPng,
  SpriteImportError,
} from './_sprite-import-helpers.js';

export const PROPOSE_IMPORT_POKEMON_SPRITE_TOOL_NAME = 'propose_import_pokemon_sprite';

export const PROPOSE_IMPORT_POKEMON_SPRITE_DESCRIPTION =
  'Import a Pokémon battle sprite (front + optional back + optional\n' +
  'shiny). Each PNG must be 64×64.\n\n' +
  'Inputs:\n' +
  '  - `speciesId`: u16 - the species index this sprite is for. The\n' +
  '    tool returns offsets only; the agent wires them into the four\n' +
  '    pointer tables (gMonFrontPic / gMonBackPic / gMonPaletteTable /\n' +
  '    gMonShinyPaletteTable) via propose_patch.\n' +
  '  - `frontPngPath`: path under .editor/assets/ (or absolute) - required.\n' +
  '  - `backPngPath`: optional - the back-pic shown when this Pokémon\n' +
  '    is on the player\'s side.\n' +
  '  - `shinyPngPath`: optional - shiny variant (palette only; the\n' +
  '    tiles are reused from the front sprite).\n' +
  '  - `compress`: default true.';

const u16 = z.number().int().min(0).max(0xffff);

export const proposeImportPokemonSpriteInputShape = {
  speciesId: u16,
  frontPngPath: z.string().min(1),
  backPngPath: z.string().optional(),
  shinyPngPath: z.string().optional(),
  compress: z.boolean().optional(),
  description: z.string().max(500).optional(),
} as const;

export interface ProposeImportPokemonSpriteResult {
  readonly proposal: AgentPatchProposal | null;
  readonly frontTilesOffset: number | null;
  readonly frontPaletteOffset: number | null;
  readonly backTilesOffset: number | null;
  readonly shinyPaletteOffset: number | null;
  readonly bytesAllocated: number;
  readonly message: string;
}

function emptyResult(message: string): ProposeImportPokemonSpriteResult {
  return {
    proposal: null,
    frontTilesOffset: null,
    frontPaletteOffset: null,
    backTilesOffset: null,
    shinyPaletteOffset: null,
    bytesAllocated: 0,
    message,
  };
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

class Allocator {
  private readonly working: Uint8Array;
  private readonly allocations: { offset: number; bytes: Uint8Array; tag: string }[] = [];
  constructor(rom: Uint8Array) { this.working = new Uint8Array(rom); }
  alloc(bytes: Uint8Array, tag: string): number | null {
    const r = romApi.findFreeRomSpace(this.working, bytes.length);
    if (!r) return null;
    for (let i = 0; i < bytes.length; i++) this.working[r.offset + i] = 0xaa;
    this.allocations.push({ offset: r.offset, bytes, tag });
    return r.offset;
  }
  drain(): ReadonlyArray<{ offset: number; bytes: Uint8Array; tag: string }> {
    return this.allocations;
  }
  totalBytes(): number {
    return this.allocations.reduce((s, a) => s + a.bytes.length, 0);
  }
}

export async function proposeImportPokemonSprite(
  ctx: ToolContext,
  args: {
    speciesId: number;
    frontPngPath: string;
    backPngPath?: string;
    shinyPngPath?: string;
    compress?: boolean;
    description?: string;
  },
  deps: { fetchFn?: typeof fetch } = {},
): Promise<ProposeImportPokemonSpriteResult> {
  const rom = await findRomFile(ctx.projectRoot);
  if (!rom) return emptyResult(`No .gba in ${ctx.projectRoot}`);

  let front;
  try {
    front = await prepareSpriteFromPng({
      projectRoot: ctx.projectRoot,
      pngPath: args.frontPngPath,
      compress: args.compress ?? true,
      expectedSize: { widthPx: 64, heightPx: 64 },
    });
  } catch (e) {
    if (e instanceof SpriteImportError) return emptyResult(`Front sprite: ${e.message}`);
    return emptyResult(`Front sprite failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  let back: Awaited<ReturnType<typeof prepareSpriteFromPng>> | null = null;
  if (args.backPngPath) {
    try {
      back = await prepareSpriteFromPng({
        projectRoot: ctx.projectRoot,
        pngPath: args.backPngPath,
        compress: args.compress ?? true,
        expectedSize: { widthPx: 64, heightPx: 64 },
      });
    } catch (e) {
      if (e instanceof SpriteImportError) return emptyResult(`Back sprite: ${e.message}`);
      return emptyResult(`Back sprite failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  let shiny: Awaited<ReturnType<typeof prepareSpriteFromPng>> | null = null;
  if (args.shinyPngPath) {
    try {
      shiny = await prepareSpriteFromPng({
        projectRoot: ctx.projectRoot,
        pngPath: args.shinyPngPath,
        compress: args.compress ?? true,
        expectedSize: { widthPx: 64, heightPx: 64 },
      });
    } catch (e) {
      if (e instanceof SpriteImportError) return emptyResult(`Shiny variant: ${e.message}`);
      return emptyResult(`Shiny variant failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const allocator = new Allocator(new Uint8Array(rom.bytes));
  const frontTilesBytes = front.tilesCompressed ?? front.tilesUncompressed;
  const frontTilesOffset = allocator.alloc(frontTilesBytes, 'front-tiles');
  if (frontTilesOffset === null) return emptyResult('No free ROM space for front tiles.');
  const frontPaletteOffset = allocator.alloc(front.palette, 'front-palette');
  if (frontPaletteOffset === null) return emptyResult('No free ROM space for front palette.');

  let backTilesOffset: number | null = null;
  if (back) {
    const backTilesBytes = back.tilesCompressed ?? back.tilesUncompressed;
    backTilesOffset = allocator.alloc(backTilesBytes, 'back-tiles');
    if (backTilesOffset === null) return emptyResult('No free ROM space for back tiles.');
  }
  let shinyPaletteOffset: number | null = null;
  if (shiny) {
    shinyPaletteOffset = allocator.alloc(shiny.palette, 'shiny-palette');
    if (shinyPaletteOffset === null) return emptyResult('No free ROM space for shiny palette.');
  }

  const edits: AgentPatchEdit[] = [];
  for (const a of allocator.drain()) {
    edits.push({
      kind: 'binary_write_bytes',
      offset: a.offset,
      beforeBytes: bytesToHex(new Uint8Array(a.bytes.length).fill(0xff)),
      afterBytes: bytesToHex(a.bytes),
      requireFreeSlot: true,
      note: `Pokémon sprite ${a.tag} (${String(a.bytes.length)} bytes)`,
    } satisfies BinaryWriteBytesEdit);
  }

  const description =
    args.description ??
    `Import Pokémon sprite for species ${String(args.speciesId)} (front${args.backPngPath ? ' + back' : ''}${args.shinyPngPath ? ' + shiny' : ''})`;
  let proposal: AgentPatchProposal;
  try {
    proposal = await proposePatch(ctx, { description, edits }, deps);
  } catch (e) {
    if (e instanceof ProposePatchError) return emptyResult(`Failed: ${e.message}`);
    throw e;
  }
  return {
    proposal,
    frontTilesOffset,
    frontPaletteOffset,
    backTilesOffset,
    shinyPaletteOffset,
    bytesAllocated: allocator.totalBytes(),
    message:
      `Species ${String(args.speciesId)} sprite imported: front @0x${frontTilesOffset.toString(16)}, palette @0x${frontPaletteOffset.toString(16)}` +
      (backTilesOffset !== null ? `, back @0x${backTilesOffset.toString(16)}` : '') +
      (shinyPaletteOffset !== null ? `, shiny palette @0x${shinyPaletteOffset.toString(16)}` : '') +
      `. Wire into gMonFrontPic/BackPic/PaletteTable/ShinyPaletteTable via propose_patch.`,
  };
}
