/**
 * Gen-3 script bytecode walker.
 *
 * Walks script bytecode starting from an entrypoint offset, using
 * the per-opcode helper-call profiles from P6-T3 to estimate
 * per-opcode argument-byte-counts. Each opcode consumes 1 byte
 * (the opcode index) plus its profile's `totalHelperCalls` bytes
 * (conservative lower-bound assumption: each helper call reads
 * ≥1 byte).
 *
 * Termination:
 *  - The walker stops when (a) the next opcode index falls outside
 *    the discovered opcode-table range, (b) walking would read past
 *    `bytes.length`, or (c) the `maxOpcodes` cap is reached. It
 *    does NOT semantically classify which opcodes are terminators
 *    (`end`/`return`/`killscript`) - that requires per-engine
 *    knowledge / corpus signatures and is left to later P6 tasks.
 *
 * Honest scope:
 *  - The walker under-walks when handlers call helpers that read >1
 *    byte per call (Halfword=2, Word=4) - vanilla Gen-3 has a handful
 *    of such handlers. The walked opcode sequence is still STRUCTURALLY
 *    valid (each opcode + at-least-one-byte-per-helper-call) but the
 *    actual script body extent may be longer than reported.
 *  - The walker over-walks if it interprets non-script bytes (e.g.
 *    padding past the actual script terminator) as opcodes - the
 *    maxOpcodes cap prevents infinite runs into garbage but small
 *    over-walks (1-2 opcodes past the true end) are expected.
 */

import type { OpcodeHelperProfile } from './handler-analysis.js';

/** Default cap on opcodes walked from a single entrypoint. Vanilla
 *  Gen-3 scripts are typically < 100 opcodes; 256 is absurdly
 *  generous and prevents infinite runs into garbage data. */
export const BYTECODE_WALKER_DEFAULT_MAX_OPCODES = 256;

export interface WalkedOpcode {
  /** The opcode-byte value at this position. */
  readonly opcodeIndex: number;
  /** File offset of the opcode byte. */
  readonly opcodeOffset: number;
  /** Number of argument bytes consumed by this opcode (= profile.
   *  totalHelperCalls). May be 0 (no-arg opcode). */
  readonly argByteCount: number;
  /** The raw argument bytes (length == argByteCount). */
  readonly argBytes: ReadonlyArray<number>;
}

/** Why the walker stopped. */
export type BytecodeWalkerStopReason =
  | 'invalid_opcode' // opcode index ≥ profiles.length
  | 'out_of_bounds' // walking would read past bytes.length
  | 'max_opcodes' // hit the maxOpcodes cap
  | 'profile_missing'; // entrypoint has no profile (empty profiles input)

export interface WalkedScriptBody {
  /** File offset where the walk started. */
  readonly startOffset: number;
  /** File offset one past the last byte consumed. */
  readonly endOffset: number;
  /** Each opcode walked, in order. */
  readonly opcodes: ReadonlyArray<WalkedOpcode>;
  /** Why the walker stopped. */
  readonly stoppedReason: BytecodeWalkerStopReason;
}

export interface WalkScriptBytecodeOptions {
  /** Max opcodes to walk before bailing. Default 256. */
  readonly maxOpcodes?: number;
}

/**
 * Walk script bytecode starting at `entrypointOffset`. Uses
 * `opcodeProfiles[opcodeIndex].totalHelperCalls` as the per-opcode
 * argbyte count.
 */
export function walkScriptBytecode(
  bytes: Uint8Array,
  entrypointOffset: number,
  opcodeProfiles: ReadonlyArray<OpcodeHelperProfile>,
  opts?: WalkScriptBytecodeOptions,
): WalkedScriptBody {
  const maxOpcodes = opts?.maxOpcodes ?? BYTECODE_WALKER_DEFAULT_MAX_OPCODES;
  const opcodes: WalkedOpcode[] = [];

  if (opcodeProfiles.length === 0) {
    return Object.freeze({
      startOffset: entrypointOffset,
      endOffset: entrypointOffset,
      opcodes: Object.freeze(opcodes),
      stoppedReason: 'profile_missing' as const,
    });
  }

  let cursor = entrypointOffset;
  let stoppedReason: BytecodeWalkerStopReason = 'max_opcodes';

  while (opcodes.length < maxOpcodes) {
    if (cursor < 0 || cursor >= bytes.length) {
      stoppedReason = 'out_of_bounds';
      break;
    }
    const opcodeIndex = bytes[cursor] ?? 0;
    if (opcodeIndex >= opcodeProfiles.length) {
      stoppedReason = 'invalid_opcode';
      break;
    }
    const profile = opcodeProfiles[opcodeIndex]!;
    const argByteCount = profile.totalHelperCalls;
    const opcodeOffset = cursor;
    const argsStart = cursor + 1;
    const argsEnd = argsStart + argByteCount;
    if (argsEnd > bytes.length) {
      stoppedReason = 'out_of_bounds';
      break;
    }
    const argBytes: number[] = [];
    for (let i = 0; i < argByteCount; i++) {
      argBytes.push(bytes[argsStart + i] ?? 0);
    }
    opcodes.push(
      Object.freeze({
        opcodeIndex,
        opcodeOffset,
        argByteCount,
        argBytes: Object.freeze(argBytes),
      }),
    );
    cursor = argsEnd;
  }

  return Object.freeze({
    startOffset: entrypointOffset,
    endOffset: cursor,
    opcodes: Object.freeze(opcodes),
    stoppedReason,
  });
}
