/**
 * Phase H-RC6 (semantic-world plan §H.6) - universal tile picker
 * inside the MapEditor's paint toolbar.
 *
 * Compact vertical layout (vs. the standalone TilesetBrowser which
 * uses a 280px-list + grid split): a dropdown picker on top to
 * choose which tileset to browse, then a scrollable grid of that
 * tileset's metatiles. Clicking a metatile sets it as the paint
 * brush via the existing `usePaintStore.selectedMetatileId`.
 *
 * Cross-tileset paint is informational in this phase: when the user
 * selects a metatile that doesn't exist on the current map's
 * primary/secondary pair, a yellow warning banner explains the
 * limitation (the painted cell will reference a metatile that the
 * runtime can't draw without swapping the map's tileset pair - 
 * full unlock lands in M10).
 *
 * The `favoritesOnly` mode hides the dropdown and shows only the
 * user's pinned metatiles, looking up each by its
 * `${tilesetOffset}:${metatileId}` key.
 */

import { useEffect, useMemo, useState } from 'react';
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
import { MetatileSwatch } from './MapPaintToolbar';

interface UniversalTilePickerProps {
  readonly manifest: ProjectManifest;
  readonly sessionId: string;
  readonly currentMapPrimaryOffset: number | null;
  readonly favoritesOnly?: boolean;
}

type FetchState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'loading' }
  | {
      readonly kind: 'loaded';
      readonly response: BinaryRomTilesetResponseLike;
      readonly pairedPrimary: BinaryRomTilesetResponseLike | null;
    }
  | { readonly kind: 'error'; readonly message: string };

export function UniversalTilePicker({
  manifest,
  sessionId,
  currentMapPrimaryOffset,
  favoritesOnly,
}: UniversalTilePickerProps): JSX.Element {
  const tilesets = manifest.tilesets ?? [];
  const setSelectedMetatileId = usePaintStore((s) => s.setSelectedMetatileId);
  const selectedMetatileId = usePaintStore((s) => s.selectedMetatileId);
  const favoriteTiles = usePaintStore((s) => s.favoriteTiles);
  const toggleFavoriteTile = usePaintStore((s) => s.toggleFavoriteTile);

  // Sort tilesets: primary first, by usage count desc, then by offset.
  const sortedTilesets = useMemo(() => {
    return [...tilesets].sort((a, b) => {
      if (a.isSecondary !== b.isSecondary) return a.isSecondary ? 1 : -1;
      if (a.usageCount !== b.usageCount) return b.usageCount - a.usageCount;
      return a.structFileOffset - b.structFileOffset;
    });
  }, [tilesets]);

  // The Real Game Editor Push - boundaries are derived from the actual
  // primary tileset response inside TilesetMetatileGrid. The game-code
  // default is only used as a fallback when no primary is loaded yet.
  const gameCode = manifest.identity.romHeader?.gameCode ?? null;

  // Default to the current map's primary tileset if set, else the
  // first detected tileset.
  const initialTilesetId = useMemo(() => {
    if (currentMapPrimaryOffset !== null) {
      const match = sortedTilesets.find((t) => t.structFileOffset === currentMapPrimaryOffset);
      if (match) return match.id;
    }
    return sortedTilesets[0]?.id ?? null;
  }, [sortedTilesets, currentMapPrimaryOffset]);

  const [selectedTilesetId, setSelectedTilesetId] = useState<string | null>(initialTilesetId);
  const [fetchState, setFetchState] = useState<FetchState>({ kind: 'idle' });

  useEffect(() => {
    if (selectedTilesetId === null && initialTilesetId !== null) {
      setSelectedTilesetId(initialTilesetId);
    }
  }, [initialTilesetId, selectedTilesetId]);

  const selectedTileset = useMemo(
    () => sortedTilesets.find((t) => t.id === selectedTilesetId) ?? null,
    [sortedTilesets, selectedTilesetId],
  );

  // For favorites mode, parse the unique tileset offsets from the
  // favorite keys so we can fetch each tileset only once.
  const favoriteTilesetOffsets = useMemo(() => {
    if (!favoritesOnly) return [];
    const set = new Set<number>();
    for (const key of favoriteTiles) {
      const [offStr] = key.split(':');
      const off = parseInt(offStr ?? '', 10);
      if (Number.isFinite(off)) set.add(off);
    }
    return Array.from(set);
  }, [favoritesOnly, favoriteTiles]);

  if (favoritesOnly) {
    if (favoriteTiles.length === 0) {
      return (
        <div className="paint-toolbar__palette-empty">
          No favorites pinned yet. Click ★ on any metatile in "This map" or
          "All tilesets" to pin it.
        </div>
      );
    }
    return (
      <FavoriteTilesGrid
        manifest={manifest}
        sessionId={sessionId}
        tilesetOffsets={favoriteTilesetOffsets}
        favoriteKeys={favoriteTiles}
        selectedMetatileId={selectedMetatileId}
        onPickMetatile={(id) => setSelectedMetatileId(id)}
        onToggleFavorite={toggleFavoriteTile}
      />
    );
  }

  // Fetch the selected tileset on demand.
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
        if (
          selectedTileset.isSecondary &&
          currentMapPrimaryOffset !== null &&
          currentMapPrimaryOffset > 0
        ) {
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

  if (sortedTilesets.length === 0) {
    return (
      <div className="paint-toolbar__palette-empty">
        No tilesets detected. Re-scan the project to populate this picker.
      </div>
    );
  }

  return (
    <div className="universal-tile-picker" data-testid="universal-tile-picker">
      <div className="universal-tile-picker__header">
        <label className="universal-tile-picker__select-label">
          Tileset
          <select
            value={selectedTilesetId ?? ''}
            onChange={(e) => setSelectedTilesetId(e.target.value)}
            data-testid="universal-tile-picker-select"
          >
            {sortedTilesets.map((t) => (
              <option key={t.id} value={t.id}>
                {t.isSecondary ? 'Secondary' : 'Primary'} @ 0x
                {t.structFileOffset.toString(16)} · used by {t.usageCount} map
                {t.usageCount === 1 ? '' : 's'}
              </option>
            ))}
          </select>
        </label>
      </div>
      {selectedTileset && (
        <TilesetMetatileGrid
          tileset={selectedTileset}
          fetchState={fetchState}
          gameCode={gameCode}
          selectedMetatileId={selectedMetatileId}
          onPickMetatile={(id) => setSelectedMetatileId(id)}
          onToggleFavorite={(metaId) =>
            toggleFavoriteTile(selectedTileset.structFileOffset, metaId)
          }
          favoriteKeys={favoriteTiles}
        />
      )}
    </div>
  );
}

interface TilesetMetatileGridProps {
  readonly tileset: TilesetEntry;
  readonly fetchState: FetchState;
  readonly gameCode: string | null;
  readonly selectedMetatileId: number;
  readonly onPickMetatile: (id: number) => void;
  readonly onToggleFavorite: (metatileId: number) => void;
  readonly favoriteKeys: ReadonlyArray<string>;
}

function TilesetMetatileGrid({
  tileset,
  fetchState,
  gameCode,
  selectedMetatileId,
  onPickMetatile,
  onToggleFavorite,
  favoriteKeys,
}: TilesetMetatileGridProps): JSX.Element {
  // The Real Game Editor Push - auto-detect boundaries from the actual
  // primary (selected tileset itself if primary, paired primary if
  // viewing a secondary). Falls back to game-code defaults for ROMs
  // where the response can't be trusted.
  const metatilePixels = useMemo<ReadonlyMap<number, Uint32Array> | null>(() => {
    if (fetchState.kind !== 'loaded') return null;
    const primaryForBoundaries = tileset.isSecondary
      ? fetchState.pairedPrimary
      : fetchState.response;
    const boundaries = tilesetBoundariesForRom(primaryForBoundaries, gameCode);
    const offset = tileset.isSecondary ? boundaries.numMetatilesInPrimary : 0;
    const fakeMapData = {
      width: 1,
      height: fetchState.response.metatileSpecs.length,
      cells: fetchState.response.metatileSpecs.map((_, i) => ({
        metatileId: offset + i,
        collision: 0,
        elevation: 0,
      })),
    };
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

  if (fetchState.kind === 'loading') {
    return <div className="paint-toolbar__palette-empty">Loading tileset…</div>;
  }
  if (fetchState.kind === 'error') {
    return (
      <div className="paint-toolbar__palette-empty paint-toolbar__palette-empty--error">
        Failed to load tileset: {fetchState.message}
      </div>
    );
  }
  if (!metatilePixels || metatilePixels.size === 0) {
    return <div className="paint-toolbar__palette-empty">No metatiles in this tileset.</div>;
  }

  const metatileIds = Array.from(metatilePixels.keys()).sort((a, b) => a - b);

  return (
    <div className="paint-toolbar__palette-grid" data-testid="universal-tile-picker-grid">
      {metatileIds.map((id) => {
        const pixels = metatilePixels.get(id);
        if (!pixels) return null;
        const favKey = `${tileset.structFileOffset}:${id}`;
        return (
          <MetatileSwatch
            key={id}
            metatileId={id}
            pixels={pixels}
            selected={id === selectedMetatileId}
            onClick={() => onPickMetatile(id)}
            onToggleFavorite={() => onToggleFavorite(id)}
            isFavorite={favoriteKeys.includes(favKey)}
          />
        );
      })}
    </div>
  );
}

interface FavoriteTilesGridProps {
  readonly manifest: ProjectManifest;
  readonly sessionId: string;
  readonly tilesetOffsets: ReadonlyArray<number>;
  readonly favoriteKeys: ReadonlyArray<string>;
  readonly selectedMetatileId: number;
  readonly onPickMetatile: (id: number) => void;
  readonly onToggleFavorite: (tilesetOffset: number, metatileId: number) => void;
}

function FavoriteTilesGrid({
  manifest,
  sessionId,
  tilesetOffsets,
  favoriteKeys,
  selectedMetatileId,
  onPickMetatile,
  onToggleFavorite,
}: FavoriteTilesGridProps): JSX.Element {
  // Fetch every tileset that has at least one favorite tile.
  const [pixelsByKey, setPixelsByKey] = useState<ReadonlyMap<string, Uint32Array> | null>(null);

  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;
    void (async () => {
      const tilesetFetches = await Promise.allSettled(
        tilesetOffsets.map(async (off) => {
          const r = await fetchBinaryRomTileset(sessionId, { tilesetStructOffset: off });
          return { offset: off, response: r };
        }),
      );
      if (cancelled) return;
      const tilesetByOffset = new Map<
        number,
        { response: BinaryRomTilesetResponseLike; entry: TilesetEntry | null }
      >();
      for (const r of tilesetFetches) {
        if (r.status !== 'fulfilled') continue;
        const { offset, response } = r.value;
        const entry = (manifest.tilesets ?? []).find((t) => t.structFileOffset === offset) ?? null;
        tilesetByOffset.set(offset, { response, entry });
      }
      // Compose each favorite's metatile pixels.
      const out = new Map<string, Uint32Array>();
      for (const key of favoriteKeys) {
        const [offStr, idStr] = key.split(':');
        const off = parseInt(offStr ?? '', 10);
        const metaId = parseInt(idStr ?? '', 10);
        if (!Number.isFinite(off) || !Number.isFinite(metaId)) continue;
        const t = tilesetByOffset.get(off);
        if (!t) continue;
        const fakeMap = {
          width: 1,
          height: 1,
          cells: [{ metatileId: metaId, collision: 0, elevation: 0 }],
        };
        // We don't have the paired primary for secondaries, so favorites
        // of secondary metatiles may render with wrong palettes - that's
        // acceptable for a preview (the actual paint uses just the
        // metatile id; rendering is best-effort).
        const composed = composeBinaryRomMetatilePixels(t.response, fakeMap);
        const pixels = composed.get(metaId);
        if (pixels) out.set(key, pixels);
      }
      if (!cancelled) setPixelsByKey(out);
    })();
    return () => {
      cancelled = true;
    };
  }, [sessionId, tilesetOffsets, favoriteKeys, manifest.tilesets]);

  if (pixelsByKey === null) {
    return <div className="paint-toolbar__palette-empty">Loading favorites…</div>;
  }

  return (
    <div className="paint-toolbar__palette-grid" data-testid="favorites-tile-grid">
      {favoriteKeys.map((key) => {
        const pixels = pixelsByKey.get(key);
        const [offStr, idStr] = key.split(':');
        const off = parseInt(offStr ?? '', 10);
        const metaId = parseInt(idStr ?? '', 10);
        if (!pixels || !Number.isFinite(off) || !Number.isFinite(metaId)) {
          return (
            <div
              key={key}
              className="paint-toolbar__swatch-wrap paint-toolbar__swatch-wrap--missing"
              title={`Favorite ${key} not loadable`}
            >
              <button
                type="button"
                className="paint-toolbar__swatch-star paint-toolbar__swatch-star--on"
                onClick={() => onToggleFavorite(off, metaId)}
              >
                ✕
              </button>
            </div>
          );
        }
        return (
          <MetatileSwatch
            key={key}
            metatileId={metaId}
            pixels={pixels}
            selected={metaId === selectedMetatileId}
            onClick={() => onPickMetatile(metaId)}
            onToggleFavorite={() => onToggleFavorite(off, metaId)}
            isFavorite={true}
          />
        );
      })}
    </div>
  );
}
