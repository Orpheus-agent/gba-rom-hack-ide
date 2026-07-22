import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { ProjectManifest } from '@rom-editor/shared';
import { emptyManifest } from '@rom-editor/shared';
import { AssetsView } from './AssetsView';

function makeManifest(): ProjectManifest {
  const base = emptyManifest('/tmp/example', '2026-05-16T00:00:00Z');
  return {
    ...base,
    assets: [
      {
        id: 'asset_tileset_route101',
        name: 'asset_tileset_route101',
        kind: 'tileset',
        relativePath: 'graphics/tilesets/route101/tiles.png',
        metadata: {},
      },
      {
        id: 'asset_music_littleroot',
        name: 'asset_music_littleroot',
        kind: 'music',
        relativePath: 'sound/songs/littleroot.aif',
        metadata: { format: 'aif' },
      },
      {
        id: 'asset_npc_mom',
        name: 'asset_npc_mom',
        kind: 'overworld_sprite',
        relativePath: 'graphics/object_events/pics/may.png',
        metadata: {},
      },
      {
        id: 'asset_portrait_oak',
        name: 'asset_portrait_oak',
        kind: 'portrait',
        relativePath: 'graphics/portraits/oak.png',
        metadata: {},
      },
      {
        id: 'asset_orphan',
        name: 'asset_orphan',
        kind: 'ui_graphic',
        relativePath: 'graphics/misc/orphan.png',
        metadata: {},
      },
    ],
    maps: [
      {
        id: 'LittlerootTown',
        name: 'LittlerootTown',
        group: 'town',
        dimensions: { width: 20, height: 20 },
        tilesetIds: ['asset_tileset_route101'],
        warpIds: [],
        scriptIds: [],
        objectEventIds: [],
        encounterTableIds: [],
        musicId: 'asset_music_littleroot',
        metadata: {},
      },
    ],
    objectEvents: [
      {
        id: 'objectEvent_LittlerootTown_0',
        name: 'objectEvent_LittlerootTown_0',
        mapId: 'LittlerootTown',
        coord: { x: 5, y: 4 },
        elevation: 3,
        kind: 'npc',
        graphicsId: 'asset_npc_mom',
        movementType: 'WANDER_AROUND',
        scriptId: 'LittlerootTown_Mom',
        flagId: null,
        trainerType: null,
        metadata: {},
      },
    ],
    dialogue: [
      {
        id: 'Text_OakIntro',
        name: 'Text_OakIntro',
        speakerName: 'Oak',
        portraitAssetId: 'asset_portrait_oak',
        text: 'Hello there!',
        choices: [],
      },
    ],
  };
}

describe('AssetsView', () => {
  afterEach(() => cleanup());

  it('renders the empty-state when no assets are indexed', () => {
    const base = emptyManifest('/tmp/example', '2026-05-16T00:00:00Z');
    render(<AssetsView manifest={base} />);
    expect(screen.getByTestId('assets-view-empty')).toBeInTheDocument();
  });

  it('renders assets grouped by kind with counts', () => {
    render(<AssetsView manifest={makeManifest()} />);
    expect(screen.getByTestId('assets-view-group-tileset')).toBeInTheDocument();
    expect(screen.getByTestId('assets-view-group-music')).toBeInTheDocument();
    expect(screen.getByTestId('assets-view-group-overworld_sprite')).toBeInTheDocument();
    expect(screen.getByTestId('assets-view-group-portrait')).toBeInTheDocument();
    expect(screen.getByTestId('assets-view-group-ui_graphic')).toBeInTheDocument();
    expect(screen.getByTestId('assets-view-item-asset_tileset_route101')).toBeInTheDocument();
  });

  it('shows the placeholder before any asset is selected', () => {
    render(<AssetsView manifest={makeManifest()} />);
    expect(screen.getByTestId('assets-view-placeholder')).toBeInTheDocument();
  });

  it('filters the list by id, path, or kind', () => {
    render(<AssetsView manifest={makeManifest()} />);
    const filter = screen.getByTestId('assets-view-filter');
    fireEvent.change(filter, { target: { value: 'portrait' } });
    expect(screen.getByTestId('assets-view-item-asset_portrait_oak')).toBeInTheDocument();
    expect(
      screen.queryByTestId('assets-view-item-asset_tileset_route101'),
    ).not.toBeInTheDocument();
  });

  it('surfaces every cross-reference kind for a richly-referenced tileset', () => {
    render(<AssetsView manifest={makeManifest()} />);
    fireEvent.click(screen.getByTestId('assets-view-item-asset_tileset_route101'));
    const detail = screen.getByTestId('asset-detail');
    expect(within(detail).getByTestId('asset-detail-id')).toHaveTextContent('asset_tileset_route101');
    expect(within(detail).getByTestId('asset-detail-kind')).toHaveTextContent('tileset');
    expect(within(detail).getByTestId('asset-detail-path')).toHaveTextContent(
      'graphics/tilesets/route101/tiles.png',
    );
    // Map reference with role=tileset
    expect(within(detail).getByTestId('asset-detail-maps')).toHaveTextContent('LittlerootTown');
    expect(within(detail).getByTestId('asset-detail-maps')).toHaveTextContent('tileset');
  });

  it('surfaces object-event + dialogue references for the right asset kinds', () => {
    render(<AssetsView manifest={makeManifest()} />);
    fireEvent.click(screen.getByTestId('assets-view-item-asset_npc_mom'));
    expect(screen.getByTestId('asset-detail-objects')).toHaveTextContent(
      'objectEvent_LittlerootTown_0',
    );

    cleanup();
    render(<AssetsView manifest={makeManifest()} />);
    fireEvent.click(screen.getByTestId('assets-view-item-asset_portrait_oak'));
    expect(screen.getByTestId('asset-detail-dialogue')).toHaveTextContent('Text_OakIntro');
    expect(screen.getByTestId('asset-detail-dialogue')).toHaveTextContent('Oak');
  });

  it('reports the empty-references state for an orphan asset', () => {
    render(<AssetsView manifest={makeManifest()} />);
    fireEvent.click(screen.getByTestId('assets-view-item-asset_orphan'));
    expect(screen.getByTestId('asset-detail-no-refs')).toBeInTheDocument();
  });

  it('renders an AssetReplaceDropZone for an overworld-sprite (PNG) asset', () => {
    const m = makeManifest();
    const sprite = m.assets.find((a) => a.id === 'asset_npc_mom')!;
    // Add .extension metadata so the PNG check passes (the real scanner always
    // populates this; the test fixture didn't until now).
    const withPng = {
      ...m,
      assets: m.assets.map((a) =>
        a.id === sprite.id ? { ...a, metadata: { ...a.metadata, extension: '.png' } } : a,
      ),
    };
    render(<AssetsView manifest={withPng} />);
    fireEvent.click(screen.getByTestId('assets-view-item-asset_npc_mom'));
    expect(screen.getByTestId('asset-replace-dropzone')).toBeInTheDocument();
    expect(screen.getByTestId('asset-replace-status')).toHaveTextContent('Ready.');
  });

  it('does NOT render the drop zone for music/sound (non-PNG) assets', () => {
    render(<AssetsView manifest={makeManifest()} />);
    fireEvent.click(screen.getByTestId('assets-view-item-asset_music_littleroot'));
    expect(screen.queryByTestId('asset-replace-dropzone')).not.toBeInTheDocument();
  });

  it('surfaces PNG dimensions in the inspector metadata when present', () => {
    const m = makeManifest();
    const withDims = {
      ...m,
      assets: m.assets.map((a) =>
        a.id === 'asset_npc_mom'
          ? { ...a, metadata: { ...a.metadata, extension: '.png', width: 32, height: 64, bitDepth: 8, colorType: 'indexed' } }
          : a,
      ),
    };
    render(<AssetsView manifest={withDims} />);
    fireEvent.click(screen.getByTestId('assets-view-item-asset_npc_mom'));
    expect(screen.getByTestId('asset-detail-meta-width')).toHaveTextContent('32');
    expect(screen.getByTestId('asset-detail-meta-height')).toHaveTextContent('64');
    expect(screen.getByTestId('asset-detail-meta-colorType')).toHaveTextContent('indexed');
  });

  it('renders the format-constraints list for a sprite asset with dimensions', () => {
    const m = makeManifest();
    const withDims = {
      ...m,
      assets: m.assets.map((a) =>
        a.id === 'asset_npc_mom'
          ? { ...a, metadata: { extension: '.png', width: 32, height: 32, bitDepth: 4, colorType: 'indexed', sizeBytes: 2000 } }
          : a,
      ),
    };
    render(<AssetsView manifest={withDims} />);
    fireEvent.click(screen.getByTestId('assets-view-item-asset_npc_mom'));
    const block = screen.getByTestId('asset-constraints');
    expect(block).toBeInTheDocument();
    // 8-aligned 32x32 sprite should report ok severity for dimensions
    expect(screen.getByTestId('asset-constraint-dimensions_8_aligned')).toHaveAttribute(
      'data-severity',
      'ok',
    );
    expect(screen.getByTestId('asset-constraint-palette_kind')).toHaveAttribute(
      'data-severity',
      'ok',
    );
    expect(screen.getByTestId('asset-constraint-bit_depth_compact')).toHaveAttribute(
      'data-severity',
      'info',
    );
  });

  it('warns on a non-8-aligned sprite dimension', () => {
    const m = makeManifest();
    const odd = {
      ...m,
      assets: m.assets.map((a) =>
        a.id === 'asset_npc_mom'
          ? { ...a, metadata: { extension: '.png', width: 24, height: 20 } }
          : a,
      ),
    };
    render(<AssetsView manifest={odd} />);
    fireEvent.click(screen.getByTestId('assets-view-item-asset_npc_mom'));
    expect(screen.getByTestId('asset-constraint-dimensions_8_aligned')).toHaveAttribute(
      'data-severity',
      'warn',
    );
  });

  it('shows the NewAssetForm collapsed by default at the top of the left rail', () => {
    render(<AssetsView manifest={makeManifest()} />);
    const form = screen.getByTestId('new-asset-form');
    expect(form).toBeInTheDocument();
    expect(form.tagName.toLowerCase()).toBe('details');
    expect(form.hasAttribute('open')).toBe(false);
    // Path input is present even when collapsed (just hidden by CSS)
    expect(screen.getByTestId('new-asset-path')).toBeInTheDocument();
  });

  it('keeps the NewAssetForm status at "Ready." before any import attempt', () => {
    render(<AssetsView manifest={makeManifest()} />);
    expect(screen.getByTestId('new-asset-status')).toHaveTextContent('Ready.');
  });
});
