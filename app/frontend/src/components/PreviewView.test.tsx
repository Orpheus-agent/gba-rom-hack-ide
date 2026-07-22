import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ProjectManifest } from '@rom-editor/shared';
import { emptyManifest } from '@rom-editor/shared';
import { PreviewView } from './PreviewView';

function makeManifest(): ProjectManifest {
  const base = emptyManifest('/tmp/x', '2026-05-16T00:00:00Z');
  return {
    ...base,
    maps: [
      {
        id: 'LittlerootTown',
        name: 'LittlerootTown',
        group: 'town',
        dimensions: { width: 20, height: 20 },
        tilesetIds: [],
        warpIds: ['warp_LittlerootMomHouse_0'],
        scriptIds: [],
        objectEventIds: ['objectEvent_LittlerootTown_0'],
        encounterTableIds: [],
        musicId: null,
        metadata: {},
      },
      {
        id: 'Route101',
        name: 'Route101',
        group: 'route',
        dimensions: { width: 30, height: 8 },
        tilesetIds: [],
        warpIds: [],
        scriptIds: [],
        objectEventIds: [],
        encounterTableIds: [],
        musicId: null,
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
        graphicsId: 'OBJ_EVENT_GFX_MOM',
        movementType: 'WANDER_AROUND',
        scriptId: 'LittlerootTown_Mom',
        flagId: 'FLAG_HIDE_MOM',
        trainerType: null,
        metadata: {},
      },
    ],
    warps: [
      {
        id: 'warp_LittlerootMomHouse_0',
        name: 'warp_LittlerootMomHouse_0',
        fromMapId: 'LittlerootTown',
        fromCoord: { x: 8, y: 9 },
        toMapId: 'LittlerootMomHouse',
        toCoord: { x: 4, y: 7 },
      },
    ],
    triggers: [
      {
        id: 'trigger_LittlerootTown_0',
        name: 'trigger_LittlerootTown_0',
        kind: 'on_enter',
        mapId: 'LittlerootTown',
        coord: { x: 10, y: 10 },
        conditionExpression: 'FLAG_INTRO_DONE',
        scriptStepIds: [],
      },
    ],
  };
}

describe('PreviewView', () => {
  afterEach(() => cleanup());

  it('renders the empty-state when no maps are indexed', () => {
    const base = emptyManifest('/tmp/x', '2026-05-16T00:00:00Z');
    render(<PreviewView manifest={base} />);
    expect(screen.getByTestId('preview-view-empty')).toBeInTheDocument();
  });

  it('renders the map picker rail with every indexed map', () => {
    render(<PreviewView manifest={makeManifest()} />);
    expect(screen.getByTestId('preview-map-LittlerootTown')).toBeInTheDocument();
    expect(screen.getByTestId('preview-map-Route101')).toBeInTheDocument();
  });

  it('auto-selects the first map and renders its preview scene', () => {
    render(<PreviewView manifest={makeManifest()} />);
    expect(screen.getByTestId('preview-scene')).toBeInTheDocument();
    expect(screen.getByTestId('preview-scene-name')).toHaveTextContent('LittlerootTown');
  });

  it('switches selected map when a different rail item is clicked', () => {
    render(<PreviewView manifest={makeManifest()} />);
    fireEvent.click(screen.getByTestId('preview-map-Route101'));
    expect(screen.getByTestId('preview-scene-name')).toHaveTextContent('Route101');
  });

  it('exposes overlay toggles for collision / warps / triggers / flag_gates', () => {
    render(<PreviewView manifest={makeManifest()} />);
    expect(screen.getByTestId('preview-overlay-collision')).toBeInTheDocument();
    expect(screen.getByTestId('preview-overlay-warps')).toBeInTheDocument();
    expect(screen.getByTestId('preview-overlay-triggers')).toBeInTheDocument();
    expect(screen.getByTestId('preview-overlay-flag_gates')).toBeInTheDocument();
    // warps + triggers default-on; collision + flag_gates default-off
    expect((screen.getByTestId('preview-overlay-warps') as HTMLInputElement).checked).toBe(true);
    expect((screen.getByTestId('preview-overlay-triggers') as HTMLInputElement).checked).toBe(true);
    expect((screen.getByTestId('preview-overlay-collision') as HTMLInputElement).checked).toBe(false);
    expect((screen.getByTestId('preview-overlay-flag_gates') as HTMLInputElement).checked).toBe(false);
  });

  it('toggling an overlay flips its checked state', () => {
    render(<PreviewView manifest={makeManifest()} />);
    const collision = screen.getByTestId('preview-overlay-collision') as HTMLInputElement;
    expect(collision.checked).toBe(false);
    fireEvent.click(collision);
    expect(collision.checked).toBe(true);
  });

  it('starts with no player placed; inspector shows the placeholder message', () => {
    render(<PreviewView manifest={makeManifest()} />);
    expect(screen.queryByTestId('preview-scene-player')).not.toBeInTheDocument();
    const inspector = screen.getByTestId('preview-scene-inspector');
    expect(inspector).toHaveTextContent(/Click on the canvas/);
  });

  it('renders flag-gate halos when the flag_gates overlay is toggled on', () => {
    render(<PreviewView manifest={makeManifest()} />);
    // Toggle flag_gates on
    fireEvent.click(screen.getByTestId('preview-overlay-flag_gates'));
    // The object event has flagId set, so a halo should render for it.
    expect(
      screen.getByTestId('preview-gate-halo-objectEvent_LittlerootTown_0'),
    ).toBeInTheDocument();
  });

  it('mounts the BuildLauncher in the preview toolbar so build can be triggered without leaving the tab', () => {
    const m = makeManifest();
    const withBuild = {
      ...m,
      buildProfile: {
        toolchain: 'agbcc+make',
        buildCommand: 'make all',
        outputPaths: ['pokeemerald.gba'],
        testCommand: null,
      },
    };
    render(<PreviewView manifest={withBuild} />);
    expect(screen.getByTestId('build-launcher')).toBeInTheDocument();
    expect(screen.getByTestId('build-launcher-run')).toHaveTextContent(/make all/);
  });

  it('mounts the BreakpointsPanel in the inspector column', () => {
    render(<PreviewView manifest={makeManifest()} />);
    expect(screen.getByTestId('bp-panel')).toBeInTheDocument();
    expect(screen.getByTestId('bp-panel-kind')).toBeInTheDocument();
    expect(screen.getByTestId('bp-panel-arm')).toBeInTheDocument();
  });

  it('arms and disarms a breakpoint via the panel controls', () => {
    render(<PreviewView manifest={makeManifest()} />);
    // Default kind is warp_taken; entity left blank means "any".
    fireEvent.click(screen.getByTestId('bp-panel-arm'));
    const list = screen.getByTestId('bp-panel-list');
    expect(list).toHaveTextContent('Armed (1)');
    // Disarm button has data-testid bp-disarm-<generated id>; just verify the
    // button exists by querying within the panel.
    const disarmBtns = list.querySelectorAll('button[data-testid^="bp-disarm-"]');
    expect(disarmBtns.length).toBe(1);
    fireEvent.click(disarmBtns[0] as HTMLButtonElement);
    expect(screen.queryByTestId('bp-panel-list')).not.toBeInTheDocument();
  });

  it('mounts the RenderCostMeter with both numeric rows', () => {
    render(<PreviewView manifest={makeManifest()} />);
    expect(screen.getByTestId('render-cost-meter')).toBeInTheDocument();
    // Both rows always render even when values are still null (display ' - ').
    expect(screen.getByTestId('render-cost-derive')).toBeInTheDocument();
    expect(screen.getByTestId('render-cost-mount')).toBeInTheDocument();
  });
});
