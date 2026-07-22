import { beforeEach, describe, expect, it } from 'vitest';
import {
  deriveProjectKey,
  lookupAnnotation,
  lookupAnnotationDescription,
  useAnnotationsStore,
} from './annotations';

describe('useAnnotationsStore (Phase Q.6)', () => {
  beforeEach(() => {
    if (typeof window !== 'undefined') {
      try {
        Object.keys(window.localStorage).forEach((k) => {
          if (k.startsWith('rom-editor.annotations')) {
            window.localStorage.removeItem(k);
          }
        });
      } catch {
        // ignore
      }
    }
    useAnnotationsStore.setState({
      projectKey: '_default',
      map: {},
    });
  });

  it('starts empty', () => {
    expect(useAnnotationsStore.getState().map).toEqual({});
    expect(useAnnotationsStore.getState().getAnnotation('flag', 'FLAG_X')).toBeNull();
  });

  it('setAnnotation stores and retrieves by kind+id', () => {
    useAnnotationsStore.getState().setAnnotation('flag', 'FLAG_X', 'My Custom Flag');
    expect(useAnnotationsStore.getState().getAnnotation('flag', 'FLAG_X')).toBe(
      'My Custom Flag',
    );
    expect(lookupAnnotation('flag', 'FLAG_X')).toBe('My Custom Flag');
  });

  it('trims whitespace from annotation value', () => {
    useAnnotationsStore.getState().setAnnotation('move', 'MOVE_TACKLE', '  Body Slam  ');
    expect(useAnnotationsStore.getState().getAnnotation('move', 'MOVE_TACKLE')).toBe(
      'Body Slam',
    );
  });

  it('empty string deletes the annotation', () => {
    useAnnotationsStore.getState().setAnnotation('flag', 'FLAG_X', 'Foo');
    expect(useAnnotationsStore.getState().getAnnotation('flag', 'FLAG_X')).toBe('Foo');
    useAnnotationsStore.getState().setAnnotation('flag', 'FLAG_X', '');
    expect(useAnnotationsStore.getState().getAnnotation('flag', 'FLAG_X')).toBeNull();
  });

  it('clearAnnotation removes the entry', () => {
    useAnnotationsStore.getState().setAnnotation('flag', 'FLAG_X', 'Foo');
    useAnnotationsStore.getState().clearAnnotation('flag', 'FLAG_X');
    expect(useAnnotationsStore.getState().getAnnotation('flag', 'FLAG_X')).toBeNull();
  });

  it('isolates annotations by kind (different EntityKinds with same id)', () => {
    useAnnotationsStore.getState().setAnnotation('flag', 'X', 'Flag X');
    useAnnotationsStore.getState().setAnnotation('variable', 'X', 'Var X');
    expect(useAnnotationsStore.getState().getAnnotation('flag', 'X')).toBe('Flag X');
    expect(useAnnotationsStore.getState().getAnnotation('variable', 'X')).toBe('Var X');
  });

  it('persists across reloads via localStorage', () => {
    useAnnotationsStore.getState().setAnnotation('species', 'species_1', 'Best Mon');
    if (typeof window === 'undefined') return;
    // Simulate reload by re-deriving the initial map.
    const raw = window.localStorage.getItem('rom-editor.annotations._default');
    expect(raw).toBeTruthy();
    const parsed = JSON.parse(raw!);
    // Phase Q.6.1 - storage moved from plain string values to rich
    // `{ name, description? }` objects so descriptions can be attached.
    // String form still parses back via the migration path in
    // loadFromStorage; new writes use the object form.
    expect(parsed['species:species_1']).toEqual({ name: 'Best Mon' });
  });

  it('switches namespace via setProjectKey + loads its data', () => {
    useAnnotationsStore.getState().setAnnotation('flag', 'FLAG_X', 'In default');
    useAnnotationsStore.getState().setProjectKey('project-a');
    // New namespace: starts empty (no entries written under project-a yet)
    expect(useAnnotationsStore.getState().getAnnotation('flag', 'FLAG_X')).toBeNull();
    useAnnotationsStore.getState().setAnnotation('flag', 'FLAG_X', 'In project A');
    // Switching back to default surfaces the original.
    useAnnotationsStore.getState().setProjectKey('_default');
    expect(useAnnotationsStore.getState().getAnnotation('flag', 'FLAG_X')).toBe(
      'In default',
    );
    // And back to project-a surfaces its.
    useAnnotationsStore.getState().setProjectKey('project-a');
    expect(useAnnotationsStore.getState().getAnnotation('flag', 'FLAG_X')).toBe(
      'In project A',
    );
  });
});

describe('useAnnotationsStore - rich descriptions (Phase Q.6.1 overhaul)', () => {
  beforeEach(() => {
    if (typeof window !== 'undefined') {
      try {
        Object.keys(window.localStorage).forEach((k) => {
          if (k.startsWith('rom-editor.annotations')) {
            window.localStorage.removeItem(k);
          }
        });
      } catch {
        // ignore
      }
    }
    useAnnotationsStore.setState({ projectKey: '_default', map: {} });
  });

  it('stores a description independently of a name', () => {
    useAnnotationsStore
      .getState()
      .setAnnotationDescription('flag', 'FLAG_X', 'Fires when the player defeats Brock.');
    expect(lookupAnnotation('flag', 'FLAG_X')).toBeNull();
    expect(lookupAnnotationDescription('flag', 'FLAG_X')).toBe(
      'Fires when the player defeats Brock.',
    );
  });

  it('preserves the description when only the name is updated', () => {
    useAnnotationsStore
      .getState()
      .setAnnotationDescription('flag', 'FLAG_X', 'Brock-defeat flag.');
    useAnnotationsStore.getState().setAnnotation('flag', 'FLAG_X', 'Brock down');
    expect(lookupAnnotation('flag', 'FLAG_X')).toBe('Brock down');
    expect(lookupAnnotationDescription('flag', 'FLAG_X')).toBe('Brock-defeat flag.');
  });

  it('preserves the name when only the description is updated', () => {
    useAnnotationsStore.getState().setAnnotation('flag', 'FLAG_X', 'Brock down');
    useAnnotationsStore
      .getState()
      .setAnnotationDescription('flag', 'FLAG_X', 'Set after defeating Brock');
    expect(lookupAnnotation('flag', 'FLAG_X')).toBe('Brock down');
    expect(lookupAnnotationDescription('flag', 'FLAG_X')).toBe('Set after defeating Brock');
  });

  it('clearing description by passing empty string preserves the name', () => {
    useAnnotationsStore.getState().setAnnotation('flag', 'FLAG_X', 'Brock down');
    useAnnotationsStore.getState().setAnnotationDescription('flag', 'FLAG_X', 'A note');
    useAnnotationsStore.getState().setAnnotationDescription('flag', 'FLAG_X', '');
    expect(lookupAnnotation('flag', 'FLAG_X')).toBe('Brock down');
    expect(lookupAnnotationDescription('flag', 'FLAG_X')).toBeNull();
  });

  it('clearing name by passing empty string preserves the description', () => {
    useAnnotationsStore.getState().setAnnotation('flag', 'FLAG_X', 'Brock down');
    useAnnotationsStore.getState().setAnnotationDescription('flag', 'FLAG_X', 'A note');
    useAnnotationsStore.getState().setAnnotation('flag', 'FLAG_X', '');
    expect(lookupAnnotation('flag', 'FLAG_X')).toBeNull();
    expect(lookupAnnotationDescription('flag', 'FLAG_X')).toBe('A note');
  });

  it('clearing both name and description removes the entry entirely', () => {
    useAnnotationsStore.getState().setAnnotation('flag', 'FLAG_X', 'Brock down');
    useAnnotationsStore.getState().setAnnotationDescription('flag', 'FLAG_X', 'A note');
    useAnnotationsStore.getState().setAnnotation('flag', 'FLAG_X', '');
    useAnnotationsStore.getState().setAnnotationDescription('flag', 'FLAG_X', '');
    expect(useAnnotationsStore.getState().map).toEqual({});
  });

  it('getFullAnnotation returns both fields when set', () => {
    useAnnotationsStore.getState().setAnnotation('flag', 'FLAG_X', 'Brock down');
    useAnnotationsStore.getState().setAnnotationDescription('flag', 'FLAG_X', 'A note');
    const full = useAnnotationsStore.getState().getFullAnnotation('flag', 'FLAG_X');
    expect(full).toEqual({ name: 'Brock down', description: 'A note' });
  });

  it('loads legacy string-only entries from localStorage as { name } objects', () => {
    if (typeof window === 'undefined') return; // skip in non-DOM environments
    window.localStorage.setItem(
      'rom-editor.annotations.legacy-test',
      JSON.stringify({ 'flag:FLAG_LEGACY': 'My old name' }),
    );
    useAnnotationsStore.getState().setProjectKey('legacy-test');
    expect(useAnnotationsStore.getState().getAnnotation('flag', 'FLAG_LEGACY')).toBe('My old name');
    expect(useAnnotationsStore.getState().getFullAnnotation('flag', 'FLAG_LEGACY')).toEqual({
      name: 'My old name',
    });
  });

  it('loads existing object-form entries from localStorage', () => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(
      'rom-editor.annotations.rich-test',
      JSON.stringify({
        'flag:FLAG_RICH': { name: 'Rich Name', description: 'Rich description' },
      }),
    );
    useAnnotationsStore.getState().setProjectKey('rich-test');
    expect(
      useAnnotationsStore.getState().getFullAnnotation('flag', 'FLAG_RICH'),
    ).toEqual({ name: 'Rich Name', description: 'Rich description' });
  });
});

describe('deriveProjectKey', () => {
  it('returns _default for empty input', () => {
    expect(deriveProjectKey({})).toBe('_default');
    expect(deriveProjectKey({ projectRoot: '', displayName: '' })).toBe('_default');
  });

  it('returns a stable hex hash for a given input', () => {
    const k1 = deriveProjectKey({
      projectRoot: '/abs/firered',
      displayName: 'pokefirered (decomp)',
    });
    const k2 = deriveProjectKey({
      projectRoot: '/abs/firered',
      displayName: 'pokefirered (decomp)',
    });
    expect(k1).toBe(k2);
    expect(k1).toMatch(/^p[0-9a-f]+$/);
  });

  it('returns different hashes for different inputs', () => {
    const k1 = deriveProjectKey({
      projectRoot: '/abs/firered',
      displayName: 'FireRed',
    });
    const k2 = deriveProjectKey({
      projectRoot: '/abs/unbound',
      displayName: 'Unbound',
    });
    expect(k1).not.toBe(k2);
  });
});

// ─── WP-C3 - Side-car sync ───────────────────────────────────────────

describe('useAnnotationsStore - side-car sync (WP-C3)', () => {
  let fetchCalls: Array<{ url: string; init: RequestInit }>;
  let fetchResponse: { status: number; body: unknown };

  beforeEach(async () => {
    const { _setSidecarFetchForTests, _flushSideCarPushForTests, useAnnotationsStore } =
      await import('./annotations');
    fetchCalls = [];
    fetchResponse = {
      status: 200,
      body: { schemaVersion: 1, updatedAtUtc: '2026-05-25T00:00:00Z', annotations: {} },
    };
    _setSidecarFetchForTests((async (url: unknown, init: unknown) => {
      fetchCalls.push({ url: String(url), init: (init as RequestInit) ?? {} });
      return {
        ok: fetchResponse.status >= 200 && fetchResponse.status < 300,
        status: fetchResponse.status,
        json: async () => fetchResponse.body,
        text: async () => JSON.stringify(fetchResponse.body),
      } as unknown as Response;
    }) as unknown as typeof fetch);
    _flushSideCarPushForTests();
    useAnnotationsStore.setState({ projectKey: '_default', sessionId: null, map: {} });
  });

  it('setSession(null) is a no-op (no fetch)', async () => {
    await useAnnotationsStore.getState().setSession(null);
    expect(fetchCalls.length).toBe(0);
  });

  it('setSession(id) GETs the side-car + merges into local map', async () => {
    fetchResponse = {
      status: 200,
      body: {
        schemaVersion: 1,
        updatedAtUtc: 'now',
        annotations: {
          'flag:FROM_DISK': { name: 'From disk', description: 'shared by team' },
        },
      },
    };
    await useAnnotationsStore.getState().setSession('sess-1');
    expect(fetchCalls.length).toBe(1);
    expect(fetchCalls[0]!.url).toContain('/api/projects/sess-1/annotations');
    expect(fetchCalls[0]!.init.method).toBe('GET');
    expect(
      useAnnotationsStore.getState().getAnnotation('flag', 'FROM_DISK'),
    ).toBe('From disk');
  });

  it('local map wins on conflict when merging from disk (in-flight edits preserved)', async () => {
    useAnnotationsStore.getState().setAnnotation('flag', 'CONFLICT', 'Local name');
    fetchResponse = {
      status: 200,
      body: {
        schemaVersion: 1,
        updatedAtUtc: 'now',
        annotations: {
          'flag:CONFLICT': { name: 'Stale disk name' },
        },
      },
    };
    await useAnnotationsStore.getState().setSession('sess-1');
    // Local wins.
    expect(useAnnotationsStore.getState().getAnnotation('flag', 'CONFLICT')).toBe(
      'Local name',
    );
  });

  it('setAnnotation schedules a debounced PUT to the side-car', async () => {
    const { _flushSideCarPushForTests, useAnnotationsStore: store } = await import('./annotations');
    await store.getState().setSession('sess-1');
    fetchCalls.length = 0; // discard the GET from setSession
    store.getState().setAnnotation('flag', 'X', 'Boulder Badge');
    // Not yet PUT (debounced).
    expect(fetchCalls.filter((c) => c.init.method === 'PUT').length).toBe(0);
    // Fire the pending push synchronously instead of waiting 400ms.
    const fired = _flushSideCarPushForTests();
    expect(fired).toBe(true);
    // Let the fetch promise resolve.
    await Promise.resolve();
    const puts = fetchCalls.filter((c) => c.init.method === 'PUT');
    expect(puts.length).toBeGreaterThanOrEqual(1);
    const lastPut = puts[puts.length - 1]!;
    const body = JSON.parse(String(lastPut.init.body)) as {
      annotations: Record<string, { name: string }>;
    };
    expect(body.annotations['flag:X']!.name).toBe('Boulder Badge');
  });

  it('coalesces multiple rapid mutations into a single PUT', async () => {
    const { _flushSideCarPushForTests, useAnnotationsStore: store } = await import('./annotations');
    await store.getState().setSession('sess-1');
    fetchCalls.length = 0;
    store.getState().setAnnotation('flag', 'A', 'a');
    store.getState().setAnnotation('flag', 'B', 'b');
    store.getState().setAnnotation('flag', 'C', 'c');
    // Only one PUT scheduled (debounced).
    _flushSideCarPushForTests();
    await Promise.resolve();
    const puts = fetchCalls.filter((c) => c.init.method === 'PUT');
    expect(puts.length).toBe(1);
    const body = JSON.parse(String(puts[0]!.init.body)) as {
      annotations: Record<string, { name: string }>;
    };
    expect(Object.keys(body.annotations).sort()).toEqual(['flag:A', 'flag:B', 'flag:C']);
  });

  it('setSession(null) → setAnnotation does NOT PUT (no active project)', async () => {
    const { _flushSideCarPushForTests } = await import('./annotations');
    await useAnnotationsStore.getState().setSession(null);
    fetchCalls.length = 0;
    useAnnotationsStore.getState().setAnnotation('flag', 'X', 'Local only');
    // Pending push fires but the guard inside it returns early when sessionId=null.
    _flushSideCarPushForTests();
    await Promise.resolve();
    expect(fetchCalls.filter((c) => c.init.method === 'PUT').length).toBe(0);
  });

  it('side-car GET failure is silent (local store remains usable)', async () => {
    fetchResponse = { status: 500, body: { error: 'server died' } };
    useAnnotationsStore.getState().setAnnotation('flag', 'LOCAL', 'preserved');
    await useAnnotationsStore.getState().setSession('sess-broken');
    // Local annotation survives the bad GET.
    expect(useAnnotationsStore.getState().getAnnotation('flag', 'LOCAL')).toBe(
      'preserved',
    );
  });
});
