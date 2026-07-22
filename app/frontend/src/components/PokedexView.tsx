import { useEffect, useMemo, useState } from 'react';
import type { PokedexEntryRecord, ProjectManifest } from '@rom-editor/shared';
import { editBinaryRomDialogueString, ProjectApiError } from '../api';
import { pushToast, useProjectStore } from '../state';
import { useEditFormKeyboard } from '../lib/useEditFormKeyboard';
import './SpeciesView.css';

/**
 * Phase O.2 - Pokédex flavor-text + category-name editor.
 *
 * Builds on Phase N.6's read-only viewer. The pokedex_system detector
 * now surfaces per-entry struct file offsets (categoryNameFileOffset =
 * entryFileOffset, since categoryName sits at struct offset 0) plus
 * the resolved descriptionPtr → file offset (descriptionFileOffset)
 * for flavor text. Both edits reuse the existing
 * `editBinaryRomDialogueString` route - categoryName slot is 12 bytes
 * (11 chars + 0xFF terminator); flavor text is open-ended (vanilla
 * entries are 100-180 chars).
 *
 * Note: flavor-text edits must fit within the original byte length
 * (no relocation in this pass). The shared route enforces this and
 * returns a clear error if the encoded length exceeds the original.
 */

interface PokedexViewProps {
  readonly manifest: ProjectManifest;
}

const POKEDEX_CATEGORY_MAX_LEN = 11;

export function PokedexView({ manifest }: PokedexViewProps): JSX.Element {
  const entries = manifest.pokedexEntries ?? [];
  const [filter, setFilter] = useState('');
  const [selectedIdx, setSelectedIdx] = useState<number | null>(
    entries.length > 0 ? 0 : null,
  );
  const filtered = useMemo(() => {
    if (!filter.trim()) return entries;
    const q = filter.toLowerCase();
    return entries.filter(
      (e) =>
        (e.speciesName ?? '').toLowerCase().includes(q) ||
        e.category.toLowerCase().includes(q) ||
        e.flavorText.toLowerCase().includes(q) ||
        String(e.speciesIndex).includes(q),
    );
  }, [entries, filter]);
  const selected =
    selectedIdx !== null && selectedIdx >= 0 && selectedIdx < entries.length
      ? entries[selectedIdx]!
      : null;

  if (entries.length === 0) {
    return (
      <div className="species-view species-view--empty">
        <h2>No Pokédex data</h2>
        <p>The pokedex_system detector didn't lift any entries.</p>
      </div>
    );
  }

  return (
    <div className="species-view">
      <aside className="species-view__list">
        <input
          type="search"
          className="species-view__filter"
          placeholder="Filter by species / category / text…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          data-testid="pokedex-view-filter"
          spellCheck={false}
        />
        <ul>
          {filtered.map((e) => {
            const realIdx = entries.indexOf(e);
            // Phase O.71 - show the category in muted text after
            // the species name so operators can scan "Bulbasaur ·
            // Seed" / "Charmander · Lizard" / etc. without opening
            // each detail pane. Mirrors O.69/O.70 polish.
            return (
              <li key={e.id}>
                <button
                  type="button"
                  className={`species-view__item${realIdx === selectedIdx ? ' species-view__item--selected' : ''}`}
                  data-testid={`pokedex-view-item-${e.id}`}
                  onClick={() => setSelectedIdx(realIdx)}
                >
                  <span className="species-view__item-idx">#{e.speciesIndex}</span>
                  <span className="species-view__item-name">
                    {e.speciesName ?? `Species ${e.speciesIndex}`}
                    {e.category && e.category.length > 0 && (
                      <span
                        className="species-view__item-meta"
                        data-testid={`pokedex-view-item-category-${e.id}`}
                        style={{
                          marginLeft: 8,
                          color: 'var(--color-text-muted)',
                          fontSize: 11,
                        }}
                      >
                        · {e.category}
                      </span>
                    )}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </aside>
      <section className="species-view__detail">
        {selected ? <PokedexDetail entry={selected} /> : <p>Pick an entry to view.</p>}
      </section>
    </div>
  );
}

function PokedexDetail({ entry }: { entry: PokedexEntryRecord }): JSX.Element {
  return (
    <div className="species-editor">
      <header>
        <h2>
          #{entry.speciesIndex} {entry.speciesName ?? `Species ${entry.speciesIndex}`}
        </h2>
        <p>
          {entry.category ? <em>The {entry.category} Pokémon</em> : 'Category unknown'}
        </p>
      </header>
      <CategoryEditor entry={entry} />
      <FlavorTextEditor entry={entry} />
    </div>
  );
}

type SaveState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'saving' }
  | { readonly kind: 'saved' }
  | { readonly kind: 'error'; readonly message: string };

function CategoryEditor({ entry }: { entry: PokedexEntryRecord }): JSX.Element {
  const sessionId = useProjectStore((s) =>
    s.load.kind === 'loaded' ? s.load.data.session.id : null,
  );
  const scanCurrent = useProjectStore((s) => s.scanCurrentProject);
  const [name, setName] = useState(entry.category);
  const [state, setState] = useState<SaveState>({ kind: 'idle' });

  useEffect(() => {
    setName(entry.category);
    setState({ kind: 'idle' });
  }, [entry.entryFileOffset, entry.category]);

  if (entry.entryFileOffset === undefined) {
    return (
      <fieldset>
        <legend>Category</legend>
        <p style={{ fontStyle: 'italic', color: 'var(--color-text-muted)', margin: 0 }}>
          {entry.category || '(empty)'} - read-only (re-scan to pick up per-entry struct offsets)
        </p>
      </fieldset>
    );
  }

  const dirty = name !== entry.category;
  const valid = name.length <= POKEDEX_CATEGORY_MAX_LEN;
  const canSave = dirty && valid && sessionId !== null;

  async function save(): Promise<void> {
    if (!sessionId || !canSave || entry.entryFileOffset === undefined) return;
    setState({ kind: 'saving' });
    try {
      await editBinaryRomDialogueString(sessionId, {
        stringFileOffset: entry.entryFileOffset,
        newText: name,
      });
      setState({ kind: 'saved' });
      pushToast('success', `Category renamed to "${name}"`);
      await scanCurrent();
    } catch (e) {
      const message =
        e instanceof ProjectApiError
          ? `${e.code}: ${e.message}`
          : e instanceof Error
            ? e.message
            : String(e);
      setState({ kind: 'error', message });
      pushToast('error', `Category rename failed - ${message}`);
    }
  }

  // Phase O.30 - Enter saves, Esc reverts category name.
  const onKeyDownCategoryEdit = useEditFormKeyboard({
    canSave: canSave && state.kind !== 'saving',
    save,
    cancel: () => {
      setName(entry.category);
      setState({ kind: 'idle' });
    },
    isSaving: state.kind === 'saving',
  });

  return (
    <fieldset onKeyDown={onKeyDownCategoryEdit}>
      <legend>Category</legend>
      <div className="species-field-grid">
        <label className="species-field">
          <span>Category name (≤{POKEDEX_CATEGORY_MAX_LEN} chars)</span>
          <input
            type="text"
            maxLength={POKEDEX_CATEGORY_MAX_LEN}
            value={name}
            onChange={(e) => setName(e.target.value)}
            data-testid={`pokedex-category-input-${entry.id}`}
            spellCheck={false}
          />
        </label>
      </div>
      <div className="species-editor__actions">
        <button
          type="button"
          className="btn btn--primary"
          disabled={!canSave || state.kind === 'saving'}
          onClick={() => void save()}
          data-testid={`pokedex-category-save-${entry.id}`}
        >
          {state.kind === 'saving' ? 'Saving…' : 'Save category'}
        </button>
        {state.kind === 'saved' && !dirty && (
          <span className="fields-editor__status fields-editor__status--saved">
            Saved · 12-byte category slot patched
          </span>
        )}
        {state.kind === 'error' && (
          <span className="fields-editor__status fields-editor__status--error">
            {state.message}
          </span>
        )}
        {!valid && (
          <span className="fields-editor__status fields-editor__status--error">
            Too long - max {POKEDEX_CATEGORY_MAX_LEN} chars
          </span>
        )}
      </div>
    </fieldset>
  );
}

function FlavorTextEditor({ entry }: { entry: PokedexEntryRecord }): JSX.Element {
  const sessionId = useProjectStore((s) =>
    s.load.kind === 'loaded' ? s.load.data.session.id : null,
  );
  const scanCurrent = useProjectStore((s) => s.scanCurrentProject);
  const [text, setText] = useState(entry.flavorText);
  const [state, setState] = useState<SaveState>({ kind: 'idle' });

  useEffect(() => {
    setText(entry.flavorText);
    setState({ kind: 'idle' });
  }, [entry.descriptionFileOffset, entry.flavorText]);

  if (entry.descriptionFileOffset === undefined) {
    return (
      <fieldset>
        <legend>Flavor text</legend>
        {entry.flavorText ? (
          <p style={{ whiteSpace: 'pre-wrap', lineHeight: 1.5, margin: 0 }}>
            {entry.flavorText}
          </p>
        ) : (
          <p style={{ color: 'var(--color-text-muted)', fontStyle: 'italic', margin: 0 }}>
            (no flavor text - descriptionPtr null or out-of-ROM)
          </p>
        )}
        <p style={{ fontSize: 11, color: 'var(--color-text-muted)', marginTop: 8 }}>
          Read-only - this entry's descriptionPtr doesn't resolve to ROM-space
          bytes (re-scan if the pokedex detector was updated recently).
        </p>
      </fieldset>
    );
  }

  const dirty = text !== entry.flavorText;
  const valid = text.length > 0;
  const canSave = dirty && valid && sessionId !== null;

  async function save(): Promise<void> {
    if (!sessionId || !canSave || entry.descriptionFileOffset === undefined) return;
    setState({ kind: 'saving' });
    try {
      await editBinaryRomDialogueString(sessionId, {
        stringFileOffset: entry.descriptionFileOffset,
        newText: text,
      });
      setState({ kind: 'saved' });
      pushToast('success', `Flavor text saved for #${entry.speciesIndex}`);
      await scanCurrent();
    } catch (e) {
      const message =
        e instanceof ProjectApiError
          ? `${e.code}: ${e.message}`
          : e instanceof Error
            ? e.message
            : String(e);
      setState({ kind: 'error', message });
      pushToast('error', `Flavor text save failed - ${message}`);
    }
  }

  // Phase O.30 - Ctrl+Enter saves the textarea (plain Enter = newline),
  // Esc reverts flavor text.
  const onKeyDownFlavorEdit = useEditFormKeyboard({
    canSave: canSave && state.kind !== 'saving',
    save,
    cancel: () => {
      setText(entry.flavorText);
      setState({ kind: 'idle' });
    },
    isSaving: state.kind === 'saving',
  });

  return (
    <fieldset onKeyDown={onKeyDownFlavorEdit}>
      <legend>Flavor text</legend>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        data-testid={`pokedex-flavor-textarea-${entry.id}`}
        rows={6}
        style={{
          width: '100%',
          fontFamily: 'inherit',
          fontSize: 13,
          lineHeight: 1.5,
          padding: 8,
          boxSizing: 'border-box',
        }}
        spellCheck
      />
      <div className="species-editor__actions">
        <button
          type="button"
          className="btn btn--primary"
          disabled={!canSave || state.kind === 'saving'}
          onClick={() => void save()}
          data-testid={`pokedex-flavor-save-${entry.id}`}
        >
          {state.kind === 'saving' ? 'Saving…' : 'Save flavor text'}
        </button>
        {state.kind === 'saved' && !dirty && (
          <span className="fields-editor__status fields-editor__status--saved">
            Saved · flavor-text bytes patched in place
          </span>
        )}
        {state.kind === 'error' && (
          <span className="fields-editor__status fields-editor__status--error">
            {state.message}
          </span>
        )}
      </div>
      <p style={{ fontSize: 11, color: 'var(--color-text-muted)', marginTop: 8 }}>
        Edits patch the bytes at the original pointer in place. The new
        encoded length must fit within the original allocation; longer
        text returns an error (no relocation in this pass). Use
        <code> \p</code> for paragraph breaks, <code>\l</code> for line breaks.
      </p>
    </fieldset>
  );
}
