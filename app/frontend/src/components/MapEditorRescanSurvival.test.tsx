/**
 * End-to-end test for the 2026-05-26 rescan-unmount bug.
 *
 * Repro: user opens a map → opens an NPC → opens the visual scripter
 * → clicks + Add step. The handleAddStep code path awaits
 * scanCurrentProject() so the new step appears. Before the fix:
 * scanCurrentProject set scan:{kind:'scanning'}, which threw away
 * the prior scan data. Every consumer GATED on `scan.kind === 'loaded'`
 * (MainPanel routing, MapsViewWired, the rest of the *Wired views)
 * fell through to their "loading" placeholder for the duration of
 * the rescan. The placeholder UNMOUNTED the real editor subtree.
 * When the rescan completed, the editor remounted FRESH, losing:
 * which inspector was open, scroll position, draft text in inline
 * editors, the visual scripter selection.
 *
 * The fix is stale-while-revalidate at the scan slice - keep the
 * prior data visible during rescans (set a `revalidating: true` flag)
 * so consumers don't fall through their guard and unmount.
 *
 * Why the original VisualScriptEditor.test didn't catch this: that
 * test mocked editBinaryRomScriptStep + the test renders the
 * VisualScriptEditor directly with a manifest prop, bypassing the
 * gated parent that does the unmount. This test exercises the
 * actual `scan.kind === 'loaded' ? <real> : <placeholder>` gate
 * pattern the editor uses everywhere, and proves a child component's
 * useState survives the rescan.
 */

import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, act } from '@testing-library/react';
import type { ProjectOpenResponse, ScanResponse } from '@rom-editor/shared';
import { emptyManifest } from '@rom-editor/shared';
import { useProjectStore } from '../state';

// Reproduces the gate pattern used across the codebase (MapsViewWired,
// SpeciesViewWired, EventsViewWired, etc.): when scan isn't loaded,
// show a placeholder; when loaded, show the real editor. Identical
// shape - that's what makes this test catch the regression.
function GatedEditor(): JSX.Element {
  const scan = useProjectStore((s) => s.scan);
  if (scan.kind !== 'loaded') {
    return <div data-testid="placeholder">Loading…</div>;
  }
  return (
    <div data-testid="real-editor">
      <ChildWithLocalState />
      <span data-testid="manifest-step-count">
        {String(scan.data.manifest.scriptSteps.length)}
      </span>
      {/* Surface revalidating so the UI CAN show a "syncing" pip
          without unmounting. */}
      <span data-testid="revalidating-flag">
        {scan.revalidating ? 'syncing' : 'fresh'}
      </span>
    </div>
  );
}

/** A counter so we can prove React state inside the gated subtree
 *  is preserved across a rescan. If the parent unmounted + remounted,
 *  the counter would reset to 0. */
function ChildWithLocalState(): JSX.Element {
  const [n, setN] = useState(0);
  return (
    <button data-testid="local-counter" onClick={() => setN((x) => x + 1)}>
      count={String(n)}
    </button>
  );
}

const fakeSession: ProjectOpenResponse = {
  session: {
    id: 'sess-1',
    projectRoot: '/abs/test',
    openedAtUtc: '2026-05-26T00:00:00Z',
  },
  rootListing: { path: '', entries: [] },
  identity: {
    kind: 'patch',
    confidence: 1,
    displayName: 'test',
    baseGame: 'pokefirered',
    fork: null,
    featureFlags: [],
    warnings: [],
    evidence: [],
  },
};

function fakeScan(stepCount: number): ScanResponse {
  const base = emptyManifest('/abs/test', '2026-05-26T00:00:00Z');
  return {
    manifest: {
      ...base,
      scriptSteps: Array.from({ length: stepCount }, (_, i) => ({
        id: `script_oak__${String(i)}`,
        kind: 'dialogue' as const,
        params: { dialogueText: `line ${String(i)}` },
      })),
    },
    stats: {
      maps: 0,
      warps: 0,
      triggers: 0,
      objectEvents: 0,
      dialogue: 0,
      flags: 0,
      variables: 0,
      encounterTables: 0,
      assets: 0,
      scriptSteps: stepCount,
    },
  } as unknown as ScanResponse;
}

describe('Stale-while-revalidate keeps gated editors mounted across a rescan', () => {
  beforeEach(() => {
    useProjectStore.setState({
      load: { kind: 'loaded', data: fakeSession },
      scan: { kind: 'loaded', data: fakeScan(3) },
    });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('the gated editor stays visible mid-rescan (placeholder never shown)', async () => {
    render(<GatedEditor />);
    expect(screen.getByTestId('real-editor')).toBeInTheDocument();
    expect(screen.queryByTestId('placeholder')).not.toBeInTheDocument();
    expect(screen.getByTestId('manifest-step-count').textContent).toBe('3');
    expect(screen.getByTestId('revalidating-flag').textContent).toBe('fresh');

    let resolveResponse!: (r: Response) => void;
    const pending = new Promise<Response>((res) => (resolveResponse = res));
    vi.stubGlobal('fetch', vi.fn(() => pending));

    // Start the rescan but don't resolve it yet - we want to inspect
    // the in-flight state.
    let scanPromise!: Promise<void>;
    await act(async () => {
      scanPromise = useProjectStore.getState().scanCurrentProject();
    });

    // Critical assertion: the placeholder MUST NOT appear. The
    // pre-fix behavior set scan.kind='scanning' which made the gate
    // fall through and the placeholder render. Post-fix, scan.kind
    // stays 'loaded' (with revalidating:true), the gate stays true,
    // the real-editor element keeps rendering with the prior data.
    expect(screen.queryByTestId('placeholder')).not.toBeInTheDocument();
    expect(screen.getByTestId('real-editor')).toBeInTheDocument();
    expect(screen.getByTestId('manifest-step-count').textContent).toBe('3');
    expect(screen.getByTestId('revalidating-flag').textContent).toBe('syncing');

    // Resolve the rescan with an updated manifest (a 4th step was added).
    resolveResponse(
      new Response(JSON.stringify(fakeScan(4)), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    await act(async () => {
      await scanPromise;
    });

    // After the rescan completes, the manifest prop updates → the
    // step count goes from 3 to 4 → the editor re-renders WITHOUT
    // unmounting. revalidating flips back to false ("fresh").
    expect(screen.getByTestId('real-editor')).toBeInTheDocument();
    expect(screen.getByTestId('manifest-step-count').textContent).toBe('4');
    expect(screen.getByTestId('revalidating-flag').textContent).toBe('fresh');
  });

  it('local React state inside the gated subtree survives the rescan', async () => {
    render(<GatedEditor />);
    // User has interacted - click the counter 3 times. This is a
    // stand-in for "user typed something in a dialogue draft field,
    // selected a card, scrolled the list, etc."
    const counter = screen.getByTestId('local-counter');
    fireEvent.click(counter);
    fireEvent.click(counter);
    fireEvent.click(counter);
    expect(screen.getByTestId('local-counter').textContent).toBe('count=3');

    let resolveResponse!: (r: Response) => void;
    const pending = new Promise<Response>((res) => (resolveResponse = res));
    vi.stubGlobal('fetch', vi.fn(() => pending));

    let scanPromise!: Promise<void>;
    await act(async () => {
      scanPromise = useProjectStore.getState().scanCurrentProject();
    });

    // Mid-rescan: counter still says 3. Pre-fix, the GatedEditor
    // unmounted on the 'scanning' transition, taking ChildWithLocalState
    // with it; when the rescan completed the child remounted fresh
    // with count=0.
    expect(screen.getByTestId('local-counter').textContent).toBe('count=3');

    resolveResponse(
      new Response(JSON.stringify(fakeScan(4)), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    await act(async () => {
      await scanPromise;
    });

    // After rescan: counter STILL says 3. The user's local edits
    // (draft text, scroll position, selection) survive.
    expect(screen.getByTestId('local-counter').textContent).toBe('count=3');
  });
});
