import { useMemo, useState } from 'react';
import type { InspectorPanelProps } from '../lib/inspectorRegistry';
import { displayName } from '../lib/displayName';
import {
  pushToast,
  useProjectStore,
  useSelection,
  useUiPreferencesStore,
} from '../state';
import { editBinaryRomSpeciesFields, ProjectApiError } from '../api';
import type {
  AbilityEntry,
  ProjectManifest,
  SpeciesEntry,
  TypeNameEntry,
} from '@rom-editor/shared';
import './InspectorShared.css';
import './SpeciesInspector.css';

// Phase S.6 - SpeciesInspector. The central per-entity inspector.
// Surfaces base stats, types, abilities, growth rate, catch rate, gender
// ratio, items, AND clickable level-up learnset rows (each move row
// click selects the move → S.10 MoveInspector renders). Types and
// abilities are clickable too (→ S.12 / S.11). The cross-inspector
// click-through graph is now complete for the species-centric loop:
//   species → ability → species (back-ref)
//   species → type    → species (back-ref)
//   species → move    → species (back-ref)
//
// Defers to follow-ups:
//   - Sprite preview (asset import already exists; binding to species
//     requires a graphics index cross-ref that's not in this commit)
//   - Evolutions (a separate species-evolutions detector populates
//     manifest.speciesEvolutions which can hang off this panel later)
//   - Encounter-table + Trainer back-refs (S.7 work)

function findSpecies(
  manifest: ProjectManifest | null,
  selectionId: string,
): SpeciesEntry | null {
  if (!manifest) return null;
  const species = manifest.species ?? [];
  if (species.length === 0) return null;
  const direct = species.find((s) => s.id === selectionId);
  if (direct) return direct;
  const syntheticMatch = /^species_(\d+)$/.exec(selectionId);
  if (syntheticMatch) {
    const idx = Number.parseInt(syntheticMatch[1]!, 10);
    return species.find((s) => s.speciesIndex === idx) ?? null;
  }
  return null;
}

function findType(
  manifest: ProjectManifest,
  typeIdx: number,
): TypeNameEntry | null {
  return (manifest.typeNames ?? []).find((t) => t.typeIndex === typeIdx) ?? null;
}

function findAbility(
  manifest: ProjectManifest,
  abilityIdx: number,
): AbilityEntry | null {
  return (manifest.abilities ?? []).find((a) => a.abilityIndex === abilityIdx) ?? null;
}

const GENDER_RATIO_LABELS: ReadonlyArray<{ value: number; label: string }> = [
  { value: 0, label: '100% male (always male)' },
  { value: 31, label: '87.5% / 12.5% male' },
  { value: 63, label: '75% / 25% male' },
  { value: 127, label: '50/50 male / female' },
  { value: 191, label: '25% / 75% male' },
  { value: 254, label: '0% / 100% (always female)' },
  { value: 255, label: 'Genderless' },
];

function genderRatioLabel(value: number): string {
  // Pick the closest preset; exact values dominant in Gen-3.
  const exact = GENDER_RATIO_LABELS.find((r) => r.value === value);
  if (exact) return exact.label;
  const malePct = ((255 - value) / 255) * 100;
  return `${malePct.toFixed(1)}% male`;
}

/** Section IDs the SpeciesInspector recognises via `selection.expandSection`.
 *  Exported as a const so call sites get compile-time typo safety. */
export const SPECIES_INSPECTOR_SECTIONS = {
  stats: 'stats',
  abilities: 'abilities',
  pokedex: 'pokedex',
  class: 'class',
} as const;

export function SpeciesInspector(props: InspectorPanelProps) {
  // Consolidated dispatch - when the registry routes `ability`,
  // `pokedexEntry`, or `trainerClass` selections here, we render a
  // focused sub-view instead of trying to look up a species.
  if (props.selection.kind === 'ability') {
    return <AbilityCarriersView {...props} />;
  }
  if (props.selection.kind === 'trainerClass') {
    return <TrainerClassMembersView {...props} />;
  }
  if (props.selection.kind === 'pokedexEntry') {
    return <PokedexEntryView {...props} />;
  }
  return <SpeciesInspectorBody {...props} />;
}

function SpeciesInspectorBody({
  selection,
  manifest,
  sessionId,
}: InspectorPanelProps) {
  const showInternalIds = useUiPreferencesStore((s) => s.showInternalIds);
  const select = useSelection((s) => s.select);
  const scanCurrentProject = useProjectStore((s) => s.scanCurrentProject);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [editingStats, setEditingStats] = useState(false);
  const [saving, setSaving] = useState(false);
  const [draft, setDraft] = useState<{
    baseHP: number;
    baseAttack: number;
    baseDefense: number;
    baseSpAttack: number;
    baseSpDefense: number;
    baseSpeed: number;
    type1: number;
    type2: number;
    ability1: number;
    ability2: number;
    catchRate: number;
    expYield: number;
    genderRatio: number;
    eggCycles: number;
    friendship: number;
    growthRate: number;
    item1: number;
    item2: number;
  }>({
    baseHP: 0,
    baseAttack: 0,
    baseDefense: 0,
    baseSpAttack: 0,
    baseSpDefense: 0,
    baseSpeed: 0,
    type1: 0,
    type2: 0,
    ability1: 0,
    ability2: 0,
    catchRate: 0,
    expYield: 0,
    genderRatio: 0,
    eggCycles: 0,
    friendship: 0,
    growthRate: 0,
    item1: 0,
    item2: 0,
  });

  const species = useMemo(
    () => findSpecies(manifest, selection.id),
    [manifest, selection.id],
  );

  function beginEdit() {
    if (!species) return;
    setDraft({
      baseHP: species.baseHP,
      baseAttack: species.baseAttack,
      baseDefense: species.baseDefense,
      baseSpAttack: species.baseSpAttack,
      baseSpDefense: species.baseSpDefense,
      baseSpeed: species.baseSpeed,
      type1: species.type1,
      type2: species.type2,
      ability1: species.ability1,
      ability2: species.ability2,
      catchRate: species.catchRate,
      expYield: species.expYield,
      genderRatio: species.genderRatio,
      eggCycles: species.eggCycles,
      friendship: species.friendship,
      growthRate: species.growthRate,
      item1: species.item1,
      item2: species.item2,
    });
    setEditingStats(true);
  }

  async function commitEdit() {
    if (!species || !sessionId) return;
    setSaving(true);
    try {
      const fields: Record<string, number> = {};
      if (draft.baseHP !== species.baseHP) fields['baseHP'] = draft.baseHP;
      if (draft.baseAttack !== species.baseAttack)
        fields['baseAttack'] = draft.baseAttack;
      if (draft.baseDefense !== species.baseDefense)
        fields['baseDefense'] = draft.baseDefense;
      if (draft.baseSpAttack !== species.baseSpAttack)
        fields['baseSpAttack'] = draft.baseSpAttack;
      if (draft.baseSpDefense !== species.baseSpDefense)
        fields['baseSpDefense'] = draft.baseSpDefense;
      if (draft.baseSpeed !== species.baseSpeed)
        fields['baseSpeed'] = draft.baseSpeed;
      if (draft.type1 !== species.type1) fields['type1'] = draft.type1;
      if (draft.type2 !== species.type2) fields['type2'] = draft.type2;
      if (draft.ability1 !== species.ability1)
        fields['ability1'] = draft.ability1;
      if (draft.ability2 !== species.ability2)
        fields['ability2'] = draft.ability2;
      if (draft.catchRate !== species.catchRate)
        fields['catchRate'] = draft.catchRate;
      if (draft.expYield !== species.expYield)
        fields['expYield'] = draft.expYield;
      if (draft.genderRatio !== species.genderRatio)
        fields['genderRatio'] = draft.genderRatio;
      if (draft.eggCycles !== species.eggCycles)
        fields['eggCycles'] = draft.eggCycles;
      if (draft.friendship !== species.friendship)
        fields['friendship'] = draft.friendship;
      if (draft.growthRate !== species.growthRate)
        fields['growthRate'] = draft.growthRate;
      if (draft.item1 !== species.item1) fields['item1'] = draft.item1;
      if (draft.item2 !== species.item2) fields['item2'] = draft.item2;
      if (Object.keys(fields).length === 0) {
        setEditingStats(false);
        setSaving(false);
        return;
      }
      await editBinaryRomSpeciesFields(sessionId, {
        sourceFileOffset: species.sourceFileOffset,
        fields,
      });
      pushToast('success', `Saved ${Object.keys(fields).length} stat(s)`);
      await scanCurrentProject();
      setEditingStats(false);
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

  if (!manifest) {
    return (
      <div className="entity-inspector entity-inspector--empty" data-testid="species-inspector">
        <p>Open a project to inspect <code>{selection.id}</code>.</p>
      </div>
    );
  }
  if (!species) {
    return (
      <div className="entity-inspector entity-inspector--empty" data-testid="species-inspector">
        <p>
          The selection references <code>{selection.id}</code> but no species
          with that id is present in the scanned manifest. The species_system
          detector either didn't run or this id falls outside the lifted range
          ({(manifest.species ?? []).length} species indexed).
        </p>
      </div>
    );
  }

  const speciesName =
    species.name && species.name.length > 0
      ? species.name
      : displayName(manifest, species.id, showInternalIds);

  const type1 = findType(manifest, species.type1);
  const type2 =
    species.type1 !== species.type2 ? findType(manifest, species.type2) : null;

  const ability1 = findAbility(manifest, species.ability1);
  const ability2 =
    species.ability1 !== species.ability2
      ? findAbility(manifest, species.ability2)
      : null;

  const bst =
    species.baseHP +
    species.baseAttack +
    species.baseDefense +
    species.baseSpeed +
    species.baseSpAttack +
    species.baseSpDefense;

  const learnset = useMemo(() => {
    const ls = (manifest.speciesLearnsets ?? []).find(
      (l) => l.speciesIndex === species.speciesIndex,
    );
    if (!ls) return null;
    return [...ls.moves].sort((a, b) => a.level - b.level);
  }, [manifest.speciesLearnsets, species.speciesIndex]);

  // Phase S.6 follow-up - evolution chain. Walks the manifest
  // speciesEvolutions table to find slots whose source is THIS species.
  const evolutions = useMemo(() => {
    const all = manifest.speciesEvolutions ?? [];
    const ours = all.find((e) => e.speciesIndex === species.speciesIndex);
    return ours?.slots ?? [];
  }, [manifest.speciesEvolutions, species.speciesIndex]);

  return (
    <div className="entity-inspector species-inspector" data-testid="species-inspector">
      <header className="entity-inspector__header">
        <div
          className="entity-inspector__title"
          data-testid="species-inspector-name"
        >
          {speciesName}
        </div>
        <div className="entity-inspector__sub">
          Dex #{species.speciesIndex.toString().padStart(3, '0')}
        </div>
      </header>

      <section className="species-inspector__types" data-testid="species-inspector-types">
        <button
          type="button"
          className="species-inspector__type-chip"
          onClick={() =>
            type1 && select({ kind: 'type', id: type1.id })
          }
          disabled={!type1}
        >
          {type1?.name ?? `Type ${species.type1}`}
        </button>
        {type2 && (
          <button
            type="button"
            className="species-inspector__type-chip"
            onClick={() => select({ kind: 'type', id: type2.id })}
          >
            {type2.name}
          </button>
        )}
      </section>

      {!editingStats ? (
        <section className="species-inspector__stats" data-testid="species-inspector-stats">
          <StatRow label="HP" value={species.baseHP} max={255} />
          <StatRow label="Attack" value={species.baseAttack} max={255} />
          <StatRow label="Defense" value={species.baseDefense} max={255} />
          <StatRow label="Sp. Atk" value={species.baseSpAttack} max={255} />
          <StatRow label="Sp. Def" value={species.baseSpDefense} max={255} />
          <StatRow label="Speed" value={species.baseSpeed} max={255} />
          <div className="species-inspector__bst" data-testid="species-inspector-bst">
            <span className="species-inspector__bst-label">BST</span>
            <span className="species-inspector__bst-value">{bst}</span>
          </div>
          {sessionId && (
            <button
              type="button"
              className="entity-inspector__edit-btn"
              onClick={beginEdit}
              data-testid="species-inspector-edit-stats-btn"
              style={{ marginTop: 8, alignSelf: 'flex-start' }}
            >
              Edit base stats…
            </button>
          )}
        </section>
      ) : (
        <section
          className="entity-inspector__edit-form"
          data-testid="species-inspector-edit-form"
        >
          {([
            ['HP', 'baseHP'],
            ['Attack', 'baseAttack'],
            ['Defense', 'baseDefense'],
            ['Sp. Atk', 'baseSpAttack'],
            ['Sp. Def', 'baseSpDefense'],
            ['Speed', 'baseSpeed'],
            ['Catch rate', 'catchRate'],
          ] as const).map(([label, key]) => (
            <label key={key} className="entity-inspector__num-field">
              <span>{label}</span>
              <input
                type="number"
                min={0}
                max={255}
                value={draft[key]}
                data-testid={`species-inspector-edit-${key}`}
                onChange={(e) => {
                  const n = Number.parseInt(e.target.value, 10);
                  if (Number.isFinite(n))
                    setDraft((d) => ({
                      ...d,
                      [key]: Math.max(0, Math.min(255, n)),
                    }));
                }}
              />
            </label>
          ))}
          {(manifest.typeNames ?? []).length > 0 && (
            <>
              <label className="entity-inspector__num-field">
                <span>Type 1</span>
                <select
                  value={draft.type1}
                  data-testid="species-inspector-edit-type1"
                  onChange={(e) =>
                    setDraft((d) => ({
                      ...d,
                      type1: Number.parseInt(e.target.value, 10),
                    }))
                  }
                >
                  {(manifest.typeNames ?? []).map((t) => (
                    <option key={t.typeIndex} value={t.typeIndex}>
                      {t.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="entity-inspector__num-field">
                <span>Type 2</span>
                <select
                  value={draft.type2}
                  data-testid="species-inspector-edit-type2"
                  onChange={(e) =>
                    setDraft((d) => ({
                      ...d,
                      type2: Number.parseInt(e.target.value, 10),
                    }))
                  }
                >
                  {(manifest.typeNames ?? []).map((t) => (
                    <option key={t.typeIndex} value={t.typeIndex}>
                      {t.name}
                    </option>
                  ))}
                </select>
              </label>
            </>
          )}
          {/* Phase S.6-extended - 6 additional editable struct fields */}
          {([
            ['Exp yield', 'expYield', 0, 255],
            ['Egg cycles', 'eggCycles', 0, 255],
            ['Friendship', 'friendship', 0, 255],
            ['Item 1 idx', 'item1', 0, 65535],
            ['Item 2 idx', 'item2', 0, 65535],
          ] as const).map(([label, key, min, max]) => (
            <label key={key} className="entity-inspector__num-field">
              <span>{label}</span>
              <input
                type="number"
                min={min}
                max={max}
                value={draft[key]}
                data-testid={`species-inspector-edit-${key}`}
                onChange={(e) => {
                  const n = Number.parseInt(e.target.value, 10);
                  if (Number.isFinite(n))
                    setDraft((d) => ({
                      ...d,
                      [key]: Math.max(min, Math.min(max, n)),
                    }));
                }}
              />
            </label>
          ))}
          <label className="entity-inspector__num-field">
            <span>Gender</span>
            <select
              value={draft.genderRatio}
              data-testid="species-inspector-edit-genderRatio"
              onChange={(e) =>
                setDraft((d) => ({
                  ...d,
                  genderRatio: Number.parseInt(e.target.value, 10),
                }))
              }
            >
              <option value="0">100% male</option>
              <option value="31">87.5% male</option>
              <option value="63">75% male</option>
              <option value="127">50/50</option>
              <option value="191">25% male</option>
              <option value="254">0% male (always female)</option>
              <option value="255">Genderless</option>
            </select>
          </label>
          <label className="entity-inspector__num-field">
            <span>Growth rate</span>
            <select
              value={draft.growthRate}
              data-testid="species-inspector-edit-growthRate"
              onChange={(e) =>
                setDraft((d) => ({
                  ...d,
                  growthRate: Number.parseInt(e.target.value, 10),
                }))
              }
            >
              <option value="0">Medium Fast</option>
              <option value="1">Erratic</option>
              <option value="2">Fluctuating</option>
              <option value="3">Medium Slow</option>
              <option value="4">Fast</option>
              <option value="5">Slow</option>
            </select>
          </label>
          {(manifest.abilities ?? []).length > 0 && (
            <>
              <label className="entity-inspector__num-field">
                <span>Ability 1</span>
                <select
                  value={draft.ability1}
                  data-testid="species-inspector-edit-ability1"
                  onChange={(e) =>
                    setDraft((d) => ({
                      ...d,
                      ability1: Number.parseInt(e.target.value, 10),
                    }))
                  }
                >
                  {(manifest.abilities ?? []).map((a) => (
                    <option key={a.abilityIndex} value={a.abilityIndex}>
                      {a.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="entity-inspector__num-field">
                <span>Ability 2</span>
                <select
                  value={draft.ability2}
                  data-testid="species-inspector-edit-ability2"
                  onChange={(e) =>
                    setDraft((d) => ({
                      ...d,
                      ability2: Number.parseInt(e.target.value, 10),
                    }))
                  }
                >
                  {(manifest.abilities ?? []).map((a) => (
                    <option key={a.abilityIndex} value={a.abilityIndex}>
                      {a.name}
                    </option>
                  ))}
                </select>
              </label>
            </>
          )}
          <div className="entity-inspector__edit-actions">
            <button
              type="button"
              className="entity-inspector__save-btn"
              onClick={commitEdit}
              disabled={saving}
              data-testid="species-inspector-save-stats-btn"
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
            <button
              type="button"
              className="entity-inspector__cancel-btn"
              onClick={() => setEditingStats(false)}
              disabled={saving}
              data-testid="species-inspector-cancel-stats-btn"
            >
              Cancel
            </button>
          </div>
          <div
            className="species-inspector__bst"
            data-testid="species-inspector-bst-preview"
            style={{ marginTop: 4 }}
          >
            <span className="species-inspector__bst-label">New BST</span>
            <span className="species-inspector__bst-value">
              {draft.baseHP +
                draft.baseAttack +
                draft.baseDefense +
                draft.baseSpAttack +
                draft.baseSpDefense +
                draft.baseSpeed}
            </span>
          </div>
        </section>
      )}

      <section
        className="species-inspector__abilities"
        data-testid="species-inspector-abilities"
      >
        <h3 className="species-inspector__section-heading">Abilities</h3>
        <div className="species-inspector__ability-row">
          {ability1 ? (
            <button
              type="button"
              className="species-inspector__ability-btn"
              onClick={() => select({ kind: 'ability', id: ability1.id })}
            >
              {ability1.name}
              <span className="species-inspector__ability-slot">slot 1</span>
            </button>
          ) : (
            <span className="species-inspector__ability-empty">
              Slot 1: ability #{species.ability1} (not in manifest)
            </span>
          )}
          {ability2 ? (
            <button
              type="button"
              className="species-inspector__ability-btn"
              onClick={() => select({ kind: 'ability', id: ability2.id })}
            >
              {ability2.name}
              <span className="species-inspector__ability-slot">slot 2</span>
            </button>
          ) : (
            species.ability1 === species.ability2 && (
              <span className="species-inspector__ability-empty">
                (single-ability species)
              </span>
            )
          )}
        </div>
      </section>

      <section
        className="species-inspector__meta"
        data-testid="species-inspector-meta"
      >
        <h3 className="species-inspector__section-heading">Misc</h3>
        <dl className="species-inspector__meta-grid">
          <MetaRow label="Catch rate" value={`${species.catchRate}/255`} />
          <MetaRow label="Exp yield" value={String(species.expYield)} />
          <MetaRow label="Gender" value={genderRatioLabel(species.genderRatio)} />
          <MetaRow label="Egg cycles" value={String(species.eggCycles)} />
          <MetaRow label="Friendship" value={String(species.friendship)} />
          {species.growthRateName && (
            <MetaRow
              label="Growth"
              value={`${species.growthRateName}${
                species.growthRateXpAtLevel100
                  ? ` · ${species.growthRateXpAtLevel100.toLocaleString()} XP to L100`
                  : ''
              }`}
            />
          )}
        </dl>
      </section>

      {evolutions.length > 0 && (
        <section
          className="entity-inspector__refs"
          data-testid="species-inspector-evolutions"
        >
          <h3 className="species-inspector__section-heading">
            Evolutions{' '}
            <span className="entity-inspector__refs-count">
              ({evolutions.length})
            </span>
          </h3>
          <ul className="entity-inspector__refs-list">
            {evolutions.map((slot, i) => (
              <li key={`evo-${slot.targetSpecies}-${i}`}>
                <button
                  type="button"
                  className="entity-inspector__refs-btn"
                  onClick={() =>
                    select({
                      kind: 'species',
                      id: `species_${slot.targetSpecies}`,
                    })
                  }
                  data-testid={`species-inspector-evo-${i}`}
                >
                  <span className="entity-inspector__refs-btn-label">
                    →{' '}
                    {slot.targetSpeciesName ??
                      displayName(
                        manifest,
                        `species_${slot.targetSpecies}`,
                        showInternalIds,
                      )}
                  </span>
                  <span className="entity-inspector__refs-btn-meta">
                    {evolutionMethodLabel(slot.method, slot.param)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {learnset && learnset.length > 0 && (
        <section
          className="species-inspector__learnset"
          data-testid="species-inspector-learnset"
        >
          <h3 className="species-inspector__section-heading">
            Level-up moves{' '}
            <span className="entity-inspector__refs-count">({learnset.length})</span>
          </h3>
          <ul className="entity-inspector__refs-list">
            {learnset.map((m, i) => (
              <li key={`${m.level}-${m.move}-${i}`}>
                <button
                  type="button"
                  className="entity-inspector__refs-btn"
                  onClick={() =>
                    select({ kind: 'move', id: `move_${m.move}` })
                  }
                >
                  <span className="entity-inspector__refs-btn-label">
                    {m.moveName ?? `Move #${m.move}`}
                  </span>
                  <span className="entity-inspector__refs-btn-meta">Lv {m.level}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <button
        type="button"
        className="species-inspector__advanced-toggle"
        onClick={() => setAdvancedOpen((v) => !v)}
        aria-expanded={advancedOpen}
        data-testid="species-inspector-advanced-toggle"
      >
        {advancedOpen ? 'Hide developer details' : 'Show developer details'}
      </button>
      {advancedOpen && (
        <dl
          className="species-inspector__advanced"
          data-testid="species-inspector-advanced"
        >
          <MetaRow label="Species index" value={`#${species.speciesIndex}`} />
          <MetaRow
            label="BaseStats offset"
            value={`0x${species.sourceFileOffset.toString(16)}`}
          />
          <MetaRow label="Raw id" value={species.id} />
        </dl>
      )}
    </div>
  );
}

// Gen-3 EVOLUTION_* method enum. Param semantics vary per method:
//   - EVO_LEVEL: level number
//   - EVO_TRADE_ITEM: held item index
//   - EVO_ITEM: evolution stone item index
//   - EVO_FRIENDSHIP_*: 0 (uses friendship threshold internally)
//   - EVO_LEVEL_ATK_GT_DEF / ATK_LT_DEF / ATK_EQ_DEF: level number
//   - EVO_LEVEL_NINJASK: level number (special branching evolution)
//   - EVO_LEVEL_SILCOON / CASCOON: level + personality LSB constraint
//   - EVO_BEAUTY: beauty threshold (param)
const EVOLUTION_METHOD_LABEL: Record<number, (param: number) => string> = {
  1: (p) => `Friendship · ${p}+`,
  2: () => `Friendship (day)`,
  3: () => `Friendship (night)`,
  4: (p) => `Level ${p}`,
  5: () => 'Trade',
  6: (p) => `Trade holding item #${p}`,
  7: (p) => `Use evolution item #${p}`,
  8: (p) => `Level ${p} (Atk > Def)`,
  9: (p) => `Level ${p} (Atk = Def)`,
  10: (p) => `Level ${p} (Atk < Def)`,
  11: (p) => `Level ${p} (Silcoon)`,
  12: (p) => `Level ${p} (Cascoon)`,
  13: (p) => `Level ${p} (Ninjask)`,
  14: (p) => `Level ${p} (Shedinja spawn)`,
  15: (p) => `Beauty stat ${p}+`,
};

function evolutionMethodLabel(method: number, param: number): string {
  const fn = EVOLUTION_METHOD_LABEL[method];
  if (fn) return fn(param);
  return `Method #${method} (param ${param})`;
}

function StatRow({ label, value, max }: { label: string; value: number; max: number }) {
  const pct = Math.min(100, (value / max) * 100);
  return (
    <div className="species-inspector__stat-row">
      <span className="species-inspector__stat-label">{label}</span>
      <span className="species-inspector__stat-value">{value}</span>
      <span className="species-inspector__stat-bar">
        <span
          className="species-inspector__stat-bar-fill"
          style={{ width: `${pct}%` }}
        />
      </span>
    </div>
  );
}

function MetaRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="species-inspector__meta-row">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

// === Consolidated sub-views (absorbed from deleted inspectors) ============

/** Surfaces "Pokémon with this ability" when the user clicks an ability
 *  reference from anywhere. Replaces the deleted AbilityInspector. */
function AbilityCarriersView({ selection, manifest }: InspectorPanelProps): JSX.Element {
  const showInternalIds = useUiPreferencesStore((s) => s.showInternalIds);
  const select = useSelection((s) => s.select);

  const abilityIdx = useMemo(() => {
    const m = /^ability_(\d+)$/.exec(selection.id);
    if (m) return Number.parseInt(m[1]!, 10);
    return null;
  }, [selection.id]);

  if (!manifest || abilityIdx === null) {
    return (
      <div className="entity-inspector entity-inspector--empty" data-testid="ability-inspector">
        <p>No ability matches this selection.</p>
      </div>
    );
  }

  const ability = manifest.abilities?.find((a) => a.abilityIndex === abilityIdx);
  const carriers = (manifest.species ?? []).filter(
    (s) => s.ability1 === abilityIdx || s.ability2 === abilityIdx,
  );

  return (
    <div className="entity-inspector" data-testid="ability-inspector">
      <header className="entity-inspector__header">
        <div className="entity-inspector__sub">Ability</div>
        <div className="entity-inspector__title" data-testid="ability-inspector-name">
          {ability?.name ?? `Ability #${abilityIdx}`}
        </div>
      </header>
      <section className="entity-inspector__refs" data-testid="ability-inspector-carriers">
        <h3 className="entity-inspector__refs-heading">
          Pokémon with this ability{' '}
          <span className="entity-inspector__refs-count">({carriers.length})</span>
        </h3>
        {carriers.length === 0 ? (
          <p className="entity-inspector__refs-empty">
            No Pokémon in the scanned manifest carry this ability.
          </p>
        ) : (
          <ul className="entity-inspector__refs-list">
            {carriers.slice(0, 60).map((s) => (
              <li key={s.id}>
                <button
                  type="button"
                  className="entity-inspector__refs-btn"
                  onClick={() => select({ kind: 'species', id: s.id, expandSection: 'abilities' })}
                >
                  <span className="entity-inspector__refs-btn-label">
                    {displayName(manifest, s.id, showInternalIds)}
                  </span>
                  <span className="entity-inspector__refs-btn-meta">
                    {s.ability1 === abilityIdx ? 'primary' : 'secondary'}
                  </span>
                </button>
              </li>
            ))}
            {carriers.length > 60 && (
              <li className="entity-inspector__refs-more">+ {carriers.length - 60} more</li>
            )}
          </ul>
        )}
      </section>
    </div>
  );
}

/** Surfaces "Trainers in this class" when the user clicks a trainer-class
 *  reference. Replaces the deleted TrainerClassInspector. */
function TrainerClassMembersView({ selection, manifest }: InspectorPanelProps): JSX.Element {
  const showInternalIds = useUiPreferencesStore((s) => s.showInternalIds);
  const select = useSelection((s) => s.select);

  const classIdx = useMemo(() => {
    const m = /^class_(\d+)$/.exec(selection.id);
    if (m) return Number.parseInt(m[1]!, 10);
    return null;
  }, [selection.id]);

  if (!manifest || classIdx === null) {
    return (
      <div className="entity-inspector entity-inspector--empty" data-testid="trainer-class-inspector">
        <p>No trainer class matches this selection.</p>
      </div>
    );
  }

  const cls = manifest.trainerClassNames?.find((c) => c.classIndex === classIdx);
  const trainers = (manifest.trainers ?? []).filter(
    (t) => t.className === cls?.name,
  );

  return (
    <div className="entity-inspector" data-testid="trainer-class-inspector">
      <header className="entity-inspector__header">
        <div className="entity-inspector__sub">Trainer class</div>
        <div className="entity-inspector__title" data-testid="trainer-class-inspector-name">
          {cls?.name ?? `Class #${classIdx}`}
        </div>
      </header>
      <section className="entity-inspector__refs" data-testid="trainer-class-inspector-members">
        <h3 className="entity-inspector__refs-heading">
          Trainers in this class{' '}
          <span className="entity-inspector__refs-count">({trainers.length})</span>
        </h3>
        {trainers.length === 0 ? (
          <p className="entity-inspector__refs-empty">
            No trainers in the scanned manifest use this class.
          </p>
        ) : (
          <ul className="entity-inspector__refs-list">
            {trainers.slice(0, 60).map((t) => (
              <li key={t.id}>
                <button
                  type="button"
                  className="entity-inspector__refs-btn"
                  onClick={() => select({ kind: 'trainer', id: t.id })}
                >
                  <span className="entity-inspector__refs-btn-label">
                    {displayName(manifest, t.id, showInternalIds)}
                  </span>
                </button>
              </li>
            ))}
            {trainers.length > 60 && (
              <li className="entity-inspector__refs-more">+ {trainers.length - 60} more</li>
            )}
          </ul>
        )}
      </section>
    </div>
  );
}

/** Surfaces the species linked to a Pokédex entry. Replaces the deleted
 *  PokedexInspector. */
function PokedexEntryView({ selection, manifest, sessionId }: InspectorPanelProps): JSX.Element {
  const select = useSelection((s) => s.select);

  const entry = useMemo(() => {
    if (!manifest) return null;
    const list = manifest.pokedexEntries ?? [];
    const direct = list.find((p) => p.id === selection.id);
    if (direct) return direct;
    const m = /^pokedex_(\d+)$/.exec(selection.id);
    if (m) {
      const idx = Number.parseInt(m[1]!, 10);
      return list.find((p) => p.speciesIndex === idx) ?? null;
    }
    return null;
  }, [manifest, selection.id]);

  if (!manifest || !entry) {
    return (
      <div className="entity-inspector entity-inspector--empty" data-testid="pokedex-inspector">
        <p>No Pokédex entry matches this selection.</p>
      </div>
    );
  }

  const species = manifest.species?.find((s) => s.speciesIndex === entry.speciesIndex);
  return (
    <div className="entity-inspector" data-testid="pokedex-inspector">
      <header className="entity-inspector__header">
        <div className="entity-inspector__sub">Pokédex entry</div>
        <div className="entity-inspector__title" data-testid="pokedex-inspector-name">
          {entry.speciesName ?? `Species #${entry.speciesIndex}`}
        </div>
        {entry.category && (
          <div className="entity-inspector__sub">
            <em>The {entry.category} Pokémon</em>
          </div>
        )}
      </header>
      {entry.flavorText && (
        <section className="entity-inspector__refs" data-testid="pokedex-inspector-flavor">
          <h3 className="entity-inspector__refs-heading">Flavor text</h3>
          <p style={{ fontSize: 12.5, lineHeight: 1.5, margin: 0 }}>{entry.flavorText}</p>
        </section>
      )}
      {species && (
        <section className="entity-inspector__refs">
          <button
            type="button"
            className="entity-inspector__edit-btn"
            onClick={() => select({ kind: 'species', id: species.id, expandSection: 'stats' })}
            data-testid="pokedex-inspector-open-species"
          >
            Open full Pokémon details →
          </button>
        </section>
      )}
      {/* sessionId reserved for future inline edit of flavor text */}
      <input type="hidden" data-session-id={sessionId ?? ''} />
    </div>
  );
}
