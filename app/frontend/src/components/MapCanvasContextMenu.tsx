/**
 * Layer 2 - canvas-native agent invocation.
 *
 * Right-click context menu rendered over the MapEditor canvas. Offers
 * "Add NPC here" / "Add trainer here" and, when an NPC already exists
 * at the clicked tile, "Make this NPC a trainer". Each action sends a
 * prefilled prompt to the agent panel via `useAgentStore.sendPrompt`
 * - the user doesn't have to type coords or look up entity ids.
 *
 * The agent will resolve the prompt through the three Layer-1 tools:
 *   - propose_add_object_event (new NPC at the clicked tile)
 *   - propose_add_trainer       (claim a new gTrainers slot)
 *   - propose_add_script_for_trainer (bind the NPC to the trainer)
 *
 * Positioning: `position: fixed` at the cursor's screen coords, so the
 * menu lives outside the canvas-wrap transform. Closes on outside
 * click, Escape, or scroll.
 */

import { useEffect, useRef } from 'react';
import type { ObjectEvent } from '@rom-editor/shared';
import { useAgentStore } from '../state/agent';
import { useViewStore } from '../state';
import './MapCanvasContextMenu.css';

export interface MapCanvasContextMenuProps {
  readonly mapId: string;
  readonly mapName: string;
  readonly tileX: number;
  readonly tileY: number;
  readonly screenX: number;
  readonly screenY: number;
  /** Existing NPC on the clicked tile, or null when the tile is empty. */
  readonly npcAtTile: ObjectEvent | null;
  /** Decomp project: "Add NPC here" writes map.json directly (no agent). */
  readonly isDecomp?: boolean;
  /** Direct decomp add - appends an ObjectEvent to the map's map.json. */
  readonly onAddNpcDirect?: (tileX: number, tileY: number) => void;
  /** Decomp: add/bind a talking NPC (creates a msgbox script). */
  readonly onAddTalkNpc?: (tileX: number, tileY: number) => void;
  /** Decomp: make a trainer (trainers.party entry + battle script + bind). */
  readonly onMakeTrainer?: (tileX: number, tileY: number) => void;
  readonly onClose: () => void;
}

export function MapCanvasContextMenu({
  mapId,
  mapName,
  tileX,
  tileY,
  screenX,
  screenY,
  npcAtTile,
  isDecomp = false,
  onAddNpcDirect,
  onAddTalkNpc,
  onMakeTrainer,
  onClose,
}: MapCanvasContextMenuProps) {
  const menuRef = useRef<HTMLDivElement | null>(null);
  const sendPrompt = useAgentStore((s) => s.sendPrompt);
  const connectionKind = useAgentStore((s) => s.connection.kind);
  const isConnected = connectionKind === 'open';
  // Phase 4.1C - "Boot from here" routes through the view store so the
  // SceneBootPicker (which lives in the livePreview view) picks up the
  // prefill on mount.
  const bootFromHere = useViewStore((s) => s.bootFromHere);

  // Close on outside click / Esc / scroll. Mirrors AddEventPopover's
  // dismissal pattern so the canvas chrome feels consistent.
  useEffect(() => {
    function onDocPointerDown(e: PointerEvent): void {
      const el = menuRef.current;
      if (!el) return;
      if (e.target instanceof Node && el.contains(e.target)) return;
      onClose();
    }
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    }
    function onScroll(): void {
      onClose();
    }
    document.addEventListener('pointerdown', onDocPointerDown);
    document.addEventListener('keydown', onKey);
    document.addEventListener('scroll', onScroll, true);
    return () => {
      document.removeEventListener('pointerdown', onDocPointerDown);
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('scroll', onScroll, true);
    };
  }, [onClose]);

  function send(text: string): void {
    sendPrompt(text);
    onClose();
  }

  // Style anchors at the cursor; nudge in on the right + bottom edges
  // so the menu doesn't get clipped against the viewport.
  const MENU_W = 280;
  const MENU_H_ESTIMATE = 200;
  const vw = typeof window !== 'undefined' ? window.innerWidth : 1024;
  const vh = typeof window !== 'undefined' ? window.innerHeight : 768;
  const left = Math.min(screenX, Math.max(8, vw - MENU_W - 8));
  const top = Math.min(screenY, Math.max(8, vh - MENU_H_ESTIMATE - 8));

  const coords = `(${String(tileX)}, ${String(tileY)})`;

  return (
    <div
      ref={menuRef}
      className="map-canvas-context-menu"
      data-testid="map-canvas-context-menu"
      style={{ left, top, width: MENU_W }}
      role="menu"
    >
      <div className="map-canvas-context-menu__header">
        {coords} on {mapName}
      </div>
      {!isDecomp && !isConnected && (
        <div className="map-canvas-context-menu__hint" data-testid="map-canvas-context-menu-hint">
          Agent isn't connected - open the Agent panel and connect to use
          these actions.
        </div>
      )}
      {/* Phase 4.1C - Boot from here. Switches to the livePreview view
          and pre-fills the SceneBootPicker composer with this map + tile
          coordinates. Always available - doesn't require agent connection. */}
      <button
        type="button"
        className="map-canvas-context-menu__item"
        onClick={() => {
          bootFromHere({
            startingMapId: mapId,
            startingPosition: { x: tileX, y: tileY, facing: 'down' },
          });
          onClose();
        }}
        data-testid="map-canvas-context-menu-boot-from-here"
      >
        <span className="map-canvas-context-menu__item-title">
          🎬 Boot from here
        </span>
        <span className="map-canvas-context-menu__item-sub">
          Open the scene-boot composer pre-filled with {coords}
        </span>
      </button>
      {isDecomp ? (
        npcAtTile ? (
          <>
            <button
              type="button"
              className="map-canvas-context-menu__item"
              onClick={() => {
                onAddTalkNpc?.(tileX, tileY);
                onClose();
              }}
              data-testid="map-canvas-context-menu-give-dialogue"
            >
              <span className="map-canvas-context-menu__item-title">💬 Give this NPC dialogue…</span>
              <span className="map-canvas-context-menu__item-sub">Creates a msgbox script + binds it to {npcAtTile.id}</span>
            </button>
            <button
              type="button"
              className="map-canvas-context-menu__item"
              onClick={() => {
                onMakeTrainer?.(tileX, tileY);
                onClose();
              }}
              data-testid="map-canvas-context-menu-make-trainer"
            >
              <span className="map-canvas-context-menu__item-title">⚔ Make this a trainer…</span>
              <span className="map-canvas-context-menu__item-sub">trainers.party entry + battle script + bind</span>
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              className="map-canvas-context-menu__item"
              onClick={() => {
                onAddNpcDirect?.(tileX, tileY);
                onClose();
              }}
              data-testid="map-canvas-context-menu-add-npc"
            >
              <span className="map-canvas-context-menu__item-title">＋ Add NPC here</span>
              <span className="map-canvas-context-menu__item-sub">Plain NPC · set its sprite / script after</span>
            </button>
            <button
              type="button"
              className="map-canvas-context-menu__item"
              onClick={() => {
                onAddTalkNpc?.(tileX, tileY);
                onClose();
              }}
              data-testid="map-canvas-context-menu-add-talk-npc"
            >
              <span className="map-canvas-context-menu__item-title">💬 Add talking NPC here…</span>
              <span className="map-canvas-context-menu__item-sub">NPC + a line of dialogue</span>
            </button>
            <button
              type="button"
              className="map-canvas-context-menu__item"
              onClick={() => {
                onMakeTrainer?.(tileX, tileY);
                onClose();
              }}
              data-testid="map-canvas-context-menu-add-trainer-decomp"
            >
              <span className="map-canvas-context-menu__item-title">⚔ Add trainer here…</span>
              <span className="map-canvas-context-menu__item-sub">NPC + trainers.party entry + battle script</span>
            </button>
          </>
        )
      ) : npcAtTile ? (
        <button
          type="button"
          className="map-canvas-context-menu__item"
          disabled={!isConnected}
          onClick={() =>
            send(
              `On ${mapId} (${mapName}), convert the existing NPC ${npcAtTile.id} at ${coords} into a trainer. ` +
                `Use propose_add_trainer to claim a new gTrainers slot (ask me what species/level/moves to use before adding the trainer), ` +
                `then propose_add_script_for_trainer to bind ${npcAtTile.id} to the new trainerId.`,
            )
          }
          data-testid="map-canvas-context-menu-make-trainer"
        >
          <span className="map-canvas-context-menu__item-title">
            Make this NPC a trainer…
          </span>
          <span className="map-canvas-context-menu__item-sub">
            Existing {npcAtTile.id}
          </span>
        </button>
      ) : (
        <>
          <button
            type="button"
            className="map-canvas-context-menu__item"
            disabled={!isConnected}
            onClick={() =>
              send(
                `On ${mapId} (${mapName}), place a new NPC at ${coords} facing down. ` +
                  `Use propose_add_object_event. Pick a sensible default graphicsId (5 = boy) and movementType (0 = static facing down) unless I say otherwise.`,
              )
            }
            data-testid="map-canvas-context-menu-add-npc"
          >
            <span className="map-canvas-context-menu__item-title">
              Add NPC here
            </span>
            <span className="map-canvas-context-menu__item-sub">
              Plain NPC, no script
            </span>
          </button>
          <button
            type="button"
            className="map-canvas-context-menu__item"
            disabled={!isConnected}
            onClick={() =>
              send(
                `On ${mapId} (${mapName}), place a new trainer NPC at ${coords} facing down. ` +
                  `Use the full sequence: propose_add_object_event (new NPC), propose_add_trainer (new gTrainers slot - ask me what species/level/moves to use before submitting), ` +
                  `then propose_add_script_for_trainer (bind the new NPC to the new trainerId).`,
              )
            }
            data-testid="map-canvas-context-menu-add-trainer"
          >
            <span className="map-canvas-context-menu__item-title">
              Add trainer here…
            </span>
            <span className="map-canvas-context-menu__item-sub">
              NPC + trainer slot + battle script
            </span>
          </button>
        </>
      )}
    </div>
  );
}
