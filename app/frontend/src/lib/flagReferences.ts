import type {
  DialogueNode,
  ObjectEvent,
  ProjectManifest,
  ScriptStep,
  Trigger,
} from '@rom-editor/shared';

// Phase Q.2 - Cross-reference computation for flags + variables. Pure
// over manifest; safe to memoize. Extracted from FlagsView.tsx so the
// FlagInspector (workspace-dock panel, registered in inspectorPanels/)
// and the legacy FlagsView (still reachable from the Advanced drawer)
// both share the same logic. Phase Q.6's manual-annotation surface
// layers on top of this without changing the reference shapes.

export type FlagOrVarKind = 'flag' | 'variable';

export interface FlagReferences {
  /** Object events whose visibility is gated by this flag (kind=flag only). */
  readonly objectEvents: ReadonlyArray<ObjectEvent>;
  /** Script steps that read / write / branch on this flag or variable. */
  readonly scriptSteps: ReadonlyArray<ScriptStep>;
  /** Triggers whose script chain touches the flag/variable. Deduped by id. */
  readonly triggers: ReadonlyArray<Trigger>;
  /** Dialogue choices that set this flag (kind=flag only). */
  readonly dialogueChoices: ReadonlyArray<{
    readonly node: DialogueNode;
    readonly choiceLabel: string;
  }>;
}

const FLAG_PARAM_KEYS: ReadonlyArray<string> = ['flag', 'condition'];
const VAR_PARAM_KEYS: ReadonlyArray<string> = [
  'variable',
  'dest',
  'source',
  'left',
  'right',
];

function stepReferencesId(
  step: ScriptStep,
  id: string,
  kind: FlagOrVarKind,
): boolean {
  const keys = kind === 'flag' ? FLAG_PARAM_KEYS : VAR_PARAM_KEYS;
  for (const k of keys) {
    const v = step.params[k];
    if (typeof v === 'string' && v === id) return true;
  }
  const args = step.params['args'];
  if (Array.isArray(args)) {
    for (const a of args) {
      if (typeof a === 'string' && a === id) return true;
    }
  }
  return false;
}

export function buildTriggerByStepIdMap(
  manifest: ProjectManifest,
): ReadonlyMap<string, Trigger> {
  const m = new Map<string, Trigger>();
  for (const t of manifest.triggers) {
    for (const sid of t.scriptStepIds) m.set(sid, t);
  }
  return m;
}

export function computeFlagReferences(
  manifest: ProjectManifest,
  kind: FlagOrVarKind,
  id: string,
  triggerByStepId?: ReadonlyMap<string, Trigger>,
): FlagReferences {
  const objectEvents =
    kind === 'flag' ? manifest.objectEvents.filter((o) => o.flagId === id) : [];

  const scriptSteps = manifest.scriptSteps.filter((s) =>
    stepReferencesId(s, id, kind),
  );

  const stepIndex = triggerByStepId ?? buildTriggerByStepIdMap(manifest);
  const triggerIds = new Set<string>();
  const triggers: Trigger[] = [];
  for (const s of scriptSteps) {
    const t = stepIndex.get(s.id);
    if (t && !triggerIds.has(t.id)) {
      triggerIds.add(t.id);
      triggers.push(t);
    }
  }

  const dialogueChoices: Array<{ node: DialogueNode; choiceLabel: string }> = [];
  if (kind === 'flag') {
    for (const node of manifest.dialogue) {
      for (const choice of node.choices) {
        if (choice.setsFlagIds.includes(id)) {
          dialogueChoices.push({ node, choiceLabel: choice.label });
        }
      }
    }
  }

  return { objectEvents, scriptSteps, triggers, dialogueChoices };
}

export function totalFlagReferences(refs: FlagReferences): number {
  return (
    refs.objectEvents.length +
    refs.scriptSteps.length +
    refs.triggers.length +
    refs.dialogueChoices.length
  );
}
