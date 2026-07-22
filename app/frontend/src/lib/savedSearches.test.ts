import { beforeEach, describe, expect, it } from 'vitest';
import { useSavedSearchesStore } from './savedSearches';

describe('useSavedSearchesStore (Phase X.3)', () => {
  beforeEach(() => {
    if (typeof window !== 'undefined') {
      try {
        Object.keys(window.localStorage).forEach((k) => {
          if (k.startsWith('rom-editor.saved-searches')) {
            window.localStorage.removeItem(k);
          }
        });
      } catch {
        // ignore
      }
    }
    useSavedSearchesStore.setState({ projectKey: '_default', list: [] });
  });

  it('starts empty', () => {
    expect(useSavedSearchesStore.getState().list).toEqual([]);
  });

  it('addSavedSearch persists name + query', () => {
    const entry = useSavedSearchesStore
      .getState()
      .addSavedSearch('Gym Trainers', 'kind:trainer gym');
    expect(entry).not.toBeNull();
    const list = useSavedSearchesStore.getState().list;
    expect(list).toHaveLength(1);
    expect(list[0]?.name).toBe('Gym Trainers');
    expect(list[0]?.query).toBe('kind:trainer gym');
  });

  it('trims whitespace from name + query', () => {
    useSavedSearchesStore
      .getState()
      .addSavedSearch('  Surf Routes  ', '  type:water kind:map  ');
    const entry = useSavedSearchesStore.getState().list[0];
    expect(entry?.name).toBe('Surf Routes');
    expect(entry?.query).toBe('type:water kind:map');
  });

  it('rejects empty name or empty query', () => {
    expect(
      useSavedSearchesStore.getState().addSavedSearch('', 'kind:trainer'),
    ).toBeNull();
    expect(useSavedSearchesStore.getState().addSavedSearch('Foo', '')).toBeNull();
    expect(useSavedSearchesStore.getState().list).toHaveLength(0);
  });

  it('does not double-add the same query', () => {
    useSavedSearchesStore.getState().addSavedSearch('Foo', 'kind:trainer');
    useSavedSearchesStore.getState().addSavedSearch('Bar', 'kind:trainer');
    expect(useSavedSearchesStore.getState().list).toHaveLength(1);
  });

  it('removeSavedSearch removes by id', () => {
    const e = useSavedSearchesStore.getState().addSavedSearch('Foo', 'a')!;
    useSavedSearchesStore.getState().addSavedSearch('Bar', 'b');
    useSavedSearchesStore.getState().removeSavedSearch(e.id);
    const list = useSavedSearchesStore.getState().list;
    expect(list).toHaveLength(1);
    expect(list[0]?.name).toBe('Bar');
  });

  it('renameSavedSearch updates the name only', () => {
    const e = useSavedSearchesStore.getState().addSavedSearch('Foo', 'a')!;
    useSavedSearchesStore.getState().renameSavedSearch(e.id, 'Better Name');
    expect(useSavedSearchesStore.getState().list[0]?.name).toBe('Better Name');
    expect(useSavedSearchesStore.getState().list[0]?.query).toBe('a');
  });

  it('persists across project key switches', () => {
    useSavedSearchesStore.getState().addSavedSearch('Default Q', 'a');
    useSavedSearchesStore.getState().setProjectKey('project-a');
    expect(useSavedSearchesStore.getState().list).toEqual([]); // new namespace empty
    useSavedSearchesStore.getState().addSavedSearch('A Q', 'b');
    useSavedSearchesStore.getState().setProjectKey('_default');
    expect(useSavedSearchesStore.getState().list[0]?.name).toBe('Default Q');
    useSavedSearchesStore.getState().setProjectKey('project-a');
    expect(useSavedSearchesStore.getState().list[0]?.name).toBe('A Q');
  });
});
