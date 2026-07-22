import { useMemo, useState } from 'react';
import type { InspectorPanelProps } from '../lib/inspectorRegistry';
import { displayName, lookupEncounterSlotSpecies } from '../lib/displayName';
// Phase 4.2E - color-coded rarity dot beside the percentage so the
// user can scan the table at a glance.
import { RarityDot, rarityBucketForPct, rarityLabelForBucket } from '../components/RarityDot';
// Phase 4.2C - sprite thumbnail (placeholder PNG today; real ROM
// sprite when the lifter lands).
import { PokemonSprite } from '../components/PokemonSprite';
import {
  pushToast,
  useProjectStore,
  useSelection,
  useUiPreferencesStore,
} from '../state';
import {
  editBinaryRomEncounterSlot,
  editBinaryRomEncounterTable,
  ProjectApiError,
} from '../api';
import type { EncounterTable, ProjectManifest } from '@rom-editor/shared';
import { EntityPicker } from '../components/EntityPicker';
import './InspectorShared.css';

// Phase S.1 (lite) - EncounterTableInspector. Renders a wild encounter
// table's slots with click-through species references. Lets the user
// land on the table directly (via Command Palette search) and see
// the rate / level range / species mix without first opening the
// map. The MapEditor's existing EncounterTablesView still exists for
// the map-scoped flow; this is the standalone workspace-dock view.

const TYPE_LABEL: Record<string, string> = {
  grass: 'Grass (land walk)',
  water: 'Surfing',
  fishing: 'Fishing',
  cave: 'Cave',
  rock_smash: 'Rock smash',
  custom: 'Custom',
};

function findTable(
  manifest: ProjectManifest | null,
  selectionId: string,
): EncounterTable | null {
  if (!manifest) return null;
  return (
    manifest.encounterTables.find((t) => t.id === selectionId) ?? null
  );
}

export function EncounterTableInspector({
  selection,
  manifest,
  sessionId,
}: InspectorPanelProps) {
  const showInternalIds = useUiPreferencesStore((s) => s.showInternalIds);
  const select = useSelection((s) => s.select);
  const scanCurrentProject = useProjectStore((s) => s.scanCurrentProject);
  const [editingSlot, setEditingSlot] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [draftSpecies, setDraftSpecies] = useState(0);
  const [draftMin, setDraftMin] = useState(0);
  const [draftMax, setDraftMax] = useState(0);
  // WP-C1 - rate edit + bulk replace state.
  const [editingRate, setEditingRate] = useState(false);
  const [draftRate, setDraftRate] = useState(0);
  const [bulkReplacing, setBulkReplacing] = useState(false);
  const [bulkSpecies, setBulkSpecies] = useState(0);

  const table = useMemo(
    () => findTable(manifest, selection.id),
    [manifest, selection.id],
  );

  if (!manifest) {
    return (
      <div className="entity-inspector entity-inspector--empty" data-testid="encounter-table-inspector">
        <p>Open a project to inspect <code>{selection.id}</code>.</p>
      </div>
    );
  }
  if (!table) {
    return (
      <div className="entity-inspector entity-inspector--empty" data-testid="encounter-table-inspector">
        <p>
          No encounter table with id <code>{selection.id}</code> in the
          manifest ({manifest.encounterTables.length} tables indexed).
        </p>
      </div>
    );
  }

  // Aggregate weight for percentage display.
  const totalWeight = table.slots.reduce((s, x) => s + x.weight, 0);

  // Group adjacent identical species into compact rows.
  return (
    <div className="entity-inspector" data-testid="encounter-table-inspector">
      <header className="entity-inspector__header">
        <div className="entity-inspector__sub" data-testid="encounter-table-inspector-type">
          {TYPE_LABEL[table.type] ?? table.type}
        </div>
        <div
          className="entity-inspector__title"
          data-testid="encounter-table-inspector-name"
        >
          {displayName(manifest, table.id, showInternalIds)}
        </div>
        {table.mapId && (
          <div className="entity-inspector__sub">
            on{' '}
            <button
              type="button"
              style={{
                display: 'inline',
                padding: 0,
                background: 'transparent',
                border: 'none',
                color: 'var(--color-accent)',
                textDecoration: 'underline',
                textDecorationStyle: 'dotted',
                cursor: 'pointer',
                font: 'inherit',
                fontSize: 'inherit',
              }}
              onClick={() => select({ kind: 'map', id: table.mapId as string })}
            >
              {displayName(manifest, table.mapId, showInternalIds)}
            </button>
          </div>
        )}
      </header>

      <dl className="entity-inspector__meta-grid">
        <div className="entity-inspector__meta-row">
          <dt>Rate</dt>
          <dd data-testid="encounter-table-inspector-rate">
            {editingRate && sessionId && table.infoFileOffset !== undefined ? (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <input
                  type="number"
                  min={0}
                  max={100}
                  value={draftRate}
                  data-testid="encounter-table-inspector-rate-input"
                  onChange={(e) => {
                    const n = Number.parseInt(e.target.value, 10);
                    if (Number.isFinite(n))
                      setDraftRate(Math.max(0, Math.min(100, n)));
                  }}
                  disabled={saving}
                  style={{ width: 60 }}
                />
                <span>%</span>
                <button
                  type="button"
                  className="entity-inspector__save-btn"
                  data-testid="encounter-table-inspector-rate-save"
                  disabled={saving || draftRate === table.encounterRate}
                  onClick={async () => {
                    if (!sessionId) return;
                    setSaving(true);
                    try {
                      await editBinaryRomEncounterTable(sessionId, {
                        encounterTableId: table.id,
                        op: 'setRate',
                        encounterRate: draftRate,
                      });
                      pushToast('success', `Rate set to ${draftRate}%`);
                      await scanCurrentProject();
                      setEditingRate(false);
                    } catch (err) {
                      const msg =
                        err instanceof ProjectApiError
                          ? `${err.code}: ${err.message}`
                          : err instanceof Error
                            ? err.message
                            : String(err);
                      pushToast('error', `Rate save failed: ${msg}`);
                    } finally {
                      setSaving(false);
                    }
                  }}
                >
                  {saving ? 'Saving…' : 'Save'}
                </button>
                <button
                  type="button"
                  className="entity-inspector__cancel-btn"
                  data-testid="encounter-table-inspector-rate-cancel"
                  disabled={saving}
                  onClick={() => setEditingRate(false)}
                >
                  Cancel
                </button>
              </span>
            ) : (
              <span>
                {table.encounterRate}% chance per step{' '}
                {sessionId && table.infoFileOffset !== undefined && (
                  <button
                    type="button"
                    className="entity-inspector__edit-btn"
                    style={{ padding: '2px 8px', marginLeft: 6 }}
                    data-testid="encounter-table-inspector-rate-edit"
                    onClick={() => {
                      setDraftRate(table.encounterRate);
                      setEditingRate(true);
                    }}
                    title="Change encounter rate"
                  >
                    ✎
                  </button>
                )}
              </span>
            )}
          </dd>
        </div>
        <div className="entity-inspector__meta-row">
          <dt>Slots</dt>
          <dd>{table.slots.length}</dd>
        </div>
      </dl>

      {sessionId && table.slotsFileOffset !== undefined && table.slots.length > 0 && (
        <section
          className="entity-inspector__refs"
          data-testid="encounter-table-inspector-bulk"
          style={{ marginBottom: 6 }}
        >
          <h3 className="entity-inspector__refs-heading">Bulk actions</h3>
          {bulkReplacing ? (
            <div
              className="entity-inspector__edit-form"
              style={{ margin: 0 }}
              data-testid="encounter-table-inspector-bulk-form"
            >
              <label className="entity-inspector__num-field">
                <span>Replace every slot with</span>
                <EntityPicker
                  kind="species"
                  manifest={manifest}
                  value={bulkSpecies}
                  onChange={setBulkSpecies}
                  minId={1}
                  maxId={1023}
                  testIdPrefix="encounter-table-bulk-species"
                  disabled={saving}
                />
              </label>
              <p style={{ margin: 0, fontSize: 11, color: 'var(--color-text-muted)' }}>
                Every slot's species becomes this one - levels are preserved.
                Handy for "Magikarp-only Route 1" challenge setups.
              </p>
              <div className="entity-inspector__edit-actions">
                <button
                  type="button"
                  className="entity-inspector__save-btn"
                  data-testid="encounter-table-inspector-bulk-save"
                  disabled={saving || bulkSpecies < 1}
                  onClick={async () => {
                    if (!sessionId) return;
                    setSaving(true);
                    try {
                      await editBinaryRomEncounterTable(sessionId, {
                        encounterTableId: table.id,
                        op: 'bulkReplaceSpecies',
                        speciesId: bulkSpecies,
                      });
                      pushToast(
                        'success',
                        `Replaced all ${table.slots.length} slots with species ${bulkSpecies}`,
                      );
                      await scanCurrentProject();
                      setBulkReplacing(false);
                    } catch (err) {
                      const msg =
                        err instanceof ProjectApiError
                          ? `${err.code}: ${err.message}`
                          : err instanceof Error
                            ? err.message
                            : String(err);
                      pushToast('error', `Bulk replace failed: ${msg}`);
                    } finally {
                      setSaving(false);
                    }
                  }}
                >
                  {saving ? 'Replacing…' : 'Replace all'}
                </button>
                <button
                  type="button"
                  className="entity-inspector__cancel-btn"
                  data-testid="encounter-table-inspector-bulk-cancel"
                  disabled={saving}
                  onClick={() => setBulkReplacing(false)}
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              className="entity-inspector__edit-btn"
              data-testid="encounter-table-inspector-bulk-open"
              onClick={() => {
                const first = parseSpeciesIndex(table.slots[0]!.speciesId);
                setBulkSpecies(first ?? 1);
                setBulkReplacing(true);
              }}
            >
              Replace every species…
            </button>
          )}
        </section>
      )}

      <section
        className="entity-inspector__refs"
        data-testid="encounter-table-inspector-slots"
      >
        <h3 className="entity-inspector__refs-heading">Wild slots</h3>
        <p
          className="entity-inspector__refs-empty"
          style={{
            margin: '0 0 8px',
            padding: '6px 8px',
            background: 'rgba(74, 158, 255, 0.05)',
            borderLeft: '3px solid var(--color-accent)',
            borderRadius: 3,
            fontSize: 11,
            color: 'var(--color-text-muted)',
          }}
          data-testid="encounter-table-inspector-hint"
        >
          Each slot's % is fixed by the engine - slot 1 is always the most
          common. To make a Pokémon rarer or more common, use ↑/↓ to move
          it (the species moves; the % stays with the slot index). Use ✎
          to change the species and level range of any one slot.
        </p>
        {table.slots.length === 0 ? (
          <p className="entity-inspector__refs-empty">
            Table has no slots (deactivated or unused).
          </p>
        ) : (
          <ul className="entity-inspector__refs-list">
            {table.slots.map((slot, i) => {
              const pct =
                totalWeight > 0 ? Math.round((slot.weight / totalWeight) * 1000) / 10 : 0;
              const levelRange =
                slot.minLevel === slot.maxLevel
                  ? `Lv ${slot.minLevel}`
                  : `Lv ${slot.minLevel}–${slot.maxLevel}`;
              // Phase 4.2E - bucket → colored dot + label.
              const rarityBucket = rarityBucketForPct(pct);
              const rarity = rarityLabelForBucket(rarityBucket);

              if (editingSlot === i) {
                return (
                  <li key={`edit-${i}`}>
                    <div
                      className="entity-inspector__edit-form"
                      style={{ margin: 0 }}
                      data-testid={`encounter-slot-edit-form-${i}`}
                    >
                      <label className="entity-inspector__num-field">
                        <span>Pokémon</span>
                        {/* Phase Q.6.1 overhaul - the species field used
                            to be a raw 0-1023 number input ("type 25 to
                            mean Pikachu"). EntityPicker turns it into a
                            name-autocomplete: the user types "pika" and
                            picks the Pokémon by name. Numeric IDs still
                            paste through, so power users can paste a
                            list of species IDs from another tool. */}
                        <EntityPicker
                          kind="species"
                          manifest={manifest}
                          value={draftSpecies}
                          onChange={setDraftSpecies}
                          minId={0}
                          maxId={1023}
                          testIdPrefix={`encounter-slot-edit-species-${i}`}
                          disabled={saving}
                        />
                      </label>
                      <label className="entity-inspector__num-field">
                        <span>Min level</span>
                        <input
                          type="number"
                          min={1}
                          max={100}
                          value={draftMin}
                          data-testid={`encounter-slot-edit-min-${i}`}
                          onChange={(e) => {
                            const n = Number.parseInt(e.target.value, 10);
                            if (Number.isFinite(n))
                              setDraftMin(Math.max(1, Math.min(100, n)));
                          }}
                        />
                      </label>
                      <label className="entity-inspector__num-field">
                        <span>Max level</span>
                        <input
                          type="number"
                          min={1}
                          max={100}
                          value={draftMax}
                          data-testid={`encounter-slot-edit-max-${i}`}
                          onChange={(e) => {
                            const n = Number.parseInt(e.target.value, 10);
                            if (Number.isFinite(n))
                              setDraftMax(Math.max(1, Math.min(100, n)));
                          }}
                        />
                      </label>
                      <div className="entity-inspector__edit-actions">
                        <button
                          type="button"
                          className="entity-inspector__save-btn"
                          disabled={saving || !slot.fileOffset}
                          data-testid={`encounter-slot-save-${i}`}
                          onClick={async () => {
                            if (!slot.fileOffset || !sessionId) return;
                            setSaving(true);
                            try {
                              const fields: {
                                speciesId?: number;
                                minLevel?: number;
                                maxLevel?: number;
                              } = {};
                              const speciesIdx = parseSpeciesIndex(slot.speciesId);
                              if (speciesIdx !== null && draftSpecies !== speciesIdx)
                                fields.speciesId = draftSpecies;
                              if (draftMin !== slot.minLevel)
                                fields.minLevel = draftMin;
                              if (draftMax !== slot.maxLevel)
                                fields.maxLevel = draftMax;
                              if (Object.keys(fields).length === 0) {
                                setEditingSlot(null);
                                setSaving(false);
                                return;
                              }
                              await editBinaryRomEncounterSlot(sessionId, {
                                slotFileOffset: slot.fileOffset,
                                fields,
                              });
                              pushToast('success', 'Slot saved');
                              await scanCurrentProject();
                              setEditingSlot(null);
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
                          }}
                        >
                          {saving ? 'Saving…' : 'Save'}
                        </button>
                        <button
                          type="button"
                          className="entity-inspector__cancel-btn"
                          disabled={saving}
                          data-testid={`encounter-slot-cancel-${i}`}
                          onClick={() => setEditingSlot(null)}
                        >
                          Cancel
                        </button>
                      </div>
                      {!slot.fileOffset && (
                        <p
                          style={{
                            margin: 0,
                            color: 'var(--color-text-dim)',
                            fontSize: 11,
                          }}
                        >
                          This slot has no fileOffset metadata; the lifter didn't
                          record where to write. Re-scan the project from a
                          newer manifest format to enable saving.
                        </p>
                      )}
                    </div>
                  </li>
                );
              }

              return (
                <li key={`${slot.speciesId}-${i}`}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                    <button
                      type="button"
                      className="entity-inspector__refs-btn"
                      style={{ flex: 1 }}
                      onClick={() => select({ kind: 'species', id: slot.speciesId })}
                      title={`Slot ${String(i + 1)} (${rarity}) · ${pct}% spawn chance per encounter · ${levelRange}`}
                    >
                      <span className="entity-inspector__refs-btn-label">
                        <span
                          style={{
                            display: 'inline-block',
                            minWidth: 18,
                            fontSize: 10,
                            color: 'var(--color-text-muted)',
                            marginRight: 6,
                          }}
                        >
                          #{i + 1}
                        </span>
                        {/* Phase 4.2C - sprite chip leading the slot row.
                            Placeholder PNG today, real sprite when the
                            lifter ships. */}
                        {parseSpeciesIndex(slot.speciesId) !== null && (
                          <PokemonSprite
                            speciesId={parseSpeciesIndex(slot.speciesId)!}
                            variant="compact"
                            testIdPrefix={`encounter-slot-sprite-${i}`}
                          />
                        )}
                        <span style={{ marginLeft: 6 }}>
                          {/* Phase 6.5 - assertive vanilla-truth overlay
                              for the screenshot's "species_undefined" bug.
                              When the scanner couldn't capture the species
                              byte (pre-rescan state) AND the project's
                              identity is overlaySafe, pet supplies the
                              vanilla default for that (map, method, slot).
                              Non-modernized ROMs fall straight through to
                              the manifest+symbol-DB path. */}
                          {(() => {
                            const fallback = displayName(manifest, slot.speciesId, showInternalIds);
                            if (parseSpeciesIndex(slot.speciesId) !== null) return fallback;
                            if (!table.mapId) return fallback;
                            const overlay = lookupEncounterSlotSpecies(
                              manifest,
                              table.mapId,
                              encounterTypeToPretMethod(table.type),
                              i,
                            );
                            return overlay ?? fallback;
                          })()}
                        </span>
                      </span>
                      <span className="entity-inspector__refs-btn-meta">
                        {levelRange} · <RarityDot
                          bucket={rarityBucket}
                          testIdPrefix={`encounter-slot-rarity-${i}`}
                        />
                        {pct}% ({rarity})
                      </span>
                    </button>
                    {sessionId && table.slotsFileOffset !== undefined && (
                      <>
                        <button
                          type="button"
                          className="entity-inspector__edit-btn"
                          style={{ padding: '4px 6px', marginTop: 0 }}
                          data-testid={`encounter-slot-up-btn-${i}`}
                          disabled={i === 0 || saving}
                          title="Move up (becomes more common - each slot index has a fixed engine weight)"
                          onClick={async () => {
                            if (i === 0 || !sessionId) return;
                            const order = Array.from(
                              { length: table.slots.length },
                              (_, idx) => idx,
                            );
                            [order[i - 1]!, order[i]!] = [order[i]!, order[i - 1]!];
                            setSaving(true);
                            try {
                              await editBinaryRomEncounterTable(sessionId, {
                                encounterTableId: table.id,
                                op: 'reorder',
                                slotOrder: order,
                              });
                              pushToast('success', `Slot ${i + 1} moved up`);
                              await scanCurrentProject();
                            } catch (err) {
                              const msg =
                                err instanceof ProjectApiError
                                  ? `${err.code}: ${err.message}`
                                  : err instanceof Error
                                    ? err.message
                                    : String(err);
                              pushToast('error', `Reorder failed: ${msg}`);
                            } finally {
                              setSaving(false);
                            }
                          }}
                        >
                          ↑
                        </button>
                        <button
                          type="button"
                          className="entity-inspector__edit-btn"
                          style={{ padding: '4px 6px', marginTop: 0 }}
                          data-testid={`encounter-slot-down-btn-${i}`}
                          disabled={i === table.slots.length - 1 || saving}
                          title="Move down (becomes rarer)"
                          onClick={async () => {
                            if (i === table.slots.length - 1 || !sessionId) return;
                            const order = Array.from(
                              { length: table.slots.length },
                              (_, idx) => idx,
                            );
                            [order[i]!, order[i + 1]!] = [order[i + 1]!, order[i]!];
                            setSaving(true);
                            try {
                              await editBinaryRomEncounterTable(sessionId, {
                                encounterTableId: table.id,
                                op: 'reorder',
                                slotOrder: order,
                              });
                              pushToast('success', `Slot ${i + 1} moved down`);
                              await scanCurrentProject();
                            } catch (err) {
                              const msg =
                                err instanceof ProjectApiError
                                  ? `${err.code}: ${err.message}`
                                  : err instanceof Error
                                    ? err.message
                                    : String(err);
                              pushToast('error', `Reorder failed: ${msg}`);
                            } finally {
                              setSaving(false);
                            }
                          }}
                        >
                          ↓
                        </button>
                      </>
                    )}
                    {sessionId && slot.fileOffset && (
                      <button
                        type="button"
                        className="entity-inspector__edit-btn"
                        style={{ padding: '4px 8px', marginTop: 0 }}
                        data-testid={`encounter-slot-edit-btn-${i}`}
                        onClick={() => {
                          const idx = parseSpeciesIndex(slot.speciesId);
                          setDraftSpecies(idx ?? 0);
                          setDraftMin(slot.minLevel);
                          setDraftMax(slot.maxLevel);
                          setEditingSlot(i);
                        }}
                        title="Edit this slot"
                      >
                        ✎
                      </button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}

function parseSpeciesIndex(speciesId: string): number | null {
  const synth = /^species_(\d+)$/.exec(speciesId);
  if (synth) return Number.parseInt(synth[1]!, 10);
  return null;
}

/** Phase 6.5 - translate the editor's `EncounterTableType` vocabulary
 *  ('grass' | 'water' | 'cave' | 'fishing' | 'rock_smash' | 'custom')
 *  to the pret JSON method names ('land_mons' | 'water_mons' |
 *  'rock_smash_mons' | 'fishing_mons') used in the vanilla-truth
 *  overlay. 'cave' maps to 'land_mons' - cave encounters share the
 *  same engine-side slot table as grass land encounters. 'custom'
 *  has no pret counterpart so the resolver returns null. */
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
