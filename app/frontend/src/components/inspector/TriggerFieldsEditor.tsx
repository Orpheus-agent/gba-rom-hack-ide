import { useEffect, useState } from 'react';
import type { Trigger } from '@rom-editor/shared';
import {
  editBinaryRomMapEventTable,
  editBinaryRomTriggerFields,
  ProjectApiError,
} from '../../api';
import { pushToast, useProjectStore } from '../../state';
import { useEditFormKeyboard } from '../../lib/useEditFormKeyboard';
import { EntityPicker } from '../EntityPicker';

/**
 * Phase J.1 - editable trigger fields for binary-ROM signs / coord
 * triggers. Sign Behavior (bg-event kind) is a labeled dropdown;
 * coord-trigger Variable + Value are numeric inputs. Backs onto the
 * new `POST /binary-rom-edit/trigger-fields` route which patches the
 * 12-byte BgEvent or 16-byte CoordEvent struct in place.
 *
 * Falls back to a "not editable" note for decomp triggers (handled by
 * the existing ConditionEditor in EventsView for those).
 */

interface TriggerFieldsEditorProps {
  readonly trigger: Trigger;
}

type SaveState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'saving' }
  | { readonly kind: 'saved' }
  | { readonly kind: 'error'; readonly message: string };

/** Gen-3 BG_EVENT_KIND values per pret/pokefirered include/constants/event_bg.h.
 *  Common ones; hack-added kinds fall through as "Hack-specific". */
const BG_EVENT_KIND_OPTIONS: ReadonlyArray<{ value: number; label: string }> = [
  { value: 0, label: '0 - Sign (player facing any)' },
  { value: 1, label: '1 - Sign (player facing north)' },
  { value: 2, label: '2 - Sign (player facing south)' },
  { value: 3, label: '3 - Sign (player facing east)' },
  { value: 4, label: '4 - Sign (player facing west)' },
  { value: 5, label: '5 - Hidden item' },
  { value: 6, label: '6 - Secret base' },
  { value: 7, label: '7 - Hidden item (custom)' },
];

export function TriggerFieldsEditor({ trigger }: TriggerFieldsEditorProps) {
  const sessionId = useProjectStore((s) =>
    s.load.kind === 'loaded' ? s.load.data.session.id : null,
  );
  const scanCurrent = useProjectStore((s) => s.scanCurrentProject);
  const manifest = useProjectStore((s) =>
    s.scan.kind === 'loaded' ? s.scan.data.manifest : null,
  );

  const meta = trigger.metadata ?? {};
  const structFileOffset =
    typeof meta['structFileOffset'] === 'number' ? (meta['structFileOffset'] as number) : -1;
  const triggerKind: 'bg' | 'coord' | null = trigger.id.includes('_bg_')
    ? 'bg'
    : trigger.id.includes('_coord_')
      ? 'coord'
      : null;

  const initialBgKind =
    typeof meta['bgEventKind'] === 'number' ? (meta['bgEventKind'] as number) : 0;
  const initialVar =
    typeof meta['coordTriggerVar'] === 'number' ? (meta['coordTriggerVar'] as number) : 0;
  const initialValue =
    typeof meta['coordTriggerIndex'] === 'number'
      ? (meta['coordTriggerIndex'] as number)
      : 0;
  const initialElevation =
    typeof meta['elevation'] === 'number' ? (meta['elevation'] as number) : 0;
  const initialHiddenItemId =
    typeof meta['hiddenItemId'] === 'number' ? (meta['hiddenItemId'] as number) : 0;
  const initialHiddenItemFlagOffset =
    typeof meta['hiddenItemFlagOffset'] === 'number'
      ? (meta['hiddenItemFlagOffset'] as number)
      : 0;
  const initialHiddenItemQuantity =
    typeof meta['hiddenItemQuantity'] === 'number'
      ? (meta['hiddenItemQuantity'] as number)
      : 1;

  const [bgKind, setBgKind] = useState(initialBgKind);
  const [varId, setVarId] = useState(initialVar);
  const [varValue, setVarValue] = useState(initialValue);
  const [elevation, setElevation] = useState(initialElevation);
  const [hiddenItemId, setHiddenItemId] = useState(initialHiddenItemId);
  const [hiddenItemFlagOffset, setHiddenItemFlagOffset] = useState(
    initialHiddenItemFlagOffset,
  );
  const [hiddenItemQuantity, setHiddenItemQuantity] = useState(initialHiddenItemQuantity);
  const [state, setState] = useState<SaveState>({ kind: 'idle' });

  useEffect(() => {
    setBgKind(initialBgKind);
    setVarId(initialVar);
    setVarValue(initialValue);
    setElevation(initialElevation);
    setHiddenItemId(initialHiddenItemId);
    setHiddenItemFlagOffset(initialHiddenItemFlagOffset);
    setHiddenItemQuantity(initialHiddenItemQuantity);
    setState({ kind: 'idle' });
  }, [
    trigger.id,
    initialBgKind,
    initialVar,
    initialValue,
    initialElevation,
    initialHiddenItemId,
    initialHiddenItemFlagOffset,
    initialHiddenItemQuantity,
  ]);

  if (triggerKind === null || structFileOffset <= 0) {
    return (
      <p className="fields-editor__note">
        Trigger struct offset isn't in the manifest yet - binary-ROM edit
        path can't reach this trigger's bytes. Decomp projects edit via
        the Events tab's ConditionEditor instead.
      </p>
    );
  }

  const isHiddenItem = triggerKind === 'bg' && (bgKind === 5 || bgKind === 7);
  const wasInitiallyHiddenItem = initialBgKind === 5 || initialBgKind === 7;
  // Phase O.34 - when the user changes the kind dropdown into a
  // hidden-item kind from a sign kind, the editor pre-fills sane
  // defaults (item 0, flag 0, quantity 1) instead of garbage values
  // unpacked from the previous script pointer. On save we force-send
  // those bytes so the ROM data is coherent for the new kind.
  const crossingIntoHiddenItem = isHiddenItem && !wasInitiallyHiddenItem;
  const hiddenItemDirty =
    isHiddenItem &&
    (hiddenItemId !== initialHiddenItemId ||
      hiddenItemFlagOffset !== initialHiddenItemFlagOffset ||
      hiddenItemQuantity !== initialHiddenItemQuantity);
  const dirty =
    triggerKind === 'bg'
      ? bgKind !== initialBgKind || elevation !== initialElevation || hiddenItemDirty
      : varId !== initialVar ||
        varValue !== initialValue ||
        elevation !== initialElevation;
  const canSave = dirty && sessionId !== null;

  function changeBgKind(next: number): void {
    setBgKind(next);
    const becomingHiddenItem = next === 5 || next === 7;
    if (becomingHiddenItem && !wasInitiallyHiddenItem) {
      // Sign → hidden item: reset the data bytes to sane defaults so
      // the editor displays a coherent starting state instead of
      // numbers unpacked from the previous script pointer.
      setHiddenItemId(0);
      setHiddenItemFlagOffset(0);
      setHiddenItemQuantity(1);
    } else if (!becomingHiddenItem && wasInitiallyHiddenItem) {
      // Hidden item → sign: restore initial hidden-item state so the
      // dirty check doesn't fire on values that will be hidden anyway.
      // The data bytes carry forward - the new sign re-uses the same
      // 4 bytes as its script pointer (which is probably invalid;
      // surfaced to the user via the warning hint below).
      setHiddenItemId(initialHiddenItemId);
      setHiddenItemFlagOffset(initialHiddenItemFlagOffset);
      setHiddenItemQuantity(initialHiddenItemQuantity);
    }
  }

  async function save(): Promise<void> {
    if (!sessionId) return;
    setState({ kind: 'saving' });
    try {
      const fields: {
        bgEventKind?: number;
        coordTriggerVar?: number;
        coordTriggerIndex?: number;
        elevation?: number;
        hiddenItemId?: number;
        hiddenItemFlagOffset?: number;
        hiddenItemQuantity?: number;
      } = {};
      if (elevation !== initialElevation) fields.elevation = elevation;
      if (triggerKind === 'bg') {
        if (bgKind !== initialBgKind) fields.bgEventKind = bgKind;
        if (isHiddenItem) {
          // Phase O.34 - when crossing INTO hidden-item from a sign kind,
          // force-send all three hidden-item fields so the stale script
          // pointer in the data bytes is fully overwritten.
          const forceSend = crossingIntoHiddenItem;
          if (forceSend || hiddenItemId !== initialHiddenItemId)
            fields.hiddenItemId = hiddenItemId;
          if (forceSend || hiddenItemFlagOffset !== initialHiddenItemFlagOffset)
            fields.hiddenItemFlagOffset = hiddenItemFlagOffset;
          if (forceSend || hiddenItemQuantity !== initialHiddenItemQuantity)
            fields.hiddenItemQuantity = hiddenItemQuantity;
        }
      } else {
        if (varId !== initialVar) fields.coordTriggerVar = varId;
        if (varValue !== initialValue) fields.coordTriggerIndex = varValue;
      }
      await editBinaryRomTriggerFields(sessionId, {
        triggerKind: triggerKind as 'bg' | 'coord',
        structFileOffset,
        fields,
      });
      setState({ kind: 'saved' });
      pushToast(
        'success',
        triggerKind === 'bg' ? 'Sign saved' : 'Step trigger saved',
      );
      await scanCurrent();
    } catch (e) {
      const message =
        e instanceof ProjectApiError
          ? `${e.code}: ${e.message}`
          : e instanceof Error
            ? e.message
            : String(e);
      setState({ kind: 'error', message });
      pushToast(
        'error',
        `${triggerKind === 'bg' ? 'Sign' : 'Step trigger'} save failed - ${message}`,
      );
    }
  }

  // Phase O.29 - Enter saves, Esc reverts trigger fields.
  const onKeyDownEdit = useEditFormKeyboard({
    canSave: canSave && state.kind !== 'saving',
    save,
    cancel: () => {
      setBgKind(initialBgKind);
      setVarId(initialVar);
      setVarValue(initialValue);
      setElevation(initialElevation);
      setHiddenItemId(initialHiddenItemId);
      setHiddenItemFlagOffset(initialHiddenItemFlagOffset);
      setHiddenItemQuantity(initialHiddenItemQuantity);
      setState({ kind: 'idle' });
    },
    isSaving: state.kind === 'saving',
  });

  return (
    <div
      className="fields-editor"
      data-testid="trigger-fields-editor"
      onKeyDown={onKeyDownEdit}
    >
      <h5 className="fields-editor__heading">
        {triggerKind === 'bg' ? 'Sign / hidden item fields' : 'Coord-trigger fields'}
      </h5>
      {triggerKind === 'bg' ? (
        <>
          <div className="fields-editor__row">
            <label>
              Behavior (bg-event kind)
              <select
                data-testid="trigger-bg-kind"
                value={bgKind}
                onChange={(e) => changeBgKind(Number.parseInt(e.target.value, 10))}
              >
                {BG_EVENT_KIND_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
                {!BG_EVENT_KIND_OPTIONS.some((o) => o.value === bgKind) && (
                  <option value={bgKind}>{`${bgKind} - Hack-specific`}</option>
                )}
              </select>
            </label>
          </div>
          {crossingIntoHiddenItem && (
            <p
              className="fields-editor__hint"
              data-testid="trigger-bg-kind-conversion-hint"
            >
              Converting from sign to hidden item - the previous script pointer
              has been replaced with defaults (item 0, flag 0, quantity 1).
              Pick a real item before saving.
            </p>
          )}
          {!isHiddenItem && wasInitiallyHiddenItem && (
            <p
              className="fields-editor__hint fields-editor__hint--warn"
              data-testid="trigger-bg-kind-leaving-hidden-item-hint"
            >
              Converting from hidden item to sign - the packed hidden-item
              bytes will be reinterpreted as a script pointer, which is
              probably not a valid script. Sign / script editing isn't
              wired yet; consider keeping this as a hidden item until that
              lands.
            </p>
          )}
          {isHiddenItem && manifest && (
            <div
              className="fields-editor__row fields-editor__row--inline"
              data-testid="trigger-hidden-item-fields"
            >
              <label>
                Item
                <EntityPicker
                  kind="item"
                  manifest={manifest}
                  value={hiddenItemId}
                  onChange={setHiddenItemId}
                  minId={0}
                  maxId={0xffff}
                  testIdPrefix="trigger-hidden-item-id"
                />
              </label>
              <label>
                Flag offset (u8)
                <input
                  type="number"
                  min={0}
                  max={0xff}
                  data-testid="trigger-hidden-item-flag-offset"
                  value={hiddenItemFlagOffset}
                  onChange={(e) =>
                    setHiddenItemFlagOffset(
                      Math.max(
                        0,
                        Math.min(0xff, Number.parseInt(e.target.value, 10) || 0),
                      ),
                    )
                  }
                />
              </label>
              <label>
                Quantity (u8)
                <input
                  type="number"
                  min={0}
                  max={0xff}
                  data-testid="trigger-hidden-item-quantity"
                  value={hiddenItemQuantity}
                  onChange={(e) =>
                    setHiddenItemQuantity(
                      Math.max(
                        0,
                        Math.min(0xff, Number.parseInt(e.target.value, 10) || 0),
                      ),
                    )
                  }
                />
              </label>
            </div>
          )}
          {isHiddenItem && (
            <p className="fields-editor__hint">
              Flag offset is added to FLAG_HIDDEN_ITEMS_START to mark this item
              as taken. Quantity = how many the player receives (1 for most
              items, 5 for berries).
            </p>
          )}
        </>
      ) : (
        <>
          <div className="fields-editor__row fields-editor__row--inline">
            <label>
              Variable id (u16)
              <input
                type="number"
                min={0}
                max={0xffff}
                data-testid="trigger-coord-var"
                value={varId}
                onChange={(e) =>
                  setVarId(
                    Math.max(0, Math.min(0xffff, Number.parseInt(e.target.value, 10) || 0)),
                  )
                }
              />
            </label>
            <label>
              Compares to (u16)
              <input
                type="number"
                min={0}
                max={0xffff}
                data-testid="trigger-coord-value"
                value={varValue}
                onChange={(e) =>
                  setVarValue(
                    Math.max(0, Math.min(0xffff, Number.parseInt(e.target.value, 10) || 0)),
                  )
                }
              />
            </label>
          </div>
          <p className="fields-editor__hint">
            Fires when variable 0x{varId.toString(16)} == {varValue}.
          </p>
        </>
      )}
      <div className="fields-editor__row">
        <label>
          Elevation (u8 - 0..15 commonly used)
          <input
            type="number"
            min={0}
            max={0xff}
            data-testid="trigger-elevation"
            value={elevation}
            onChange={(e) =>
              setElevation(
                Math.max(0, Math.min(0xff, Number.parseInt(e.target.value, 10) || 0)),
              )
            }
          />
        </label>
      </div>
      <div className="fields-editor__actions">
        <button
          type="button"
          className="btn btn--primary"
          data-testid="trigger-fields-save"
          disabled={!canSave || state.kind === 'saving'}
          onClick={() => void save()}
        >
          {state.kind === 'saving' ? 'Saving…' : 'Save trigger'}
        </button>
        <DuplicateTriggerButton
          trigger={trigger}
          triggerKind={triggerKind}
          structFileOffset={structFileOffset}
          bgKind={bgKind}
          elevation={elevation}
          varId={varId}
          varValue={varValue}
          hiddenItemId={hiddenItemId}
          hiddenItemFlagOffset={hiddenItemFlagOffset}
          hiddenItemQuantity={hiddenItemQuantity}
          isHiddenItem={isHiddenItem}
        />
        <DeleteTriggerButton
          trigger={trigger}
          triggerKind={triggerKind}
          structFileOffset={structFileOffset}
        />
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

/**
 * Phase O.36 - Duplicate trigger button. Appends a new BG or coord
 * event slot using the current form values + (+1, 0) tile offset.
 * For BG events the `data` u32 carries either the original script
 * pointer (sign kinds 0-4) or the freshly-typed item-id / flag /
 * quantity packed struct (kinds 5/7). For coord events the
 * `scriptPointer` is reconstructed from the existing `scriptStepIds`
 * entry (e.g. `binary_script_0xN`) by adding GBA_ROM_BASE_ADDRESS.
 */
function DuplicateTriggerButton({
  trigger,
  triggerKind,
  structFileOffset,
  bgKind,
  elevation,
  varId,
  varValue,
  hiddenItemId,
  hiddenItemFlagOffset,
  hiddenItemQuantity,
  isHiddenItem,
}: {
  trigger: Trigger;
  triggerKind: 'bg' | 'coord' | null;
  structFileOffset: number;
  bgKind: number;
  elevation: number;
  varId: number;
  varValue: number;
  hiddenItemId: number;
  hiddenItemFlagOffset: number;
  hiddenItemQuantity: number;
  isHiddenItem: boolean;
}): JSX.Element | null {
  const sessionId = useProjectStore((s) =>
    s.load.kind === 'loaded' ? s.load.data.session.id : null,
  );
  const scanCurrent = useProjectStore((s) => s.scanCurrentProject);
  const parentMap = useProjectStore((s) =>
    s.scan.kind === 'loaded' && trigger.mapId
      ? s.scan.data.manifest.maps.find((m) => m.id === trigger.mapId) ?? null
      : null,
  );
  const mapEventsStructOffset =
    parentMap && typeof parentMap.metadata['binaryRomMapEventsStructOffset'] === 'number'
      ? (parentMap.metadata['binaryRomMapEventsStructOffset'] as number)
      : -1;
  const subArrayOffset =
    parentMap && triggerKind === 'bg'
      ? (parentMap.metadata['binaryRomBgEventsArrayOffset'] as number) ?? -1
      : parentMap && triggerKind === 'coord'
        ? (parentMap.metadata['binaryRomCoordEventsArrayOffset'] as number) ?? -1
        : -1;
  const meta = trigger.metadata ?? {};
  const bgEventDataRaw =
    typeof meta['bgEventDataRaw'] === 'number' ? (meta['bgEventDataRaw'] as number) : 0;
  const [state, setState] = useState<SaveState>({ kind: 'idle' });
  if (
    triggerKind === null ||
    structFileOffset <= 0 ||
    mapEventsStructOffset <= 0 ||
    subArrayOffset <= 0
  ) {
    return null;
  }
  const kind: 'coordEvent' | 'bgEvent' = triggerKind === 'coord' ? 'coordEvent' : 'bgEvent';
  return (
    <button
      type="button"
      className="btn btn--secondary"
      data-testid="trigger-duplicate"
      disabled={!sessionId || state.kind === 'saving'}
      onClick={() => {
        if (!sessionId) return;
        const newX = trigger.coord?.x !== undefined ? trigger.coord.x + 1 : 0;
        const newY = trigger.coord?.y ?? 0;
        void (async () => {
          setState({ kind: 'saving' });
          try {
            if (kind === 'bgEvent') {
              // For sign kinds (0-4) reuse the original script pointer
              // u32 unchanged so the duplicate fires the same script.
              // For hidden-item kinds (5/7) pack the current editor
              // state into the 4-byte struct shape so the duplicate
              // gives the same item.
              const data = isHiddenItem
                ? ((hiddenItemQuantity & 0xff) << 24) |
                  ((hiddenItemFlagOffset & 0xff) << 16) |
                  (hiddenItemId & 0xffff)
                : bgEventDataRaw;
              await editBinaryRomMapEventTable(sessionId, {
                mapEventsStructOffset,
                subArrayOffset,
                kind: 'bgEvent',
                op: 'append',
                newBgEvent: {
                  x: newX,
                  y: newY,
                  elevation,
                  kind: bgKind,
                  data: data >>> 0,
                },
              });
            } else {
              // Reconstruct the script ROM pointer from the
              // scriptStepIds entry (binary_script_0xN). If absent or
              // unparseable, append with scriptPointer=0 (no script);
              // the user can wire it up after the next re-scan.
              let scriptPointer = 0;
              const stepId = trigger.scriptStepIds?.[0] ?? '';
              const m = /^binary_script_0x([0-9a-fA-F]+)$/.exec(stepId);
              if (m) {
                const fileOff = parseInt(m[1]!, 16);
                if (Number.isFinite(fileOff)) {
                  scriptPointer = (fileOff + 0x08000000) >>> 0;
                }
              }
              await editBinaryRomMapEventTable(sessionId, {
                mapEventsStructOffset,
                subArrayOffset,
                kind: 'coordEvent',
                op: 'append',
                newCoordEvent: {
                  x: newX,
                  y: newY,
                  elevation,
                  trigger: varId,
                  index: varValue,
                  scriptPointer,
                },
              });
            }
            setState({ kind: 'saved' });
            pushToast(
              'success',
              `${triggerKind === 'bg' ? 'Sign' : 'Step trigger'} duplicated at (${newX}, ${newY})`,
            );
            await scanCurrent();
          } catch (e) {
            const message =
              e instanceof ProjectApiError
                ? `${e.code}: ${e.message}`
                : e instanceof Error
                  ? e.message
                  : String(e);
            setState({ kind: 'error', message });
            pushToast('error', `Duplicate failed - ${message}`);
          }
        })();
      }}
    >
      Duplicate
    </button>
  );
}

function DeleteTriggerButton({
  trigger,
  triggerKind,
  structFileOffset,
}: {
  trigger: Trigger;
  triggerKind: 'bg' | 'coord' | null;
  structFileOffset: number;
}): JSX.Element | null {
  const sessionId = useProjectStore((s) =>
    s.load.kind === 'loaded' ? s.load.data.session.id : null,
  );
  const scanCurrent = useProjectStore((s) => s.scanCurrentProject);
  const parentMap = useProjectStore((s) =>
    s.scan.kind === 'loaded' && trigger.mapId
      ? s.scan.data.manifest.maps.find((m) => m.id === trigger.mapId) ?? null
      : null,
  );
  const mapEventsStructOffset =
    parentMap && typeof parentMap.metadata['binaryRomMapEventsStructOffset'] === 'number'
      ? (parentMap.metadata['binaryRomMapEventsStructOffset'] as number)
      : -1;
  const subArrayOffset =
    parentMap && triggerKind === 'bg'
      ? (parentMap.metadata['binaryRomBgEventsArrayOffset'] as number) ?? -1
      : parentMap && triggerKind === 'coord'
        ? (parentMap.metadata['binaryRomCoordEventsArrayOffset'] as number) ?? -1
        : -1;
  const [state, setState] = useState<SaveState>({ kind: 'idle' });
  if (
    triggerKind === null ||
    structFileOffset <= 0 ||
    mapEventsStructOffset <= 0 ||
    subArrayOffset <= 0
  ) {
    return null;
  }
  const kind: 'coordEvent' | 'bgEvent' = triggerKind === 'coord' ? 'coordEvent' : 'bgEvent';
  return (
    <button
      type="button"
      className="btn btn--secondary"
      data-testid="trigger-delete"
      disabled={!sessionId || state.kind === 'saving'}
      onClick={() => {
        if (!window.confirm(`Delete this ${triggerKind === 'bg' ? 'sign / hidden item' : 'step trigger'}? Subsequent entries shift up.`)) return;
        void (async () => {
          if (!sessionId) return;
          setState({ kind: 'saving' });
          try {
            await editBinaryRomMapEventTable(sessionId, {
              mapEventsStructOffset,
              subArrayOffset,
              kind,
              op: 'delete',
              deleteStructFileOffset: structFileOffset,
            });
            setState({ kind: 'saved' });
            pushToast('success', `${triggerKind === 'bg' ? 'Sign' : 'Step trigger'} deleted`);
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
        })();
      }}
      style={{ color: 'var(--color-error, #e25555)' }}
    >
      Delete
    </button>
  );
}
