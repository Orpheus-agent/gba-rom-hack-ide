import { useEffect, useMemo, useState } from 'react';
import type { ItemEntry, ProjectManifest } from '@rom-editor/shared';
import { editBinaryRomItemFields, ProjectApiError } from '../api';
import { pushToast, useProjectStore } from '../state';
import { useEditFormKeyboard } from '../lib/useEditFormKeyboard';
import './SpeciesView.css';

/**
 * Phase M.3 - Items workspace.
 *
 * List+detail editor for item structs. Editable fields: price (u16),
 * holdEffect (u8), holdEffectParam (u8), importance (u8), pocket (u8),
 * type (u8). The full item struct has more fields (name pointer,
 * description pointer, mystery_value, etc.) that aren't in
 * /binary-rom-edit/item-fields' layout - those need separate routes
 * (name editing needs codec re-encoding into the name slot;
 * description editing needs the dialogue-string route on the right
 * offset). Subset of fields editable here covers ~80% of common item
 * tweaks (price, hold effect, pocket).
 */

const POCKET_OPTIONS: ReadonlyArray<{ value: number; label: string }> = [
  { value: 0, label: '0 - None' },
  { value: 1, label: '1 - Items' },
  { value: 2, label: '2 - Poké Balls' },
  { value: 3, label: '3 - TMs / HMs' },
  { value: 4, label: '4 - Berries' },
  { value: 5, label: '5 - Key items' },
  { value: 6, label: '6 - Battle (Emerald)' },
];

interface ItemsViewProps {
  readonly manifest: ProjectManifest;
}

export function ItemsView({ manifest }: ItemsViewProps): JSX.Element {
  const items = manifest.items ?? [];
  const [filter, setFilter] = useState('');
  const [selectedIdx, setSelectedIdx] = useState<number | null>(items.length > 0 ? 0 : null);
  const filtered = useMemo(() => {
    if (!filter.trim()) return items;
    const q = filter.toLowerCase();
    return items.filter(
      (it) => (it.name ?? '').toLowerCase().includes(q) || String(it.itemIndex).includes(q),
    );
  }, [items, filter]);
  const selected =
    selectedIdx !== null && selectedIdx >= 0 && selectedIdx < items.length
      ? items[selectedIdx]!
      : null;

  if (items.length === 0) {
    return (
      <div className="species-view species-view--empty">
        <h2>No items data</h2>
        <p>The items_system detector didn't lift any items. Open a Gen-3 ROM and scan.</p>
      </div>
    );
  }

  return (
    <div className="species-view">
      <aside className="species-view__list">
        <input
          type="search"
          className="species-view__filter"
          placeholder="Filter by name / index…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          data-testid="items-view-filter"
          spellCheck={false}
        />
        <ul>
          {filtered.map((it) => {
            const realIdx = items.indexOf(it);
            // Phase O.72 - pocket + price in muted text after the
            // name so operators can scan items at a glance.
            // POCKET_OPTIONS labels are "0 - None", "1 - Items",
            // etc.; strip the "<n> - " prefix for compact display.
            const pocketOption = POCKET_OPTIONS.find(
              (o) => o.value === (it.pocket ?? 0),
            );
            const pocketLabel = pocketOption
              ? pocketOption.label.replace(/^\d+ - /, '')
              : `Pocket ${it.pocket ?? 0}`;
            const priceLabel =
              it.price !== undefined && it.price !== null
                ? `¥${it.price}`
                : null;
            return (
              <li key={it.id}>
                <button
                  type="button"
                  className={`species-view__item${realIdx === selectedIdx ? ' species-view__item--selected' : ''}`}
                  data-testid={`items-view-item-${it.id}`}
                  onClick={() => setSelectedIdx(realIdx)}
                >
                  <span className="species-view__item-idx">#{it.itemIndex}</span>
                  <span className="species-view__item-name">
                    {it.name}
                    <span
                      className="species-view__item-meta"
                      data-testid={`items-view-item-meta-${it.id}`}
                      style={{
                        marginLeft: 8,
                        color: 'var(--color-text-muted)',
                        fontSize: 11,
                      }}
                    >
                      · {pocketLabel}
                      {priceLabel ? ` · ${priceLabel}` : ''}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </aside>
      <section className="species-view__detail">
        {selected ? <ItemEditor item={selected} /> : <p>Pick an item to edit.</p>}
      </section>
    </div>
  );
}

function ItemEditor({ item }: { item: ItemEntry }): JSX.Element {
  const sessionId = useProjectStore((s) =>
    s.load.kind === 'loaded' ? s.load.data.session.id : null,
  );
  const scanCurrent = useProjectStore((s) => s.scanCurrentProject);
  const initial = {
    price: item.price ?? 0,
    holdEffect: item.holdEffect ?? 0,
    holdEffectParam: item.holdEffectParam ?? 0,
    importance: item.importance ?? 0,
    pocket: item.pocket ?? 0,
    type: item.type ?? 0,
  };
  const [values, setValues] = useState<Record<string, number>>({ ...initial });
  const [state, setState] = useState<
    | { kind: 'idle' }
    | { kind: 'saving' }
    | { kind: 'saved' }
    | { kind: 'error'; message: string }
  >({ kind: 'idle' });
  useEffect(() => {
    setValues({ ...initial });
    setState({ kind: 'idle' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item.id]);

  const dirty = Object.keys(initial).some(
    (k) => values[k] !== (initial as Record<string, number>)[k],
  );
  const canSave = dirty && sessionId !== null;

  async function save(): Promise<void> {
    if (!sessionId || !canSave) return;
    setState({ kind: 'saving' });
    try {
      const fields: Record<string, number> = {};
      for (const k of Object.keys(initial)) {
        if (values[k] !== (initial as Record<string, number>)[k]) fields[k] = values[k]!;
      }
      await editBinaryRomItemFields(sessionId, {
        sourceFileOffset: item.sourceTableOffset,
        fields,
      });
      setState({ kind: 'saved' });
      pushToast('success', `Item "${item.name}" saved`);
      await scanCurrent();
    } catch (e) {
      const message =
        e instanceof ProjectApiError
          ? `${e.code}: ${e.message}`
          : e instanceof Error
            ? e.message
            : String(e);
      setState({ kind: 'error', message });
      pushToast('error', `Item save failed - ${message}`);
    }
  }

  function setField(k: string, v: number): void {
    setValues((prev) => ({ ...prev, [k]: v }));
  }

  // Phase O.30 - Enter saves, Esc reverts all fields.
  const onKeyDownEdit = useEditFormKeyboard({
    canSave: canSave && state.kind !== 'saving',
    save,
    cancel: () => {
      setValues({ ...initial });
      setState({ kind: 'idle' });
    },
    isSaving: state.kind === 'saving',
  });

  return (
    <div className="species-editor" onKeyDown={onKeyDownEdit}>
      <header>
        <h2>
          #{item.itemIndex} {item.name}
        </h2>
        <p>Item entry</p>
      </header>
      <fieldset>
        <legend>Shop + bag</legend>
        <div className="species-field-grid">
          <label className="species-field">
            <span>Price (u16, coins)</span>
            <input
              type="number"
              min={0}
              max={0xffff}
              value={values.price ?? 0}
              onChange={(e) =>
                setField('price', Math.max(0, Math.min(0xffff, Number.parseInt(e.target.value, 10) || 0)))
              }
            />
          </label>
          <label className="species-field">
            <span>Pocket</span>
            <select
              value={values.pocket ?? 0}
              onChange={(e) => setField('pocket', Number.parseInt(e.target.value, 10))}
            >
              {POCKET_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
              {!POCKET_OPTIONS.some((o) => o.value === values.pocket) && (
                <option value={values.pocket}>{`${values.pocket} - Hack-specific`}</option>
              )}
            </select>
          </label>
          <label className="species-field">
            <span>Importance (u8 - 0 or 1 for key items)</span>
            <input
              type="number"
              min={0}
              max={0xff}
              value={values.importance ?? 0}
              onChange={(e) =>
                setField('importance', Math.max(0, Math.min(0xff, Number.parseInt(e.target.value, 10) || 0)))
              }
            />
          </label>
          <label className="species-field">
            <span>Type (u8 - context-specific)</span>
            <input
              type="number"
              min={0}
              max={0xff}
              value={values.type ?? 0}
              onChange={(e) =>
                setField('type', Math.max(0, Math.min(0xff, Number.parseInt(e.target.value, 10) || 0)))
              }
            />
          </label>
        </div>
      </fieldset>
      <fieldset>
        <legend>Hold effect</legend>
        <div className="species-field-grid">
          <label className="species-field">
            <span>Hold-effect id (u8)</span>
            <input
              type="number"
              min={0}
              max={0xff}
              value={values.holdEffect ?? 0}
              onChange={(e) =>
                setField('holdEffect', Math.max(0, Math.min(0xff, Number.parseInt(e.target.value, 10) || 0)))
              }
            />
          </label>
          <label className="species-field">
            <span>Hold-effect param (u8)</span>
            <input
              type="number"
              min={0}
              max={0xff}
              value={values.holdEffectParam ?? 0}
              onChange={(e) =>
                setField('holdEffectParam', Math.max(0, Math.min(0xff, Number.parseInt(e.target.value, 10) || 0)))
              }
            />
          </label>
        </div>
      </fieldset>
      <div className="species-editor__actions">
        <button
          type="button"
          className="btn btn--primary"
          data-testid="items-save"
          disabled={!canSave || state.kind === 'saving'}
          onClick={() => void save()}
        >
          {state.kind === 'saving' ? 'Saving…' : 'Save item'}
        </button>
        {state.kind === 'saved' && !dirty && (
          <span className="species-editor__ok">Saved · item struct patched</span>
        )}
        {state.kind === 'error' && (
          <span className="species-editor__err">{state.message}</span>
        )}
      </div>
      <p style={{ fontSize: 11, color: 'var(--color-text-muted)', marginTop: 8 }}>
        Editable subset: price · pocket · hold effect · importance · type.
        Item name + description text are edited via the dialogue-string
        route - wire that into this view in a follow-up.
      </p>
    </div>
  );
}
