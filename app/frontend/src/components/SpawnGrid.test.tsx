import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { EncounterTable, MapNode, ProjectManifest } from '@rom-editor/shared';
import { SpawnGrid } from './SpawnGrid';
import { useProjectStore } from '../state';

function manifest(over: Partial<ProjectManifest> = {}): ProjectManifest {
  return {
    schemaVersion: 1,
    generatedAtUtc: '2026-05-27T00:00:00.000Z',
    projectRoot: '/x',
    identity: {
      kind: 'patch',
      confidence: 1,
      displayName: 'fake',
      baseGame: 'firered',
      fork: null,
      featureFlags: [],
      warnings: [],
      evidence: [],
    },
    buildProfile: null,
    maps: [],
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
    ...over,
  };
}

function fakeMap(id: string, name: string): MapNode {
  return {
    id,
    name,
    metadata: {},
    group: 'route',
    dimensions: { width: 20, height: 20 },
    tilesetIds: [],
    warpIds: [],
    scriptIds: [],
    objectEventIds: [],
    encounterTableIds: [],
    musicId: null,
    connections: [],
  };
}

function fakeTable(id: string, mapId: string, type: EncounterTable['type'], slotCount = 4): EncounterTable {
  return {
    id,
    name: id,
    mapId,
    type,
    encounterRate: 25,
    slots: Array.from({ length: slotCount }, (_, i) => ({
      speciesId: `species_${String(16 + i)}`,
      minLevel: 5,
      maxLevel: 7,
      weight: i === 0 ? 20 : 5,
    })),
  };
}

describe('SpawnGrid (Phase 4.2B)', () => {
  beforeEach(() => {
    useProjectStore.setState({
      load: {
        kind: 'loaded',
        data: {
          session: {
            id: 'sess-1',
            projectRoot: '/tmp',
            name: 'test',
            createdAtUtc: '2026-05-27T00:00:00Z',
            updatedAtUtc: '2026-05-27T00:00:00Z',
          },
          rootListing: { entries: [] },
        } as never,
      },
      scan: { kind: 'idle' },
    } as never);
  });
  afterEach(() => cleanup());

  it('renders an empty grid when no tables are present', () => {
    render(<SpawnGrid manifest={manifest()} />);
    expect(screen.getByTestId('spawn-grid')).toBeInTheDocument();
    expect(screen.getByTestId('spawn-grid-empty')).toBeInTheDocument();
  });

  it('flattens every encounter slot across every map', () => {
    const m = manifest({
      maps: [fakeMap('m_3_19', 'Route 1'), fakeMap('m_4_0', 'Viridian Forest')],
      encounterTables: [
        fakeTable('t1', 'm_3_19', 'grass', 4),
        fakeTable('t2', 'm_4_0', 'grass', 4),
      ],
    });
    render(<SpawnGrid manifest={m} />);
    // 8 slots total.
    expect(screen.getAllByTestId(/^spawn-grid-row-/)).toHaveLength(8);
  });

  it('filters by map name substring', () => {
    const m = manifest({
      maps: [fakeMap('m_3_19', 'Route 1'), fakeMap('m_4_0', 'Viridian Forest')],
      encounterTables: [
        fakeTable('t1', 'm_3_19', 'grass', 2),
        fakeTable('t2', 'm_4_0', 'grass', 2),
      ],
    });
    render(<SpawnGrid manifest={m} />);
    fireEvent.change(screen.getByTestId('spawn-grid-filter-map'), { target: { value: 'Viridian' } });
    expect(screen.getAllByTestId(/^spawn-grid-row-/)).toHaveLength(2);
  });

  it('filters by method', () => {
    const m = manifest({
      maps: [fakeMap('m_3_19', 'Route 1')],
      encounterTables: [
        fakeTable('t-grass', 'm_3_19', 'grass', 2),
        fakeTable('t-water', 'm_3_19', 'water', 2),
      ],
    });
    render(<SpawnGrid manifest={m} />);
    fireEvent.change(screen.getByTestId('spawn-grid-filter-method'), { target: { value: 'water' } });
    expect(screen.getAllByTestId(/^spawn-grid-row-/)).toHaveLength(2);
  });

  it('filters by rarity bucket', () => {
    const m = manifest({
      maps: [fakeMap('m_3_19', 'Route 1')],
      encounterTables: [fakeTable('t', 'm_3_19', 'grass', 4)],
    });
    render(<SpawnGrid manifest={m} />);
    // Slot 0 has weight 20, slots 1..3 have weight 5 → slot 0 is very common,
    // others are common (or below).
    fireEvent.change(screen.getByTestId('spawn-grid-filter-rarity'), { target: { value: 'very-common' } });
    expect(screen.getAllByTestId(/^spawn-grid-row-/)).toHaveLength(1);
  });

  it('shows the filtered/total count line', () => {
    const m = manifest({
      maps: [fakeMap('m_3_19', 'Route 1')],
      encounterTables: [fakeTable('t', 'm_3_19', 'grass', 3)],
    });
    render(<SpawnGrid manifest={m} />);
    expect(screen.getByTestId('spawn-grid').textContent).toMatch(/Showing 3 of 3 slots/);
  });
});
