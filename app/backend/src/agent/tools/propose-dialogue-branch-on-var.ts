/**
 * propose_dialogue_branch_on_var - Phase 2B Filing 3.
 *
 * Inserts a single "If VAR_X ⊕ N → jump to script Y" branch step into an
 * existing Gen-3 script. The bytecode emitted is the vanilla 11-byte
 * pattern `compare varId, value; goto_if condition, target`. The engine's
 * decoder collapses the pair back into one `'branch_on_var'` step on the
 * next scan, so round-trip is byte-stable and the visual scripter shows
 * one card instead of two.
 *
 * This is the load-bearing primitive for Resonance Alignment - the story
 * system that branches dialogue based on six hidden vars (VAR_RA_EMO_LOG,
 * VAR_RA_TRAD_PROG, etc.). CFRU adds no new script opcodes; we use
 * vanilla `compare` (0x21) + `goto_if` (0x06) and a propose-side wrapper
 * that surfaces it as one semantic edit.
 *
 * Architecture: this tool is a THIN wrapper around `computeScriptEdit`
 * from propose-script-edit.ts. It:
 *
 *   1. Validates the var id (in-band + outside the CFRU-reserved daily
 *      band 0x40F0-0x40FF; warns past 75% of the persistent band).
 *   2. Resolves `targetScriptId` → `targetRomPtr` if the caller passed
 *      a script id rather than a raw pointer.
 *   3. Builds the {kind: 'branch_on_var', params: {...}} step.
 *   4. Delegates to computeScriptEdit({op: 'insertStep', ...}) which
 *      handles the encode/relocate/repoint pipeline already used by
 *      propose_script_edit.
 *   5. Registers the resulting edits as a proposal via proposePatch.
 *
 * Inputs accept both symbolic and numeric forms:
 *
 *   - `varId`: number (e.g. 0x40D0) OR string (e.g. "VAR_RA_EMO_LOG").
 *     The propose tool resolves symbolic names via the canonical
 *     firered-cfru symbol DB at scan time (manifest.variables).
 *
 *   - `operator`: 'less' | 'equal' | 'greater' | 'lessorequal' |
 *     'greaterorequal' | 'notequal'. Also accepts the symbolic forms
 *     "<", "=", ">", "<=", ">=", "!=" for ergonomic prompts.
 *
 *   - `targetScriptId`: optional script_0x<hex> id (recommended). When
 *     present, the tool resolves it to the GBA pointer that lands in
 *     the goto_if's target arg. When absent, `targetRomPtr` must be set
 *     directly (escape hatch for cross-script jumps).
 */

import { z } from 'zod';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import type { AgentPatchProposal } from '@rom-editor/shared';
import { readManifest } from '../../scan/manifest-io.js';
import type { ToolContext } from '../types.js';
import { proposePatch, ProposePatchError } from './propose-patch.js';
import { computeScriptEdit } from './propose-script-edit.js';

export const PROPOSE_DIALOGUE_BRANCH_ON_VAR_TOOL_NAME = 'propose_dialogue_branch_on_var';

export const PROPOSE_DIALOGUE_BRANCH_ON_VAR_DESCRIPTION =
  "Insert a 'If VAR ⊕ N → jump' branch into an existing script. The " +
  "editor's primitive for story-state-aware dialogue - load-bearing for " +
  "the Resonance Alignment six-var system (VAR_RA_EMO_LOG / VAR_RA_TRAD_PROG / " +
  "VAR_RA_REST_FORCE / VAR_RA_INST_CTRL / VAR_RA_OPT_FEAR / VAR_RA_HUM_ECO).\n\n" +
  "Emits the vanilla 11-byte bytecode pattern `compare varId, value; " +
  "goto_if condition, target`. The decoder recognises the pair and " +
  "reifies it back as one branch card, so the visual scripter shows one " +
  "step (not two opaque branch cards).\n\n" +
  "Inputs:\n" +
  "  - `scriptId`: the script entrypoint id to insert the branch into " +
  "    (e.g. `script_0x1a3c5f`). Get from ObjectEvent.scriptId or " +
  "    Trigger.scriptStepIds.\n" +
  "  - `varId`: number (e.g. 0x40D0) OR symbolic name (e.g. " +
  "    'VAR_RA_EMO_LOG'). The tool resolves names via manifest.variables.\n" +
  "  - `operator`: 'less' | 'equal' | 'greater' | 'lessorequal' | " +
  "    'greaterorequal' | 'notequal' (also accepts '<', '=', '>', '<=', " +
  "    '>=', '!=').\n" +
  "  - `value`: the u16 value to compare against.\n" +
  "  - `targetScriptId`: optional `script_0x<hex>` id of the jump " +
  "    destination. Resolved to the GBA pointer fed to `goto_if`.\n" +
  "  - `targetRomPtr`: optional u32 GBA pointer (escape hatch when you " +
  "    need to jump somewhere that isn't an existing scripted entrypoint).\n" +
  "    Exactly one of `targetScriptId` or `targetRomPtr` must be set.\n" +
  "  - `insertAtIndex`: optional 0-based step index for insertion. " +
  "    Defaults to append (after the last step before a terminator).\n\n" +
  "Guards:\n" +
  "  - varIds in 0x40F0-0x40FF are CFRU's reserved daily-mechanic band " +
  "    and are refused.\n" +
  "  - varIds outside 0x4000-0x40FF (persistent band) or 0x8000-0x801F " +
  "    (temp/special band) are refused.\n" +
  "  - If the persistent band is >75% allocated, the response carries a " +
  "    soft warning so the user can plan ahead.";

// ──────────────────────────────────────────────────────────────────────
// Var-allocation policy. Mirrors pret/pokefirered + CFRU vars.h.
// ──────────────────────────────────────────────────────────────────────

const PERSISTENT_VAR_START = 0x4000;
const PERSISTENT_VAR_END = 0x40ff;
const CFRU_DAILY_RESERVED_START = 0x40f0;
const CFRU_DAILY_RESERVED_END = 0x40ff;
const SPECIAL_TEMP_VAR_START = 0x8000;
const SPECIAL_TEMP_VAR_END = 0x801f;

/** True when `id` is the engine's persistent var band. */
function isPersistentVar(id: number): boolean {
  return id >= PERSISTENT_VAR_START && id <= PERSISTENT_VAR_END;
}

/** True when `id` is the CFRU daily-mechanic reserved band (refused). */
function isCfruDailyReserved(id: number): boolean {
  return id >= CFRU_DAILY_RESERVED_START && id <= CFRU_DAILY_RESERVED_END;
}

/** True when `id` is the engine's temp/special var band (scratch slots). */
function isSpecialTempVar(id: number): boolean {
  return id >= SPECIAL_TEMP_VAR_START && id <= SPECIAL_TEMP_VAR_END;
}

// ──────────────────────────────────────────────────────────────────────
// Operator parsing (accepts both keyword + symbol forms).
// ──────────────────────────────────────────────────────────────────────

type BranchOperator =
  | 'less'
  | 'equal'
  | 'greater'
  | 'lessorequal'
  | 'greaterorequal'
  | 'notequal';

const OPERATOR_SYMBOL_MAP: ReadonlyMap<string, BranchOperator> = new Map([
  ['less', 'less'],
  ['equal', 'equal'],
  ['greater', 'greater'],
  ['lessorequal', 'lessorequal'],
  ['greaterorequal', 'greaterorequal'],
  ['notequal', 'notequal'],
  ['<', 'less'],
  ['=', 'equal'],
  ['==', 'equal'],
  ['>', 'greater'],
  ['<=', 'lessorequal'],
  ['>=', 'greaterorequal'],
  ['!=', 'notequal'],
  ['≠', 'notequal'],
  ['≤', 'lessorequal'],
  ['≥', 'greaterorequal'],
]);

const OPERATOR_DISPLAY: Readonly<Record<BranchOperator, string>> = {
  less: '<',
  equal: '=',
  greater: '>',
  lessorequal: '≤',
  greaterorequal: '≥',
  notequal: '≠',
};

export function normalizeOperator(input: string): BranchOperator | null {
  const lc = input.trim().toLowerCase();
  return OPERATOR_SYMBOL_MAP.get(lc) ?? null;
}

// ──────────────────────────────────────────────────────────────────────
// Var-id resolution (numeric ↔ symbolic).
// ──────────────────────────────────────────────────────────────────────

/** Resolve a varId input (number or symbolic name) to a numeric id.
 *  Returns null when the symbolic name doesn't appear in the manifest. */
export function resolveVarId(
  input: number | string,
  manifest: { readonly variables: ReadonlyArray<{ readonly id: string; readonly name: string; readonly engineValue: string }> },
): number | null {
  if (typeof input === 'number') {
    if (!Number.isInteger(input) || input < 0 || input > 0xffff) return null;
    return input;
  }
  const needle = input.trim().toUpperCase();
  // First pass: exact id match (e.g. "0x40d0", "VAR_RA_EMO_LOG").
  for (const v of manifest.variables) {
    if (v.id.toUpperCase() === needle || v.name.toUpperCase() === needle) {
      // Engine value is a string like "0x4040"; parse to number.
      const ev = v.engineValue;
      if (typeof ev === 'string') {
        const trimmed = ev.replace(/[() ]/g, '');
        const n = trimmed.startsWith('0x') || trimmed.startsWith('0X')
          ? parseInt(trimmed.slice(2), 16)
          : parseInt(trimmed, 10);
        if (Number.isFinite(n) && n >= 0 && n <= 0xffff) return n;
      }
    }
  }
  // Direct hex literal parse fallback (e.g. user passed "0x40D0").
  const hexMatch = /^0x[0-9a-f]+$/i.exec(needle);
  if (hexMatch) {
    const n = parseInt(needle.slice(2), 16);
    if (Number.isFinite(n) && n >= 0 && n <= 0xffff) return n;
  }
  return null;
}

// ──────────────────────────────────────────────────────────────────────
// Script-id → ROM pointer.
// ──────────────────────────────────────────────────────────────────────

const GBA_ROM_BASE = 0x08000000;

/** Parse a `script_0x<hex>` or `binary_script_0x<hex>` id and return the
 *  corresponding GBA pointer. Returns null on shape mismatch. */
export function scriptIdToRomPtr(scriptId: string): number | null {
  const m = /^(?:binary_)?script_0x([0-9a-fA-F]+)$/.exec(scriptId);
  if (!m) return null;
  const off = parseInt(m[1]!, 16);
  if (!Number.isFinite(off) || off < 0) return null;
  return (off + GBA_ROM_BASE) >>> 0;
}

// ──────────────────────────────────────────────────────────────────────
// Input schema.
// ──────────────────────────────────────────────────────────────────────

const u16 = z.number().int().min(0).max(0xffff);
const u32 = z.number().int().min(0).max(0xffffffff);
const varIdInput = z.union([u16, z.string().min(1).max(64)]);
const operatorInput = z.string().min(1).max(20);

export const proposeDialogueBranchOnVarInputShape = {
  scriptId: z.string().min(1),
  varId: varIdInput,
  operator: operatorInput,
  value: u16,
  targetScriptId: z.string().min(1).optional(),
  targetRomPtr: u32.optional(),
  insertAtIndex: z.number().int().min(0).optional(),
  description: z.string().min(1).max(500).optional(),
} as const;

// ──────────────────────────────────────────────────────────────────────
// Result type.
// ──────────────────────────────────────────────────────────────────────

export interface ProposeDialogueBranchOnVarResult {
  readonly proposal: AgentPatchProposal | null;
  readonly scriptOffset: number | null;
  readonly resolvedVarId: number | null;
  readonly resolvedOperator: BranchOperator | null;
  readonly resolvedTargetRomPtr: number | null;
  readonly oldByteLength: number;
  readonly newByteLength: number;
  readonly wasRelocated: boolean;
  readonly pointerRewrites: number;
  readonly warnings: ReadonlyArray<string>;
  readonly message: string;
}

function emptyResult(message: string): ProposeDialogueBranchOnVarResult {
  return {
    proposal: null,
    scriptOffset: null,
    resolvedVarId: null,
    resolvedOperator: null,
    resolvedTargetRomPtr: null,
    oldByteLength: 0,
    newByteLength: 0,
    wasRelocated: false,
    pointerRewrites: 0,
    warnings: [],
    message,
  };
}

// ──────────────────────────────────────────────────────────────────────
// Find a .gba in the project root (mirrors other propose tools).
// ──────────────────────────────────────────────────────────────────────

async function findRomFile(
  projectRoot: string,
): Promise<{ readonly path: string } | null> {
  try {
    const entries = await fsp.readdir(projectRoot, { withFileTypes: true });
    for (const e of entries) {
      if (e.isFile() && e.name.toLowerCase().endsWith('.gba')) {
        return { path: path.join(projectRoot, e.name) };
      }
    }
  } catch {
    return null;
  }
  return null;
}

// ──────────────────────────────────────────────────────────────────────
// Main entrypoint.
// ──────────────────────────────────────────────────────────────────────

export async function proposeDialogueBranchOnVar(
  ctx: ToolContext,
  args: {
    scriptId: string;
    varId: number | string;
    operator: string;
    value: number;
    targetScriptId?: string;
    targetRomPtr?: number;
    insertAtIndex?: number;
    description?: string;
  },
  deps: { fetchFn?: typeof fetch } = {},
): Promise<ProposeDialogueBranchOnVarResult> {
  const warnings: string[] = [];

  // ── 1. Operator parsing ────────────────────────────────────────
  const operator = normalizeOperator(args.operator);
  if (operator === null) {
    return emptyResult(
      `Unknown operator "${args.operator}". Use one of: less | equal | greater | lessorequal | greaterorequal | notequal (or '<', '=', '>', '<=', '>=', '!=').`,
    );
  }

  // ── 2. Manifest load (needed for varId symbolic resolution + the
  //      compute pipeline below). ───────────────────────────────────
  const manifest = await readManifest(ctx.projectRoot);
  if (!manifest) {
    return emptyResult('No manifest. Open + scan a project first.');
  }
  // ROM access sanity check (computeScriptEdit will re-open + verify).
  const rom = await findRomFile(ctx.projectRoot);
  if (!rom) {
    return emptyResult(`No .gba in ${ctx.projectRoot}`);
  }

  // ── 3. varId resolution + guard checks ────────────────────────
  const resolvedVarId = resolveVarId(args.varId, manifest);
  if (resolvedVarId === null) {
    return emptyResult(
      `Unknown varId "${String(args.varId)}". Pass a numeric id (0x4000-0x40FF or 0x8000-0x801F) or a symbolic name from manifest.variables (e.g. 'VAR_RA_EMO_LOG').`,
    );
  }
  if (isCfruDailyReserved(resolvedVarId)) {
    return emptyResult(
      `varId 0x${resolvedVarId.toString(16)} is in CFRU's reserved daily-mechanic band (0x40F0-0x40FF). Pick a different slot - try the Resonance Alignment range 0x40D0-0x40D5 or any free 0x4000-0x40EF slot.`,
    );
  }
  if (!isPersistentVar(resolvedVarId) && !isSpecialTempVar(resolvedVarId)) {
    return emptyResult(
      `varId 0x${resolvedVarId.toString(16)} is outside the editable bands (0x4000-0x40FF persistent or 0x8000-0x801F special). Engine reads from this address would target system memory.`,
    );
  }
  if (isPersistentVar(resolvedVarId)) {
    // 75% saturation warning. Count manifest.variables entries in the
    // persistent band as "allocated" - leaves room for the user to
    // judge headroom without us hard-failing.
    const persistentEntries = manifest.variables.filter((v) => {
      const ev = v.engineValue;
      if (typeof ev !== 'string') return false;
      const trimmed = ev.replace(/[() ]/g, '');
      const n = trimmed.startsWith('0x') || trimmed.startsWith('0X')
        ? parseInt(trimmed.slice(2), 16)
        : parseInt(trimmed, 10);
      return Number.isFinite(n) && isPersistentVar(n);
    });
    const cap = PERSISTENT_VAR_END - PERSISTENT_VAR_START + 1;
    if (persistentEntries.length / cap >= 0.75) {
      warnings.push(
        `Persistent var band (0x4000-0x40FF) is ${Math.round((persistentEntries.length / cap) * 100)}% allocated (${String(persistentEntries.length)} of ${String(cap)} slots). Consider consolidating before adding new vars.`,
      );
    }
  }

  // ── 4. Target pointer resolution ───────────────────────────────
  let targetRomPtr: number | null = null;
  if (args.targetScriptId && args.targetRomPtr !== undefined) {
    return emptyResult(
      `Pass exactly one of targetScriptId or targetRomPtr (got both). targetScriptId is preferred for cross-script jumps to existing entrypoints.`,
    );
  }
  if (args.targetScriptId) {
    const ptr = scriptIdToRomPtr(args.targetScriptId);
    if (ptr === null) {
      return emptyResult(
        `targetScriptId "${args.targetScriptId}" doesn't match the script_0x<hex> pattern. Use propose_add_script_for_trainer or list_entities({ kind: 'script' }) to find a valid id.`,
      );
    }
    targetRomPtr = ptr;
  } else if (args.targetRomPtr !== undefined) {
    if (args.targetRomPtr < GBA_ROM_BASE) {
      return emptyResult(
        `targetRomPtr 0x${args.targetRomPtr.toString(16)} is below GBA_ROM_BASE (0x08000000). GBA pointers must live in the cartridge mirror range [0x08000000, 0x0a000000).`,
      );
    }
    targetRomPtr = args.targetRomPtr;
  } else {
    return emptyResult(
      `Provide either targetScriptId (preferred) or targetRomPtr. Without a target, the goto_if has nowhere to jump.`,
    );
  }

  // ── 5. Determine the insert position ──────────────────────────
  // Default: append (computeScriptEdit re-derives the steps from the
  // ROM internally, so we don't have to read them here - but we DO
  // need to know how many there are to set "append". Use a quick
  // manifest-side count of steps belonging to this scriptId.
  let insertAtIndex = args.insertAtIndex;
  if (insertAtIndex === undefined) {
    const prefix = `${args.scriptId}__`;
    const count = manifest.scriptSteps.filter((s) => s.id.startsWith(prefix)).length;
    // Insert just before the trailing `end` step if there is one;
    // otherwise append. The manifest's last script step IS typically the
    // terminator (decoder emits `end` as the last raw step).
    insertAtIndex = Math.max(0, count - 1);
  }

  // ── 6. Build the new step ─────────────────────────────────────
  const newStep = {
    kind: 'branch_on_var' as const,
    params: {
      varId: resolvedVarId,
      value: args.value,
      operator,
      targetRomPtr,
    },
  };

  // ── 7. Delegate to the script-edit pipeline ───────────────────
  const computed = await computeScriptEdit(ctx.projectRoot, {
    scriptId: args.scriptId,
    op: 'insertStep',
    stepIndex: insertAtIndex,
    newStep,
    description:
      args.description ??
      `If var 0x${resolvedVarId.toString(16)} ${OPERATOR_DISPLAY[operator]} ${String(args.value)} → jump to 0x${targetRomPtr.toString(16)}`,
  });

  if (!computed.ok) {
    return {
      ...emptyResult(computed.message),
      resolvedVarId,
      resolvedOperator: operator,
      resolvedTargetRomPtr: targetRomPtr,
      warnings,
      scriptOffset: computed.partial?.scriptOffset ?? null,
      oldByteLength: computed.partial?.oldByteLength ?? 0,
      newByteLength: computed.partial?.newByteLength ?? 0,
    };
  }

  // ── 8. Register the proposal ──────────────────────────────────
  let proposal: AgentPatchProposal;
  try {
    proposal = await proposePatch(
      ctx,
      {
        description: computed.result.description,
        edits: [...computed.result.edits],
      },
      deps,
    );
  } catch (e) {
    if (e instanceof ProposePatchError) {
      return {
        proposal: null,
        scriptOffset: computed.result.scriptOffset,
        resolvedVarId,
        resolvedOperator: operator,
        resolvedTargetRomPtr: targetRomPtr,
        oldByteLength: computed.result.oldByteLength,
        newByteLength: computed.result.newByteLength,
        wasRelocated: computed.result.wasRelocated,
        pointerRewrites: computed.result.pointerRewrites,
        warnings,
        message: `Failed to register proposal: ${e.message}`,
      };
    }
    throw e;
  }

  return {
    proposal,
    scriptOffset: computed.result.scriptOffset,
    resolvedVarId,
    resolvedOperator: operator,
    resolvedTargetRomPtr: targetRomPtr,
    oldByteLength: computed.result.oldByteLength,
    newByteLength: computed.result.newByteLength,
    wasRelocated: computed.result.wasRelocated,
    pointerRewrites: computed.result.pointerRewrites,
    warnings,
    message:
      `Inserted branch step at index ${String(insertAtIndex)} of ${args.scriptId}. ` +
      `If var 0x${resolvedVarId.toString(16)} ${OPERATOR_DISPLAY[operator]} ${String(args.value)} → ` +
      `0x${targetRomPtr.toString(16)}. ` +
      `${String(computed.result.oldByteLength)} → ${String(computed.result.newByteLength)} bytes` +
      (computed.result.wasRelocated
        ? `, relocated + ${String(computed.result.pointerRewrites)} pointer rewrites`
        : `, in place`) +
      (warnings.length > 0 ? `\nWarnings: ${warnings.join('; ')}` : ''),
  };
}
