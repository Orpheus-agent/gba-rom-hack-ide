import { useMemo, useState } from 'react';
import type { InspectorPanelProps } from '../lib/inspectorRegistry';
import { displayName } from '../lib/displayName';
import { useSelection, useUiPreferencesStore } from '../state';
import {
  buildTriggerByStepIdMap,
  computeFlagReferences,
  totalFlagReferences,
  type FlagOrVarKind,
  type FlagReferences,
} from '../lib/flagReferences';
import './FlagInspector.css';

/** Turn the engine enum into something a non-engineer can read. */
function prettifyScope(scope: string): string {
  switch (scope) {
    case 'global':
      return 'Persistent - saved to the save file';
    case 'map_local':
      return 'Map-local - resets when leaving the map';
    case 'temporary':
      return 'Temporary - cleared when scene unloads';
    default:
      return scope;
  }
}

/** Build a top-of-panel "What this flag does" summary from the cross-
 *  reference counts. The user lands on a flag and immediately sees
 *  "set by 2 scripts, checked by 3 NPCs" instead of having to scan a
 *  long list of references to figure out the story role. */
function summarizeFlagRole(
  refs: FlagReferences,
  kind: FlagOrVarKind,
): { readonly headline: string; readonly chips: ReadonlyArray<string> } {
  const chips: string[] = [];
  const setCount = refs.scriptSteps.filter((s) => s.kind === 'set_flag').length;
  const clearCount = refs.scriptSteps.filter((s) => s.kind === 'clear_flag').length;
  const varSetCount = refs.scriptSteps.filter((s) => s.kind === 'set_variable').length;
  const branchCount = refs.scriptSteps.filter((s) => s.kind === 'branch').length;
  const npcCount = refs.objectEvents.length;
  const triggerCount = refs.triggers.length;
  const dialogueChoiceCount = refs.dialogueChoices.length;

  if (kind === 'flag') {
    if (setCount > 0)
      chips.push(`set by ${String(setCount)} script step${setCount === 1 ? '' : 's'}`);
    if (clearCount > 0)
      chips.push(`reset by ${String(clearCount)} script step${clearCount === 1 ? '' : 's'}`);
    if (branchCount > 0)
      chips.push(`checked in ${String(branchCount)} branch${branchCount === 1 ? '' : 'es'}`);
    if (npcCount > 0)
      chips.push(`gates ${String(npcCount)} NPC${npcCount === 1 ? '' : 's'}`);
    if (triggerCount > 0)
      chips.push(`affects ${String(triggerCount)} trigger${triggerCount === 1 ? '' : 's'}`);
    if (dialogueChoiceCount > 0)
      chips.push(
        `set by ${String(dialogueChoiceCount)} dialogue choice${dialogueChoiceCount === 1 ? '' : 's'}`,
      );
  } else {
    if (varSetCount > 0)
      chips.push(`written by ${String(varSetCount)} script step${varSetCount === 1 ? '' : 's'}`);
    if (branchCount > 0)
      chips.push(`compared in ${String(branchCount)} branch${branchCount === 1 ? '' : 'es'}`);
    if (npcCount > 0) chips.push(`read by ${String(npcCount)} NPC${npcCount === 1 ? '' : 's'}`);
    if (triggerCount > 0)
      chips.push(`affects ${String(triggerCount)} trigger${triggerCount === 1 ? '' : 's'}`);
  }

  if (chips.length === 0) {
    return {
      headline:
        kind === 'flag'
          ? 'Nothing in the indexed project touches this flag.'
          : 'Nothing in the indexed project reads or writes this variable.',
      chips: [],
    };
  }
  return {
    headline:
      kind === 'flag'
        ? 'This flag is part of the story state. It is:'
        : 'This variable is part of the story state. It is:',
    chips,
  };
}

// Phase P.3 - Sample registered inspector. Picked `flag` because flags
// are universal (every script gates on them, every trigger checks them,
// every NPC visibility flips on them) and the manifest already carries
// Flag.name + scope + engineValue + defaultValue + description without
// extra detector work - Phase Q.2 will progressively enrich the metadata
// (script-flow inference, manual annotation) but the baseline data is
// already available today.

export function FlagInspector({ selection, manifest }: InspectorPanelProps) {
  const showInternalIds = useUiPreferencesStore((s) => s.showInternalIds);
  const [advancedOpen, setAdvancedOpen] = useState(false);

  if (!manifest) {
    return (
      <div className="flag-inspector flag-inspector--no-manifest" data-testid="flag-inspector">
        <p>Open a project to inspect <code>{selection.id}</code>.</p>
      </div>
    );
  }

  const flag = manifest.flags.find((f) => f.id === selection.id);
  const variable = !flag ? manifest.variables.find((v) => v.id === selection.id) : null;

  if (!flag && !variable) {
    return (
      <div className="flag-inspector flag-inspector--unknown" data-testid="flag-inspector">
        <p>
          The selection references <code>{selection.id}</code> but no flag or variable with
          that id is present in the scanned manifest. This usually means the flag is
          referenced by a script but not declared in <code>include/constants/flags.h</code>
 - common on binary-ROM workspaces. Phase Q.2 will infer a semantic name from
          script context for cases like this.
        </p>
      </div>
    );
  }

  const entity = flag ?? variable!;
  const kindLabel: FlagOrVarKind = flag ? 'flag' : 'variable';
  const resolvedName =
    entity.name && entity.name !== entity.id
      ? entity.name
      : displayName(manifest, entity.id, showInternalIds);

  // Compute the same refs used by FlagReferencesPanel once here so the
  // top-of-panel role summary can describe what the flag does without
  // the user having to scan the long list below.
  const triggerByStepId = buildTriggerByStepIdMap(manifest);
  const refs = computeFlagReferences(manifest, kindLabel, entity.id, triggerByStepId);
  const roleSummary = summarizeFlagRole(refs, kindLabel);

  return (
    <div className="flag-inspector" data-testid="flag-inspector">
      {/* Phase Q.6.1 - Role summary chips. Lands the user on the
          answer ("set by 2 scripts, gates 1 NPC") before the long
          reference list. Empty list = explicit "nothing touches this"
          message so the user knows the flag is dead/unused. */}
      <section
        className="flag-inspector__role"
        data-testid="flag-inspector-role"
      >
        <p className="flag-inspector__role-headline">{roleSummary.headline}</p>
        {roleSummary.chips.length > 0 && (
          <ul
            className="flag-inspector__role-chips"
            data-testid="flag-inspector-role-chips"
          >
            {roleSummary.chips.map((chip) => (
              <li key={chip} className="flag-inspector__role-chip">
                {chip}
              </li>
            ))}
          </ul>
        )}
      </section>
      <dl className="flag-inspector__meta">
        <div className="flag-inspector__row">
          <dt>Name</dt>
          <dd data-testid="flag-inspector-name">{resolvedName}</dd>
        </div>
        <div className="flag-inspector__row">
          <dt>{kindLabel === 'flag' ? 'Initially' : 'Default value'}</dt>
          <dd data-testid="flag-inspector-default">
            {kindLabel === 'flag'
              ? entity.defaultValue
                ? 'Set (on at new game)'
                : 'Cleared (off at new game)'
              : String(entity.defaultValue)}
          </dd>
        </div>
        <div className="flag-inspector__row">
          <dt>Scope</dt>
          <dd data-testid="flag-inspector-scope">{prettifyScope(entity.scope)}</dd>
        </div>
        {entity.description && (
          <div className="flag-inspector__row">
            <dt>Description</dt>
            <dd data-testid="flag-inspector-description">{entity.description}</dd>
          </div>
        )}
      </dl>

      <FlagReferencesPanel manifest={manifest} kind={kindLabel} id={entity.id} />

      <button
        type="button"
        className="flag-inspector__advanced-toggle"
        onClick={() => setAdvancedOpen((v) => !v)}
        aria-expanded={advancedOpen}
        data-testid="flag-inspector-advanced-toggle"
      >
        {advancedOpen ? 'Hide developer details' : 'Show developer details'}
      </button>
      {advancedOpen && (
        <dl
          className="flag-inspector__advanced"
          data-testid="flag-inspector-advanced"
        >
          <div className="flag-inspector__row">
            <dt>Raw id</dt>
            <dd>
              <code>{entity.id}</code>
            </dd>
          </div>
          <div className="flag-inspector__row">
            <dt>Engine value</dt>
            <dd>
              <code>{entity.engineValue}</code>
            </dd>
          </div>
        </dl>
      )}
    </div>
  );
}

// Phase Q.2 - Cross-reference rows. Every reference is a click-through
// that selects the target via useSelection, so the user can walk the
// graph "flag → triggers that gate on it → trigger's NPC → that NPC's
// dialogue" without ever opening a separate page. Each row uses
// displayName() so the reference labels are themselves semantic
// (e.g., "Professor Oak Intro Speech" not "script_0x08123456").
function FlagReferencesPanel({
  manifest,
  kind,
  id,
}: {
  manifest: NonNullable<InspectorPanelProps['manifest']>;
  kind: FlagOrVarKind;
  id: string;
}) {
  const showInternalIds = useUiPreferencesStore((s) => s.showInternalIds);
  const select = useSelection((s) => s.select);

  const triggerByStepId = useMemo(
    () => buildTriggerByStepIdMap(manifest),
    [manifest],
  );
  const refs = useMemo(
    () => computeFlagReferences(manifest, kind, id, triggerByStepId),
    [manifest, kind, id, triggerByStepId],
  );
  const total = totalFlagReferences(refs);

  if (total === 0) {
    return (
      <section
        className="flag-inspector__refs flag-inspector__refs--empty"
        data-testid="flag-inspector-refs"
      >
        <h3 className="flag-inspector__refs-heading">
          References <span className="flag-inspector__refs-count">(0)</span>
        </h3>
        <p className="flag-inspector__refs-empty">
          Not referenced anywhere in the indexed project. This may indicate
          dead state - or that the engine only touches it at boot time.
        </p>
      </section>
    );
  }

  return (
    <section className="flag-inspector__refs" data-testid="flag-inspector-refs">
      <h3 className="flag-inspector__refs-heading">
        References{' '}
        <span
          className="flag-inspector__refs-count"
          data-testid="flag-inspector-refs-count"
        >
          ({total})
        </span>
      </h3>

      {refs.triggers.length > 0 && (
        <FlagRefGroup
          heading="Triggers"
          count={refs.triggers.length}
          testid="flag-inspector-refs-triggers"
        >
          {refs.triggers.map((t) => (
            <FlagRefButton
              key={t.id}
              label={displayName(manifest, t.id, showInternalIds)}
              meta={`${t.kind}${t.mapId ? ` · ${displayName(manifest, t.mapId, showInternalIds)}` : ''}`}
              onClick={() =>
                select({
                  kind: 'trigger',
                  id: t.id,
                  mapContext: t.mapId ?? undefined,
                })
              }
            />
          ))}
        </FlagRefGroup>
      )}

      {refs.objectEvents.length > 0 && (
        <FlagRefGroup
          heading="NPCs gated on this"
          count={refs.objectEvents.length}
          testid="flag-inspector-refs-objects"
        >
          {refs.objectEvents.map((o) => (
            <FlagRefButton
              key={o.id}
              label={displayName(manifest, o.id, showInternalIds)}
              meta={`${o.kind} on ${displayName(manifest, o.mapId, showInternalIds)} @ (${o.coord.x}, ${o.coord.y})`}
              onClick={() =>
                select({
                  kind: 'objectEvent',
                  id: o.id,
                  mapContext: o.mapId,
                })
              }
            />
          ))}
        </FlagRefGroup>
      )}

      {refs.scriptSteps.length > 0 && (
        <FlagRefGroup
          heading={
            kind === 'flag'
              ? 'Script steps (set / clear / branch)'
              : 'Script steps (set / read)'
          }
          count={refs.scriptSteps.length}
          testid="flag-inspector-refs-steps"
        >
          {refs.scriptSteps.map((s) => (
            <FlagRefButton
              key={s.id}
              label={displayName(manifest, s.id, showInternalIds)}
              meta={s.kind}
              onClick={() => select({ kind: 'scriptStep', id: s.id })}
            />
          ))}
        </FlagRefGroup>
      )}

      {refs.dialogueChoices.length > 0 && (
        <FlagRefGroup
          heading="Dialogue choices that set this"
          count={refs.dialogueChoices.length}
          testid="flag-inspector-refs-dialogue"
        >
          {refs.dialogueChoices.map((c, i) => (
            <FlagRefButton
              key={`${c.node.id}#${i}`}
              label={displayName(manifest, c.node.id, showInternalIds)}
              meta={`choice: ${c.choiceLabel}`}
              onClick={() => select({ kind: 'dialogue', id: c.node.id })}
            />
          ))}
        </FlagRefGroup>
      )}
    </section>
  );
}

function FlagRefGroup({
  heading,
  count,
  testid,
  children,
}: {
  heading: string;
  count: number;
  testid: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flag-inspector__refs-group" data-testid={testid}>
      <h4 className="flag-inspector__refs-group-heading">
        {heading}{' '}
        <span className="flag-inspector__refs-group-count">({count})</span>
      </h4>
      <ul className="flag-inspector__refs-list">{children}</ul>
    </div>
  );
}

function FlagRefButton({
  label,
  meta,
  onClick,
}: {
  label: string;
  meta: string;
  onClick: () => void;
}) {
  return (
    <li className="flag-inspector__refs-item">
      <button
        type="button"
        className="flag-inspector__refs-btn"
        onClick={onClick}
      >
        <span className="flag-inspector__refs-btn-label">{label}</span>
        <span className="flag-inspector__refs-btn-meta">{meta}</span>
      </button>
    </li>
  );
}
