// Pure preview-breakpoint evaluator. Given the live manifest, the active map,
// the current player position, and an array of armed breakpoints, returns the
// list of matches plus a typed reason per match. Closes the "broken warp/event
// debuggable in-context" half of Phase 7 criterion 2 by turning typed entity
// ids into instant-fire hit signals at every player move.
//
// All state is immutable; React state-machine semantics are unchanged.

import type { ProjectManifest, ScriptStep } from '@rom-editor/shared';

export type BreakpointKind =
  | 'warp_taken'
  | 'trigger_fire'
  | 'object_event_step'
  | 'dialogue_show';

export interface Breakpoint {
  readonly id: string;
  readonly kind: BreakpointKind;
  /** Optional entity-id filter - e.g. warp id, trigger id, dialogue label.
   *  When null, the breakpoint matches ANY entity of the given kind. */
  readonly entityId: string | null;
  readonly armed: boolean;
}

export interface BreakpointHit {
  readonly breakpointId: string;
  readonly kind: BreakpointKind;
  readonly reason: string;
  readonly entityId: string | null;
  readonly tile: { readonly x: number; readonly y: number };
  /** Monotonic counter so the UI can render most-recent-first. */
  readonly sequence: number;
}

export interface BreakpointState {
  readonly breakpoints: ReadonlyArray<Breakpoint>;
  readonly hits: ReadonlyArray<BreakpointHit>;
  readonly nextSequence: number;
}

export function emptyBreakpointState(): BreakpointState {
  return { breakpoints: [], hits: [], nextSequence: 0 };
}

export function armBreakpoint(
  state: BreakpointState,
  bp: Omit<Breakpoint, 'armed'> & { armed?: boolean },
): BreakpointState {
  const next: Breakpoint = { ...bp, armed: bp.armed ?? true };
  // Replace if the id already exists; otherwise append.
  const existingIdx = state.breakpoints.findIndex((b) => b.id === bp.id);
  if (existingIdx >= 0) {
    const copy = state.breakpoints.slice();
    copy[existingIdx] = next;
    return { ...state, breakpoints: copy };
  }
  return { ...state, breakpoints: [...state.breakpoints, next] };
}

export function disarmBreakpoint(state: BreakpointState, id: string): BreakpointState {
  return {
    ...state,
    breakpoints: state.breakpoints.filter((b) => b.id !== id),
  };
}

export function clearHits(state: BreakpointState): BreakpointState {
  return { ...state, hits: [] };
}

export function clearAll(): BreakpointState {
  return emptyBreakpointState();
}

/**
 * Evaluate every armed breakpoint against the current player tile on the
 * given map. Returns hits in the same order as the input breakpoints.
 * Does NOT mutate state; callers append the returned hits via recordHits().
 */
export function evaluateBreakpoints(
  state: BreakpointState,
  manifest: ProjectManifest,
  mapId: string,
  pos: { x: number; y: number },
): ReadonlyArray<Omit<BreakpointHit, 'sequence'>> {
  const matches: Array<Omit<BreakpointHit, 'sequence'>> = [];
  for (const bp of state.breakpoints) {
    if (!bp.armed) continue;
    const match = evaluateOne(bp, manifest, mapId, pos);
    if (match) matches.push(match);
  }
  return matches;
}

export function recordHits(
  state: BreakpointState,
  newHits: ReadonlyArray<Omit<BreakpointHit, 'sequence'>>,
  /** Cap the kept history so the UI list stays bounded. */
  maxHits = 50,
): BreakpointState {
  if (newHits.length === 0) return state;
  let seq = state.nextSequence;
  const stamped: BreakpointHit[] = [];
  for (const h of newHits) {
    stamped.push({ ...h, sequence: seq });
    seq += 1;
  }
  const combined = [...stamped, ...state.hits].slice(0, maxHits);
  return { ...state, hits: combined, nextSequence: seq };
}

function evaluateOne(
  bp: Breakpoint,
  manifest: ProjectManifest,
  mapId: string,
  pos: { x: number; y: number },
): Omit<BreakpointHit, 'sequence'> | null {
  switch (bp.kind) {
    case 'warp_taken': {
      const warp = manifest.warps.find(
        (w) =>
          w.fromMapId === mapId &&
          w.fromCoord.x === pos.x &&
          w.fromCoord.y === pos.y &&
          (bp.entityId === null || w.id === bp.entityId),
      );
      if (!warp) return null;
      return {
        breakpointId: bp.id,
        kind: bp.kind,
        entityId: warp.id,
        reason: `warp ${warp.id} → ${warp.toMapId} @ (${warp.toCoord.x}, ${warp.toCoord.y})`,
        tile: pos,
      };
    }
    case 'trigger_fire': {
      const trig = manifest.triggers.find(
        (t) =>
          t.mapId === mapId &&
          t.coord !== null &&
          t.coord.x === pos.x &&
          t.coord.y === pos.y &&
          (bp.entityId === null || t.id === bp.entityId),
      );
      if (!trig) return null;
      const cond = trig.conditionExpression ? ` · if ${trig.conditionExpression}` : '';
      return {
        breakpointId: bp.id,
        kind: bp.kind,
        entityId: trig.id,
        reason: `trigger ${trig.id} (${trig.kind})${cond}`,
        tile: pos,
      };
    }
    case 'object_event_step': {
      const obj = manifest.objectEvents.find(
        (o) =>
          o.mapId === mapId &&
          o.coord.x === pos.x &&
          o.coord.y === pos.y &&
          (bp.entityId === null || o.id === bp.entityId),
      );
      if (!obj) return null;
      const flag = obj.flagId ? ` · gated by ${obj.flagId}` : '';
      return {
        breakpointId: bp.id,
        kind: bp.kind,
        entityId: obj.id,
        reason: `object ${obj.id} (${obj.kind})${flag}`,
        tile: pos,
      };
    }
    case 'dialogue_show': {
      // The dialogue this object event would show is reached via its scriptId.
      // We look up the first msgbox-kind ScriptStep in that script and check
      // whether its text param matches bp.entityId (or any, if null).
      const obj = manifest.objectEvents.find(
        (o) => o.mapId === mapId && o.coord.x === pos.x && o.coord.y === pos.y,
      );
      if (!obj || !obj.scriptId) return null;
      const matchingStep = findFirstDialogueStep(manifest.scriptSteps, obj.scriptId);
      if (!matchingStep) return null;
      const dlgId = typeof matchingStep.params['text'] === 'string'
        ? (matchingStep.params['text'] as string)
        : null;
      if (!dlgId) return null;
      if (bp.entityId !== null && bp.entityId !== dlgId) return null;
      return {
        breakpointId: bp.id,
        kind: bp.kind,
        entityId: dlgId,
        reason: `dialogue ${dlgId} (from object ${obj.id})`,
        tile: pos,
      };
    }
  }
}

function findFirstDialogueStep(
  steps: ReadonlyArray<ScriptStep>,
  scriptLabel: string,
): ScriptStep | null {
  // ScriptStep ids look like "<scriptLabel>#<n>". The first dialogue-kind step
  // in that block (by ascending index) is what the engine would show first.
  const inBlock = steps
    .filter((s) => {
      const hashIdx = s.id.lastIndexOf('#');
      return hashIdx > 0 && s.id.slice(0, hashIdx) === scriptLabel;
    })
    .sort((a, b) => {
      const ai = Number.parseInt(a.id.slice(a.id.lastIndexOf('#') + 1), 10);
      const bi = Number.parseInt(b.id.slice(b.id.lastIndexOf('#') + 1), 10);
      return ai - bi;
    });
  return inBlock.find((s) => s.kind === 'dialogue') ?? null;
}
