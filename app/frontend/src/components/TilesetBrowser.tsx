/**
 * Phase F (semantic-world plan §3.2) - Universal tileset browser.
 *
 * The current paint palette (`MapPaintToolbar`) only shows metatiles
 * referenced by the currently-loaded map's primary+secondary tilesets.
 * For real creative editing the operator needs to discover every
 * tileset in the ROM - cave tilesets while editing an outdoor route,
 * gym interiors while editing a route, decoration tilesets across the
 * region. This component surfaces `manifest.tilesets[]` (Phase 3.1
 * lifter) as a navigable list:
 *
 *  - Left column: all detected tilesets grouped by primary/secondary,
 *    sortable by usage count, each card showing struct offset and
 *    usage info ("used by 23 maps").
 *  - Right column: when a tileset is picked, fetches its tiles +
 *    palettes + metatileSpecs via the existing
 *    `/api/projects/:id/binary-rom-tileset` route and renders each
 *    metatile in a clickable 16×16 grid. Selecting a metatile updates
 *    the paint store so the next pencil stroke uses it.
 *
 * Scope notes:
 *  - PRIMARY tilesets render fully (their metatiles only reference
 *    tile indices 0..639 and palettes 0..6 in FRLG - all in the
 *    fetched response). SECONDARY tilesets reference tile indices
 *    640..1023 + palettes 7..12, which require a paired primary at
 *    composition time. For secondaries we render best-effort with
 *    just-the-secondary's-data (some metatiles will look wrong);
 *    cross-tileset paint with proper pair selection lands in §3.3 /
 *    Milestone M10.
 *  - The browser is read-only for tileset structure. Editing tileset
 *    contents (tile-pixel painting, palette replacement) is a future
 *    surface - this iter only enables painting with discovered
 *    metatile IDs.
 *  - No search/category/favorites in this iteration - those add up
 *    quickly and the list is small enough (~20-50 tilesets in vanilla
 *    FRLG) that scrolling is fine. Follow-up: virtualization +
 *    semantic tagging once usable evidence accumulates.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import type { ProjectManifest, TilesetEntry } from '@rom-editor/shared';
import {
  fetchBinaryRomTileset,
  ProjectApiError,
  type BinaryRomTilesetResponseLike,
} from '../api';
import { usePaintStore } from '../state';
import {
  composeBinaryRomMetatilePixels,
  composeBinaryRomMetatilePixelsDual,
  tilesetBoundariesForRom,
} from '../lib/binaryRomTiles';
import './TilesetBrowser.css';

type FetchState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'loading' }
  | {
      readonly kind: 'loaded';
      readonly response: BinaryRomTilesetResponseLike;
      readonly pairedPrimary: BinaryRomTilesetResponseLike | null;
    }
  | { readonly kind: 'error'; readonly message: string };

interface TilesetBrowserProps {
  readonly manifest: ProjectManifest;
  readonly sessionId: string | null;
  /** Optional: the primary tileset offset of the currently-loaded map.
   *  Used to pair a secondary tileset with a primary for correct
   *  metatile composition when rendering secondaries. */
  readonly currentMapPrimaryOffset?: number;
}

export function TilesetBrowser({
  manifest,
  sessionId,
  currentMapPrimaryOffset,
}: TilesetBrowserProps): JSX.Element {
  const tilesets = manifest.tilesets ?? [];
  // The Real Game Editor Push - boundaries are derived from the fetched
  // primary tileset response inside TilesetDetail. The game-code default
  // is only used as a seed/fallback when no primary is yet fetched.
  const gameCode = manifest.identity.romHeader?.gameCode ?? null;

  // Sort: primaries first, then by usage count desc, then by file offset.
  const sortedTilesets = useMemo(() => {
    return [...tilesets].sort((a, b) => {
      if (a.isSecondary !== b.isSecondary) return a.isSecondary ? 1 : -1;
      if (a.usageCount !== b.usageCount) return b.usageCount - a.usageCount;
      return a.structFileOffset - b.structFileOffset;
    });
  }, [tilesets]);

  const [selectedTilesetId, setSelectedTilesetId] = useState<string | null>(null);
  const [fetchState, setFetchState] = useState<FetchState>({ kind: 'idle' });

  const selectedTileset = useMemo(
    () => sortedTilesets.find((t) => t.id === selectedTilesetId) ?? null,
    [sortedTilesets, selectedTilesetId],
  );

  // Fetch the selected tileset + (when it's a secondary) the paired
  // primary so we can compose correctly via composeBinaryRomMetatilePixelsDual.
  useEffect(() => {
    if (!sessionId || !selectedTileset) {
      setFetchState({ kind: 'idle' });
      return;
    }
    let cancelled = false;
    setFetchState({ kind: 'loading' });
    void (async () => {
      try {
        const response = await fetchBinaryRomTileset(sessionId, {
          tilesetStructOffset: selectedTileset.structFileOffset,
        });
        let pairedPrimary: BinaryRomTilesetResponseLike | null = null;
        if (selectedTileset.isSecondary && currentMapPrimaryOffset && currentMapPrimaryOffset > 0) {
          // Best-effort paired primary fetch so the secondary's metatiles
          // composite correctly. Failures degrade to single-tileset mode.
          pairedPrimary = await fetchBinaryRomTileset(sessionId, {
            tilesetStructOffset: currentMapPrimaryOffset,
          }).catch(() => null);
        }
        if (cancelled) return;
        setFetchState({ kind: 'loaded', response, pairedPrimary });
      } catch (e) {
        if (cancelled) return;
        const msg =
          e instanceof ProjectApiError
            ? `${e.code}: ${e.message}`
            : e instanceof Error
              ? e.message
              : String(e);
        setFetchState({ kind: 'error', message: msg });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sessionId, selectedTileset, currentMapPrimaryOffset]);

  return (
    <div className="tileset-browser" data-testid="tileset-browser">
      <div className="tileset-browser__list" role="list">
        <div className="tileset-browser__list-heading">
          Tilesets ({tilesets.length})
        </div>
        {tilesets.length === 0 ? (
          <p className="tileset-browser__empty">
            No tilesets detected. Open a binary-ROM project to populate this list.
          </p>
        ) : (
          sortedTilesets.map((t) => (
            <TilesetListItem
              key={t.id}
              tileset={t}
              selected={t.id === selectedTilesetId}
              onClick={() => setSelectedTilesetId(t.id)}
            />
          ))
        )}
      </div>
      <div className="tileset-browser__detail">
        {selectedTileset ? (
          <TilesetDetail
            tileset={selectedTileset}
            fetchState={fetchState}
            gameCode={gameCode}
          />
        ) : (
          <p className="tileset-browser__detail-empty">
            Select a tileset to preview its metatiles.
          </p>
        )}
      </div>
    </div>
  );
}

interface TilesetListItemProps {
  readonly tileset: TilesetEntry;
  readonly selected: boolean;
  readonly onClick: () => void;
}

function TilesetListItem({ tileset, selected, onClick }: TilesetListItemProps): JSX.Element {
  const offsetHex = `0x${tileset.structFileOffset.toString(16)}`;
  return (
    <button
      type="button"
      role="listitem"
      className={`tileset-browser__item${selected ? ' tileset-browser__item--selected' : ''}`}
      onClick={onClick}
      data-testid={`tileset-item-${tileset.id}`}
    >
      <div className="tileset-browser__item-header">
        <span
          className={`tileset-browser__item-tag tileset-browser__item-tag--${
            tileset.isSecondary ? 'secondary' : 'primary'
          }`}
        >
          {tileset.isSecondary ? 'Secondary' : 'Primary'}
        </span>
        <span className="tileset-browser__item-offset">{offsetHex}</span>
      </div>
      <div className="tileset-browser__item-meta">
        Used by {tileset.usageCount} map{tileset.usageCount === 1 ? '' : 's'}
        {tileset.isCompressed ? ' · LZ77' : ''}
      </div>
    </button>
  );
}

interface TilesetDetailProps {
  readonly tileset: TilesetEntry;
  readonly fetchState: FetchState;
  readonly gameCode: string | null;
}

function TilesetDetail({ tileset, fetchState, gameCode }: TilesetDetailProps): JSX.Element {
  const setSelectedMetatileId = usePaintStore((s) => s.setSelectedMetatileId);
  const selectedMetatileId = usePaintStore((s) => s.selectedMetatileId);

  // Compose all metatile previews from the fetched tileset response.
  // For primaries: use the single-tileset composer.
  // For secondaries with a paired primary: use the dual composer so
  // tile/palette indices spanning the boundary look right.
  //
  // The Real Game Editor Push - boundaries are derived from the actual
  // primary response (the selected tileset itself if it's a primary, or
  // the paired primary when viewing a secondary) instead of hardcoded by
  // cartridge game code, so CFRU/Unbound's relocated boundaries render
  // correctly.
  const metatilePixels = useMemo<ReadonlyMap<number, Uint32Array> | null>(() => {
    if (fetchState.kind !== 'loaded') return null;
    const primaryForBoundaries = tileset.isSecondary
      ? fetchState.pairedPrimary
      : fetchState.response;
    const boundaries = tilesetBoundariesForRom(primaryForBoundaries, gameCode);
    const fakeMapData = makeFakeMapDataCoveringAllMetatiles(fetchState.response, tileset, boundaries);
    if (tileset.isSecondary && fetchState.pairedPrimary) {
      return composeBinaryRomMetatilePixelsDual(
        fetchState.pairedPrimary,
        fetchState.response,
        fakeMapData,
        boundaries,
      );
    }
    return composeBinaryRomMetatilePixels(fetchState.response, fakeMapData);
  }, [fetchState, tileset, gameCode]);

  const metatileIds = useMemo(() => {
    if (!metatilePixels) return [];
    return Array.from(metatilePixels.keys()).sort((a, b) => a - b);
  }, [metatilePixels]);

  if (fetchState.kind === 'loading') {
    return <p className="tileset-browser__detail-empty">Loading tileset…</p>;
  }
  if (fetchState.kind === 'error') {
    return (
      <p className="tileset-browser__detail-error" data-testid="tileset-detail-error">
        Failed to load tileset: {fetchState.message}
      </p>
    );
  }
  if (fetchState.kind !== 'loaded' || !metatilePixels) {
    return <p className="tileset-browser__detail-empty">Select a tileset.</p>;
  }

  return (
    <div className="tileset-browser__detail-loaded">
      <div className="tileset-browser__detail-header">
        <div>
          <strong>
            {tileset.isSecondary ? 'Secondary' : 'Primary'} tileset @ 0x
            {tileset.structFileOffset.toString(16)}
          </strong>
          <span className="tileset-browser__detail-meta">
            {fetchState.response.tileCount} tiles · {fetchState.response.metatileSpecs.length}{' '}
            metatiles
          </span>
        </div>
        {tileset.isSecondary && !fetchState.pairedPrimary && (
          <p className="tileset-browser__detail-note">
            No paired primary loaded - some metatiles may render with the wrong
            colors. Open a map that uses this secondary to view it accurately.
          </p>
        )}
      </div>
      <div className="tileset-browser__grid" data-testid="tileset-browser-grid">
        {metatileIds.map((id) => {
          const pixels = metatilePixels.get(id);
          if (!pixels) return null;
          return (
            <MetatilePreview
              key={id}
              metatileId={id}
              pixels={pixels}
              selected={id === selectedMetatileId}
              onClick={() => setSelectedMetatileId(id)}
            />
          );
        })}
      </div>
    </div>
  );
}

interface MetatilePreviewProps {
  readonly metatileId: number;
  readonly pixels: Uint32Array;
  readonly selected: boolean;
  readonly onClick: () => void;
}

function MetatilePreview({
  metatileId,
  pixels,
  selected,
  onClick,
}: MetatilePreviewProps): JSX.Element {
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
    <button
      type="button"
      className={`tileset-browser__swatch${selected ? ' tileset-browser__swatch--selected' : ''}`}
      title={`Metatile #${metatileId}`}
      data-testid={`tileset-browser-swatch-${metatileId}`}
      onClick={onClick}
    >
      <canvas
        ref={canvasRef}
        width={16}
        height={16}
        style={{ imageRendering: 'pixelated', width: '32px', height: '32px' }}
      />
    </button>
  );
}

/** Build a synthetic map-data response that references every metatile
 *  in the tileset exactly once, so the existing composer functions
 *  yield a Map<metatileId, Uint32Array> we can iterate. */
function makeFakeMapDataCoveringAllMetatiles(
  tileset: BinaryRomTilesetResponseLike,
  registry: TilesetEntry,
  boundaries: { numMetatilesInPrimary: number },
): { width: number; height: number; cells: ReadonlyArray<{ metatileId: number; collision: number; elevation: number }> } {
  // Secondary tilesets' metatileSpecs are indexed 0..N-1 in the response,
  // but the unified ID space puts them at numMetatilesInPrimary..1023.
  const offset = registry.isSecondary ? boundaries.numMetatilesInPrimary : 0;
  const cells = tileset.metatileSpecs.map((_, i) => ({
    metatileId: offset + i,
    collision: 0,
    elevation: 0,
  }));
  return {
    width: 1,
    height: cells.length,
    cells,
  };
}
