import { useMemo, useState } from 'react';
import type { InspectorPanelProps } from '../lib/inspectorRegistry';
import { displayName } from '../lib/displayName';
import {
  pushToast,
  useProjectStore,
  useSelection,
  useUiPreferencesStore,
} from '../state';
import { editBinaryRomTriggerFields, ProjectApiError } from '../api';
import type { ProjectManifest, Trigger } from '@rom-editor/shared';
import './InspectorShared.css';

// Phase S.8 (lite) - TriggerInspector. Read view of a map trigger's
// kind, location, condition, and the chain of script steps that fire.
// Each step is click-through so the operator can walk into the visual
// event graph (Phase V) once that surface lands. For now, clicking a
// step selects it and the InspectorDock falls back to the P.3
// placeholder until S.8 full step inspector ships.
//
// Phase S.4-edit - for binary-ROM bg/coord triggers (those carrying
// structFileOffset + bgEventKind/coordTriggerVar in metadata), grow an
// inline edit form so trigger struct fields can be patched from
// anywhere the dock is reachable (Find, Cmd+K results, etc.) without
// routing back into MapEditor's right-aside.

function findTrigger(
  manifest: ProjectManifest | null,
  selectionId: string,
): Trigger | null {
  if (!manifest) return null;
  return manifest.triggers.find((t) => t.id === selectionId) ?? null;
}

const KIND_LABELS: Record<string, string> = {
  on_enter: 'On enter',
  on_interact: 'On interact',
  on_flag_set: 'On flag set',
};

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

function detectTriggerKind(triggerId: string): 'bg' | 'coord' | null {
  if (triggerId.includes('_bg_')) return 'bg';
  if (triggerId.includes('_coord_')) return 'coord';
  return null;
}

function metaNum(
  meta: Readonly<Record<string, string | number | boolean>> | undefined,
  key: string,
  fallback = 0,
): number {
  if (!meta) return fallback;
  return typeof meta[key] === 'number' ? (meta[key] as number) : fallback;
}

export function TriggerInspector({
  selection,
  manifest,
  sessionId,
}: InspectorPanelProps) {
  const showInternalIds = useUiPreferencesStore((s) => s.showInternalIds);
  const select = useSelection((s) => s.select);
  const scanCurrentProject = useProjectStore((s) => s.scanCurrentProject);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);

  const trigger = useMemo(
    () => findTrigger(manifest, selection.id),
    [manifest, selection.id],
  );

  const meta = trigger?.metadata;
  const structFileOffset = trigger ? metaNum(meta, 'structFileOffset', -1) : -1;
  const triggerKind = trigger ? detectTriggerKind(trigger.id) : null;
  const initialBgKind = metaNum(meta, 'bgEventKind', 0);
  const initialElevation = metaNum(meta, 'elevation', 0);
  const initialVar = metaNum(meta, 'coordTriggerVar', 0);
  const initialValue = metaNum(meta, 'coordTriggerIndex', 0);
  const initialHiddenItemId = metaNum(meta, 'hiddenItemId', 0);
  const initialHiddenItemFlagOffset = metaNum(meta, 'hiddenItemFlagOffset', 0);
  const initialHiddenItemQuantity = metaNum(meta, 'hiddenItemQuantity', 1);

  const [draftBgKind, setDraftBgKind] = useState(initialBgKind);
  const [draftElevation, setDraftElevation] = useState(initialElevation);
  const [draftVar, setDraftVar] = useState(initialVar);
  const [draftValue, setDraftValue] = useState(initialValue);
  const [draftHiddenItemId, setDraftHiddenItemId] = useState(initialHiddenItemId);
  const [draftHiddenItemFlagOffset, setDraftHiddenItemFlagOffset] = useState(
    initialHiddenItemFlagOffset,
  );
  const [draftHiddenItemQuantity, setDraftHiddenItemQuantity] = useState(
    initialHiddenItemQuantity,
  );

  function beginEdit() {
    setDraftBgKind(initialBgKind);
    setDraftElevation(initialElevation);
    setDraftVar(initialVar);
    setDraftValue(initialValue);
    setDraftHiddenItemId(initialHiddenItemId);
    setDraftHiddenItemFlagOffset(initialHiddenItemFlagOffset);
    setDraftHiddenItemQuantity(initialHiddenItemQuantity);
    setEditing(true);
  }

  async function commitEdit() {
    if (!trigger || !sessionId || structFileOffset < 0 || !triggerKind) return;
    const fields: {
      bgEventKind?: number;
      coordTriggerVar?: number;
      coordTriggerIndex?: number;
      elevation?: number;
      hiddenItemId?: number;
      hiddenItemFlagOffset?: number;
      hiddenItemQuantity?: number;
    } = {};
    if (draftElevation !== initialElevation) fields.elevation = draftElevation;
    if (triggerKind === 'bg') {
      if (draftBgKind !== initialBgKind) fields.bgEventKind = draftBgKind;
      const isHiddenItem = draftBgKind === 5 || draftBgKind === 7;
      if (isHiddenItem) {
        if (draftHiddenItemId !== initialHiddenItemId)
          fields.hiddenItemId = draftHiddenItemId;
        if (draftHiddenItemFlagOffset !== initialHiddenItemFlagOffset)
          fields.hiddenItemFlagOffset = draftHiddenItemFlagOffset;
        if (draftHiddenItemQuantity !== initialHiddenItemQuantity)
          fields.hiddenItemQuantity = draftHiddenItemQuantity;
      }
    } else {
      if (draftVar !== initialVar) fields.coordTriggerVar = draftVar;
      if (draftValue !== initialValue) fields.coordTriggerIndex = draftValue;
    }
    if (Object.keys(fields).length === 0) {
      setEditing(false);
      return;
    }
    setSaving(true);
    try {
      await editBinaryRomTriggerFields(sessionId, {
        triggerKind,
        structFileOffset,
        fields,
      });
      pushToast('success', `Trigger saved`);
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

  if (!manifest) {
    return (
      <div className="entity-inspector entity-inspector--empty" data-testid="trigger-inspector">
        <p>Open a project to inspect <code>{selection.id}</code>.</p>
      </div>
    );
  }
  if (!trigger) {
    return (
      <div className="entity-inspector entity-inspector--empty" data-testid="trigger-inspector">
        <p>
          No trigger with id <code>{selection.id}</code> in the manifest
          ({manifest.triggers.length} triggers indexed).
        </p>
      </div>
    );
  }

  // Pull the actual ScriptStep records so we can label by their kind
  // and surface a one-line preview where useful.
  const steps = useMemo(() => {
    const stepIndex = new Map(
      (manifest.scriptSteps ?? []).map((s) => [s.id, s]),
    );
    return trigger.scriptStepIds.map((id) => ({
      id,
      step: stepIndex.get(id) ?? null,
    }));
  }, [manifest.scriptSteps, trigger.scriptStepIds]);

  const editable =
    sessionId !== null && structFileOffset >= 0 && triggerKind !== null;
  const isHiddenItem = draftBgKind === 5 || draftBgKind === 7;

  return (
    <div className="entity-inspector" data-testid="trigger-inspector">
      <header className="entity-inspector__header">
        <div className="entity-inspector__sub" data-testid="trigger-inspector-kind">
          {KIND_LABELS[trigger.kind] ?? trigger.kind}
        </div>
        <div className="entity-inspector__title" data-testid="trigger-inspector-name">
          {displayName(manifest, trigger.id, showInternalIds)}
        </div>
        {trigger.mapId && (
          <div className="entity-inspector__sub">
            on{' '}
            <button
              type="button"
              style={{ display: 'inline', padding: 0, background: 'transparent', border: 'none', color: 'var(--color-accent)', textDecoration: 'underline', textDecorationStyle: 'dotted', cursor: 'pointer', font: 'inherit', fontSize: 'inherit' }}
              onClick={() => select({ kind: 'map', id: trigger.mapId as string })}
            >
              {displayName(manifest, trigger.mapId, showInternalIds)}
            </button>
            {trigger.coord ? ` @ (${trigger.coord.x}, ${trigger.coord.y})` : ''}
          </div>
        )}
      </header>

      {trigger.conditionExpression && (
        <section
          className="entity-inspector__refs"
          data-testid="trigger-inspector-condition"
        >
          <h3 className="entity-inspector__refs-heading">Condition</h3>
          <p
            style={{
              margin: 0,
              padding: '6px 8px',
              background: 'rgba(255, 255, 255, 0.02)',
              border: '1px solid var(--color-border)',
              borderRadius: 3,
              fontFamily: 'monospace',
              fontSize: 12,
            }}
          >
            {trigger.conditionExpression}
          </p>
        </section>
      )}

      <section
        className="entity-inspector__refs"
        data-testid="trigger-inspector-steps"
      >
        <h3 className="entity-inspector__refs-heading">
          Script chain{' '}
          <span className="entity-inspector__refs-count">({steps.length})</span>
        </h3>
        {steps.length === 0 ? (
          <p className="entity-inspector__refs-empty">
            Trigger has no script steps in the lifted manifest. May be a
            stub or its script wasn't decoded.
          </p>
        ) : (
          <ul className="entity-inspector__refs-list">
            {steps.slice(0, 30).map((s, i) => (
              <li key={`${s.id}-${i}`}>
                <button
                  type="button"
                  className="entity-inspector__refs-btn"
                  onClick={() => select({ kind: 'scriptStep', id: s.id })}
                >
                  <span className="entity-inspector__refs-btn-label">
                    {i + 1}. {s.step?.kind ?? '(unknown)'}
                  </span>
                  <span className="entity-inspector__refs-btn-meta">
                    {displayName(manifest, s.id, showInternalIds)}
                  </span>
                </button>
              </li>
            ))}
            {steps.length > 30 && (
              <li className="entity-inspector__refs-more">
                + {steps.length - 30} more
              </li>
            )}
          </ul>
        )}
      </section>

      {!editing && editable && (
        <button
          type="button"
          className="entity-inspector__edit-btn"
          onClick={beginEdit}
          data-testid="trigger-inspector-edit-btn"
        >
          Edit trigger fields…
        </button>
      )}
      {editing && (
        <div
          className="entity-inspector__edit-form"
          data-testid="trigger-inspector-edit-form"
        >
          {triggerKind === 'bg' && (
            <>
              <label className="entity-inspector__num-field">
                <span>Sign behavior</span>
                <select
                  value={draftBgKind}
                  data-testid="trigger-inspector-edit-bg-kind"
                  onChange={(e) => {
                    const n = Number.parseInt(e.target.value, 10);
                    if (Number.isFinite(n)) setDraftBgKind(n);
                  }}
                >
                  {BG_EVENT_KIND_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </label>
              {isHiddenItem && (
                <>
                  <label className="entity-inspector__num-field">
                    <span>Hidden item id</span>
                    <input
                      type="number"
                      min={0}
                      max={65535}
                      value={draftHiddenItemId}
                      data-testid="trigger-inspector-edit-hidden-item-id"
                      onChange={(e) => {
                        const n = Number.parseInt(e.target.value, 10);
                        if (Number.isFinite(n))
                          setDraftHiddenItemId(Math.max(0, Math.min(65535, n)));
                      }}
                    />
                  </label>
                  <label className="entity-inspector__num-field">
                    <span>Flag offset</span>
                    <input
                      type="number"
                      min={0}
                      max={255}
                      value={draftHiddenItemFlagOffset}
                      data-testid="trigger-inspector-edit-hidden-item-flag"
                      onChange={(e) => {
                        const n = Number.parseInt(e.target.value, 10);
                        if (Number.isFinite(n))
                          setDraftHiddenItemFlagOffset(Math.max(0, Math.min(255, n)));
                      }}
                    />
                  </label>
                  <label className="entity-inspector__num-field">
                    <span>Quantity</span>
                    <input
                      type="number"
                      min={1}
                      max={255}
                      value={draftHiddenItemQuantity}
                      data-testid="trigger-inspector-edit-hidden-item-qty"
                      onChange={(e) => {
                        const n = Number.parseInt(e.target.value, 10);
                        if (Number.isFinite(n))
                          setDraftHiddenItemQuantity(Math.max(1, Math.min(255, n)));
                      }}
                    />
                  </label>
                </>
              )}
            </>
          )}
          {triggerKind === 'coord' && (
            <>
              <label className="entity-inspector__num-field">
                <span>Variable</span>
                <input
                  type="number"
                  min={0}
                  max={65535}
                  value={draftVar}
                  data-testid="trigger-inspector-edit-coord-var"
                  onChange={(e) => {
                    const n = Number.parseInt(e.target.value, 10);
                    if (Number.isFinite(n))
                      setDraftVar(Math.max(0, Math.min(65535, n)));
                  }}
                />
              </label>
              <label className="entity-inspector__num-field">
                <span>Value</span>
                <input
                  type="number"
                  min={0}
                  max={65535}
                  value={draftValue}
                  data-testid="trigger-inspector-edit-coord-value"
                  onChange={(e) => {
                    const n = Number.parseInt(e.target.value, 10);
                    if (Number.isFinite(n))
                      setDraftValue(Math.max(0, Math.min(65535, n)));
                  }}
                />
              </label>
            </>
          )}
          <label className="entity-inspector__num-field">
            <span>Elevation</span>
            <input
              type="number"
              min={0}
              max={15}
              value={draftElevation}
              data-testid="trigger-inspector-edit-elevation"
              onChange={(e) => {
                const n = Number.parseInt(e.target.value, 10);
                if (Number.isFinite(n))
                  setDraftElevation(Math.max(0, Math.min(15, n)));
              }}
            />
          </label>
          <div className="entity-inspector__edit-actions">
            <button
              type="button"
              className="entity-inspector__save-btn"
              onClick={commitEdit}
              disabled={saving}
              data-testid="trigger-inspector-save-btn"
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
            <button
              type="button"
              className="entity-inspector__cancel-btn"
              onClick={() => setEditing(false)}
              disabled={saving}
              data-testid="trigger-inspector-cancel-btn"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
