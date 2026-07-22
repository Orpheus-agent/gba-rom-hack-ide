import { useMemo, useState } from 'react';
import type { InspectorPanelProps } from '../lib/inspectorRegistry';
import { displayName } from '../lib/displayName';
import {
  pushToast,
  useProjectStore,
  useSelection,
  useUiPreferencesStore,
} from '../state';
import { editBinaryRomTypeMatchup, ProjectApiError } from '../api';
import type {
  ProjectManifest,
  TypeMatchupEntry,
  TypeNameEntry,
} from '@rom-editor/shared';
import './InspectorShared.css';
import './TypeInspector.css';

// Phase S.12 - TypeInspector. Shows the type's name, the effectiveness
// chart (what it's strong/weak/no-effect against as an attacker AND as
// a defender), and back-references to species that carry it.
//
// Effectiveness multiplier encoding (Gen-3): 20 = 2× super-effective,
// 10 = 1× neutral (not stored as explicit entries - assumed unless
// otherwise listed), 5 = 0.5× resistance, 0 = 0× immune.

function findType(
  manifest: ProjectManifest | null,
  selectionId: string,
): TypeNameEntry | null {
  if (!manifest) return null;
  const types = manifest.typeNames ?? [];
  if (types.length === 0) return null;
  const direct = types.find((t) => t.id === selectionId);
  if (direct) return direct;
  const syntheticMatch = /^type_(\d+)$/.exec(selectionId);
  if (syntheticMatch) {
    const idx = Number.parseInt(syntheticMatch[1]!, 10);
    return types.find((t) => t.typeIndex === idx) ?? null;
  }
  return null;
}

function nameOfType(
  manifest: ProjectManifest,
  typeIdx: number,
): string {
  const t = (manifest.typeNames ?? []).find((x) => x.typeIndex === typeIdx);
  return t?.name ?? `Type ${typeIdx}`;
}

interface MatchupGroup {
  readonly multiplier: number;
  readonly label: string;
  readonly cssClass: string;
  readonly entries: ReadonlyArray<TypeMatchupEntry>;
}

function groupMatchups(
  entries: ReadonlyArray<TypeMatchupEntry>,
  axis: 'attacker' | 'defender',
  typeIdx: number,
): ReadonlyArray<MatchupGroup> {
  const buckets: Record<number, TypeMatchupEntry[]> = {};
  for (const e of entries) {
    if (axis === 'attacker' && e.attackerType !== typeIdx) continue;
    if (axis === 'defender' && e.defenderType !== typeIdx) continue;
    const bucket = e.effectiveness;
    (buckets[bucket] = buckets[bucket] ?? []).push(e);
  }
  const groups: MatchupGroup[] = [];
  if ((buckets[20] ?? []).length > 0) {
    groups.push({
      multiplier: 20,
      label: axis === 'attacker' ? 'Super-effective vs' : 'Weak to',
      cssClass: 'type-inspector__group--strong',
      entries: buckets[20]!,
    });
  }
  if ((buckets[5] ?? []).length > 0) {
    groups.push({
      multiplier: 5,
      label: axis === 'attacker' ? 'Resisted by' : 'Resists',
      cssClass: 'type-inspector__group--resisted',
      entries: buckets[5]!,
    });
  }
  if ((buckets[0] ?? []).length > 0) {
    groups.push({
      multiplier: 0,
      label: axis === 'attacker' ? 'No effect against' : 'Immune to',
      cssClass: 'type-inspector__group--immune',
      entries: buckets[0]!,
    });
  }
  return groups;
}

export function TypeInspector({
  selection,
  manifest,
  sessionId,
}: InspectorPanelProps) {
  const showInternalIds = useUiPreferencesStore((s) => s.showInternalIds);
  const select = useSelection((s) => s.select);

  const type = useMemo(
    () => findType(manifest, selection.id),
    [manifest, selection.id],
  );

  if (!manifest) {
    return (
      <div className="entity-inspector entity-inspector--empty" data-testid="type-inspector">
        <p>Open a project to inspect <code>{selection.id}</code>.</p>
      </div>
    );
  }
  if (!type) {
    return (
      <div className="entity-inspector entity-inspector--empty" data-testid="type-inspector">
        <p>
          The selection references <code>{selection.id}</code> but no type
          with that id is present in the scanned manifest. The
          type_chart_system detector either didn't run or this id falls
          outside the lifted range ({(manifest.typeNames ?? []).length} types
          indexed).
        </p>
      </div>
    );
  }

  const matchups = manifest.typeMatchups ?? [];
  const asAttacker = useMemo(
    () => groupMatchups(matchups, 'attacker', type.typeIndex),
    [matchups, type.typeIndex],
  );
  const asDefender = useMemo(
    () => groupMatchups(matchups, 'defender', type.typeIndex),
    [matchups, type.typeIndex],
  );

  // Species that have this as type1 or type2 (counting dual-type once).
  const carriers = useMemo(() => {
    const species = manifest.species ?? [];
    const out: Array<{ id: string; slot: 1 | 2 }> = [];
    for (const s of species) {
      if (s.type1 === type.typeIndex) out.push({ id: s.id, slot: 1 });
      else if (s.type2 === type.typeIndex && s.type2 !== s.type1)
        out.push({ id: s.id, slot: 2 });
    }
    return out;
  }, [manifest.species, type.typeIndex]);

  return (
    <div className="entity-inspector" data-testid="type-inspector">
      <header className="entity-inspector__header">
        <div className="entity-inspector__title" data-testid="type-inspector-name">
          {type.name}
        </div>
        <div className="entity-inspector__sub">Type #{type.typeIndex}</div>
      </header>

      <section className="type-inspector__axis" data-testid="type-inspector-as-attacker">
        <h3 className="type-inspector__axis-heading">As attacker</h3>
        {asAttacker.length === 0 ? (
          <p className="entity-inspector__refs-empty">
            Neutral against every type (no super-effective, resistance, or
            immunity entries in gTypeEffectiveness for this attacker type).
          </p>
        ) : (
          asAttacker.map((g) => (
            <MatchupBlock key={g.multiplier} group={g} axis="defender" manifest={manifest} />
          ))
        )}
      </section>

      <section className="type-inspector__axis" data-testid="type-inspector-as-defender">
        <h3 className="type-inspector__axis-heading">As defender</h3>
        {asDefender.length === 0 ? (
          <p className="entity-inspector__refs-empty">
            Neutral against every attacker (no entries in
            gTypeEffectiveness where this is the defender).
          </p>
        ) : (
          asDefender.map((g) => (
            <MatchupBlock key={g.multiplier} group={g} axis="attacker" manifest={manifest} />
          ))
        )}
      </section>

      {sessionId && <TypeMatchupEdit type={type} manifest={manifest} sessionId={sessionId} />}

      <section
        className="entity-inspector__refs"
        data-testid="type-inspector-carriers"
      >
        <h3 className="entity-inspector__refs-heading">
          Species with this type{' '}
          <span className="entity-inspector__refs-count">({carriers.length})</span>
        </h3>
        {carriers.length === 0 ? (
          <p className="entity-inspector__refs-empty">
            No species in the lifted manifest carry this type.
          </p>
        ) : (
          <ul className="entity-inspector__refs-list">
            {carriers.slice(0, 30).map((c, i) => (
              <li key={`${c.id}-${c.slot}-${i}`}>
                <button
                  type="button"
                  className="entity-inspector__refs-btn"
                  onClick={() => select({ kind: 'species', id: c.id })}
                >
                  <span className="entity-inspector__refs-btn-label">
                    {displayName(manifest, c.id, showInternalIds)}
                  </span>
                  <span className="entity-inspector__refs-btn-meta">slot {c.slot}</span>
                </button>
              </li>
            ))}
            {carriers.length > 30 && (
              <li className="entity-inspector__refs-more">
                + {carriers.length - 30} more
              </li>
            )}
          </ul>
        )}
      </section>
    </div>
  );
}

function MatchupBlock({
  group,
  axis,
  manifest,
}: {
  group: MatchupGroup;
  axis: 'attacker' | 'defender';
  manifest: ProjectManifest;
}) {
  return (
    <div
      className={`type-inspector__group ${group.cssClass}`}
      data-testid={`type-inspector-group-${group.multiplier}`}
    >
      <span className="type-inspector__group-label">{group.label}</span>
      <span className="type-inspector__group-types">
        {group.entries.map((e, i) => {
          const otherType = axis === 'attacker' ? e.attackerType : e.defenderType;
          return (
            <span key={i} className="type-inspector__group-chip">
              {nameOfType(manifest, otherType)}
            </span>
          );
        })}
      </span>
    </div>
  );
}

// Type matchup editor - adjusts a single attacker→defender effectiveness
// row. Rendered below the read view so the user picks an existing
// matchup and modifies its multiplier.
export function TypeMatchupEdit({
  type,
  manifest,
  sessionId,
}: {
  type: TypeNameEntry;
  manifest: ProjectManifest;
  sessionId: string;
}) {
  const scanCurrentProject = useProjectStore((s) => s.scanCurrentProject);
  const matchups = (manifest.typeMatchups ?? []).filter(
    (m) => m.attackerType === type.typeIndex || m.defenderType === type.typeIndex,
  );
  const editable = matchups.filter((m) => m.entryFileOffset != null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draftEff, setDraftEff] = useState(10);
  const [saving, setSaving] = useState(false);

  if (editable.length === 0) return null;

  const selected = selectedId
    ? editable.find((m) => m.id === selectedId) ?? null
    : null;

  async function commit() {
    if (!selected || selected.entryFileOffset == null) return;
    if (draftEff === selected.effectiveness) {
      setSelectedId(null);
      return;
    }
    setSaving(true);
    try {
      await editBinaryRomTypeMatchup(sessionId, {
        entryFileOffset: selected.entryFileOffset,
        fields: { effectiveness: draftEff },
      });
      pushToast('success', 'Type matchup saved');
      await scanCurrentProject();
      setSelectedId(null);
    } catch (err) {
      const msg =
        err instanceof ProjectApiError
          ? `${err.code}: ${err.message}`
          : err instanceof Error
            ? err.message
            : String(err);
      pushToast('error', `Save failed: ${msg}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <section
      className="entity-inspector__refs"
      data-testid="type-inspector-edit"
      style={{ marginTop: 12 }}
    >
      <h3 className="entity-inspector__refs-heading">Edit a matchup</h3>
      <label className="entity-inspector__num-field">
        <span>Matchup</span>
        <select
          value={selectedId ?? ''}
          data-testid="type-inspector-edit-pick"
          onChange={(e) => {
            const id = e.target.value;
            if (!id) {
              setSelectedId(null);
              return;
            }
            const m = editable.find((x) => x.id === id);
            if (m) {
              setSelectedId(id);
              setDraftEff(m.effectiveness);
            }
          }}
        >
          <option value="">Pick a matchup…</option>
          {editable.map((m) => (
            <option key={m.id} value={m.id}>
              {nameOfType(manifest, m.attackerType)} → {nameOfType(manifest, m.defenderType)}{' '}
              ({effLabel(m.effectiveness)})
            </option>
          ))}
        </select>
      </label>
      {selected && (
        <>
          <label className="entity-inspector__num-field">
            <span>Multiplier</span>
            <select
              value={draftEff}
              data-testid="type-inspector-edit-effectiveness"
              onChange={(e) =>
                setDraftEff(Number.parseInt(e.target.value, 10))
              }
            >
              <option value="0">0× (no effect)</option>
              <option value="5">0.5× (resists)</option>
              <option value="10">1× (neutral)</option>
              <option value="20">2× (super-effective)</option>
            </select>
          </label>
          <div className="entity-inspector__edit-actions">
            <button
              type="button"
              className="entity-inspector__save-btn"
              onClick={commit}
              disabled={saving}
              data-testid="type-inspector-edit-save"
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
            <button
              type="button"
              className="entity-inspector__cancel-btn"
              onClick={() => setSelectedId(null)}
              disabled={saving}
              data-testid="type-inspector-edit-cancel"
            >
              Cancel
            </button>
          </div>
        </>
      )}
    </section>
  );
}

function effLabel(eff: number): string {
  if (eff === 0) return '0× immune';
  if (eff === 5) return '0.5×';
  if (eff === 10) return '1×';
  if (eff === 20) return '2×';
  return `${eff / 10}×`;
}
