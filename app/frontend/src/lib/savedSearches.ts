import { create } from 'zustand';

// Phase X.3 - Saved searches. Users can name a Command Palette query
// and pin it for one-click access ("All rival battles", "Surfable
// routes", "Trainers using Charizard"). Persists per-project via
// the same hashed project key the annotations system uses.

const STORAGE_PREFIX = 'rom-editor.saved-searches';
const DEFAULT_PROJECT_KEY = '_default';

export interface SavedSearch {
  readonly id: string;
  readonly name: string;
  readonly query: string;
  readonly createdAtUtc: string;
}

function storageKey(projectKey: string): string {
  return `${STORAGE_PREFIX}.${projectKey}`;
}

function load(projectKey: string): SavedSearch[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(storageKey(projectKey));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (s): s is SavedSearch =>
          s &&
          typeof s.id === 'string' &&
          typeof s.name === 'string' &&
          typeof s.query === 'string' &&
          typeof s.createdAtUtc === 'string',
      );
  } catch {
    return [];
  }
}

function save(projectKey: string, list: ReadonlyArray<SavedSearch>): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(storageKey(projectKey), JSON.stringify(list));
  } catch {
    // best-effort
  }
}

interface SavedSearchesStoreState {
  readonly projectKey: string;
  readonly list: ReadonlyArray<SavedSearch>;
  setProjectKey: (key: string) => void;
  addSavedSearch: (name: string, query: string) => SavedSearch | null;
  removeSavedSearch: (id: string) => void;
  renameSavedSearch: (id: string, newName: string) => void;
}

export const useSavedSearchesStore = create<SavedSearchesStoreState>(
  (set, get) => ({
    projectKey: DEFAULT_PROJECT_KEY,
    list: load(DEFAULT_PROJECT_KEY),
    setProjectKey(key) {
      const normalized = (key || '').trim() || DEFAULT_PROJECT_KEY;
      if (normalized === get().projectKey) return;
      set({ projectKey: normalized, list: load(normalized) });
    },
    addSavedSearch(name, query) {
      const trimmedName = name.trim();
      const trimmedQuery = query.trim();
      if (!trimmedName || !trimmedQuery) return null;
      const s = get();
      // Don't double-add an identical query.
      if (s.list.some((x) => x.query === trimmedQuery)) {
        return s.list.find((x) => x.query === trimmedQuery) ?? null;
      }
      const entry: SavedSearch = {
        id: `ss-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        name: trimmedName,
        query: trimmedQuery,
        createdAtUtc: new Date().toISOString(),
      };
      const next = [...s.list, entry];
      save(s.projectKey, next);
      set({ list: next });
      return entry;
    },
    removeSavedSearch(id) {
      const s = get();
      const next = s.list.filter((x) => x.id !== id);
      save(s.projectKey, next);
      set({ list: next });
    },
    renameSavedSearch(id, newName) {
      const trimmed = newName.trim();
      if (!trimmed) return;
      const s = get();
      const next = s.list.map((x) =>
        x.id === id ? { ...x, name: trimmed } : x,
      );
      save(s.projectKey, next);
      set({ list: next });
    },
  }),
);
