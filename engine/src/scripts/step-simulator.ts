/**
 * Script step simulator (Phase 3.5).
 *
 * Walks a decoded script-step list with a state machine - tracks flag
 * sets/clears, var assignments, dialogue lines passed, branches taken,
 * NPCs moved, items given. Used by:
 *
 *   - `propose_check_story_coherence` (Phase 3.23): verify reachability
 *     from a starting state.
 *   - `propose_test_scene` (Phase 3.25): simulate a scene's bytecode
 *     against pre-set var/flag conditions and assert outcomes.
 *
 * Out of scope:
 *   - True branch following across multi-script entrypoints (the
 *     simulator records the target ROM pointer and STOPS at goto/call;
 *     it doesn't recursively decode the destination).
 *   - Engine-internal effects (battle resolution, fade animations,
 *     etc.) - the simulator just notes "battle started", not the
 *     outcome.
 *
 * The simulator is OPCODE-AWARE in that it handles the ScriptStepKind
 * union the editor emits - anything else (kind: 'raw') is logged as
 * `unknown_op` and the simulator continues.
 */

import type { DecodedScriptStep } from './binary-script-decoder.js';

export interface ScriptSimState {
  /** Set of flag ids known to be on. */
  readonly flags: Set<number>;
  /** Map of var id → current value. */
  readonly vars: Map<number, number>;
  /** Items the player has been given during this run. */
  readonly itemsGiven: Array<{ readonly itemId: number; readonly quantity: number }>;
  /** Trainer battles started (recorded but not resolved). */
  readonly battlesStarted: number[];
  /** Warps the script invoked. */
  readonly warpsTaken: Array<{
    readonly mapGroup: number;
    readonly mapNum: number;
    readonly x: number;
    readonly y: number;
  }>;
  /** Dialogue lines the script displayed (text content from the
   *  decoder's `dialogueText` param). */
  readonly dialoguesShown: string[];
  /** Branch destinations the simulator stopped at. */
  readonly branchesEncountered: Array<{
    readonly opcodeName: string;
    readonly targetRomPtr?: number;
    readonly condition?: number;
    readonly varId?: number;
    readonly value?: number;
  }>;
  /** Trace of steps visited (indices into the input script). */
  readonly stepsVisited: number[];
  /** Unknown opcodes the simulator skipped past. */
  readonly unknownOps: Array<{ readonly stepIndex: number; readonly opcode: number }>;
}

export interface ScriptSimResult {
  readonly state: ScriptSimState;
  readonly stoppedReason:
    | 'terminator' // hit `end` or `return`
    | 'branch' // hit goto / call / goto_if / branch_on_var - caller can recurse
    | 'max_steps' // hit the cap (defensive)
    | 'unknown'; // unknown opcode AND `haltOnUnknown=true`
  readonly stoppedAtStepIndex: number;
}

export interface ScriptSimOptions {
  /** Initial flags + vars. */
  readonly initial?: {
    readonly flags?: ReadonlySet<number> | ReadonlyArray<number>;
    readonly vars?: ReadonlyMap<number, number> | ReadonlyArray<readonly [number, number]>;
  };
  /** Max steps before bailing. Defaults to the script length × 2. */
  readonly maxSteps?: number;
  /** When true, an unknown opcode halts the simulation; default false
   *  (simulator just logs + continues). */
  readonly haltOnUnknown?: boolean;
}

/** Simulate a decoded script. Walks step-by-step until a terminator or
 *  a branch (whichever comes first). */
export function simulateScript(
  steps: ReadonlyArray<DecodedScriptStep>,
  opts: ScriptSimOptions = {},
): ScriptSimResult {
  const state: ScriptSimState = {
    flags: new Set<number>(toIterable(opts.initial?.flags)),
    vars: new Map<number, number>(toEntries(opts.initial?.vars)),
    itemsGiven: [],
    battlesStarted: [],
    warpsTaken: [],
    dialoguesShown: [],
    branchesEncountered: [],
    stepsVisited: [],
    unknownOps: [],
  };
  const maxSteps = opts.maxSteps ?? steps.length * 2;
  let i = 0;
  while (i < steps.length && state.stepsVisited.length < maxSteps) {
    const step = steps[i]!;
    state.stepsVisited.push(i);

    switch (step.kind) {
      case 'set_flag': {
        const flagId = numParam(step, 'flagId');
        if (flagId !== null) state.flags.add(flagId);
        break;
      }
      case 'clear_flag': {
        const flagId = numParam(step, 'flagId');
        if (flagId !== null) state.flags.delete(flagId);
        break;
      }
      case 'set_variable': {
        const opcodeName = strParam(step, 'opcodeName') ?? 'setvar';
        const varId = numParam(step, 'varId');
        const value = numParam(step, 'value');
        if (varId !== null) {
          const existing = state.vars.get(varId) ?? 0;
          if (opcodeName === 'addvar' && value !== null) {
            state.vars.set(varId, (existing + value) & 0xffff);
          } else if (opcodeName === 'subvar' && value !== null) {
            state.vars.set(varId, (existing - value) & 0xffff);
          } else if (value !== null) {
            state.vars.set(varId, value & 0xffff);
          }
        }
        break;
      }
      case 'dialogue': {
        const text = strParam(step, 'dialogueText');
        if (text !== null) state.dialoguesShown.push(text);
        break;
      }
      case 'give_item': {
        const itemId = numParam(step, 'itemId');
        const quantity = numParam(step, 'quantity') ?? 1;
        if (itemId !== null) state.itemsGiven.push({ itemId, quantity });
        break;
      }
      case 'start_battle': {
        const trainerId = numParam(step, 'trainerId');
        if (trainerId !== null) state.battlesStarted.push(trainerId);
        return {
          state,
          stoppedReason: 'branch',
          stoppedAtStepIndex: i,
        };
      }
      case 'warp_player': {
        const mapGroup = numParam(step, 'destMapBank') ?? 0;
        const mapNum = numParam(step, 'destMapNum') ?? 0;
        const x = numParam(step, 'x') ?? 0;
        const y = numParam(step, 'y') ?? 0;
        state.warpsTaken.push({ mapGroup, mapNum, x, y });
        return {
          state,
          stoppedReason: 'branch',
          stoppedAtStepIndex: i,
        };
      }
      case 'branch': {
        // Generic branches: goto / call / goto_if / call_if /
        // checkflag / etc. We record but don't follow.
        const entry: ScriptSimState['branchesEncountered'][number] & {
          targetRomPtr?: number;
          condition?: number;
          varId?: number;
          value?: number;
        } = {
          opcodeName: strParam(step, 'opcodeName') ?? 'branch',
        };
        const target = numParam(step, 'targetRomPtr');
        if (target !== null) entry.targetRomPtr = target;
        const cond = numParam(step, 'condition');
        if (cond !== null) entry.condition = cond;
        const vid = numParam(step, 'varId');
        if (vid !== null) entry.varId = vid;
        const val = numParam(step, 'value');
        if (val !== null) entry.value = val;
        state.branchesEncountered.push(entry);
        const op = strParam(step, 'opcodeName');
        if (op === 'goto' || op === 'goto_if') {
          // unconditional / conditional non-recursive: stop and let
          // caller handle the branch.
          return { state, stoppedReason: 'branch', stoppedAtStepIndex: i };
        }
        break;
      }
      case 'branch_on_var': {
        const varId = numParam(step, 'varId');
        const value = numParam(step, 'value');
        const operator = strParam(step, 'operator');
        const target = numParam(step, 'targetRomPtr');
        const entry: ScriptSimState['branchesEncountered'][number] & {
          targetRomPtr?: number;
          varId?: number;
          value?: number;
        } = {
          opcodeName: 'branch_on_var',
        };
        if (target !== null) entry.targetRomPtr = target;
        if (varId !== null) entry.varId = varId;
        if (value !== null) entry.value = value;
        state.branchesEncountered.push(entry);
        // Evaluate the condition against the current var state.
        if (varId !== null && value !== null && operator !== null) {
          const currentValue = state.vars.get(varId) ?? 0;
          const matches = evalOperator(operator, currentValue, value);
          if (matches) {
            // Caller can recurse on the targetRomPtr if it wants.
            return { state, stoppedReason: 'branch', stoppedAtStepIndex: i };
          }
        }
        break;
      }
      case 'raw': {
        const opcode = numParam(step, 'opcode');
        if (opcode !== null) {
          state.unknownOps.push({ stepIndex: i, opcode });
          // Terminator opcodes (end=0x02, return=0x03) stop us.
          if (opcode === 0x02 || opcode === 0x03) {
            return { state, stoppedReason: 'terminator', stoppedAtStepIndex: i };
          }
        }
        if (opts.haltOnUnknown) {
          return { state, stoppedReason: 'unknown', stoppedAtStepIndex: i };
        }
        break;
      }
      case 'fade_scene':
      case 'play_sound':
      case 'move_npc':
      case 'randomize_branch':
        // Recognised, no state effect we model.
        break;
      default: {
        // Exhaustiveness; future ScriptStepKind values fall here as a
        // logged unknown without halting.
        state.unknownOps.push({ stepIndex: i, opcode: -1 });
      }
    }
    i++;
  }
  return {
    state,
    stoppedReason: state.stepsVisited.length >= maxSteps ? 'max_steps' : 'terminator',
    stoppedAtStepIndex: i,
  };
}

function evalOperator(op: string, a: number, b: number): boolean {
  switch (op) {
    case 'less': return a < b;
    case 'lessorequal': return a <= b;
    case 'equal': return a === b;
    case 'notequal': return a !== b;
    case 'greaterorequal': return a >= b;
    case 'greater': return a > b;
    default: return false;
  }
}

function numParam(step: DecodedScriptStep, key: string): number | null {
  const v = step.params[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function strParam(step: DecodedScriptStep, key: string): string | null {
  const v = step.params[key];
  return typeof v === 'string' ? v : null;
}

function toIterable(v: ReadonlySet<number> | ReadonlyArray<number> | undefined): Iterable<number> {
  if (!v) return [];
  if (v instanceof Set) return v;
  return v;
}

function toEntries(
  v: ReadonlyMap<number, number> | ReadonlyArray<readonly [number, number]> | undefined,
): Iterable<[number, number]> {
  if (!v) return [];
  if (v instanceof Map) return v.entries();
  return v as Iterable<[number, number]>;
}
