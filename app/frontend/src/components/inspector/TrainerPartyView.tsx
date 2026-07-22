import { useEffect, useMemo, useState } from 'react';
import type {
  ObjectEvent,
  ProjectManifest,
  Trainer,
  TrainerPartyMember,
} from '@rom-editor/shared';
import { displayName } from '../../lib/displayName';
import { EntityPicker } from '../EntityPicker';
import { pushToast, useProjectStore, useUiPreferencesStore } from '../../state';
import {
  editBinaryRomTrainerFields,
  editBinaryRomTrainerPartyAppend,
  editBinaryRomTrainerPartyDelete,
  editBinaryRomTrainerPartyMember,
  ProjectApiError,
} from '../../api';
import { useEditFormKeyboard } from '../../lib/useEditFormKeyboard';

/**
 * Phase J.6 - Trainer party preview.
 *
 * When an ObjectEvent has trainerType !== 0 (i.e. it's a trainer NPC),
 * we walk its decoded script for a `trainerbattle` opcode, extract the
 * trainerId from that step's params, and look up the matching
 * `binary_trainer_N` entry in manifest.trainers. The party + class +
 * AI flags render below as a read-only list.
 *
 * Editing the party requires a writer that handles 4 party-struct
 * variants (PARTY_FLAG_MOVES + PARTY_FLAG_HELD_ITEM combinations) and
 * relocates when the new party size exceeds the original - non-trivial
 * scope deferred to a follow-up. This commit surfaces what's already
 * in the manifest so operators can SEE the party they're editing
 * around.
 */

interface TrainerPartyViewProps {
  readonly objectEvent: ObjectEvent;
  readonly manifest: ProjectManifest;
}

export function TrainerPartyView({ objectEvent, manifest }: TrainerPartyViewProps) {
  const showInternalIds = useUiPreferencesStore((s) => s.showInternalIds);

  // Walk script steps for this NPC's scriptId; find a trainerbattle.
  const trainer = useMemo<Trainer | null>(() => {
    if (!objectEvent.scriptId) return null;
    const prefix = `${objectEvent.scriptId}__`;
    for (const s of manifest.scriptSteps) {
      if (!s.id.startsWith(prefix)) continue;
      if (s.kind !== 'start_battle') continue;
      const params = s.params as Record<string, unknown>;
      const tid = typeof params.trainerId === 'number' ? params.trainerId : null;
      if (tid === null) continue;
      // Look up by binary-rom synthetic id OR by numeric index suffix.
      const found = manifest.trainers.find(
        (t) => t.id === `binary_trainer_${tid}` || t.id === `trainer_${tid}`,
      );
      if (found) return found;
      // Fallback: linear scan by index.
      if (tid >= 0 && tid < manifest.trainers.length) {
        return manifest.trainers[tid] ?? null;
      }
      return null;
    }
    return null;
  }, [objectEvent.scriptId, manifest.scriptSteps, manifest.trainers]);

  if (!trainer) {
    // Could be: no trainerType, no script, no trainerbattle in script, or
    // trainers table not lifted. Render nothing rather than a noisy empty.
    return null;
  }

  return (
    <div className="fields-editor" data-testid="trainer-party-view">
      <h5 className="fields-editor__heading">
        Trainer - {displayName(manifest, trainer.id, showInternalIds)}
      </h5>
      <TrainerFieldsInlineEditor trainer={trainer} manifest={manifest} showInternalIds={showInternalIds} />
      {trainer.party.length === 0 ? (
        <p className="fields-editor__note">
          Trainer party not yet lifted (trainer_parties_system detector may
          not have fired for this ROM, or this trainer's party uses an
          unusual encoding).
        </p>
      ) : (
        <ol className="trainer-party-list" data-testid="trainer-party-list">
          {trainer.party.map((m, i) => (
            <TrainerPartyMemberRow
              key={i}
              member={m}
              memberIndex={i}
              trainer={trainer}
              manifest={manifest}
              showInternalIds={showInternalIds}
            />
          ))}
        </ol>
      )}
      {/* Phase O.6 - Add party member button. Allocates a relocated
          larger party array in free ROM space and patches the trainer
          struct's partySize + partyPointer. Disabled when party is at
          Gen-3 max (6) or the struct metadata is incomplete. */}
      <AddPartyMemberButton trainer={trainer} />
      <p className="fields-editor__note">
        Click "Edit" on any party member to change species / level /
        moves / held item - writes the struct in place. Add party
        member relocates the array (party slot allocated in free ROM
        space; up to Gen-3 max of 6 members).
      </p>
    </div>
  );
}

/** Phase O.38 - labeled options for the encounter-music byte. These
 *  are the bottom-7 bits of the Trainer struct's byte 0x02 (gender
 *  lives in the top bit). Values track FRLG's
 *  `include/constants/trainers.h` `TRAINER_ENCOUNTER_MUSIC_*`
 *  constants; hack-added musics fall through as "Hack-specific N". */
const TRAINER_ENCOUNTER_MUSIC_OPTIONS: ReadonlyArray<{
  value: number;
  label: string;
}> = [
  { value: 0, label: '0 - Standard male' },
  { value: 1, label: '1 - Standard female' },
  { value: 2, label: '2 - Girl' },
  { value: 3, label: '3 - Intense (rival, gym leader)' },
  { value: 4, label: '4 - Cool' },
  { value: 5, label: '5 - Twin' },
  { value: 6, label: '6 - Hiker' },
  { value: 7, label: '7 - Interviewer' },
  { value: 8, label: '8 - Rich' },
  { value: 9, label: '9 - Elite Four' },
  { value: 10, label: '10 - Swimmer' },
];

/** Phase L.3 - inline editor for the trainer struct (name, class,
 *  encounter music, sprite, AI flags, held items). Shown in the
 *  trainer party panel header so name/class/AI/items are editable in
 *  the same place as the party. */
function TrainerFieldsInlineEditor({
  trainer,
  manifest,
  showInternalIds,
}: {
  trainer: Trainer;
  manifest: ProjectManifest;
  showInternalIds: boolean;
}): JSX.Element {
  const sessionId = useProjectStore((s) =>
    s.load.kind === 'loaded' ? s.load.data.session.id : null,
  );
  const scanCurrent = useProjectStore((s) => s.scanCurrentProject);
  const meta = trainer.metadata ?? {};
  const structFileOffset =
    typeof meta['structFileOffset'] === 'number' ? (meta['structFileOffset'] as number) : -1;
  const initialClass =
    typeof meta['trainerClass'] === 'number' ? (meta['trainerClass'] as number) : 0;
  const initialMusic =
    typeof meta['encounterMusic'] === 'number' ? (meta['encounterMusic'] as number) : 0;
  const initialPic =
    typeof meta['trainerPic'] === 'number' ? (meta['trainerPic'] as number) : 0;
  const initialAiFlags =
    typeof meta['aiFlagsRaw'] === 'number' ? (meta['aiFlagsRaw'] as number) : 0;
  const initialItems = [0, 1, 2, 3].map((i) => {
    const v = meta[`item${i}`];
    return typeof v === 'number' ? v : 0;
  });
  const [trainerClass, setTrainerClass] = useState(initialClass);
  const [name, setName] = useState(trainer.name);
  const [music, setMusic] = useState(initialMusic);
  const [pic, setPic] = useState(initialPic);
  const [aiFlags, setAiFlags] = useState(initialAiFlags);
  const [items, setItems] = useState(initialItems);
  const [state, setState] = useState<
    | { kind: 'idle' }
    | { kind: 'saving' }
    | { kind: 'saved' }
    | { kind: 'error'; message: string }
  >({ kind: 'idle' });

  useEffect(() => {
    setTrainerClass(initialClass);
    setName(trainer.name);
    setMusic(initialMusic);
    setPic(initialPic);
    setAiFlags(initialAiFlags);
    setItems(initialItems);
    setState({ kind: 'idle' });
  }, [trainer.id, initialClass, initialMusic, initialPic, initialAiFlags, trainer.name]); // initialItems omitted on purpose (array identity)

  if (structFileOffset <= 0) {
    return (
      <dl>
        <dt>Class</dt>
        <dd>{displayName(manifest, trainer.className, showInternalIds)}</dd>
        <dt>AI flags</dt>
        <dd>
          {trainer.aiFlags.length > 0
            ? trainer.aiFlags.join(', ')
            : '(none - standard AI)'}
        </dd>
        <dt>Party size</dt>
        <dd>{trainer.party.length}</dd>
      </dl>
    );
  }

  const dirty =
    trainerClass !== initialClass ||
    name !== trainer.name ||
    music !== initialMusic ||
    pic !== initialPic ||
    aiFlags !== initialAiFlags ||
    items.some((v, i) => v !== initialItems[i]);
  const canSave = dirty && sessionId !== null && name.length <= 11;

  async function save(): Promise<void> {
    if (!sessionId || !canSave) return;
    setState({ kind: 'saving' });
    try {
      const fields: {
        trainerClass?: number;
        encounterMusic?: number;
        trainerPic?: number;
        aiFlagsRaw?: number;
        item0?: number;
        item1?: number;
        item2?: number;
        item3?: number;
        name?: string;
      } = {};
      if (trainerClass !== initialClass) fields.trainerClass = trainerClass;
      if (name !== trainer.name) fields.name = name;
      if (music !== initialMusic) fields.encounterMusic = music;
      if (pic !== initialPic) fields.trainerPic = pic;
      if (aiFlags !== initialAiFlags) fields.aiFlagsRaw = aiFlags;
      if (items[0] !== initialItems[0]) fields.item0 = items[0];
      if (items[1] !== initialItems[1]) fields.item1 = items[1];
      if (items[2] !== initialItems[2]) fields.item2 = items[2];
      if (items[3] !== initialItems[3]) fields.item3 = items[3];
      await editBinaryRomTrainerFields(sessionId, { structFileOffset, fields });
      setState({ kind: 'saved' });
      pushToast('success', `Trainer "${name}" saved`);
      await scanCurrent();
    } catch (e) {
      const message =
        e instanceof ProjectApiError
          ? `${e.code}: ${e.message}`
          : e instanceof Error
            ? e.message
            : String(e);
      setState({ kind: 'error', message });
      pushToast('error', `Trainer save failed - ${message}`);
    }
  }

  // Phase O.31 - Enter saves, Esc reverts trainer fields.
  const onKeyDownTrainerEdit = useEditFormKeyboard({
    canSave: canSave && state.kind !== 'saving',
    save,
    cancel: () => {
      setName(trainer.name);
      setTrainerClass(initialClass);
      setMusic(initialMusic);
      setPic(initialPic);
      setAiFlags(initialAiFlags);
      setItems(initialItems);
      setState({ kind: 'idle' });
    },
    isSaving: state.kind === 'saving',
  });

  return (
    <div onKeyDown={onKeyDownTrainerEdit}>
      <div className="fields-editor__row fields-editor__row--inline">
        <label>
          Name (≤11 chars)
          <input
            type="text"
            maxLength={11}
            value={name}
            data-testid="trainer-fields-name"
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <label>
          Class
          <EntityPicker
            kind="trainerClass"
            manifest={manifest}
            value={trainerClass}
            onChange={setTrainerClass}
            minId={0}
            maxId={0xff}
            testIdPrefix="trainer-fields-class"
          />
        </label>
      </div>
      <div className="fields-editor__row fields-editor__row--inline">
        <label>
          Battle theme
          <select
            value={music}
            data-testid="trainer-fields-music"
            onChange={(e) => setMusic(Number.parseInt(e.target.value, 10))}
          >
            {TRAINER_ENCOUNTER_MUSIC_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
            {!TRAINER_ENCOUNTER_MUSIC_OPTIONS.some((o) => o.value === music) && (
              <option value={music}>{`${music} - Hack-specific`}</option>
            )}
          </select>
        </label>
        <label>
          Sprite/pic (u8)
          <input
            type="number"
            min={0}
            max={0xff}
            value={pic}
            data-testid="trainer-fields-pic"
            onChange={(e) => setPic(Math.max(0, Math.min(0xff, Number.parseInt(e.target.value, 10) || 0)))}
          />
        </label>
      </div>
      <div className="fields-editor__row">
        <label>
          AI flags (u32, hex)
          <input
            type="text"
            value={`0x${aiFlags.toString(16)}`}
            data-testid="trainer-fields-aiflags"
            onChange={(e) => {
              const v = e.target.value.trim();
              const n = v.startsWith('0x') || v.startsWith('0X') ? parseInt(v, 16) : parseInt(v, 10);
              if (Number.isFinite(n) && n >= 0 && n <= 0xffffffff) setAiFlags(n >>> 0);
            }}
            spellCheck={false}
          />
          <span className="fields-editor__hint">
            {trainer.aiFlags.length > 0 ? trainer.aiFlags.join(' · ') : '(none)'}
          </span>
        </label>
      </div>
      <div className="fields-editor__row fields-editor__row--inline">
        {[0, 1, 2, 3].map((i) => (
          <label key={i}>
            {`Held item ${i + 1}`}
            <EntityPicker
              kind="item"
              manifest={manifest}
              value={items[i] ?? 0}
              onChange={(next) => {
                const arr = [...items];
                arr[i] = next;
                setItems(arr);
              }}
              minId={0}
              maxId={0xffff}
              testIdPrefix={`trainer-fields-item-${i}`}
            />
          </label>
        ))}
      </div>
      <div className="fields-editor__actions">
        <button
          type="button"
          className="btn btn--primary"
          data-testid="trainer-fields-save"
          disabled={!canSave || state.kind === 'saving'}
          onClick={() => void save()}
        >
          {state.kind === 'saving' ? 'Saving…' : 'Save trainer fields'}
        </button>
        {state.kind === 'saved' && !dirty && (
          <span className="fields-editor__status fields-editor__status--saved">
            Saved · ROM patched
          </span>
        )}
        {state.kind === 'error' && (
          <span className="fields-editor__status fields-editor__status--error">
            {state.message}
          </span>
        )}
      </div>
    </div>
  );
}

/** Phase K.4 - inline editor for a trainer party member. */
function TrainerPartyMemberRow({
  member,
  memberIndex,
  trainer,
  manifest,
  showInternalIds,
}: {
  member: TrainerPartyMember;
  memberIndex: number;
  trainer: Trainer;
  manifest: ProjectManifest;
  showInternalIds: boolean;
}) {
  const sessionId = useProjectStore((s) =>
    s.load.kind === 'loaded' ? s.load.data.session.id : null,
  );
  const scanCurrent = useProjectStore((s) => s.scanCurrentProject);
  const [editing, setEditing] = useState(false);
  const initialSpecies =
    Number.parseInt(member.speciesId.replace(/^species_/, ''), 10) || 0;
  const initialHeldItem = member.heldItemId
    ? Number.parseInt(member.heldItemId.replace(/^item_/, ''), 10) || 0
    : 0;
  const initialMoves = [0, 0, 0, 0];
  for (let i = 0; i < Math.min(member.moveIds.length, 4); i++) {
    initialMoves[i] = Number.parseInt(member.moveIds[i]!.replace(/^move_/, ''), 10) || 0;
  }
  const [speciesId, setSpeciesId] = useState(initialSpecies);
  const [level, setLevel] = useState(member.level);
  const [heldItemId, setHeldItemId] = useState(initialHeldItem);
  const [moveIds, setMoveIds] = useState<number[]>(initialMoves);
  const [state, setState] = useState<
    | { kind: 'idle' }
    | { kind: 'saving' }
    | { kind: 'saved' }
    | { kind: 'error'; message: string }
  >({ kind: 'idle' });

  useEffect(() => {
    setSpeciesId(initialSpecies);
    setLevel(member.level);
    setHeldItemId(initialHeldItem);
    setMoveIds([...initialMoves]);
    setState({ kind: 'idle' });
  }, [
    member.fileOffset,
    initialSpecies,
    member.level,
    initialHeldItem,
  ]); // initialMoves not in deps because array identity changes each render - covered by initialSpecies

  const partyFlags =
    typeof trainer.metadata?.['partyFlags'] === 'number'
      ? (trainer.metadata['partyFlags'] as number)
      : 0;
  const hasMoves = (partyFlags & 0x01) !== 0;
  const hasItems = (partyFlags & 0x02) !== 0;
  const canEdit = typeof member.fileOffset === 'number';
  const dirty =
    speciesId !== initialSpecies ||
    level !== member.level ||
    heldItemId !== initialHeldItem ||
    moveIds.some((v, i) => v !== initialMoves[i]);
  const canSave =
    dirty && canEdit && sessionId !== null && state.kind !== 'saving';
  const cancelEdit = (): void => {
    setEditing(false);
    setSpeciesId(initialSpecies);
    setLevel(member.level);
    setHeldItemId(initialHeldItem);
    setMoveIds([...initialMoves]);
    setState({ kind: 'idle' });
  };

  async function save(): Promise<void> {
    if (!sessionId || !canEdit || member.fileOffset === undefined) return;
    setState({ kind: 'saving' });
    try {
      const fields: {
        speciesId?: number;
        level?: number;
        heldItemId?: number;
        moveIds?: ReadonlyArray<number>;
      } = {};
      if (speciesId !== initialSpecies) fields.speciesId = speciesId;
      if (level !== member.level) fields.level = level;
      if (hasItems && heldItemId !== initialHeldItem) fields.heldItemId = heldItemId;
      if (hasMoves && moveIds.some((v, i) => v !== initialMoves[i])) {
        fields.moveIds = moveIds;
      }
      await editBinaryRomTrainerPartyMember(sessionId, {
        memberFileOffset: member.fileOffset,
        partyFlags,
        fields,
      });
      setState({ kind: 'saved' });
      pushToast('success', 'Party member saved');
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
      pushToast('error', `Party member save failed - ${message}`);
    }
  }

  // Phase O.8 - delete handler. Gated on currentPartySize ≥ 2 (Gen-3
  // requires party size ≥ 1) AND on all the metadata fields the route
  // needs being present on the trainer.
  const trainerStructFileOffset =
    typeof trainer.metadata?.['structFileOffset'] === 'number'
      ? (trainer.metadata['structFileOffset'] as number)
      : -1;
  const partyPointer =
    typeof trainer.metadata?.['partyPointer'] === 'number'
      ? (trainer.metadata['partyPointer'] as number)
      : 0;
  const partySize =
    typeof trainer.metadata?.['partySize'] === 'number'
      ? (trainer.metadata['partySize'] as number)
      : trainer.party.length;
  const canDelete =
    trainerStructFileOffset > 0 && partyPointer !== 0 && partySize >= 2;

  async function deleteMember(): Promise<void> {
    if (!sessionId || !canDelete) return;
    if (
      !window.confirm(
        `Delete party member #${String(memberIndex + 1)} (${displayName(manifest, member.speciesId, showInternalIds)})? Subsequent members shift up. Party size will become ${String(partySize - 1)}.`,
      )
    ) {
      return;
    }
    setState({ kind: 'saving' });
    try {
      await editBinaryRomTrainerPartyDelete(sessionId, {
        trainerStructFileOffset,
        currentPartyPointer: partyPointer,
        currentPartySize: partySize,
        memberIndex,
        partyFlags,
      });
      pushToast('success', `Party member #${String(memberIndex + 1)} deleted`);
      await scanCurrent();
    } catch (e) {
      const message =
        e instanceof ProjectApiError
          ? `${e.code}: ${e.message}`
          : e instanceof Error
            ? e.message
            : String(e);
      setState({ kind: 'error', message });
      pushToast('error', `Delete failed - ${message}`);
    }
  }

  // Phase O.27 - Enter saves, Esc cancels. Hook always called for
  // stable identity; passed onKeyDown only used in the editing branch.
  const onKeyDownEdit = useEditFormKeyboard({
    canSave,
    save,
    cancel: cancelEdit,
    isSaving: state.kind === 'saving',
  });

  if (!editing) {
    return (
      <li className="trainer-party-row">
        <div>
          <strong>{displayName(manifest, member.speciesId, showInternalIds)}</strong>
          {' '} - Lv {member.level}
          {canEdit && (
            <button
              type="button"
              className="btn btn--secondary"
              style={{ height: 20, fontSize: 10, padding: '0 8px', marginLeft: 8 }}
              data-testid={`trainer-party-edit-${memberIndex}`}
              onClick={() => setEditing(true)}
            >
              Edit
            </button>
          )}
          {canDelete && (
            <button
              type="button"
              className="btn btn--secondary"
              style={{
                height: 20,
                fontSize: 10,
                padding: '0 8px',
                marginLeft: 4,
                color: 'var(--color-error, #e25555)',
              }}
              data-testid={`trainer-party-delete-${memberIndex}`}
              onClick={() => void deleteMember()}
              disabled={state.kind === 'saving'}
              title="Remove this party member. Subsequent members shift up."
            >
              {state.kind === 'saving' ? '…' : 'Delete'}
            </button>
          )}
        </div>
        {member.heldItemId && (
          <div className="trainer-party-row__detail">
            Holding: {displayName(manifest, member.heldItemId, showInternalIds)}
          </div>
        )}
        {member.moveIds.length > 0 && (
          <div className="trainer-party-row__detail">
            Moves:{' '}
            {member.moveIds
              .map((id) => displayName(manifest, id, showInternalIds))
              .join(', ')}
          </div>
        )}
      </li>
    );
  }
  return (
    <li
      className="trainer-party-row"
      style={{ borderColor: 'var(--color-accent)' }}
      onKeyDown={onKeyDownEdit}
    >
      <div className="fields-editor__row fields-editor__row--inline">
        <label>
          Species
          <EntityPicker
            kind="species"
            manifest={manifest}
            value={speciesId}
            onChange={setSpeciesId}
            minId={0}
            maxId={0xffff}
            testIdPrefix={`trainer-party-${String(memberIndex)}-species`}
          />
        </label>
        <label>
          Level
          <input
            type="number"
            min={1}
            max={100}
            value={level}
            onChange={(e) => setLevel(Math.max(1, Math.min(100, Number.parseInt(e.target.value, 10) || 1)))}
            style={{ width: 50 }}
          />
        </label>
        {hasItems && (
          <label>
            Held item
            <EntityPicker
              kind="item"
              manifest={manifest}
              value={heldItemId}
              onChange={setHeldItemId}
              minId={0}
              maxId={0xffff}
              testIdPrefix={`trainer-party-${String(memberIndex)}-item`}
            />
          </label>
        )}
      </div>
      {hasMoves && (
        <div className="fields-editor__row fields-editor__row--inline" style={{ marginTop: 4 }}>
          {[0, 1, 2, 3].map((i) => (
            <label key={i}>
              {`Move ${i + 1}`}
              <EntityPicker
                kind="move"
                manifest={manifest}
                value={moveIds[i] ?? 0}
                onChange={(next) => {
                  const arr = [...moveIds];
                  arr[i] = next;
                  setMoveIds(arr);
                }}
                minId={0}
                maxId={0xffff}
                testIdPrefix={`trainer-party-${String(memberIndex)}-move-${String(i)}`}
              />
            </label>
          ))}
        </div>
      )}
      <div className="fields-editor__actions">
        <button
          type="button"
          className="btn btn--primary"
          data-testid={`trainer-party-save-${memberIndex}`}
          disabled={!dirty || state.kind === 'saving' || !sessionId}
          onClick={() => void save()}
        >
          {state.kind === 'saving' ? 'Saving…' : 'Save'}
        </button>
        <button
          type="button"
          className="btn btn--secondary"
          onClick={() => {
            setEditing(false);
            setSpeciesId(initialSpecies);
            setLevel(member.level);
            setHeldItemId(initialHeldItem);
            setMoveIds([...initialMoves]);
            setState({ kind: 'idle' });
          }}
        >
          Cancel
        </button>
        {state.kind === 'error' && (
          <span className="fields-editor__status fields-editor__status--error">
            {state.message}
          </span>
        )}
      </div>
    </li>
  );
}

/** Phase O.6 - Add party member button. Pulls the trainer's struct
 *  offset / pointer / size / flags from metadata, then calls the
 *  binary-rom-edit/trainer-party-append route. The route allocates
 *  free ROM space for the larger array, copies existing members,
 *  appends a new one (defaulted to species 1 level 5), and rewrites
 *  the trainer struct's partySize + partyPointer.
 *
 *  Gen-3 max party = 6, so the button gates on currentPartySize < 6
 *  and the required metadata fields being present (lifter coverage). */
function AddPartyMemberButton({ trainer }: { trainer: Trainer }): JSX.Element | null {
  const sessionId = useProjectStore((s) =>
    s.load.kind === 'loaded' ? s.load.data.session.id : null,
  );
  const scanCurrent = useProjectStore((s) => s.scanCurrentProject);
  const [busy, setBusy] = useState(false);
  const structFileOffset =
    typeof trainer.metadata?.['structFileOffset'] === 'number'
      ? (trainer.metadata['structFileOffset'] as number)
      : -1;
  const partyFlags =
    typeof trainer.metadata?.['partyFlags'] === 'number'
      ? (trainer.metadata['partyFlags'] as number)
      : 0;
  const partySize =
    typeof trainer.metadata?.['partySize'] === 'number'
      ? (trainer.metadata['partySize'] as number)
      : trainer.party.length;
  const partyPointer =
    typeof trainer.metadata?.['partyPointer'] === 'number'
      ? (trainer.metadata['partyPointer'] as number)
      : 0;

  if (structFileOffset < 0) {
    // Metadata not lifted - silently render nothing rather than a
    // disabled button that the operator can't fix from the UI.
    return null;
  }
  const canAdd = partySize < 6 && !busy && sessionId !== null;

  async function add(): Promise<void> {
    if (!sessionId || partySize >= 6) return;
    if (
      !window.confirm(
        `Add a 7th party member? The party array will be reallocated in free ROM space; the old slot is left as-is (no compaction).`,
      ) &&
      partySize === 5
    ) {
      // confirmation needed only when growing to 6 - minor friction
    }
    setBusy(true);
    try {
      const r = await editBinaryRomTrainerPartyAppend(sessionId, {
        trainerStructFileOffset: structFileOffset,
        currentPartyPointer: partyPointer,
        currentPartySize: partySize,
        partyFlags,
        newMember: {
          speciesId: 1, // Bulbasaur - default, operator edits after
          level: 5,
        },
      });
      pushToast(
        'success',
        `Party grown to ${String(r.newPartySize)} member${r.newPartySize === 1 ? '' : 's'}`,
      );
      await scanCurrent();
    } catch (e) {
      const message =
        e instanceof ProjectApiError
          ? `${e.code}: ${e.message}`
          : e instanceof Error
            ? e.message
            : String(e);
      pushToast('error', `Add party member failed - ${message}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fields-editor__actions" style={{ marginTop: 8 }}>
      <button
        type="button"
        className="btn btn--secondary"
        disabled={!canAdd}
        onClick={() => void add()}
        data-testid="trainer-party-append"
        title={
          partySize >= 6
            ? 'Party already at Gen-3 max (6 members).'
            : 'Allocate a new party slot in free ROM space and append a default member (Bulbasaur lv5). Edit the slot afterward.'
        }
      >
        {busy ? 'Adding…' : `＋ Add party member (${partySize}/6)`}
      </button>
    </div>
  );
}
