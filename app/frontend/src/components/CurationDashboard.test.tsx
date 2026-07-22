/**
 * Phase 8J-2 - Smoke tests for CurationDashboard.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';

import { CurationDashboard } from './CurationDashboard';

const SUMMARY = {
  available: true as const,
  total: 5,
  good: 3,
  bad: 1,
  neutral: 1,
  by_kind: { metatile_placement: 4, template: 1 },
};

const OVERRIDES = {
  available: true as const,
  total: 5,
  overrides: [
    {
      id: 7,
      kind: 'metatile_placement',
      label: 'good',
      weight: 1.0,
      payload: { resolved_slug: 'forest', x: 4, y: 5 },
      note: 'looks right',
      created_at: '2026-05-28T00:00:00Z',
      scope: 'global',
      project_id: null,
    },
    {
      id: 6,
      kind: 'template',
      label: 'bad',
      weight: 1.0,
      payload: { template_slug: 'pattern-3x3-deadbeef' },
      note: null,
      created_at: '2026-05-27T23:59:00Z',
      scope: 'global',
      project_id: null,
    },
  ],
};

function mockFetch(routes: Record<string, unknown>): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      for (const [path, body] of Object.entries(routes)) {
        if (url.includes(path)) {
          return new Response(JSON.stringify(body), { status: 200 });
        }
      }
      return new Response(JSON.stringify({ detail: 'unhandled' }), {
        status: 404,
      });
    }),
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('CurationDashboard', () => {
  beforeEach(() => {
    mockFetch({
      '/api/tile-intel/curation/summary': SUMMARY,
      '/api/tile-intel/curation/overrides': OVERRIDES,
    });
  });

  it('renders the summary stats', async () => {
    render(<CurationDashboard />);
    await waitFor(() => {
      expect(screen.getByText('Total')).toBeInTheDocument();
      expect(screen.getByText('Good')).toBeInTheDocument();
      expect(screen.getByText('Bad')).toBeInTheDocument();
      expect(screen.getByText('Neutral')).toBeInTheDocument();
      // The "by_kind" rows: 'metatile placement' (4) + 'template' (1).
      // The string also appears in the override row badges, so use
      // getAllByText.
      expect(
        screen.getAllByText('metatile placement').length,
      ).toBeGreaterThanOrEqual(1);
    });
  });

  it('renders recent override rows', async () => {
    render(<CurationDashboard />);
    await waitFor(() => {
      expect(screen.getByText('GOOD')).toBeInTheDocument();
      expect(screen.getByText('BAD')).toBeInTheDocument();
      // Notes surface in the meta line.
      expect(screen.getByText(/looks right/)).toBeInTheDocument();
    });
  });

  it('refresh button reissues fetch', async () => {
    render(<CurationDashboard />);
    await waitFor(() => {
      expect(screen.getByText('GOOD')).toBeInTheDocument();
    });
    const fetchMock = (
      globalThis as unknown as { fetch: ReturnType<typeof vi.fn> }
    ).fetch;
    const initialCalls = fetchMock.mock.calls.length;
    fireEvent.click(screen.getByRole('button', { name: /Refresh/i }));
    await waitFor(() => {
      expect(fetchMock.mock.calls.length).toBeGreaterThan(initialCalls);
    });
  });

  it('handles sidecar offline state', async () => {
    mockFetch({
      '/api/tile-intel/curation/summary': {
        available: false,
        reason: 'sidecar_offline',
        details: 'mock down',
      },
      '/api/tile-intel/curation/overrides': {
        available: false,
        reason: 'sidecar_offline',
        details: 'mock down',
      },
    });
    render(<CurationDashboard />);
    await waitFor(() => {
      // The warning surfaces under both summary + overrides panes.
      expect(
        screen.getAllByText(/Tile intelligence is offline/i).length,
      ).toBeGreaterThan(0);
    });
  });
});
