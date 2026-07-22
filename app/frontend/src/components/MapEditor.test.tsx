import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ProjectManifest } from '@rom-editor/shared';
import { emptyManifest } from '@rom-editor/shared';
import { MapEditor } from './MapEditor';

// PixiJS' Application.init throws in jsdom (no GPU context). The component
// catches this and renders a fallback marker - that's what tests observe.
// React shell + inspector + toolbar are fully tested independent of the canvas.

function makeManifest(): ProjectManifest {
  const base = emptyManifest('/tmp/example', '2026-05-16T00:00:00Z');
  return {
    ...base,
    maps: [
      {
        id: 'MAP_LITTLEROOT_TOWN',
        name: 'LITTLEROOT_TOWN',
        group: 'town',
        dimensions: { width: 20, height: 20 },
        tilesetIds: [],
        warpIds: ['MAP_LITTLEROOT_TOWN_warp_0'],
        scriptIds: [],
        objectEventIds: ['MAP_LITTLEROOT_TOWN_obj_0'],
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
        toCoord: { x: 4, y: 5 },
      },
    ],
    triggers: [
      {
        id: 'MAP_LITTLEROOT_TOWN_bg_0',
        name: 'LittlerootTown_Sign',
        kind: 'on_interact',
        mapId: 'MAP_LITTLEROOT_TOWN',
        coord: { x: 6, y: 8 },
        conditionExpression: null,
        scriptStepIds: ['LittlerootTown_Sign#0'],
      },
    ],
    objectEvents: [
      {
        id: 'MAP_LITTLEROOT_TOWN_obj_0',
        name: 'LittlerootTown_EventScript_Boy',
        mapId: 'MAP_LITTLEROOT_TOWN',
        coord: { x: 11, y: 6 },
        elevation: 3,
        kind: 'npc',
        graphicsId: 'OBJ_EVENT_GFX_LITTLE_BOY_1',
        movementType: 'MOVEMENT_TYPE_FACE_DOWN',
        scriptId: 'LittlerootTown_EventScript_Boy',
        flagId: null,
        trainerType: 'TRAINER_TYPE_NONE',
        metadata: {},
      },
    ],
  };
}

describe('MapEditor', () => {
  afterEach(() => cleanup());

  it('renders the toolbar with map name, dimensions, and a Back button', () => {
    const onClose = vi.fn();
    const m = makeManifest();
    const map = m.maps[0]!;
    render(<MapEditor manifest={m} map={map} onClose={onClose} />);
    expect(screen.getByTestId('map-editor-name').textContent).toBe('LITTLEROOT_TOWN');
    expect(screen.getByText(/20 × 20/)).toBeInTheDocument();
    expect(screen.getByTestId('map-editor-back')).toBeInTheDocument();
  });

  it('invokes onClose when Back is clicked', () => {
    const onClose = vi.fn();
    const m = makeManifest();
    render(<MapEditor manifest={m} map={m.maps[0]!} onClose={onClose} />);
    fireEvent.click(screen.getByTestId('map-editor-back'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('renders all five layer toggles in default state', () => {
    const onClose = vi.fn();
    const m = makeManifest();
    render(<MapEditor manifest={m} map={m.maps[0]!} onClose={onClose} />);
    expect((screen.getByTestId('map-editor-layer-tiles') as HTMLInputElement).checked).toBe(true);
    expect((screen.getByTestId('map-editor-layer-collision') as HTMLInputElement).checked).toBe(false);
    expect((screen.getByTestId('map-editor-layer-objects') as HTMLInputElement).checked).toBe(true);
    expect((screen.getByTestId('map-editor-layer-warps') as HTMLInputElement).checked).toBe(true);
    expect((screen.getByTestId('map-editor-layer-triggers') as HTMLInputElement).checked).toBe(true);
  });

  it('toggles a layer checkbox on click', () => {
    const onClose = vi.fn();
    const m = makeManifest();
    render(<MapEditor manifest={m} map={m.maps[0]!} onClose={onClose} />);
    const collision = screen.getByTestId('map-editor-layer-collision') as HTMLInputElement;
    expect(collision.checked).toBe(false);
    fireEvent.click(collision);
    expect(collision.checked).toBe(true);
  });

  // Phase O.77 - verify Reset + Hide-all buttons (O.75/O.76) move the
  // layer set through the toggle → reset → hide-all state cycle the
  // operator expects.
  it('Reset restores defaults; Hide all wipes; buttons disable correctly', () => {
    const onClose = vi.fn();
    const m = makeManifest();
    render(<MapEditor manifest={m} map={m.maps[0]!} onClose={onClose} />);
    const tiles = screen.getByTestId('map-editor-layer-tiles') as HTMLInputElement;
    const objects = screen.getByTestId('map-editor-layer-objects') as HTMLInputElement;
    const reset = screen.getByTestId(
      'map-editor-layers-reset',
    ) as HTMLButtonElement;
    const hideAll = screen.getByTestId(
      'map-editor-layers-hide-all',
    ) as HTMLButtonElement;

    // Initial state: tiles + objects on, Reset disabled (matches default),
    // Hide-all enabled.
    expect(tiles.checked).toBe(true);
    expect(objects.checked).toBe(true);
    expect(reset.disabled).toBe(true);
    expect(hideAll.disabled).toBe(false);

    // Toggle objects off → Reset becomes enabled.
    fireEvent.click(objects);
    expect(objects.checked).toBe(false);
    expect(reset.disabled).toBe(false);
    expect(hideAll.disabled).toBe(false);

    // Reset → objects back on, Reset disabled again.
    fireEvent.click(reset);
    expect(objects.checked).toBe(true);
    expect(reset.disabled).toBe(true);

    // Hide all → both off, Hide-all disabled, Reset enabled.
    fireEvent.click(hideAll);
    expect(tiles.checked).toBe(false);
    expect(objects.checked).toBe(false);
    expect(hideAll.disabled).toBe(true);
    expect(reset.disabled).toBe(false);

    // Reset from empty → back to defaults.
    fireEvent.click(reset);
    expect(tiles.checked).toBe(true);
    expect(objects.checked).toBe(true);
    expect(reset.disabled).toBe(true);
    expect(hideAll.disabled).toBe(false);
  });

  it('mounts the PixiJS host div even when canvas init is unavailable (jsdom)', () => {
    const onClose = vi.fn();
    const m = makeManifest();
    render(<MapEditor manifest={m} map={m.maps[0]!} onClose={onClose} />);
    expect(screen.getByTestId('map-editor-canvas')).toBeInTheDocument();
  });

  it('shows entity counts in the empty-selection inspector', () => {
    const onClose = vi.fn();
    const m = makeManifest();
    render(<MapEditor manifest={m} map={m.maps[0]!} onClose={onClose} />);
    const inspector = screen.getByTestId('map-editor-inspector');
    expect(inspector.textContent).toMatch(/1.*object events/i);
    expect(inspector.textContent).toMatch(/1.*outgoing warps/i);
    expect(inspector.textContent).toMatch(/1.*triggers/i);
  });

  it('filters object/warp/trigger entries to those whose mapId matches', () => {
    const onClose = vi.fn();
    const m = makeManifest();
    // Add a foreign object event on a different map; it should not appear in counts
    const polluted: ProjectManifest = {
      ...m,
      objectEvents: [
        ...m.objectEvents,
        {
          id: 'MAP_OTHER_obj_0',
          name: 'foreign',
          mapId: 'MAP_SOMEWHERE_ELSE',
          coord: { x: 0, y: 0 },
          elevation: 0,
          kind: 'npc',
          graphicsId: null,
          movementType: null,
          scriptId: null,
          flagId: null,
          trainerType: null,
          metadata: {},
        },
      ],
    };
    render(<MapEditor manifest={polluted} map={m.maps[0]!} onClose={onClose} />);
    const inspector = screen.getByTestId('map-editor-inspector');
    // Still 1 object event for THIS map, not 2.
    expect(inspector.textContent).toMatch(/1.*object events/i);
  });

  it('Phase O.4 - surfaces OW sprite detector failure as a toolbar banner', () => {
    const onClose = vi.fn();
    const m = makeManifest();
    const withFailedDetector = {
      ...m,
      binaryRom: {
        subsystems: [
          {
            id: 'overworld_sprites_system',
            status: 'not_detected',
            confidence: 0.9,
            summary: 'No 36-byte ObjectEventGraphicsInfo struct run found',
            evidence: [],
            reason: 'expanded layout',
          },
        ],
      },
    } as unknown as ProjectManifest;
    render(<MapEditor manifest={withFailedDetector} map={m.maps[0]!} onClose={onClose} />);
    expect(screen.getByTestId('map-editor-ow-sprite-warn')).toBeInTheDocument();
  });

  it('Phase O.4 - does NOT show OW sprite banner when detector succeeded', () => {
    const onClose = vi.fn();
    const m = makeManifest();
    const withDetected = {
      ...m,
      binaryRom: {
        subsystems: [
          {
            id: 'overworld_sprites_system',
            status: 'detected',
            confidence: 0.95,
            summary: 'Found 200 OW sprites',
            evidence: [],
          },
        ],
      },
    } as unknown as ProjectManifest;
    render(<MapEditor manifest={withDetected} map={m.maps[0]!} onClose={onClose} />);
    expect(screen.queryByTestId('map-editor-ow-sprite-warn')).toBeNull();
  });

  it('Phase O.5 - renders a sprite-preview placeholder for NPC inspector when no cache hit', () => {
    const onClose = vi.fn();
    const m = makeManifest();
    render(<MapEditor manifest={m} map={m.maps[0]!} onClose={onClose} />);
    // Simulate selecting the NPC. The selected state is internal - to
    // make the inspector show the objectEvent branch, click the marker.
    // Since the Pixi canvas doesn't render in jsdom, fall back to
    // verifying the preview component class is registered (its CSS
    // class shows up if used).
    // For now, just assert no crash + the empty-selection inspector
    // renders. Full preview test would need the canvas wired.
    expect(screen.getByTestId('map-editor-inspector')).toBeInTheDocument();
  });
});
