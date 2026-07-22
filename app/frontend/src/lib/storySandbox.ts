// In-memory story walker - the foundation for "writers can test conditional
// dialogue without recompiling" (Phase 5 criterion 3). Pure state-machine
// functions over the structured `NarrativeEdge.condition` and
// `NarrativeEdge.sideEffectOps` so the sandbox is unit-testable and the React
// component is a thin shell.

import type { ProjectManifest } from '@rom-editor/shared';
import {
  traceDialogueNarrative,
  type NarrativeCondition,
  type NarrativeEdge,
  type NarrativeSideEffect,
  type NarrativeTrace,
} from './dialogueTrace';

export interface SandboxState {
  readonly flags: ReadonlyMap<string, boolean>;
  readonly variables: ReadonlyMap<string, number>;
}

export interface SandboxStepRecord {
  readonly fromDialogueId: string;
  readonly toDialogueId: string;
  readonly edge: NarrativeEdge;
  readonly stepIndex: number;
}

export interface SandboxSession {
  readonly startDialogueId: string;
  readonly currentDialogueId: string;
  readonly state: SandboxState;
  readonly history: ReadonlyArray<SandboxStepRecord>;
}

export type ConditionResult = 'true' | 'false' | 'unknown';

export interface NextOption {
  readonly edge: NarrativeEdge;
  readonly result: ConditionResult;
}

/** Build the initial sandbox state from the manifest's declared defaults. */
export function initialSandboxState(manifest: ProjectManifest): SandboxState {
  const flags = new Map<string, boolean>();
  for (const f of manifest.flags) flags.set(f.id, f.defaultValue);
  const variables = new Map<string, number>();
  for (const v of manifest.variables) variables.set(v.id, v.defaultValue);
  return { flags, variables };
}

/** Snapshot of "what changed from the manifest's defaults" - useful for
 *  highlighting in the UI ("FLAG_INTRO_DONE was false, is now true"). */
export function diffFromDefaults(
  manifest: ProjectManifest,
  state: SandboxState,
): {
  flags: ReadonlyArray<{ id: string; value: boolean; defaultValue: boolean }>;
  variables: ReadonlyArray<{ id: string; value: number; defaultValue: number }>;
} {
  const flagDiff: Array<{ id: string; value: boolean; defaultValue: boolean }> = [];
  for (const f of manifest.flags) {
    const v = state.flags.get(f.id) ?? f.defaultValue;
    if (v !== f.defaultValue) flagDiff.push({ id: f.id, value: v, defaultValue: f.defaultValue });
  }
  const varDiff: Array<{ id: string; value: number; defaultValue: number }> = [];
  for (const v of manifest.variables) {
    const cur = state.variables.get(v.id) ?? v.defaultValue;
    if (cur !== v.defaultValue) varDiff.push({ id: v.id, value: cur, defaultValue: v.defaultValue });
  }
  return { flags: flagDiff, variables: varDiff };
}

function parseValue(raw: string): number | null {
  // Pokemerald script values can be decimal ("1"), hex ("0x10"), or symbolic
  // ("VAR_RESULT_YES"). For symbolic forms we cannot evaluate a comparison
  // numerically without a constants table - return null to mean "unknown".
  if (/^-?\d+$/.test(raw)) return Number.parseInt(raw, 10);
  if (/^-?0x[0-9a-fA-F]+$/.test(raw)) return Number.parseInt(raw.slice(raw.indexOf('x') + 1), 16);
  return null;
}

export function evaluateCondition(
  condition: NarrativeCondition,
  state: SandboxState,
): ConditionResult {
  switch (condition.kind) {
    case 'always':
      return 'true';
    case 'flag_set':
      return state.flags.get(condition.flagId) === true ? 'true' : 'false';
    case 'flag_unset':
      return state.flags.get(condition.flagId) === true ? 'false' : 'true';
    case 'var_eq': {
      const lhs = state.variables.get(condition.variableId);
      const rhs = parseValue(condition.value);
      if (lhs === undefined || rhs === null) return 'unknown';
      return lhs === rhs ? 'true' : 'false';
    }
    case 'var_ne': {
      const lhs = state.variables.get(condition.variableId);
      const rhs = parseValue(condition.value);
      if (lhs === undefined || rhs === null) return 'unknown';
      return lhs !== rhs ? 'true' : 'false';
    }
    case 'expression':
    case 'unknown':
      return 'unknown';
  }
}

export function applySideEffect(state: SandboxState, op: NarrativeSideEffect): SandboxState {
  const flags = new Map(state.flags);
  const variables = new Map(state.variables);
  switch (op.kind) {
    case 'set_flag':
      flags.set(op.flagId, true);
      break;
    case 'clear_flag':
      flags.set(op.flagId, false);
      break;
    case 'set_var': {
      const v = parseValue(op.value);
      if (v !== null) variables.set(op.variableId, v);
      break;
    }
    case 'add_var': {
      const v = parseValue(op.value);
      if (v !== null) variables.set(op.variableId, (variables.get(op.variableId) ?? 0) + v);
      break;
    }
    case 'sub_var': {
      const v = parseValue(op.value);
      if (v !== null) variables.set(op.variableId, (variables.get(op.variableId) ?? 0) - v);
      break;
    }
    case 'copy_var': {
      const src = variables.get(op.sourceId);
      if (src !== undefined) variables.set(op.destId, src);
      break;
    }
  }
  return { flags, variables };
}

export function applySideEffectOps(
  state: SandboxState,
  ops: ReadonlyArray<NarrativeSideEffect>,
): SandboxState {
  let next = state;
  for (const op of ops) next = applySideEffect(next, op);
  return next;
}

/** Return the outgoing edges from `currentDialogueId` annotated with whether
 *  each condition evaluates `true` / `false` / `unknown` in `state`. Used by
 *  the UI to render the "follow" buttons. */
export function availableNextOptions(
  trace: NarrativeTrace,
  currentDialogueId: string,
  state: SandboxState,
): ReadonlyArray<NextOption> {
  return trace.edges
    .filter((e) => e.fromId === currentDialogueId)
    .map((e) => ({ edge: e, result: evaluateCondition(e.condition, state) }));
}

/** Advance the session along `edge`: apply its side-effects, move the pointer,
 *  append a history record. Returns the new session. */
export function follow(session: SandboxSession, edge: NarrativeEdge): SandboxSession {
  const newState = applySideEffectOps(session.state, edge.sideEffectOps);
  const record: SandboxStepRecord = {
    fromDialogueId: session.currentDialogueId,
    toDialogueId: edge.toId,
    edge,
    stepIndex: session.history.length,
  };
  return {
    ...session,
    currentDialogueId: edge.toId,
    state: newState,
    history: [...session.history, record],
  };
}

/** Reset the session to its starting line + the manifest's default state. */
export function resetSession(
  session: SandboxSession,
  manifest: ProjectManifest,
): SandboxSession {
  return {
    startDialogueId: session.startDialogueId,
    currentDialogueId: session.startDialogueId,
    state: initialSandboxState(manifest),
    history: [],
  };
}

/** Convenience: build a fresh session anchored at `dialogueId`. */
export function createSession(
  manifest: ProjectManifest,
  dialogueId: string,
): SandboxSession {
  return {
    startDialogueId: dialogueId,
    currentDialogueId: dialogueId,
    state: initialSandboxState(manifest),
    history: [],
  };
}

/** Walk the trace forward from `currentDialogueId` to enumerate all outgoing
 *  edges PLUS perform a single-step re-trace if the current node was rendered
 *  as a leaf of the original trace (i.e. depth = maxDepth). The sandbox calls
 *  this internally - exported for tests + UI re-anchoring. */
export function ensureTraceCoversCurrent(
  manifest: ProjectManifest,
  trace: NarrativeTrace,
  currentDialogueId: string,
): NarrativeTrace {
  const hasOutgoing = trace.edges.some((e) => e.fromId === currentDialogueId);
  if (hasOutgoing) return trace;
  if (currentDialogueId === trace.root.id && trace.edges.length === 0) {
    // The original root had no edges - stay there; nothing to do.
    return trace;
  }
  // Re-anchor the trace to the current dialogue so the sandbox can keep going.
  return traceDialogueNarrative(manifest, currentDialogueId);
}
