/**
 * propose_set_sound_effect (Phase 3.37) + propose_set_cry (Phase 3.38).
 *
 * Both tools share the same WAV → 8-bit PCM → ROM allocation pipeline.
 * They differ only in:
 *   - Target sample rate (cries: ~13379 Hz vanilla; SFX: variable)
 *   - Wiring guidance (cry → gCryTable; SFX → gSampleTable)
 *
 * Single shared implementation, two registered tool names.
 */

import { z } from 'zod';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import type {
  AgentPatchEdit,
  AgentPatchProposal,
  BinaryWriteBytesEdit,
} from '@rom-editor/shared';
import { audio as audioApi, rom as romApi } from '@rom-introspection/engine';
import type { ToolContext } from '../types.js';
import { proposePatch, ProposePatchError } from './propose-patch.js';

const u16 = z.number().int().min(0).max(0xffff);

export const proposeSetSoundEffectInputShape = {
  effectId: u16,
  wavPath: z.string().min(1),
  targetSampleRate: z.number().int().min(1000).max(48000).optional(),
  description: z.string().max(500).optional(),
} as const;

export const proposeSetCryInputShape = {
  speciesId: u16,
  wavPath: z.string().min(1),
  description: z.string().max(500).optional(),
} as const;

export interface ProposeImportAudioSampleResult {
  readonly proposal: AgentPatchProposal | null;
  readonly sampleOffset: number | null;
  readonly sourceSampleRate: number;
  readonly outputSampleRate: number;
  readonly samples: number;
  readonly bytesAllocated: number;
  readonly message: string;
}

export const PROPOSE_SET_SOUND_EFFECT_TOOL_NAME = 'propose_set_sound_effect';
export const PROPOSE_SET_SOUND_EFFECT_DESCRIPTION =
  'Import a WAV as a sound effect. The tool downmixes stereo to mono,\n' +
  'converts 16-bit to 8-bit, optionally resamples to the target rate,\n' +
  'and allocates the PCM in fresh ROM space.\n\n' +
  'Inputs:\n' +
  '  - `effectId`: u16 - the gSampleTable index this SFX targets.\n' +
  '  - `wavPath`: path under .editor/assets/.\n' +
  '  - `targetSampleRate`: optional (default: source rate; typical\n' +
  '    SFX sample rates are 8000-22050 Hz).\n\n' +
  'Returns the allocated PCM offset; the agent wires it into the\n' +
  'gSampleTable via propose_patch.';

export const PROPOSE_SET_CRY_TOOL_NAME = 'propose_set_cry';
export const PROPOSE_SET_CRY_DESCRIPTION =
  'Import a WAV as a Pokémon cry. Downmixes/8-bit/resamples to the\n' +
  'CFRU canonical cry rate (~13379 Hz) and allocates in fresh ROM\n' +
  'space.\n\n' +
  'Inputs:\n' +
  '  - `speciesId`: u16 - the gCryTable index.\n' +
  '  - `wavPath`: path under .editor/assets/.\n\n' +
  'Returns the allocated PCM offset; the agent wires it into the\n' +
  'gCryTable via propose_patch.';

/** Canonical Gen-3 cry sample rate. */
const CRY_TARGET_SAMPLE_RATE = 13379;

function emptyResult(message: string): ProposeImportAudioSampleResult {
  return { proposal: null, sampleOffset: null, sourceSampleRate: 0, outputSampleRate: 0, samples: 0, bytesAllocated: 0, message };
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

async function importAudioSample(
  ctx: ToolContext,
  args: {
    wavPath: string;
    targetSampleRate: number;
    description: string;
  },
  deps: { fetchFn?: typeof fetch } = {},
): Promise<ProposeImportAudioSampleResult> {
  const rom = await findRomFile(ctx.projectRoot);
  if (!rom) return emptyResult(`No .gba in ${ctx.projectRoot}`);
  const wavAbs = resolveAssetPath(ctx.projectRoot, args.wavPath);
  let wavBytes: Buffer;
  try {
    wavBytes = await fsp.readFile(wavAbs);
  } catch (e) {
    return emptyResult(`Couldn\'t read WAV at ${wavAbs}: ${e instanceof Error ? e.message : String(e)}`);
  }
  let decoded;
  try {
    decoded = audioApi.decodeWav(new Uint8Array(wavBytes));
  } catch (e) {
    return emptyResult(`WAV decode failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  // Resample to target rate.
  const resampled = audioApi.resamplePcm(decoded.pcmSigned8, decoded.sampleRate, args.targetSampleRate);
  // Convert Int8Array to Uint8Array (the engine writes raw bytes; -128..127 wraps to 0x80..0x7F).
  const pcmBytes = new Uint8Array(resampled.length);
  for (let i = 0; i < resampled.length; i++) pcmBytes[i] = resampled[i]! & 0xff;

  const romBytes = new Uint8Array(rom.bytes);
  const alloc = romApi.findFreeRomSpace(romBytes, pcmBytes.length);
  if (!alloc) return emptyResult(`No free ROM space for ${String(pcmBytes.length)} sample bytes.`);

  const edits: AgentPatchEdit[] = [
    {
      kind: 'binary_write_bytes',
      offset: alloc.offset,
      beforeBytes: bytesToHex(new Uint8Array(pcmBytes.length).fill(0xff)),
      afterBytes: bytesToHex(pcmBytes),
      requireFreeSlot: true,
      note: `8-bit signed PCM (${String(pcmBytes.length)} samples @ ${String(args.targetSampleRate)} Hz)`,
    } satisfies BinaryWriteBytesEdit,
  ];

  let proposal: AgentPatchProposal;
  try {
    proposal = await proposePatch(ctx, { description: args.description, edits }, deps);
  } catch (e) {
    if (e instanceof ProposePatchError) return emptyResult(`Failed: ${e.message}`);
    throw e;
  }
  return {
    proposal,
    sampleOffset: alloc.offset,
    sourceSampleRate: decoded.sampleRate,
    outputSampleRate: args.targetSampleRate,
    samples: resampled.length,
    bytesAllocated: pcmBytes.length,
    message: `Audio sample @ 0x${alloc.offset.toString(16)}: ${String(resampled.length)} samples @ ${String(args.targetSampleRate)} Hz (source ${String(decoded.sampleRate)} Hz).`,
  };
}

export async function proposeSetSoundEffect(
  ctx: ToolContext,
  args: {
    effectId: number;
    wavPath: string;
    targetSampleRate?: number;
    description?: string;
  },
  deps: { fetchFn?: typeof fetch } = {},
): Promise<ProposeImportAudioSampleResult> {
  return importAudioSample(
    ctx,
    {
      wavPath: args.wavPath,
      targetSampleRate: args.targetSampleRate ?? 16000,
      description: args.description ?? `Import sound effect ${String(args.effectId)} from ${args.wavPath}`,
    },
    deps,
  );
}

export async function proposeSetCry(
  ctx: ToolContext,
  args: { speciesId: number; wavPath: string; description?: string },
  deps: { fetchFn?: typeof fetch } = {},
): Promise<ProposeImportAudioSampleResult> {
  return importAudioSample(
    ctx,
    {
      wavPath: args.wavPath,
      targetSampleRate: CRY_TARGET_SAMPLE_RATE,
      description: args.description ?? `Import cry for species ${String(args.speciesId)} from ${args.wavPath}`,
    },
    deps,
  );
}
