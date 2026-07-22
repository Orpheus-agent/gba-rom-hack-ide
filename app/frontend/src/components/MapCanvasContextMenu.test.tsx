/**
 * Smoke tests for the Layer-2 right-click canvas menu - verify the
 * two empty-tile actions, the "convert NPC" action, agent-not-connected
 * disabled state, and Esc dismissal.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { cleanup, render, screen, fireEvent } from '@testing-library/react';
import type { ObjectEvent } from '@rom-editor/shared';
import { MapCanvasContextMenu } from './MapCanvasContextMenu';
import { useAgentStore } from '../state/agent';
import { useViewStore } from '../state';

const baseProps = {
  mapId: 'binary_map_3_19',
  mapName: 'Route 1',
  tileX: 6,
  tileY: 31,
  screenX: 100,
  screenY: 200,
};

function mockOpenConnection(): void {
  useAgentStore.setState({
    connection: { kind: 'open', sessionId: 'sess', turnCount: 0 },
    stream: {
      send: () => {},
      close: () => {},
    } as unknown as ReturnType<typeof useAgentStore.getState>['stream'],
  });
}

function mockIdleConnection(): void {
  useAgentStore.setState({
    connection: { kind: 'idle' },
    stream: null,
  });
}

const sampleNpc: ObjectEvent = {
  id: 'binary_obj_3_19_2',
  name: 'Object 2 (npc)',
  mapId: 'binary_map_3_19',
  coord: { x: 6, y: 31 },
  elevation: 3,
  kind: 'npc',
  graphicsId: 'gfx_5',
  movementType: 'movement_0',
  scriptId: null,
  flagId: null,
  trainerType: null,
  metadata: {},
};

describe('MapCanvasContextMenu', () => {
  beforeEach(() => {
    mockIdleConnection();
  });
  afterEach(() => {
    cleanup();
  });

  it('renders the two empty-tile actions when no NPC is on the tile', () => {
    render(
      <MapCanvasContextMenu
        {...baseProps}
        npcAtTile={null}
        onClose={() => {}}
      />,
    );
    expect(screen.getByTestId('map-canvas-context-menu-add-npc')).toBeTruthy();
    expect(screen.getByTestId('map-canvas-context-menu-add-trainer')).toBeTruthy();
    expect(screen.queryByTestId('map-canvas-context-menu-make-trainer')).toBeNull();
  });

  it('replaces empty-tile actions with the convert action when an NPC is on the tile', () => {
    render(
      <MapCanvasContextMenu
        {...baseProps}
        npcAtTile={sampleNpc}
        onClose={() => {}}
      />,
    );
    expect(screen.getByTestId('map-canvas-context-menu-make-trainer')).toBeTruthy();
    expect(screen.queryByTestId('map-canvas-context-menu-add-npc')).toBeNull();
    expect(screen.queryByTestId('map-canvas-context-menu-add-trainer')).toBeNull();
  });

  it('disables actions and shows a hint when the agent is not connected', () => {
    render(
      <MapCanvasContextMenu
        {...baseProps}
        npcAtTile={null}
        onClose={() => {}}
      />,
    );
    const addNpc = screen.getByTestId('map-canvas-context-menu-add-npc') as HTMLButtonElement;
    expect(addNpc.disabled).toBe(true);
    expect(screen.getByTestId('map-canvas-context-menu-hint')).toBeTruthy();
  });

  it('sends a prefilled prompt and closes when an action is clicked', () => {
    mockOpenConnection();
    const sent: string[] = [];
    useAgentStore.setState({
      sendPrompt: (text: string) => sent.push(text),
    });
    let closed = false;
    render(
      <MapCanvasContextMenu
        {...baseProps}
        npcAtTile={null}
        onClose={() => {
          closed = true;
        }}
      />,
    );
    fireEvent.click(screen.getByTestId('map-canvas-context-menu-add-trainer'));
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('Route 1');
    expect(sent[0]).toContain('(6, 31)');
    expect(sent[0]).toContain('propose_add_object_event');
    expect(sent[0]).toContain('propose_add_trainer');
    expect(sent[0]).toContain('propose_add_script_for_trainer');
    expect(closed).toBe(true);
  });

  it('closes on Escape', () => {
    let closed = false;
    render(
      <MapCanvasContextMenu
        {...baseProps}
        npcAtTile={null}
        onClose={() => {
          closed = true;
        }}
      />,
    );
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(closed).toBe(true);
  });

  // Phase 4.1C - "Boot from here"
  it('renders a "Boot from here" item that is always enabled', () => {
    render(
      <MapCanvasContextMenu
        {...baseProps}
        npcAtTile={null}
        onClose={() => {}}
      />,
    );
    const boot = screen.getByTestId('map-canvas-context-menu-boot-from-here') as HTMLButtonElement;
    expect(boot).toBeTruthy();
    // Doesn't require agent connection.
    expect(boot.disabled).toBe(false);
  });

  it('"Boot from here" sets the view-store prefill + switches to livePreview', () => {
    // Start in 'maps' view, no prefill.
    useViewStore.setState({
      activeView: 'maps',
      sceneBootPrefill: null,
    });
    let closed = false;
    render(
      <MapCanvasContextMenu
        {...baseProps}
        npcAtTile={null}
        onClose={() => {
          closed = true;
        }}
      />,
    );
    fireEvent.click(screen.getByTestId('map-canvas-context-menu-boot-from-here'));
    const state = useViewStore.getState();
    expect(state.activeView).toBe('livePreview');
    expect(state.sceneBootPrefill).toEqual({
      startingMapId: 'binary_map_3_19',
      startingPosition: { x: 6, y: 31, facing: 'down' },
    });
    expect(closed).toBe(true);
  });
});
