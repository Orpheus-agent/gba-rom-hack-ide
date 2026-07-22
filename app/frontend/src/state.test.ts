import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  pushToast,
  useAdvancedDrawerStore,
  useProjectStore,
  useSelection,
  useToastStore,
  useViewStore,
} from './state';
import type { ProjectOpenResponse } from '@rom-editor/shared';

const sampleResponse: ProjectOpenResponse = {
  session: {
    id: 'test-session-1',
    projectRoot: '/abs/path/example',
    openedAtUtc: '2026-05-16T07:00:00Z',
  },
  rootListing: {
    path: '',
    entries: [
      { name: 'Makefile', kind: 'file', relativePath: 'Makefile', sizeBytes: 12 },
      { name: 'src', kind: 'directory', relativePath: 'src', sizeBytes: null },
    ],
  },
  identity: {
    kind: 'decomp',
    confidence: 0.85,
    displayName: 'pokeemerald (decomp)',
    baseGame: 'pokeemerald',
    fork: null,
    featureFlags: [],
    warnings: [],
    evidence: ['Makefile', 'src/', 'pokeemerald.ld'],
  },
};

describe('useProjectStore', () => {
  beforeEach(() => {
    useProjectStore.setState({ load: { kind: 'empty' } });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('starts in the empty state', () => {
    expect(useProjectStore.getState().load.kind).toBe('empty');
  });

  it('transitions empty → loading → loaded on a successful open', async () => {
    let resolveResponse!: (r: Response) => void;
    const pendingResponse = new Promise<Response>((res) => (resolveResponse = res));
    vi.stubGlobal('fetch', vi.fn(() => pendingResponse));

    const promise = useProjectStore.getState().openProject('/abs/path/example');
    // Synchronously after kick-off we should be in loading state
    expect(useProjectStore.getState().load.kind).toBe('loading');
    if (useProjectStore.getState().load.kind === 'loading') {
      expect((useProjectStore.getState().load as { projectRoot: string }).projectRoot).toBe(
        '/abs/path/example',
      );
    }

    resolveResponse(
      new Response(JSON.stringify(sampleResponse), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    await promise;
    const final = useProjectStore.getState().load;
    expect(final.kind).toBe('loaded');
    if (final.kind === 'loaded') {
      expect(final.data.identity.displayName).toBe('pokeemerald (decomp)');
      expect(final.data.session.id).toBe('test-session-1');
    }
  });

  it('transitions empty → loading → error on an API error response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              error: { code: 'project_root_not_found', message: 'no such dir' },
            }),
            { status: 404, headers: { 'content-type': 'application/json' } },
          ),
      ),
    );

    await useProjectStore.getState().openProject('/abs/missing');
    const final = useProjectStore.getState().load;
    expect(final.kind).toBe('error');
    if (final.kind === 'error') {
      expect(final.code).toBe('project_root_not_found');
      expect(final.message).toBe('no such dir');
      expect(final.projectRoot).toBe('/abs/missing');
    }
  });

  it('closeProject resets to empty', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify(sampleResponse), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      ),
    );
    await useProjectStore.getState().openProject('/abs/path/example');
    expect(useProjectStore.getState().load.kind).toBe('loaded');

    useProjectStore.getState().closeProject();
    expect(useProjectStore.getState().load.kind).toBe('empty');
  });
});

describe('useViewStore', () => {
  beforeEach(() => {
    useViewStore.setState({ activeView: 'project' });
  });

  it('defaults to the project view', () => {
    expect(useViewStore.getState().activeView).toBe('project');
  });

  it('switches active view via setView', () => {
    useViewStore.getState().setView('maps');
    expect(useViewStore.getState().activeView).toBe('maps');
    useViewStore.getState().setView('build');
    expect(useViewStore.getState().activeView).toBe('build');
  });
});

describe('useToastStore', () => {
  beforeEach(() => {
    useToastStore.setState({ toasts: [] });
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('pushToast adds a toast that auto-dismisses after 4 seconds', () => {
    pushToast('success', 'Saved');
    expect(useToastStore.getState().toasts).toHaveLength(1);
    expect(useToastStore.getState().toasts[0]?.kind).toBe('success');
    expect(useToastStore.getState().toasts[0]?.message).toBe('Saved');

    vi.advanceTimersByTime(4000);
    expect(useToastStore.getState().toasts).toHaveLength(0);
  });

  it('dismiss removes a toast immediately', () => {
    pushToast('error', 'Failed');
    const id = useToastStore.getState().toasts[0]!.id;
    useToastStore.getState().dismiss(id);
    expect(useToastStore.getState().toasts).toHaveLength(0);
  });

  it('stacks multiple toasts in order', () => {
    pushToast('info', 'First');
    pushToast('success', 'Second');
    pushToast('error', 'Third');
    const toasts = useToastStore.getState().toasts;
    expect(toasts.map((t) => t.message)).toEqual(['First', 'Second', 'Third']);
  });
});

describe('useSelection (Phase P.2)', () => {
  beforeEach(() => {
    useSelection.setState({ current: null, history: [] });
  });

  it('starts with no selection', () => {
    expect(useSelection.getState().current).toBeNull();
    expect(useSelection.getState().history).toEqual([]);
  });

  it('select replaces the current entity', () => {
    useSelection.getState().select({ kind: 'species', id: 'SPECIES_BULBASAUR' });
    expect(useSelection.getState().current).toEqual({
      kind: 'species',
      id: 'SPECIES_BULBASAUR',
    });

    useSelection.getState().select({ kind: 'trainer', id: 'TRAINER_BROCK' });
    expect(useSelection.getState().current).toEqual({
      kind: 'trainer',
      id: 'TRAINER_BROCK',
    });
  });

  it('re-selecting the same entity is a no-op (idempotent)', () => {
    const ref = { kind: 'flag' as const, id: 'FLAG_BADGE01_GET' };
    useSelection.getState().select(ref);
    const stateAfterFirst = useSelection.getState();
    useSelection.getState().select(ref);
    expect(useSelection.getState()).toBe(stateAfterFirst);
  });

  it('selecting the same id under a new mapContext replaces the selection', () => {
    useSelection
      .getState()
      .select({ kind: 'objectEvent', id: 'obj_brock', mapContext: 'MAP_PEWTER_GYM' });
    useSelection
      .getState()
      .select({ kind: 'objectEvent', id: 'obj_brock', mapContext: 'MAP_VIRIDIAN_CITY' });
    expect(useSelection.getState().current?.mapContext).toBe('MAP_VIRIDIAN_CITY');
  });

  it('preserves the previous selection in history (most recent first, deduped)', () => {
    useSelection.getState().select({ kind: 'species', id: 'BULBASAUR' });
    useSelection.getState().select({ kind: 'species', id: 'CHARMANDER' });
    useSelection.getState().select({ kind: 'species', id: 'SQUIRTLE' });
    const history = useSelection.getState().history;
    expect(history.map((h) => h.id)).toEqual(['CHARMANDER', 'BULBASAUR']);
  });

  it('clear() drops the current selection but preserves history', () => {
    useSelection.getState().select({ kind: 'map', id: 'MAP_PALLET_TOWN' });
    useSelection.getState().select({ kind: 'map', id: 'MAP_ROUTE_1' });
    useSelection.getState().clear();
    expect(useSelection.getState().current).toBeNull();
    expect(useSelection.getState().history.length).toBeGreaterThan(0);
  });

  it('supports the full EntityKind union without TS narrowing failures', () => {
    // Smoke: every kind the roadmap commits to is selectable.
    const kinds = [
      'map',
      'warp',
      'trigger',
      'objectEvent',
      'sign',
      'door',
      'healLocation',
      'tile',
      'connection',
      'species',
      'move',
      'ability',
      'type',
      'item',
      'trainer',
      'trainerClass',
      'flag',
      'variable',
      'script',
      'scriptStep',
      'dialogue',
      'multichoice',
      'choice',
      'tileset',
      'palette',
      'asset',
      'sprite',
      'song',
      'encounterTable',
      'encounterSlot',
      'pokedexEntry',
      'region',
      'structure',
      'cutscene',
    ] as const;
    for (const k of kinds) {
      useSelection.getState().select({ kind: k, id: 'demo' });
      expect(useSelection.getState().current?.kind).toBe(k);
    }
  });
});

// ─── Stale-while-revalidate rescan (2026-05-26 bug fix) ─────────────
//
// Before this fix, scanCurrentProject() set scan: {kind:'scanning'},
// which threw away the previous manifest data. Every consumer that
// gated on `scan.kind === 'loaded'` (MapEditor, inspectors, the
// visual scripter) UNMOUNTED for the entire duration of the rescan.
// All React state inside those subtrees - which inspector was open,
// scroll position, inline editor drafts - was destroyed; the user
// landed back at default after every script edit / encounter edit /
// annotation push. The fix: keep the previous `loaded` data visible
// during rescans by flipping to {kind:'loaded', data, revalidating:true}
// instead of {kind:'scanning'}. Consumers that care can read the
// revalidating flag to show a subtle "syncing" pip without unmounting.
describe('useProjectStore.scanCurrentProject - stale-while-revalidate', () => {
  beforeEach(() => {
    useProjectStore.setState({ load: { kind: 'empty' }, scan: { kind: 'idle' } });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('keeps the previous scan data visible during a rescan (revalidating flag set)', async () => {
    // Synthetic scan shapes - we just need a unique marker to tell the
    // two apart. Using `projectRoot` because it's the simplest top-
    // level string field on ProjectManifest.
    const oldScan = {
      manifest: { schemaVersion: 1, projectRoot: '/abs/before' },
      stats: {},
    } as never;
    const newScan = {
      manifest: { schemaVersion: 1, projectRoot: '/abs/after' },
      stats: {},
    } as never;
    useProjectStore.setState({
      load: { kind: 'loaded', data: sampleResponse },
      scan: { kind: 'loaded', data: oldScan },
    });

    let resolveResponse!: (r: Response) => void;
    const pendingResponse = new Promise<Response>((res) => (resolveResponse = res));
    vi.stubGlobal('fetch', vi.fn(() => pendingResponse));

    const promise = useProjectStore.getState().scanCurrentProject();
    // While the rescan is in flight, scan.kind MUST stay 'loaded' so
    // consumers don't unmount. The data MUST be the previous snapshot
    // (so the UI keeps rendering meaningfully). revalidating signals
    // the pending refresh.
    const midflight = useProjectStore.getState().scan;
    expect(midflight.kind).toBe('loaded');
    if (midflight.kind === 'loaded') {
      expect(midflight.data.manifest.projectRoot).toBe('/abs/before');
      expect(midflight.revalidating).toBe(true);
    }

    resolveResponse(
      new Response(JSON.stringify(newScan), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    await promise;
    const after = useProjectStore.getState().scan;
    expect(after.kind).toBe('loaded');
    if (after.kind === 'loaded') {
      expect(after.data.manifest.projectRoot).toBe('/abs/after');
      // revalidating is false / undefined after the request completes.
      expect(after.revalidating).toBeFalsy();
    }
  });

  it('falls back to bare scanning when there is no prior data (initial scan)', async () => {
    useProjectStore.setState({
      load: { kind: 'loaded', data: sampleResponse },
      scan: { kind: 'idle' },
    });
    let resolveResponse!: (r: Response) => void;
    const pendingResponse = new Promise<Response>((res) => (resolveResponse = res));
    vi.stubGlobal('fetch', vi.fn(() => pendingResponse));

    const promise = useProjectStore.getState().scanCurrentProject();
    // No prior data → fall back to bare scanning (consumers will show
    // their initial loading skeleton; nothing to keep visible).
    expect(useProjectStore.getState().scan.kind).toBe('scanning');

    resolveResponse(
      new Response(JSON.stringify({ manifest: {}, stats: {} }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    await promise;
    expect(useProjectStore.getState().scan.kind).toBe('loaded');
  });

  it('does nothing when no project is loaded', async () => {
    useProjectStore.setState({ load: { kind: 'empty' }, scan: { kind: 'idle' } });
    await useProjectStore.getState().scanCurrentProject();
    expect(useProjectStore.getState().scan.kind).toBe('idle');
  });
});

describe('useAdvancedDrawerStore (Phase P.2)', () => {
  beforeEach(() => {
    // Reset to the implicit default each test so we don't leak persistence.
    useAdvancedDrawerStore.setState({ open: true });
    if (typeof window !== 'undefined') {
      try {
        window.localStorage.removeItem('rom-editor.advancedDrawerOpen');
      } catch {
        // ignore
      }
    }
  });

  it('defaults to OPEN (sidebar visible until World Atlas ships in Phase P.4)', () => {
    expect(useAdvancedDrawerStore.getState().open).toBe(true);
  });

  it('toggle flips open/closed', () => {
    useAdvancedDrawerStore.getState().toggle();
    expect(useAdvancedDrawerStore.getState().open).toBe(false);
    useAdvancedDrawerStore.getState().toggle();
    expect(useAdvancedDrawerStore.getState().open).toBe(true);
  });

  it('setOpen forces a specific value', () => {
    useAdvancedDrawerStore.getState().setOpen(false);
    expect(useAdvancedDrawerStore.getState().open).toBe(false);
    useAdvancedDrawerStore.getState().setOpen(true);
    expect(useAdvancedDrawerStore.getState().open).toBe(true);
  });
});
