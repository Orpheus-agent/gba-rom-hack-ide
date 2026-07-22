/**
 * Gen-3 script-engine opcode-handler analysis.
 *
 * Each opcode in the discovered `gScriptCmdTable` (P6-T1) points to
 * an ARM/Thumb function. To infer per-opcode argument-byte-counts
 * (needed for the eventual bytecode decompile in subsequent P6 tasks),
 * we first need to identify the engine's `ScriptReadByte`/
 * `ScriptReadHalfword`/`ScriptReadWord` helper functions. These
 * helpers are called by every opcode handler that consumes script
 * bytes - so they appear as the most-frequent BL targets across
 * all handler functions.
 *
 * `analyzeHandler` walks Thumb instructions starting at a handler's
 * entry point, collecting BL targets until it hits a function-exit
 * pattern (POP {pc} / BX LR / explicit RETURN-conventions) or the
 * `maxInstructions` cap. `analyzeScriptHandlers` aggregates across
 * all handlers + returns the top-N most-called targets.
 *
 * Performance: 64-229 handlers × 32-instruction walks × decode time
 * ~= < 10 ms for a typical Gen-3 cart.
 *
 * PD 5: structural-only (Thumb encoding is hardware spec). PD 8
 * accounted-for (this analysis doesn't add coverage; the helper-
 * function bytes are caught by the Phase-3 region finalizer as
 * `unknown_executable`).
 */

import { tryDecodeThumbBL, THUMB_BL_INSTRUCTION_SIZE_BYTES } from './thumb-disasm.js';

/** Default maximum Thumb 16-bit instructions to scan per handler.
 *  Most opcode handlers are < 32 instructions; absurdly-generous
 *  cap handles even verbose handlers. */
export const HANDLER_ANALYSIS_DEFAULT_MAX_INSTRUCTIONS = 64;
/** Default number of top helpers to return from aggregation. */
export const HANDLER_ANALYSIS_DEFAULT_TOP_N = 10;

/** Why a handler walk stopped. */
export type HandlerWalkStopReason =
  | 'function_return' // BX LR or POP {pc} encountered
  | 'max_instructions' // hit the maxInstructions cap
  | 'out_of_bounds'; // walked past bytes.length

export interface HandlerAnalysis {
  /** File offset of the handler function's entry. */
  readonly handlerOffset: number;
  /** Absolute file offsets of every BL target encountered in the walk
   *  (in order; duplicates preserved - a handler that calls
   *  ScriptReadByte 3 times shows the target 3 times). */
  readonly blTargets: ReadonlyArray<number>;
  /** Total bytes covered by the walk (= instructions × 2). */
  readonly bytesWalked: number;
  /** Why the walk stopped. */
  readonly stoppedReason: HandlerWalkStopReason;
}

/**
 * Walk Thumb instructions starting at `handlerOffset`. Stops when:
 *   - The current 16-bit halfword is `0x4770` (BX LR - Thumb return)
 *   - The current 16-bit halfword's top 8 bits are `0xBD` (POP {…, pc}
 * - i.e. POP-with-pc-bit-set, the function-epilogue pattern)
 *   - `maxInstructions` 16-bit halfwords have been walked
 *   - The cursor falls past `bytes.length`
 *
 * BL instructions (4-byte, two halfwords) count as 2 instructions for
 * the maxInstructions cap.
 */
export function analyzeHandler(
  bytes: Uint8Array,
  handlerOffset: number,
  maxInstructions: number = HANDLER_ANALYSIS_DEFAULT_MAX_INSTRUCTIONS,
): HandlerAnalysis {
  const blTargets: number[] = [];
  let cursor = handlerOffset;
  let instructionsWalked = 0;
  let stoppedReason: HandlerWalkStopReason = 'max_instructions';

  while (instructionsWalked < maxInstructions) {
    if (cursor + 2 > bytes.length) {
      stoppedReason = 'out_of_bounds';
      break;
    }
    const hw = readUint16Le(bytes, cursor);

    // Function exit: BX LR or POP {…, pc}
    if (hw === 0x4770 || (hw & 0xff00) === 0xbd00) {
      stoppedReason = 'function_return';
      cursor += 2;
      instructionsWalked += 1;
      break;
    }

    // BL (Thumb-1, 4 bytes) - top 5 bits of hw1 = 11110
    if ((hw & 0xf800) === 0xf000) {
      const bl = tryDecodeThumbBL(bytes, cursor);
      if (bl !== null) {
        blTargets.push(bl.targetOffset);
        cursor += THUMB_BL_INSTRUCTION_SIZE_BYTES;
        instructionsWalked += 2;
        continue;
      }
      // Malformed BL prefix without valid hw2 - fall through to skip
      // 2 bytes (just consume the prefix halfword and keep walking).
    }

    // Default: 16-bit Thumb instruction, advance by 2 bytes.
    cursor += 2;
    instructionsWalked += 1;
  }

  return Object.freeze({
    handlerOffset,
    blTargets: Object.freeze(blTargets),
    bytesWalked: cursor - handlerOffset,
    stoppedReason,
  });
}

export interface CommonHelperFunction {
  /** File offset of the helper. */
  readonly offset: number;
  /** How many BL instructions across all handlers targeted this offset. */
  readonly callCount: number;
  /** How many DISTINCT handlers called this offset (≤ callCount). */
  readonly callerCount: number;
}

export interface ScriptHandlersAnalysis {
  /** Per-handler walk results, in input order. */
  readonly perHandler: ReadonlyArray<HandlerAnalysis>;
  /** Top-N common-helper targets aggregated across all handlers, sorted
   *  descending by callCount (ties broken by ascending offset for
   *  determinism). */
  readonly commonHelperFunctions: ReadonlyArray<CommonHelperFunction>;
}

/**
 * Run `analyzeHandler` on every entry in `handlerOffsets`, aggregate
 * BL-target frequencies + caller-counts, return the top-N most-called.
 */
export function analyzeScriptHandlers(
  bytes: Uint8Array,
  handlerOffsets: ReadonlyArray<number>,
  opts?: {
    readonly maxInstructionsPerHandler?: number;
    readonly topN?: number;
  },
): ScriptHandlersAnalysis {
  const maxInstructionsPerHandler =
    opts?.maxInstructionsPerHandler ?? HANDLER_ANALYSIS_DEFAULT_MAX_INSTRUCTIONS;
  const topN = opts?.topN ?? HANDLER_ANALYSIS_DEFAULT_TOP_N;

  const perHandler: HandlerAnalysis[] = [];
  // offset → { callCount, callers: Set<handlerOffset> }
  const targetStats = new Map<number, { callCount: number; callers: Set<number> }>();
  for (const handlerOffset of handlerOffsets) {
    const analysis = analyzeHandler(bytes, handlerOffset, maxInstructionsPerHandler);
    perHandler.push(analysis);
    for (const t of analysis.blTargets) {
      let stat = targetStats.get(t);
      if (stat === undefined) {
        stat = { callCount: 0, callers: new Set() };
        targetStats.set(t, stat);
      }
      stat.callCount += 1;
      stat.callers.add(handlerOffset);
    }
  }

  const helpers: CommonHelperFunction[] = [];
  for (const [offset, { callCount, callers }] of targetStats) {
    helpers.push({ offset, callCount, callerCount: callers.size });
  }
  helpers.sort((a, b) => {
    if (b.callCount !== a.callCount) return b.callCount - a.callCount;
    return a.offset - b.offset;
  });

  return Object.freeze({
    perHandler: Object.freeze(perHandler),
    commonHelperFunctions: Object.freeze(
      helpers.slice(0, topN).map((h) => Object.freeze(h)),
    ),
  });
}

/** Per-opcode helper-call profile. */
export interface OpcodeHelperProfile {
  /** Index of the opcode in the script-engine dispatch table. */
  readonly opcodeIndex: number;
  /** File offset of the opcode's handler function. */
  readonly handlerOffset: number;
  /** Sum of BL calls from this handler to ANY of the top-N helpers. */
  readonly totalHelperCalls: number;
  /** Per-helper call count. Key is the helper's offset rendered as a
   *  decimal-string so it round-trips through JSON. */
  readonly perHelperCallCount: Readonly<Record<string, number>>;
}

/**
 * For each opcode handler, count calls to each of the top-N
 * helpers. Returns one `OpcodeHelperProfile` per handler in input
 * order (so `result[opcodeIndex]` resolves directly).
 *
 * `topHelperOffsets` is typically the `.offset` field of the top-3
 * `commonHelperFunctions` from `analyzeScriptHandlers`, though any
 * subset is valid.
 *
 * BL targets that aren't in `topHelperOffsets` are ignored for the
 * per-helper count, but they DO contribute to `totalHelperCalls`
 * only if they ARE in the top-N set (the function counts EXACTLY
 * the helper calls - non-helper BLs don't count).
 */
export function inferOpcodeHelperProfiles(
  bytes: Uint8Array,
  handlerOffsets: ReadonlyArray<number>,
  topHelperOffsets: ReadonlyArray<number>,
  maxInstructionsPerHandler: number = HANDLER_ANALYSIS_DEFAULT_MAX_INSTRUCTIONS,
): ReadonlyArray<OpcodeHelperProfile> {
  const helperSet = new Set(topHelperOffsets);
  const profiles: OpcodeHelperProfile[] = [];
  for (let opcodeIndex = 0; opcodeIndex < handlerOffsets.length; opcodeIndex++) {
    const handlerOffset = handlerOffsets[opcodeIndex]!;
    const analysis = analyzeHandler(bytes, handlerOffset, maxInstructionsPerHandler);
    const perHelperCallCount: Record<string, number> = {};
    let totalHelperCalls = 0;
    for (const target of analysis.blTargets) {
      if (!helperSet.has(target)) continue;
      const key = String(target);
      perHelperCallCount[key] = (perHelperCallCount[key] ?? 0) + 1;
      totalHelperCalls += 1;
    }
    profiles.push(
      Object.freeze({
        opcodeIndex,
        handlerOffset,
        totalHelperCalls,
        perHelperCallCount: Object.freeze(perHelperCallCount),
      }),
    );
  }
  return Object.freeze(profiles);
}

/**
 * Aggregate a per-opcode profile array into a histogram counting
 * opcodes by their `totalHelperCalls` bucket. Returns
 * `Record<helperCallCount, opcodeCount>` - e.g. `{ "0": 56, "2": 8 }`
 * means 56 opcodes call 0 helpers and 8 opcodes call 2 helpers.
 */
export function helperCallHistogram(
  profiles: ReadonlyArray<OpcodeHelperProfile>,
): Readonly<Record<string, number>> {
  const histogram: Record<string, number> = {};
  for (const p of profiles) {
    const key = String(p.totalHelperCalls);
    histogram[key] = (histogram[key] ?? 0) + 1;
  }
  return Object.freeze(histogram);
}

function readUint16Le(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8)) >>> 0;
}
