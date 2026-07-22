/**
 * propose_cutscene - Phase 3.20.
 *
 * High-level DSL for composing choreographed scenes (intro cutscene,
 * legendary encounter, gym leader monologue, etc.). The agent
 * supplies a beat list - each beat is a tagged union - and the tool
 * compiles them to the underlying Gen-3 script-step sequence which
 * propose_script_edit's encoder writes to ROM.
 *
 * Supported beats:
 *
 *   { kind: 'lock_all' }
 *   { kind: 'release_all' }
 *   { kind: 'face_player', npcId? }
 *   { kind: 'dialogue', text, stdType? }
 *   { kind: 'pause', frames }
 *   { kind: 'set_flag', flagId } | { kind: 'clear_flag', flagId }
 *   { kind: 'set_variable', varId, value }
 *   { kind: 'play_sound', songId }
 *   { kind: 'play_fanfare', songId }
 *   { kind: 'play_bgm', songId }
 *   { kind: 'fade_out', frames? } | { kind: 'fade_in', frames? }
 *   { kind: 'give_item', itemId, quantity? }
 *   { kind: 'start_battle', trainerId }
 *   { kind: 'warp', destMapBank, destMapNum, x, y }
 *   { kind: 'branch_on_var', varId, operator, value, targetScriptId }
 *
 * Each beat compiles to 1+ DecodedScriptStep entries via the engine's
 * encoder. The tool reuses computeScriptEdit from propose-script-edit
 * as the apply layer; the result is a single proposal containing
 * binary_write_bytes edits for the full compiled sequence.
 *
 * Out of scope (defer to follow-up):
 *   - pan_camera (needs ARM helper; CFRU may not expose a clean
 *     stdscript for it).
 *   - move_npc with arbitrary sequences (use propose_script_edit
 *     directly for now; this DSL targets the 80% case).
 *   - choice prompts with multi-branch (use propose_dialogue_branch_on_var
 *     after the dialogue for now).
 */

import { z } from 'zod';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import type { AgentPatchEdit, AgentPatchProposal, BinaryWriteBytesEdit } from '@rom-editor/shared';
import { rom as romApi, scripts as scriptsApi } from '@rom-introspection/engine';
import type { ToolContext } from '../types.js';
import { proposePatch, ProposePatchError } from './propose-patch.js';

export const PROPOSE_CUTSCENE_TOOL_NAME = 'propose_cutscene';

export const PROPOSE_CUTSCENE_DESCRIPTION =
  'Compose a choreographed cutscene as a sequence of high-level beats.\n' +
  'The tool compiles to Gen-3 script bytecode + allocates a fresh ROM\n' +
  'slot. The new script\'s entry offset is returned; the agent then\n' +
  'wires it into an NPC, trigger, or map-script via propose_patch.\n\n' +
  'Inputs:\n' +
  '  - `beats`: array of cutscene beats (1-100). Each beat is a tagged\n' +
  '    object with a `kind` discriminator. See the DSL grammar in the\n' +
  '    source for the full list.\n' +
  '  - `terminator`: \'end\' (default) | \'return\' - terminator opcode\n' +
  '    appended after the last beat.\n\n' +
  'Returns the entry offset of the compiled script + bytes-written.';

const u8 = z.number().int().min(0).max(0xff);
const u16 = z.number().int().min(0).max(0xffff);
const u32 = z.number().int().min(0).max(0xffffffff);

const beatSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('lock_all') }),
  z.object({ kind: z.literal('release_all') }),
  z.object({ kind: z.literal('face_player') }),
  z.object({
    kind: z.literal('dialogue'),
    text: z.string().min(1).max(500),
    stdType: u8.optional(),
  }),
  z.object({ kind: z.literal('pause'), frames: z.number().int().min(0).max(0xffff) }),
  z.object({ kind: z.literal('set_flag'), flagId: u16 }),
  z.object({ kind: z.literal('clear_flag'), flagId: u16 }),
  z.object({ kind: z.literal('set_variable'), varId: u16, value: u16 }),
  z.object({ kind: z.literal('play_sound'), songId: u16 }),
  z.object({ kind: z.literal('play_fanfare'), songId: u16 }),
  z.object({ kind: z.literal('play_bgm'), songId: u16 }),
  z.object({ kind: z.literal('fade_out'), fadeType: u8.optional() }),
  z.object({ kind: z.literal('fade_in'), fadeType: u8.optional() }),
  z.object({ kind: z.literal('give_item'), itemId: u16, quantity: u16.optional() }),
  z.object({ kind: z.literal('start_battle'), trainerId: u16 }),
  z.object({
    kind: z.literal('warp'),
    destMapBank: u8,
    destMapNum: u8,
    x: u16,
    y: u16,
  }),
  z.object({
    kind: z.literal('branch_on_var'),
    varId: u16,
    operator: z.enum(['less', 'equal', 'greater', 'lessorequal', 'greaterorequal', 'notequal']),
    value: u16,
    targetRomPtr: u32,
  }),
]);

export const proposeCutsceneInputShape = {
  beats: z.array(beatSchema).min(1).max(100),
  terminator: z.enum(['end', 'return']).optional(),
  description: z.string().max(500).optional(),
} as const;

export type CutsceneBeat = z.infer<typeof beatSchema>;

export interface ProposeCutsceneResult {
  readonly proposal: AgentPatchProposal | null;
  readonly scriptOffset: number | null;
  readonly bytesAllocated: number;
  readonly stepCount: number;
  readonly message: string;
}

function emptyResult(message: string): ProposeCutsceneResult {
  return { proposal: null, scriptOffset: null, bytesAllocated: 0, stepCount: 0, message };
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

/** Compile a beat list into the EncodableStep[] the engine encoder
 *  consumes. Each beat produces 1+ steps; the encoder handles
 *  allocations for dialogue text + movement blocks. */
function compileBeats(beats: ReadonlyArray<CutsceneBeat>): Array<scriptsApi.EncodableStep> {
  const steps: scriptsApi.EncodableStep[] = [];
  for (const beat of beats) {
    switch (beat.kind) {
      case 'lock_all':
        steps.push({ kind: 'raw', params: { opcode: 0x69 } }); // lockall
        break;
      case 'release_all':
        steps.push({ kind: 'raw', params: { opcode: 0x6b } }); // releaseall
        break;
      case 'face_player':
        steps.push({ kind: 'raw', params: { opcode: 0x5d } });
        break;
      case 'dialogue':
        steps.push({
          kind: 'dialogue',
          params: { dialogueText: beat.text, stdType: beat.stdType ?? 4, dialogueDirty: true },
        });
        break;
      case 'pause':
        steps.push({ kind: 'raw', params: { opcode: 0x40, argBytes: [beat.frames & 0xff, (beat.frames >>> 8) & 0xff] } });
        break;
      case 'set_flag':
        steps.push({ kind: 'set_flag', params: { flagId: beat.flagId } });
        break;
      case 'clear_flag':
        steps.push({ kind: 'clear_flag', params: { flagId: beat.flagId } });
        break;
      case 'set_variable':
        steps.push({
          kind: 'set_variable',
          params: { opcodeName: 'setvar', varId: beat.varId, value: beat.value },
        });
        break;
      case 'play_sound':
        steps.push({ kind: 'play_sound', params: { opcodeName: 'playse', songId: beat.songId } });
        break;
      case 'play_fanfare':
        steps.push({ kind: 'play_sound', params: { opcodeName: 'playfanfare', songId: beat.songId } });
        steps.push({ kind: 'play_sound', params: { opcodeName: 'waitfanfare' } });
        break;
      case 'play_bgm':
        steps.push({ kind: 'play_sound', params: { opcodeName: 'fadenewbgm', songId: beat.songId } });
        break;
      case 'fade_out':
        steps.push({ kind: 'fade_scene', params: { opcodeName: 'fadescreen', fadeType: beat.fadeType ?? 1 } });
        break;
      case 'fade_in':
        steps.push({ kind: 'fade_scene', params: { opcodeName: 'fadescreen', fadeType: beat.fadeType ?? 0 } });
        break;
      case 'give_item':
        steps.push({
          kind: 'give_item',
          params: {
            opcodeName: 'giveitem',
            itemId: beat.itemId,
            quantity: beat.quantity ?? 1,
            callbackType: 0,
          },
        });
        break;
      case 'start_battle':
        steps.push({
          kind: 'start_battle',
          params: {
            battleType: 0,
            trainerId: beat.trainerId,
            trainerbattleRemainder: new Array<number>(12).fill(0),
          },
        });
        break;
      case 'warp':
        steps.push({
          kind: 'warp_player',
          params: {
            opcodeName: 'warp',
            destMapBank: beat.destMapBank,
            destMapNum: beat.destMapNum,
            warpId: 0,
            x: beat.x,
            y: beat.y,
          },
        });
        break;
      case 'branch_on_var':
        steps.push({
          kind: 'branch_on_var',
          params: {
            varId: beat.varId,
            value: beat.value,
            operator: beat.operator,
            targetRomPtr: beat.targetRomPtr,
          },
        });
        break;
    }
  }
  return steps;
}

export async function proposeCutscene(
  ctx: ToolContext,
  args: {
    beats: ReadonlyArray<CutsceneBeat>;
    terminator?: 'end' | 'return';
    description?: string;
  },
  deps: { fetchFn?: typeof fetch } = {},
): Promise<ProposeCutsceneResult> {
  const rom = await findRomFile(ctx.projectRoot);
  if (!rom) return emptyResult(`No .gba in ${ctx.projectRoot}`);

  const romBytes = new Uint8Array(rom.bytes);
  const steps = compileBeats(args.beats);
  // Append terminator.
  if (args.terminator === 'return') {
    steps.push({ kind: 'raw', params: { opcode: 0x03 } });
  } else {
    steps.push({ kind: 'raw', params: { opcode: 0x02 } });
  }

  // Allocator: each text block goes into a separate free slot.
  const allocator = new InBatchAllocator(romBytes);
  let encoded: Uint8Array;
  try {
    encoded = scriptsApi.encodeScript(steps, {
      allocate: (req) => {
        const off = allocator.allocate(req.bytes);
        if (off === null) throw new Error(`no free space for ${req.kind} block of ${String(req.bytes.length)} bytes`);
        return off;
      },
    });
  } catch (e) {
    return emptyResult(`Encode failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Allocate the script bytecode itself.
  const scriptOffset = allocator.allocate(encoded);
  if (scriptOffset === null) return emptyResult(`No free ROM space for ${String(encoded.length)} script bytes.`);

  // Emit edits for every allocation.
  const edits: AgentPatchEdit[] = [];
  for (const alloc of allocator.drain()) {
    edits.push({
      kind: 'binary_write_bytes',
      offset: alloc.offset,
      beforeBytes: bytesToHex(new Uint8Array(alloc.bytes.length).fill(alloc.fillByte)),
      afterBytes: bytesToHex(alloc.bytes),
      requireFreeSlot: true,
      note: `cutscene allocation: ${String(alloc.bytes.length)} bytes`,
    } satisfies BinaryWriteBytesEdit);
  }

  const description = args.description ?? `Compose ${String(args.beats.length)}-beat cutscene (${String(encoded.length)} bytes)`;
  let proposal: AgentPatchProposal;
  try {
    proposal = await proposePatch(ctx, { description, edits }, deps);
  } catch (e) {
    if (e instanceof ProposePatchError) return emptyResult(`Failed to register proposal: ${e.message}`);
    throw e;
  }
  return {
    proposal,
    scriptOffset,
    bytesAllocated: allocator.totalBytes(),
    stepCount: steps.length,
    message:
      `Cutscene compiled: ${String(steps.length)} steps, ${String(encoded.length)} bytes ` +
      `@ 0x${scriptOffset.toString(16)}. Wire into an NPC/trigger via propose_patch.`,
  };
}

class InBatchAllocator {
  private readonly working: Uint8Array;
  private readonly allocations: { offset: number; bytes: Uint8Array; fillByte: number }[] = [];
  constructor(romBytes: Uint8Array) {
    this.working = new Uint8Array(romBytes);
  }
  allocate(bytes: Uint8Array): number | null {
    if (bytes.length <= 0) return null;
    const r = romApi.findFreeRomSpace(this.working, bytes.length);
    if (!r) return null;
    for (let i = 0; i < bytes.length; i++) this.working[r.offset + i] = 0xaa;
    this.allocations.push({ offset: r.offset, bytes, fillByte: r.fillByte });
    return r.offset;
  }
  drain(): ReadonlyArray<{ offset: number; bytes: Uint8Array; fillByte: number }> {
    return [...this.allocations];
  }
  totalBytes(): number {
    return this.allocations.reduce((s, a) => s + a.bytes.length, 0);
  }
}
