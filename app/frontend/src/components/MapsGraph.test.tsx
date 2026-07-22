import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useState } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ProjectManifest } from '@rom-editor/shared';
import { emptyManifest } from '@rom-editor/shared';
import { MapsGraph } from './MapsGraph';

function Harness({ manifest }: { manifest: ProjectManifest }) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  return <MapsGraph manifest={manifest} selectedId={selectedId} onSelect={setSelectedId} />;
}

function makeManifest(): ProjectManifest {
  const base = emptyManifest('/tmp/example', '2026-05-16T00:00:00Z');
  return {
    ...base,
    maps: [
      {
        id: 'MAP_LITTLEROOT_TOWN',
        name: 'LITTLEROOT_TOWN',
        group: 'town',
        dimensions: { width: 0, height: 0 },
        tilesetIds: [],
        warpIds: ['MAP_LITTLEROOT_TOWN_warp_0'],
        scriptIds: [],
        objectEventIds: [],
        encounterTableIds: [],
        musicId: 'MUS_LITTLEROOT_TOWN',
        metadata: {},
      },
      {
        id: 'MAP_ROUTE101',
        name: 'ROUTE101',
        group: 'route',
        dimensions: { width: 0, height: 0 },
        tilesetIds: [],
        warpIds: ['MAP_ROUTE101_warp_0'],
        scriptIds: [],
        objectEventIds: [],
        encounterTableIds: [],
        musicId: null,
        metadata: {},
      },
    ],
    warps: [
      {
        id: 'MAP_LITTLEROOT_TOWN_warp_0',
        name: 'MAP_LITTLEROOT_TOWN → MAP_ROUTE101',
        fromMapId: 'MAP_LITTLEROOT_TOWN',
        fromCoord: { x: 10, y: 12 },
        toMapId: 'MAP_ROUTE101',
        toCoord: { x: 20, y: 5 },
      },
      {
        id: 'MAP_ROUTE101_warp_0',
        name: 'MAP_ROUTE101 → MAP_LITTLEROOT_TOWN',
        fromMapId: 'MAP_ROUTE101',
        fromCoord: { x: 20, y: 5 },
        toMapId: 'MAP_LITTLEROOT_TOWN',
        toCoord: { x: 10, y: 12 },
      },
    ],
  };
}

describe('MapsGraph', () => {
  beforeEach(() => {
    /* no-op */
  });

  afterEach(() => {
    cleanup();
  });

  it('renders one node per map plus the empty-inspector summary', () => {
    render(<Harness manifest={makeManifest()} />);
    expect(screen.getByTestId('map-node-MAP_LITTLEROOT_TOWN')).toBeInTheDocument();
    expect(screen.getByTestId('map-node-MAP_ROUTE101')).toBeInTheDocument();
    // Empty-inspector pane shows counts
    const inspector = screen.getByTestId('maps-graph-inspector');
    expect(inspector.textContent).toMatch(/2.*maps indexed/);
    expect(inspector.textContent).toMatch(/2.*warps/);
  });

  it('shows MapInspector populated when a node is clicked', () => {
    render(<Harness manifest={makeManifest()} />);
    const node = screen.getByTestId('map-node-MAP_LITTLEROOT_TOWN');
    fireEvent.click(node);
    expect(screen.getByTestId('map-inspector-name').textContent).toBe('LITTLEROOT_TOWN');
  });

  it('lists outgoing and incoming warps for the selected map with both directions', () => {
    render(<Harness manifest={makeManifest()} />);
    fireEvent.click(screen.getByTestId('map-node-MAP_LITTLEROOT_TOWN'));
    expect(screen.getByTestId('outgoing-warp-MAP_LITTLEROOT_TOWN_warp_0')).toBeInTheDocument();
    expect(screen.getByTestId('incoming-warp-MAP_ROUTE101_warp_0')).toBeInTheDocument();
  });

  it('navigates between maps when a warp button is clicked (bidirectional traversal)', () => {
    render(<Harness manifest={makeManifest()} />);
    fireEvent.click(screen.getByTestId('map-node-MAP_LITTLEROOT_TOWN'));
    expect(screen.getByTestId('map-inspector-name').textContent).toBe('LITTLEROOT_TOWN');
    // Click the outgoing warp button → selects MAP_ROUTE101
    fireEvent.click(screen.getByTestId('outgoing-warp-MAP_LITTLEROOT_TOWN_warp_0'));
    expect(screen.getByTestId('map-inspector-name').textContent).toBe('ROUTE101');
    // From Route101 the inbound list shows the way back; click it → returns to LittlerootTown
    fireEvent.click(screen.getByTestId('incoming-warp-MAP_LITTLEROOT_TOWN_warp_0'));
    expect(screen.getByTestId('map-inspector-name').textContent).toBe('LITTLEROOT_TOWN');
  });

  it('renders an empty inspector when no node is selected', () => {
    render(<Harness manifest={makeManifest()} />);
    expect(screen.queryByTestId('map-inspector-name')).not.toBeInTheDocument();
    expect(screen.getByText(/Map inspector/i)).toBeInTheDocument();
  });
});
