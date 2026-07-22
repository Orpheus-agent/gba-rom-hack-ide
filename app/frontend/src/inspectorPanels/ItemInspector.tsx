import { useMemo, useState } from 'react';
import type { InspectorPanelProps } from '../lib/inspectorRegistry';
import { displayName } from '../lib/displayName';
import {
  pushToast,
  useProjectStore,
  useSelection,
  useUiPreferencesStore,
} from '../state';
import { editBinaryRomItemFields, ProjectApiError } from '../api';
import type { ItemEntry, ProjectManifest } from '@rom-editor/shared';
import './InspectorShared.css';

// Phase S.9 - ItemInspector. Renders price, pocket, importance, hold
// effect plus back-references to NPCs that give the item and trainers
// that hold it. Click-through to the giver/holder.

const POCKET_LABELS: ReadonlyArray<{ value: number; label: string }> = [
  { value: 0, label: 'Items' },
  { value: 1, label: 'Key Items' },
  { value: 2, label: 'Poké Balls' },
  { value: 3, label: 'TMs / HMs' },
  { value: 4, label: 'Berries' },
];

function pocketLabel(p: number | undefined): string {
  if (p == null) return ' - ';
  return POCKET_LABELS.find((x) => x.value === p)?.label ?? `Pocket #${p}`;
}

function findItem(
  manifest: ProjectManifest | null,
  selectionId: string,
): ItemEntry | null {
  if (!manifest) return null;
  const items = manifest.items ?? [];
  if (items.length === 0) return null;
  const direct = items.find((m) => m.id === selectionId);
  if (direct) return direct;
  const synth = /^item_(\d+)$/.exec(selectionId);
  if (synth) {
    const idx = Number.parseInt(synth[1]!, 10);
    return items.find((m) => m.itemIndex === idx) ?? null;
  }
  return null;
}

export function ItemInspector({
  selection,
  manifest,
  sessionId,
}: InspectorPanelProps) {
  const showInternalIds = useUiPreferencesStore((s) => s.showInternalIds);
  const select = useSelection((s) => s.select);
  const scanCurrentProject = useProjectStore((s) => s.scanCurrentProject);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [draftPrice, setDraftPrice] = useState(0);
  const [draftImportance, setDraftImportance] = useState(0);
  const [draftPocket, setDraftPocket] = useState(0);
  const [draftHoldEffect, setDraftHoldEffect] = useState(0);
  const [draftHoldEffectParam, setDraftHoldEffectParam] = useState(0);

  const item = useMemo(
    () => findItem(manifest, selection.id),
    [manifest, selection.id],
  );

  function beginEdit() {
    if (!item) return;
    setDraftPrice(item.price ?? 0);
    setDraftImportance(item.importance ?? 0);
    setDraftPocket(item.pocket ?? 0);
    setDraftHoldEffect(item.holdEffect ?? 0);
    setDraftHoldEffectParam(item.holdEffectParam ?? 0);
    setEditing(true);
  }

  async function commitEdit() {
    if (!item || !sessionId) return;
    setSaving(true);
    try {
      const fields: Record<string, number> = {};
      if (draftPrice !== (item.price ?? 0)) fields['price'] = draftPrice;
      if (draftImportance !== (item.importance ?? 0))
        fields['importance'] = draftImportance;
      if (draftPocket !== (item.pocket ?? 0)) fields['pocket'] = draftPocket;
      if (draftHoldEffect !== (item.holdEffect ?? 0))
        fields['holdEffect'] = draftHoldEffect;
      if (draftHoldEffectParam !== (item.holdEffectParam ?? 0))
        fields['holdEffectParam'] = draftHoldEffectParam;
      if (Object.keys(fields).length === 0) {
        setEditing(false);
        setSaving(false);
        return;
      }
      await editBinaryRomItemFields(sessionId, {
        sourceFileOffset: item.sourceTableOffset,
        fields,
      });
      pushToast('success', `Saved ${Object.keys(fields).length} field(s)`);
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
      <div className="entity-inspector entity-inspector--empty" data-testid="item-inspector">
        <p>Open a project to inspect <code>{selection.id}</code>.</p>
      </div>
    );
  }
  if (!item) {
    return (
      <div className="entity-inspector entity-inspector--empty" data-testid="item-inspector">
        <p>
          The selection references <code>{selection.id}</code> but no item with
          that id is present in the scanned manifest
          ({(manifest.items ?? []).length} items indexed).
        </p>
      </div>
    );
  }

  const itemName = item.name || `Item #${item.itemIndex}`;

  // Back-refs: trainers holding this item.
  const holdingTrainers = useMemo(() => {
    const out: Array<{ trainerId: string; speciesId: string; level: number }> = [];
    for (const t of manifest.trainers ?? []) {
      for (const p of t.party) {
        if (p.heldItemId === item.id || p.heldItemId === `item_${item.itemIndex}`) {
          out.push({ trainerId: t.id, speciesId: p.speciesId, level: p.level });
        }
      }
    }
    return out;
  }, [manifest.trainers, item.id, item.itemIndex]);

  // Back-refs: script steps that give this item.
  const givingSteps = useMemo(() => {
    const out: Array<{ stepId: string; macro: string }> = [];
    for (const s of manifest.scriptSteps ?? []) {
      if (s.kind === 'give_item') {
        const itemRef = (s.params as Record<string, unknown>)['item'];
        if (itemRef === item.id || itemRef === `item_${item.itemIndex}`) {
          out.push({ stepId: s.id, macro: 'give_item' });
        }
      }
    }
    return out;
  }, [manifest.scriptSteps, item.id, item.itemIndex]);

  return (
    <div className="entity-inspector" data-testid="item-inspector">
      <header className="entity-inspector__header">
        <div className="entity-inspector__title" data-testid="item-inspector-name">
          {itemName}
        </div>
        <div className="entity-inspector__sub">Item #{item.itemIndex}</div>
      </header>

      {!editing ? (
        <>
          <dl className="entity-inspector__meta-grid">
            <Row label="Price" value={item.price != null ? `${item.price.toLocaleString()} ₽` : ' - '} testid="item-inspector-price" />
            <Row label="Pocket" value={pocketLabel(item.pocket)} testid="item-inspector-pocket" />
            <Row label="Importance" value={item.importance === 1 ? 'Key item' : 'Regular'} testid="item-inspector-importance" />
            {item.holdEffect != null && (
              <Row
                label="Hold effect"
                value={`#${item.holdEffect}${item.holdEffectParam ? ` (param ${item.holdEffectParam})` : ''}`}
                testid="item-inspector-hold-effect"
              />
            )}
          </dl>
          {sessionId && (
            <button
              type="button"
              className="entity-inspector__edit-btn"
              onClick={beginEdit}
              data-testid="item-inspector-edit-btn"
            >
              Edit price + importance…
            </button>
          )}
        </>
      ) : (
        <div
          className="entity-inspector__edit-form"
          data-testid="item-inspector-edit-form"
        >
          <label className="entity-inspector__num-field">
            <span>Price (₽)</span>
            <input
              type="number"
              min={0}
              max={65535}
              value={draftPrice}
              data-testid="item-inspector-edit-price"
              onChange={(e) => {
                const n = Number.parseInt(e.target.value, 10);
                if (Number.isFinite(n)) setDraftPrice(Math.max(0, Math.min(65535, n)));
              }}
            />
          </label>
          <label className="entity-inspector__num-field">
            <span>Key item?</span>
            <select
              value={String(draftImportance)}
              data-testid="item-inspector-edit-importance"
              onChange={(e) => setDraftImportance(Number.parseInt(e.target.value, 10))}
            >
              <option value="0">Regular</option>
              <option value="1">Key item</option>
            </select>
          </label>
          <label className="entity-inspector__num-field">
            <span>Pocket</span>
            <select
              value={String(draftPocket)}
              data-testid="item-inspector-edit-pocket"
              onChange={(e) => setDraftPocket(Number.parseInt(e.target.value, 10))}
            >
              <option value="0">Items</option>
              <option value="1">Key Items</option>
              <option value="2">Poké Balls</option>
              <option value="3">TMs / HMs</option>
              <option value="4">Berries</option>
            </select>
          </label>
          <label className="entity-inspector__num-field">
            <span>Hold effect</span>
            <input
              type="number"
              min={0}
              max={255}
              value={draftHoldEffect}
              data-testid="item-inspector-edit-hold-effect"
              onChange={(e) => {
                const n = Number.parseInt(e.target.value, 10);
                if (Number.isFinite(n))
                  setDraftHoldEffect(Math.max(0, Math.min(255, n)));
              }}
            />
          </label>
          <label className="entity-inspector__num-field">
            <span>Effect param</span>
            <input
              type="number"
              min={0}
              max={255}
              value={draftHoldEffectParam}
              data-testid="item-inspector-edit-hold-effect-param"
              onChange={(e) => {
                const n = Number.parseInt(e.target.value, 10);
                if (Number.isFinite(n))
                  setDraftHoldEffectParam(Math.max(0, Math.min(255, n)));
              }}
            />
          </label>
          <div className="entity-inspector__edit-actions">
            <button
              type="button"
              className="entity-inspector__save-btn"
              onClick={commitEdit}
              disabled={saving}
              data-testid="item-inspector-save-btn"
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
            <button
              type="button"
              className="entity-inspector__cancel-btn"
              onClick={() => setEditing(false)}
              disabled={saving}
              data-testid="item-inspector-cancel-btn"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {holdingTrainers.length > 0 && (
        <section className="entity-inspector__refs" data-testid="item-inspector-holders">
          <h3 className="entity-inspector__refs-heading">
            Held by trainer Pokémon{' '}
            <span className="entity-inspector__refs-count">({holdingTrainers.length})</span>
          </h3>
          <ul className="entity-inspector__refs-list">
            {holdingTrainers.slice(0, 20).map((h, i) => (
              <li key={`${h.trainerId}-${h.speciesId}-${i}`}>
                <button
                  type="button"
                  className="entity-inspector__refs-btn"
                  onClick={() => select({ kind: 'trainer', id: h.trainerId })}
                >
                  <span className="entity-inspector__refs-btn-label">
                    {displayName(manifest, h.trainerId, showInternalIds)}
                  </span>
                  <span className="entity-inspector__refs-btn-meta">
                    {displayName(manifest, h.speciesId, showInternalIds)} · Lv{' '}
                    {h.level}
                  </span>
                </button>
              </li>
            ))}
            {holdingTrainers.length > 20 && (
              <li className="entity-inspector__refs-more">
                + {holdingTrainers.length - 20} more
              </li>
            )}
          </ul>
        </section>
      )}

      {givingSteps.length > 0 && (
        <section className="entity-inspector__refs" data-testid="item-inspector-givers">
          <h3 className="entity-inspector__refs-heading">
            Given by scripts{' '}
            <span className="entity-inspector__refs-count">({givingSteps.length})</span>
          </h3>
          <ul className="entity-inspector__refs-list">
            {givingSteps.slice(0, 20).map((g, i) => (
              <li key={`${g.stepId}-${i}`}>
                <button
                  type="button"
                  className="entity-inspector__refs-btn"
                  onClick={() => select({ kind: 'scriptStep', id: g.stepId })}
                >
                  <span className="entity-inspector__refs-btn-label">
                    {displayName(manifest, g.stepId, showInternalIds)}
                  </span>
                  <span className="entity-inspector__refs-btn-meta">{g.macro}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {holdingTrainers.length === 0 && givingSteps.length === 0 && (
        <p className="entity-inspector__refs-empty">
          No trainers hold this item and no scripts give it. It may be
          purchasable, hidden, or unused in this ROM.
        </p>
      )}
    </div>
  );
}

function Row({ label, value, testid }: { label: string; value: string; testid: string }) {
  return (
    <div className="entity-inspector__meta-row">
      <dt>{label}</dt>
      <dd data-testid={testid}>{value}</dd>
    </div>
  );
}
