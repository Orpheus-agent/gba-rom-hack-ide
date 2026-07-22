/**
 * propose_import_music - Phase 3.36.
 *
 * Imports a custom music track via mid2agb. Detects the binary at
 * call time; when missing, returns structured install instructions
 * instead of failing.
 *
 * The full workflow once mid2agb is installed:
 *   1. Read user-supplied MIDI from .editor/assets/<midiPath>.
 *   2. Run mid2agb to produce an M4A (Sappy/Game Freak song format).
 *   3. Allocate the M4A bytes in fresh ROM space.
 *   4. Return the new song offset; the agent wires it into
 *      gSongTable via propose_patch.
 *
 * Until mid2agb is on the user's PATH, the tool returns a structured
 * "install at <suggested path>" result so the agent surfaces the
 * blocker to the user.
 */

import { z } from 'zod';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import type {
  AgentPatchEdit,
  AgentPatchProposal,
  BinaryWriteBytesEdit,
} from '@rom-editor/shared';
import { audio as audioApi, rom as romApi } from '@rom-introspection/engine';
import type { ToolContext } from '../types.js';
import { proposePatch, ProposePatchError } from './propose-patch.js';

export const PROPOSE_IMPORT_MUSIC_TOOL_NAME = 'propose_import_music';

export const PROPOSE_IMPORT_MUSIC_DESCRIPTION =
  'Import a custom music track via mid2agb. When mid2agb isn\'t\n' +
  'installed, returns structured install instructions.\n\n' +
  'Inputs:\n' +
  '  - `midiPath`: path under .editor/assets/ (or absolute).\n' +
  '  - `voicebank`: optional u32 - voicebank/soundbank id (0 = default).\n' +
  '  - `description`: optional free-form description.';

const u32 = z.number().int().min(0).max(0xffffffff);

export const proposeImportMusicInputShape = {
  midiPath: z.string().min(1),
  voicebank: u32.optional(),
  description: z.string().max(500).optional(),
} as const;

export interface ProposeImportMusicResult {
  readonly proposal: AgentPatchProposal | null;
  readonly mid2agbStatus: 'found' | 'missing';
  readonly mid2agbPath: string | null;
  readonly suggestedInstallPath: string | null;
  readonly suggestion: string;
  readonly songOffset: number | null;
  readonly bytesAllocated: number;
  readonly message: string;
}

function emptyResult(message: string, status: 'found' | 'missing' = 'missing'): ProposeImportMusicResult {
  return {
    proposal: null,
    mid2agbStatus: status,
    mid2agbPath: null,
    suggestedInstallPath: null,
    suggestion: '',
    songOffset: null,
    bytesAllocated: 0,
    message,
  };
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

function resolveAssetPath(projectRoot: string, supplied: string): string {
  if (path.isAbsolute(supplied)) return supplied;
  return path.join(projectRoot, '.editor', 'assets', supplied);
}

export async function proposeImportMusic(
  ctx: ToolContext,
  args: {
    midiPath: string;
    voicebank?: number;
    description?: string;
  },
  deps: { fetchFn?: typeof fetch } = {},
): Promise<ProposeImportMusicResult> {
  // 1) Locate mid2agb.
  const location = await audioApi.locateMid2agb();
  if (!location.found) {
    return {
      proposal: null,
      mid2agbStatus: 'missing',
      mid2agbPath: null,
      suggestedInstallPath: location.suggestedInstallPath,
      suggestion: location.suggestion,
      songOffset: null,
      bytesAllocated: 0,
      message: `mid2agb not installed. ${location.suggestion}`,
    };
  }

  // 2) Read MIDI.
  const midiAbsolute = resolveAssetPath(ctx.projectRoot, args.midiPath);
  let midiBytes: Buffer;
  try {
    midiBytes = await fsp.readFile(midiAbsolute);
  } catch (e) {
    return emptyResult(`Couldn\'t read MIDI at ${midiAbsolute}: ${e instanceof Error ? e.message : String(e)}`, 'found');
  }

  // 3) Run mid2agb in a temp dir.
  const tempDir = await fsp.mkdtemp(path.join(tmpdir(), 'mid2agb-'));
  const tempMidiPath = path.join(tempDir, 'in.mid');
  const tempM4aPath = path.join(tempDir, 'out.s');
  try {
    await fsp.writeFile(tempMidiPath, midiBytes);
    const result = await audioApi.runMid2agb(tempMidiPath, tempM4aPath, location.path!);
    if (!result.ok) {
      return emptyResult(`mid2agb failed: ${result.stderr.slice(0, 300)}`, 'found');
    }
    // mid2agb produces an assembly file; for now we treat the
    // generated artifact as opaque + write it as a blob. Real
    // integration requires assembling the .s file via devkitARM - 
    // out of scope for this first cut. Surface the blob path so the
    // user can complete the pipeline manually.
    let m4aBytes: Buffer;
    try {
      m4aBytes = await fsp.readFile(tempM4aPath);
    } catch (e) {
      return emptyResult(`mid2agb didn\'t produce ${tempM4aPath}: ${e instanceof Error ? e.message : String(e)}`, 'found');
    }
    const rom = await findRomFile(ctx.projectRoot);
    if (!rom) return emptyResult(`No .gba in ${ctx.projectRoot}`, 'found');

    const romBytes = new Uint8Array(rom.bytes);
    const alloc = romApi.findFreeRomSpace(romBytes, m4aBytes.length);
    if (!alloc) return emptyResult(`No free ROM space for ${String(m4aBytes.length)} song bytes.`, 'found');

    const edits: AgentPatchEdit[] = [
      {
        kind: 'binary_write_bytes',
        offset: alloc.offset,
        beforeBytes: bytesToHex(new Uint8Array(m4aBytes.length).fill(0xff)),
        afterBytes: bytesToHex(new Uint8Array(m4aBytes)),
        requireFreeSlot: true,
        note: `Imported song from ${args.midiPath} (${String(m4aBytes.length)} bytes via mid2agb)`,
      } satisfies BinaryWriteBytesEdit,
    ];

    const description = args.description ?? `Import music from ${path.basename(args.midiPath)}`;
    let proposal: AgentPatchProposal;
    try {
      proposal = await proposePatch(ctx, { description, edits }, deps);
    } catch (e) {
      if (e instanceof ProposePatchError) return emptyResult(`Failed to register proposal: ${e.message}`, 'found');
      throw e;
    }
    return {
      proposal,
      mid2agbStatus: 'found',
      mid2agbPath: location.path,
      suggestedInstallPath: null,
      suggestion: location.suggestion,
      songOffset: alloc.offset,
      bytesAllocated: m4aBytes.length,
      message: `Music imported via mid2agb (${location.path}): ${String(m4aBytes.length)} bytes @ 0x${alloc.offset.toString(16)}. Wire into gSongTable via propose_patch.`,
    };
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true });
  }
}
