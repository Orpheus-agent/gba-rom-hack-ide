/**
 * Phase H-RC2 (semantic-world plan §H.2) - decoded script steps
 * rendered inline in the NPC inspector.
 *
 * The binary script decoder (H.1) pushes one ScriptStep per opcode
 * to `manifest.scriptSteps[]` with ids `<scriptId>__<index>`. This
 * component looks up all steps belonging to a given scriptId by
 * prefix-match and renders them as a plain-English list:
 *
 *   1. Lock player
 *   2. Face player
 *   3. Msgbox: "Hello, my name is Mom!"
 *   4. Release
 *   5. End
 *
 * Each step is color-coded by ScriptStepKind. msgbox steps surface
 * the decoded dialogue text inline.
 */

import { useEffect, useMemo, useState } from 'react';
import type { ProjectManifest, ScriptStep, ScriptStepKind } from '@rom-editor/shared';
import {
  editBinaryRomDialogueString,
  editBinaryRomMovementActionByte,
  editBinaryRomScriptStepArgs,
  editBinaryRomStartBattleTrainerId,
  ProjectApiError,
} from '../../api';
import { pushToast, useProjectStore } from '../../state';
import {
  EntityPicker,
  packMapId,
  unpackMapGroup,
  unpackMapNum,
  type EntityPickerKind,
} from '../EntityPicker';
import {
  describeMovementAction,
  isMovementEnd,
  listMovementActionOptions,
} from '../../lib/movementActions';
import { useEditFormKeyboard } from '../../lib/useEditFormKeyboard';

/** GBA ROM base address - duplicated here to avoid pulling in the
 *  engine bundle for one constant. Matches `GBA_ROM_BASE_ADDRESS`
 *  in engine/src/pointers/discovery.ts. */
const GBA_ROM_BASE_ADDRESS = 0x08000000;
import './ScriptStepsList.css';

interface ScriptStepsListProps {
  readonly scriptId: string;
  readonly manifest: ProjectManifest;
}

const KIND_COLORS: Readonly<Record<ScriptStepKind, string>> = {
  dialogue: '#4a9eff',
  set_flag: '#50c878',
  clear_flag: '#c98a3d',
  branch: '#b46aff',
  branch_on_var: '#b46aff',
  give_item: '#f0b429',
  start_battle: '#a83d3d',
  play_sound: '#7c8088',
  move_npc: '#5dade2',
  fade_scene: '#7c8088',
  warp_player: '#4a9eff',
  set_variable: '#50c878',
  randomize_branch: '#b46aff',
  raw: '#7c8088',
};

export function ScriptStepsList({ scriptId, manifest }: ScriptStepsListProps): JSX.Element {
  const allSteps = useMemo(() => {
    // Accept either a script label (object events) or a `<label>__<n>` step id
    // (triggers pass scriptStepIds[0]); strip a trailing index to normalize.
    const scriptLabel = scriptId.replace(/__\d+$/, '');
    const prefix = `${scriptLabel}__`;
    const matches = manifest.scriptSteps.filter((s) => s.id.startsWith(prefix));
    // Sort by trailing index (id format: `<scriptId>__<index>`).
    matches.sort((a, b) => {
      const ai = parseInt(a.id.slice(prefix.length), 10);
      const bi = parseInt(b.id.slice(prefix.length), 10);
      return ai - bi;
    });
    return matches;
  }, [scriptId, manifest.scriptSteps]);

  // Filter out `raw` / unknown-opcode steps from the default view. They're
  // engine-internal noise (no gameplay semantics - "Unknown opcode 0x80"
  // means the decoder didn't recognize that byte) and they dominate the
  // wall when a script has many of them. Power users see them inside
  // the "Show every raw opcode" toggle below.
  const meaningfulSteps = useMemo(
    () => allSteps.filter((s) => s.kind !== 'raw'),
    [allSteps],
  );
  const rawSteps = allSteps.length - meaningfulSteps.length;

  if (allSteps.length === 0) {
    return (
      <div className="script-steps script-steps--empty" data-testid="script-steps-empty">
        <h4 className="script-steps__heading">What this NPC does</h4>
        <p className="script-steps__note">
          No decoded script - re-scan the project to try again.
        </p>
      </div>
    );
  }

  // Collapsed by default: clicking an NPC should show identity +
  // movement + sprite. Whether the user actually cares about the
  // 35-opcode script chain is a separate decision they opt into.
  return (
    <details className="script-steps" data-testid="script-steps">
      <summary className="script-steps__summary">
        What this NPC does{' '}
        <span className="script-steps__summary-count">
          ({meaningfulSteps.length} action{meaningfulSteps.length === 1 ? '' : 's'}
          {rawSteps > 0 ? `, +${rawSteps} internal` : ''})
        </span>
      </summary>
      <ol className="script-steps__list">
        {meaningfulSteps.map((step) => (
          <ScriptStepItem key={step.id} step={step} manifest={manifest} />
        ))}
      </ol>
    </details>
  );
}

function ScriptStepItem({ step, manifest }: { step: ScriptStep; manifest: ProjectManifest }): JSX.Element {
  const params = step.params as Record<string, unknown>;
  const label = typeof params.label === 'string' ? params.label : null;
  const dialogueText = typeof params.dialogueText === 'string' ? params.dialogueText : null;
  const color = KIND_COLORS[step.kind] ?? KIND_COLORS.raw;
  const textFileOffset =
    typeof params.textFileOffset === 'number' ? params.textFileOffset : null;

  return (
    <li
      className={`script-steps__item script-steps__item--${step.kind}`}
      data-testid={`script-step-${step.id}`}
    >
      <span
        className="script-steps__kind-chip"
        style={{ backgroundColor: color }}
        title={`Kind: ${step.kind}`}
      >
        {step.kind.replace(/_/g, ' ')}
      </span>
      <span className="script-steps__label">
        {/* Phase I.3 - strip the inline dialogue from the label since
            we render the editable text below. The label was previously
            `Msgbox: "OAK POKéMON ..."` which duplicated the dialogue
            block. Now the label is just "Msgbox" and the text is the
            sole editable surface. */}
        {step.kind === 'dialogue' ? 'Msgbox' : label ?? step.kind}
      </span>
      {step.kind === 'dialogue' && dialogueText !== null ? (
        <MsgboxEditor
          initialText={dialogueText}
          textFileOffset={textFileOffset}
          stepId={step.id}
        />
      ) : step.kind === 'set_flag' || step.kind === 'clear_flag' ? (
        <FlagStepEditor step={step} manifest={manifest} />
      ) : step.kind === 'set_variable' ? (
        <SetVariableStepEditor step={step} manifest={manifest} />
      ) : step.kind === 'give_item' ? (
        <GiveItemStepEditor step={step} manifest={manifest} />
      ) : step.kind === 'start_battle' ? (
        <TrainerBattleStepEditor step={step} manifest={manifest} />
      ) : step.kind === 'move_npc' ? (
        <ApplyMovementStepViewer step={step} />
      ) : step.kind === 'warp_player' ? (
        <WarpStepEditor step={step} manifest={manifest} />
      ) : dialogueText ? (
        <div className="script-steps__dialogue" data-testid="script-step-dialogue">
          "{dialogueText}"
        </div>
      ) : null}
      {/* The per-step ROM file offset (@ 0xNNNN) used to render here.
       *  Removed from the default view - it leaks engine-internal
       *  detail to a user who just clicked an NPC. Power-user access
       *  via step.params.fileOffset on the underlying ScriptStep entity. */}
    </li>
  );
}

/**
 * Phase I.3 - inline editor for msgbox text. User edits → "Save" →
 * backend re-encodes via the Gen-3 codec and writes in place if the
 * new encoded length fits within the original terminator-bounded span.
 * If encoding fails (character outside the charmap) or the new text
 * is longer than the original span, surfaces a clear error.
 */
function MsgboxEditor({
  initialText,
  textFileOffset,
  stepId,
}: {
  initialText: string;
  textFileOffset: number | null;
  stepId: string;
}): JSX.Element {
  const sessionId = useProjectStore((s) =>
    s.load.kind === 'loaded' ? s.load.data.session.id : null,
  );
  const scanCurrent = useProjectStore((s) => s.scanCurrentProject);
  const [text, setText] = useState(initialText);
  const [state, setState] = useState<
    | { kind: 'idle' }
    | { kind: 'saving' }
    | { kind: 'saved' }
    | { kind: 'error'; message: string }
  >({ kind: 'idle' });

  useEffect(() => {
    setText(initialText);
    setState({ kind: 'idle' });
  }, [initialText, stepId]);

  const dirty = text !== initialText;
  const canSave = dirty && textFileOffset !== null && sessionId !== null;

  async function save(): Promise<void> {
    if (!sessionId || textFileOffset === null) return;
    setState({ kind: 'saving' });
    try {
      await editBinaryRomDialogueString(sessionId, {
        stringFileOffset: textFileOffset,
        newText: text,
      });
      setState({ kind: 'saved' });
      pushToast('success', 'Dialogue saved');
      // Re-scan so the new dialogue text flows back into the manifest +
      // future renders pick it up.
      await scanCurrent();
    } catch (e) {
      const message =
        e instanceof ProjectApiError
          ? `${e.code}: ${e.message}`
          : e instanceof Error
            ? e.message
            : String(e);
      setState({ kind: 'error', message });
      pushToast('error', `Dialogue save failed - ${message}`);
    }
  }

  // Phase O.27 - Ctrl+Enter saves (plain Enter inserts newline in
  // the textarea). Escape cancels (reverts to initialText).
  const onKeyDown = useEditFormKeyboard({
    canSave,
    save,
    cancel: () => {
      setText(initialText);
      setState({ kind: 'idle' });
    },
    isSaving: state.kind === 'saving',
  });

  return (
    <div
      className="script-steps__msgbox-editor"
      data-testid={`msgbox-editor-${stepId}`}
      onKeyDown={onKeyDown}
    >
      <textarea
        className="script-steps__msgbox-textarea"
        data-testid={`msgbox-textarea-${stepId}`}
        value={text}
        onChange={(e) => setText(e.target.value)}
        spellCheck
        rows={2}
        title="Edit dialogue text. Ctrl+Enter to save · Esc to revert."
      />
      <div className="script-steps__msgbox-actions">
        <button
          type="button"
          className="btn btn--primary"
          data-testid={`msgbox-save-${stepId}`}
          disabled={!canSave || state.kind === 'saving'}
          onClick={() => void save()}
          title={
            textFileOffset === null
              ? 'No string offset on this step - cannot save.'
              : !sessionId
                ? 'No project session.'
                : !dirty
                  ? 'No changes.'
                  : 'Re-encode + write in place.'
          }
        >
          {state.kind === 'saving' ? 'Saving…' : 'Save text'}
        </button>
        {state.kind === 'saved' && !dirty && (
          <span className="script-steps__msgbox-ok">Saved · ROM patched</span>
        )}
        {state.kind === 'error' && (
          <span className="script-steps__msgbox-err">{state.message}</span>
        )}
      </div>
    </div>
  );
}

/**
 * Phase I.4 - generic step-arg editor for opcodes that take a small
 * number of u16 args. Shared backing component for set_flag, clear_flag,
 * set_variable, and give_item editors. Each caller passes the schema
 * for its inputs (label, current value, max value).
 */
interface StepArgFieldInput {
  readonly key: string;
  readonly label: string;
  readonly value: number;
  readonly max: number; // 0xff for u8, 0xffff for u16
  /** Phase O.21 - when set, render an EntityPicker for this field
   *  instead of a raw number input. Resolves the value to a name from
   *  the matching manifest collection. */
  readonly pickerKind?: EntityPickerKind;
}

function StepArgEditor({
  stepId,
  fileOffset,
  fields,
  toArgBytes,
  manifest,
}: {
  stepId: string;
  fileOffset: number | null;
  fields: ReadonlyArray<StepArgFieldInput>;
  toArgBytes: (values: ReadonlyArray<number>) => ReadonlyArray<number>;
  manifest: ProjectManifest;
}): JSX.Element {
  const sessionId = useProjectStore((s) =>
    s.load.kind === 'loaded' ? s.load.data.session.id : null,
  );
  const scanCurrent = useProjectStore((s) => s.scanCurrentProject);
  const [values, setValues] = useState(fields.map((f) => f.value));
  const [state, setState] = useState<
    | { kind: 'idle' }
    | { kind: 'saving' }
    | { kind: 'saved' }
    | { kind: 'error'; message: string }
  >({ kind: 'idle' });

  useEffect(() => {
    setValues(fields.map((f) => f.value));
    setState({ kind: 'idle' });
  }, [stepId, fields]);

  const dirty = values.some((v, i) => v !== fields[i]?.value);
  const valid =
    values.length === fields.length &&
    values.every((v, i) => {
      const f = fields[i];
      return f && Number.isInteger(v) && v >= 0 && v <= f.max;
    });
  const canSave = dirty && valid && fileOffset !== null && sessionId !== null;

  async function save(): Promise<void> {
    if (!sessionId || fileOffset === null) return;
    setState({ kind: 'saving' });
    try {
      await editBinaryRomScriptStepArgs(sessionId, {
        stepFileOffset: fileOffset,
        argBytes: toArgBytes(values),
      });
      setState({ kind: 'saved' });
      pushToast('success', 'Script step saved');
      await scanCurrent();
    } catch (e) {
      const message =
        e instanceof ProjectApiError
          ? `${e.code}: ${e.message}`
          : e instanceof Error
            ? e.message
            : String(e);
      setState({ kind: 'error', message });
      pushToast('error', `Script step save failed - ${message}`);
    }
  }

  return (
    <div className="script-steps__arg-editor" data-testid={`arg-editor-${stepId}`}>
      <div className="script-steps__arg-fields">
        {fields.map((f, i) => (
          <label key={f.key} className="script-steps__arg-field">
            <span className="script-steps__arg-label">{f.label}</span>
            {f.pickerKind ? (
              <EntityPicker
                kind={f.pickerKind}
                manifest={manifest}
                value={values[i] ?? f.value}
                onChange={(next) => {
                  const arr = [...values];
                  arr[i] = next;
                  setValues(arr);
                }}
                minId={0}
                maxId={f.max}
                testIdPrefix={`arg-input-${stepId}-${f.key}`}
              />
            ) : (
              <input
                type="number"
                min={0}
                max={f.max}
                data-testid={`arg-input-${stepId}-${f.key}`}
                value={values[i] ?? f.value}
                onChange={(e) => {
                  const next = [...values];
                  next[i] = Number.parseInt(e.target.value, 10) || 0;
                  setValues(next);
                }}
              />
            )}
            <span className="script-steps__arg-hex">0x{(values[i] ?? f.value).toString(16)}</span>
          </label>
        ))}
      </div>
      <div className="script-steps__msgbox-actions">
        <button
          type="button"
          className="btn btn--primary"
          data-testid={`arg-save-${stepId}`}
          disabled={!canSave || state.kind === 'saving'}
          onClick={() => void save()}
          title={
            fileOffset === null
              ? 'No file offset on this step - cannot save.'
              : !sessionId
                ? 'No project session.'
                : !dirty
                  ? 'No changes.'
                  : !valid
                    ? 'Invalid input.'
                    : 'Patch args in place.'
          }
        >
          {state.kind === 'saving' ? 'Saving…' : 'Save'}
        </button>
        {state.kind === 'saved' && !dirty && (
          <span className="script-steps__msgbox-ok">Saved · ROM patched</span>
        )}
        {state.kind === 'error' && (
          <span className="script-steps__msgbox-err">{state.message}</span>
        )}
      </div>
    </div>
  );
}

/** u16 → little-endian byte pair. */
function u16ToLE(n: number): [number, number] {
  return [n & 0xff, (n >>> 8) & 0xff];
}

function FlagStepEditor({
  step,
  manifest,
}: {
  step: ScriptStep;
  manifest: ProjectManifest;
}): JSX.Element {
  const params = step.params as Record<string, unknown>;
  const flagId = typeof params.flagId === 'number' ? params.flagId : 0;
  const fileOffset = typeof params.fileOffset === 'number' ? params.fileOffset : null;
  return (
    <StepArgEditor
      stepId={step.id}
      fileOffset={fileOffset}
      fields={[{ key: 'flagId', label: 'Flag id', value: flagId, max: 0xffff }]}
      toArgBytes={(vs) => u16ToLE(vs[0] ?? 0)}
      manifest={manifest}
    />
  );
}

function SetVariableStepEditor({
  step,
  manifest,
}: {
  step: ScriptStep;
  manifest: ProjectManifest;
}): JSX.Element {
  const params = step.params as Record<string, unknown>;
  const varId = typeof params.varId === 'number' ? params.varId : 0;
  const value = typeof params.value === 'number' ? params.value : 0;
  const fileOffset = typeof params.fileOffset === 'number' ? params.fileOffset : null;
  return (
    <StepArgEditor
      stepId={step.id}
      fileOffset={fileOffset}
      fields={[
        { key: 'varId', label: 'Variable id', value: varId, max: 0xffff },
        { key: 'value', label: 'Value', value: value, max: 0xffff },
      ]}
      toArgBytes={(vs) => [...u16ToLE(vs[0] ?? 0), ...u16ToLE(vs[1] ?? 0)]}
      manifest={manifest}
    />
  );
}

function GiveItemStepEditor({
  step,
  manifest,
}: {
  step: ScriptStep;
  manifest: ProjectManifest;
}): JSX.Element {
  const params = step.params as Record<string, unknown>;
  const itemId = typeof params.itemId === 'number' ? params.itemId : 0;
  // The decoder names the count field `quantity` for giveitem/takeitem/checkitem.
  const quantity = typeof params.quantity === 'number' ? params.quantity : 1;
  const callbackType =
    typeof params.callbackType === 'number' ? params.callbackType : 0;
  const fileOffset = typeof params.fileOffset === 'number' ? params.fileOffset : null;
  return (
    <StepArgEditor
      stepId={step.id}
      fileOffset={fileOffset}
      fields={[
        // Phase O.21 - item id resolves via 'item' picker; quantity +
        // callbackType stay numeric (small ints, no names table).
        { key: 'itemId', label: 'Item', value: itemId, max: 0xffff, pickerKind: 'item' },
        { key: 'quantity', label: 'Quantity', value: quantity, max: 0xffff },
        { key: 'callbackType', label: 'Callback type', value: callbackType, max: 0xff },
      ]}
      toArgBytes={(vs) => [
        ...u16ToLE(vs[0] ?? 0),
        ...u16ToLE(vs[1] ?? 0),
        (vs[2] ?? 0) & 0xff,
      ]}
      manifest={manifest}
    />
  );
}

/** Phase O.23 - Trainerbattle (start_battle) step editor.
 *
 * Trainerbattle args are variable-byte (depending on battleType 0..9)
 * with the trainerId u16 always at offset +2 from the opcode byte.
 * Editing the trainerId only - the type byte + the trailing variable
 * args (script pointers per battle variant) are preserved untouched
 * via a targeted partial-write route. */
function TrainerBattleStepEditor({
  step,
  manifest,
}: {
  step: ScriptStep;
  manifest: ProjectManifest;
}): JSX.Element {
  const params = step.params as Record<string, unknown>;
  const initialTrainerId = typeof params.trainerId === 'number' ? params.trainerId : 0;
  const battleType = typeof params.battleType === 'number' ? params.battleType : null;
  const fileOffset = typeof params.fileOffset === 'number' ? params.fileOffset : null;
  const sessionId = useProjectStore((s) =>
    s.load.kind === 'loaded' ? s.load.data.session.id : null,
  );
  const scanCurrent = useProjectStore((s) => s.scanCurrentProject);
  const [trainerId, setTrainerId] = useState(initialTrainerId);
  const [state, setState] = useState<
    | { kind: 'idle' }
    | { kind: 'saving' }
    | { kind: 'saved' }
    | { kind: 'error'; message: string }
  >({ kind: 'idle' });

  useEffect(() => {
    setTrainerId(initialTrainerId);
    setState({ kind: 'idle' });
  }, [step.id, initialTrainerId]);

  const dirty = trainerId !== initialTrainerId;
  const canSave = dirty && fileOffset !== null && sessionId !== null;

  async function save(): Promise<void> {
    if (!sessionId || fileOffset === null) return;
    setState({ kind: 'saving' });
    try {
      await editBinaryRomStartBattleTrainerId(sessionId, {
        stepFileOffset: fileOffset,
        trainerId,
      });
      setState({ kind: 'saved' });
      pushToast('success', 'Trainerbattle trainer updated');
      await scanCurrent();
    } catch (e) {
      const message =
        e instanceof ProjectApiError
          ? `${e.code}: ${e.message}`
          : e instanceof Error
            ? e.message
            : String(e);
      setState({ kind: 'error', message });
      pushToast('error', `Trainerbattle save failed - ${message}`);
    }
  }

  return (
    <div className="script-steps__arg-editor" data-testid={`trainer-battle-editor-${step.id}`}>
      <div className="script-steps__arg-fields">
        <label className="script-steps__arg-field">
          <span className="script-steps__arg-label">Trainer</span>
          <EntityPicker
            kind="trainer"
            manifest={manifest}
            value={trainerId}
            onChange={setTrainerId}
            minId={0}
            maxId={0xffff}
            testIdPrefix={`trainer-battle-trainer-${step.id}`}
          />
          <span className="script-steps__arg-hex">0x{trainerId.toString(16)}</span>
        </label>
        {battleType !== null && (
          <p className="script-steps__msgbox-hint">
            Battle type {String(battleType)} (preserved). Editing only the
            trainer id; the trailing script-pointer args (intro / loss
            text / etc.) stay as-is.
          </p>
        )}
      </div>
      <div className="script-steps__msgbox-actions">
        <button
          type="button"
          className="btn btn--primary"
          data-testid={`trainer-battle-save-${step.id}`}
          disabled={!canSave || state.kind === 'saving'}
          onClick={() => void save()}
          title={
            fileOffset === null
              ? 'No file offset - cannot save.'
              : !sessionId
                ? 'No project session.'
                : !dirty
                  ? 'No changes.'
                  : 'Patch trainerId u16 at step offset +2.'
          }
        >
          {state.kind === 'saving' ? 'Saving…' : 'Save trainer'}
        </button>
        {state.kind === 'saved' && !dirty && (
          <span className="script-steps__msgbox-ok">Saved</span>
        )}
        {state.kind === 'error' && (
          <span className="script-steps__msgbox-err">{state.message}</span>
        )}
      </div>
    </div>
  );
}

/** Phase O.24 + O.26 - Applymovement step editor.
 *
 * Renders the decoded movement byte sequence as a list of inline
 * editors. Each action becomes a tiny `<select>` of the ~96 known
 * MOVEMENT_ACTION_* options. Picking a new action triggers an
 * immediate single-byte partial-write via
 * `editBinaryRomMovementActionByte`. The END sentinel (0xFE)
 * renders as a static chip (not editable - would truncate the
 * sequence).
 *
 * Insert / delete / reorder is still deferred - those need a
 * relocation route. */
function ApplyMovementStepViewer({ step }: { step: ScriptStep }): JSX.Element {
  const params = step.params as Record<string, unknown>;
  const objectId =
    typeof params.objectId === 'number' ? params.objectId : null;
  const movementPtr =
    typeof params.movementPtr === 'number' ? params.movementPtr : null;
  const movementDataOffset =
    movementPtr !== null && movementPtr >= GBA_ROM_BASE_ADDRESS
      ? movementPtr - GBA_ROM_BASE_ADDRESS
      : null;
  const sequence = Array.isArray(params.movementSequence)
    ? (params.movementSequence as ReadonlyArray<unknown>).filter(
        (v): v is number => typeof v === 'number',
      )
    : [];
  const CAP = 32;
  const visible = sequence.slice(0, CAP);
  const overflow = sequence.length - visible.length;
  const options = useMemo(() => listMovementActionOptions(), []);
  const sessionId = useProjectStore((s) =>
    s.load.kind === 'loaded' ? s.load.data.session.id : null,
  );
  const scanCurrent = useProjectStore((s) => s.scanCurrentProject);
  const canEdit = movementDataOffset !== null && sessionId !== null;

  async function setActionAt(index: number, newByte: number): Promise<void> {
    if (!sessionId || movementDataOffset === null) return;
    try {
      await editBinaryRomMovementActionByte(sessionId, {
        movementDataOffset,
        actionIndex: index,
        newActionByte: newByte,
      });
      pushToast('success', `Movement action ${String(index + 1)} updated`);
      await scanCurrent();
    } catch (e) {
      const message =
        e instanceof ProjectApiError
          ? `${e.code}: ${e.message}`
          : e instanceof Error
            ? e.message
            : String(e);
      pushToast('error', `Movement action save failed - ${message}`);
    }
  }

  return (
    <div
      className="script-steps__movement-viewer"
      data-testid={`movement-viewer-${step.id}`}
      style={{
        marginTop: 4,
        padding: 6,
        background: 'var(--color-bg)',
        border: '1px solid var(--color-border)',
        borderRadius: 4,
        fontSize: 11,
      }}
    >
      <div style={{ color: 'var(--color-text-muted)', marginBottom: 4 }}>
        Object {objectId !== null ? String(objectId) : '?'} · {sequence.length} action
        {sequence.length === 1 ? '' : 's'}
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
        {visible.map((byte, i) => {
          const info = describeMovementAction(byte);
          const isEnd = isMovementEnd(byte);
          if (isEnd || !canEdit) {
            // Read-only chip: END sentinel OR no movement-data offset.
            return (
              <span
                key={i}
                data-testid={`movement-chip-${step.id}-${String(i)}`}
                title={`Byte 0x${byte.toString(16).padStart(2, '0')} - ${info.label}`}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 4,
                  padding: '2px 6px',
                  borderRadius: 3,
                  background: isEnd
                    ? 'var(--color-bg-elevated, #1f2227)'
                    : 'color-mix(in srgb, var(--color-accent, #4a9eff) 12%, transparent)',
                  border: '1px solid var(--color-border, #2a2e35)',
                  fontFamily: 'var(--font-mono)',
                  fontSize: 10,
                  lineHeight: 1.2,
                  whiteSpace: 'nowrap',
                }}
              >
                <span aria-hidden="true">{info.glyph}</span>
                <span>{info.label}</span>
              </span>
            );
          }
          // Editable: inline <select>.
          return (
            <select
              key={i}
              data-testid={`movement-chip-${step.id}-${String(i)}`}
              value={byte}
              onChange={(e) => {
                const next = Number.parseInt(e.target.value, 10);
                if (!Number.isFinite(next)) return;
                void setActionAt(i, next);
              }}
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 10,
                padding: '2px 4px',
                borderRadius: 3,
                background: 'color-mix(in srgb, var(--color-accent, #4a9eff) 12%, transparent)',
                border: '1px solid var(--color-border, #2a2e35)',
              }}
              title={`Byte 0x${byte.toString(16).padStart(2, '0')} - ${info.label}`}
            >
              {options.map((o) => (
                <option key={o.byte} value={o.byte}>
                  {o.glyph} {o.label}
                </option>
              ))}
              {!options.some((o) => o.byte === byte) && (
                <option value={byte}>
                  ? Action 0x{byte.toString(16).padStart(2, '0')}
                </option>
              )}
            </select>
          );
        })}
        {overflow > 0 && (
          <span
            style={{
              padding: '2px 6px',
              color: 'var(--color-text-muted)',
              fontStyle: 'italic',
            }}
          >
            +{String(overflow)} more
          </span>
        )}
      </div>
      <p style={{ fontSize: 10, color: 'var(--color-text-muted)', marginTop: 6, marginBottom: 0 }}>
        Pick a new action from any dropdown to patch that single byte
        in place. Insert / delete / reorder of the sequence is deferred
        (needs relocation).
      </p>
    </div>
  );
}

/** Phase O.25 - Warp step editor.
 *
 * Handles five warp opcode variants (warp / warpsilent / warpdoor /
 * warpteleport / warphole). Each writes a fixed-byte args block via
 * the generic script-step-args route:
 *   warp / silent / door / teleport:
 *     +0 destMapBank u8
 *     +1 destMapNum u8
 *     +2 warpId u8
 *     +3 x s16
 *     +5 y s16
 *   warphole (2 args):
 *     +0 destMapBank u8
 *     +1 destMapNum u8
 *
 * Destination map is presented as a single packed-u16 EntityPicker
 * (mirrors O.19's ConnectionRow map picker). warpId / x / y stay
 * numeric. For warphole, the warpId/x/y inputs are hidden since the
 * struct doesn't have them. */
function WarpStepEditor({
  step,
  manifest,
}: {
  step: ScriptStep;
  manifest: ProjectManifest;
}): JSX.Element {
  const params = step.params as Record<string, unknown>;
  const opcode = typeof params.opcode === 'number' ? params.opcode : null;
  const isWarphole = opcode === 0x3c; // warphole - 2-byte args, no warpId/x/y
  const fileOffset = typeof params.fileOffset === 'number' ? params.fileOffset : null;
  const sessionId = useProjectStore((s) =>
    s.load.kind === 'loaded' ? s.load.data.session.id : null,
  );
  const scanCurrent = useProjectStore((s) => s.scanCurrentProject);

  const initialDestMapBank =
    typeof params.destMapBank === 'number' ? params.destMapBank : 0;
  const initialDestMapNum =
    typeof params.destMapNum === 'number' ? params.destMapNum : 0;
  const initialWarpId = typeof params.warpId === 'number' ? params.warpId : 0;
  const initialX = typeof params.x === 'number' ? params.x : 0;
  const initialY = typeof params.y === 'number' ? params.y : 0;

  const [destMapBank, setDestMapBank] = useState(initialDestMapBank);
  const [destMapNum, setDestMapNum] = useState(initialDestMapNum);
  const [warpId, setWarpId] = useState(initialWarpId);
  const [x, setX] = useState(initialX);
  const [y, setY] = useState(initialY);
  const [state, setState] = useState<
    | { kind: 'idle' }
    | { kind: 'saving' }
    | { kind: 'saved' }
    | { kind: 'error'; message: string }
  >({ kind: 'idle' });

  useEffect(() => {
    setDestMapBank(initialDestMapBank);
    setDestMapNum(initialDestMapNum);
    setWarpId(initialWarpId);
    setX(initialX);
    setY(initialY);
    setState({ kind: 'idle' });
  }, [
    step.id,
    initialDestMapBank,
    initialDestMapNum,
    initialWarpId,
    initialX,
    initialY,
  ]);

  const dirty =
    destMapBank !== initialDestMapBank ||
    destMapNum !== initialDestMapNum ||
    (!isWarphole && warpId !== initialWarpId) ||
    (!isWarphole && x !== initialX) ||
    (!isWarphole && y !== initialY);
  const canSave = dirty && fileOffset !== null && sessionId !== null;

  async function save(): Promise<void> {
    if (!sessionId || fileOffset === null) return;
    setState({ kind: 'saving' });
    try {
      const argBytes = isWarphole
        ? [destMapBank & 0xff, destMapNum & 0xff]
        : [
            destMapBank & 0xff,
            destMapNum & 0xff,
            warpId & 0xff,
            ...u16ToLE(x),
            ...u16ToLE(y),
          ];
      await editBinaryRomScriptStepArgs(sessionId, {
        stepFileOffset: fileOffset,
        argBytes,
      });
      setState({ kind: 'saved' });
      pushToast('success', 'Warp step saved');
      await scanCurrent();
    } catch (e) {
      const message =
        e instanceof ProjectApiError
          ? `${e.code}: ${e.message}`
          : e instanceof Error
            ? e.message
            : String(e);
      setState({ kind: 'error', message });
      pushToast('error', `Warp step save failed - ${message}`);
    }
  }

  return (
    <div
      className="script-steps__arg-editor"
      data-testid={`warp-step-editor-${step.id}`}
    >
      <div className="script-steps__arg-fields">
        <label className="script-steps__arg-field">
          <span className="script-steps__arg-label">Destination map</span>
          <EntityPicker
            kind="map"
            manifest={manifest}
            value={packMapId(destMapBank, destMapNum)}
            onChange={(next) => {
              setDestMapBank(unpackMapGroup(next));
              setDestMapNum(unpackMapNum(next));
            }}
            minId={0}
            maxId={0xffff}
            testIdPrefix={`warp-step-${step.id}-dest`}
          />
        </label>
        {!isWarphole && (
          <>
            <label className="script-steps__arg-field">
              <span className="script-steps__arg-label">Dest warp id (u8)</span>
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
                data-testid={`warp-step-${step.id}-warp-id`}
              />
              <span className="script-steps__arg-hex">0x{warpId.toString(16)}</span>
            </label>
            <label className="script-steps__arg-field">
              <span className="script-steps__arg-label">x (s16)</span>
              <input
                type="number"
                min={-0x8000}
                max={0x7fff}
                value={x}
                onChange={(e) => setX(Number.parseInt(e.target.value, 10) || 0)}
                data-testid={`warp-step-${step.id}-x`}
              />
            </label>
            <label className="script-steps__arg-field">
              <span className="script-steps__arg-label">y (s16)</span>
              <input
                type="number"
                min={-0x8000}
                max={0x7fff}
                value={y}
                onChange={(e) => setY(Number.parseInt(e.target.value, 10) || 0)}
                data-testid={`warp-step-${step.id}-y`}
              />
            </label>
          </>
        )}
      </div>
      <div className="script-steps__msgbox-actions">
        <button
          type="button"
          className="btn btn--primary"
          data-testid={`warp-step-save-${step.id}`}
          disabled={!canSave || state.kind === 'saving'}
          onClick={() => void save()}
          title={
            fileOffset === null
              ? 'No file offset - cannot save.'
              : !dirty
                ? 'No changes.'
                : isWarphole
                  ? 'Patch warphole args (2 bytes: destMapBank, destMapNum).'
                  : 'Patch warp args (7 bytes: destMapBank, destMapNum, warpId, x, y).'
          }
        >
          {state.kind === 'saving' ? 'Saving…' : 'Save warp'}
        </button>
        {state.kind === 'saved' && !dirty && (
          <span className="script-steps__msgbox-ok">Saved</span>
        )}
        {state.kind === 'error' && (
          <span className="script-steps__msgbox-err">{state.message}</span>
        )}
      </div>
    </div>
  );
}
