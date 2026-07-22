import { useState } from 'react';
import type { InspectorPanelProps } from '../lib/inspectorRegistry';
import { displayName, prettifyMetadataKey } from '../lib/displayName';
import {
  pushToast,
  useProjectStore,
  useSelection,
  useUiPreferencesStore,
  type EntityRef,
} from '../state';
import {
  editBinaryRomTrainerFields,
  editBinaryRomTrainerPartyMember,
  ProjectApiError,
} from '../api';
import type {
  ProjectManifest,
  Trainer,
  TrainerPartyMember,
} from '@rom-editor/shared';
// Phase 4.3A - name-based pickers replace the raw numeric inputs that
// used to live in PartyMemberRow + TrainerStructEdit.
import { EntityPicker } from '../components/EntityPicker';
// Phase 4.3B - chip editor for the u32 AI-flag bitfield (decodes via
// the engine's named flag round-trip).
import { AiFlagChips } from '../components/AiFlagChips';
// Phase 4.3C - name-based picker for the trainer class index.
import { TrainerClassPicker } from '../components/TrainerClassPicker';
// Phase 4.2D / 4.3E - color chips for the species's type(s).
import { TypeChipPair } from '../components/TypeChip';
// Phase 4.3E - chip for the species's ability.
import { AbilityChip } from '../components/AbilityChip';
// Phase 4.3D - sprite thumbnail (placeholder PNG per species id today).
import { PokemonSprite } from '../components/PokemonSprite';
// Phase 4.3F - inline damage simulation against a curated benchmark.
import { TrainerSimQuickTest } from '../components/TrainerSimQuickTest';
import './InspectorShared.css';
import './TrainerInspector.css';

// Phase S.7 - TrainerInspector. Surfaces the trainer's class + party
// roster + AI flags + map context. Every party member's species is
// click-through (→ S.6 SpeciesInspector); every move slot is
// click-through (→ S.10 MoveInspector). This closes the click-anything
// loop for the battle-design surface.

function findTrainer(
  manifest: ProjectManifest | null,
  selectionId: string,
): Trainer | null {
  if (!manifest) return null;
  return manifest.trainers.find((t) => t.id === selectionId) ?? null;
}

export function TrainerInspector({
  selection,
  manifest,
  sessionId,
}: InspectorPanelProps) {
  const showInternalIds = useUiPreferencesStore((s) => s.showInternalIds);
  const select = useSelection((s) => s.select);
  const [advancedOpen, setAdvancedOpen] = useState(false);

  if (!manifest) {
    return (
      <div className="entity-inspector entity-inspector--empty" data-testid="trainer-inspector">
        <p>Open a project to inspect <code>{selection.id}</code>.</p>
      </div>
    );
  }
  const trainer = findTrainer(manifest, selection.id);
  if (!trainer) {
    return (
      <div className="entity-inspector entity-inspector--empty" data-testid="trainer-inspector">
        <p>
          The selection references <code>{selection.id}</code> but no trainer
          with that id is present in the scanned manifest
          ({manifest.trainers.length} trainers indexed).
        </p>
      </div>
    );
  }

  const trainerName = displayName(manifest, trainer.id, showInternalIds);
  const className = trainer.className || 'Unknown class';
  const trainerStructOffset =
    typeof trainer.metadata?.['structFileOffset'] === 'number'
      ? (trainer.metadata['structFileOffset'] as number)
      : null;

  return (
    <div className="entity-inspector trainer-inspector" data-testid="trainer-inspector">
      <header className="entity-inspector__header">
        <div className="trainer-inspector__class-row">
          <span className="trainer-inspector__class-chip" data-testid="trainer-inspector-class">
            {className}
          </span>
        </div>
        <div
          className="entity-inspector__title"
          data-testid="trainer-inspector-name"
        >
          {trainerName}
        </div>
        {trainer.mapId && (
          <div className="entity-inspector__sub">
            on{' '}
            <button
              type="button"
              className="trainer-inspector__map-link"
              onClick={() =>
                select({ kind: 'map', id: trainer.mapId as string })
              }
            >
              {displayName(manifest, trainer.mapId, showInternalIds)}
            </button>
          </div>
        )}
      </header>

      <section
        className="trainer-inspector__party"
        data-testid="trainer-inspector-party"
      >
        <h3 className="trainer-inspector__section-heading">
          Party{' '}
          <span className="entity-inspector__refs-count">
            ({trainer.party.length} / 6)
          </span>
        </h3>
        {trainer.party.length === 0 ? (
          <p className="entity-inspector__refs-empty">
            No party members indexed for this trainer.
          </p>
        ) : (
          <ul className="trainer-inspector__party-list">
            {trainer.party.map((m, i) => (
              <PartyMemberRow
                key={i}
                member={m}
                index={i}
                manifest={manifest}
                trainer={trainer}
                sessionId={sessionId}
                showInternalIds={showInternalIds}
                onSelect={select}
              />
            ))}
          </ul>
        )}
      </section>

      {trainer.aiFlags.length > 0 && (
        <section
          className="trainer-inspector__ai"
          data-testid="trainer-inspector-ai"
        >
          <h3 className="trainer-inspector__section-heading">AI flags</h3>
          <div className="trainer-inspector__ai-chips">
            {trainer.aiFlags.map((f, i) => (
              <span key={i} className="trainer-inspector__ai-chip">
                {f}
              </span>
            ))}
          </div>
        </section>
      )}

      {sessionId && trainerStructOffset !== null && (
        <TrainerStructEdit
          trainer={trainer}
          structFileOffset={trainerStructOffset}
          sessionId={sessionId}
          manifest={manifest}
        />
      )}

      {/* Phase 4.3F - quick "is this team balanced?" estimator. */}
      <TrainerSimQuickTest trainerId={trainer.id} />


      <button
        type="button"
        className="trainer-inspector__advanced-toggle"
        onClick={() => setAdvancedOpen((v) => !v)}
        aria-expanded={advancedOpen}
        data-testid="trainer-inspector-advanced-toggle"
      >
        {advancedOpen ? 'Hide developer details' : 'Show developer details'}
      </button>
      {advancedOpen && (
        <dl
          className="trainer-inspector__advanced"
          data-testid="trainer-inspector-advanced"
        >
          <MetaRow label="Internal ID" value={trainer.id} />
          {trainer.metadata &&
            Object.entries(trainer.metadata).map(([k, v]) => {
              const isOffset = /[Oo]ffset$/.test(k) && typeof v === 'number';
              const formatted = isOffset
                ? `0x${(v as number).toString(16)}`
                : String(v);
              return (
                <MetaRow key={k} label={prettifyMetadataKey(k)} value={formatted} />
              );
            })}
        </dl>
      )}
    </div>
  );
}

function PartyMemberRow({
  member,
  index,
  manifest,
  trainer,
  sessionId,
  showInternalIds,
  onSelect,
}: {
  member: TrainerPartyMember;
  index: number;
  manifest: ProjectManifest;
  trainer: Trainer;
  sessionId: string | null;
  showInternalIds: boolean;
  onSelect: (ref: EntityRef) => void;
}) {
  const scanCurrentProject = useProjectStore((s) => s.scanCurrentProject);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [draftLevel, setDraftLevel] = useState(member.level);
  const [draftSpecies, setDraftSpecies] = useState(
    parseSyntheticIndex(member.speciesId) ?? 0,
  );
  const [draftHeldItem, setDraftHeldItem] = useState(
    member.heldItemId ? (parseSyntheticIndex(member.heldItemId) ?? 0) : 0,
  );
  const [draftMoves, setDraftMoves] = useState<readonly [number, number, number, number]>(
    () => {
      const ids = member.moveIds.slice(0, 4);
      const parsed = ids.map((m) => parseSyntheticIndex(m) ?? 0);
      while (parsed.length < 4) parsed.push(0);
      return [parsed[0]!, parsed[1]!, parsed[2]!, parsed[3]!] as const;
    },
  );

  const speciesLabel = displayName(manifest, member.speciesId, showInternalIds);
  const heldItemLabel = member.heldItemId
    ? displayName(manifest, member.heldItemId, showInternalIds)
    : null;
  // Phase 4.3E - surface the species's type(s) via TypeChipPair when
  // the manifest's SpeciesEntry lifter has populated them. Falls back
  // gracefully to no chips when species data is missing.
  const memberSpeciesIdx = parseSyntheticIndex(member.speciesId);
  const speciesEntry =
    memberSpeciesIdx !== null
      ? manifest.species?.find((s) => s.speciesIndex === memberSpeciesIdx)
      : undefined;

  const partyFlags =
    typeof trainer.metadata?.['partyFlags'] === 'number'
      ? (trainer.metadata['partyFlags'] as number)
      : 0;

  const canEdit = sessionId !== null && member.fileOffset != null;

  async function commitEdit() {
    if (!sessionId || member.fileOffset == null) return;
    const fields: {
      speciesId?: number;
      level?: number;
      heldItemId?: number;
    } = {};
    if (draftLevel !== member.level) fields.level = draftLevel;
    const memberSpeciesIdx = parseSyntheticIndex(member.speciesId);
    if (memberSpeciesIdx !== null && draftSpecies !== memberSpeciesIdx) {
      fields.speciesId = draftSpecies;
    }
    const hasItems = (partyFlags & 0x02) !== 0;
    if (hasItems) {
      const memberItemIdx = member.heldItemId
        ? parseSyntheticIndex(member.heldItemId)
        : 0;
      if (memberItemIdx !== null && draftHeldItem !== memberItemIdx) {
        fields.heldItemId = draftHeldItem;
      }
    }
    const hasMoves = (partyFlags & 0x01) !== 0;
    if (hasMoves) {
      const memberMoves = member.moveIds.slice(0, 4).map(
        (m) => parseSyntheticIndex(m) ?? 0,
      );
      while (memberMoves.length < 4) memberMoves.push(0);
      const changed = draftMoves.some(
        (m, i) => m !== memberMoves[i],
      );
      if (changed) {
        (fields as { moveIds?: ReadonlyArray<number> }).moveIds = [
          ...draftMoves,
        ];
      }
    }
    if (Object.keys(fields).length === 0) {
      setEditing(false);
      return;
    }
    setSaving(true);
    try {
      await editBinaryRomTrainerPartyMember(sessionId, {
        memberFileOffset: member.fileOffset,
        partyFlags,
        fields,
      });
      pushToast(
        'success',
        `Party member saved (${Object.keys(fields).length} field${Object.keys(fields).length === 1 ? '' : 's'})`,
      );
      await scanCurrentProject();
      setEditing(false);
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
    <li className="trainer-inspector__party-row" data-testid={`trainer-inspector-party-${index}`}>
      <div className="trainer-inspector__party-header">
        <button
          type="button"
          className="trainer-inspector__species-btn"
          onClick={() =>
            onSelect({ kind: 'species', id: member.speciesId })
          }
          style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 6 }}
        >
          {memberSpeciesIdx !== null && (
            <PokemonSprite
              speciesId={memberSpeciesIdx}
              variant="compact"
              testIdPrefix={`trainer-inspector-party-sprite-${index}`}
            />
          )}
          <span className="trainer-inspector__species-name">{speciesLabel}</span>
          {!editing && speciesEntry && (
            <TypeChipPair
              type1={speciesEntry.type1}
              type2={speciesEntry.type2}
              {...(speciesEntry.type1Name !== undefined ? { type1Name: speciesEntry.type1Name } : {})}
              {...(speciesEntry.type2Name !== undefined ? { type2Name: speciesEntry.type2Name } : {})}
              compact
              testIdPrefix={`trainer-inspector-party-types-${index}`}
            />
          )}
          {!editing && (
            <span className="trainer-inspector__species-level">Lv {member.level}</span>
          )}
        </button>
        {!editing && canEdit && (
          <button
            type="button"
            className="entity-inspector__edit-btn"
            style={{ padding: '2px 6px', marginLeft: 4, marginTop: 0, fontSize: 11 }}
            onClick={() => {
              setDraftLevel(member.level);
              setEditing(true);
            }}
            data-testid={`trainer-inspector-party-edit-${index}`}
            title="Edit this party member"
          >
            ✎
          </button>
        )}
      </div>
      {editing && (
        <div
          className="entity-inspector__edit-form"
          style={{ margin: '6px 0 0 0' }}
          data-testid={`trainer-inspector-party-edit-form-${index}`}
        >
          {/* Phase 4.3A - EntityPicker autocomplete by name. The
              user types "pika" and lands on Pikachu. Pasting a raw
              numeric id still works (EntityPicker's numeric-input
              fallback). */}
          <label className="entity-inspector__num-field">
            <span>Pokémon</span>
            <EntityPicker
              kind="species"
              manifest={manifest}
              value={draftSpecies}
              onChange={setDraftSpecies}
              minId={0}
              maxId={1023}
              testIdPrefix={`trainer-inspector-party-edit-species-${index}`}
              disabled={saving}
            />
          </label>
          <label className="entity-inspector__num-field">
            <span>Level</span>
            <input
              type="number"
              min={1}
              max={100}
              value={draftLevel}
              data-testid={`trainer-inspector-party-edit-level-${index}`}
              onChange={(e) => {
                const n = Number.parseInt(e.target.value, 10);
                if (Number.isFinite(n))
                  setDraftLevel(Math.max(1, Math.min(100, n)));
              }}
            />
          </label>
          {(partyFlags & 0x02) !== 0 && (
            <label className="entity-inspector__num-field">
              <span>Held item</span>
              <EntityPicker
                kind="item"
                manifest={manifest}
                value={draftHeldItem}
                onChange={setDraftHeldItem}
                minId={0}
                maxId={65535}
                testIdPrefix={`trainer-inspector-party-edit-item-${index}`}
                disabled={saving}
              />
            </label>
          )}
          {(partyFlags & 0x01) !== 0 && (
            <>
              {[0, 1, 2, 3].map((slot) => (
                <label key={`move-${slot}`} className="entity-inspector__num-field">
                  <span>Move {slot + 1}</span>
                  <EntityPicker
                    kind="move"
                    manifest={manifest}
                    value={draftMoves[slot]!}
                    onChange={(n) => {
                      setDraftMoves((prev) => {
                        const next = [...prev] as [number, number, number, number];
                        next[slot] = Math.max(0, Math.min(1023, n));
                        return next as unknown as readonly [number, number, number, number];
                      });
                    }}
                    minId={0}
                    maxId={1023}
                    testIdPrefix={`trainer-inspector-party-edit-move-${index}-${slot}`}
                    disabled={saving}
                  />
                </label>
              ))}
            </>
          )}
          <div className="entity-inspector__edit-actions">
            <button
              type="button"
              className="entity-inspector__save-btn"
              onClick={commitEdit}
              disabled={saving}
              data-testid={`trainer-inspector-party-save-${index}`}
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
            <button
              type="button"
              className="entity-inspector__cancel-btn"
              onClick={() => setEditing(false)}
              disabled={saving}
              data-testid={`trainer-inspector-party-cancel-${index}`}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
      {(member.moveIds.length > 0 || heldItemLabel || speciesEntry) && (
        <dl className="trainer-inspector__party-detail">
          {/* Phase 4.3E - Surface the species's default ability when
              the manifest's species lifter has populated it. Trainers
              get the slot-1 ability in vanilla Gen-3 (slot-2 selection
              is a CFRU feature, surfaced here only when the data
              changes). */}
          {speciesEntry && speciesEntry.ability1 !== 0 && (
            <div className="trainer-inspector__party-detail-row">
              <dt>Ability</dt>
              <dd>
                <AbilityChip
                  abilityId={speciesEntry.ability1}
                  manifest={manifest}
                  compact
                  testIdPrefix={`trainer-inspector-party-ability-${index}`}
                />
              </dd>
            </div>
          )}
          {heldItemLabel && (
            <div className="trainer-inspector__party-detail-row">
              <dt>Item</dt>
              <dd>
                <button
                  type="button"
                  className="trainer-inspector__item-btn"
                  onClick={() =>
                    onSelect({ kind: 'item', id: member.heldItemId! })
                  }
                >
                  {heldItemLabel}
                </button>
              </dd>
            </div>
          )}
          {member.moveIds.length > 0 && (
            <div className="trainer-inspector__party-detail-row">
              <dt>Moves</dt>
              <dd className="trainer-inspector__move-chips">
                {member.moveIds.map((mid, mi) => (
                  <button
                    key={`${mid}-${mi}`}
                    type="button"
                    className="trainer-inspector__move-chip"
                    onClick={() => onSelect({ kind: 'move', id: mid })}
                  >
                    {displayName(manifest, mid, showInternalIds)}
                  </button>
                ))}
              </dd>
            </div>
          )}
        </dl>
      )}
    </li>
  );
}

// Trainer-level edit form - class index + AI flags raw + 4 battle items.
function TrainerStructEdit({
  trainer,
  structFileOffset,
  sessionId,
  manifest,
}: {
  trainer: Trainer;
  structFileOffset: number;
  sessionId: string;
  manifest: ProjectManifest;
}) {
  const scanCurrentProject = useProjectStore((s) => s.scanCurrentProject);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);

  const aiFlagsRawInitial =
    typeof trainer.metadata?.['aiFlagsRaw'] === 'number'
      ? (trainer.metadata['aiFlagsRaw'] as number)
      : 0;
  const trainerClassInitial =
    typeof trainer.metadata?.['trainerClass'] === 'number'
      ? (trainer.metadata['trainerClass'] as number)
      : 0;
  const itemsInitial = ((trainer.metadata?.['items'] as unknown) as
    | readonly number[]
    | undefined) ?? [0, 0, 0, 0];

  const [draftClass, setDraftClass] = useState(trainerClassInitial);
  const [draftAi, setDraftAi] = useState(aiFlagsRawInitial);
  const [draftItems, setDraftItems] = useState<readonly [number, number, number, number]>(
    [
      itemsInitial[0] ?? 0,
      itemsInitial[1] ?? 0,
      itemsInitial[2] ?? 0,
      itemsInitial[3] ?? 0,
    ],
  );

  async function commit() {
    type Mutable<T> = { -readonly [K in keyof T]: T[K] };
    const fields: Mutable<Parameters<typeof editBinaryRomTrainerFields>[1]['fields']> = {};
    if (draftClass !== trainerClassInitial) fields.trainerClass = draftClass;
    if (draftAi !== aiFlagsRawInitial) fields.aiFlagsRaw = draftAi;
    if (draftItems[0] !== (itemsInitial[0] ?? 0)) fields.item0 = draftItems[0];
    if (draftItems[1] !== (itemsInitial[1] ?? 0)) fields.item1 = draftItems[1];
    if (draftItems[2] !== (itemsInitial[2] ?? 0)) fields.item2 = draftItems[2];
    if (draftItems[3] !== (itemsInitial[3] ?? 0)) fields.item3 = draftItems[3];
    if (Object.keys(fields).length === 0) {
      setOpen(false);
      return;
    }
    setSaving(true);
    try {
      await editBinaryRomTrainerFields(sessionId, {
        structFileOffset,
        fields,
      });
      pushToast('success', `Trainer saved (${Object.keys(fields).length} field${Object.keys(fields).length === 1 ? '' : 's'})`);
      await scanCurrentProject();
      setOpen(false);
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

  if (!open) {
    return (
      <button
        type="button"
        className="entity-inspector__edit-btn"
        onClick={() => setOpen(true)}
        data-testid="trainer-inspector-edit-btn"
      >
        Edit trainer fields…
      </button>
    );
  }

  return (
    <div
      className="entity-inspector__edit-form"
      data-testid="trainer-inspector-edit-form"
    >
      {/* Phase 4.3C - TrainerClassPicker autocompletes by class name
          (Youngster, Lass, Gym Leader …) from manifest.trainerClasses. */}
      <label className="entity-inspector__num-field">
        <span>Trainer class</span>
        <TrainerClassPicker
          manifest={manifest}
          value={draftClass}
          onChange={setDraftClass}
          testIdPrefix="trainer-inspector-edit-class"
          disabled={saving}
        />
      </label>
      {/* Phase 4.3B - Chip toggle grid for the u32 AI flag bitfield,
          using the engine's decodeAiFlags/encodeAiFlags round-trip
          (Phase 3.4). Includes SMART / GYM_LEADER / ELITE_FOUR
          preset buttons. */}
      <label className="entity-inspector__num-field">
        <span>AI behavior</span>
        <AiFlagChips
          value={draftAi}
          onChange={setDraftAi}
          testIdPrefix="trainer-inspector-edit-ai"
          disabled={saving}
        />
      </label>
      {[0, 1, 2, 3].map((slot) => (
        <label key={`tritem-${slot}`} className="entity-inspector__num-field">
          <span>Battle item {slot + 1}</span>
          <EntityPicker
            kind="item"
            manifest={manifest}
            value={draftItems[slot]!}
            onChange={(n) => {
              setDraftItems((prev) => {
                const next = [...prev] as [number, number, number, number];
                next[slot] = Math.max(0, Math.min(65535, n));
                return next as unknown as readonly [number, number, number, number];
              });
            }}
            minId={0}
            maxId={65535}
            testIdPrefix={`trainer-inspector-edit-item-${slot}`}
            disabled={saving}
          />
        </label>
      ))}
      <div className="entity-inspector__edit-actions">
        <button
          type="button"
          className="entity-inspector__save-btn"
          onClick={commit}
          disabled={saving}
          data-testid="trainer-inspector-save-btn"
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
        <button
          type="button"
          className="entity-inspector__cancel-btn"
          onClick={() => setOpen(false)}
          disabled={saving}
          data-testid="trainer-inspector-cancel-btn"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

// Parse synthetic 'species_N' / 'item_N' ids into their numeric index.
function parseSyntheticIndex(id: string | null): number | null {
  if (!id) return null;
  const synth = /^(?:species|item|ITEM|SPECIES)_?_?(\d+)$/i.exec(id);
  if (synth) return Number.parseInt(synth[1]!, 10);
  return null;
}

function MetaRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="trainer-inspector__meta-row">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}
