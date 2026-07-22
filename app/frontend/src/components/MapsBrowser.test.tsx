import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ProjectManifest } from '@rom-editor/shared';
import { emptyManifest } from '@rom-editor/shared';
import { MapsBrowser } from './MapsBrowser';

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
        warpIds: [],
        scriptIds: [],
        objectEventIds: [],
        encounterTableIds: [],
        musicId: null,
        metadata: {},
      },
      {
        id: 'MAP_PETALBURG_CITY',
        name: 'PETALBURG_CITY',
        group: 'town',
        dimensions: { width: 0, height: 0 },
        tilesetIds: [],
        warpIds: [],
        scriptIds: [],
        objectEventIds: [],
        encounterTableIds: [],
        musicId: null,
        metadata: {},
      },
      {
        id: 'MAP_ROUTE101',
        name: 'ROUTE101',
        group: 'route',
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
  };
}

describe('MapsBrowser', () => {
  afterEach(() => cleanup());

  it('renders one group section per non-empty MapGroup, ordered consistently', () => {
    const onSelect = vi.fn();
    render(<MapsBrowser manifest={makeManifest()} selectedId={null} onSelect={onSelect} />);
    expect(screen.getByTestId('maps-browser-group-town')).toBeInTheDocument();
    expect(screen.getByTestId('maps-browser-group-route')).toBeInTheDocument();
    // Cave/dungeon/etc. have no maps in this fixture and should not render.
    expect(screen.queryByTestId('maps-browser-group-cave')).not.toBeInTheDocument();
  });

  it('sorts items within a group alphabetically by name', () => {
    const onSelect = vi.fn();
    render(<MapsBrowser manifest={makeManifest()} selectedId={null} onSelect={onSelect} />);
    const townItems = screen.getAllByTestId(/^maps-browser-item-MAP_(LITTLEROOT_TOWN|PETALBURG_CITY)/);
    // LITTLEROOT_TOWN sorts before PETALBURG_CITY
    expect(townItems[0]?.getAttribute('data-testid')).toBe('maps-browser-item-MAP_LITTLEROOT_TOWN');
    expect(townItems[1]?.getAttribute('data-testid')).toBe('maps-browser-item-MAP_PETALBURG_CITY');
  });

  it('calls onSelect when a map item is clicked', () => {
    const onSelect = vi.fn();
    render(<MapsBrowser manifest={makeManifest()} selectedId={null} onSelect={onSelect} />);
    fireEvent.click(screen.getByTestId('maps-browser-item-MAP_ROUTE101'));
    expect(onSelect).toHaveBeenCalledWith('MAP_ROUTE101');
  });

  it('toggles a group collapsed/expanded when its header is clicked', () => {
    const onSelect = vi.fn();
    render(<MapsBrowser manifest={makeManifest()} selectedId={null} onSelect={onSelect} />);
    // Start expanded - items visible
    expect(screen.getByTestId('maps-browser-item-MAP_LITTLEROOT_TOWN')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('maps-browser-group-town'));
    expect(screen.queryByTestId('maps-browser-item-MAP_LITTLEROOT_TOWN')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('maps-browser-group-town'));
    expect(screen.getByTestId('maps-browser-item-MAP_LITTLEROOT_TOWN')).toBeInTheDocument();
  });

  it('marks the selected map item with the --selected class', () => {
    const onSelect = vi.fn();
    render(
      <MapsBrowser
        manifest={makeManifest()}
        selectedId="MAP_LITTLEROOT_TOWN"
        onSelect={onSelect}
      />,
    );
    const selected = screen.getByTestId('maps-browser-item-MAP_LITTLEROOT_TOWN');
    expect(selected.className).toContain('maps-browser__item--selected');
  });

  it('marks highlighted (search-result) items with the --highlighted class', () => {
    const onSelect = vi.fn();
    render(
      <MapsBrowser
        manifest={makeManifest()}
        selectedId={null}
        onSelect={onSelect}
        highlightedIds={new Set(['MAP_ROUTE101'])}
      />,
    );
    const item = screen.getByTestId('maps-browser-item-MAP_ROUTE101');
    expect(item.className).toContain('maps-browser__item--highlighted');
  });
});
