import { z } from 'zod';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import type {
  AgentPatchEdit,
  AgentPatchProposal,
  BinaryWriteBytesEdit,
  BinaryRewritePointerEdit,
  ScriptStep,
} from '@rom-editor/shared';
import { rom as romApi, scripts as scriptsApi } from '@rom-introspection/engine';

// ScriptStepKind is namespaced under the `scripts` module export. Pull it
// out via the namespace import so we don't depend on a top-level re-export.
type ScriptStepKind = scriptsApi.ScriptStepKind;
import { readManifest } from '../../scan/manifest-io.js';
import type { ToolContext } from '../types.js';
import { proposePatch, ProposePatchError } from './propose-patch.js';

export const PROPOSE_SCRIPT_EDIT_TOOL_NAME = 'propose_script_edit';

export const PROPOSE_SCRIPT_EDIT_DESCRIPTION =
  'Insert, delete, or modify a step in a Gen-3 script. Decodes the ' +
  "existing bytecode at the script's entrypoint, applies the requested " +
  'mutation, encodes back, and writes the new bytes to ROM. Two write ' +
  'paths, picked automatically:\n\n' +
  '  - **in-place** (new bytes ≤ original): patch the script slot, pad ' +
  '    trailing space with 0xFF. Safe; no pointer changes.\n' +
  '  - **relocate** (new bytes > original): allocate fresh ROM space, ' +
  '    write the new bytecode there, rewrite every NPC / Trigger that ' +
  "    points at the old script's entry, fill the old slot with 0xFF.\n\n" +
  'Common operations:\n' +
  '  - **insertStep**: add a new step at position `stepIndex` (0-based, ' +
  '    `stepIndex: 0` prepends, `stepIndex: existing.length` appends). ' +
  "    Specify the new step's kind + params.\n" +
  '  - **deleteStep**: remove the step at `stepIndex`.\n' +
  '  - **editStep**: replace the step at `stepIndex` with a new one. ' +
  '    To change dialogue text, pass `dialogueDirty: true` in params so ' +
  '    the encoder allocates fresh text space.\n\n' +
  'Inputs:\n' +
  '  - `scriptId`: the script entrypoint id (e.g., `script_0x1a3c5f` from ' +
  '    `ObjectEvent.scriptId` or `binary_script_0x1a3c5f` from ' +
  '    `Trigger.scriptStepIds`).\n' +
  '  - `op`: `insertStep` | `deleteStep` | `editStep`.\n' +
  '  - `stepIndex`: 0-based position the op applies to.\n' +
  '  - `newStep`: for insert/edit, the step shape `{ kind, params }` ' +
  '    matching the decoder vocabulary.\n\n' +
  'Always call `read_decoded_script` first to see the current step list ' +
  'and pick the right index.';

const SCRIPT_STEP_KINDS: ReadonlyArray<ScriptStepKind> = Object.freeze([
  'dialogue',
  'set_flag',
  'clear_flag',
  'branch',
  'branch_on_var',
  'give_item',
  'start_battle',
  'play_sound',
  'move_npc',
  'fade_scene',
  'warp_player',
  'set_variable',
  'randomize_branch',
  'raw',
]);

export const proposeScriptEditInputShape = {
  scriptId: z.string().min(1),
  op: z.enum(['insertStep', 'deleteStep', 'editStep']),
  stepIndex: z.number().int().min(0),
  newStep: z
    .object({
      kind: z.enum(SCRIPT_STEP_KINDS as readonly [ScriptStepKind, ...ScriptStepKind[]]),
      params: z.record(z.string(), z.unknown()),
    })
    .optional(),
  description: z.string().min(1).max(500).optional(),
} as const;

export interface ProposeScriptEditResult {
  readonly proposal: AgentPatchProposal | null;
  readonly scriptOffset: number | null;
  readonly oldByteLength: number;
  readonly newByteLength: number;
  readonly wasRelocated: boolean;
  readonly pointerRewrites: number;
  readonly message: string;
}

/** Tracks free-space allocations within a single call so consecutive
 *  `findFreeRomSpace` lookups don't return overlapping offsets. Mirrors
 *  the InBatchAllocator pattern from propose-rename.ts. */
class InBatchAllocator {
  private readonly working: Uint8Array;
  private readonly allocations: { offset: number; size: number; bytes: Uint8Array; fillByte: number }[] = [];
  constructor(romBytes: Uint8Array) {
    this.working = new Uint8Array(romBytes);
  }
  allocate(bytes: Uint8Array): number | null {
    if (bytes.length <= 0) return null;
    const r = romApi.findFreeRomSpace(this.working, bytes.length);
    if (!r) return null;
    // Mark non-fill so subsequent allocations skip these bytes.
    for (let i = 0; i < bytes.length; i++) this.working[r.offset + i] = 0xaa;
    this.allocations.push({ offset: r.offset, size: bytes.length, bytes, fillByte: r.fillByte });
    return r.offset;
  }
  /** Return every allocation the encoder requested so the proposal can
   *  emit the right binary_write_bytes for each. fillByte is the actual
   *  fill the scanner saw (0xff for vanilla padding, 0x00 for
   *  CFRU-zeroed free runs) - beforeBytes must match it. */
  drain(): ReadonlyArray<{ offset: number; bytes: Uint8Array; fillByte: number }> {
    return this.allocations.map((a) => ({ offset: a.offset, bytes: a.bytes, fillByte: a.fillByte }));
  }
  /** Look up the fillByte recorded for a previously-allocated offset.
   *  Returns 0xff as a safe default (preserves prior behavior for
   *  offsets this allocator didn't produce). */
  fillByteAt(offset: number): number {
    const hit = this.allocations.find((a) => a.offset === offset);
    return hit ? hit.fillByte : 0xff;
  }
}

async function findRomFile(
  projectRoot: string,
): Promise<{ path: string; bytes: Buffer } | null> {
  try {
    const entries = await fsp.readdir(projectRoot, { withFileTypes: true });
    for (const e of entries) {
      if (e.isFile() && e.name.toLowerCase().endsWith('.gba')) {
        const p = path.join(projectRoot, e.name);
        const bytes = await fsp.readFile(p);
        return { path: p, bytes };
      }
    }
  } catch {
    return null;
  }
  return null;
}

/** Recover the ROM file offset from a script id like
 *  `script_0x1a3c5f` or `binary_script_0x1a3c5f` or `script_0x1A3C5F`. */
function parseScriptOffset(scriptId: string): number | null {
  const m = /^(?:binary_)?script_0x([0-9a-fA-F]+)$/.exec(scriptId);
  if (!m) return null;
  const n = parseInt(m[1]!, 16);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** Find every (entityId, byteOffset) that holds a pointer to the
 *  given script's entrypoint, so we can repoint after relocation. */
interface ScriptReference {
  readonly entityKind: 'object_event' | 'trigger';
  readonly entityId: string;
  /** File offset of the 4-byte GBA pointer that targets the script. */
  readonly pointerOffset: number;
}

function collectScriptReferences(
  manifest: NonNullable<Awaited<ReturnType<typeof readManifest>>>,
  scriptId: string,
): ScriptReference[] {
  const out: ScriptReference[] = [];
  // ObjectEvents - scriptPointer lives at structFileOffset + 0x10 in
  // the 24-byte ObjectEventTemplate. The binary-rom lifter stashes the
  // struct's file offset under `binaryFileOffset` (see binary-rom-registry
  // → BinaryRomScanner metadata block). Some older test fixtures still
  // use `binaryRomStructFileOffset` - try the production key first, fall
  // back to the legacy key so fixtures keep working.
  for (const o of manifest.objectEvents) {
    if (o.scriptId !== scriptId) continue;
    const a = o.metadata['binaryFileOffset'];
    const b = o.metadata['binaryRomStructFileOffset'];
    const structOffset =
      typeof a === 'number' && Number.isFinite(a)
        ? a
        : typeof b === 'number' && Number.isFinite(b)
          ? b
          : null;
    if (structOffset === null) continue;
    out.push({
      entityKind: 'object_event',
      entityId: o.id,
      pointerOffset: structOffset + 0x10,
    });
  }
  // Triggers - coord_event / bg_event also carry scriptPointer fields.
  // The trigger struct layout differs (bg_event has pointer at +4 for
  // sign type, coord_event at +0xC). We stash the pointer offset as
  // `binaryRomScriptPointerFileOffset` so we don't have to know the
  // shape here.
  for (const t of manifest.triggers) {
    if (!t.scriptStepIds.includes(scriptId)) continue;
    const meta = t.metadata ?? {};
    const ptrOffset = meta['binaryRomScriptPointerFileOffset'];
    if (typeof ptrOffset !== 'number' || !Number.isFinite(ptrOffset)) continue;
    out.push({
      entityKind: 'trigger',
      entityId: t.id,
      pointerOffset: ptrOffset,
    });
  }
  return out;
}

/** Build a hex string from a Uint8Array for binary_write_bytes edits. */
function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i]!.toString(16).padStart(2, '0');
  }
  return out;
}

/** Result of computing the edits for a script-edit operation, separated
 *  from the propose registration step so a direct-apply HTTP route can
 *  bypass the agent's review flow when the user clicks an Add Step
 *  button in the visual scripter. */
export interface ComputedScriptEdit {
  readonly edits: ReadonlyArray<AgentPatchEdit>;
  readonly description: string;
  readonly scriptOffset: number;
  readonly oldByteLength: number;
  readonly newByteLength: number;
  readonly wasRelocated: boolean;
  readonly pointerRewrites: number;
}

/** Pure-ish computation of the edits required for the requested script
 *  mutation. Reads the manifest + ROM, decodes the existing script,
 *  applies the mutation, encodes back, computes either in-place or
 *  relocate edits + cross-ref pointer rewrites. Does NOT register a
 *  proposal or write to disk. Returns null with a human-readable
 *  reason on any failure.
 *
 *  This is the pure half of proposeScriptEdit; the original function
 *  wraps it + the proposal registration step. The direct-apply HTTP
 *  route (used by AddEventPopover from the frontend) reuses this
 *  function and pipes the edits straight to applyEdits. */
export async function computeScriptEdit(
  projectRoot: string,
  args: {
    scriptId: string;
    op: 'insertStep' | 'deleteStep' | 'editStep';
    stepIndex: number;
    newStep?: { kind: ScriptStepKind; params: Record<string, unknown> };
    description?: string;
  },
): Promise<{ ok: true; result: ComputedScriptEdit } | { ok: false; message: string; partial?: Partial<ProposeScriptEditResult> }> {
  const scriptOffset = parseScriptOffset(args.scriptId);
  if (scriptOffset === null) {
    return { ok: false, message: `scriptId "${args.scriptId}" doesn't match the script_0x<hex> pattern.` };
  }
  if ((args.op === 'insertStep' || args.op === 'editStep') && !args.newStep) {
    return { ok: false, message: `${args.op} requires newStep`, partial: { scriptOffset } };
  }
  const manifest = await readManifest(projectRoot);
  if (!manifest) {
    return { ok: false, message: 'No manifest. Open + scan a project first.', partial: { scriptOffset } };
  }
  const rom = await findRomFile(projectRoot);
  if (!rom) {
    return { ok: false, message: `No .gba in ${projectRoot}`, partial: { scriptOffset } };
  }
  const decoded = scriptsApi.decodeBinaryScript(rom.bytes, scriptOffset);
  if (decoded.steps.length === 0) {
    return {
      ok: false,
      message: `No steps decoded at 0x${scriptOffset.toString(16)} (stopped: ${decoded.stoppedReason}).`,
      partial: { scriptOffset },
    };
  }
  const oldByteLength = decoded.bytesConsumed;
  const stepsAfter: Array<{ kind: ScriptStepKind; params: Record<string, unknown> }> = decoded.steps.map(
    (s) => ({ kind: s.kind, params: { ...s.params } as Record<string, unknown> }),
  );
  if (args.op === 'insertStep') {
    if (args.stepIndex < 0 || args.stepIndex > stepsAfter.length) {
      return {
        ok: false,
        message: `stepIndex ${args.stepIndex} out of range [0..${stepsAfter.length}]`,
        partial: { scriptOffset, oldByteLength },
      };
    }
    stepsAfter.splice(args.stepIndex, 0, { kind: args.newStep!.kind, params: args.newStep!.params });
  } else if (args.op === 'deleteStep') {
    if (args.stepIndex < 0 || args.stepIndex >= stepsAfter.length) {
      return {
        ok: false,
        message: `stepIndex ${args.stepIndex} out of range [0..${stepsAfter.length - 1}]`,
        partial: { scriptOffset, oldByteLength },
      };
    }
    stepsAfter.splice(args.stepIndex, 1);
  } else {
    if (args.stepIndex < 0 || args.stepIndex >= stepsAfter.length) {
      return {
        ok: false,
        message: `stepIndex ${args.stepIndex} out of range [0..${stepsAfter.length - 1}]`,
        partial: { scriptOffset, oldByteLength },
      };
    }
    stepsAfter[args.stepIndex] = { kind: args.newStep!.kind, params: args.newStep!.params };
  }

  const allocator = new InBatchAllocator(rom.bytes);
  let newBytes: Uint8Array;
  try {
    newBytes = scriptsApi.encodeScript(stepsAfter, {
      allocate: (req) => {
        const offset = allocator.allocate(req.bytes);
        if (offset === null) {
          throw new Error(`no free space for ${req.kind} block of ${String(req.bytes.length)} bytes`);
        }
        return offset;
      },
    });
  } catch (e) {
    return {
      ok: false,
      message: `Encode failed: ${e instanceof Error ? e.message : String(e)}`,
      partial: { scriptOffset, oldByteLength },
    };
  }
  const newByteLength = newBytes.length;

  const edits: AgentPatchEdit[] = [];
  for (const alloc of allocator.drain()) {
    edits.push({
      kind: 'binary_write_bytes',
      offset: alloc.offset,
      beforeBytes: bytesToHex(new Uint8Array(alloc.bytes.length).fill(alloc.fillByte)),
      afterBytes: bytesToHex(alloc.bytes),
      requireFreeSlot: true,
      note: `allocate ${String(alloc.bytes.length)} bytes for script-side block`,
    } satisfies BinaryWriteBytesEdit);
  }

  let wasRelocated = false;
  let pointerRewrites = 0;
  if (newByteLength <= oldByteLength) {
    const padded = new Uint8Array(oldByteLength).fill(0xff);
    padded.set(newBytes, 0);
    const before = rom.bytes.subarray(scriptOffset, scriptOffset + oldByteLength);
    edits.push({
      kind: 'binary_write_bytes',
      offset: scriptOffset,
      beforeBytes: bytesToHex(before),
      afterBytes: bytesToHex(padded),
      note: `in-place script edit (${args.op} at index ${String(args.stepIndex)})`,
    } satisfies BinaryWriteBytesEdit);
  } else {
    wasRelocated = true;
    const newOffset = allocator.allocate(newBytes);
    if (newOffset === null) {
      return {
        ok: false,
        message: `Script grew from ${String(oldByteLength)} to ${String(newByteLength)} bytes - no free space available for relocation.`,
        partial: { scriptOffset, oldByteLength, newByteLength },
      };
    }
    edits.push({
      kind: 'binary_write_bytes',
      offset: newOffset,
      beforeBytes: bytesToHex(new Uint8Array(newBytes.length).fill(allocator.fillByteAt(newOffset))),
      afterBytes: bytesToHex(newBytes),
      requireFreeSlot: true,
      note: `relocated script (was 0x${scriptOffset.toString(16)}, now 0x${newOffset.toString(16)})`,
    } satisfies BinaryWriteBytesEdit);
    edits.push({
      kind: 'binary_write_bytes',
      offset: scriptOffset,
      beforeBytes: bytesToHex(rom.bytes.subarray(scriptOffset, scriptOffset + oldByteLength)),
      afterBytes: bytesToHex(new Uint8Array(oldByteLength).fill(0xff)),
      note: `clear old script slot at 0x${scriptOffset.toString(16)}`,
    } satisfies BinaryWriteBytesEdit);
    const refs = collectScriptReferences(manifest, args.scriptId);
    for (const ref of refs) {
      edits.push({
        kind: 'binary_rewrite_pointer',
        pointerOffset: ref.pointerOffset,
        beforeTargetOffset: scriptOffset,
        afterTargetOffset: newOffset,
        note: `repoint ${ref.entityKind} ${ref.entityId} to relocated script`,
      } satisfies BinaryRewritePointerEdit);
      pointerRewrites += 1;
    }
  }

  const description =
    args.description ??
    `${args.op} at index ${String(args.stepIndex)} in script ${args.scriptId} (${String(oldByteLength)}→${String(newByteLength)} bytes${wasRelocated ? `, relocated, ${String(pointerRewrites)} pointer${pointerRewrites === 1 ? '' : 's'} rewritten` : ', in place'})`;

  return {
    ok: true,
    result: {
      edits: Object.freeze(edits),
      description,
      scriptOffset,
      oldByteLength,
      newByteLength,
      wasRelocated,
      pointerRewrites,
    },
  };
}

export async function proposeScriptEdit(
  ctx: ToolContext,
  args: {
    scriptId: string;
    op: 'insertStep' | 'deleteStep' | 'editStep';
    stepIndex: number;
    newStep?: { kind: ScriptStepKind; params: Record<string, unknown> };
    description?: string;
  },
  deps: { fetchFn?: typeof fetch } = {},
): Promise<ProposeScriptEditResult> {
  const scriptOffset = parseScriptOffset(args.scriptId);
  if (scriptOffset === null) {
    return {
      proposal: null,
      scriptOffset: null,
      oldByteLength: 0,
      newByteLength: 0,
      wasRelocated: false,
      pointerRewrites: 0,
      message: `scriptId "${args.scriptId}" doesn't match the script_0x<hex> pattern.`,
    };
  }

  if ((args.op === 'insertStep' || args.op === 'editStep') && !args.newStep) {
    return {
      proposal: null,
      scriptOffset,
      oldByteLength: 0,
      newByteLength: 0,
      wasRelocated: false,
      pointerRewrites: 0,
      message: `${args.op} requires newStep`,
    };
  }

  const manifest = await readManifest(ctx.projectRoot);
  if (!manifest) {
    return {
      proposal: null,
      scriptOffset,
      oldByteLength: 0,
      newByteLength: 0,
      wasRelocated: false,
      pointerRewrites: 0,
      message: 'No manifest. Open + scan a project first.',
    };
  }

  const rom = await findRomFile(ctx.projectRoot);
  if (!rom) {
    return {
      proposal: null,
      scriptOffset,
      oldByteLength: 0,
      newByteLength: 0,
      wasRelocated: false,
      pointerRewrites: 0,
      message: `No .gba in ${ctx.projectRoot}`,
    };
  }

  // Decode the current script.
  const decoded = scriptsApi.decodeBinaryScript(rom.bytes, scriptOffset);
  if (decoded.steps.length === 0) {
    return {
      proposal: null,
      scriptOffset,
      oldByteLength: 0,
      newByteLength: 0,
      wasRelocated: false,
      pointerRewrites: 0,
      message: `No steps decoded at 0x${scriptOffset.toString(16)} (stopped: ${decoded.stoppedReason}).`,
    };
  }
  const oldByteLength = decoded.bytesConsumed;

  // Apply the mutation.
  const stepsAfter: Array<{ kind: ScriptStepKind; params: Record<string, unknown> }> =
    decoded.steps.map((s) => ({
      kind: s.kind,
      params: { ...s.params } as Record<string, unknown>,
    }));

  if (args.op === 'insertStep') {
    if (args.stepIndex < 0 || args.stepIndex > stepsAfter.length) {
      return {
        proposal: null,
        scriptOffset,
        oldByteLength,
        newByteLength: 0,
        wasRelocated: false,
        pointerRewrites: 0,
        message: `stepIndex ${args.stepIndex} out of range [0..${stepsAfter.length}]`,
      };
    }
    stepsAfter.splice(args.stepIndex, 0, {
      kind: args.newStep!.kind,
      params: args.newStep!.params,
    });
  } else if (args.op === 'deleteStep') {
    if (args.stepIndex < 0 || args.stepIndex >= stepsAfter.length) {
      return {
        proposal: null,
        scriptOffset,
        oldByteLength,
        newByteLength: 0,
        wasRelocated: false,
        pointerRewrites: 0,
        message: `stepIndex ${args.stepIndex} out of range [0..${stepsAfter.length - 1}]`,
      };
    }
    stepsAfter.splice(args.stepIndex, 1);
  } else {
    // editStep
    if (args.stepIndex < 0 || args.stepIndex >= stepsAfter.length) {
      return {
        proposal: null,
        scriptOffset,
        oldByteLength,
        newByteLength: 0,
        wasRelocated: false,
        pointerRewrites: 0,
        message: `stepIndex ${args.stepIndex} out of range [0..${stepsAfter.length - 1}]`,
      };
    }
    stepsAfter[args.stepIndex] = {
      kind: args.newStep!.kind,
      params: args.newStep!.params,
    };
  }

  // Encode the new bytecode. The allocator routes any new text /
  // movement blocks through findFreeRomSpace.
  const allocator = new InBatchAllocator(rom.bytes);
  let newBytes: Uint8Array;
  try {
    newBytes = scriptsApi.encodeScript(stepsAfter, {
      allocate: (req) => {
        const offset = allocator.allocate(req.bytes);
        if (offset === null) {
          throw new Error(`no free space for ${req.kind} block of ${String(req.bytes.length)} bytes`);
        }
        return offset;
      },
    });
  } catch (e) {
    return {
      proposal: null,
      scriptOffset,
      oldByteLength,
      newByteLength: 0,
      wasRelocated: false,
      pointerRewrites: 0,
      message: `Encode failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
  const newByteLength = newBytes.length;

  const edits: AgentPatchEdit[] = [];

  // Emit any text / movement block allocations the encoder requested.
  for (const alloc of allocator.drain()) {
    edits.push({
      kind: 'binary_write_bytes',
      offset: alloc.offset,
      beforeBytes: bytesToHex(new Uint8Array(alloc.bytes.length).fill(alloc.fillByte)),
      afterBytes: bytesToHex(alloc.bytes),
      requireFreeSlot: true,
      note: `allocate ${String(alloc.bytes.length)} bytes for script-side block`,
    } satisfies BinaryWriteBytesEdit);
  }

  let wasRelocated = false;
  let pointerRewrites = 0;

  if (newByteLength <= oldByteLength) {
    // In-place - pad shorter with 0xFF.
    const padded = new Uint8Array(oldByteLength).fill(0xff);
    padded.set(newBytes, 0);
    const before = rom.bytes.subarray(scriptOffset, scriptOffset + oldByteLength);
    edits.push({
      kind: 'binary_write_bytes',
      offset: scriptOffset,
      beforeBytes: bytesToHex(before),
      afterBytes: bytesToHex(padded),
      note: `in-place script edit (${args.op} at index ${String(args.stepIndex)})`,
    } satisfies BinaryWriteBytesEdit);
  } else {
    // Relocate.
    wasRelocated = true;
    const newOffset = allocator.allocate(newBytes);
    if (newOffset === null) {
      return {
        proposal: null,
        scriptOffset,
        oldByteLength,
        newByteLength,
        wasRelocated: false,
        pointerRewrites: 0,
        message: `Script grew from ${String(oldByteLength)} to ${String(newByteLength)} bytes - no free space available for relocation.`,
      };
    }
    // Write the relocated script.
    edits.push({
      kind: 'binary_write_bytes',
      offset: newOffset,
      beforeBytes: bytesToHex(new Uint8Array(newBytes.length).fill(allocator.fillByteAt(newOffset))),
      afterBytes: bytesToHex(newBytes),
      requireFreeSlot: true,
      note: `relocated script (was 0x${scriptOffset.toString(16)}, now 0x${newOffset.toString(16)})`,
    } satisfies BinaryWriteBytesEdit);
    // Fill the old slot with 0xFF.
    edits.push({
      kind: 'binary_write_bytes',
      offset: scriptOffset,
      beforeBytes: bytesToHex(rom.bytes.subarray(scriptOffset, scriptOffset + oldByteLength)),
      afterBytes: bytesToHex(new Uint8Array(oldByteLength).fill(0xff)),
      note: `clear old script slot at 0x${scriptOffset.toString(16)}`,
    } satisfies BinaryWriteBytesEdit);
    // Repoint every reference.
    const refs = collectScriptReferences(manifest, args.scriptId);
    for (const ref of refs) {
      edits.push({
        kind: 'binary_rewrite_pointer',
        pointerOffset: ref.pointerOffset,
        beforeTargetOffset: scriptOffset,
        afterTargetOffset: newOffset,
        note: `repoint ${ref.entityKind} ${ref.entityId} to relocated script`,
      } satisfies BinaryRewritePointerEdit);
      pointerRewrites += 1;
    }
    if (refs.length === 0) {
      // No known cross-references - warn but still apply (the script
      // may be called from another script we couldn't index, OR it may
      // be orphan / unreferenced). Caller decides whether to accept.
      // We don't fail here; the user can reject the proposal.
    }
  }

  const description =
    args.description ??
    `${args.op} at index ${String(args.stepIndex)} in script ${args.scriptId} (${String(oldByteLength)}→${String(newByteLength)} bytes${wasRelocated ? `, relocated, ${String(pointerRewrites)} pointer${pointerRewrites === 1 ? '' : 's'} rewritten` : ', in place'})`;

  let proposal: AgentPatchProposal;
  try {
    proposal = await proposePatch(ctx, { description, edits }, deps);
  } catch (e) {
    if (e instanceof ProposePatchError) {
      return {
        proposal: null,
        scriptOffset,
        oldByteLength,
        newByteLength,
        wasRelocated,
        pointerRewrites,
        message: `Failed to register proposal: ${e.message}`,
      };
    }
    throw e;
  }

  return {
    proposal,
    scriptOffset,
    oldByteLength,
    newByteLength,
    wasRelocated,
    pointerRewrites,
    message:
      `Script ${args.scriptId}: ${args.op} at index ${String(args.stepIndex)}. ` +
      `${String(oldByteLength)} → ${String(newByteLength)} bytes` +
      (wasRelocated
        ? `, relocated + ${String(pointerRewrites)} pointer rewrites`
        : `, in place`),
  };
}

// Re-export the kind type so the tool's caller can type its newStep param.
export type { ScriptStep };
