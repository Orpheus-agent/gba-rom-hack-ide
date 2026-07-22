/**
 * Faithful script-bytecode interpreter - Phase 10 P10-T1.
 *
 * Per D-0006 + §13.3 fullest-faithful-alternative: when the WASM
 * mGBA core path is impractical in this Node-only environment, the
 * §5/§13.3 mandate kicks in: "a faithful instrumented interpreter/
 * simulator that executes the ROM's actual data and script bytecode
 * and produces *real* traces - never synthetic/sample traces."
 *
 * This module is THAT interpreter, scoped to the script-engine
 * bytecode dispatched by the gScriptCmdTable (P6-T1). It reuses:
 *
 *   - Opcode dispatch shape detected by P6-T1 (opcodeProfiles - 
 *     argbyte counts per opcode index).
 *   - Opcode names from the signature DB / detector report (P6-T5
 *     decompile + P7-T1 variable-access).
 *   - Script body bytes - the actual ROM bytes the engine would
 *     execute on a real GBA.
 *
 * The interpreter walks the bytecode AND maintains semantic runtime
 * state:
 *   - `flags: Map<number, boolean>` - Gen-3 flag bits, initially
 *     `false` (unset) for any not-yet-seen flag id.
 *   - `vars: Map<number, number>` - Gen-3 u16 variables, initially
 *     `0` for any not-yet-seen variable id.
 *   - `pc: number` - program counter (file offset of next opcode).
 *   - `executedCount: number` - total opcodes executed (vs max).
 *
 * For each executed opcode, the interpreter emits a typed
 * `RuntimeTraceEvent` describing what was observed:
 *   - kind 'opcode_executed' - base event for every step (pc, opcode
 *     index/name, args raw bytes).
 *   - kind 'flag_set' - `setflag <id>`, value transition false→true.
 *   - kind 'flag_cleared' - `clearflag <id>`, true→false.
 *   - kind 'flag_read' - `checkflag <id>`, current value observed.
 *   - kind 'var_set' - `setvar <id> <value>`, integer write.
 *   - kind 'var_read' - `compare_var_to_value`/`compare_var_to_var`,
 *     current variable value observed.
 *   - kind 'branched_to' - control-flow opcode change (P10-Tn).
 *   - kind 'terminated' - `end`/`return`/EOF terminates the body.
 *
 * Real-vs-synthetic per §10 acceptance: every event is produced by
 * actually EXECUTING the script body's bytes - there is no simulation
 * of "expected" results, no hardcoded output for known op patterns,
 * no fake traces. If the body's bytes don't form a valid opcode, the
 * interpreter halts with `terminated.reason = 'invalid_opcode'` and
 * does NOT emit a fake 'continued' event.
 *
 * Scope (this iteration P10-T1):
 *   - flag/var write/read opcodes (the §15 P7 + P10 sweet spot - 
 *     these are where static-vs-runtime validation pays off).
 *   - End/return opcodes terminate the body.
 *   - Unrecognized opcodes execute as no-ops (consuming their
 *     declared argbytes per opcodeProfiles) but emit
 *     `opcode_executed` events so the trace is complete.
 *
 * Out of scope (P10-Tn):
 *   - Control-flow opcodes (jump, branch, callstd) - would require
 *     branch-target validation against the signature DB and
 *     potentially recursive/looped execution.
 *   - GBA hardware-state opcodes (graphics, sound, weather).
 *   - Trainer-battle scripting opcodes.
 */

import type { WalkedScriptBody, WalkedOpcode } from '../scripts/index.js';

/** Universal runtime trace event - the §15 P10 "real runtime traces"
 *  output. Each event is produced by ACTUAL execution; none are
 *  synthesized or extrapolated. */
export type RuntimeTraceEvent =
  | {
      readonly kind: 'opcode_executed';
      readonly pc: number;
      readonly opcodeIndex: number;
      readonly opcodeName: string | null;
      readonly argBytes: ReadonlyArray<number>;
    }
  | {
      readonly kind: 'flag_set';
      readonly pc: number;
      readonly flagId: number;
      readonly previousValue: boolean;
    }
  | {
      readonly kind: 'flag_cleared';
      readonly pc: number;
      readonly flagId: number;
      readonly previousValue: boolean;
    }
  | {
      readonly kind: 'flag_read';
      readonly pc: number;
      readonly flagId: number;
      readonly observedValue: boolean;
    }
  | {
      readonly kind: 'var_set';
      readonly pc: number;
      readonly variableId: number;
      readonly value: number;
      readonly previousValue: number;
    }
  | {
      readonly kind: 'var_read';
      readonly pc: number;
      readonly variableId: number;
      readonly observedValue: number;
    }
  | {
      readonly kind: 'terminated';
      readonly pc: number;
      readonly reason:
        | 'end_opcode'
        | 'return_opcode'
        | 'invalid_opcode'
        | 'out_of_bounds'
        | 'max_steps';
    };

/** Snapshot of the runtime state at end-of-execution. */
export interface RuntimeStateSnapshot {
  /** Flag id → current value (bool). Includes every flag seen during
   *  execution. Missing flags default to `false`. */
  readonly flags: Readonly<Map<number, boolean>>;
  /** Variable id → current value (u16). Includes every var seen.
   *  Missing vars default to `0`. */
  readonly vars: Readonly<Map<number, number>>;
  /** Program counter where execution stopped. */
  readonly stoppedAtPc: number;
  /** Total opcodes executed. */
  readonly executedCount: number;
}

export interface InterpretedScriptResult {
  /** Ordered runtime trace events, one or more per executed opcode. */
  readonly traceEvents: ReadonlyArray<RuntimeTraceEvent>;
  /** Final runtime state snapshot. */
  readonly endState: RuntimeStateSnapshot;
  /** Mirror: source walked body (for cross-reference with P6-T5 decompile). */
  readonly walkedBody: WalkedScriptBody;
}

export interface InterpretScriptOptions {
  /** Maximum opcodes to execute before halting (default 1024). */
  readonly maxSteps?: number;
  /** Sparse opcode-name lookup (same shape as the P6-T5 decompile
   *  consumer). Required for semantic flag/var event emission. */
  readonly opcodeNames?: ReadonlyArray<string | undefined>;
  /** Pre-existing flag state (e.g. story progression - flags carried
   *  over from a prior script's runtime). Default: empty. */
  readonly initialFlags?: ReadonlyMap<number, boolean>;
  /** Pre-existing variable state. Default: empty. */
  readonly initialVars?: ReadonlyMap<number, number>;
}

/** Opcode names that terminate the body. */
const END_OPCODE_NAMES: ReadonlySet<string> = new Set([
  'end',
  'return',
  'returnram',
]);

/**
 * Interpret a script body - execute its opcodes against a simulated
 * Gen-3 flag/var state machine and emit real trace events for every
 * step. Reuses the P6-T4 walked-body shape (opcode index + argbytes
 * per step) as the deterministic input.
 */
export function interpretScript(
  walkedBody: WalkedScriptBody,
  opts?: InterpretScriptOptions,
): InterpretedScriptResult {
  const maxSteps = opts?.maxSteps ?? 1024;
  const opcodeNames = opts?.opcodeNames ?? [];
  const flags = new Map<number, boolean>(opts?.initialFlags ?? []);
  const vars = new Map<number, number>(opts?.initialVars ?? []);
  const traceEvents: RuntimeTraceEvent[] = [];
  let executedCount = 0;
  let stoppedAtPc = walkedBody.startOffset;

  for (const opcode of walkedBody.opcodes) {
    if (executedCount >= maxSteps) {
      traceEvents.push(
        Object.freeze({
          kind: 'terminated' as const,
          pc: opcode.opcodeOffset,
          reason: 'max_steps' as const,
        }),
      );
      stoppedAtPc = opcode.opcodeOffset;
      break;
    }
    executedCount++;

    const opcodeName = opcodeNames[opcode.opcodeIndex] ?? null;
    traceEvents.push(
      Object.freeze({
        kind: 'opcode_executed' as const,
        pc: opcode.opcodeOffset,
        opcodeIndex: opcode.opcodeIndex,
        opcodeName,
        argBytes: opcode.argBytes,
      }),
    );

    // Handle the semantic ops we care about. Unknown ops execute as
    // no-ops (their argbytes already consumed by the walker).
    if (opcodeName !== null) {
      switch (opcodeName) {
        case 'setflag': {
          const flagId = readU16Arg(opcode);
          if (flagId !== null) {
            const previous = flags.get(flagId) ?? false;
            flags.set(flagId, true);
            traceEvents.push(
              Object.freeze({
                kind: 'flag_set' as const,
                pc: opcode.opcodeOffset,
                flagId,
                previousValue: previous,
              }),
            );
          }
          break;
        }
        case 'clearflag': {
          const flagId = readU16Arg(opcode);
          if (flagId !== null) {
            const previous = flags.get(flagId) ?? false;
            flags.set(flagId, false);
            traceEvents.push(
              Object.freeze({
                kind: 'flag_cleared' as const,
                pc: opcode.opcodeOffset,
                flagId,
                previousValue: previous,
              }),
            );
          }
          break;
        }
        case 'checkflag': {
          const flagId = readU16Arg(opcode);
          if (flagId !== null) {
            const observed = flags.get(flagId) ?? false;
            traceEvents.push(
              Object.freeze({
                kind: 'flag_read' as const,
                pc: opcode.opcodeOffset,
                flagId,
                observedValue: observed,
              }),
            );
          }
          break;
        }
        case 'setvar': {
          const variableId = readU16Arg(opcode);
          const value = readU16Arg(opcode, 2);
          if (variableId !== null && value !== null) {
            const previous = vars.get(variableId) ?? 0;
            vars.set(variableId, value);
            traceEvents.push(
              Object.freeze({
                kind: 'var_set' as const,
                pc: opcode.opcodeOffset,
                variableId,
                value,
                previousValue: previous,
              }),
            );
          }
          break;
        }
        case 'compare_var_to_value':
        case 'compare_var_to_var': {
          const variableId = readU16Arg(opcode);
          if (variableId !== null) {
            const observed = vars.get(variableId) ?? 0;
            traceEvents.push(
              Object.freeze({
                kind: 'var_read' as const,
                pc: opcode.opcodeOffset,
                variableId,
                observedValue: observed,
              }),
            );
          }
          break;
        }
        default:
          if (END_OPCODE_NAMES.has(opcodeName)) {
            traceEvents.push(
              Object.freeze({
                kind: 'terminated' as const,
                pc: opcode.opcodeOffset,
                reason:
                  opcodeName === 'end'
                    ? ('end_opcode' as const)
                    : ('return_opcode' as const),
              }),
            );
            stoppedAtPc = opcode.opcodeOffset;
            return Object.freeze({
              traceEvents: Object.freeze(traceEvents),
              endState: Object.freeze({
                flags: new Map(flags),
                vars: new Map(vars),
                stoppedAtPc,
                executedCount,
              }),
              walkedBody,
            });
          }
          break;
      }
    }

    stoppedAtPc = opcode.opcodeOffset + 1 + opcode.argByteCount;
  }

  // Body's walked opcodes exhausted - the walker already stopped for
  // its own reason (invalid_opcode / out_of_bounds / max_opcodes /
  // profile_missing). Emit one terminated event reflecting that.
  if (walkedBody.opcodes.length === 0 || traceEvents[traceEvents.length - 1]?.kind !== 'terminated') {
    const reason = mapWalkerStopReason(walkedBody.stoppedReason);
    traceEvents.push(
      Object.freeze({
        kind: 'terminated' as const,
        pc: stoppedAtPc,
        reason,
      }),
    );
  }

  return Object.freeze({
    traceEvents: Object.freeze(traceEvents),
    endState: Object.freeze({
      flags: new Map(flags),
      vars: new Map(vars),
      stoppedAtPc,
      executedCount,
    }),
    walkedBody,
  });
}

/** Read a u16 little-endian from the opcode's argBytes at byteIndex. */
function readU16Arg(opcode: WalkedOpcode, byteIndex = 0): number | null {
  if (byteIndex + 2 > opcode.argByteCount) return null;
  const lo = opcode.argBytes[byteIndex] ?? 0;
  const hi = opcode.argBytes[byteIndex + 1] ?? 0;
  return ((lo | (hi << 8)) & 0xffff) >>> 0;
}

function mapWalkerStopReason(
  walkerReason: WalkedScriptBody['stoppedReason'],
): 'invalid_opcode' | 'out_of_bounds' | 'max_steps' {
  switch (walkerReason) {
    case 'invalid_opcode':
      return 'invalid_opcode';
    case 'out_of_bounds':
      return 'out_of_bounds';
    case 'max_opcodes':
      return 'max_steps';
    case 'profile_missing':
      return 'invalid_opcode';
  }
}
