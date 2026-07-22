/**
 * Phase 8I-2 - Smoke tests for TileNeighboursExplorer.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';

import { TileNeighboursExplorer } from './TileNeighboursExplorer';

const NEIGHBOURS_BODY = {
  available: true as const,
  seed_tileset_slug: 'pret-frlg-route1',
  seed_metatile_index: 42,
  direction: 2,
  total_observations: 50,
  entropy: 0.5,
  suggestions: [
    {
      tileset_slug: 'pret-frlg-route1',
      metatile_index: 11,
      probability: 0.7,
      support_count: 35,
      behavior_id: 1,
      is_walkable: true,
      phash_hex: '0b0b0b0b0b0b0b0b',
      seed_tags_sample: [],
    },
    {
      tileset_slug: 'pret-frlg-route1',
      metatile_index: 12,
      probability: 0.3,
      support_count: 15,
      behavior_id: 1,
      is_walkable: false,
      phash_hex: '0c0c0c0c0c0c0c0c',
      seed_tags_sample: [],
    },
  ],
};

const EMPTY_BODY = {
  available: true as const,
  seed_tileset_slug: 'pret-frlg-route1',
  seed_metatile_index: 0,
  direction: 0,
  total_observations: 0,
  entropy: 0,
  suggestions: [],
};

function mockFetch(response: unknown): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      new Response(JSON.stringify(response), { status: 200 }),
    ),
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('TileNeighboursExplorer', () => {
  beforeEach(() => {
    mockFetch(NEIGHBOURS_BODY);
  });

  it('renders the input form with default direction east', () => {
    render(<TileNeighboursExplorer />);
    expect(screen.getByText(/Tileset slug:/)).toBeInTheDocument();
    expect(screen.getByText(/Metatile #:/)).toBeInTheDocument();
    expect(screen.getByText(/Direction:/)).toBeInTheDocument();
    expect(
      (screen.getByRole('combobox') as HTMLSelectElement).value,
    ).toBe('east');
  });

  it('fetches and renders ranked suggestions on submit', async () => {
    render(
      <TileNeighboursExplorer
        initialTilesetSlug="pret-frlg-route1"
        initialMetatileIndex={42}
      />,
    );
    fireEvent.click(
      screen.getByRole('button', { name: /Suggest neighbours/i }),
    );
    await waitFor(() => {
      expect(screen.getByText(/Top 2 neighbours/)).toBeInTheDocument();
    });
    // First suggestion's probability bar shows 70%.
    expect(screen.getByText(/70% · 35 maps/)).toBeInTheDocument();
    // Walkability badges.
    expect(screen.getByText('Walkable')).toBeInTheDocument();
    expect(screen.getByText('Blocked')).toBeInTheDocument();
  });

  it('shows the empty-state hint when the sidecar returns no suggestions', async () => {
    mockFetch(EMPTY_BODY);
    render(
      <TileNeighboursExplorer
        initialTilesetSlug="pret-frlg-route1"
        initialMetatileIndex={0}
      />,
    );
    fireEvent.click(
      screen.getByRole('button', { name: /Suggest neighbours/i }),
    );
    await waitFor(() => {
      expect(
        screen.getByText(/No observed neighbours/),
      ).toBeInTheDocument();
    });
  });

  it('refuses to submit when required inputs are missing', async () => {
    render(<TileNeighboursExplorer />);
    fireEvent.click(
      screen.getByRole('button', { name: /Suggest neighbours/i }),
    );
    await waitFor(() => {
      expect(
        screen.getByText(/Tileset slug and metatile index are required/i),
      ).toBeInTheDocument();
    });
  });

  it('surfaces sidecar_offline inline', async () => {
    mockFetch({
      available: false,
      reason: 'sidecar_offline',
      details: 'mock down',
    });
    render(
      <TileNeighboursExplorer
        initialTilesetSlug="x"
        initialMetatileIndex={1}
      />,
    );
    fireEvent.click(
      screen.getByRole('button', { name: /Suggest neighbours/i }),
    );
    await waitFor(() => {
      expect(
        screen.getByText(/tile intelligence service is offline/i),
      ).toBeInTheDocument();
    });
  });
});
