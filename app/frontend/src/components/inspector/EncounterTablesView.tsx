import { useEffect, useMemo, useState } from 'react';
import type { EncounterSlot, EncounterTable, ProjectManifest } from '@rom-editor/shared';
import { displayName, lookupEncounterSlotSpecies } from '../../lib/displayName';
import { EntityPicker } from '../EntityPicker';
import { pushToast, useProjectStore, useUiPreferencesStore } from '../../state';
import { editBinaryRomEncounterSlot, ProjectApiError } from '../../api';
import { useEditFormKeyboard } from '../../lib/useEditFormKeyboard';

/**
 * Phase J.5 - Wild encounter table preview for the current map.
 *
 * Reads manifest.encounterTables filtered by mapId, groups by type
 * (grass / water / fishing / cave), and renders each slot's
 * species + level range + weight. Read-only this commit - editing
 * encounter slots requires a WildPokemonInfo struct writer + slot
 * file offsets on each EncounterTable (the lifter doesn't stash
 * them yet). The viewer surfaces what the engine already detected
 * so operators can SEE which species spawn where without leaving
 * the map.
 */

interface EncounterTablesViewProps {
  readonly mapId: string;
  readonly manifest: ProjectManifest;
}

const TYPE_LABEL: Record<string, string> = {
  grass: 'Grass (land)',
  water: 'Water (surfing)',
  fishing: 'Fishing',
  cave: 'Cave',
  rock_smash: 'Rock smash',
  custom: 'Custom',
};

export function EncounterTablesView({ mapId, manifest }: EncounterTablesViewProps) {
  const showInternalIds = useUiPreferencesStore((s) => s.showInternalIds);

  const tables = useMemo(
    () => manifest.encounterTables.filter((t) => t.mapId === mapId),
    [manifest.encounterTables, mapId],
  );

  if (tables.length === 0) {
    return null;
  }

  return (
    <div className="fields-editor" data-testid="encounter-tables-view">
      <h5 className="fields-editor__heading">
        Wild encounters ({tables.length} table{tables.length === 1 ? '' : 's'})
      </h5>
      {tables.map((t) => (
        <EncounterTableSection
          key={t.id}
          table={t}
          manifest={manifest}
          showInternalIds={showInternalIds}
        />
      ))}
      <p className="fields-editor__note">
        Click "Edit" on any slot to change species / level range - 
        writes the 4-byte WildPokemon struct in place. Slots without
        an Edit button were ingested before per-slot file offsets
        were stashed; re-scan to enable editing.
      </p>
    </div>
  );
}

/** Phase K - inline editor for a single WildPokemon slot. Click "Edit"
 *  to expand species + minLevel + maxLevel inputs; Save writes via
 *  /binary-rom-edit/encounter-slot. Read-only when slot.fileOffset is
 *  undefined (decomp / pre-rescan). */
function EncounterSlotRow({
  slot,
  slotIndex,
  manifest,
  showInternalIds,
  mapId,
  pretMethod,
}: {
  slot: EncounterSlot;
  slotIndex: number;
  manifest: ProjectManifest;
  showInternalIds: boolean;
  /** Phase 6.10 - passed through from EncounterTableSection so the
   *  vanilla-truth overlay can fall back to pret's species default when
   *  the scanner couldn't capture this slot's species byte (the
   *  "species_undefined" symptom). */
  mapId: string | null;
  pretMethod: 'land_mons' | 'water_mons' | 'rock_smash_mons' | 'fishing_mons';
}) {
  const sessionId = useProjectStore((s) =>
    s.load.kind === 'loaded' ? s.load.data.session.id : null,
  );
  const scanCurrent = useProjectStore((s) => s.scanCurrentProject);
  const [editing, setEditing] = useState(false);
  const initialSpecies =
    Number.parseInt(slot.speciesId.replace(/^species_/, ''), 10) || 0;
  const [speciesId, setSpeciesId] = useState(initialSpecies);
  const [minLevel, setMinLevel] = useState(slot.minLevel);
  const [maxLevel, setMaxLevel] = useState(slot.maxLevel);
  const [state, setState] = useState<
    | { kind: 'idle' }
    | { kind: 'saving' }
    | { kind: 'saved' }
    | { kind: 'error'; message: string }
  >({ kind: 'idle' });

  useEffect(() => {
    setSpeciesId(initialSpecies);
    setMinLevel(slot.minLevel);
    setMaxLevel(slot.maxLevel);
    setState({ kind: 'idle' });
  }, [slot.fileOffset, initialSpecies, slot.minLevel, slot.maxLevel]);

  const canEdit = typeof slot.fileOffset === 'number';
  const dirty =
    speciesId !== initialSpecies ||
    minLevel !== slot.minLevel ||
    maxLevel !== slot.maxLevel;
  const valid =
    speciesId >= 0 &&
    speciesId <= 0xffff &&
    minLevel >= 1 &&
    minLevel <= 100 &&
    maxLevel >= minLevel &&
    maxLevel <= 100;
  const canSave =
    dirty && valid && canEdit && sessionId !== null && state.kind !== 'saving';
  const cancelEdit = (): void => {
    setEditing(false);
    setSpeciesId(initialSpecies);
    setMinLevel(slot.minLevel);
    setMaxLevel(slot.maxLevel);
    setState({ kind: 'idle' });
  };

  async function save(): Promise<void> {
    if (!sessionId || !canEdit || slot.fileOffset === undefined) return;
    setState({ kind: 'saving' });
    try {
      await editBinaryRomEncounterSlot(sessionId, {
        slotFileOffset: slot.fileOffset,
        fields: {
          ...(speciesId !== initialSpecies ? { speciesId } : {}),
          ...(minLevel !== slot.minLevel ? { minLevel } : {}),
          ...(maxLevel !== slot.maxLevel ? { maxLevel } : {}),
        },
      });
      setState({ kind: 'saved' });
      pushToast('success', 'Encounter slot saved');
      await scanCurrent();
      setEditing(false);
    } catch (e) {
      const message =
        e instanceof ProjectApiError
          ? `${e.code}: ${e.message}`
          : e instanceof Error
            ? e.message
            : String(e);
      setState({ kind: 'error', message });
      pushToast('error', `Encounter save failed - ${message}`);
    }
  }

  // Phase O.28 - Enter saves, Esc cancels.
  const onKeyDownEdit = useEditFormKeyboard({
    canSave,
    save,
    cancel: cancelEdit,
    isSaving: state.kind === 'saving',
  });

  if (!editing) {
    return (
      <li className="encounter-slot-row">
        <span
          className="encounter-slot-row__species"
          title={`Slot ${String(slotIndex + 1)} - fixed spawn weight set by the engine. Swap which species occupies this slot to change rarity.`}
        >
          <span
            style={{
              display: 'inline-block',
              minWidth: 16,
              fontSize: 10,
              color: 'var(--color-text-muted)',
              marginRight: 4,
            }}
          >
            #{slotIndex + 1}
          </span>
          {/* Phase 6.10 - when the scanner couldn't capture the species
              byte (slot.speciesId === "species_undefined") AND the
              project's identity is overlaySafe, fall back to pret's
              vanilla species for this (map, method, slot). The agent's
              proposal preview still passes through synthetic ids for
              diffability; only this rendered label gets the overlay. */}
          {(() => {
            const fallback = displayName(manifest, slot.speciesId, showInternalIds);
            // Slot ids of the form `species_NNN` (numeric) already
            // resolve via the symbol DB - keep displayName's answer.
            if (/^species_\d+$/.test(slot.speciesId)) return fallback;
            if (!mapId) return fallback;
            const overlay = lookupEncounterSlotSpecies(
              manifest,
              mapId,
              pretMethod,
              slotIndex,
            );
            return overlay ?? fallback;
          })()}
        </span>
        <span className="encounter-slot-row__levels">
          Lv {slot.minLevel === slot.maxLevel
            ? slot.minLevel
            : `${slot.minLevel}–${slot.maxLevel}`}
        </span>
        {canEdit ? (
          <button
            type="button"
            className="btn btn--secondary"
            data-testid={`encounter-slot-edit-${slotIndex}`}
            style={{ height: 22, fontSize: 10, padding: '0 8px' }}
            onClick={() => setEditing(true)}
          >
            Edit
          </button>
        ) : (
          <span className="encounter-slot-row__weight">slot {slotIndex + 1}</span>
        )}
      </li>
    );
  }
  return (
    <li
      className="encounter-slot-row encounter-slot-row--editing"
      onKeyDown={onKeyDownEdit}
    >
      <EntityPicker
        kind="species"
        manifest={manifest}
        value={speciesId}
        onChange={setSpeciesId}
        minId={0}
        maxId={0xffff}
        testIdPrefix={`encounter-slot-species-${slotIndex}`}
      />
      <input
        type="number"
        min={1}
        max={100}
        value={minLevel}
        data-testid={`encounter-slot-min-${slotIndex}`}
        onChange={(e) => setMinLevel(Math.max(1, Math.min(100, Number.parseInt(e.target.value, 10) || 1)))}
        style={{ width: 50 }}
        title="Min level"
      />
      <input
        type="number"
        min={minLevel}
        max={100}
        value={maxLevel}
        data-testid={`encounter-slot-max-${slotIndex}`}
        onChange={(e) => setMaxLevel(Math.max(minLevel, Math.min(100, Number.parseInt(e.target.value, 10) || minLevel)))}
        style={{ width: 50 }}
        title="Max level"
      />
      <button
        type="button"
        className="btn btn--primary"
        data-testid={`encounter-slot-save-${slotIndex}`}
        disabled={!dirty || !valid || !sessionId || state.kind === 'saving'}
        style={{ height: 22, fontSize: 10, padding: '0 8px' }}
        onClick={() => void save()}
      >
        {state.kind === 'saving' ? 'Saving…' : 'Save'}
      </button>
      <button
        type="button"
        className="btn btn--secondary"
        style={{ height: 22, fontSize: 10, padding: '0 8px' }}
        onClick={() => {
          setEditing(false);
          setSpeciesId(initialSpecies);
          setMinLevel(slot.minLevel);
          setMaxLevel(slot.maxLevel);
          setState({ kind: 'idle' });
        }}
      >
        Cancel
      </button>
      {state.kind === 'error' && (
        <span className="encounter-slot-row__weight" style={{ color: 'var(--color-error)' }}>
          {state.message}
        </span>
      )}
    </li>
  );
}

/** Phase 6.10 - translate the editor's EncounterTableType vocabulary
 *  to pret's JSON method names so the overlay can be queried. 'cave'
 *  maps to 'land_mons' since cave encounters share the same engine
 *  slot table as grass land encounters. */
function encounterTypeToPretMethod(
  type: string,
): 'land_mons' | 'water_mons' | 'rock_smash_mons' | 'fishing_mons' {
  switch (type) {
    case 'water':
      return 'water_mons';
    case 'fishing':
      return 'fishing_mons';
    case 'rock_smash':
      return 'rock_smash_mons';
    case 'grass':
    case 'cave':
    default:
      return 'land_mons';
  }
}

function EncounterTableSection({
  table,
  manifest,
  showInternalIds,
}: {
  table: EncounterTable;
  manifest: ProjectManifest;
  showInternalIds: boolean;
}) {
  const pretMethod = encounterTypeToPretMethod(table.type);
  return (
    <div className="encounter-table" data-testid={`encounter-table-${table.id}`}>
      <div className="encounter-table__header">
        <strong>{TYPE_LABEL[table.type] ?? table.type}</strong>
        {table.encounterRate > 0 && (
          <span className="encounter-table__rate">
            · encounter rate {table.encounterRate}
          </span>
        )}
      </div>
      {table.slots.length === 0 ? (
        <div className="fields-editor__note">No slots populated.</div>
      ) : (
        <ol className="encounter-slot-list">
          {table.slots.map((s, i) => (
            <EncounterSlotRow
              key={i}
              slot={s}
              slotIndex={i}
              manifest={manifest}
              showInternalIds={showInternalIds}
              mapId={table.mapId}
              pretMethod={pretMethod}
            />
          ))}
        </ol>
      )}
    </div>
  );
}
