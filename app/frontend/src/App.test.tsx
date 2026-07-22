import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App } from './App';
import { useAdvancedDrawerStore, useProjectStore, useViewStore } from './state';
import type { ProjectOpenResponse } from '@rom-editor/shared';

const healthBody = {
  status: 'ok',
  service: 'rom-editor-backend',
  version: '0.0.0',
  uptimeSeconds: 0.1,
};

const decompResponse: ProjectOpenResponse = {
  session: {
    id: 'sess-abc',
    projectRoot: '/abs/path/pokeemerald',
    openedAtUtc: '2026-05-16T07:00:00Z',
  },
  rootListing: {
    path: '',
    entries: [
      { name: 'data', kind: 'directory', relativePath: 'data', sizeBytes: null },
      { name: 'include', kind: 'directory', relativePath: 'include', sizeBytes: null },
      { name: 'src', kind: 'directory', relativePath: 'src', sizeBytes: null },
      { name: 'Makefile', kind: 'file', relativePath: 'Makefile', sizeBytes: 1234 },
      { name: 'pokeemerald.ld', kind: 'file', relativePath: 'pokeemerald.ld', sizeBytes: 500 },
    ],
  },
  identity: {
    kind: 'decomp',
    confidence: 1,
    displayName: 'pokeemerald (decomp)',
    baseGame: 'pokeemerald',
    fork: null,
    featureFlags: [],
    warnings: [],
    evidence: ['Makefile', 'include/', 'src/', 'data/', 'pokeemerald.ld'],
  },
};

const scanResponseFixture = {
  sessionId: 'sess-abc',
  manifestPath: '/abs/path/pokeemerald/.editor/manifest.json',
  scannerName: 'DecompScanner',
  scanDurationMs: 5,
  warnings: [],
  manifest: {
    schemaVersion: 1 as const,
    generatedAtUtc: '2026-05-16T07:00:00Z',
    projectRoot: '/abs/path/pokeemerald',
    identity: decompResponse.identity,
    buildProfile: {
      toolchain: 'agbcc+make',
      buildCommand: 'make',
      outputPaths: ['pokeemerald.gba', 'pokeemerald.elf'],
      testCommand: null,
    },
    maps: [
      {
        id: 'MAP_LITTLEROOT_TOWN',
        name: 'LITTLEROOT_TOWN',
        group: 'town' as const,
        dimensions: { width: 0, height: 0 },
        tilesetIds: [],
        warpIds: [],
        scriptIds: [],
        objectEventIds: [],
        encounterTableIds: [],
        musicId: null,
        metadata: {},
      },
    ],
    warps: [],
    triggers: [],
    objectEvents: [],
    dialogue: [],
    flags: [],
    variables: [],
    encounterTables: [],
    trainers: [],
    scriptSteps: [],
    assets: [],
  },
};

function installFetchMock(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/api/health')) {
        return new Response(JSON.stringify(healthBody), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.endsWith('/api/projects/open') && init?.method === 'POST') {
        const body = JSON.parse(String(init.body));
        if (body.projectRoot === '/abs/path/pokeemerald') {
          return new Response(JSON.stringify(decompResponse), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        if (body.projectRoot === '/abs/missing') {
          return new Response(
            JSON.stringify({
              error: { code: 'project_root_not_found', message: 'no such directory' },
            }),
            { status: 404, headers: { 'content-type': 'application/json' } },
          );
        }
      }
      if (url.match(/\/api\/projects\/[^/]+\/scan$/) && init?.method === 'POST') {
        return new Response(JSON.stringify(scanResponseFixture), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('not found', { status: 404 });
    }),
  );
}

describe('App', () => {
  beforeEach(() => {
    installFetchMock();
    // Reset stores between tests
    useProjectStore.setState({ load: { kind: 'empty' } });
    useViewStore.setState({ activeView: 'project' });
    // The Real Game Editor Push routes ROM-loaded transitions to the
    // world atlas. The existing tests exercise Project-view UI in
    // isolation, so they opt out of that auto-route here. The dedicated
    // route-on-load test below clears the flag to verify the behavior.
    (globalThis as { __SUPPRESS_ATLAS_AUTO_ROUTE__?: boolean })
      .__SUPPRESS_ATLAS_AUTO_ROUTE__ = true;
    // Also: the Advanced drawer is closed by default in production now,
    // but the legacy Project-view-focused tests reach the Sidebar tabs
    // (sidebar-nav-*) which only render when the drawer is open. Force
    // it open here so those tests still target a visible Sidebar.
    useAdvancedDrawerStore.setState({ open: true });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    (globalThis as { __SUPPRESS_ATLAS_AUTO_ROUTE__?: boolean })
      .__SUPPRESS_ATLAS_AUTO_ROUTE__ = false;
  });

  it('renders the editor shell title and shows the Project view by default', () => {
    render(<App />);
    expect(screen.getByText(/Pokémon GBA Decomp\/Patch World Editor/i)).toBeInTheDocument();
    expect(screen.getByText(/Open a project/i)).toBeInTheDocument();
    expect(screen.getByTestId('project-root-input')).toBeInTheDocument();
  });

  it('shows backend connection status once the health check resolves', async () => {
    render(<App />);
    await waitFor(() => {
      // Connected state surfaces the service name + version in the backend cell
      // (with a green status dot adjacent). The full "connected" phrase lives
      // in the cell's title attribute for hover; the visible text is concise.
      expect(screen.getByTestId('backend-status').textContent ?? '').toMatch(
        /rom-editor-backend v0\.0\.0/i,
      );
    });
  });

  it('switches main panel view when sidebar nav items are clicked', () => {
    render(<App />);
    expect(screen.getByTestId('main-panel-project')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('sidebar-nav-maps'));
    expect(screen.getByTestId('main-panel-maps')).toBeInTheDocument();
    expect(screen.getByText(/Maps detected in the project/i)).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('sidebar-nav-events'));
    expect(screen.getByTestId('main-panel-events')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('sidebar-nav-assets'));
    expect(screen.getByTestId('main-panel-assets')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('sidebar-nav-build'));
    expect(screen.getByTestId('main-panel-build')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('sidebar-nav-project'));
    expect(screen.getByTestId('main-panel-project')).toBeInTheDocument();
  });

  it('opens a real project on submit and displays the detected identity', async () => {
    render(<App />);
    const input = screen.getByTestId('project-root-input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '/abs/path/pokeemerald' } });
    fireEvent.click(screen.getByTestId('open-project-button'));

    await waitFor(() => {
      expect(screen.getByTestId('identity-card')).toBeInTheDocument();
    });
    expect(screen.getByTestId('identity-display-name')).toHaveTextContent('pokeemerald (decomp)');
    expect(screen.getByText(/confidence 100%/i)).toBeInTheDocument();
    expect(screen.getByTestId('identity-evidence')).toBeInTheDocument();
    // After open (pre-scan), Project view offers a Scan button and reports the
    // raw root entry count rather than indexed manifest counts.
    expect(screen.getByTestId('scan-project-button')).toBeInTheDocument();
    expect(screen.getByText(/5 root entries/i)).toBeInTheDocument();
  });

  it('shows a user-visible error when the backend rejects the path', async () => {
    render(<App />);
    fireEvent.change(screen.getByTestId('project-root-input'), {
      target: { value: '/abs/missing' },
    });
    fireEvent.click(screen.getByTestId('open-project-button'));

    await waitFor(() => {
      expect(screen.getByTestId('open-error')).toBeInTheDocument();
    });
    expect(screen.getByTestId('open-error').textContent ?? '').toMatch(/no such directory/i);
    expect(screen.getByTestId('open-error').textContent ?? '').toMatch(/project_root_not_found/);
  });

  it('updates the Project sidebar count after a successful open', async () => {
    render(<App />);
    // Before open: all counts are ' - '
    const sidebarCounts = screen
      .getAllByRole('tab')
      .map((b) => b.textContent ?? '');
    expect(sidebarCounts.every((t) => t.includes(' - '))).toBe(true);

    fireEvent.change(screen.getByTestId('project-root-input'), {
      target: { value: '/abs/path/pokeemerald' },
    });
    fireEvent.click(screen.getByTestId('open-project-button'));

    await waitFor(() => {
      expect(screen.getByTestId('identity-card')).toBeInTheDocument();
    });

    const projectBtn = screen.getByTestId('sidebar-nav-project');
    // Root listing has 5 entries → count for Project tab is "5"
    expect(projectBtn.textContent ?? '').toMatch(/5/);
  });

  it('scans the project and the Maps view renders the region atlas', async () => {
    render(<App />);
    fireEvent.change(screen.getByTestId('project-root-input'), {
      target: { value: '/abs/path/pokeemerald' },
    });
    fireEvent.click(screen.getByTestId('open-project-button'));
    await waitFor(() => {
      expect(screen.getByTestId('identity-card')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId('scan-project-button'));
    await waitFor(() => {
      expect(screen.getByTestId('scan-summary')).toBeInTheDocument();
    });
    // Sidebar count for Maps should now show 1
    const mapsBtn = screen.getByTestId('sidebar-nav-maps');
    expect(mapsBtn.textContent ?? '').toMatch(/1/);
    // Switch to Maps view → RegionAtlas (PixiJS) mounts in place of
    // the old ReactFlow MapsGraph. The maps-browser categorical list
    // stays alongside as the bulk-list affordance.
    fireEvent.click(mapsBtn);
    await waitFor(() => {
      expect(screen.getByTestId('region-atlas')).toBeInTheDocument();
    });
    expect(screen.getByTestId('maps-browser')).toBeInTheDocument();
  });

  it('opens the MapEditor when a map is opened via the maps view', async () => {
    render(<App />);
    fireEvent.change(screen.getByTestId('project-root-input'), {
      target: { value: '/abs/path/pokeemerald' },
    });
    fireEvent.click(screen.getByTestId('open-project-button'));
    await waitFor(() => expect(screen.getByTestId('identity-card')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('scan-project-button'));
    await waitFor(() => expect(screen.getByTestId('scan-summary')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('sidebar-nav-maps'));
    await waitFor(() => expect(screen.getByTestId('region-atlas')).toBeInTheDocument());
    // Opening a map directly via the view store mirrors what the
    // RegionAtlas does on double-click and what the MapsBrowser
    // "Edit this map" button does on click. The MapEditor mount is
    // the business logic; the UI affordances that trigger it have
    // their own component tests.
    useViewStore.getState().openMapInEditor('MAP_LITTLEROOT_TOWN');
    await waitFor(() => expect(screen.getByTestId('map-editor')).toBeInTheDocument());
    expect(screen.getByTestId('map-editor-name').textContent).toBe('LITTLEROOT_TOWN');
    // Back to the world view via the MapEditor back button → returns
    // to the RegionAtlas (not the old ReactFlow graph).
    fireEvent.click(screen.getByTestId('map-editor-back'));
    await waitFor(() => expect(screen.getByTestId('region-atlas')).toBeInTheDocument());
  });

  it('closes the project and returns to the open form', async () => {
    render(<App />);
    fireEvent.change(screen.getByTestId('project-root-input'), {
      target: { value: '/abs/path/pokeemerald' },
    });
    fireEvent.click(screen.getByTestId('open-project-button'));
    await waitFor(() => {
      expect(screen.getByTestId('identity-card')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText(/Close project/i));
    expect(screen.queryByTestId('identity-card')).not.toBeInTheDocument();
    expect(screen.getByTestId('project-root-input')).toBeInTheDocument();
  });

  it('renders Browse folder + Browse ROM/ZIP buttons alongside the typed input', () => {
    render(<App />);
    expect(screen.getByTestId('browse-folder-button')).toBeInTheDocument();
    expect(screen.getByTestId('browse-rom-button')).toBeInTheDocument();
    expect(screen.getByTestId('project-root-input')).toBeInTheDocument();
  });

  it('renders the Detected Subsystems section when identity.detectedSubsystems is populated (UW-2-T6)', async () => {
    const subsystemResponse = {
      ...decompResponse,
      identity: {
        ...decompResponse.identity,
        kind: 'patch' as const,
        displayName: 'Bare ROM workspace',
        detectedSubsystems: [
          {
            id: 'moves_system',
            name: 'Moves System (Gen-3 gBattleMoves scanner)',
            phase: 8,
            status: 'detected' as const,
            confidence: 0.95,
            runtimeMs: 142,
            summary: 'Found gBattleMoves at offset 0x250000 (355 moves, 4260 bytes)',
            sampleNames: [
              'POUND',
              'KARATE CHOP',
              'DOUBLE SLAP',
              'COMET PUNCH',
              'MEGA PUNCH',
              'PAY DAY',
              'FIRE PUNCH',
              'ICE PUNCH',
            ],
          },
          {
            id: 'type_chart_system',
            name: 'Type Chart System (Gen-3 gTypeEffectiveness scanner)',
            phase: 8,
            status: 'detected' as const,
            confidence: 0.95,
            runtimeMs: 87,
            summary: 'Found gTypeEffectiveness at offset 0x1fa400 (107 matchups + foresight separator, 327 bytes total)',
          },
          {
            id: 'items_system',
            name: 'Items System (Gen-3 gItems scanner)',
            phase: 8,
            status: 'not_detected' as const,
            confidence: 0.85,
            runtimeMs: 412,
            summary: null,
          },
        ],
      },
    };
    vi.unstubAllGlobals();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url.endsWith('/api/health')) {
          return new Response(JSON.stringify(healthBody), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        if (url.endsWith('/api/projects/open') && init?.method === 'POST') {
          return new Response(JSON.stringify(subsystemResponse), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        return new Response('not found', { status: 404 });
      }),
    );
    render(<App />);
    fireEvent.change(screen.getByTestId('project-root-input'), {
      target: { value: '/abs/path/with-rom' },
    });
    fireEvent.click(screen.getByTestId('open-project-button'));
    await waitFor(() => {
      expect(screen.getByTestId('identity-detected-subsystems')).toBeInTheDocument();
    });
    // Header shows "(N of M detected)".
    expect(screen.getByTestId('identity-detected-subsystems').textContent ?? '').toMatch(
      /2 of 3 detected/i,
    );
    // Each subsystem has a tile with friendly label + confidence.
    expect(screen.getByTestId('detected-subsystem-moves_system')).toBeInTheDocument();
    expect(screen.getByTestId('detected-subsystem-type_chart_system')).toBeInTheDocument();
    expect(screen.getByTestId('detected-subsystem-items_system')).toBeInTheDocument();
    // The detected entries have engine evidence summary; the not_detected
    // one explains what's missing instead of going silent (PD 12).
    expect(
      screen.getByTestId('detected-subsystem-moves_system-summary').textContent ?? '',
    ).toMatch(/Found gBattleMoves/);
    expect(
      screen.getByTestId('detected-subsystem-type_chart_system-summary').textContent ?? '',
    ).toMatch(/Found gTypeEffectiveness/);
    // Items: not_detected - no summary text but the missing-fallback line
    // is rendered (PD 12).
    expect(
      screen.queryByTestId('detected-subsystem-items_system-summary'),
    ).not.toBeInTheDocument();
    expect(
      screen.getByTestId('detected-subsystem-items_system').textContent ?? '',
    ).toMatch(/Engine returned not_detected/i);
    expect(
      screen.getByTestId('detected-subsystem-items_system').textContent ?? '',
    ).toMatch(/items table/i);
    // UW-2-T9 iter 75: sampleNames render below the summary as a chip
    // list with "+N more" suffix.
    expect(
      screen.getByTestId('detected-subsystem-moves_system-sample-names'),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId('detected-subsystem-moves_system-sample-names').textContent ?? '',
    ).toMatch(/POUND/);
    expect(
      screen.getByTestId('detected-subsystem-moves_system-sample-names').textContent ?? '',
    ).toMatch(/KARATE CHOP/);
    expect(
      screen.getByTestId('detected-subsystem-moves_system-sample-names').textContent ?? '',
    ).toMatch(/\+2 more/);
    // Subsystems without sampleNames (type_chart_system, items_system)
    // do NOT render the chip list.
    expect(
      screen.queryByTestId('detected-subsystem-type_chart_system-sample-names'),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId('detected-subsystem-items_system-sample-names'),
    ).not.toBeInTheDocument();
    // UW-3-T4 iter 85: View all toggle button is present when more than
    // 6 names exist (fixture has 8 → button reads "View all (8)").
    const toggleBtn = screen.getByTestId(
      'detected-subsystem-moves_system-sample-names-toggle',
    );
    expect(toggleBtn).toBeInTheDocument();
    expect(toggleBtn.textContent ?? '').toMatch(/View all \(8\)/);
    expect(toggleBtn.getAttribute('aria-expanded')).toBe('false');
    // Collapsed state: ICE PUNCH (8th name) is NOT visible.
    expect(
      screen.getByTestId('detected-subsystem-moves_system-sample-names').textContent ?? '',
    ).not.toMatch(/ICE PUNCH/);
    // Click → expanded.
    fireEvent.click(toggleBtn);
    expect(toggleBtn.getAttribute('aria-expanded')).toBe('true');
    expect(toggleBtn.textContent ?? '').toMatch(/Show less/);
    // Now ICE PUNCH IS visible.
    expect(
      screen.getByTestId('detected-subsystem-moves_system-sample-names').textContent ?? '',
    ).toMatch(/ICE PUNCH/);
    // No "+N more" suffix when expanded.
    expect(
      screen.getByTestId('detected-subsystem-moves_system-sample-names').textContent ?? '',
    ).not.toMatch(/\+2 more/);
    // Click again → collapsed.
    fireEvent.click(toggleBtn);
    expect(toggleBtn.getAttribute('aria-expanded')).toBe('false');
  });

  it('renders the Unknowns Policy section when identity.coverageSummary is populated (UW-2-T14)', async () => {
    const coverageResponse = {
      ...decompResponse,
      identity: {
        ...decompResponse.identity,
        kind: 'patch' as const,
        displayName: 'Bare ROM workspace',
        coverageSummary: {
          romSize: 16 * 1024 * 1024,
          classifiedBytes: 4 * 1024 * 1024,
          unknownScoredBytes: 256 * 1024,
          unaccountedBytes: 16 * 1024 * 1024 - 4 * 1024 * 1024 - 256 * 1024,
          classifiedPct: 25.0,
          unknownScoredPct: 1.5625,
          unaccountedPct: 73.4375,
          regionCount: 1234,
          topScoredUnknownRegions: [
            {
              start: 0x100000,
              end: 0x110000,
              sizeBytes: 0x10000,
              score: 0.4,
              provenance: 'pointer_network#cluster',
              note: 'pointer cluster target',
            },
            {
              start: 0x200000,
              end: 0x208000,
              sizeBytes: 0x8000,
              score: 0.6,
              provenance: 'compression_format#lz77_probable',
            },
          ],
        },
      },
    };
    vi.unstubAllGlobals();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url.endsWith('/api/health')) {
          return new Response(JSON.stringify(healthBody), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        if (url.endsWith('/api/projects/open') && init?.method === 'POST') {
          return new Response(JSON.stringify(coverageResponse), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        return new Response('not found', { status: 404 });
      }),
    );
    render(<App />);
    fireEvent.change(screen.getByTestId('project-root-input'), {
      target: { value: '/abs/path/with-rom' },
    });
    fireEvent.click(screen.getByTestId('open-project-button'));
    await waitFor(() => {
      expect(screen.getByTestId('identity-unknowns-policy')).toBeInTheDocument();
    });
    // Summary shows percentage breakdown.
    expect(
      screen.getByTestId('identity-unknowns-policy').textContent ?? '',
    ).toMatch(/classified 25\.00%/);
    expect(
      screen.getByTestId('identity-unknowns-policy').textContent ?? '',
    ).toMatch(/unknown 1\.56%/);
    expect(
      screen.getByTestId('identity-unknowns-policy').textContent ?? '',
    ).toMatch(/unaccounted 73\.44%/);
    // Totals rows are present.
    expect(screen.getByTestId('unknowns-policy-totals')).toBeInTheDocument();
    // Top scored-unknown regions list is present + each tile renders.
    expect(screen.getByTestId('unknowns-policy-regions')).toBeInTheDocument();
    expect(screen.getByTestId('unknown-region-1048576')).toBeInTheDocument(); // 0x100000
    expect(screen.getByTestId('unknown-region-2097152')).toBeInTheDocument(); // 0x200000
    expect(
      screen.getByTestId('unknown-region-1048576').textContent ?? '',
    ).toMatch(/pointer_network#cluster/);
    expect(
      screen.getByTestId('unknown-region-1048576').textContent ?? '',
    ).toMatch(/pointer cluster target/);
  });

  it('UW-3-T5: renders contextual "Run full project scan" button inside UnknownsPolicySection with idle disclaimer', async () => {
    const coverageResponse = {
      ...decompResponse,
      identity: {
        ...decompResponse.identity,
        kind: 'patch' as const,
        displayName: 'Bare ROM workspace',
        coverageSummary: {
          romSize: 16 * 1024 * 1024,
          classifiedBytes: 4 * 1024 * 1024,
          unknownScoredBytes: 0,
          unaccountedBytes: 12 * 1024 * 1024,
          classifiedPct: 25.0,
          unknownScoredPct: 0,
          unaccountedPct: 75.0,
          regionCount: 100,
          topScoredUnknownRegions: [],
        },
      },
    };
    vi.unstubAllGlobals();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url.endsWith('/api/health')) {
          return new Response(JSON.stringify(healthBody), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        if (url.endsWith('/api/projects/open') && init?.method === 'POST') {
          return new Response(JSON.stringify(coverageResponse), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        return new Response('not found', { status: 404 });
      }),
    );
    render(<App />);
    fireEvent.change(screen.getByTestId('project-root-input'), {
      target: { value: '/abs/path/with-rom' },
    });
    fireEvent.click(screen.getByTestId('open-project-button'));
    await waitFor(() => {
      expect(screen.getByTestId('identity-unknowns-policy')).toBeInTheDocument();
    });
    // Button is present + clickable + carries the idle label.
    const btn = screen.getByTestId('unknowns-policy-scan-button') as HTMLButtonElement;
    expect(btn).toBeInTheDocument();
    expect(btn.disabled).toBe(false);
    expect(btn.textContent ?? '').toMatch(/^Run full project scan$/);
    // Disclaimer surfaces the lightweight-vs-full distinction.
    const disc = screen.getByTestId('unknowns-policy-disclaimer');
    expect(disc.textContent ?? '').toMatch(/lightweight project-open scan/);
    expect(disc.textContent ?? '').toMatch(/full scan above surfaces additional classified regions/);
    // Pre-scan: no scanner-name / manifest-path tags rendered.
    expect(screen.queryByTestId('unknowns-policy-scanner-name')).not.toBeInTheDocument();
    expect(screen.queryByTestId('unknowns-policy-manifest-path')).not.toBeInTheDocument();
  });

  it('UW-3-T5: clicking the contextual scan button calls /scan and the disclaimer updates with scanner + manifest', async () => {
    const coverageResponse = {
      ...decompResponse,
      identity: {
        ...decompResponse.identity,
        kind: 'patch' as const,
        displayName: 'Bare ROM workspace',
        coverageSummary: {
          romSize: 16 * 1024 * 1024,
          classifiedBytes: 4 * 1024 * 1024,
          unknownScoredBytes: 0,
          unaccountedBytes: 12 * 1024 * 1024,
          classifiedPct: 25.0,
          unknownScoredPct: 0,
          unaccountedPct: 75.0,
          regionCount: 100,
          topScoredUnknownRegions: [],
        },
      },
    };
    const scanCallTracker = { calls: 0 };
    vi.unstubAllGlobals();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url.endsWith('/api/health')) {
          return new Response(JSON.stringify(healthBody), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        if (url.endsWith('/api/projects/open') && init?.method === 'POST') {
          return new Response(JSON.stringify(coverageResponse), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        if (url.match(/\/api\/projects\/[^/]+\/scan$/) && init?.method === 'POST') {
          scanCallTracker.calls++;
          return new Response(JSON.stringify(scanResponseFixture), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        return new Response('not found', { status: 404 });
      }),
    );
    render(<App />);
    fireEvent.change(screen.getByTestId('project-root-input'), {
      target: { value: '/abs/path/with-rom' },
    });
    fireEvent.click(screen.getByTestId('open-project-button'));
    await waitFor(() => {
      expect(screen.getByTestId('unknowns-policy-scan-button')).toBeInTheDocument();
    });
    expect(scanCallTracker.calls).toBe(0);
    fireEvent.click(screen.getByTestId('unknowns-policy-scan-button'));
    // Scan resolves → disclaimer + button update.
    await waitFor(() => {
      expect(screen.getByTestId('unknowns-policy-disclaimer').textContent ?? '').toMatch(
        /Full project scan complete/,
      );
    });
    expect(scanCallTracker.calls).toBe(1);
    expect(screen.getByTestId('unknowns-policy-scanner-name').textContent ?? '').toMatch(
      /DecompScanner/,
    );
    expect(screen.getByTestId('unknowns-policy-manifest-path').textContent ?? '').toMatch(
      /manifest\.json/,
    );
    expect(screen.getByTestId('unknowns-policy-scan-button').textContent ?? '').toMatch(
      /Re-run full project scan/,
    );
  });

  it('UW-3-T5: scan failure surfaces inline as an alert in the UnknownsPolicySection disclaimer', async () => {
    const coverageResponse = {
      ...decompResponse,
      identity: {
        ...decompResponse.identity,
        kind: 'patch' as const,
        displayName: 'Bare ROM workspace',
        coverageSummary: {
          romSize: 16 * 1024 * 1024,
          classifiedBytes: 4 * 1024 * 1024,
          unknownScoredBytes: 0,
          unaccountedBytes: 12 * 1024 * 1024,
          classifiedPct: 25.0,
          unknownScoredPct: 0,
          unaccountedPct: 75.0,
          regionCount: 100,
          topScoredUnknownRegions: [],
        },
      },
    };
    vi.unstubAllGlobals();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url.endsWith('/api/health')) {
          return new Response(JSON.stringify(healthBody), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        if (url.endsWith('/api/projects/open') && init?.method === 'POST') {
          return new Response(JSON.stringify(coverageResponse), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        if (url.match(/\/api\/projects\/[^/]+\/scan$/) && init?.method === 'POST') {
          return new Response(
            JSON.stringify({ error: { code: 'internal_error', message: 'detector explosion' } }),
            { status: 500, headers: { 'content-type': 'application/json' } },
          );
        }
        return new Response('not found', { status: 404 });
      }),
    );
    render(<App />);
    fireEvent.change(screen.getByTestId('project-root-input'), {
      target: { value: '/abs/path/with-rom' },
    });
    fireEvent.click(screen.getByTestId('open-project-button'));
    await waitFor(() => {
      expect(screen.getByTestId('unknowns-policy-scan-button')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId('unknowns-policy-scan-button'));
    await waitFor(() => {
      expect(screen.getByTestId('unknowns-policy-disclaimer').textContent ?? '').toMatch(
        /Scan failed/,
      );
    });
    expect(screen.getByTestId('unknowns-policy-disclaimer').textContent ?? '').toMatch(
      /detector explosion/,
    );
    expect(screen.getByTestId('unknowns-policy-disclaimer').textContent ?? '').toMatch(
      /internal_error/,
    );
  });

  it('does NOT render the Unknowns Policy section when identity.coverageSummary is absent (decomp projects)', async () => {
    render(<App />);
    fireEvent.change(screen.getByTestId('project-root-input'), {
      target: { value: '/abs/path/pokeemerald' },
    });
    fireEvent.click(screen.getByTestId('open-project-button'));
    await waitFor(() => {
      expect(screen.getByTestId('identity-card')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('identity-unknowns-policy')).not.toBeInTheDocument();
  });

  it('does NOT render the Detected Subsystems section when identity.detectedSubsystems is absent (decomp projects)', async () => {
    render(<App />);
    fireEvent.change(screen.getByTestId('project-root-input'), {
      target: { value: '/abs/path/pokeemerald' },
    });
    fireEvent.click(screen.getByTestId('open-project-button'));
    await waitFor(() => {
      expect(screen.getByTestId('identity-card')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('identity-detected-subsystems')).not.toBeInTheDocument();
  });

  it('Browse ROM/ZIP → picker returns a path → opens via open-from-file → IdentityCard renders', async () => {
    const intakeResponse = {
      ...decompResponse,
      session: { ...decompResponse.session, projectRoot: 'C:\\AppData\\rom-editor\\projects\\abcd1234' },
      identity: {
        ...decompResponse.identity,
        kind: 'patch' as const,
        baseGame: 'Pokémon FireRed',
        displayName: 'Bare ROM workspace',
      },
      intake: { kind: 'rom' as const, originalPath: 'C:\\roms\\FireRed.gba', sha1: 'abcd1234' },
    };
    vi.unstubAllGlobals();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url.endsWith('/api/health')) {
          return new Response(JSON.stringify(healthBody), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        if (url.endsWith('/api/dialogs/pick') && init?.method === 'POST') {
          return new Response(
            JSON.stringify({ kind: 'rom-or-archive', path: 'C:\\roms\\FireRed.gba' }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        if (url.endsWith('/api/projects/open-from-file') && init?.method === 'POST') {
          return new Response(JSON.stringify(intakeResponse), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        return new Response('not found', { status: 404 });
      }),
    );
    render(<App />);
    fireEvent.click(screen.getByTestId('browse-rom-button'));
    await waitFor(() => {
      expect(screen.getByTestId('identity-card')).toBeInTheDocument();
    });
    expect(screen.getByTestId('identity-display-name')).toHaveTextContent('Bare ROM workspace');
  });

  it('cancelling the picker (path=null) leaves the form usable with no error', async () => {
    vi.unstubAllGlobals();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url.endsWith('/api/health')) {
          return new Response(JSON.stringify(healthBody), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        if (url.endsWith('/api/dialogs/pick')) {
          return new Response(JSON.stringify({ kind: 'rom-or-archive', path: null }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        return new Response('not found', { status: 404 });
      }),
    );
    render(<App />);
    fireEvent.click(screen.getByTestId('browse-rom-button'));
    // Give the picker promise a tick to resolve.
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByTestId('picker-error')).not.toBeInTheDocument();
    expect(screen.queryByTestId('identity-card')).not.toBeInTheDocument();
    // The typed input is still there + still usable.
    expect((screen.getByTestId('project-root-input') as HTMLInputElement).disabled).toBe(false);
  });

  it('routes to the World view after opening a project (atlas auto-route)', async () => {
    // The Real Game Editor Push - clear the suppress flag so the
    // useAtlasOnLoadRouting hook fires.
    (globalThis as { __SUPPRESS_ATLAS_AUTO_ROUTE__?: boolean })
      .__SUPPRESS_ATLAS_AUTO_ROUTE__ = false;
    render(<App />);
    fireEvent.change(screen.getByTestId('project-root-input'), {
      target: { value: '/abs/path/pokeemerald' },
    });
    fireEvent.click(screen.getByTestId('open-project-button'));
    await waitFor(() => {
      expect(useViewStore.getState().activeView).toBe('maps');
    });
    expect(screen.getByTestId('main-panel-maps')).toBeInTheDocument();
  });

  it('renders an Open ROM titlebar button that routes back to Project view', () => {
    render(<App />);
    const openRomBtn = screen.getByTestId('editor-shell-open-rom-btn');
    expect(openRomBtn).toBeInTheDocument();
    // Simulate being on the maps view; clicking the titlebar button
    // brings the user back to Project view for ROM-loader UI.
    useViewStore.setState({ activeView: 'maps' });
    fireEvent.click(openRomBtn);
    expect(useViewStore.getState().activeView).toBe('project');
  });

  it('Maps view empty state offers an inline Scan project button when project is loaded but unscanned', async () => {
    render(<App />);
    fireEvent.change(screen.getByTestId('project-root-input'), {
      target: { value: '/abs/path/pokeemerald' },
    });
    fireEvent.click(screen.getByTestId('open-project-button'));
    await waitFor(() => expect(useProjectStore.getState().load.kind).toBe('loaded'));
    // Navigate to Maps view (auto-route suppressed by beforeEach).
    useViewStore.setState({ activeView: 'maps' });
    await waitFor(() => {
      expect(screen.getByTestId('maps-empty-scan-button')).toBeInTheDocument();
    });
    // Click it → scan kicks off.
    fireEvent.click(screen.getByTestId('maps-empty-scan-button'));
    await waitFor(() => {
      expect(useProjectStore.getState().scan.kind).toBe('loaded');
    });
  });

  it('shows a picker-error alert when the backend returns platform_not_supported', async () => {
    vi.unstubAllGlobals();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url.endsWith('/api/health')) {
          return new Response(JSON.stringify(healthBody), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        if (url.endsWith('/api/dialogs/pick')) {
          return new Response(
            JSON.stringify({
              kind: 'folder',
              path: null,
              error: 'platform_not_supported',
              message: 'Native file picker is only wired up on Windows',
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        return new Response('not found', { status: 404 });
      }),
    );
    render(<App />);
    fireEvent.click(screen.getByTestId('browse-folder-button'));
    await waitFor(() => {
      expect(screen.getByTestId('picker-error')).toBeInTheDocument();
    });
    expect(screen.getByTestId('picker-error').textContent ?? '').toMatch(/only available on Windows/i);
  });
});
