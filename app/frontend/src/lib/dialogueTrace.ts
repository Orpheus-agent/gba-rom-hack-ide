// Pure narrative-graph tracer for the DialogueView. Given a manifest + a starting
// dialogue id, walks the SCRIPT graph forward from each msgbox call site for that
// dialogue and emits a small typed graph of "what comes next" - every reachable
// next-dialogue, every branch condition, every flag side-effect annotated on its
// edge. No React, no IO - pure manifest-derived computation so the trace stays
// unit-testable.
//
// Per D-0015: pokemerald's `text.inc` parser emits `DialogueNode.choices: []`
// always - branching narrative lives in `scripts.inc` (`msgbox` + `multichoice`
// + `goto_if_*` + `compare`). This trace is the script-graph-driven view of the
// dialogue, complementing the per-line text editor.

import type {
  EntityId,
  ProjectManifest,
  ScriptStep,
} from '@rom-editor/shared';

export type NarrativeNodeKind = 'dialogue' | 'unknown';

export interface NarrativeNode {
  readonly id: string;
  readonly kind: NarrativeNodeKind;
  readonly label: string;
  readonly speakerName: string | null;
  readonly preview: string | null;
  readonly depth: number;
  readonly isRoot: boolean;
}

/** Structured representation of an edge's branch condition. The rendered
 *  `NarrativeEdge.label` is derived from this, but downstream consumers (the
 *  story sandbox) need the typed form to evaluate against an in-memory state. */
export type NarrativeCondition =
  | { readonly kind: 'always' }
  | { readonly kind: 'flag_set'; readonly flagId: string }
  | { readonly kind: 'flag_unset'; readonly flagId: string }
  | { readonly kind: 'var_eq'; readonly variableId: string; readonly value: string }
  | { readonly kind: 'var_ne'; readonly variableId: string; readonly value: string }
  | { readonly kind: 'expression'; readonly raw: string }
  | { readonly kind: 'unknown'; readonly raw: string };

/** Structured representation of a script side-effect (setflag, setvar, etc.) so
 *  the sandbox can apply it without re-parsing the human-readable string form. */
export type NarrativeSideEffect =
  | { readonly kind: 'set_flag'; readonly flagId: string }
  | { readonly kind: 'clear_flag'; readonly flagId: string }
  | { readonly kind: 'set_var'; readonly variableId: string; readonly value: string }
  | { readonly kind: 'add_var'; readonly variableId: string; readonly value: string }
  | { readonly kind: 'sub_var'; readonly variableId: string; readonly value: string }
  | { readonly kind: 'copy_var'; readonly destId: string; readonly sourceId: string };

export interface NarrativeEdge {
  readonly id: string;
  readonly fromId: string;
  readonly toId: string;
  readonly label: string;
  readonly kind: 'next' | 'branch' | 'choice';
  /** Side-effects encountered between fromId and toId (e.g. ["sets FLAG_X", "VAR_Y ← 1"]). */
  readonly sideEffects: ReadonlyArray<string>;
  /** Structured form of the side-effects so the story sandbox can apply them
   *  programmatically. Same order as `sideEffects`. */
  readonly sideEffectOps: ReadonlyArray<NarrativeSideEffect>;
  /** Structured form of the branch condition (used by the sandbox to decide
   *  whether the edge is reachable from current state). `{ kind: 'always' }`
   *  for unconditional fall-through edges. */
  readonly condition: NarrativeCondition;
}

export interface NarrativeCaller {
  readonly scriptStepId: string;
  readonly scriptLabel: string;
  readonly triggerId: string | null;
  readonly triggerKind: string | null;
  readonly mapId: string | null;
}

export interface NarrativeTrace {
  readonly root: NarrativeNode;
  readonly nodes: ReadonlyArray<NarrativeNode>;
  readonly edges: ReadonlyArray<NarrativeEdge>;
  readonly callers: ReadonlyArray<NarrativeCaller>;
  readonly truncated: boolean;
}

interface Indexes {
  readonly stepById: ReadonlyMap<string, ScriptStep>;
  readonly stepsByLabel: ReadonlyMap<string, ReadonlyArray<ScriptStep>>;
  readonly msgboxCallersByDialogueId: ReadonlyMap<string, ReadonlyArray<ScriptStep>>;
  readonly labelToFirstStepId: ReadonlyMap<string, string>;
  readonly triggerByStepId: ReadonlyMap<string, { id: EntityId; kind: string; mapId: string | null }>;
}

function parseStepLabel(stepId: string): { label: string; index: number } | null {
  const hashIdx = stepId.lastIndexOf('#');
  if (hashIdx <= 0) return null;
  const label = stepId.slice(0, hashIdx);
  const idxStr = stepId.slice(hashIdx + 1);
  const index = Number.parseInt(idxStr, 10);
  if (!Number.isFinite(index)) return null;
  return { label, index };
}

function buildIndexes(manifest: ProjectManifest): Indexes {
  const stepById = new Map<string, ScriptStep>();
  for (const s of manifest.scriptSteps) stepById.set(s.id, s);

  // Group every step by its label, preserving ascending #index order so we can
  // walk forward from a known starting step.
  const stepsByLabel = new Map<string, ScriptStep[]>();
  for (const s of manifest.scriptSteps) {
    const parsed = parseStepLabel(s.id);
    if (!parsed) continue;
    const bucket = stepsByLabel.get(parsed.label) ?? [];
    bucket.push(s);
    stepsByLabel.set(parsed.label, bucket);
  }
  for (const [, arr] of stepsByLabel) arr.sort((a, b) => {
    const ai = parseStepLabel(a.id)?.index ?? 0;
    const bi = parseStepLabel(b.id)?.index ?? 0;
    return ai - bi;
  });

  // Index msgbox/message callers by their text argument so we can answer
  // "which scripts call this dialogue line?" in O(1).
  const msgboxCallersByDialogueId = new Map<string, ScriptStep[]>();
  for (const s of manifest.scriptSteps) {
    if (s.kind !== 'dialogue') continue;
    const text = s.params['text'];
    if (typeof text !== 'string') continue;
    const bucket = msgboxCallersByDialogueId.get(text) ?? [];
    bucket.push(s);
    msgboxCallersByDialogueId.set(text, bucket);
  }

  // Label → first-step lookup so branch targets can resolve to a concrete step.
  const labelToFirstStepId = new Map<string, string>();
  for (const [label, arr] of stepsByLabel) {
    const first = arr[0];
    if (first) labelToFirstStepId.set(label, first.id);
  }

  // Reverse-index every step → its parent trigger (a step can only belong to one).
  const triggerByStepId = new Map<string, { id: EntityId; kind: string; mapId: string | null }>();
  for (const t of manifest.triggers) {
    for (const sid of t.scriptStepIds) {
      triggerByStepId.set(sid, { id: t.id, kind: t.kind, mapId: t.mapId });
    }
  }

  return {
    stepById,
    stepsByLabel,
    msgboxCallersByDialogueId,
    labelToFirstStepId,
    triggerByStepId,
  };
}

function makeDialogueNode(
  manifest: ProjectManifest,
  dialogueId: string,
  depth: number,
  isRoot: boolean,
): NarrativeNode {
  const node = manifest.dialogue.find((d) => d.id === dialogueId);
  if (!node) {
    return {
      id: dialogueId,
      kind: 'unknown',
      label: dialogueId,
      speakerName: null,
      preview: null,
      depth,
      isRoot,
    };
  }
  return {
    id: dialogueId,
    kind: 'dialogue',
    label: node.id,
    speakerName: node.speakerName,
    preview: node.text.length > 60 ? node.text.slice(0, 60) + '…' : node.text,
    depth,
    isRoot,
  };
}

interface WalkContext {
  readonly indexes: Indexes;
  readonly indexesManifest: ProjectManifest;
  readonly nodes: Map<string, NarrativeNode>;
  readonly edges: NarrativeEdge[];
  readonly edgeIds: Set<string>;
  readonly visitedDialogueIds: Set<string>;
  readonly queue: Array<{ dialogueId: string; depth: number }>;
}

function ensureEdge(ctx: WalkContext, edge: NarrativeEdge): void {
  if (ctx.edgeIds.has(edge.id)) return;
  ctx.edgeIds.add(edge.id);
  ctx.edges.push(edge);
}

function describeSideEffectOp(step: ScriptStep): NarrativeSideEffect | null {
  const macro = typeof step.params['macro'] === 'string' ? step.params['macro'] : null;
  const flag = typeof step.params['flag'] === 'string' ? step.params['flag'] : null;
  const variable = typeof step.params['variable'] === 'string' ? step.params['variable'] : null;
  const value = typeof step.params['value'] === 'string' ? step.params['value'] : null;
  switch (macro) {
    case 'setflag':
      if (flag) return { kind: 'set_flag', flagId: flag };
      return null;
    case 'clearflag':
      if (flag) return { kind: 'clear_flag', flagId: flag };
      return null;
    case 'setvar':
      if (variable && value !== null) return { kind: 'set_var', variableId: variable, value };
      return null;
    case 'addvar':
      if (variable && value !== null) return { kind: 'add_var', variableId: variable, value };
      return null;
    case 'subvar':
      if (variable && value !== null) return { kind: 'sub_var', variableId: variable, value };
      return null;
    case 'copyvar': {
      const dest = typeof step.params['dest'] === 'string' ? step.params['dest'] : null;
      const source = typeof step.params['source'] === 'string' ? step.params['source'] : null;
      if (dest && source) return { kind: 'copy_var', destId: dest, sourceId: source };
      return null;
    }
    default:
      return null;
  }
}

function describeSideEffectString(op: NarrativeSideEffect): string {
  switch (op.kind) {
    case 'set_flag':
      return `sets ${op.flagId}`;
    case 'clear_flag':
      return `clears ${op.flagId}`;
    case 'set_var':
      return `${op.variableId} ← ${op.value}`;
    case 'add_var':
      return `${op.variableId} += ${op.value}`;
    case 'sub_var':
      return `${op.variableId} -= ${op.value}`;
    case 'copy_var':
      return `${op.destId} ← ${op.sourceId}`;
  }
}

function conditionFor(step: ScriptStep, pendingCompare: ScriptStep | null): NarrativeCondition {
  const macro = typeof step.params['macro'] === 'string' ? step.params['macro'] : '';
  const flag = typeof step.params['flag'] === 'string' ? step.params['flag'] : null;
  switch (macro) {
    case 'goto_if_set':
      if (flag) return { kind: 'flag_set', flagId: flag };
      return { kind: 'unknown', raw: macro };
    case 'goto_if_unset':
      if (flag) return { kind: 'flag_unset', flagId: flag };
      return { kind: 'unknown', raw: macro };
    case 'goto_if_eq': {
      const variableId =
        typeof pendingCompare?.params['left'] === 'string' ? pendingCompare.params['left'] : null;
      const value =
        typeof step.params['value'] === 'string'
          ? step.params['value']
          : typeof pendingCompare?.params['right'] === 'string'
            ? pendingCompare.params['right']
            : null;
      if (variableId && value !== null) return { kind: 'var_eq', variableId, value };
      return { kind: 'unknown', raw: macro };
    }
    case 'goto_if_ne': {
      const variableId =
        typeof pendingCompare?.params['left'] === 'string' ? pendingCompare.params['left'] : null;
      const value =
        typeof step.params['value'] === 'string'
          ? step.params['value']
          : typeof pendingCompare?.params['right'] === 'string'
            ? pendingCompare.params['right']
            : null;
      if (variableId && value !== null) return { kind: 'var_ne', variableId, value };
      return { kind: 'unknown', raw: macro };
    }
    case 'goto_if':
    case 'call_if': {
      const condition =
        typeof step.params['condition'] === 'string' ? step.params['condition'] : null;
      return { kind: 'expression', raw: condition ?? macro };
    }
    case 'call_if_set':
      if (flag) return { kind: 'flag_set', flagId: flag };
      return { kind: 'unknown', raw: macro };
    case 'call_if_unset':
      if (flag) return { kind: 'flag_unset', flagId: flag };
      return { kind: 'unknown', raw: macro };
    default:
      return { kind: 'unknown', raw: macro };
  }
}

function labelForCondition(condition: NarrativeCondition): string {
  switch (condition.kind) {
    case 'always':
      return 'after';
    case 'flag_set':
      return `if ${condition.flagId} set`;
    case 'flag_unset':
      return `if ${condition.flagId} unset`;
    case 'var_eq':
      return `if ${condition.variableId} == ${condition.value}`;
    case 'var_ne':
      return `if ${condition.variableId} != ${condition.value}`;
    case 'expression':
      return `if ${condition.raw}`;
    case 'unknown':
      return condition.raw || 'branch';
  }
}

/**
 * Walk forward from `startStep` within its script block, accumulating
 * side-effects (setflag etc.) until we hit either: (a) the next msgbox → emit
 * a "next" edge to the new dialogue, or (b) a conditional branch → emit a
 * "branch" edge to the first msgbox in the target label, then continue walking
 * forward past the branch step (fall-through case).
 *
 * Returns the dialogue ids that should be enqueued for further depth expansion.
 */
function walkForwardFromCaller(
  ctx: WalkContext,
  fromDialogueId: string,
  caller: ScriptStep,
  currentDepth: number,
  maxDepth: number,
): ReadonlyArray<string> {
  const parsed = parseStepLabel(caller.id);
  if (!parsed) return [];
  const block = ctx.indexes.stepsByLabel.get(parsed.label) ?? [];
  const startIdx = block.findIndex((s) => s.id === caller.id);
  if (startIdx < 0) return [];

  const pendingSideEffectOps: NarrativeSideEffect[] = [];
  const newlyAddedDialogueIds: string[] = [];
  let pendingCompare: ScriptStep | null = null;

  for (let i = startIdx + 1; i < block.length; i++) {
    const step = block[i];
    if (!step) continue;
    const macro = typeof step.params['macro'] === 'string' ? step.params['macro'] : null;

    if (step.kind === 'dialogue') {
      const nextDialogueId =
        typeof step.params['text'] === 'string' ? (step.params['text'] as string) : null;
      if (!nextDialogueId) break;
      addDialogueChildEdge(
        ctx,
        fromDialogueId,
        nextDialogueId,
        { kind: 'always' },
        pendingSideEffectOps.slice(),
        currentDepth + 1,
        maxDepth,
        'next',
      );
      newlyAddedDialogueIds.push(nextDialogueId);
      break;
    }

    // Branch macros - emit branch edge then continue past it (fall-through).
    if (
      macro === 'goto_if_set' ||
      macro === 'goto_if_unset' ||
      macro === 'goto_if_eq' ||
      macro === 'goto_if_ne' ||
      macro === 'goto_if' ||
      macro === 'call_if' ||
      macro === 'call_if_set' ||
      macro === 'call_if_unset'
    ) {
      const targetLabel =
        typeof step.params['label'] === 'string' ? (step.params['label'] as string) : null;
      if (targetLabel) {
        const targetDialogueId = findFirstDialogueAtLabel(ctx, targetLabel);
        if (targetDialogueId) {
          addDialogueChildEdge(
            ctx,
            fromDialogueId,
            targetDialogueId,
            conditionFor(step, pendingCompare),
            pendingSideEffectOps.slice(),
            currentDepth + 1,
            maxDepth,
            'branch',
          );
          newlyAddedDialogueIds.push(targetDialogueId);
        }
      }
      pendingCompare = null;
      continue;
    }

    if (macro === 'compare') {
      pendingCompare = step;
      continue;
    }

    if (macro === 'goto') {
      const targetLabel =
        typeof step.params['label'] === 'string' ? (step.params['label'] as string) : null;
      if (targetLabel) {
        const targetFirstId = ctx.indexes.labelToFirstStepId.get(targetLabel);
        if (targetFirstId) {
          const targetParsed = parseStepLabel(targetFirstId);
          if (targetParsed) {
            const newBlock = ctx.indexes.stepsByLabel.get(targetParsed.label) ?? [];
            const newStartIdx = newBlock.findIndex((s) => s.id === targetFirstId);
            if (newStartIdx >= 0) {
              const virtualCaller = newBlock[newStartIdx];
              if (virtualCaller && virtualCaller.id !== caller.id) {
                const added = walkForwardFromCaller(
                  ctx,
                  fromDialogueId,
                  { ...virtualCaller, id: `${virtualCaller.id}__via_goto_from_${caller.id}` } as ScriptStep,
                  currentDepth,
                  maxDepth,
                );
                for (const id of added) newlyAddedDialogueIds.push(id);
              }
            }
          }
        }
      }
      break;
    }

    if (macro === 'return' || macro === 'end' || step.kind === 'warp_player') {
      break;
    }

    const op = describeSideEffectOp(step);
    if (op) pendingSideEffectOps.push(op);
  }

  return newlyAddedDialogueIds;
}

function findFirstDialogueAtLabel(ctx: WalkContext, label: string): string | null {
  const block = ctx.indexes.stepsByLabel.get(label);
  if (!block) return null;
  for (const s of block) {
    if (s.kind === 'dialogue' && typeof s.params['text'] === 'string') {
      return s.params['text'] as string;
    }
  }
  return null;
}

function addDialogueChildEdge(
  ctx: WalkContext,
  fromDialogueId: string,
  toDialogueId: string,
  condition: NarrativeCondition,
  sideEffectOps: ReadonlyArray<NarrativeSideEffect>,
  newDepth: number,
  maxDepth: number,
  edgeKind: 'next' | 'branch' | 'choice',
): void {
  if (!ctx.nodes.has(toDialogueId)) {
    ctx.nodes.set(
      toDialogueId,
      makeDialogueNode(ctx.indexesManifest, toDialogueId, newDepth, false),
    );
    if (newDepth <= maxDepth && !ctx.visitedDialogueIds.has(toDialogueId)) {
      ctx.queue.push({ dialogueId: toDialogueId, depth: newDepth });
    }
  }
  const label = labelForCondition(condition);
  const edge: NarrativeEdge = {
    id: `${edgeKind}:${fromDialogueId}->${toDialogueId}:${label}`,
    fromId: fromDialogueId,
    toId: toDialogueId,
    label,
    kind: edgeKind,
    sideEffects: sideEffectOps.map(describeSideEffectString),
    sideEffectOps,
    condition,
  };
  ensureEdge(ctx, edge);
}

export function traceDialogueNarrative(
  manifest: ProjectManifest,
  dialogueId: EntityId,
  maxDepth = 2,
): NarrativeTrace {
  const indexes = buildIndexes(manifest);

  const root = makeDialogueNode(manifest, dialogueId, 0, true);
  const nodes = new Map<string, NarrativeNode>();
  nodes.set(dialogueId, root);
  const edges: NarrativeEdge[] = [];
  const edgeIds = new Set<string>();
  const visitedDialogueIds = new Set<string>();
  const queue: Array<{ dialogueId: string; depth: number }> = [{ dialogueId, depth: 0 }];

  const ctx: WalkContext = {
    indexes,
    nodes,
    edges,
    edgeIds,
    visitedDialogueIds,
    queue,
    indexesManifest: manifest,
  };

  let truncated = false;

  while (queue.length > 0) {
    const next = queue.shift();
    if (!next) break;
    if (visitedDialogueIds.has(next.dialogueId)) continue;
    visitedDialogueIds.add(next.dialogueId);

    if (next.depth >= maxDepth) {
      // Stop expanding from this node. If there are unseen callers downstream
      // we mark the trace as truncated so the UI can hint "more available".
      const callers = indexes.msgboxCallersByDialogueId.get(next.dialogueId) ?? [];
      if (callers.length > 0) truncated = true;
      continue;
    }

    const callers = indexes.msgboxCallersByDialogueId.get(next.dialogueId) ?? [];
    for (const c of callers) {
      walkForwardFromCaller(ctx, next.dialogueId, c, next.depth, maxDepth);
    }
  }

  // Build callers metadata for the root dialogue so the UI can show "called
  // from N scripts" without re-walking. Each unique script step contributes
  // one entry - deduplicate by step id.
  const callersForRoot = indexes.msgboxCallersByDialogueId.get(dialogueId) ?? [];
  const callerEntries: NarrativeCaller[] = [];
  for (const c of callersForRoot) {
    const parsed = parseStepLabel(c.id);
    const t = indexes.triggerByStepId.get(c.id);
    callerEntries.push({
      scriptStepId: c.id,
      scriptLabel: parsed?.label ?? c.id,
      triggerId: t?.id ?? null,
      triggerKind: t?.kind ?? null,
      mapId: t?.mapId ?? null,
    });
  }

  return {
    root,
    nodes: Array.from(nodes.values()).sort((a, b) => a.depth - b.depth || a.id.localeCompare(b.id)),
    edges,
    callers: callerEntries,
    truncated,
  };
}
