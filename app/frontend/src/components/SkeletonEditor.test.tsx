/**
 * Phase 8I-3 - Smoke tests for SkeletonEditor.
 *
 * Stubs the project store so SkeletonEditor sees a synthetic
 * session, and stubs fetch so listing + body fetch + resolve +
 * validate all return scripted bodies.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';

import { SkeletonEditor } from './SkeletonEditor';
import { useProjectStore } from '../state';

const SKELETON_LIST = {
  sessionId: 'test-session',
  entries: [
    {
      slug: 'forest-1',
      name: 'Forest Test',
      version: '1.0',
      width: 24,
      height: 32,
      primaryTileset: 'pret-frlg-general',
      secondaryTileset: 'pret-frlg-viridian-forest',
      defaultBiome: 'biome.forest',
      regionCount: 2,
      poiCount: 3,
      pathCount: 1,
      templateCount: 0,
      constraintCount: 1,
    },
  ],
};

const SKELETON_BODY = {
  slug: 'forest-1',
  body: {
    version: '1.0',
    map: {
      name: 'Forest Test',
      size: { w: 24, h: 32 },
      primary_tileset: 'pret-frlg-general',
      secondary_tileset: 'pret-frlg-viridian-forest',
      default_biome: 'biome.forest',
    },
    regions: [],
    pois: [],
    paths: [],
    templates: [],
    constraints: [],
  },
};

const RESOLVE_RESPONSE = {
  available: true as const,
  primary_tileset_slug: 'pret-frlg-general',
  secondary_tileset_slug: 'pret-frlg-viridian-forest',
  width: 24,
  height: 32,
  grid: [],
  tag_grid: [],
  border_blocks: [
    [null, null],
    [null, null],
  ],
  pois: [],
  report: {
    seed: 7,
    width: 24,
    height: 32,
    assigned_cells: 760,
    unassigned_cells: 8,
    template_anchors_placed: 0,
    template_anchors_skipped: 0,
    rule_violations: 2,
    rules_consulted: 10,
    paths_solved: 1,
    paths_failed: 0,
    warnings: ['Some cells unassigned'],
  },
};

const VALIDATE_RESPONSE = {
  available: true as const,
  ok: true,
  summary: 'Traversal check passed: all POIs reachable.',
  width: 24,
  height: 32,
  issues: [],
  poi_reachability: [],
  walkable_summary: {
    walkable_cells: 760,
    component_count: 1,
    largest_component_size: 760,
    largest_component_share: 1.0,
  },
};

function setProjectLoaded(): void {
  useProjectStore.setState((prev) => ({
    ...prev,
    load: {
      kind: 'loaded',
      data: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        rootListing: { entries: [] } as any,
        session: { id: 'test-session', projectRoot: '/x', openedAtUtc: '' },
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
  }));
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  useProjectStore.setState((prev) => ({ ...prev, load: { kind: 'empty' } }));
});

describe('SkeletonEditor', () => {
  beforeEach(() => {
    setProjectLoaded();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url.includes('/api/projects/test-session/skeletons/forest-1')) {
          return new Response(JSON.stringify(SKELETON_BODY), { status: 200 });
        }
        if (url.includes('/api/projects/test-session/skeletons')) {
          return new Response(JSON.stringify(SKELETON_LIST), { status: 200 });
        }
        if (url.includes('/api/projects/test-session/resolved-maps')) {
          return new Response(
            JSON.stringify({ slug: 'forest-1', body: {} }),
            { status: 200 },
          );
        }
        if (url.includes('/api/tile-intel/generate/resolve')) {
          return new Response(JSON.stringify(RESOLVE_RESPONSE), {
            status: 200,
          });
        }
        if (url.includes('/api/tile-intel/generate/validate-traversal')) {
          return new Response(JSON.stringify(VALIDATE_RESPONSE), {
            status: 200,
          });
        }
        return new Response(JSON.stringify({ detail: 'unhandled' }), {
          status: 404,
        });
      }),
    );
  });

  it('shows a prompt to open a project when no session is loaded', () => {
    useProjectStore.setState((prev) => ({ ...prev, load: { kind: 'empty' } }));
    render(<SkeletonEditor />);
    expect(
      screen.getByText(/Open a project to author/i),
    ).toBeInTheDocument();
  });

  it('lists skeletons in the left pane after the project is loaded', async () => {
    render(<SkeletonEditor />);
    await waitFor(() => {
      expect(screen.getByText('Forest Test')).toBeInTheDocument();
    });
    expect(screen.getByText('24 × 32')).toBeInTheDocument();
  });

  it('clicking a skeleton loads its detail view', async () => {
    render(<SkeletonEditor />);
    await waitFor(() => {
      expect(screen.getByText('Forest Test')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText('Forest Test'));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Resolve' })).toBeInTheDocument();
    });
  });

  it('Resolve button posts to the proxy and renders the report', async () => {
    render(<SkeletonEditor />);
    await waitFor(() => {
      expect(screen.getByText('Forest Test')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText('Forest Test'));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Resolve' })).not.toBeDisabled(),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Resolve' }));
    await waitFor(() => {
      expect(screen.getByText(/Resolve report/)).toBeInTheDocument();
    });
    expect(screen.getByText(/760 \/ 768 cells assigned/)).toBeInTheDocument();
    // Adjacency-rule respect: (10-2)/10 = 80%.
    expect(screen.getByText(/Adjacency rule respect: 80%/)).toBeInTheDocument();
  });

  it('Validate traversal button shows the traversal summary', async () => {
    render(<SkeletonEditor />);
    await waitFor(() => {
      expect(screen.getByText('Forest Test')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText('Forest Test'));
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Validate traversal' }),
      ).toBeInTheDocument(),
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'Validate traversal' }),
    );
    await waitFor(() => {
      expect(
        screen.getByText(/Traversal check: ✅ passed/),
      ).toBeInTheDocument();
    });
    expect(
      screen.getByText(/Traversal check passed: all POIs reachable/),
    ).toBeInTheDocument();
  });
});
