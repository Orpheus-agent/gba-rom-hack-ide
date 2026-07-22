import { useEffect, useMemo, useRef, useState } from 'react';
import { create } from 'zustand';
import {
  buildSemanticIndex,
  searchSemanticIndex,
  type SearchResult,
} from '../lib/semanticIndex';
import { useProjectStore, useSelection } from '../state';
import { useAnnotationsStore } from '../lib/annotations';
import { useSavedSearchesStore } from '../lib/savedSearches';
import './CommandPalette.css';

// Phase X.1 - Universal command palette. Cmd+K / Ctrl+K opens; type a
// query and any entity in the workspace (species, moves, abilities,
// types, items, trainers, maps, flags, variables, regions, dex,
// heal locations, songs) surfaces with a click that selects via
// useSelection. The selection re-renders the InspectorDock so the
// user can immediately edit / inspect.

interface CommandPaletteStoreState {
  readonly open: boolean;
  setOpen: (value: boolean) => void;
  toggle: () => void;
}

export const useCommandPaletteStore = create<CommandPaletteStoreState>(
  (set, get) => ({
    open: false,
    setOpen(value) {
      set({ open: value });
    },
    toggle() {
      set({ open: !get().open });
    },
  }),
);

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.dataset['cmdkInput'] === 'true') return false;
  const tag = target.tagName.toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;
  if (target.isContentEditable) return true;
  return false;
}

export function useCommandPaletteShortcut(): void {
  const toggle = useCommandPaletteStore((s) => s.toggle);
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== 'k') return;
      if (!(e.ctrlKey || e.metaKey)) return;
      // Allow even inside inputs - the palette is the universal escape
      // hatch. Only the palette's own input is exempt from re-opening.
      if (isTypingTarget(e.target)) return;
      if (e.repeat) return;
      e.preventDefault();
      toggle();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [toggle]);
}

export function CommandPalette() {
  const open = useCommandPaletteStore((s) => s.open);
  const setOpen = useCommandPaletteStore((s) => s.setOpen);
  const manifest = useProjectStore((s) =>
    s.scan.kind === 'loaded' ? s.scan.data.manifest : null,
  );
  // Re-render on annotation changes so renamed entities surface in
  // search results.
  useAnnotationsStore((s) => s.map);
  const select = useSelection((s) => s.select);

  const [query, setQuery] = useState('');
  const [activeIdx, setActiveIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const resultsRef = useRef<HTMLDivElement>(null);

  const savedSearches = useSavedSearchesStore((s) => s.list);
  const addSavedSearch = useSavedSearchesStore((s) => s.addSavedSearch);
  const removeSavedSearch = useSavedSearchesStore((s) => s.removeSavedSearch);
  const [showSavePrompt, setShowSavePrompt] = useState(false);
  const [saveName, setSaveName] = useState('');

  const index = useMemo(() => buildSemanticIndex(manifest), [manifest]);
  const results = useMemo(() => searchSemanticIndex(index, query, 50), [
    index,
    query,
  ]);

  // Reset query + active row when palette opens.
  useEffect(() => {
    if (open) {
      setQuery('');
      setActiveIdx(0);
      setShowSavePrompt(false);
      setSaveName('');
      // Autofocus the input.
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  // Clamp activeIdx into range.
  useEffect(() => {
    if (results.length === 0) {
      setActiveIdx(0);
    } else if (activeIdx >= results.length) {
      setActiveIdx(results.length - 1);
    }
  }, [results.length, activeIdx]);

  if (!open) return null;

  const commit = (r: SearchResult) => {
    select({
      kind: r.entry.kind,
      id: r.entry.id,
      mapContext: r.entry.mapContext,
    });
    setOpen(false);
  };

  return (
    <div
      className="command-palette__backdrop"
      data-testid="command-palette-backdrop"
      onClick={() => setOpen(false)}
    >
      <div
        className="command-palette"
        data-testid="command-palette"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Search the workspace"
      >
        <input
          ref={inputRef}
          type="text"
          className="command-palette__input"
          placeholder={
            manifest
              ? 'Find anything - Pokémon, move, trainer, map, flag, item…'
              : 'No project open - load a ROM in the Project view first'
          }
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault();
              setOpen(false);
              return;
            }
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setActiveIdx((i) => Math.min(results.length - 1, i + 1));
              return;
            }
            if (e.key === 'ArrowUp') {
              e.preventDefault();
              setActiveIdx((i) => Math.max(0, i - 1));
              return;
            }
            if (e.key === 'Enter') {
              e.preventDefault();
              const r = results[activeIdx];
              if (r) commit(r);
              return;
            }
          }}
          data-testid="command-palette-input"
          data-cmdk-input="true"
          aria-controls="command-palette-results"
        />
        <div
          ref={resultsRef}
          id="command-palette-results"
          className="command-palette__results"
          data-testid="command-palette-results"
          role="listbox"
        >
          {!manifest ? (
            <div className="command-palette__empty">
              Open a project to enable search.
            </div>
          ) : query.trim() === '' ? (
            <div className="command-palette__empty">
              {savedSearches.length > 0 && (
                <div
                  className="command-palette__saved-row"
                  data-testid="command-palette-saved-row"
                >
                  <div className="command-palette__saved-label">
                    Saved searches
                  </div>
                  <ul className="command-palette__saved-list">
                    {savedSearches.map((s) => (
                      <li key={s.id}>
                        <button
                          type="button"
                          className="command-palette__saved-chip"
                          onClick={() => setQuery(s.query)}
                          title={s.query}
                          data-testid={`command-palette-saved-${s.id}`}
                        >
                          {s.name}
                        </button>
                        <button
                          type="button"
                          className="command-palette__saved-remove"
                          onClick={() => removeSavedSearch(s.id)}
                          title="Remove this saved search"
                          aria-label={`Remove saved search ${s.name}`}
                        >
                          ✕
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              <p style={{ margin: '8px 0 0 0' }}>
                {index.entryCount.toLocaleString()} entities indexed - start
                typing.
              </p>
            </div>
          ) : results.length === 0 ? (
            <div className="command-palette__empty">
              No matches for &ldquo;{query}&rdquo;
            </div>
          ) : (
            results.map((r, i) => (
              <button
                key={`${r.entry.kind}-${r.entry.id}`}
                type="button"
                className={`command-palette__row${
                  i === activeIdx ? ' command-palette__row--active' : ''
                }`}
                onClick={() => commit(r)}
                onMouseEnter={() => setActiveIdx(i)}
                role="option"
                aria-selected={i === activeIdx}
                data-testid={`command-palette-row-${i}`}
              >
                <span className="command-palette__row-kind">
                  {r.entry.kind}
                </span>
                <span className="command-palette__row-name">
                  {r.entry.name}
                </span>
                <span className="command-palette__row-hint">
                  {r.entry.hint}
                </span>
              </button>
            ))
          )}
        </div>
        <div className="command-palette__footer">
          {showSavePrompt ? (
            <form
              className="command-palette__save-form"
              data-testid="command-palette-save-form"
              onSubmit={(e) => {
                e.preventDefault();
                if (addSavedSearch(saveName, query)) {
                  setShowSavePrompt(false);
                  setSaveName('');
                }
              }}
            >
              <input
                type="text"
                placeholder="Name this search"
                value={saveName}
                onChange={(e) => setSaveName(e.target.value)}
                autoFocus
                data-testid="command-palette-save-name-input"
              />
              <button
                type="submit"
                className="command-palette__save-confirm"
                data-testid="command-palette-save-confirm"
              >
                Save
              </button>
              <button
                type="button"
                className="command-palette__save-cancel"
                onClick={() => setShowSavePrompt(false)}
              >
                Cancel
              </button>
            </form>
          ) : (
            <>
              <span>
                <kbd>↑↓</kbd> navigate · <kbd>Enter</kbd> select · <kbd>Esc</kbd>{' '}
                close
              </span>
              <span className="command-palette__footer-right">
                {manifest && query.trim() && (
                  <button
                    type="button"
                    className="command-palette__save-btn"
                    onClick={() => {
                      setSaveName(query);
                      setShowSavePrompt(true);
                    }}
                    title="Save this query"
                    data-testid="command-palette-save-btn"
                  >
                    + Save search
                  </button>
                )}
                {manifest && (
                  <span className="command-palette__footer-count">
                    {results.length} of {index.entryCount.toLocaleString()}
                  </span>
                )}
              </span>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
