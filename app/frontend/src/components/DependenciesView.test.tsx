import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ProjectManifest } from '@rom-editor/shared';
import { emptyManifest } from '@rom-editor/shared';
import { DependenciesView } from './DependenciesView';

function makeManifest(): ProjectManifest {
  const base = emptyManifest('/tmp/x', '2026-05-16T00:00:00Z');
  return {
    ...base,
    maps: [
      {
        id: 'Town', name: 'Town', group: 'town',
        dimensions: { width: 10, height: 10 },
        tilesetIds: ['asset_tiles'], warpIds: [], scriptIds: [], objectEventIds: [],
        encounterTableIds: [], musicId: null, metadata: {},
      },
    ],
    flags: [
      { id: 'FLAG_VISIT', name: 'FLAG_VISIT', scope: 'global', defaultValue: false, description: null, engineValue: '0x800' },
    ],
    assets: [
      { id: 'asset_tiles', name: 'asset_tiles', kind: 'tileset', relativePath: 'graphics/tilesets/town.png', metadata: {} },
    ],
  };
}

describe('DependenciesView', () => {
  afterEach(() => cleanup());

  it('renders the kind selector + id input + (empty) report shell on an empty manifest', () => {
    render(<DependenciesView manifest={emptyManifest('/tmp/x', '2026-05-16T00:00:00Z')} />);
    expect(screen.getByTestId('deps-view')).toBeInTheDocument();
    expect(screen.getByTestId('deps-view-kind')).toBeInTheDocument();
    expect(screen.getByTestId('deps-view-id')).toBeInTheDocument();
    // With no entities, effectiveId stays empty and the placeholder shows.
    expect(screen.getByTestId('deps-view-report')).toHaveTextContent('No entity selected');
  });

  it('auto-selects the first entity of the chosen kind and renders the report', () => {
    render(<DependenciesView manifest={makeManifest()} />);
    // Default kind is 'map' and Town is the only map → auto-selected.
    expect(screen.getByTestId('deps-report-id')).toHaveTextContent('Town');
    expect(screen.getByTestId('deps-report-outbound')).toHaveTextContent('asset_tiles');
  });

  it('switches kind when the dropdown changes', () => {
    render(<DependenciesView manifest={makeManifest()} />);
    fireEvent.change(screen.getByTestId('deps-view-kind'), { target: { value: 'flag' } });
    expect(screen.getByTestId('deps-report-id')).toHaveTextContent('FLAG_VISIT');
  });

  it('shows the not-found message when an unknown id is typed for the selected kind', () => {
    render(<DependenciesView manifest={makeManifest()} />);
    fireEvent.change(screen.getByTestId('deps-view-id'), { target: { value: 'NoSuchMap' } });
    expect(screen.getByTestId('deps-view-not-found')).toBeInTheDocument();
  });

  it('renders inbound + outbound sections with the right counts for an asset', () => {
    render(<DependenciesView manifest={makeManifest()} />);
    fireEvent.change(screen.getByTestId('deps-view-kind'), { target: { value: 'asset' } });
    // asset_tiles is referenced by Town as a tileset → inbound count = 1.
    expect(screen.getByTestId('deps-report-inbound')).toHaveTextContent('Town');
    expect(screen.getByTestId('deps-report-outbound')).toHaveTextContent('(0)');
  });
});
