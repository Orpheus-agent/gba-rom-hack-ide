import { useEffect, useMemo, useState } from 'react';
import type {
  MultichoiceChoiceRecord,
  MultichoiceListRecord,
  ProjectManifest,
} from '@rom-editor/shared';
import {
  editBinaryRomDialogueString,
  editBinaryRomMultichoiceAppend,
  editBinaryRomMultichoiceDelete,
  ProjectApiError,
} from '../api';
import { pushToast, useProjectStore } from '../state';
import { useEditFormKeyboard } from '../lib/useEditFormKeyboard';
import './SpeciesView.css';

/**
 * Phase O.3 - Multichoice menus workspace.
 *
 * Surfaces every entry from gMultichoiceLists[] (detected by the
 * multichoice_lists_system pass) and lets the operator rename each
 * visible choice - "YES" → "Sure!", "NO" → "Maybe later", starter
 * names, etc. Each choice's text bytes live at their own file offset
 * in ROM so renames are a 1-call patch via the existing
 * `editBinaryRomDialogueString` route (which already enforces "new
 * encoded length ≤ original span" - over-long renames return a clear
 * error rather than corrupting downstream data).
 *
 * Read-only beyond renaming: adding / removing choices requires
 * relocation of the MenuAction array (struct-array growth). Deferred
 * to the same relocation pass as dialogue branching (M10 in the
 * roadmap).
 */

interface ChoicesViewProps {
  readonly manifest: ProjectManifest;
}

export function ChoicesView({ manifest }: ChoicesViewProps): JSX.Element {
  const lists = manifest.multichoiceLists ?? [];
  const [filter, setFilter] = useState('');
  const [selectedIdx, setSelectedIdx] = useState<number | null>(
    lists.length > 0 ? 0 : null,
  );
  const filtered = useMemo(() => {
    if (!filter.trim()) return lists;
    const q = filter.toLowerCase();
    return lists.filter(
      (l) =>
        String(l.listIndex).includes(q) ||
        l.choices.some((c) => c.text.toLowerCase().includes(q)),
    );
  }, [lists, filter]);
  const selected =
    selectedIdx !== null && selectedIdx >= 0 && selectedIdx < lists.length
      ? lists[selectedIdx]!
      : null;

  if (lists.length === 0) {
    return (
      <div className="species-view species-view--empty">
        <h2>No multichoice menus</h2>
        <p>
          The multichoice_lists_system detector didn't lift any entries - either
          this ROM doesn't have a Gen-3 gMultichoiceLists table, or the table's
          layout has been rewritten beyond the detector's heuristic.
        </p>
      </div>
    );
  }

  return (
    <div className="species-view">
      <aside className="species-view__list">
        <input
          type="search"
          className="species-view__filter"
          placeholder="Filter by list # / choice text…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          data-testid="choices-view-filter"
          spellCheck={false}
        />
        <ul>
          {filtered.map((l) => {
            const realIdx = lists.indexOf(l);
            // Phase O.70 - show as many choices as fit within ~60
            // chars, with "+N more" when truncated, so the operator
            // can scan starter pickers / yes-no / region menus at
            // a glance without opening each detail pane.
            const PREVIEW_CHAR_BUDGET = 60;
            const allTexts = l.choices.map((c) => c.text);
            let used = 0;
            let shown = 0;
            for (let i = 0; i < allTexts.length; i++) {
              const t = allTexts[i]!;
              const cost = t.length + (i > 0 ? 3 : 0); // " / " separator
              if (used + cost > PREVIEW_CHAR_BUDGET && i > 0) break;
              used += cost;
              shown++;
            }
            const previewParts = allTexts.slice(0, Math.max(shown, 1));
            const previewBase = previewParts.join(' / ');
            const remaining = allTexts.length - previewParts.length;
            const preview =
              remaining > 0
                ? `${previewBase} · +${remaining} more`
                : previewBase;
            return (
              <li key={l.id}>
                <button
                  type="button"
                  className={`species-view__item${realIdx === selectedIdx ? ' species-view__item--selected' : ''}`}
                  data-testid={`choices-view-item-${l.id}`}
                  onClick={() => setSelectedIdx(realIdx)}
                >
                  <span className="species-view__item-idx">#{l.listIndex}</span>
                  <span className="species-view__item-name">
                    {preview || `(${l.count} choices)`}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </aside>
      <section className="species-view__detail">
        {selected ? <ChoicesDetail list={selected} /> : <p>Pick a list to view.</p>}
      </section>
    </div>
  );
}

function ChoicesDetail({ list }: { list: MultichoiceListRecord }): JSX.Element {
  return (
    <div className="species-editor">
      <header>
        <h2>Multichoice list #{list.listIndex}</h2>
        <p>
          {list.count} choice{list.count === 1 ? '' : 's'}
        </p>
      </header>
      <fieldset>
        <legend>Choices</legend>
        {list.choices.length === 0 ? (
          <p style={{ fontStyle: 'italic', color: 'var(--color-text-muted)', margin: 0 }}>
            No choice strings decoded. (Pointers may target unreachable bytes.)
          </p>
        ) : (
          list.choices.map((c) => (
            <ChoiceRow
              key={`${list.id}__${String(c.choiceIndex)}`}
              choice={c}
              list={list}
            />
          ))
        )}
        {/* Phase O.12 - Add a new choice via free-space relocation. */}
        <AddChoiceButton list={list} />
      </fieldset>
      <p style={{ fontSize: 11, color: 'var(--color-text-muted)', marginTop: 8 }}>
        Edit each choice's text in place (length ≤ original byte span).
        Add choice allocates new text + a larger MenuAction array in free
        ROM space and patches the gMultichoiceLists entry's listPtr +
        count. Old text + array slots are left in place.
      </p>
    </div>
  );
}

function AddChoiceButton({
  list,
}: {
  list: MultichoiceListRecord;
}): JSX.Element | null {
  const sessionId = useProjectStore((s) =>
    s.load.kind === 'loaded' ? s.load.data.session.id : null,
  );
  const scanCurrent = useProjectStore((s) => s.scanCurrentProject);
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [state, setState] = useState<SaveState>({ kind: 'idle' });

  if (list.count >= 16) {
    return (
      <p
        style={{ fontSize: 11, color: 'var(--color-text-muted)', margin: '8px 0 0 0' }}
      >
        Multichoice already at max (16 choices).
      </p>
    );
  }

  async function add(): Promise<void> {
    if (!sessionId || text.length === 0) return;
    setState({ kind: 'saving' });
    try {
      const r = await editBinaryRomMultichoiceAppend(sessionId, {
        entryFileOffset: list.entryFileOffset,
        newChoiceText: text,
      });
      setState({ kind: 'idle' });
      pushToast('success', `Choice added - list now has ${String(r.newCount)} entries`);
      setText('');
      setOpen(false);
      await scanCurrent();
    } catch (e) {
      const message =
        e instanceof ProjectApiError
          ? `${e.code}: ${e.message}`
          : e instanceof Error
            ? e.message
            : String(e);
      setState({ kind: 'error', message });
      pushToast('error', `Add choice failed - ${message}`);
    }
  }

  if (!open) {
    return (
      <div style={{ marginTop: 8 }}>
        <button
          type="button"
          className="btn btn--secondary"
          onClick={() => setOpen(true)}
          data-testid="multichoice-add-open"
        >
          {`＋ Add choice (${list.count}/16)`}
        </button>
      </div>
    );
  }
  return (
    <div
      style={{
        marginTop: 8,
        padding: 8,
        border: '1px solid var(--color-border)',
        borderRadius: 4,
      }}
      data-testid="multichoice-add-form"
    >
      <label className="species-field" style={{ width: '100%' }}>
        <span>New choice text</span>
        <input
          type="text"
          value={text}
          onChange={(e) => setText(e.target.value)}
          maxLength={32}
          spellCheck={false}
          data-testid="multichoice-add-input"
          autoFocus
        />
      </label>
      <div className="species-editor__actions" style={{ marginTop: 4 }}>
        <button
          type="button"
          className="btn btn--primary"
          disabled={text.length === 0 || state.kind === 'saving'}
          onClick={() => void add()}
          data-testid="multichoice-add-save"
        >
          {state.kind === 'saving' ? 'Adding…' : 'Add'}
        </button>
        <button
          type="button"
          className="btn btn--secondary"
          onClick={() => {
            setOpen(false);
            setText('');
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
    </div>
  );
}

type SaveState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'saving' }
  | { readonly kind: 'saved' }
  | { readonly kind: 'error'; readonly message: string };

function ChoiceRow({
  choice,
  list,
}: {
  choice: MultichoiceChoiceRecord;
  list: MultichoiceListRecord;
}): JSX.Element {
  const sessionId = useProjectStore((s) =>
    s.load.kind === 'loaded' ? s.load.data.session.id : null,
  );
  const scanCurrent = useProjectStore((s) => s.scanCurrentProject);
  const [text, setText] = useState(choice.text);
  const [state, setState] = useState<SaveState>({ kind: 'idle' });

  useEffect(() => {
    setText(choice.text);
    setState({ kind: 'idle' });
  }, [choice.textFileOffset, choice.text]);

  const dirty = text !== choice.text;
  const valid = text.length > 0;
  const canSave = dirty && valid && sessionId !== null;
  // Phase O.13 - delete gated on list.count > 2 (Gen-3 multichoice
  // opcode requires ≥ 2 choices).
  const canDelete = list.count > 2 && sessionId !== null;

  async function save(): Promise<void> {
    if (!sessionId || !canSave) return;
    setState({ kind: 'saving' });
    try {
      await editBinaryRomDialogueString(sessionId, {
        stringFileOffset: choice.textFileOffset,
        newText: text,
      });
      setState({ kind: 'saved' });
      pushToast('success', `Choice renamed to "${text}"`);
      await scanCurrent();
    } catch (e) {
      const message =
        e instanceof ProjectApiError
          ? `${e.code}: ${e.message}`
          : e instanceof Error
            ? e.message
            : String(e);
      setState({ kind: 'error', message });
      pushToast('error', `Choice rename failed - ${message}`);
    }
  }

  async function deleteChoice(): Promise<void> {
    if (!sessionId || !canDelete) return;
    if (
      !window.confirm(
        `Delete choice #${String(choice.choiceIndex + 1)} ("${choice.text}")? Subsequent choices shift up. List will have ${String(list.count - 1)} choices.`,
      )
    ) {
      return;
    }
    setState({ kind: 'saving' });
    try {
      await editBinaryRomMultichoiceDelete(sessionId, {
        entryFileOffset: list.entryFileOffset,
        choiceIndex: choice.choiceIndex,
      });
      pushToast('success', `Choice "${choice.text}" deleted`);
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

  // Phase O.29 - Enter saves, Esc reverts.
  const onKeyDownEdit = useEditFormKeyboard({
    canSave: canSave && state.kind !== 'saving',
    save,
    cancel: () => {
      setText(choice.text);
      setState({ kind: 'idle' });
    },
    isSaving: state.kind === 'saving',
  });

  return (
    <div
      className="species-field-grid"
      style={{ marginBottom: 8 }}
      onKeyDown={onKeyDownEdit}
    >
      <label className="species-field">
        <span>Choice {choice.choiceIndex + 1}</span>
        <input
          type="text"
          value={text}
          onChange={(e) => setText(e.target.value)}
          data-testid={`choice-input-${String(choice.choiceIndex)}`}
          spellCheck={false}
        />
      </label>
      <div className="species-editor__actions">
        <button
          type="button"
          className="btn btn--primary btn--sm"
          disabled={!canSave || state.kind === 'saving'}
          onClick={() => void save()}
          data-testid={`choice-save-${String(choice.choiceIndex)}`}
        >
          {state.kind === 'saving' ? 'Saving…' : 'Save'}
        </button>
        {canDelete && (
          <button
            type="button"
            className="btn btn--secondary btn--sm"
            disabled={state.kind === 'saving'}
            onClick={() => void deleteChoice()}
            data-testid={`choice-delete-${String(choice.choiceIndex)}`}
            style={{ color: 'var(--color-error, #e25555)' }}
            title="Remove this choice. Subsequent choices shift up."
          >
            Delete
          </button>
        )}
        {state.kind === 'saved' && !dirty && (
          <span className="fields-editor__status fields-editor__status--saved">Saved</span>
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
