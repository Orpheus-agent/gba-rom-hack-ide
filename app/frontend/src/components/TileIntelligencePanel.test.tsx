/**
 * Phase 8I-1 - Smoke tests for TileIntelligencePanel.
 *
 * Mocks `fetch` so the component sees scripted backend responses;
 * we don't need a live sidecar or running backend.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';

import { TileIntelligencePanel } from './TileIntelligencePanel';

const HEALTH_OK = {
  available: true as const,
  baseUrl: 'http://stub',
  health: { ok: true, schema_version: 1, api_version: 1 },
  version: {
    package_version: '0.1.0',
    schema_version: 1,
    api_version: 1,
    test_mode: true,
  },
};

const HEALTH_DOWN = {
  available: false as const,
  reason: 'sidecar_offline' as const,
  details: 'tests',
};

const LIBRARY_BODY = {
  available: true as const,
  total_tilesets: 2,
  entries: [
    {
      slug: 'pret-frlg-route1',
      display_name: 'FRLG Route 1',
      family: 'frlg',
      is_secondary: false,
      source: 'pret-firered',
      source_commit: 'abc1234',
      license_spdx: 'MIT',
      attribution: 'pret/pokefirered',
      metatile_count: 256,
      palette_count: 6,
    },
    {
      slug: 'pret-frlg-cave-secondary',
      display_name: 'FRLG Cave (secondary)',
      family: 'frlg',
      is_secondary: true,
      source: 'pret-firered',
      source_commit: 'abc1234',
      license_spdx: 'MIT',
      attribution: 'pret/pokefirered',
      metatile_count: 512,
      palette_count: 10,
    },
  ],
};

const TEMPLATES_BIOME_BODY = {
  available: true as const,
  biome: 'biome.route',
  templates: [
    {
      template_slug: 'pattern-3x3-deadbeef',
      role: 'uniform_terrain.grass.tall',
      required_tags: ['terrain.grass.tall'],
      biomes: ['biome.route', 'biome.forest', 'biome.plains'],
      total_usage: 42,
    },
  ],
};

const COVERAGE_BODY = {
  available: true as const,
  biomes: { 'biome.route': 47, 'biome.cave': 22, 'biome.arctic': 2 },
};

interface FetchFixture {
  readonly [path: string]: unknown;
}

function mockFetch(fixture: FetchFixture): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      const path = url.split('?')[0]!;
      const body = fixture[path] ?? fixture[url];
      if (body === undefined) {
        return new Response(JSON.stringify({ detail: 'unhandled' }), {
          status: 404,
        });
      }
      return new Response(JSON.stringify(body), { status: 200 });
    }),
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('TileIntelligencePanel', () => {
  beforeEach(() => {
    mockFetch({
      '/api/tile-intel/health': HEALTH_OK,
      '/api/tile-intel/library': LIBRARY_BODY,
      '/api/tile-intel/templates/by-biome': TEMPLATES_BIOME_BODY,
      '/api/tile-intel/biome-coverage': COVERAGE_BODY,
    });
  });

  it('renders tabs + the library by default', async () => {
    render(<TileIntelligencePanel />);
    expect(screen.getByText('Tile Intelligence')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Library' })).toBeInTheDocument();
    // Library entries land via fetch.
    await waitFor(() => {
      expect(screen.getByText('FRLG Route 1')).toBeInTheDocument();
      expect(screen.getByText('FRLG Cave (secondary)')).toBeInTheDocument();
    });
    expect(
      screen.getByText('Showing 2 of 2 tilesets.'),
    ).toBeInTheDocument();
  });

  it('shows attribution and license metadata per row', async () => {
    render(<TileIntelligencePanel />);
    await waitFor(() => {
      expect(screen.getAllByText(/pret\/pokefirered/).length).toBeGreaterThan(0);
    });
  });

  it('switches to the templates tab and shows biome results', async () => {
    render(<TileIntelligencePanel />);
    fireEvent.click(screen.getByRole('button', { name: 'Templates' }));
    await waitFor(() => {
      expect(
        screen.getByText('1 template for biome.route.'),
      ).toBeInTheDocument();
    });
    expect(screen.getByText(/uniform terrain.grass.tall/)).toBeInTheDocument();
  });

  it('renders biome coverage table sorted by count desc', async () => {
    render(<TileIntelligencePanel />);
    fireEvent.click(screen.getByRole('button', { name: 'Biome coverage' }));
    await waitFor(() => {
      expect(screen.getByText('biome.route')).toBeInTheDocument();
      expect(screen.getByText('biome.cave')).toBeInTheDocument();
      expect(screen.getByText('biome.arctic')).toBeInTheDocument();
    });
    const rows = screen.getAllByRole('row');
    // First row is header, then sorted: route(47), cave(22), arctic(2).
    expect(rows[1]!.textContent).toContain('biome.route');
    expect(rows[2]!.textContent).toContain('biome.cave');
    expect(rows[3]!.textContent).toContain('biome.arctic');
  });

  it('surfaces sidecar_offline inline when health probes fail', async () => {
    mockFetch({
      '/api/tile-intel/health': HEALTH_DOWN,
      '/api/tile-intel/library': LIBRARY_BODY,
    });
    render(<TileIntelligencePanel />);
    await waitFor(() => {
      expect(
        screen.getByText(/tile intelligence service is offline/i),
      ).toBeInTheDocument();
    });
  });

  it('filters the visible library by search text', async () => {
    render(<TileIntelligencePanel />);
    await waitFor(() => {
      expect(screen.getByText('FRLG Route 1')).toBeInTheDocument();
    });
    fireEvent.change(screen.getByPlaceholderText(/search by name/i), {
      target: { value: 'cave' },
    });
    expect(screen.getByText('FRLG Cave (secondary)')).toBeInTheDocument();
    expect(screen.queryByText('FRLG Route 1')).not.toBeInTheDocument();
  });
});
