import { useMemo, useState } from 'react';
import { displayName } from '../lib/displayName';
import { useUiPreferencesStore } from '../state';
import type {
  DialogueNode,
  Flag,
  ObjectEvent,
  ProjectManifest,
  ScriptStep,
  Trigger,
  Variable,
} from '@rom-editor/shared';
import './FlagsView.css';

interface FlagsViewProps {
  readonly manifest: ProjectManifest;
}

type SelectionKind = 'flag' | 'variable';

interface Selection {
  readonly kind: SelectionKind;
  readonly id: string;
}

interface References {
  readonly objectEvents: ReadonlyArray<ObjectEvent>;
  readonly scriptSteps: ReadonlyArray<ScriptStep>;
  readonly triggers: ReadonlyArray<Trigger>;
  readonly dialogueChoices: ReadonlyArray<{ readonly node: DialogueNode; readonly choiceLabel: string }>;
}

export function FlagsView({ manifest }: FlagsViewProps) {
  const [selection, setSelection] = useState<Selection | null>(null);
  const [filter, setFilter] = useState('');
  const showInternalIds = useUiPreferencesStore((s) => s.showInternalIds);

  const flags = manifest.flags;
  const variables = manifest.variables;

  // Pre-build a stepId → trigger map so cross-reference computation stays O(steps + triggers)
  // per selection rather than O(steps × triggers).
  const triggerByStepId = useMemo(() => {
    const m = new Map<string, Trigger>();
    for (const t of manifest.triggers) {
      for (const sid of t.scriptStepIds) m.set(sid, t);
    }
    return m;
  }, [manifest.triggers]);

  const filteredFlags = useMemo(() => filterEntities(flags, filter), [flags, filter]);
  const filteredVariables = useMemo(
    () => filterEntities(variables, filter),
    [variables, filter],
  );

  const selectedEntity = useMemo(() => {
    if (!selection) return null;
    if (selection.kind === 'flag') return flags.find((f) => f.id === selection.id) ?? null;
    return variables.find((v) => v.id === selection.id) ?? null;
  }, [selection, flags, variables]);

  const references = useMemo<References | null>(() => {
    if (!selection || !selectedEntity) return null;
    return computeReferences(manifest, selection, triggerByStepId);
  }, [manifest, selection, selectedEntity, triggerByStepId]);

  if (flags.length === 0 && variables.length === 0) {
    // Phase G-RC9 (semantic-world plan §G.9): for binary-ROM
    // workspaces there's no flag/variable constant registry on disk
    // - the scanner can't infer human-readable flag names without
    // include/constants/flags.h. Surface a clear explanation rather
    // than a generic empty state.
    const isBinaryRom = manifest.binaryRom !== undefined;
    return (
      <div className="flags-view flags-view--empty" data-testid="flags-view-empty">
        <h2>No flags or variables indexed</h2>
        {isBinaryRom ? (
          <p>
            Binary-ROM workspaces don't expose flag constants on disk by
            name. Flags referenced by scripts and NPCs are listed in the
            inspector when you click on the script or object that touches
            them - the editor resolves friendly names (like
            "Defeated Brock") wherever it can. To browse the full named
            flag registry, open the matching decomp project for this ROM.
          </p>
        ) : (
          <p>
            The project's scan didn't produce any <code>Flag</code> or{' '}
            <code>Variable</code> entries. Open a project with{' '}
            <code>include/constants/flags.h</code> +{' '}
            <code>include/constants/vars.h</code> and scan it from the
            Project view.
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="flags-view" data-testid="flags-view">
      <aside className="flags-view__list" aria-label="Flag and variable list">
        <input
          type="search"
          className="flags-view__filter"
          placeholder="Filter by name or engine value…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          spellCheck={false}
          data-testid="flags-view-filter"
        />
        <FlagsGroup
          heading="Flags"
          items={filteredFlags}
          totalCount={flags.length}
          kind="flag"
          manifest={manifest}
          showInternalIds={showInternalIds}
          selectedId={selection?.kind === 'flag' ? selection.id : null}
          onSelect={(id) => setSelection({ kind: 'flag', id })}
        />
        <FlagsGroup
          heading="Variables"
          items={filteredVariables}
          totalCount={variables.length}
          kind="variable"
          manifest={manifest}
          showInternalIds={showInternalIds}
          selectedId={selection?.kind === 'variable' ? selection.id : null}
          onSelect={(id) => setSelection({ kind: 'variable', id })}
        />
      </aside>
      <section className="flags-view__detail">
        {selectedEntity && references && selection ? (
          <EntityDetail
            manifest={manifest}
            entity={selectedEntity}
            kind={selection.kind}
            references={references}
          />
        ) : (
          <div className="flags-view__placeholder" data-testid="flags-view-placeholder">
            <h2>Pick a flag or variable</h2>
            <p>
              {flags.length} flag{flags.length === 1 ? '' : 's'} ·{' '}
              {variables.length} variable{variables.length === 1 ? '' : 's'} indexed.
            </p>
            <p>
              Selection surfaces every event, script step, trigger, and dialogue choice
              that references it - so you can see what a flag controls without grepping
              the source.
            </p>
          </div>
        )}
      </section>
    </div>
  );
}

function filterEntities<T extends Flag | Variable>(
  items: ReadonlyArray<T>,
  filter: string,
): ReadonlyArray<T> {
  const q = filter.trim().toLowerCase();
  if (!q) return items;
  return items.filter(
    (e) =>
      e.id.toLowerCase().includes(q) ||
      e.name.toLowerCase().includes(q) ||
      e.engineValue.toLowerCase().includes(q) ||
      (e.description ?? '').toLowerCase().includes(q),
  );
}

function FlagsGroup({
  heading,
  items,
  totalCount,
  kind,
  manifest,
  showInternalIds,
  selectedId,
  onSelect,
}: {
  heading: string;
  items: ReadonlyArray<Flag | Variable>;
  totalCount: number;
  kind: SelectionKind;
  manifest: ProjectManifest;
  showInternalIds: boolean;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <div className="flags-view__group" data-testid={`flags-view-group-${kind}`}>
      <h3 className="flags-view__group-heading">
        {heading} <span className="flags-view__group-count">({items.length}/{totalCount})</span>
      </h3>
      {items.length === 0 ? (
        <div className="flags-view__empty-msg">
          {totalCount === 0 ? 'None indexed.' : 'No matches.'}
        </div>
      ) : (
        <ul className="flags-view__items">
          {items.map((e) => (
            <li key={e.id}>
              <button
                type="button"
                className={`flags-view__item${e.id === selectedId ? ' flags-view__item--selected' : ''}`}
                data-testid={`flags-view-item-${e.id}`}
                onClick={() => onSelect(e.id)}
              >
                <span className="flags-view__item-id">
                  {/* Phase I.1 - render the resolved name (or "Flag @ 0x800" prettifier)
                      so binary-ROM workspaces don't expose raw `flag_0x800` ids. The
                      entity's `name` field already carries the decomp constant when
                      available; for binary projects the synthetic id flows through
                      displayName's `prettifyHexId` path. */}
                  {e.name && e.name !== e.id
                    ? e.name
                    : displayName(manifest, e.id, showInternalIds)}
                </span>
                <span className="flags-view__item-engine">{e.engineValue}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function EntityDetail({
  manifest,
  entity,
  kind,
  references,
}: {
  manifest: ProjectManifest;
  entity: Flag | Variable;
  kind: SelectionKind;
  references: References;
}) {
  // Phase G-RC6 - resolve referenced entity ids through displayName.
  const showInternalIds = useUiPreferencesStore((s) => s.showInternalIds);
  const totalRefs =
    references.objectEvents.length +
    references.scriptSteps.length +
    references.triggers.length +
    references.dialogueChoices.length;

  return (
    <div className="flags-detail" data-testid="flags-detail">
      <header className="flags-detail__header">
        <h2 className="flags-detail__id" data-testid="flags-detail-id">
          {entity.id}
        </h2>
        <div className="flags-detail__kind-badge" data-testid="flags-detail-kind">
          {kind}
        </div>
      </header>
      <dl className="flags-detail__meta">
        <span style={{ display: 'contents' }}>
          <dt>Engine value</dt>
          <dd data-testid="flags-detail-engine">
            <code>{entity.engineValue}</code>
          </dd>
        </span>
        <span style={{ display: 'contents' }}>
          <dt>Scope</dt>
          <dd>{entity.scope}</dd>
        </span>
        <span style={{ display: 'contents' }}>
          <dt>Default</dt>
          <dd>{kind === 'flag' ? String((entity as Flag).defaultValue) : String((entity as Variable).defaultValue)}</dd>
        </span>
        {entity.description && (
          <span style={{ display: 'contents' }}>
            <dt>Description</dt>
            <dd>{entity.description}</dd>
          </span>
        )}
      </dl>
      <section className="flags-detail__refs" data-testid="flags-detail-refs">
        <h3 className="flags-detail__refs-heading">
          References{' '}
          <span className="flags-detail__refs-count" data-testid="flags-detail-refs-count">
            ({totalRefs})
          </span>
        </h3>
        {totalRefs === 0 ? (
          <div className="flags-detail__no-refs" data-testid="flags-detail-no-refs">
            Not referenced anywhere in the indexed project. This may indicate dead state
 - or that the project uses it only at engine boot time.
          </div>
        ) : (
          <div className="flags-detail__refs-body">
            {references.objectEvents.length > 0 && (
              <RefSection
                heading="Object events (visibility gated by this flag)"
                count={references.objectEvents.length}
                testid="flags-detail-objects"
              >
                {references.objectEvents.map((o) => (
                  <li key={o.id} className="flags-detail__ref-row">
                    <span className="flags-detail__ref-id">{displayName(manifest, o.id, showInternalIds)}</span>
                    <span className="flags-detail__ref-meta">
                      {o.kind} on {o.mapId} @ ({o.coord.x}, {o.coord.y})
                    </span>
                  </li>
                ))}
              </RefSection>
            )}
            {references.scriptSteps.length > 0 && (
              <RefSection
                heading={kind === 'flag' ? 'Script steps that set / clear / branch on this flag' : 'Script steps that set / read this variable'}
                count={references.scriptSteps.length}
                testid="flags-detail-steps"
              >
                {references.scriptSteps.map((s) => (
                  <li key={s.id} className="flags-detail__ref-row">
                    <span className="flags-detail__ref-id">{displayName(manifest, s.id, showInternalIds)}</span>
                    <span className="flags-detail__ref-meta">
                      <span className="flags-detail__ref-kind">{s.kind}</span>{' '}
                      <code>{stepMacro(s)}</code>
                    </span>
                  </li>
                ))}
              </RefSection>
            )}
            {references.triggers.length > 0 && (
              <RefSection
                heading="Triggers whose chain references this"
                count={references.triggers.length}
                testid="flags-detail-triggers"
              >
                {references.triggers.map((t) => (
                  <li key={t.id} className="flags-detail__ref-row">
                    <span className="flags-detail__ref-id">{displayName(manifest, t.id, showInternalIds)}</span>
                    <span className="flags-detail__ref-meta">
                      {t.kind}
                      {t.mapId && ` on ${t.mapId}`}
                      {t.coord && ` @ (${t.coord.x}, ${t.coord.y})`}
                    </span>
                  </li>
                ))}
              </RefSection>
            )}
            {references.dialogueChoices.length > 0 && (
              <RefSection
                heading="Dialogue choices that set this flag"
                count={references.dialogueChoices.length}
                testid="flags-detail-dialogue"
              >
                {references.dialogueChoices.map((c, i) => (
                  <li key={`${c.node.id}#${i}`} className="flags-detail__ref-row">
                    <span className="flags-detail__ref-id">{displayName(manifest, c.node.id, showInternalIds)}</span>
                    <span className="flags-detail__ref-meta">
                      choice: <em>{c.choiceLabel}</em>
                    </span>
                  </li>
                ))}
              </RefSection>
            )}
          </div>
        )}
      </section>
    </div>
  );
}

function RefSection({
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
    <div className="flags-detail__ref-section" data-testid={testid}>
      <h4 className="flags-detail__ref-section-heading">
        {heading} <span className="flags-detail__ref-section-count">({count})</span>
      </h4>
      <ul className="flags-detail__ref-list">{children}</ul>
    </div>
  );
}

function stepMacro(s: ScriptStep): string {
  const macro = typeof s.params['macro'] === 'string' ? s.params['macro'] : s.kind;
  const args = Array.isArray(s.params['args'])
    ? (s.params['args'] as ReadonlyArray<unknown>).join(', ')
    : '';
  return args ? `${macro} ${args}` : macro;
}

const FLAG_PARAM_KEYS: ReadonlyArray<string> = ['flag', 'condition'];
const VAR_PARAM_KEYS: ReadonlyArray<string> = ['variable', 'dest', 'source', 'left', 'right'];

function stepReferencesId(step: ScriptStep, id: string, kind: SelectionKind): boolean {
  const keys = kind === 'flag' ? FLAG_PARAM_KEYS : VAR_PARAM_KEYS;
  for (const k of keys) {
    const v = step.params[k];
    if (typeof v === 'string' && v === id) return true;
  }
  // Some macros store the identifier inside their `args` array verbatim
  // (e.g. compare VAR_FOO, 1). Check args[] for an exact-token match as a
  // fallback so we don't miss references where buildParams() didn't split.
  const args = step.params['args'];
  if (Array.isArray(args)) {
    for (const a of args) {
      if (typeof a === 'string' && a === id) return true;
    }
  }
  return false;
}

function computeReferences(
  manifest: ProjectManifest,
  selection: Selection,
  triggerByStepId: ReadonlyMap<string, Trigger>,
): References {
  const id = selection.id;
  const objectEvents =
    selection.kind === 'flag'
      ? manifest.objectEvents.filter((o) => o.flagId === id)
      : [];

  const scriptSteps = manifest.scriptSteps.filter((s) =>
    stepReferencesId(s, id, selection.kind),
  );

  // Dedup triggers by id (a trigger that references the flag in two steps still counts once).
  const triggerIds = new Set<string>();
  const triggers: Trigger[] = [];
  for (const s of scriptSteps) {
    const t = triggerByStepId.get(s.id);
    if (t && !triggerIds.has(t.id)) {
      triggerIds.add(t.id);
      triggers.push(t);
    }
  }

  const dialogueChoices: Array<{ node: DialogueNode; choiceLabel: string }> = [];
  if (selection.kind === 'flag') {
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
