/**
 * Phase 2 (semantic-world plan §2.1/2.2) - editable fields for the
 * MapEditor's right-side inspector.
 *
 * The existing `SelectedInspector` in MapEditor.tsx renders a read-only
 * `<dl>` for the picked object event / warp / trigger, plus a
 * `CoordEditor` for position. This module fills in the remaining
 * editable fields surfaced by the universal vocabulary and patches
 * them via the existing `PATCH /api/projects/:id/events/:kind/:id/fields`
 * route (whitelisted by `app/backend/src/events/patch-fields.ts`):
 *
 *   ObjectEvent  → graphics_id, movement_type, movement_range_x/y,
 *                  elevation, trainer_type, trainer_sight_or_berry_tree_id,
 *                  script, flag
 *   Warp         → dest_map, dest_warp_id, elevation
 *
 * Binary-ROM projects don't yet have a write path through this route
 * (the backend mutates `data/maps/.../map.json` files which only exist
 * for decomp workspaces). We detect binary entities by id prefix
 * (`binary_obj_*` / `binary_warp_*`) and render a disabled note so the
 * operator understands the limitation rather than seeing a silent save
 * failure.
 */

import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import type { ObjectEvent, Warp } from '@rom-editor/shared';
import {
  editBinaryRomMapEventTable,
  editBinaryRomObjectEventFields,
  editBinaryRomObjectEventTable,
  editBinaryRomWarpFields,
  patchEventFields,
  getDecompTrainer,
  editDecompTrainerParty,
  getDecompNames,
  type DecompPartyMon,
  type DecompNames,
  ProjectApiError,
} from '../api';
import { pushToast, useProjectStore, useViewStore } from '../state';
import {
  EntityPicker,
  packMapId,
  unpackMapGroup,
  unpackMapNum,
} from './EntityPicker';
import { useEditFormKeyboard } from '../lib/useEditFormKeyboard';
import { GEN3_MOVEMENT_TYPE_NAMES } from '../lib/displayName';

type SaveState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'saving' }
  | { readonly kind: 'saved' }
  | { readonly kind: 'error'; readonly message: string };

/** Common movement_type values from pokefirered include/constants/movement.h.
 *  Listed here so the dropdown surfaces the popular ones with friendly
 *  labels; free-text entry is still allowed for hack-added enums. */
const MOVEMENT_TYPES: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'MOVEMENT_TYPE_NONE', label: 'None (stationary)' },
  { value: 'MOVEMENT_TYPE_LOOK_AROUND', label: 'Look around' },
  { value: 'MOVEMENT_TYPE_WANDER_AROUND', label: 'Wander around' },
  { value: 'MOVEMENT_TYPE_WANDER_LEFT_AND_RIGHT', label: 'Wander left & right' },
  { value: 'MOVEMENT_TYPE_WANDER_UP_AND_DOWN', label: 'Wander up & down' },
  { value: 'MOVEMENT_TYPE_FACE_DOWN', label: 'Face down' },
  { value: 'MOVEMENT_TYPE_FACE_UP', label: 'Face up' },
  { value: 'MOVEMENT_TYPE_FACE_LEFT', label: 'Face left' },
  { value: 'MOVEMENT_TYPE_FACE_RIGHT', label: 'Face right' },
  { value: 'MOVEMENT_TYPE_FACE_DOWN_AND_LEFT', label: 'Face down-left' },
  { value: 'MOVEMENT_TYPE_FACE_DOWN_AND_RIGHT', label: 'Face down-right' },
  { value: 'MOVEMENT_TYPE_FACE_UP_AND_LEFT', label: 'Face up-left' },
  { value: 'MOVEMENT_TYPE_FACE_UP_AND_RIGHT', label: 'Face up-right' },
  { value: 'MOVEMENT_TYPE_FACE_DOWN_UP_AND_RIGHT', label: 'Face down/up/right' },
  { value: 'MOVEMENT_TYPE_WALK_IN_PLACE_DOWN', label: 'Walk in place - down' },
  { value: 'MOVEMENT_TYPE_WALK_IN_PLACE_UP', label: 'Walk in place - up' },
  { value: 'MOVEMENT_TYPE_WALK_IN_PLACE_LEFT', label: 'Walk in place - left' },
  { value: 'MOVEMENT_TYPE_WALK_IN_PLACE_RIGHT', label: 'Walk in place - right' },
  { value: 'MOVEMENT_TYPE_RAISE_HAND_AND_STOP', label: 'Raise hand & stop' },
  { value: 'MOVEMENT_TYPE_HIDDEN', label: 'Hidden' },
];

/** Common trainer_type values from include/constants/trainer_types.h.
 *  Frequently TRAINER_TYPE_NONE for non-battle NPCs. */
const TRAINER_TYPES: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'TRAINER_TYPE_NONE', label: 'Not a trainer' },
  { value: 'TRAINER_TYPE_NORMAL', label: 'Normal trainer (line-of-sight)' },
  { value: 'TRAINER_TYPE_SEE_ALL_DIRECTIONS', label: 'Sees all directions' },
  { value: 'TRAINER_TYPE_BURIED', label: 'Buried (rock smash trainer)' },
];

/** Phase O.40 - numeric trainer_type variants for binary-ROM NPCs.
 *  Mirrors TRAINER_TYPES above for the decomp path; binary editors
 *  store the byte directly so we surface labeled u8 values instead
 *  of the string constants. Trainer_type is technically u16 in the
 *  ObjectEventTemplate but vanilla only ever uses the bottom byte. */
const BINARY_TRAINER_TYPE_OPTIONS: ReadonlyArray<{
  value: number;
  label: string;
}> = [
  { value: 0, label: '0 - Not a trainer' },
  { value: 1, label: '1 - Normal trainer (line-of-sight)' },
  { value: 2, label: '2 - Sees all directions' },
  { value: 3, label: '3 - Buried (rock smash trainer)' },
];

/** Phase O.41 - common OBJ_EVENT_GFX_* values labeled for the
 *  binary-ROM ObjectEvent editor. FRLG-leaning per
 *  pret/pokefirered/include/constants/event_objects.h. Hack ROMs
 *  reuse slots differently; non-listed values render as
 *  "<n> - Hack-specific" via the same passthrough as the bg-event
 *  kind / battle-theme / movement-type / trainer-type dropdowns.
 *
 *  Curated to ~25 semantically clear NPCs that are universal across
 *  FRLG/Emerald style ROMs. Special-object slots (boulder, cut tree,
 *  berry tree) vary too much across games to label safely without
 *  ROM-fingerprint dispatch - left for a later phase. */
const BINARY_GRAPHICS_ID_OPTIONS: ReadonlyArray<{
  value: number;
  label: string;
}> = [
  { value: 0, label: '0 - Player (normal)' },
  { value: 7, label: '7 - Player alt (Leaf in FRLG)' },
  { value: 14, label: '14 - Little boy' },
  { value: 15, label: '15 - Little girl' },
  { value: 16, label: '16 - Youngster' },
  { value: 17, label: '17 - Boy' },
  { value: 18, label: '18 - Lass / pretty girl' },
  { value: 19, label: '19 - Woman (var 1)' },
  { value: 20, label: '20 - Fat man' },
  { value: 22, label: '22 - Man' },
  { value: 23, label: '23 - Woman (var 2)' },
  { value: 24, label: '24 - Old man' },
  { value: 25, label: '25 - Old woman' },
  { value: 26, label: '26 - Camper' },
  { value: 27, label: '27 - Picnicker' },
  { value: 32, label: '32 - Girl' },
  { value: 34, label: '34 - Bug catcher' },
  { value: 38, label: '38 - Black belt' },
  { value: 39, label: '39 - Receptionist (mart / center)' },
  { value: 42, label: '42 - Gentleman' },
  { value: 43, label: '43 - Nurse' },
  { value: 45, label: '45 - Prof. Oak' },
  { value: 48, label: '48 - Hiker' },
  { value: 49, label: '49 - Sailor' },
];

/** Decomp-only check: true when the entity originated from a binary ROM
 *  scan, where map.json doesn't exist so the PATCH route can't land. */
function isBinaryRomEntityId(id: string): boolean {
  return id.startsWith('binary_');
}

function renderSaveState(state: SaveState): JSX.Element | null {
  switch (state.kind) {
    case 'idle':
      return null;
    case 'saving':
      return <span className="fields-editor__status fields-editor__status--saving">Saving…</span>;
    case 'saved':
      return <span className="fields-editor__status fields-editor__status--saved">Saved</span>;
    case 'error':
      return (
        <span className="fields-editor__status fields-editor__status--error" title={state.message}>
          Error: {state.message}
        </span>
      );
  }
}

interface ObjectEventFieldsEditorProps {
  readonly objectEvent: ObjectEvent;
  readonly sessionId: string | null;
}

export function ObjectEventFieldsEditor({
  objectEvent,
  sessionId,
}: ObjectEventFieldsEditorProps): JSX.Element {
  const scanCurrent = useProjectStore((s) => s.scanCurrentProject);
  const binaryRom = isBinaryRomEntityId(objectEvent.id);

  // Pull current field values out of the entity's metadata. These mirror
  // the keys the backend whitelist accepts so we can round-trip cleanly.
  const initialGraphicsId =
    typeof objectEvent.graphicsId === 'string' ? objectEvent.graphicsId : '';
  const initialMovementType =
    typeof objectEvent.movementType === 'string' ? objectEvent.movementType : '';
  const initialMovementRangeX = readNumberMetadata(objectEvent, 'movement_range_x');
  const initialMovementRangeY = readNumberMetadata(objectEvent, 'movement_range_y');
  const initialFlag = typeof objectEvent.flagId === 'string' ? objectEvent.flagId : '';
  const initialScript = typeof objectEvent.scriptId === 'string' ? objectEvent.scriptId : '';
  const initialTrainerType =
    typeof objectEvent.trainerType === 'string' ? objectEvent.trainerType : '';
  const initialTrainerSight = readNumberMetadata(
    objectEvent,
    'trainer_sight_or_berry_tree_id',
  );
  const initialElevation = objectEvent.elevation;

  const [graphicsId, setGraphicsId] = useState(initialGraphicsId);
  const [movementType, setMovementType] = useState(initialMovementType);
  const [movementRangeX, setMovementRangeX] = useState(initialMovementRangeX);
  const [movementRangeY, setMovementRangeY] = useState(initialMovementRangeY);
  const [flag, setFlag] = useState(initialFlag);
  const [script, setScript] = useState(initialScript);
  const [trainerType, setTrainerType] = useState(initialTrainerType);
  const [trainerSight, setTrainerSight] = useState(initialTrainerSight);
  const [elevation, setElevation] = useState(initialElevation);
  const [state, setState] = useState<SaveState>({ kind: 'idle' });

  useEffect(() => {
    setGraphicsId(initialGraphicsId);
    setMovementType(initialMovementType);
    setMovementRangeX(initialMovementRangeX);
    setMovementRangeY(initialMovementRangeY);
    setFlag(initialFlag);
    setScript(initialScript);
    setTrainerType(initialTrainerType);
    setTrainerSight(initialTrainerSight);
    setElevation(initialElevation);
    setState({ kind: 'idle' });
  }, [
    initialGraphicsId,
    initialMovementType,
    initialMovementRangeX,
    initialMovementRangeY,
    initialFlag,
    initialScript,
    initialTrainerType,
    initialTrainerSight,
    initialElevation,
  ]);

  const dirty = useMemo(() => {
    return (
      graphicsId !== initialGraphicsId ||
      movementType !== initialMovementType ||
      movementRangeX !== initialMovementRangeX ||
      movementRangeY !== initialMovementRangeY ||
      flag !== initialFlag ||
      script !== initialScript ||
      trainerType !== initialTrainerType ||
      trainerSight !== initialTrainerSight ||
      elevation !== initialElevation
    );
  }, [
    graphicsId,
    initialGraphicsId,
    movementType,
    initialMovementType,
    movementRangeX,
    initialMovementRangeX,
    movementRangeY,
    initialMovementRangeY,
    flag,
    initialFlag,
    script,
    initialScript,
    trainerType,
    initialTrainerType,
    trainerSight,
    initialTrainerSight,
    elevation,
    initialElevation,
  ]);

  const save = useCallback(async () => {
    if (!sessionId || !dirty || binaryRom) return;
    setState({ kind: 'saving' });
    try {
      // Build the diff: only send fields that changed so we don't
      // overwrite unrelated values with current-buffer state on race.
      const fields: Record<string, string | number | boolean | null> = {};
      if (graphicsId !== initialGraphicsId) fields.graphics_id = graphicsId;
      if (movementType !== initialMovementType) fields.movement_type = movementType;
      if (movementRangeX !== initialMovementRangeX)
        fields.movement_range_x = movementRangeX;
      if (movementRangeY !== initialMovementRangeY)
        fields.movement_range_y = movementRangeY;
      if (flag !== initialFlag) fields.flag = flag;
      if (script !== initialScript) fields.script = script;
      if (trainerType !== initialTrainerType) fields.trainer_type = trainerType;
      if (trainerSight !== initialTrainerSight)
        fields.trainer_sight_or_berry_tree_id = trainerSight;
      if (elevation !== initialElevation) fields.elevation = elevation;
      await patchEventFields(sessionId, 'objectEvent', objectEvent.id, fields);
      setState({ kind: 'saved' });
      await scanCurrent();
    } catch (e) {
      setState({ kind: 'error', message: extractErrorMessage(e) });
    }
  }, [
    binaryRom,
    dirty,
    elevation,
    flag,
    graphicsId,
    initialElevation,
    initialFlag,
    initialGraphicsId,
    initialMovementRangeX,
    initialMovementRangeY,
    initialMovementType,
    initialScript,
    initialTrainerSight,
    initialTrainerType,
    movementRangeX,
    movementRangeY,
    movementType,
    objectEvent.id,
    scanCurrent,
    script,
    sessionId,
    trainerSight,
    trainerType,
  ]);

  if (binaryRom) {
    // Phase G-RC5 (semantic-world plan §G.5) - binary-ROM ObjectEvent
    // edits land via a separate route + numeric byte-level form. The
    // decomp form's MOVEMENT_TYPE_* constants don't apply since the
    // ROM stores these as u8 bytes (graphicsId, movementType) and u16s
    // (trainerType, flagId, script pointer). See BinaryRomObjectEventEditor
    // below for the byte-editing variant.
    return <BinaryRomObjectEventEditor objectEvent={objectEvent} sessionId={sessionId} />;
  }

  return (
    <div className="fields-editor" data-testid="object-event-fields-editor">
      <h4 className="fields-editor__heading">Edit fields</h4>
      <div className="fields-editor__row">
        <label>
          Sprite (graphics_id)
          <input
            type="text"
            value={graphicsId}
            onChange={(e) => setGraphicsId(e.target.value)}
            placeholder="OBJ_EVENT_GFX_..."
            spellCheck={false}
            data-testid="obj-graphics-id"
          />
        </label>
      </div>
      <div className="fields-editor__row">
        <label>
          Movement
          <select
            value={MOVEMENT_TYPES.some((m) => m.value === movementType) ? movementType : ''}
            onChange={(e) => setMovementType(e.target.value)}
            data-testid="obj-movement-type"
          >
            <option value=""> - Custom (see text below) - </option>
            {MOVEMENT_TYPES.map((m) => (
              <option key={m.value} value={m.value}>
                {m.label}
              </option>
            ))}
          </select>
        </label>
        <input
          type="text"
          value={movementType}
          onChange={(e) => setMovementType(e.target.value)}
          placeholder="MOVEMENT_TYPE_..."
          spellCheck={false}
          data-testid="obj-movement-type-text"
        />
      </div>
      <div className="fields-editor__row fields-editor__row--inline">
        <label>
          Range X
          <input
            type="number"
            value={movementRangeX}
            onChange={(e) => setMovementRangeX(parseIntSafe(e.target.value, 0))}
            min={0}
            max={31}
            data-testid="obj-range-x"
          />
        </label>
        <label>
          Range Y
          <input
            type="number"
            value={movementRangeY}
            onChange={(e) => setMovementRangeY(parseIntSafe(e.target.value, 0))}
            min={0}
            max={31}
            data-testid="obj-range-y"
          />
        </label>
        <label>
          Elevation
          <input
            type="number"
            value={elevation}
            onChange={(e) => setElevation(parseIntSafe(e.target.value, 0))}
            min={0}
            max={15}
            data-testid="obj-elevation"
          />
        </label>
      </div>
      <div className="fields-editor__row">
        <label>
          Script
          <input
            type="text"
            value={script}
            onChange={(e) => setScript(e.target.value)}
            placeholder="MyMap_EventScript_NPC"
            spellCheck={false}
            data-testid="obj-script"
          />
        </label>
      </div>
      <div className="fields-editor__row">
        <label>
          Visibility flag
          <input
            type="text"
            value={flag}
            onChange={(e) => setFlag(e.target.value)}
            placeholder="FLAG_HIDE_NPC_X (or 0)"
            spellCheck={false}
            data-testid="obj-flag"
          />
        </label>
      </div>
      <div className="fields-editor__row">
        <label>
          Trainer
          <select
            value={TRAINER_TYPES.some((t) => t.value === trainerType) ? trainerType : ''}
            onChange={(e) => setTrainerType(e.target.value)}
            data-testid="obj-trainer-type"
          >
            <option value=""> - Custom - </option>
            {TRAINER_TYPES.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Sight range
          <input
            type="number"
            value={trainerSight}
            onChange={(e) => setTrainerSight(parseIntSafe(e.target.value, 0))}
            min={0}
            max={255}
            data-testid="obj-trainer-sight"
          />
        </label>
      </div>
      <div className="fields-editor__actions">
        <button
          type="button"
          className="btn btn--primary"
          onClick={() => void save()}
          disabled={!dirty || !sessionId || state.kind === 'saving'}
          data-testid="object-event-fields-save"
        >
          Save
        </button>
        {renderSaveState(state)}
      </div>
      <TrainerTeamEditor objectEvent={objectEvent} sessionId={sessionId} />
    </div>
  );
}

/** True when this object event is a battling trainer (decomp). */
function isTrainerNpc(objectEvent: ObjectEvent): boolean {
  const t = objectEvent.trainerType;
  return typeof t === 'string' && t.length > 0 && t !== 'TRAINER_TYPE_NONE';
}

// Project-global name lists (species/moves/items/abilities) are the same for
// every trainer, so fetch once per session and share across all team editors.
const decompNamesCache = new Map<string, DecompNames>();
const decompNamesInflight = new Map<string, Promise<DecompNames>>();

function useDecompNames(sessionId: string | null): DecompNames | null {
  const [names, setNames] = useState<DecompNames | null>(
    sessionId ? decompNamesCache.get(sessionId) ?? null : null,
  );
  useEffect(() => {
    if (!sessionId) {
      setNames(null);
      return;
    }
    const cached = decompNamesCache.get(sessionId);
    if (cached) {
      setNames(cached);
      return;
    }
    let cancelled = false;
    let p = decompNamesInflight.get(sessionId);
    if (!p) {
      p = getDecompNames(sessionId).then((n) => {
        decompNamesCache.set(sessionId, n);
        decompNamesInflight.delete(sessionId);
        return n;
      });
      decompNamesInflight.set(sessionId, p);
    }
    p.then((n) => {
      if (!cancelled) setNames(n);
    }).catch(() => {
      decompNamesInflight.delete(sessionId);
    });
    return () => {
      cancelled = true;
    };
  }, [sessionId]);
  return names;
}

/**
 * The four `<datalist>`s that back the team editor's autocomplete. Memoized:
 * the option lists are large (~3.5k entries) and depend only on `names`, so
 * they must not re-render as the user types in a party field.
 */
const TeamNameDatalists = memo(function TeamNameDatalists({
  names,
}: {
  names: DecompNames | null;
}): JSX.Element | null {
  if (!names) return null;
  return (
    <>
      <datalist id="team-species-names">
        {names.species.map((n) => (
          <option key={n} value={n} />
        ))}
      </datalist>
      <datalist id="team-move-names">
        {names.moves.map((n) => (
          <option key={n} value={n} />
        ))}
      </datalist>
      <datalist id="team-item-names">
        {names.items.map((n) => (
          <option key={n} value={n} />
        ))}
      </datalist>
      <datalist id="team-ability-names">
        {names.abilities.map((n) => (
          <option key={n} value={n} />
        ))}
      </datalist>
    </>
  );
});

/**
 * In-context trainer TEAM editor for decomp `.party` projects. Resolves the
 * trainer this NPC battles from its script label, loads the human-readable
 * party from src/data/trainers.party, and writes edits straight back to that
 * source file. Names round-trip verbatim (no SPECIES_/MOVE_ constant mapping).
 */
function TrainerTeamEditor({
  objectEvent,
  sessionId,
}: {
  objectEvent: ObjectEvent;
  sessionId: string | null;
}): JSX.Element | null {
  const scanCurrent = useProjectStore((s) => s.scanCurrentProject);
  const names = useDecompNames(sessionId);
  const [trainerId, setTrainerId] = useState<string | null>(null);
  const [trainerName, setTrainerName] = useState<string | null>(null);
  const [className, setClassName] = useState<string | null>(null);
  const [party, setParty] = useState<DecompPartyMon[] | null>(null);
  const [load, setLoad] = useState<'idle' | 'loading' | 'loaded' | 'none' | 'error'>('idle');
  const [dirty, setDirty] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>({ kind: 'idle' });

  useEffect(() => {
    let cancelled = false;
    if (!sessionId || !isTrainerNpc(objectEvent) || !objectEvent.scriptId) {
      setLoad('none');
      setParty(null);
      return;
    }
    setLoad('loading');
    setDirty(false);
    setSaveState({ kind: 'idle' });
    getDecompTrainer(sessionId, {
      script: objectEvent.scriptId,
      mapId: typeof objectEvent.mapId === 'string' ? objectEvent.mapId : undefined,
    })
      .then((res) => {
        if (cancelled) return;
        if (res.resolved && res.trainer) {
          setTrainerId(res.trainerId);
          setTrainerName(res.trainer.name);
          setClassName(res.trainer.className);
          setParty(
            res.trainer.party.map((m) => ({
              ...m,
              moves: [...m.moves],
              extraLines: [...m.extraLines],
            })),
          );
          setLoad('loaded');
        } else {
          setLoad('none');
          setParty(null);
        }
      })
      .catch(() => {
        if (!cancelled) setLoad('error');
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, objectEvent.id, objectEvent.scriptId, objectEvent.mapId, objectEvent.trainerType]);

  if (!isTrainerNpc(objectEvent)) return null;

  const updateMon = (i: number, patch: Partial<DecompPartyMon>): void => {
    setParty((prev) => (prev ? prev.map((m, idx) => (idx === i ? { ...m, ...patch } : m)) : prev));
    setDirty(true);
  };
  const updateMove = (i: number, mi: number, value: string): void => {
    setParty((prev) =>
      prev
        ? prev.map((m, idx) => {
            if (idx !== i) return m;
            const moves = [...m.moves];
            while (moves.length <= mi) moves.push('');
            moves[mi] = value;
            return { ...m, moves };
          })
        : prev,
    );
    setDirty(true);
  };
  const removeMon = (i: number): void => {
    setParty((prev) => (prev ? prev.filter((_, idx) => idx !== i) : prev));
    setDirty(true);
  };
  const addMon = (): void => {
    setParty((prev) =>
      prev
        ? [
            ...prev,
            {
              species: 'Rattata',
              heldItem: null,
              level: 5,
              ivs: null,
              evs: null,
              ability: null,
              nature: null,
              moves: [],
              extraLines: [],
            },
          ]
        : prev,
    );
    setDirty(true);
  };

  const doSave = async (): Promise<void> => {
    if (!sessionId || !trainerId || !party) return;
    setSaveState({ kind: 'saving' });
    try {
      const cleaned = party.map((m) => ({
        ...m,
        species: m.species.trim(),
        heldItem: m.heldItem && m.heldItem.trim() ? m.heldItem.trim() : null,
        ability: m.ability && m.ability.trim() ? m.ability.trim() : null,
        moves: m.moves.map((x) => x.trim()).filter((x) => x.length > 0),
      }));
      await editDecompTrainerParty(sessionId, trainerId, cleaned);
      setSaveState({ kind: 'saved' });
      setDirty(false);
      await scanCurrent();
    } catch (e) {
      setSaveState({ kind: 'error', message: extractErrorMessage(e) });
    }
  };

  return (
    <div className="fields-editor" data-testid="trainer-team-editor" style={{ marginTop: 12 }}>
      <h4 className="fields-editor__heading">
        Team{className ? ` - ${className}` : ''}
        {trainerName ? ` ${trainerName}` : ''}
      </h4>
      {load === 'loading' && <p className="fields-editor__note">Loading team…</p>}
      {load === 'error' && <p className="fields-editor__note">Couldn't load the team.</p>}
      {load === 'none' && (
        <p className="fields-editor__note">
          Couldn't trace this NPC to a trainer in <code>src/data/trainers.party</code> (its
          script may battle no one, or this isn't an expansion .party project).
        </p>
      )}
      {load === 'loaded' && party && (
        <>
          <TeamNameDatalists names={names} />
          {party.map((mon, i) => (
            <div
              key={i}
              className="fields-editor__row"
              style={{
                flexDirection: 'column',
                alignItems: 'stretch',
                gap: 4,
                borderTop: '1px solid var(--border-subtle, #2a2a2a)',
                paddingTop: 6,
                marginTop: 4,
              }}
            >
              <div className="fields-editor__row fields-editor__row--inline">
                <label>
                  Pokémon
                  <input
                    type="text"
                    value={mon.species}
                    spellCheck={false}
                    list="team-species-names"
                    onChange={(e) => updateMon(i, { species: e.target.value })}
                    placeholder="Rattata"
                    data-testid={`team-${i}-species`}
                  />
                </label>
                <label>
                  Level
                  <input
                    type="number"
                    min={1}
                    max={100}
                    value={mon.level ?? 0}
                    onChange={(e) => updateMon(i, { level: parseIntSafe(e.target.value, 1) })}
                    data-testid={`team-${i}-level`}
                  />
                </label>
              </div>
              <div className="fields-editor__row fields-editor__row--inline">
                <label>
                  Held item
                  <input
                    type="text"
                    value={mon.heldItem ?? ''}
                    spellCheck={false}
                    list="team-item-names"
                    onChange={(e) => updateMon(i, { heldItem: e.target.value })}
                    placeholder="(none)"
                  />
                </label>
                <label>
                  Ability
                  <input
                    type="text"
                    value={mon.ability ?? ''}
                    spellCheck={false}
                    list="team-ability-names"
                    onChange={(e) => updateMon(i, { ability: e.target.value })}
                    placeholder="(default)"
                  />
                </label>
              </div>
              <label>
                Moves (leave blank for level-up defaults)
                <div className="fields-editor__row fields-editor__row--inline">
                  {[0, 1, 2, 3].map((mi) => (
                    <input
                      key={mi}
                      type="text"
                      value={mon.moves[mi] ?? ''}
                      spellCheck={false}
                      list="team-move-names"
                      onChange={(e) => updateMove(i, mi, e.target.value)}
                      placeholder={`Move ${mi + 1}`}
                      data-testid={`team-${i}-move-${mi}`}
                    />
                  ))}
                </div>
              </label>
              <button
                type="button"
                className="btn btn--secondary"
                onClick={() => removeMon(i)}
                style={{ color: 'var(--color-error, #e25555)', alignSelf: 'flex-start' }}
              >
                Remove
              </button>
            </div>
          ))}
          <div className="fields-editor__actions" style={{ marginTop: 8 }}>
            <button type="button" className="btn btn--secondary" onClick={addMon}>
              + Add Pokémon
            </button>
            <button
              type="button"
              className="btn btn--primary"
              onClick={() => void doSave()}
              disabled={!dirty || !sessionId || saveState.kind === 'saving'}
              data-testid="trainer-team-save"
            >
              Save team
            </button>
            {renderSaveState(saveState)}
          </div>
          <p className="fields-editor__note">
            Writes to <code>src/data/trainers.party</code>. Build &amp; play to see it in-game.
          </p>
        </>
      )}
    </div>
  );
}

interface WarpFieldsEditorProps {
  readonly warp: Warp;
  readonly sessionId: string | null;
}

/**
 * Minimal warp editor - only the destination map is wired, since the
 * manifest's Warp shape currently surfaces `toMapId` + `toCoord` but
 * not the dest-warp-slot index that the backend whitelist's
 * `dest_warp_id` references. Surfacing dest_warp_id + elevation needs
 * a manifest extension (Phase 2 follow-up).
 */
export function WarpFieldsEditor({ warp, sessionId }: WarpFieldsEditorProps): JSX.Element {
  const scanCurrent = useProjectStore((s) => s.scanCurrentProject);
  const openMapInEditor = useViewStore((s) => s.openMapInEditor);
  // Phase O.78 - the previous hasDestMap check only validated that
  // toMapId was a non-empty string. But MAP_UNKNOWN (decomp's
  // fallback when dest_map is missing) and binary_map_255_<num> (the
  // Gen-3 "previous map" sentinel used by Pokémon Center / Mart
  // exits) both pass that check yet point at no real lifted map. The
  // user saw the maps list pop up instead of the destination editor.
  // Fix: cross-check the lookup against the actual manifest.maps[]
  // before enabling the button, and surface a clear note when the
  // destination doesn't resolve.
  const manifest = useProjectStore((s) =>
    s.scan.kind === 'loaded' ? s.scan.data.manifest : null,
  );
  const binaryRom = isBinaryRomEntityId(warp.id);

  const initialDestMap = warp.toMapId ?? '';
  const [destMap, setDestMap] = useState(initialDestMap);
  const [state, setState] = useState<SaveState>({ kind: 'idle' });

  useEffect(() => {
    setDestMap(initialDestMap);
    setState({ kind: 'idle' });
  }, [initialDestMap]);

  const dirty = destMap !== initialDestMap;
  const hasDestMapId = warp.toMapId !== null && warp.toMapId.length > 0;
  const destMapInManifest =
    hasDestMapId && manifest
      ? manifest.maps.some((m) => m.id === warp.toMapId)
      : false;
  const hasDestMap = destMapInManifest;
  // Only flag the destination as "unresolved" when we have a manifest
  // to actually check against. When manifest is null (project not yet
  // scanned) we don't know - stay silent.
  const destMapUnresolved =
    manifest !== null && hasDestMapId && !destMapInManifest;

  const save = useCallback(async () => {
    if (!sessionId || !dirty || binaryRom) return;
    setState({ kind: 'saving' });
    try {
      await patchEventFields(sessionId, 'warp', warp.id, { dest_map: destMap });
      setState({ kind: 'saved' });
      await scanCurrent();
    } catch (e) {
      setState({ kind: 'error', message: extractErrorMessage(e) });
    }
  }, [binaryRom, destMap, dirty, scanCurrent, sessionId, warp.id]);

  // Phase H-RC3: jump to destination map. Works for both binary-rom
  // and decomp warps - it just routes the editor to a different map.
  const openDestination = useCallback(() => {
    if (!destMapInManifest) return;
    openMapInEditor(warp.toMapId);
  }, [destMapInManifest, openMapInEditor, warp.toMapId]);

  if (binaryRom) {
    return (
      <BinaryRomWarpExtras
        warp={warp}
        sessionId={sessionId}
        openDestination={openDestination}
        hasDestMap={hasDestMap}
      />
    );
  }

  return (
    <div className="fields-editor" data-testid="warp-fields-editor">
      <h4 className="fields-editor__heading">Edit fields</h4>
      <div className="fields-editor__row">
        <label>
          Destination map
          <input
            type="text"
            value={destMap}
            onChange={(e) => setDestMap(e.target.value)}
            placeholder="MAP_PALLET_TOWN"
            spellCheck={false}
            data-testid="warp-dest-map"
          />
        </label>
      </div>
      <div className="fields-editor__actions">
        <button
          type="button"
          className="btn btn--primary"
          onClick={() => void save()}
          disabled={!dirty || !sessionId || state.kind === 'saving'}
          data-testid="warp-fields-save"
        >
          Save
        </button>
        {hasDestMap && (
          <button
            type="button"
            className="btn btn--secondary"
            onClick={openDestination}
            data-testid="warp-open-destination"
          >
            → Open destination
          </button>
        )}
        {destMapUnresolved && (
          <span
            className="fields-editor__hint fields-editor__hint--warn"
            data-testid="warp-dest-unresolved"
          >
            Destination map "{warp.toMapId}" isn't lifted in this project - likely
            a "previous map" sentinel (Pokémon Center / Mart exits) or a hack-ROM
            stub. Edit the dest_map field above to repoint it.
          </span>
        )}
        {renderSaveState(state)}
      </div>
    </div>
  );
}

function readNumberMetadata(
  entity: { readonly metadata: Readonly<Record<string, unknown>> },
  key: string,
): number {
  const v = entity.metadata[key];
  if (typeof v === 'number') return v;
  // Decomp map.json quotes some numeric fields (e.g. trainer sight range) as
  // strings ("2"); coerce so they don't read as 0 on decomp projects.
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return 0;
}

/** Phase K.2 - binary-ROM warp extras: open destination + Delete button.
 *  Delete uses /binary-rom-edit/map-event-table to remove the 8-byte
 *  warp slot from the table. Requires the warp's structFileOffset on
 *  metadata + the parent map's MapEvents + warpsArrayOffset metadata. */
function BinaryRomWarpExtras({
  warp,
  sessionId,
  openDestination,
  hasDestMap,
}: {
  warp: Warp;
  sessionId: string | null;
  openDestination: () => void;
  hasDestMap: boolean;
}): JSX.Element {
  const scanCurrent = useProjectStore((s) => s.scanCurrentProject);
  const manifest = useProjectStore((s) =>
    s.scan.kind === 'loaded' ? s.scan.data.manifest : null,
  );
  const parentMap = manifest?.maps.find((m) => m.id === warp.fromMapId) ?? null;
  const meta = warp.metadata ?? {};
  const warpStructFileOffset =
    typeof meta['structFileOffset'] === 'number' ? (meta['structFileOffset'] as number) : -1;
  const initialDestMapGroup =
    typeof meta['destMapGroup'] === 'number' ? (meta['destMapGroup'] as number) : 0;
  const initialDestMapNum =
    typeof meta['destMapNum'] === 'number' ? (meta['destMapNum'] as number) : 0;
  const initialWarpId =
    typeof meta['warpId'] === 'number' ? (meta['warpId'] as number) : 0;
  const initialElevation =
    typeof meta['elevation'] === 'number' ? (meta['elevation'] as number) : 0;
  const mapEventsStructOffset =
    parentMap && typeof parentMap.metadata['binaryRomMapEventsStructOffset'] === 'number'
      ? (parentMap.metadata['binaryRomMapEventsStructOffset'] as number)
      : -1;
  const warpsArrayOffset =
    parentMap && typeof parentMap.metadata['binaryRomWarpsArrayOffset'] === 'number'
      ? (parentMap.metadata['binaryRomWarpsArrayOffset'] as number)
      : -1;
  const canDelete =
    warpStructFileOffset > 0 && mapEventsStructOffset > 0 && warpsArrayOffset > 0;
  const canEdit = warpStructFileOffset > 0 && manifest !== null;
  const [destMapGroup, setDestMapGroup] = useState(initialDestMapGroup);
  const [destMapNum, setDestMapNum] = useState(initialDestMapNum);
  const [warpId, setWarpId] = useState(initialWarpId);
  const [elevation, setElevation] = useState(initialElevation);
  const [state, setState] = useState<SaveState>({ kind: 'idle' });
  useEffect(() => {
    setDestMapGroup(initialDestMapGroup);
    setDestMapNum(initialDestMapNum);
    setWarpId(initialWarpId);
    setElevation(initialElevation);
    setState({ kind: 'idle' });
  }, [
    warpStructFileOffset,
    initialDestMapGroup,
    initialDestMapNum,
    initialWarpId,
    initialElevation,
  ]);
  const dirty =
    destMapGroup !== initialDestMapGroup ||
    destMapNum !== initialDestMapNum ||
    warpId !== initialWarpId ||
    elevation !== initialElevation;

  async function save(): Promise<void> {
    if (!sessionId || !dirty) return;
    setState({ kind: 'saving' });
    try {
      const fields: {
        destMapGroup?: number;
        destMapNum?: number;
        warpId?: number;
        elevation?: number;
      } = {};
      if (destMapGroup !== initialDestMapGroup) fields.destMapGroup = destMapGroup;
      if (destMapNum !== initialDestMapNum) fields.destMapNum = destMapNum;
      if (warpId !== initialWarpId) fields.warpId = warpId;
      if (elevation !== initialElevation) fields.elevation = elevation;
      await editBinaryRomWarpFields(sessionId, {
        structFileOffset: warpStructFileOffset,
        fields,
      });
      setState({ kind: 'saved' });
      pushToast('success', 'Warp destination saved');
      await scanCurrent();
    } catch (e) {
      const msg = extractErrorMessage(e);
      setState({ kind: 'error', message: msg });
      pushToast('error', `Warp save failed - ${msg}`);
    }
  }

  // Phase O.28 - Enter saves, Esc cancels.
  const canSave =
    dirty && canEdit && sessionId !== null && state.kind !== 'saving';
  const cancelEdit = (): void => {
    setDestMapGroup(initialDestMapGroup);
    setDestMapNum(initialDestMapNum);
    setWarpId(initialWarpId);
    setElevation(initialElevation);
    setState({ kind: 'idle' });
  };
  const onKeyDownEdit = useEditFormKeyboard({
    canSave,
    save,
    cancel: cancelEdit,
    isSaving: state.kind === 'saving',
  });

  return (
    <div
      className="fields-editor"
      data-testid="binary-rom-warp-fields-editor"
      onKeyDown={onKeyDownEdit}
    >
      <h4 className="fields-editor__heading">
        Edit warp destination
      </h4>
      {canEdit && manifest !== null ? (
        <>
          <div className="fields-editor__row">
            <label>
              Destination map
              <EntityPicker
                kind="map"
                manifest={manifest}
                value={packMapId(destMapGroup, destMapNum)}
                onChange={(next) => {
                  setDestMapGroup(unpackMapGroup(next));
                  setDestMapNum(unpackMapNum(next));
                }}
                minId={0}
                maxId={0xffff}
                testIdPrefix="warp-dest-map"
              />
            </label>
          </div>
          <div className="fields-editor__row fields-editor__row--inline">
            <label>
              Dest warp id (u8)
              <input
                type="number"
                min={0}
                max={0xff}
                value={warpId}
                onChange={(e) =>
                  setWarpId(
                    Math.max(0, Math.min(0xff, Number.parseInt(e.target.value, 10) || 0)),
                  )
                }
                data-testid="warp-warp-id"
              />
            </label>
            <label>
              Elevation (u8)
              <input
                type="number"
                min={0}
                max={0xff}
                value={elevation}
                onChange={(e) =>
                  setElevation(
                    Math.max(0, Math.min(0xff, Number.parseInt(e.target.value, 10) || 0)),
                  )
                }
                data-testid="warp-elevation"
              />
            </label>
          </div>
        </>
      ) : (
        <p className="fields-editor__note">
          This warp has no struct file offset on its metadata - re-scan
          the project after a recent lifter update to enable field editing.
        </p>
      )}
      <div className="fields-editor__actions" style={{ marginTop: 8 }}>
        {canEdit && (
          <button
            type="button"
            className="btn btn--primary"
            data-testid="warp-fields-save"
            disabled={!dirty || !sessionId || state.kind === 'saving'}
            onClick={() => void save()}
          >
            {state.kind === 'saving' ? 'Saving…' : 'Save destination'}
          </button>
        )}
        {hasDestMap && (
          <button
            type="button"
            className="btn btn--secondary"
            onClick={openDestination}
            data-testid="warp-open-destination"
          >
            → Open destination map
          </button>
        )}
        {/* Phase O.78 - surface the unresolved-destination warning
            for the binary-rom branch too. `manifest` is already in
            scope from the parentMap lookup. */}
        {!hasDestMap &&
          warp.toMapId &&
          warp.toMapId.length > 0 &&
          manifest !== null &&
          !manifest.maps.some((m) => m.id === warp.toMapId) && (
            <span
              className="fields-editor__hint fields-editor__hint--warn"
              data-testid="warp-dest-unresolved"
            >
              Destination map "{warp.toMapId}" isn't in the lifted manifest - 
              this is usually a Pokémon Center / Mart exit using the Gen-3
              "previous map" sentinel (group=255). Re-point via the
              destination dropdown above to use a static map.
            </span>
          )}
        {/* Phase O.36 - Duplicate warp. Appends a new 8-byte warp slot
            using current form values + (+1, 0) tile offset. Mirrors
            the O.35 ObjectEvent Duplicate pattern. */}
        {canDelete && (
          <button
            type="button"
            className="btn btn--secondary"
            data-testid="warp-duplicate"
            disabled={!sessionId || state.kind === 'saving'}
            onClick={() => {
              if (!sessionId) return;
              const newX = warp.fromCoord.x + 1;
              const newY = warp.fromCoord.y;
              void (async () => {
                setState({ kind: 'saving' });
                try {
                  await editBinaryRomMapEventTable(sessionId, {
                    mapEventsStructOffset,
                    subArrayOffset: warpsArrayOffset,
                    kind: 'warp',
                    op: 'append',
                    newWarp: {
                      x: newX,
                      y: newY,
                      elevation,
                      warpId,
                      destMapNum,
                      destMapGroup,
                    },
                  });
                  setState({ kind: 'saved' });
                  pushToast('success', `Warp duplicated at (${newX}, ${newY})`);
                  await scanCurrent();
                } catch (e) {
                  const msg = extractErrorMessage(e);
                  setState({ kind: 'error', message: msg });
                  pushToast('error', `Warp duplicate failed - ${msg}`);
                }
              })();
            }}
          >
            Duplicate this warp
          </button>
        )}
        {canDelete && (
          <button
            type="button"
            className="btn btn--secondary"
            data-testid="warp-delete"
            disabled={!sessionId || state.kind === 'saving'}
            onClick={() => {
              if (!window.confirm('Delete this warp? The slot will be removed; subsequent warps shift up.')) return;
              void (async () => {
                if (!sessionId) return;
                setState({ kind: 'saving' });
                try {
                  await editBinaryRomMapEventTable(sessionId, {
                    mapEventsStructOffset,
                    subArrayOffset: warpsArrayOffset,
                    kind: 'warp',
                    op: 'delete',
                    deleteStructFileOffset: warpStructFileOffset,
                  });
                  setState({ kind: 'saved' });
                  pushToast('success', 'Warp deleted');
                  await scanCurrent();
                } catch (e) {
                  const msg = extractErrorMessage(e);
                  setState({ kind: 'error', message: msg });
                  pushToast('error', `Warp delete failed - ${msg}`);
                }
              })();
            }}
            style={{ color: 'var(--color-error, #e25555)' }}
          >
            Delete this warp
          </button>
        )}
        {renderSaveState(state)}
      </div>
    </div>
  );
}

function parseIntSafe(input: string, fallback: number): number {
  if (input.trim() === '') return 0;
  const n = Number.parseInt(input, 10);
  return Number.isFinite(n) ? n : fallback;
}

function extractErrorMessage(e: unknown): string {
  if (e instanceof ProjectApiError) return `${e.code}: ${e.message}`;
  if (e instanceof Error) return e.message;
  return String(e);
}

/** Parse a synthetic id like `gfx_5` / `move_9` / `flag_0x800` /
 *  `trainer_3` / `script_0x1a2b3c` to its numeric byte value. Returns
 *  null when the prefix doesn't match or the suffix isn't parseable. */
function parseSyntheticNumber(id: string | null | undefined, prefix: string): number | null {
  if (!id || typeof id !== 'string') return null;
  const re = new RegExp(`^${prefix}_(0x[0-9a-fA-F]+|\\d+)$`);
  const m = re.exec(id);
  if (!m) return null;
  const raw = m[1]!;
  const n = raw.startsWith('0x') || raw.startsWith('0X') ? parseInt(raw, 16) : parseInt(raw, 10);
  return Number.isFinite(n) ? n : null;
}

/**
 * Phase G-RC5 - Binary-ROM ObjectEvent editor (numeric byte form).
 *
 * The decomp editor above expects MOVEMENT_TYPE_* constant strings and
 * pushes them through `patchEventFields`. For binary ROMs the
 * ObjectEventTemplate struct stores raw bytes: graphicsId u8,
 * movementType u8, movementRangeX/Y 4-bit nibbles, trainerType u16,
 * trainerSight u16, script u32 (ROM pointer), flagId u16. This editor
 * pulls the current values out of the synthetic ids (`gfx_5`,
 * `move_9`, etc.) + metadata, lets the operator change them as
 * numbers, and writes via the new
 * /binary-rom-edit/object-event-fields route.
 */
function BinaryRomObjectEventEditor({
  objectEvent,
  sessionId,
}: ObjectEventFieldsEditorProps): JSX.Element {
  const scanCurrent = useProjectStore((s) => s.scanCurrentProject);
  const structFileOffsetRaw = objectEvent.metadata['binaryFileOffset'];
  const structFileOffset =
    typeof structFileOffsetRaw === 'number' && structFileOffsetRaw > 0
      ? structFileOffsetRaw
      : null;
  // Phase J.7 - pull map-events struct offsets from the parent map's
  // metadata so the Delete button can do a true table-shift delete.
  const parentMap = useProjectStore((s) =>
    s.load.kind === 'loaded' && s.scan.kind === 'loaded'
      ? s.scan.data.manifest.maps.find((m) => m.id === objectEvent.mapId) ?? null
      : null,
  );
  const mapEventsStructOffset =
    parentMap && typeof parentMap.metadata['binaryRomMapEventsStructOffset'] === 'number'
      ? (parentMap.metadata['binaryRomMapEventsStructOffset'] as number)
      : -1;
  const objectEventsArrayOffset =
    parentMap && typeof parentMap.metadata['binaryRomObjectEventsArrayOffset'] === 'number'
      ? (parentMap.metadata['binaryRomObjectEventsArrayOffset'] as number)
      : -1;

  // Phase O.66 - movementRangeXY + trainerSightOrBerryTreeId are
  // now lifted on metadata (O.62) and the struct writer's whitelist
  // accepts them, so the form can expose both as editable fields.
  // movement_range_x + _y are nibbles of the same byte (high = x,
  // low = y); the writer packs them back on save. trainer_sight_or
  // _berry_tree_id is a u16 that serves dual purpose depending on
  // graphicsId (vision range for trainers, berry-tree id for OBJ
  // _EVENT_GFX_BERRY_TREE NPCs - the UI label clarifies).
  const initial = useMemo(() => {
    const rangeXY =
      typeof objectEvent.metadata['movementRangeXY'] === 'number'
        ? (objectEvent.metadata['movementRangeXY'] as number)
        : 0;
    const sight =
      typeof objectEvent.metadata['trainerSightOrBerryTreeId'] === 'number'
        ? (objectEvent.metadata['trainerSightOrBerryTreeId'] as number)
        : 0;
    return {
      graphics_id: parseSyntheticNumber(objectEvent.graphicsId, 'gfx') ?? 0,
      movement_type: parseSyntheticNumber(objectEvent.movementType, 'move') ?? 0,
      movement_range_x: (rangeXY >> 4) & 0x0f,
      movement_range_y: rangeXY & 0x0f,
      elevation: objectEvent.elevation,
      trainer_type: parseSyntheticNumber(objectEvent.trainerType, 'trainer') ?? 0,
      trainer_sight_or_berry_tree_id: sight,
      script: parseSyntheticNumber(objectEvent.scriptId, 'script') ?? 0,
      flag: parseSyntheticNumber(objectEvent.flagId, 'flag') ?? 0,
    };
  }, [objectEvent]);

  const [values, setValues] = useState(initial);
  const [state, setState] = useState<SaveState>({ kind: 'idle' });

  useEffect(() => {
    setValues(initial);
    setState({ kind: 'idle' });
  }, [initial]);

  const dirty = useMemo(() => {
    for (const k of Object.keys(initial) as Array<keyof typeof initial>) {
      if (values[k] !== initial[k]) return true;
    }
    return false;
  }, [initial, values]);

  function setField<K extends keyof typeof values>(key: K, value: number): void {
    setValues((prev) => ({ ...prev, [key]: value }));
  }

  const save = useCallback(async () => {
    if (!sessionId || !dirty || structFileOffset === null) return;
    setState({ kind: 'saving' });
    try {
      const fields: Record<string, number> = {};
      for (const k of Object.keys(initial) as Array<keyof typeof initial>) {
        if (values[k] !== initial[k]) fields[k] = values[k];
      }
      await editBinaryRomObjectEventFields(sessionId, [
        { structFileOffset, fields },
      ]);
      setState({ kind: 'saved' });
      pushToast('success', 'NPC fields saved');
      await scanCurrent();
    } catch (e) {
      const msg = extractErrorMessage(e);
      setState({ kind: 'error', message: msg });
      pushToast('error', `NPC save failed - ${msg}`);
    }
  }, [dirty, initial, scanCurrent, sessionId, structFileOffset, values]);

  // Phase O.28 - Enter saves, Esc reverts.
  const onKeyDownEdit = useEditFormKeyboard({
    canSave: dirty && sessionId !== null && structFileOffset !== null,
    save,
    cancel: () => {
      setValues(initial);
      setState({ kind: 'idle' });
    },
    isSaving: state.kind === 'saving',
  });

  if (structFileOffset === null) {
    return (
      <div className="fields-editor fields-editor--readonly">
        <p className="fields-editor__note">
          This binary-ROM object event has no struct file offset on its
          metadata (was the project scanned before Phase G shipped?). Re-scan
          the project to enable field editing.
        </p>
      </div>
    );
  }

  return (
    <div
      className="fields-editor"
      data-testid="binary-rom-object-event-fields-editor"
      onKeyDown={onKeyDownEdit}
    >
      <h4 className="fields-editor__heading">Edit NPC fields</h4>
      <div className="fields-editor__row fields-editor__row--inline">
        <label>
          Sprite (graphics id)
          <select
            value={values.graphics_id}
            data-testid="bin-obj-graphics-id"
            onChange={(e) =>
              setField('graphics_id', Number.parseInt(e.target.value, 10) || 0)
            }
          >
            {BINARY_GRAPHICS_ID_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
            {!BINARY_GRAPHICS_ID_OPTIONS.some(
              (o) => o.value === values.graphics_id,
            ) && (
              <option value={values.graphics_id}>
                {`${values.graphics_id} - Hack-specific`}
              </option>
            )}
          </select>
        </label>
        <label>
          Movement type
          <select
            value={values.movement_type}
            data-testid="bin-obj-movement-type"
            onChange={(e) =>
              setField('movement_type', Number.parseInt(e.target.value, 10) || 0)
            }
          >
            {GEN3_MOVEMENT_TYPE_NAMES.map((label, value) => (
              <option key={value} value={value}>{`${value} - ${label}`}</option>
            ))}
            {values.movement_type >= GEN3_MOVEMENT_TYPE_NAMES.length && (
              <option value={values.movement_type}>
                {`${values.movement_type} - Hack-specific`}
              </option>
            )}
          </select>
        </label>
      </div>
      <div className="fields-editor__row fields-editor__row--inline">
        <label>
          Elevation
          <input
            type="number"
            min={0}
            max={255}
            value={values.elevation}
            onChange={(e) => setField('elevation', parseIntSafe(e.target.value, 0))}
            data-testid="bin-obj-elevation"
          />
        </label>
        <label>
          Trainer type
          <select
            value={values.trainer_type}
            data-testid="bin-obj-trainer-type"
            onChange={(e) =>
              setField('trainer_type', Number.parseInt(e.target.value, 10) || 0)
            }
          >
            {BINARY_TRAINER_TYPE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
            {!BINARY_TRAINER_TYPE_OPTIONS.some(
              (o) => o.value === values.trainer_type,
            ) && (
              <option value={values.trainer_type}>
                {`${values.trainer_type} - Hack-specific`}
              </option>
            )}
          </select>
        </label>
      </div>
      {/* Phase O.66 - wander range + trainer sight inputs. The
          render path in mapEditorScene.ts uses these to draw the
          purple wander bboxes + red trainer cones on the canvas;
          editing them updates both the in-game behaviour AND the
          visualization on the next re-scan. */}
      <div className="fields-editor__row fields-editor__row--inline">
        <label>
          Wander range X (0–15)
          <input
            type="number"
            min={0}
            max={15}
            value={values.movement_range_x}
            onChange={(e) =>
              setField('movement_range_x', Math.max(0, Math.min(15, parseIntSafe(e.target.value, 0))))
            }
            data-testid="bin-obj-movement-range-x"
          />
        </label>
        <label>
          Wander range Y (0–15)
          <input
            type="number"
            min={0}
            max={15}
            value={values.movement_range_y}
            onChange={(e) =>
              setField('movement_range_y', Math.max(0, Math.min(15, parseIntSafe(e.target.value, 0))))
            }
            data-testid="bin-obj-movement-range-y"
          />
        </label>
      </div>
      <div className="fields-editor__row">
        <label>
          Trainer sight range (tiles; 0 = no battle)
          <input
            type="number"
            min={0}
            max={65535}
            value={values.trainer_sight_or_berry_tree_id}
            onChange={(e) =>
              setField(
                'trainer_sight_or_berry_tree_id',
                Math.max(0, Math.min(65535, parseIntSafe(e.target.value, 0))),
              )
            }
            data-testid="bin-obj-trainer-sight"
          />
          <span className="fields-editor__hint">
            For berry-tree NPCs, this field is the berry-tree id instead.
          </span>
        </label>
      </div>
      <div className="fields-editor__row">
        <label>
          Visibility flag (0 = always visible)
          <input
            type="text"
            value={`0x${values.flag.toString(16)}`}
            onChange={(e) => {
              const v = e.target.value.trim();
              const n = v.startsWith('0x') || v.startsWith('0X')
                ? parseInt(v, 16)
                : parseInt(v, 10);
              if (Number.isFinite(n) && n >= 0 && n <= 0xffff) {
                setField('flag', n);
              }
            }}
            spellCheck={false}
            data-testid="bin-obj-flag"
          />
        </label>
      </div>
      <div className="fields-editor__row">
        <label>
          Script (advanced - leave alone unless you know the address)
          <input
            type="text"
            value={`0x${values.script.toString(16)}`}
            onChange={(e) => {
              const v = e.target.value.trim();
              const n = v.startsWith('0x') || v.startsWith('0X')
                ? parseInt(v, 16)
                : parseInt(v, 10);
              if (Number.isFinite(n) && n >= 0 && n <= 0xffffffff) {
                setField('script', n >>> 0);
              }
            }}
            spellCheck={false}
            data-testid="bin-obj-script"
          />
        </label>
      </div>
      <div className="fields-editor__actions">
        <button
          type="button"
          className="btn btn--primary"
          onClick={() => void save()}
          disabled={!dirty || !sessionId || state.kind === 'saving'}
          data-testid="bin-obj-fields-save"
        >
          Save to ROM
        </button>
        {renderSaveState(state)}
      </div>
      {/* Phase O.35 - Duplicate this NPC. Appends a new ObjectEventTemplate
          slot using the current form values + a (+1, 0) tile offset so
          the copy is visible next to the original. Defaults un-lifted
          fields (movementRangeXY, trainerSight) to 0; the operator can
          tweak after the next re-scan. */}
      {mapEventsStructOffset > 0 && objectEventsArrayOffset > 0 && (
        <div className="fields-editor__row" style={{ marginTop: 10 }}>
          <button
            type="button"
            className="btn btn--secondary"
            data-testid="bin-obj-duplicate"
            disabled={!sessionId || state.kind === 'saving'}
            onClick={() => {
              if (!sessionId) return;
              const newX = objectEvent.coord.x + 1;
              const newY = objectEvent.coord.y;
              const newLocalId =
                (parentMap?.objectEventIds.length ?? 0) + 1;
              void (async () => {
                setState({ kind: 'saving' });
                try {
                  await editBinaryRomObjectEventTable(sessionId, {
                    mapEventsStructOffset,
                    objectEventsArrayOffset,
                    op: 'append',
                    newObject: {
                      localId: newLocalId,
                      graphicsId: values.graphics_id,
                      x: newX,
                      y: newY,
                      elevation: values.elevation,
                      movementType: values.movement_type,
                      movementRangeXY: 0,
                      trainerType: values.trainer_type,
                      trainerSightOrBerryTreeId: 0,
                      scriptPointer: values.script,
                      flagId: values.flag,
                    },
                  });
                  setState({ kind: 'saved' });
                  pushToast(
                    'success',
                    `NPC duplicated at (${newX}, ${newY}) as local id ${newLocalId}`,
                  );
                  await scanCurrent();
                } catch (e) {
                  const msg = extractErrorMessage(e);
                  setState({ kind: 'error', message: msg });
                  pushToast('error', `Duplicate failed - ${msg}`);
                }
              })();
            }}
          >
            Duplicate this NPC
          </button>
        </div>
      )}
      {/* Phase J.7 - TRUE Delete NPC. Shifts subsequent slots down in
          the ObjectEvent table + decrements the count byte on the
          parent MapEvents struct. Requires the parent map's metadata
          to expose mapEventsStructOffset + objectEventsArrayOffset
          (added in Phase J pre-work). Falls back to soft delete (zero
          the struct) when those offsets aren't in the manifest yet - 
          better than failing. */}
      <div className="fields-editor__row" style={{ marginTop: 10 }}>
        <button
          type="button"
          className="btn btn--secondary"
          data-testid="bin-obj-delete"
          disabled={!sessionId || state.kind === 'saving'}
          onClick={() => {
            const trueDelete =
              mapEventsStructOffset > 0 && objectEventsArrayOffset > 0;
            if (
              !window.confirm(
                trueDelete
                  ? 'Delete this NPC? The slot will be removed from the table (subsequent NPCs shift up by one local id). Reversible via the .bak file.'
                  : 'Soft-delete this NPC (clear graphics/script/flag/trainer)? The slot stays in the table - true delete needs a re-scan with map-events offsets stashed in metadata. Reversible via the .bak file.',
              )
            ) {
              return;
            }
            void (async () => {
              if (!sessionId || structFileOffset === null) return;
              setState({ kind: 'saving' });
              try {
                if (trueDelete) {
                  await editBinaryRomObjectEventTable(sessionId, {
                    mapEventsStructOffset,
                    objectEventsArrayOffset,
                    op: 'delete',
                    deleteStructFileOffset: structFileOffset,
                  });
                } else {
                  await editBinaryRomObjectEventFields(sessionId, [
                    {
                      structFileOffset,
                      fields: {
                        graphics_id: 0,
                        movement_type: 0,
                        movement_range_x: 0,
                        movement_range_y: 0,
                        trainer_type: 0,
                        trainer_sight_or_berry_tree_id: 0,
                        script: 0,
                        flag: 0,
                      },
                    },
                  ]);
                }
                setState({ kind: 'saved' });
                pushToast(
                  'success',
                  trueDelete ? 'NPC deleted' : 'NPC slot cleared',
                );
                await scanCurrent();
              } catch (e) {
                const msg = extractErrorMessage(e);
                setState({ kind: 'error', message: msg });
                pushToast('error', `NPC delete failed - ${msg}`);
              }
            })();
          }}
          style={{ color: 'var(--color-error, #e25555)' }}
        >
          Delete this NPC
        </button>
      </div>
      <p className="fields-editor__note">
        Edits patch the 24-byte struct in place. A one-time
        <code> &lt;rom&gt;.bak</code> backup is created on first edit so you
        can roll back by restoring the file.
        {mapEventsStructOffset > 0 && objectEventsArrayOffset > 0 ? (
          <> Delete removes the slot from the table (subsequent NPCs shift up).</>
        ) : (
          <> Delete clears the slot but doesn't remove it (re-scan to enable true delete).</>
        )}
      </p>
    </div>
  );
}
