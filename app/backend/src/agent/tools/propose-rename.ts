import { z } from 'zod';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import type { AgentPatchEdit, AgentPatchProposal } from '@rom-editor/shared';
import { rom as romApi, text } from '@rom-introspection/engine';
import { readManifest } from '../../scan/manifest-io.js';
import type { ToolContext } from '../types.js';
import { proposePatch, ProposePatchError } from './propose-patch.js';

const STRING_TERMINATOR = 0xff;

export const PROPOSE_RENAME_TOOL_NAME = 'propose_rename';

export const PROPOSE_RENAME_DESCRIPTION =
  'High-level rename: scan every decoded dialogue scriptStep for occurrences ' +
  "of `before`, then build the minimum set of edits needed to rewrite each " +
  "slot to `after`. The tool automatically picks the right edit kind per slot:\n\n" +
  "  - same-length-or-shorter renames → one binary_replace_text edit in place\n" +
  "  - length-INCREASING renames → a binary_write_text into newly-allocated " +
  "free space + a binary_rewrite_pointer that points the original reference " +
  "at the new location (AI-1.4b)\n\n" +
  "USE THIS for any place/name/item rename in a binary-rom project " +
  "(FireRed / Unbound / Radical Red / etc.). For decomp projects (data/maps/*.inc), " +
  "use propose_patch directly with replace_in_file edits.\n\n" +
  "Matching is case-sensitive and exact (Gen-3 in-game text is typically " +
  "ALL CAPS - e.g. 'ROUTE 1', 'PALLET TOWN'). The decoded scriptStep text " +
  "is what you should search for; use list_entities or read_decoded_script " +
  "first if you're unsure of the exact casing.";

export const proposeRenameInputShape = {
  before: z.string().min(1),
  after: z.string().min(1),
  description: z.string().optional(),
} as const;

export interface ProposeRenameResult {
  readonly proposal: AgentPatchProposal | null;
  readonly matchCount: number;
  readonly inPlaceCount: number;
  readonly repointedCount: number;
  readonly skippedNoOffset: number;
  readonly skippedNoPointer: number;
  readonly skippedNoFreeSpace: number;
  readonly message: string;
}

interface ScriptStepLike {
  readonly kind: string;
  readonly params: Readonly<Record<string, unknown>>;
}

interface SlotMatch {
  readonly textOffset: number;
  readonly decodedText: string;
  readonly fileOffset: number | null;
  occurrences: number;
}

/** Tracks free-space allocations within a single propose_rename call so
 *  consecutive `findFreeRomSpace` lookups don't return overlapping
 *  offsets. Allocations are "marked" in a working copy of the ROM bytes
 *  (set to non-fill 0xAA) so the next lookup skips them. */
class InBatchAllocator {
  private readonly working: Uint8Array;
  constructor(romBytes: Uint8Array) {
    this.working = new Uint8Array(romBytes);
  }
  allocate(size: number): number | null {
    if (size <= 0) return null;
    const r = romApi.findFreeRomSpace(this.working, size);
    if (!r) return null;
    // Claim the bytes by marking them non-fill so the next call sees them as used.
    for (let i = 0; i < size; i++) this.working[r.offset + i] = 0xaa;
    return r.offset;
  }
}

async function findRomFile(projectRoot: string): Promise<{ path: string; bytes: Buffer } | null> {
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

/** Measure the actual byte length of the string at offset (up to and
 *  including its 0xFF terminator), capped at maxBytes. */
function measureSlotBytes(buffer: Uint8Array, offset: number, maxBytes = 256): number {
  let walked = 0;
  while (walked < maxBytes && offset + walked < buffer.length) {
    const b = buffer[offset + walked]!;
    walked += 1;
    if (b === STRING_TERMINATOR) break;
  }
  return walked;
}

export async function proposeRename(
  ctx: ToolContext,
  args: { before: string; after: string; description?: string },
  deps: { fetchFn?: typeof fetch } = {},
): Promise<ProposeRenameResult> {
  if (args.before === args.after) {
    return {
      proposal: null,
      matchCount: 0,
      inPlaceCount: 0,
      repointedCount: 0,
      skippedNoOffset: 0,
      skippedNoPointer: 0,
      skippedNoFreeSpace: 0,
      message: `No-op: before equals after ('${args.before}'). Nothing to do.`,
    };
  }

  const manifest = await readManifest(ctx.projectRoot);
  if (!manifest) {
    return {
      proposal: null,
      matchCount: 0,
      inPlaceCount: 0,
      repointedCount: 0,
      skippedNoOffset: 0,
      skippedNoPointer: 0,
      skippedNoFreeSpace: 0,
      message: `No manifest at ${ctx.projectRoot}/.editor/manifest.json. Open + scan a project first.`,
    };
  }

  // Collect unique text slots by textFileOffset.
  const slotsByOffset = new Map<number, SlotMatch>();
  let skippedNoOffset = 0;
  for (const step of manifest.scriptSteps as ReadonlyArray<ScriptStepLike>) {
    const p = step.params;
    const dialogueText =
      typeof p['dialogueText'] === 'string' ? (p['dialogueText'] as string) : null;
    if (dialogueText === null) continue;
    if (!dialogueText.includes(args.before)) continue;
    const offsetRaw = p['textFileOffset'];
    if (typeof offsetRaw !== 'number' || !Number.isFinite(offsetRaw) || offsetRaw < 0) {
      skippedNoOffset += 1;
      continue;
    }
    const fileOffsetRaw = p['fileOffset'];
    const fileOffset =
      typeof fileOffsetRaw === 'number' && Number.isFinite(fileOffsetRaw) && fileOffsetRaw >= 0
        ? fileOffsetRaw
        : null;
    const existing = slotsByOffset.get(offsetRaw);
    if (existing) {
      existing.occurrences += 1;
    } else {
      slotsByOffset.set(offsetRaw, {
        textOffset: offsetRaw,
        decodedText: dialogueText,
        fileOffset,
        occurrences: 1,
      });
    }
  }

  if (slotsByOffset.size === 0) {
    return {
      proposal: null,
      matchCount: 0,
      inPlaceCount: 0,
      repointedCount: 0,
      skippedNoOffset,
      skippedNoPointer: 0,
      skippedNoFreeSpace: 0,
      message:
        `No dialogue slots match "${args.before}" in this manifest` +
        (skippedNoOffset > 0
          ? ` (${skippedNoOffset} match${skippedNoOffset === 1 ? '' : 'es'} skipped - no textFileOffset present; use propose_patch with replace_in_file for decomp targets).`
          : '.'),
    };
  }

  // Open the ROM so we can measure slot sizes + allocate free space
  // for length-increasing renames.
  const rom = await findRomFile(ctx.projectRoot);
  if (!rom) {
    return {
      proposal: null,
      matchCount: 0,
      inPlaceCount: 0,
      repointedCount: 0,
      skippedNoOffset,
      skippedNoPointer: 0,
      skippedNoFreeSpace: 0,
      message: `No .gba found at ${ctx.projectRoot}. The agent's manifest is binary-rom-shaped but the ROM isn't reachable.`,
    };
  }

  // Encode `after` once - every match shares the same encoded form.
  let encodedAfter: Uint8Array;
  try {
    encodedAfter = text.encodeString(args.after);
  } catch (e) {
    return {
      proposal: null,
      matchCount: 0,
      inPlaceCount: 0,
      repointedCount: 0,
      skippedNoOffset,
      skippedNoPointer: 0,
      skippedNoFreeSpace: 0,
      message: `Cannot encode "${args.after}" to Gen-3 text: ${(e as Error).message}`,
    };
  }
  // Encode `before` for slot-by-slot length math.
  let encodedBefore: Uint8Array;
  try {
    encodedBefore = text.encodeString(args.before);
  } catch (e) {
    return {
      proposal: null,
      matchCount: 0,
      inPlaceCount: 0,
      repointedCount: 0,
      skippedNoOffset,
      skippedNoPointer: 0,
      skippedNoFreeSpace: 0,
      message: `Cannot encode "${args.before}" to Gen-3 text: ${(e as Error).message}`,
    };
  }
  const sizeDelta = encodedAfter.length - encodedBefore.length;

  const allocator = new InBatchAllocator(rom.bytes);
  const edits: AgentPatchEdit[] = [];
  let inPlaceCount = 0;
  let repointedCount = 0;
  let skippedNoPointer = 0;
  let skippedNoFreeSpace = 0;

  for (const slot of slotsByOffset.values()) {
    const slotBytes = measureSlotBytes(rom.bytes, slot.textOffset);
    const newDecodedText = slot.decodedText.split(args.before).join(args.after);
    let newEncoded: Uint8Array;
    try {
      newEncoded = text.encodeString(newDecodedText);
    } catch {
      // Can't encode the new text - likely contains unmappable chars
      // from non-substring positions in the decoded text. Skip.
      skippedNoPointer += 1;
      continue;
    }
    // Path 1: fits in place.
    if (newEncoded.length + 1 <= slotBytes) {
      edits.push({
        kind: 'binary_replace_text',
        textOffset: slot.textOffset,
        before: slot.decodedText,
        after: newDecodedText,
        note: `rename "${args.before}" → "${args.after}" at 0x${slot.textOffset.toString(16)}`,
      });
      inPlaceCount += 1;
      continue;
    }
    // Path 2: needs repointing. Requires a known pointer offset (for the
    // msgbox loadword pattern, pointerOffset = scriptStep.fileOffset + 2).
    if (slot.fileOffset === null) {
      skippedNoPointer += 1;
      continue;
    }
    const pointerOffset = slot.fileOffset + 2;
    // Validate the pointer at that offset actually targets our slot.
    if (pointerOffset + 4 > rom.bytes.length) {
      skippedNoPointer += 1;
      continue;
    }
    const expectedPtr = (slot.textOffset + 0x08000000) >>> 0;
    const actualPtr =
      (rom.bytes[pointerOffset]! |
        (rom.bytes[pointerOffset + 1]! << 8) |
        (rom.bytes[pointerOffset + 2]! << 16) |
        (rom.bytes[pointerOffset + 3]! << 24)) >>>
      0;
    if (actualPtr !== expectedPtr) {
      // The pointer-at-fileOffset+2 convention didn't hold for this
      // scriptStep - likely a non-msgbox opcode the engine still
      // emitted dialogue text for. Skip.
      skippedNoPointer += 1;
      continue;
    }
    // Allocate free space for the new (longer) text.
    const newAllocSize = newEncoded.length + 1; // include terminator
    const newOffset = allocator.allocate(newAllocSize);
    if (newOffset === null) {
      skippedNoFreeSpace += 1;
      continue;
    }
    edits.push({
      kind: 'binary_write_text',
      offset: newOffset,
      before: '',
      after: newDecodedText,
      slotBytes: newAllocSize,
      note: `rename "${args.before}" → "${args.after}" - new slot at 0x${newOffset.toString(16)}`,
    });
    edits.push({
      kind: 'binary_rewrite_pointer',
      pointerOffset,
      beforeTargetOffset: slot.textOffset,
      afterTargetOffset: newOffset,
      note: `repoint to relocated string for "${args.before}" → "${args.after}"`,
    });
    repointedCount += 1;
  }

  if (edits.length === 0) {
    const skippedSummary = [
      skippedNoOffset && `${skippedNoOffset} no-offset`,
      skippedNoPointer && `${skippedNoPointer} no-pointer`,
      skippedNoFreeSpace && `${skippedNoFreeSpace} no-free-space`,
    ]
      .filter(Boolean)
      .join(', ');
    return {
      proposal: null,
      matchCount: 0,
      inPlaceCount: 0,
      repointedCount: 0,
      skippedNoOffset,
      skippedNoPointer,
      skippedNoFreeSpace,
      message:
        `Found ${slotsByOffset.size} slot${slotsByOffset.size === 1 ? '' : 's'} matching "${args.before}" but no edits could be built (${skippedSummary}).`,
    };
  }

  const totalSlots = inPlaceCount + repointedCount;
  const description =
    args.description ??
    `Rename "${args.before}" to "${args.after}" - ${totalSlots} slot${totalSlots === 1 ? '' : 's'}` +
      (sizeDelta > 0 ? ` (${repointedCount} repointed into free space)` : '');

  let proposal: AgentPatchProposal;
  try {
    proposal = await proposePatch(ctx, { description, edits }, deps);
  } catch (e) {
    if (e instanceof ProposePatchError) {
      return {
        proposal: null,
        matchCount: totalSlots,
        inPlaceCount,
        repointedCount,
        skippedNoOffset,
        skippedNoPointer,
        skippedNoFreeSpace,
        message: `Failed to register proposal: ${e.message}`,
      };
    }
    throw e;
  }

  const messageParts: string[] = [];
  messageParts.push(
    `Proposed renaming ${totalSlots} text slot${totalSlots === 1 ? '' : 's'} ("${args.before}" → "${args.after}").`,
  );
  if (inPlaceCount > 0)
    messageParts.push(`${inPlaceCount} in-place (same-or-shorter slot).`);
  if (repointedCount > 0)
    messageParts.push(`${repointedCount} repointed into newly-allocated free space.`);
  if (skippedNoOffset > 0)
    messageParts.push(`${skippedNoOffset} skipped (no textFileOffset - non-binary source).`);
  if (skippedNoPointer > 0)
    messageParts.push(`${skippedNoPointer} skipped (pointer-discovery failed).`);
  if (skippedNoFreeSpace > 0)
    messageParts.push(`${skippedNoFreeSpace} skipped (no free space available for repointing).`);
  messageParts.push(`Review the diff and click Apply in the agent panel.`);

  return {
    proposal,
    matchCount: totalSlots,
    inPlaceCount,
    repointedCount,
    skippedNoOffset,
    skippedNoPointer,
    skippedNoFreeSpace,
    message: messageParts.join(' '),
  };
}
