/**
 * Phase UX-D - MapEditor paint toolbar + tile palette.
 *
 * Porymap-inspired Toolbar with single-letter keyboard shortcuts:
 *   P = Pointer (no painting; click selects markers)
 *   N = peNcil (click + drag paints selected metatile at hovered cell)
 *   B = Bucket fill (4-direction flood fill)
 *   E = Eyedropper (click samples metatile id at cell into the palette)
 *
 * Below the toolbar: tile palette grid showing previews of every
 * metatile referenced by the current map. Click to select; the chosen
 * metatile becomes the brush.
 *
 * Phase H-RC6 (semantic-world plan §H.6) - three tab modes for the
 * palette:
 *   - "This map" (default): the existing per-map grid.
 *   - "All tilesets": dropdown picker + grid of every metatile from
 *     any detected tileset in the ROM. Lets the user paint with tiles
 *     not currently loaded on the map. Powered by manifest.tilesets[]
 *     and the existing /binary-rom-tileset route.
 *   - "Favorites": pinned tiles per project, persisted to
 *     localStorage. Click ★ on any metatile to pin/unpin.
 *
 * Backed by `usePaintStore` in state.ts.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import type { ProjectManifest } from '@rom-editor/shared';
import { usePaintStore, type PaintTool } from '../state';
import { UniversalTilePicker } from './UniversalTilePicker';
import './MapPaintToolbar.css';

interface MapPaintToolbarProps {
  /** Metatile pixel cache keyed by metatile id. Only metatiles present
   *  in this map are rendered in the "This map" tab. */
  readonly metatilePixels: ReadonlyMap<number, Uint32Array> | null;
  /** Disable the toolbar when the map isn't binary-rom (can't write). */
  readonly disabled: boolean;
  /** Phase UX-D - called when the operator presses Ctrl+Z (or clicks
   *  Undo). Argument is the popped paint edit; caller applies the
   *  inverse via editBinaryRomMapCells. */
  readonly onUndo?: () => void;
  /** Ctrl+Y / Ctrl+Shift+Z redo. */
  readonly onRedo?: () => void;
  /** Phase H-RC6 - manifest for the "All tilesets" tab. */
  readonly manifest?: ProjectManifest;
  /** Session id for fetching tilesets via /binary-rom-tileset. */
  readonly sessionId?: string | null;
  /** Phase H-RC6 - current map's primary tileset offset, used by the
   *  dual composer when previewing secondary tilesets so their
   *  metatiles render with correct palettes. */
  readonly currentMapPrimaryOffset?: number;
}

type PaletteTab = 'this-map' | 'all-tilesets' | 'favorites';

const TOOLS: ReadonlyArray<{
  tool: PaintTool;
  label: string;
  hotkey: string;
  description: string;
}> = [
  { tool: 'pointer', label: 'Pointer', hotkey: 'P', description: 'Select markers (no painting)' },
  { tool: 'pencil', label: 'Pencil', hotkey: 'N', description: 'Paint selected metatile' },
  { tool: 'fill', label: 'Fill', hotkey: 'B', description: 'Bucket fill 4-direction flood' },
  { tool: 'eyedropper', label: 'Eyedropper', hotkey: 'E', description: 'Sample metatile at cell' },
  {
    tool: 'collision',
    label: 'Collision',
    hotkey: 'C',
    description: 'Paint walkable / blocked (left = block, right = passable)',
  },
];

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName.toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;
  if (target.isContentEditable) return true;
  return false;
}

export function MapPaintToolbar({
  metatilePixels,
  disabled,
  onUndo,
  onRedo,
  manifest,
  sessionId,
  currentMapPrimaryOffset,
}: MapPaintToolbarProps) {
  const tool = usePaintStore((s) => s.tool);
  const selectedMetatileId = usePaintStore((s) => s.selectedMetatileId);
  const setTool = usePaintStore((s) => s.setTool);
  const setSelectedMetatileId = usePaintStore((s) => s.setSelectedMetatileId);
  const undoStackLen = usePaintStore((s) => s.undoStack.length);
  const redoStackLen = usePaintStore((s) => s.redoStack.length);
  const favoriteTiles = usePaintStore((s) => s.favoriteTiles);
  const toggleFavoriteTile = usePaintStore((s) => s.toggleFavoriteTile);
  const [paletteTab, setPaletteTab] = useState<PaletteTab>('this-map');
  const universalEnabled = manifest !== undefined && sessionId !== null && sessionId !== undefined;

  // Keyboard shortcuts: P/N/B/E for tools; Ctrl+Z undo + Ctrl+Y / Ctrl+Shift+Z redo.
  useEffect(() => {
    if (disabled) return;
    function onKey(e: KeyboardEvent) {
      if (e.repeat || isTypingTarget(e.target)) return;
      const key = e.key.toLowerCase();
      if ((e.ctrlKey || e.metaKey) && !e.altKey) {
        if (key === 'z' && !e.shiftKey) {
          if (onUndo) {
            e.preventDefault();
            onUndo();
          }
          return;
        }
        if (key === 'y' || (key === 'z' && e.shiftKey)) {
          if (onRedo) {
            e.preventDefault();
            onRedo();
          }
          return;
        }
      }
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const match = TOOLS.find((t) => t.hotkey.toLowerCase() === key);
      if (match) {
        e.preventDefault();
        setTool(match.tool);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setTool, disabled, onUndo, onRedo]);

  const sortedMetatileIds = useMemo(() => {
    if (!metatilePixels) return [];
    return Array.from(metatilePixels.keys()).sort((a, b) => a - b);
  }, [metatilePixels]);

  return (
    <div className="paint-toolbar" data-testid="paint-toolbar">
      <div className="paint-toolbar__row">
        <div className="paint-toolbar__tools" role="group" aria-label="Paint tools">
          {TOOLS.map((t) => (
            <button
              key={t.tool}
              type="button"
              className={`paint-toolbar__tool${
                tool === t.tool ? ' paint-toolbar__tool--active' : ''
              }`}
              title={`${t.description} (${t.hotkey})`}
              aria-label={t.label}
              data-testid={`paint-tool-${t.tool}`}
              disabled={disabled}
              onClick={() => setTool(t.tool)}
            >
              {t.label}
              <span className="paint-toolbar__tool-hotkey">{t.hotkey}</span>
            </button>
          ))}
        </div>
        <div className="paint-toolbar__status" aria-live="polite">
          {disabled ? (
            <span className="paint-toolbar__status-disabled">
              Editing requires a binary-ROM project
            </span>
          ) : (
            <>
              <span>Tool: <strong>{TOOLS.find((t) => t.tool === tool)?.label ?? tool}</strong></span>
              {(tool === 'pencil' || tool === 'fill') && (
                <span>
                  Brush: <strong>Metatile #{selectedMetatileId}</strong>
                </span>
              )}
              <span>
                History: {undoStackLen} ↶ / {redoStackLen} ↷
              </span>
            </>
          )}
        </div>
      </div>
      {(sortedMetatileIds.length > 0 || universalEnabled) && (
        <div className="paint-toolbar__palette" data-testid="paint-palette">
          {/* Phase H-RC6: three-tab palette so the user can paint from
              any tileset in the ROM without leaving the map editor.
              "This map" stays the default since most painting is in-
              current-tileset; "All tilesets" + "Favorites" unblock
              cross-tileset and per-project pinned workflows. */}
          <div className="paint-toolbar__palette-tabs" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={paletteTab === 'this-map'}
              className={`paint-toolbar__palette-tab${paletteTab === 'this-map' ? ' paint-toolbar__palette-tab--active' : ''}`}
              data-testid="palette-tab-this-map"
              onClick={() => setPaletteTab('this-map')}
            >
              This map ({sortedMetatileIds.length})
            </button>
            {universalEnabled && (
              <button
                type="button"
                role="tab"
                aria-selected={paletteTab === 'all-tilesets'}
                className={`paint-toolbar__palette-tab${paletteTab === 'all-tilesets' ? ' paint-toolbar__palette-tab--active' : ''}`}
                data-testid="palette-tab-all-tilesets"
                onClick={() => setPaletteTab('all-tilesets')}
              >
                All tilesets ({manifest?.tilesets?.length ?? 0})
              </button>
            )}
            <button
              type="button"
              role="tab"
              aria-selected={paletteTab === 'favorites'}
              className={`paint-toolbar__palette-tab${paletteTab === 'favorites' ? ' paint-toolbar__palette-tab--active' : ''}`}
              data-testid="palette-tab-favorites"
              onClick={() => setPaletteTab('favorites')}
            >
              ★ Favorites ({favoriteTiles.length})
            </button>
          </div>

          {paletteTab === 'this-map' && sortedMetatileIds.length > 0 && (
            <div className="paint-toolbar__palette-grid" data-testid="palette-grid-this-map">
              {sortedMetatileIds.map((id) => (
                <MetatileSwatch
                  key={id}
                  metatileId={id}
                  pixels={metatilePixels!.get(id)!}
                  selected={id === selectedMetatileId}
                  onClick={() => setSelectedMetatileId(id)}
                  onToggleFavorite={
                    currentMapPrimaryOffset !== undefined
                      ? () => toggleFavoriteTile(currentMapPrimaryOffset, id)
                      : undefined
                  }
                  isFavorite={
                    currentMapPrimaryOffset !== undefined &&
                    favoriteTiles.includes(`${currentMapPrimaryOffset}:${id}`)
                  }
                />
              ))}
            </div>
          )}

          {paletteTab === 'all-tilesets' && universalEnabled && manifest && sessionId && (
            <UniversalTilePicker
              manifest={manifest}
              sessionId={sessionId}
              currentMapPrimaryOffset={currentMapPrimaryOffset ?? null}
            />
          )}

          {paletteTab === 'favorites' && universalEnabled && manifest && sessionId && (
            <UniversalTilePicker
              manifest={manifest}
              sessionId={sessionId}
              currentMapPrimaryOffset={currentMapPrimaryOffset ?? null}
              favoritesOnly
            />
          )}

          {paletteTab === 'favorites' && favoriteTiles.length === 0 && !universalEnabled && (
            <div className="paint-toolbar__palette-empty">
              No favorites pinned yet. Click ★ on any metatile to pin it.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

interface MetatileSwatchProps {
  readonly metatileId: number;
  readonly pixels: Uint32Array;
  readonly selected: boolean;
  readonly onClick: () => void;
  readonly onToggleFavorite?: () => void;
  readonly isFavorite?: boolean;
}

export function MetatileSwatch({
  metatileId,
  pixels,
  selected,
  onClick,
  onToggleFavorite,
  isFavorite,
}: MetatileSwatchProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const imageData = ctx.createImageData(16, 16);
    const u8 = new Uint8ClampedArray(pixels.buffer, pixels.byteOffset, pixels.byteLength);
    imageData.data.set(u8);
    ctx.putImageData(imageData, 0, 0);
  }, [pixels]);
  return (
    <div
      className={`paint-toolbar__swatch-wrap${selected ? ' paint-toolbar__swatch-wrap--selected' : ''}`}
    >
      <button
        type="button"
        className="paint-toolbar__swatch"
        title={`Metatile #${metatileId}`}
        data-testid={`paint-swatch-${metatileId}`}
        onClick={onClick}
      >
        <canvas
          ref={canvasRef}
          width={16}
          height={16}
          style={{ imageRendering: 'pixelated', width: '32px', height: '32px' }}
        />
      </button>
      {onToggleFavorite && (
        <button
          type="button"
          className={`paint-toolbar__swatch-star${isFavorite ? ' paint-toolbar__swatch-star--on' : ''}`}
          title={isFavorite ? 'Unpin from favorites' : 'Pin to favorites'}
          data-testid={`paint-swatch-star-${metatileId}`}
          onClick={(e) => {
            e.stopPropagation();
            onToggleFavorite();
          }}
        >
          ★
        </button>
      )}
    </div>
  );
}
