import { useEffect, useMemo, useState } from 'react';
import type {
  ProjectManifest,
  TrainerClassNameEntry,
} from '@rom-editor/shared';
import { editBinaryRomDialogueString, ProjectApiError } from '../api';
import { pushToast, useProjectStore } from '../state';
import { useEditFormKeyboard } from '../lib/useEditFormKeyboard';
import './SpeciesView.css';

/**
 * Phase N.3 - Trainer class names workspace.
 *
 * Same pattern as AbilitiesView: list+detail editor that writes the
 * class-name slot via the existing Gen-3 dialogue-string codec route.
 * Vanilla FRLG ~58 classes; hacks expand into the 100s.
 */

interface TrainerClassesViewProps {
  readonly manifest: ProjectManifest;
}

export function TrainerClassesView({ manifest }: TrainerClassesViewProps): JSX.Element {
  const classes = manifest.trainerClassNames ?? [];
  const [filter, setFilter] = useState('');
  const [selectedIdx, setSelectedIdx] = useState<number | null>(
    classes.length > 0 ? 0 : null,
  );
  const filtered = useMemo(() => {
    if (!filter.trim()) return classes;
    const q = filter.toLowerCase();
    return classes.filter(
      (c) => c.name.toLowerCase().includes(q) || String(c.classIndex).includes(q),
    );
  }, [classes, filter]);
  const selected =
    selectedIdx !== null && selectedIdx >= 0 && selectedIdx < classes.length
      ? classes[selectedIdx]!
      : null;

  if (classes.length === 0) {
    return (
      <div className="species-view species-view--empty">
        <h2>No trainer classes data</h2>
        <p>The trainer_class_names detector didn't lift any classes.</p>
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
          data-testid="trainer-classes-filter"
          spellCheck={false}
        />
        <ul>
          {filtered.map((c) => {
            const realIdx = classes.indexOf(c);
            return (
              <li key={c.id}>
                <button
                  type="button"
                  className={`species-view__item${realIdx === selectedIdx ? ' species-view__item--selected' : ''}`}
                  data-testid={`trainer-classes-item-${c.id}`}
                  onClick={() => setSelectedIdx(realIdx)}
                >
                  <span className="species-view__item-idx">#{c.classIndex}</span>
                  <span className="species-view__item-name">{c.name}</span>
                </button>
              </li>
            );
          })}
        </ul>
      </aside>
      <section className="species-view__detail">
        {selected ? <ClassEditor entry={selected} /> : <p>Pick a class to edit.</p>}
      </section>
    </div>
  );
}

function ClassEditor({ entry }: { entry: TrainerClassNameEntry }): JSX.Element {
  const sessionId = useProjectStore((s) =>
    s.load.kind === 'loaded' ? s.load.data.session.id : null,
  );
  const scanCurrent = useProjectStore((s) => s.scanCurrentProject);
  const [name, setName] = useState(entry.name);
  const [state, setState] = useState<
    | { kind: 'idle' }
    | { kind: 'saving' }
    | { kind: 'saved' }
    | { kind: 'error'; message: string }
  >({ kind: 'idle' });
  useEffect(() => {
    setName(entry.name);
    setState({ kind: 'idle' });
  }, [entry.id, entry.name]);
  // Class name slot is 13 bytes (12 chars + 0xFF terminator).
  const dirty = name !== entry.name;
  const valid = name.length <= 12;
  const canSave = dirty && valid && sessionId !== null;

  async function save(): Promise<void> {
    if (!sessionId || !canSave) return;
    setState({ kind: 'saving' });
    try {
      // Phase N.5 - per-entry name slot offset (was previously writing
      // to the table start which only worked for class 0).
      await editBinaryRomDialogueString(sessionId, {
        stringFileOffset: entry.nameSlotOffset ?? entry.sourceTableOffset,
        newText: name,
      });
      setState({ kind: 'saved' });
      pushToast('success', `Trainer class renamed to "${name}"`);
      await scanCurrent();
    } catch (e) {
      const message =
        e instanceof ProjectApiError
          ? `${e.code}: ${e.message}`
          : e instanceof Error
            ? e.message
            : String(e);
      setState({ kind: 'error', message });
      pushToast('error', `Trainer class rename failed - ${message}`);
    }
  }

  // Phase O.30 - Enter saves, Esc reverts name input.
  const onKeyDownEdit = useEditFormKeyboard({
    canSave: canSave && state.kind !== 'saving',
    save,
    cancel: () => {
      setName(entry.name);
      setState({ kind: 'idle' });
    },
    isSaving: state.kind === 'saving',
  });

  return (
    <div className="species-editor" onKeyDown={onKeyDownEdit}>
      <header>
        <h2>
          #{entry.classIndex} {entry.name}
        </h2>
        <p>Trainer class name (up to 12 characters)</p>
      </header>
      <fieldset>
        <legend>Name</legend>
        <div className="species-field-grid">
          <label className="species-field">
            <span>Trainer class name (≤12 chars)</span>
            <input
              type="text"
              maxLength={12}
              value={name}
              data-testid="trainer-classes-name-input"
              onChange={(e) => setName(e.target.value)}
            />
          </label>
        </div>
      </fieldset>
      <div className="species-editor__actions">
        <button
          type="button"
          className="btn btn--primary"
          data-testid="trainer-classes-save"
          disabled={!canSave || state.kind === 'saving'}
          onClick={() => void save()}
        >
          {state.kind === 'saving' ? 'Saving…' : 'Save name'}
        </button>
        {state.kind === 'saved' && !dirty && (
          <span className="species-editor__ok">Saved · name slot patched</span>
        )}
        {state.kind === 'error' && (
          <span className="species-editor__err">{state.message}</span>
        )}
      </div>
    </div>
  );
}
