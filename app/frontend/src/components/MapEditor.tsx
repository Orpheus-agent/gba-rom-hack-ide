import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  LayoutData,
  MapNode,
  ObjectEvent,
  ProjectManifest,
  Trigger,
  Warp,
} from '@rom-editor/shared';
import { GROUP_COLORS } from './MapsGraph';
import { renderMapScene, type MapSceneOptions } from './mapEditorScene';
import {
  editBinaryRomMapCells,
  fetchBinaryRomMapData,
  fetchBinaryRomOwSprite,
  fetchBinaryRomTileset,
  fetchLayout,
  fetchLayoutTiles,
  moveEvent as apiMoveEvent,
  editBinaryRomHealLocation,
  addDecompObjectEvent,
  addDecompTalkNpc,
  makeDecompTrainer,
  ProjectApiError,
} from '../api';
import {
  pushToast,
  useProjectStore,
  useUiPreferencesStore,
  usePaintStore,
  useSelection,
  useViewStore,
  type EntityKind,
} from '../state';
import { displayName, prettifyMapGroup, prettifyMapName } from '../lib/displayName';
import {
  composeBinaryRomMetatilePixels,
  composeBinaryRomMetatilePixelsDual,
  computeMissingMetatiles,
  tilesetBoundariesForGameCode,
  tilesetBoundariesForRom,
  type TilesetBoundaries,
} from '../lib/binaryRomTiles';
import { MapPaintToolbar } from './MapPaintToolbar';
import {
  ObjectEventFieldsEditor,
  WarpFieldsEditor,
} from './MapEntityFieldsEditor';
import { ScriptStepsList } from './inspector/ScriptStepsList';
import { VisualScriptEditor } from './script/VisualScriptEditor';
import { TilePropertiesEditor } from './inspector/TilePropertiesEditor';
import { MapHeaderEditor } from './inspector/MapHeaderEditor';
import { MapResizeModal } from './MapResizeModal';
import { TriggerFieldsEditor } from './inspector/TriggerFieldsEditor';
import { TrainerPartyView } from './inspector/TrainerPartyView';
import { MapCanvasContextMenu } from './MapCanvasContextMenu';
import './MapEditor.css';

type LayerKey =
  | 'tiles'
  | 'collision'
  | 'objects'
  | 'warps'
  | 'triggers'
  | 'healLocations'
  | 'visionCones';

const DEFAULT_LAYERS: ReadonlyArray<LayerKey> = [
  'tiles',
  'objects',
  'warps',
  'triggers',
  'healLocations',
  'visionCones',
];
const TILE_SIZE_PX = 16;

interface SelectedMarker {
  readonly kind: 'objectEvent' | 'warp' | 'trigger';
  readonly id: string;
}

type LayoutState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'loading' }
  | { readonly kind: 'loaded'; readonly data: LayoutData }
  | { readonly kind: 'error'; readonly message: string };

interface MapEditorProps {
  readonly manifest: ProjectManifest;
  readonly map: MapNode;
  readonly onClose: () => void;
}

/** Iter-95 lifter writes ObjectEvent.name as `Object 5 (npc)` - 
 *  user-friendly enough but the synthetic id slips through if not
 *  prettified. Drop the wrapping parens kind suffix since the inspector
 *  shows it separately as `Type`. */
function prettifyObjectName(name: string, id: string): string {
  const m = /^Object (\d+)(?: \(\w+\))?$/.exec(name);
  if (m) return `Object #${m[1]!}`;
  // If name is just the synthetic id, fallback to "Object #N".
  if (name === id || /^binary_obj_/.test(name)) {
    const idMatch = /_(\d+)$/.exec(id);
    return idMatch ? `Object #${idMatch[1]!}` : 'Object';
  }
  return name;
}

/** Map `ObjectEventKind` vocabulary to user-friendly label. */
function prettifyObjectKind(kind: string): string {
  switch (kind) {
    case 'npc':
      return 'NPC';
    case 'trainer':
      return 'Trainer';
    case 'item':
      return 'Item';
    case 'misc':
      return 'Other';
    default:
      return kind;
  }
}

/** Iter-95 lifter writes Warp.name as `Warp 0 @ (12,8)` - keep coords
 *  but drop redundant prefix when shown in a panel already labeled "warp". */
function prettifyWarpName(name: string, id: string): string {
  const m = /^Warp (\d+) @ \((\d+),(\d+)\)$/.exec(name);
  if (m) return `Warp #${m[1]!}`;
  if (name === id || /^binary_warp_/.test(name)) {
    const idMatch = /_(\d+)$/.exec(id);
    return idMatch ? `Warp #${idMatch[1]!}` : 'Warp';
  }
  return name;
}

/** Iter-95 lifter writes trigger names as `Coord trigger @ (5,9)` or
 *  `Sign/hidden @ (5,9)`. Show shorter form since coords are in the dl. */
function prettifyTriggerName(name: string, id: string): string {
  if (/^Coord trigger @/.test(name)) return 'Step trigger';
  if (/^Sign\/hidden @/.test(name)) return 'Sign or hidden item';
  if (name === id || /^binary_(coord|bg)_/.test(name)) return 'Trigger';
  return name;
}

/** Render trigger kind enum as user-friendly label. */
function prettifyTriggerKind(kind: string): string {
  switch (kind) {
    case 'on_enter':
      return 'On step';
    case 'on_interact':
      return 'On interact';
    case 'on_load':
      return 'On map load';
    default:
      return kind;
  }
}

export function MapEditor({ manifest, map, onClose }: MapEditorProps) {
  const showInternalIds = useUiPreferencesStore((s) => s.showInternalIds);
  const objectEvents = useMemo(
    () => manifest.objectEvents.filter((o) => o.mapId === map.id),
    [manifest.objectEvents, map.id],
  );
  const warps = useMemo(
    () => manifest.warps.filter((w) => w.fromMapId === map.id),
    [manifest.warps, map.id],
  );
  const triggers = useMemo(
    () => manifest.triggers.filter((t) => t.mapId === map.id),
    [manifest.triggers, map.id],
  );
  // Phase O.47 - filter heal-locations to those whose cross-ref 21
  // resolved destMapId matches this map. The MapEditor renders a
  // green pin at each (x, y) so the operator sees where the
  // SPAWN_* warps land without leaving the map page.
  const healLocations = useMemo(
    () =>
      (manifest.healLocations ?? []).filter((h) => h.destMapId === map.id),
    [manifest.healLocations, map.id],
  );

  const [enabledLayers, setEnabledLayers] = useState<ReadonlySet<LayerKey>>(
    () => new Set(DEFAULT_LAYERS),
  );
  const [selected, setSelected] = useState<SelectedMarker | null>(null);
  const [resizeModalOpen, setResizeModalOpen] = useState(false);
  // Phase I.2.1 - tile cell selection. Mutually exclusive with marker
  // selection: clicking a cell clears the marker, clicking a marker
  // clears the tile. Active only when the Pointer tool is selected.
  const [selectedTile, setSelectedTile] = useState<
    { readonly x: number; readonly y: number } | null
  >(null);

  // Phase P.3 - sync the local selection into the global useSelection
  // store so the workspace InspectorDock (right rail) surfaces the same
  // entity. The MapEditor's existing right-side aside continues to host
  // the kind-specific editor; useSelection lets future Phase S
  // inspectors render in the workspace dock for the same selection too.
  const select = useSelection((s) => s.select);
  const clearSelection = useSelection((s) => s.clear);
  useEffect(() => {
    if (selected) {
      select({
        kind: selected.kind as EntityKind,
        id: selected.id,
        mapContext: map.id,
      });
      return;
    }
    if (selectedTile) {
      select({
        kind: 'tile',
        id: `${map.id}:${selectedTile.x},${selectedTile.y}`,
        mapContext: map.id,
        details: { x: selectedTile.x, y: selectedTile.y },
      });
      return;
    }
    // Nothing locally selected - if the workspace selection still points
    // at something inside this map, defer to the map header by clearing.
    // Other-map selections from outside MapEditor are left alone.
    const current = useSelection.getState().current;
    if (current && current.mapContext === map.id) {
      clearSelection();
    }
  }, [selected, selectedTile, map.id, select, clearSelection]);

  // Phase L.2 - keyboard navigation. Esc clears selection (returns to
  // map-header inspector); Tab / Shift+Tab cycles through markers on
  // this map; '?' toggles the help overlay. We register on document
  // because the canvas / inspector aren't always focused.
  useEffect(() => {
    const allMarkers: Array<{ kind: 'objectEvent' | 'warp' | 'trigger'; id: string }> = [
      ...objectEvents.map((o) => ({ kind: 'objectEvent' as const, id: o.id })),
      ...warps.map((w) => ({ kind: 'warp' as const, id: w.id })),
      ...triggers.map((t) => ({ kind: 'trigger' as const, id: t.id })),
    ];

    function onKey(e: KeyboardEvent): void {
      // Don't hijack typing inside form fields.
      const t = e.target as HTMLElement | null;
      const isTyping =
        t &&
        (t.tagName === 'INPUT' ||
          t.tagName === 'TEXTAREA' ||
          t.tagName === 'SELECT' ||
          t.isContentEditable);
      if (isTyping) return;

      if (e.key === 'Escape') {
        if (selected !== null || selectedTile !== null) {
          setSelected(null);
          setSelectedTile(null);
          e.preventDefault();
        }
        return;
      }
      if (e.key === 'Tab' && allMarkers.length > 0) {
        const dir = e.shiftKey ? -1 : 1;
        const currentIdx = selected
          ? allMarkers.findIndex((m) => m.id === selected.id)
          : -1;
        const nextIdx =
          currentIdx < 0
            ? dir > 0
              ? 0
              : allMarkers.length - 1
            : (currentIdx + dir + allMarkers.length) % allMarkers.length;
        const next = allMarkers[nextIdx]!;
        setSelected({ kind: next.kind, id: next.id });
        setSelectedTile(null);
        e.preventDefault();
      }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [objectEvents, warps, triggers, selected, selectedTile]);
  const [layout, setLayout] = useState<LayoutState>({ kind: 'idle' });
  // Phase UX-E - sprite cache keyed by sprite struct file offset. Many
  // NPCs share the same sprite roster entry so caching by struct
  // offset avoids redundant fetches.
  const [objectEventSprites, setObjectEventSprites] = useState<
    ReadonlyMap<
      number,
      { width: number; height: number; rgba: Uint8ClampedArray }
    > | null
  >(null);
  // Phase G-RC2 (semantic-world plan §G.2) - sprite decode stats so the
  // toolbar can show "Sprites: 7/9 decoded (5 colored)" instead of
  // silently falling back to colored rectangles. Helps the operator
  // see what's happening when the OW sprite table or OBJ palette table
  // detector didn't fire on a heavy hack ROM.
  const [spriteStats, setSpriteStats] = useState<{
    requested: number;
    decoded: number;
    colored: number;
    failed: ReadonlyArray<{ offset: number; message: string }>;
    /** Phase O.4 - count of NPCs on the map whose metadata has NO
     *  `spriteStructFileOffset`. Surfaces as a toolbar banner so the
     *  operator knows the OW sprite table detector missed those events
     *  (rather than silently falling back to colored markers). */
    uncovered: number;
  } | null>(null);
  const [metatilePixels, setMetatilePixels] = useState<
    ReadonlyMap<number, Uint32Array> | null
  >(null);
  // Phase T.1 - black-tile diagnostic. After the pixels Map and the
  // mapData cells both land, any cell whose metatileId is absent from
  // the pixels Map renders as a blank/black tile. Surface a count so
  // the operator notices broken composition (commonly: CFRU/Unbound
  // relocate the primary/secondary boundary; the lifter couldn't
  // decode a metatile spec). The diagnostic itself does not fix the
  // gap - it just makes it visible until the rendering fix lands.
  const [missingMetatileIds, setMissingMetatileIds] = useState<
    ReadonlyArray<number>
  >([]);
  const sessionId = useProjectStore((s) =>
    s.load.kind === 'loaded' ? s.load.data.session.id : null,
  );

  const layoutName = typeof map.metadata['layout'] === 'string'
    ? (map.metadata['layout'] as string)
    : null;

  // Phase H-RC7 - hovered cell readout for visual diagnosis. When the
  // user reports "tree fragment misplaced at (X, Y)", they can hover
  // over the offending cell + read off the metatile id from the
  // toolbar without having to click into paint mode.
  const [hoveredCell, setHoveredCell] = useState<
    { x: number; y: number; metatileId: number } | null
  >(null);

  // Layer 2 - right-click context menu state. When non-null, a popover
  // anchored at (screenX, screenY) offers "Add NPC here" / "Add trainer
  // here" / "Make NPC #N a trainer" → routes through the agent panel's
  // sendPrompt with the tile coords + map id baked in.
  const [contextMenu, setContextMenu] = useState<{
    readonly tileX: number;
    readonly tileY: number;
    readonly screenX: number;
    readonly screenY: number;
  } | null>(null);

  // Phase UX-C.4 - detect binary-rom maps via iter-95-stashed metadata
  // offsets. When present, fetch the real tile graphics + map data via
  // the new binary-rom routes (C.3) and compose per-metatile pixel
  // arrays for the scene renderer.
  const binaryRomPrimaryBlocksOffset = typeof map.metadata['binaryRomPrimaryBlocksOffset'] === 'number'
    ? (map.metadata['binaryRomPrimaryBlocksOffset'] as number)
    : -1;
  const binaryRomPrimaryTilesetOffset = typeof map.metadata['binaryRomPrimaryTilesetOffset'] === 'number'
    ? (map.metadata['binaryRomPrimaryTilesetOffset'] as number)
    : -1;
  // Phase F (semantic-world plan §1.2): the lifter stashes the secondary
  // tileset offset on the same metadata bag. When non-zero, fetch both
  // tilesets and merge at the family-specific boundary so secondary
  // metatiles render with correct tiles + palettes instead of black.
  const binaryRomSecondaryTilesetOffset = typeof map.metadata['binaryRomSecondaryTilesetOffset'] === 'number'
    ? (map.metadata['binaryRomSecondaryTilesetOffset'] as number)
    : -1;
  const binaryRomMapDimsWidth = map.dimensions.width;
  const binaryRomMapDimsHeight = map.dimensions.height;
  const isBinaryRomMap =
    binaryRomPrimaryBlocksOffset > 0 &&
    binaryRomPrimaryTilesetOffset > 0 &&
    binaryRomMapDimsWidth > 0 &&
    binaryRomMapDimsHeight > 0;
  // The Real Game Editor Push - boundaries are auto-detected from the
  // fetched primary tileset response (tileCount, palettes.length,
  // metatileSpecs.length) instead of hardcoded by cartridge game code.
  // CFRU/Unbound relocate the boundary; auto-detection fixes the black/
  // missing tiles those ROMs previously rendered. Seeded with the game-
  // code default so renders before the first fetch still have valid
  // boundaries; replaced after the primary response lands.
  const gameCode = manifest.identity.romHeader?.gameCode ?? null;
  const [tilesetBoundaries, setTilesetBoundaries] = useState<TilesetBoundaries>(
    () => tilesetBoundariesForGameCode(gameCode),
  );

  useEffect(() => {
    if (!sessionId || !isBinaryRomMap) {
      setMetatilePixels(null);
      setMissingMetatileIds([]);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        // Phase F: fetch primary + (when present) secondary + map data
        // all in parallel. The secondary fetch is best-effort - if the
        // map has no secondary OR the secondary parse fails, we fall
        // back to single-tileset composition.
        const wantSecondary = binaryRomSecondaryTilesetOffset > 0;
        const [primary, secondaryResult, mapData] = await Promise.all([
          fetchBinaryRomTileset(sessionId, {
            // Backend parses the Tileset struct at this offset to
            // extract tiles + palettes + metatiles offsets +
            // isCompressed flag (covers FireRed and Emerald slot
            // layouts automatically).
            tilesetStructOffset: binaryRomPrimaryTilesetOffset,
          }),
          wantSecondary
            ? fetchBinaryRomTileset(sessionId, {
                tilesetStructOffset: binaryRomSecondaryTilesetOffset,
              }).catch(() => null)
            : Promise.resolve(null),
          fetchBinaryRomMapData(sessionId, {
            layoutOffset: binaryRomPrimaryBlocksOffset,
            width: binaryRomMapDimsWidth,
            height: binaryRomMapDimsHeight,
          }),
        ]);
        if (cancelled) return;
        // Auto-detect boundaries from the actual primary response.
        const detectedBoundaries = tilesetBoundariesForRom(primary, gameCode);
        setTilesetBoundaries(detectedBoundaries);
        const pixels = secondaryResult
          ? composeBinaryRomMetatilePixelsDual(
              primary,
              secondaryResult,
              mapData,
              detectedBoundaries,
            )
          : composeBinaryRomMetatilePixels(primary, mapData);
        setMetatilePixels(pixels);
        setMissingMetatileIds(computeMissingMetatiles(pixels, mapData));
        // Synthesize a tileGrid LayoutData-like shape for the scene
        // renderer so existing drawTileCells / drawCollisionFromCells
        // / etc. paths fire. The decomp-layout state slot is reused as
        // a "loaded" carrier.
        setLayout({
          kind: 'loaded',
          data: {
            id: `binary-rom:${map.id}`,
            name: map.name,
            width: mapData.width,
            height: mapData.height,
            borderWidth: 0,
            borderHeight: 0,
            primaryTileset: null,
            secondaryTileset: null,
            cells: mapData.cells.map((c) => ({
              metatileId: c.metatileId,
              collision: c.collision,
              elevation: c.elevation,
            })),
            sourceLayoutJsonPath: `<binary-rom:${binaryRomPrimaryBlocksOffset.toString(16)}>`,
          },
        });
      } catch (e) {
        if (cancelled) return;
        const msg =
          e instanceof ProjectApiError
            ? `${e.code}: ${e.message}`
            : e instanceof Error
              ? e.message
              : String(e);
        setLayout({ kind: 'error', message: `binary-rom render failed - ${msg}` });
        setMetatilePixels(null);
        setMissingMetatileIds([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    sessionId,
    isBinaryRomMap,
    binaryRomPrimaryBlocksOffset,
    binaryRomPrimaryTilesetOffset,
    binaryRomSecondaryTilesetOffset,
    binaryRomMapDimsWidth,
    binaryRomMapDimsHeight,
    gameCode,
    map.id,
  ]);

  // Phase UX-E - fetch OW sprites for object events on this map. Keys
  // by spriteStructFileOffset (iter-102 cross-ref stash on metadata)
  // so duplicate sprites across NPCs only fetch once.
  //
  // Phase F (semantic-world plan §1.1) - when the cross-ref pass
  // resolved the sprite's palette tag against sObjectEventSpritePalettes[]
  // it stashes `spritePaletteRgba` (16 × u32) on the same metadata bag.
  // Passing it to the route swaps the grayscale fallback for real
  // colors. When the OBJ palette detector didn't fire (non-vanilla
  // layout) the field is missing and the route stays in grayscale.
  useEffect(() => {
    if (!sessionId) {
      setObjectEventSprites(null);
      setSpriteStats(null);
      return;
    }
    const fetchSet = new Map<
      number,
      { palette?: ReadonlyArray<number> }
    >();
    // Phase O.4 - count NPCs lacking spriteStructFileOffset. These are
    // ones the OW sprite detector / cross-ref pass couldn't match. The
    // toolbar surfaces this so the operator understands the gap.
    let uncovered = 0;
    for (const oe of objectEvents) {
      const off = oe.metadata['spriteStructFileOffset'];
      if (typeof off !== 'number' || off <= 0) {
        uncovered++;
        continue;
      }
      // Phase F: the cross-ref pass encodes the resolved 16-color
      // palette as 128 lowercase-hex chars (16 × u32 × 8). Decode here
      // so we pass the same shape /binary-rom-ow-sprite expects.
      const palHex = oe.metadata['spritePaletteRgbaHex'];
      let palette: ReadonlyArray<number> | undefined;
      if (typeof palHex === 'string' && palHex.length === 128) {
        const arr = new Array<number>(16);
        let ok = true;
        for (let k = 0; k < 16; k++) {
          const n = parseInt(palHex.slice(k * 8, k * 8 + 8), 16);
          if (Number.isNaN(n)) {
            ok = false;
            break;
          }
          arr[k] = n;
        }
        if (ok) palette = arr;
      }
      // First request for this offset wins - duplicates share a single
      // fetch keyed by structFileOffset. Subsequent NPCs using the same
      // sprite + same palette reuse the cached entry.
      if (!fetchSet.has(off)) {
        fetchSet.set(off, palette ? { palette } : {});
      }
    }
    if (fetchSet.size === 0) {
      setObjectEventSprites(null);
      // Phase G-RC2: report 0 requested rather than null when there
      // were no objectEvents AT ALL - distinguishes "no sprites needed"
      // from "decoding pending".
      setSpriteStats({
        requested: 0,
        decoded: 0,
        colored: 0,
        failed: [],
        uncovered,
      });
      return;
    }
    let cancelled = false;
    void (async () => {
      const cache = new Map<
        number,
        {
          width: number;
          height: number;
          rgba: Uint8ClampedArray;
          paletteSource?: 'detected' | 'neutral';
        }
      >();
      const failed: { offset: number; message: string }[] = [];
      let colored = 0;
      // Fetch in parallel; collect successes + record failures so the
      // toolbar can surface them instead of silently falling back to
      // colored rectangles.
      const results = await Promise.allSettled(
        Array.from(fetchSet.entries()).map(async ([off, args]) => {
          const r = await fetchBinaryRomOwSprite(sessionId, {
            structFileOffset: off,
            ...(args.palette ? { palette: args.palette } : {}),
          });
          return { off, response: r, requestedPalette: Boolean(args.palette) };
        }),
      );
      if (cancelled) return;
      for (let i = 0; i < results.length; i++) {
        const r = results[i]!;
        const off = Array.from(fetchSet.keys())[i]!;
        if (r.status === 'rejected') {
          const reason = r.reason as unknown;
          const message =
            reason instanceof ProjectApiError
              ? `${reason.code}: ${reason.message}`
              : reason instanceof Error
                ? reason.message
                : String(reason);
          failed.push({ offset: off, message });
           
          console.warn(
            `[Phase G-RC2] OW sprite fetch failed @ 0x${off.toString(16)}: ${message}`,
          );
          continue;
        }
        const { response, requestedPalette } = r.value;
        const binary = atob(response.rgbaBase64);
        const rgba = new Uint8ClampedArray(binary.length);
        for (let k = 0; k < binary.length; k++) rgba[k] = binary.charCodeAt(k);
        // The Real Game Editor Push - pass paletteSource through so
        // the scene marker can overlay a "?" badge on neutral fallbacks.
        const paletteSource: 'detected' | 'neutral' = response.paletteSource
          ?? (response.grayscaleFallback ? 'neutral' : 'detected');
        cache.set(off, {
          width: response.width,
          height: response.height,
          rgba,
          paletteSource,
        });
        if (requestedPalette && paletteSource === 'detected') colored++;
      }
      if (!cancelled) {
        setObjectEventSprites(cache);
        setSpriteStats({
          requested: fetchSet.size,
          decoded: cache.size,
          colored,
          failed: Object.freeze(failed),
          uncovered,
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sessionId, objectEvents]);

  useEffect(() => {
    if (!sessionId || !layoutName) {
      // Don't clobber the binary-rom-loaded state.
      if (!isBinaryRomMap) setLayout({ kind: 'idle' });
      return;
    }
    let cancelled = false;
    setLayout({ kind: 'loading' });
    if (!isBinaryRomMap) setMetatilePixels(null);
    void (async () => {
      try {
        const data = await fetchLayout(sessionId, layoutName);
        if (!cancelled) setLayout({ kind: 'loaded', data });
      } catch (e) {
        if (cancelled) return;
        const msg =
          e instanceof ProjectApiError
            ? `${e.code}: ${e.message}`
            : e instanceof Error
              ? e.message
              : String(e);
        setLayout({ kind: 'error', message: msg });
        return;
      }
      // Decomp projects: compose the real tiles from the source tilesets.
      // (Binary-rom maps get their pixels from the ROM path above.) Best
      // effort - markers/collision/clicks still work without it.
      if (!isBinaryRomMap) {
        try {
          const tiles = await fetchLayoutTiles(sessionId, layoutName);
          if (!cancelled) setMetatilePixels(tiles);
        } catch {
          if (!cancelled) setMetatilePixels(null);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sessionId, layoutName, isBinaryRomMap]);

  function toggleLayer(layer: LayerKey): void {
    setEnabledLayers((prev) => {
      const next = new Set(prev);
      if (next.has(layer)) next.delete(layer);
      else next.add(layer);
      return next;
    });
  }

  // Phase O.75 - restore the canonical visible-by-default set when
  // the operator wants to re-enable layers they previously toggled
  // off (or wants a clean slate after experimenting). Distinct from
  // toggleLayer so the regression test can verify the reset path
  // independently.
  function resetLayersToDefault(): void {
    setEnabledLayers(new Set(DEFAULT_LAYERS));
  }
  // Phase O.76 - wipe to a blank canvas for diagnostics (e.g.
  // finding a misaligned tile through visual noise). One click
  // hides every layer; "Reset" restores defaults.
  function hideAllLayers(): void {
    setEnabledLayers(new Set());
  }
  const layersAreDefault =
    enabledLayers.size === DEFAULT_LAYERS.length &&
    DEFAULT_LAYERS.every((l) => enabledLayers.has(l));
  const layersAreEmpty = enabledLayers.size === 0;

  const dims = useMemo(
    () =>
      layout.kind === 'loaded'
        ? { width: layout.data.width, height: layout.data.height, inferred: false }
        : inferMapDimensions(map),
    [layout, map],
  );
  // Phase I.0.1 - memoize tileGrid so its reference is stable across
  // renders that don't change layout. Previously this was an inline
  // object literal recreated every render, which busted the
  // `sceneOptions` useMemo deps → caused PixiScene to tear down and
  // rebuild the canvas on every hover (the visible "flashing on/off").
  const tileGrid = useMemo(
    () =>
      layout.kind === 'loaded'
        ? {
            width: layout.data.width,
            height: layout.data.height,
            cells: layout.data.cells,
          }
        : null,
    [layout],
  );
  const scanCurrent = useProjectStore((s) => s.scanCurrentProject);

  // Decomp maps keep their NPCs in data/maps/<Map>/map.json, so adding one is
  // a structured JSON append (no binary free-space relocation). Binary ROMs
  // route through the agent's propose_add_object_event instead.
  const isDecompProject = !manifest.binaryRom;
  const [addingNpc, setAddingNpc] = useState(false);
  const handleAddNpc = async (tileX: number, tileY: number): Promise<void> => {
    if (!sessionId || addingNpc) return;
    setAddingNpc(true);
    try {
      await addDecompObjectEvent(sessionId, map.id, { x: tileX, y: tileY });
      await scanCurrent();
      pushToast(
        'success',
        `NPC added at (${String(tileX)}, ${String(tileY)}). Click it to set its sprite, movement, and script.`,
      );
    } catch (e) {
      pushToast('error', `Couldn't add NPC: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setAddingNpc(false);
    }
  };

  // Add (or, if an NPC is already on the tile, give) a talking NPC: prompts for
  // the line, creates a msgbox script in scripts.inc, and binds it.
  const handleAddTalkNpc = async (tileX: number, tileY: number): Promise<void> => {
    if (!sessionId || addingNpc) return;
    const message = typeof window !== 'undefined' ? window.prompt('What should this NPC say?', 'Hello!') : null;
    if (message === null) return;
    setAddingNpc(true);
    try {
      const r = await addDecompTalkNpc(sessionId, map.id, { x: tileX, y: tileY, message: message || '...' });
      await scanCurrent();
      pushToast(
        'success',
        `${r.boundExisting ? 'Dialogue added to the NPC' : 'Talking NPC added'} at (${String(tileX)}, ${String(tileY)}). Build & Play to hear it.`,
      );
    } catch (e) {
      pushToast('error', `Couldn't add dialogue: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setAddingNpc(false);
    }
  };

  // Make a trainer: prompts for name + team lead, appends a TRAINER_* to
  // trainers.party + a trainerbattle script, and binds it (+ sets trainer_type).
  const handleMakeTrainer = async (tileX: number, tileY: number): Promise<void> => {
    if (!sessionId || addingNpc) return;
    const trainerName = typeof window !== 'undefined' ? window.prompt('Trainer name?', 'Youngster Joey') : null;
    if (trainerName === null) return;
    const species =
      (typeof window !== 'undefined' ? window.prompt('Team lead Pokémon (e.g. Rattata)?', 'Rattata') : null) ?? 'Rattata';
    setAddingNpc(true);
    try {
      const r = await makeDecompTrainer(sessionId, map.id, {
        x: tileX,
        y: tileY,
        ...(trainerName.trim() ? { trainerName: trainerName.trim() } : {}),
        species: species.trim() || 'Rattata',
      });
      await scanCurrent();
      pushToast(
        'success',
        `Trainer ${r.trainerId} created with a battle script. Edit its team in the Trainers editor; Build & Play to battle it.`,
      );
    } catch (e) {
      pushToast('error', `Couldn't make trainer: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setAddingNpc(false);
    }
  };

  // Phase UX-D paint state - current tool + selected metatile id.
  // The store is cleared when switching maps via clearForMap.
  const paintTool = usePaintStore((s) => s.tool);
  const selectedMetatileId = usePaintStore((s) => s.selectedMetatileId);
  const setSelectedMetatileId = usePaintStore((s) => s.setSelectedMetatileId);
  const pushEdit = usePaintStore((s) => s.pushEdit);
  const undoPaint = usePaintStore((s) => s.undo);
  const redoPaint = usePaintStore((s) => s.redo);
  const clearPaintForMap = usePaintStore((s) => s.clearForMap);

  useEffect(() => {
    clearPaintForMap(map.id);
    return () => clearPaintForMap(null);
  }, [map.id, clearPaintForMap]);

  // Click → paint handler. Routes to pencil/fill/eyedropper backend
  // calls based on the active tool. Backend's editBinaryRomMapCells
  // writes the cell + auto-creates a `<rom>.bak` on first edit.
  //
  // Phase I.2.1 - when the Pointer tool is active and the user clicks
  // an empty cell, we open the Tile properties inspector. Returns a
  // tile-pick handler instead of the paint handler in that case.
  const onCellClick = useMemo(() => {
    if (!isBinaryRomMap || layout.kind !== 'loaded') {
      return undefined;
    }
    if (paintTool === 'pointer') {
      // Pointer tool: cell-click selects the tile for inspection.
      return (x: number, y: number, _currentMetatileId: number) => {
        setSelected(null);
        setSelectedTile({ x, y });
      };
    }
    if (!sessionId) {
      return undefined;
    }
    return (x: number, y: number, currentMetatileId: number) => {
      if (paintTool === 'eyedropper') {
        setSelectedMetatileId(currentMetatileId);
        return;
      }
      if (paintTool === 'pencil') {
        if (currentMetatileId === selectedMetatileId) return;
        void (async () => {
          try {
            await editBinaryRomMapCells(sessionId, {
              layoutOffset: binaryRomPrimaryBlocksOffset,
              width: binaryRomMapDimsWidth,
              height: binaryRomMapDimsHeight,
              edits: [{ x, y, metatileId: selectedMetatileId }],
            });
            pushEdit({
              mapId: map.id,
              x,
              y,
              prevMetatileId: currentMetatileId,
              nextMetatileId: selectedMetatileId,
            });
            // Refresh: re-fetch map data + recompose pixels (mirrors
            // the binary-rom load effect).
            void refetchBinaryRomMap();
          } catch (e) {
             
            console.error('paint failed:', e);
          }
        })();
        return;
      }
      if (paintTool === 'collision') {
        // Left-click = blocked (collision=1), right-click handled via
        // contextmenu in the scene below. For now both routes here set
        // blocked; passable-paint is wired separately as a Shift modifier
        // exposed by the scene's onCellRightClick callback.
        if (layout.kind !== 'loaded') return;
        const cell = layout.data.cells[y * layout.data.width + x];
        if (!cell) return;
        const nextCollision = cell.collision === 0 ? 1 : 0; // toggle
        void (async () => {
          try {
            await editBinaryRomMapCells(sessionId, {
              layoutOffset: binaryRomPrimaryBlocksOffset,
              width: binaryRomMapDimsWidth,
              height: binaryRomMapDimsHeight,
              edits: [{ x, y, collision: nextCollision }],
            });
            void refetchBinaryRomMap();
          } catch (e) {
             
            console.error('collision toggle failed:', e);
          }
        })();
        return;
      }
      if (paintTool === 'fill') {
        if (currentMetatileId === selectedMetatileId || layout.kind !== 'loaded') return;
        // Bucket fill - 4-direction flood from (x, y).
        const grid = layout.data;
        const visited = new Set<number>();
        const stack: Array<[number, number]> = [[x, y]];
        const targetId = currentMetatileId;
        const edits: Array<{ x: number; y: number; metatileId: number }> = [];
        while (stack.length > 0) {
          const [px, py] = stack.pop()!;
          const key = py * grid.width + px;
          if (visited.has(key)) continue;
          visited.add(key);
          const cell = grid.cells[key];
          if (!cell || cell.metatileId !== targetId) continue;
          edits.push({ x: px, y: py, metatileId: selectedMetatileId });
          if (px > 0) stack.push([px - 1, py]);
          if (px < grid.width - 1) stack.push([px + 1, py]);
          if (py > 0) stack.push([px, py - 1]);
          if (py < grid.height - 1) stack.push([px, py + 1]);
        }
        if (edits.length === 0) return;
        void (async () => {
          try {
            await editBinaryRomMapCells(sessionId, {
              layoutOffset: binaryRomPrimaryBlocksOffset,
              width: binaryRomMapDimsWidth,
              height: binaryRomMapDimsHeight,
              edits,
            });
            for (const e of edits) {
              pushEdit({
                mapId: map.id,
                x: e.x,
                y: e.y,
                prevMetatileId: targetId,
                nextMetatileId: selectedMetatileId,
              });
            }
            void refetchBinaryRomMap();
          } catch (e) {
             
            console.error('fill failed:', e);
          }
        })();
      }
    };
  }, [
    isBinaryRomMap,
    sessionId,
    layout,
    paintTool,
    selectedMetatileId,
    setSelectedMetatileId,
    binaryRomPrimaryBlocksOffset,
    binaryRomMapDimsWidth,
    binaryRomMapDimsHeight,
    map.id,
    pushEdit,
  ]);

  // Ref-callback for re-fetching the binary-rom map data after a write.
  // Implemented as a ref so onCellClick doesn't trigger the binary-rom
  // load effect on every state tick.
  const refetchBinaryRomMap = useMemo(() => {
    return async () => {
      if (!sessionId || !isBinaryRomMap) return;
      try {
        const mapData = await fetchBinaryRomMapData(sessionId, {
          layoutOffset: binaryRomPrimaryBlocksOffset,
          width: binaryRomMapDimsWidth,
          height: binaryRomMapDimsHeight,
        });
        setLayout({
          kind: 'loaded',
          data: {
            id: `binary-rom:${map.id}`,
            name: map.name,
            width: mapData.width,
            height: mapData.height,
            borderWidth: 0,
            borderHeight: 0,
            primaryTileset: null,
            secondaryTileset: null,
            cells: mapData.cells.map((c) => ({
              metatileId: c.metatileId,
              collision: c.collision,
              elevation: c.elevation,
            })),
            sourceLayoutJsonPath: `<binary-rom:${binaryRomPrimaryBlocksOffset.toString(16)}>`,
          },
        });
      } catch {
        // Ignore refetch failures; next manual reload picks up state.
      }
    };
  }, [
    sessionId,
    isBinaryRomMap,
    binaryRomPrimaryBlocksOffset,
    binaryRomMapDimsWidth,
    binaryRomMapDimsHeight,
    map.id,
    map.name,
  ]);

  // The Real Game Editor Push - communicate the metatile-pixel fetch
  // state to the scene so it renders the right fallback (loading
  // stripes vs missing-pattern vs unavailable-decomp pattern) instead
  // of HSL-hashed colored swatches.
  // Decomp projects now compose real tiles (metatilePixels) the same as binary
  // ROMs, so the state is driven by whether pixels exist - not by project kind.
  // 'unavailable' only when there are genuinely no pixels for a decomp map
  // (e.g. its tileset dir couldn't be resolved).
  const tileLoadingState: 'loading' | 'partial' | 'ready' | 'unavailable' =
    metatilePixels && metatilePixels.size > 0
      ? missingMetatileIds.length > 0
        ? 'partial'
        : 'ready'
      : isBinaryRomMap
        ? 'loading'
        : 'unavailable';

  const sceneOptions = useMemo<MapSceneOptions>(
    () => ({
      width: dims.width * TILE_SIZE_PX,
      height: dims.height * TILE_SIZE_PX,
      tileSize: TILE_SIZE_PX,
      layers: enabledLayers,
      objectEvents,
      warps,
      triggers,
      healLocations,
      tileGrid,
      metatilePixels,
      loadingState: tileLoadingState,
      objectEventSprites,
      selectedId: selected?.id ?? null,
      groupColor: GROUP_COLORS[map.group],
      onSelect: (kind, id) => {
        if (kind === 'healLocation') {
          // Phase O.55 - clicking a heal-location pin jumps to the
          // Heal Locations sidebar tab so the operator can edit
          // destination + coords numerically. The drag-to-move
          // handler on the same marker (wired via wireMarker) writes
          // the new (x, y) directly via editBinaryRomHealLocation.
          useViewStore.getState().setView('healLocations');
          return;
        }
        setSelected({ kind, id });
        setSelectedTile(null);
      },
      onCellClick,
      // Phase H-RC7 - diagnostic hover + strong grid when "internal
      // ids" toggle is on.
      onCellHover: (x, y, metatileId) => setHoveredCell({ x, y, metatileId }),
      onContextMenu: (tileX, tileY, screenX, screenY) =>
        setContextMenu({ tileX, tileY, screenX, screenY }),
      showMetatileIds: showInternalIds,
      onMove: sessionId
        ? (kind, id, x, y) => {
            if (kind !== 'healLocation') {
              setSelected({ kind, id });
            }
            void (async () => {
              try {
                if (kind === 'healLocation') {
                  // Phase O.55 - heal-location pins persist via the
                  // /binary-rom-edit/heal-location route, not /events/move.
                  // Look up the entry to get its sourceFileOffset since
                  // the marker only carries its synthetic id.
                  const entry = healLocations.find((h) => h.id === id);
                  if (!entry) return;
                  await editBinaryRomHealLocation(sessionId, {
                    sourceFileOffset: entry.sourceFileOffset,
                    fields: { x, y },
                  });
                } else {
                  await apiMoveEvent(sessionId, kind, id, x, y);
                }
                await scanCurrent();
              } catch (e) {
                // Failure is surfaced by the subsequent rescan and the form;
                // log to console for now so the operator sees the cause.
                 
                console.error(
                  kind === 'healLocation'
                    ? 'editBinaryRomHealLocation failed:'
                    : 'apiMoveEvent failed:',
                  e,
                );
                await scanCurrent();
              }
            })();
          }
        : undefined,
    }),
    [
      dims.width,
      dims.height,
      enabledLayers,
      objectEvents,
      warps,
      triggers,
      healLocations,
      tileGrid,
      metatilePixels,
      tileLoadingState,
      objectEventSprites,
      selected,
      map.group,
      sessionId,
      scanCurrent,
      onCellClick,
      showInternalIds,
    ],
  );

  return (
    <div className="map-editor" data-testid="map-editor">
      <header className="map-editor__toolbar">
        <button
          type="button"
          className="btn btn--secondary"
          onClick={onClose}
          data-testid="map-editor-back"
        >
          ← Back to map graph
        </button>
        {isDecompProject && sessionId && (
          <button
            type="button"
            className="btn btn--secondary"
            data-testid="map-editor-add-npc"
            disabled={addingNpc}
            title="Add a new NPC to this map (or right-click the map to place one at a specific tile)"
            onClick={() =>
              void handleAddNpc(
                Math.max(0, Math.floor(dims.width / 2)),
                Math.max(0, Math.floor(dims.height / 2)),
              )
            }
          >
            {addingNpc ? 'Adding…' : '＋ Add NPC'}
          </button>
        )}
        <div className="map-editor__title">
          <span
            className="map-editor__title-kind"
            style={{ color: GROUP_COLORS[map.group] }}
            title={`Region category: ${map.group}`}
          >
            {prettifyMapGroup(map.group)}
          </span>
          <span className="map-editor__title-name" data-testid="map-editor-name">
            {prettifyMapName(map.name, map.id)}
            {showInternalIds && (
              <span className="map-editor__title-internal-id"> ({map.id})</span>
            )}
          </span>
          <button
            type="button"
            className="map-editor__title-dim map-editor__title-dim--button"
            data-testid="map-editor-dims"
            onClick={() => setResizeModalOpen(true)}
            title="Resize this map"
          >
            {dims.width > 0 && dims.height > 0
              ? `${dims.width} × ${dims.height} tiles`
              : 'Dimensions unknown'}
            {dims.inferred && dims.width > 0 ? ' (estimated)' : ''}
            <span className="map-editor__title-dim-edit"> · edit ↗</span>
          </button>
          <span
            className={`map-editor__layout-status map-editor__layout-status--${layout.kind}`}
            data-testid="map-editor-layout-status"
          >
            {layout.kind === 'idle' && (layoutName ? 'Layout idle' : 'Layout not yet decoded')}
            {layout.kind === 'loading' && 'Loading layout…'}
            {layout.kind === 'loaded' && `Layout: ${layout.data.cells.length} cells`}
            {layout.kind === 'error' && `Layout error: ${layout.message}`}
          </span>
        </div>
        <div className="map-editor__layers" role="group" aria-label="Layer toggles">
          {(
            [
              'tiles',
              'collision',
              'objects',
              'warps',
              'triggers',
              'healLocations',
              'visionCones',
            ] as ReadonlyArray<LayerKey>
          ).map((layer) => {
            // Phase O.64 - 'visionCones' layer now renders both trainer
            // vision cones (red) and wander bboxes (purple), so the
            // label "vision cones" is misleading. Rename it to
            // "movement ranges" with a tiny color legend in the
            // tooltip so operators understand both overlays at a
            // glance without having to dig into the source.
            const label =
              layer === 'healLocations'
                ? 'heal locations'
                : layer === 'visionCones'
                  ? 'movement ranges'
                  : layer;
            const title =
              layer === 'visionCones'
                ? 'Red: trainer line-of-sight cones · Purple: NPC wander zones'
                : undefined;
            return (
              <label
                key={layer}
                className="map-editor__layer-toggle"
                title={title}
              >
                <input
                  type="checkbox"
                  checked={enabledLayers.has(layer)}
                  onChange={() => toggleLayer(layer)}
                  data-testid={`map-editor-layer-${layer}`}
                />
                {label}
              </label>
            );
          })}
          {/* Phase O.75 - Reset to default layers. Disabled when
              the set already matches the default so the button
              doesn't dangle pointlessly. */}
          <button
            type="button"
            className="btn btn--secondary"
            data-testid="map-editor-layers-reset"
            disabled={layersAreDefault}
            onClick={resetLayersToDefault}
            title="Re-enable the default layer set (tiles + objects + warps + triggers + heal locations + movement ranges)"
            style={{ marginLeft: 4, fontSize: 11, padding: '2px 6px' }}
          >
            Reset
          </button>
          {/* Phase O.76 - Hide all layers for blank-canvas
              diagnostics. Disabled when nothing's visible. */}
          <button
            type="button"
            className="btn btn--secondary"
            data-testid="map-editor-layers-hide-all"
            disabled={layersAreEmpty}
            onClick={hideAllLayers}
            title="Hide every layer (useful for diagnosing a tile bug obscured by markers / overlays)"
            style={{ marginLeft: 2, fontSize: 11, padding: '2px 6px' }}
          >
            Hide all
          </button>
        </div>
      </header>
      <div className="map-editor__body">
        <div className="map-editor__canvas-column">
          <div className="map-editor__canvas-wrap">
            <PixiScene options={sceneOptions} />
            {contextMenu && (
              <MapCanvasContextMenu
                mapId={map.id}
                mapName={prettifyMapName(map.name, map.id)}
                tileX={contextMenu.tileX}
                tileY={contextMenu.tileY}
                screenX={contextMenu.screenX}
                screenY={contextMenu.screenY}
                npcAtTile={objectEvents.find(
                  (o) => o.coord.x === contextMenu.tileX && o.coord.y === contextMenu.tileY,
                ) ?? null}
                isDecomp={isDecompProject}
                onAddNpcDirect={(x, y) => void handleAddNpc(x, y)}
                onAddTalkNpc={(x, y) => void handleAddTalkNpc(x, y)}
                onMakeTrainer={(x, y) => void handleMakeTrainer(x, y)}
                onClose={() => setContextMenu(null)}
              />
            )}
            {/* Phase I.0.2 - floating overlays so the canvas stays
                maximally sized regardless of how many status badges
                are visible. The toolbar is fixed-height; transient
                state appears here over the canvas instead of pushing
                the canvas smaller. */}
            <div className="map-editor__overlays" data-testid="map-editor-overlays">
              {spriteStats && spriteStats.requested > 0 && (
                <span
                  className="map-editor__sprite-stats"
                  data-testid="map-editor-sprite-stats"
                  title={
                    spriteStats.failed.length > 0
                      ? `Failed sprite decodes:\n${spriteStats.failed
                          .map((f) => `0x${f.offset.toString(16)} → ${f.message}`)
                          .join('\n')}`
                      : `All ${spriteStats.requested} sprites decoded${
                          spriteStats.colored > 0
                            ? ` (${spriteStats.colored} with real palettes)`
                            : ''
                        }`
                  }
                >
                  Sprites: {spriteStats.decoded}/{spriteStats.requested} decoded
                  {spriteStats.colored > 0 && ` · ${spriteStats.colored} colored`}
                  {spriteStats.failed.length > 0 && ` · ${spriteStats.failed.length} failed`}
                </span>
              )}
              {(() => {
                const objPalSub = manifest.binaryRom?.subsystems.find(
                  (s) => s.id === 'object_event_palettes_system',
                );
                if (!objPalSub || objPalSub.status === 'detected') return null;
                return (
                  <span
                    className="map-editor__obj-palette-warn"
                    data-testid="map-editor-obj-palette-warn"
                    title={`OBJ palette table not detected - NPCs render in grayscale.\nDetector reason: ${objPalSub.summary ?? '(no detail)'}.`}
                  >
                    ⚠ OBJ palette table not detected - NPCs grayscale
                  </span>
                );
              })()}
              {/* Phase O.4 - surface OW sprite table detection gap. When
                  overworld_sprites_system didn't fire OR fired but missed
                  some object events, the operator sees colored marker
                  fallbacks instead of decoded sprites. Banner explains
                  why so they can re-scan / file a bug rather than guess. */}
              {(() => {
                const owSub = manifest.binaryRom?.subsystems.find(
                  (s) => s.id === 'overworld_sprites_system',
                );
                if (!owSub || owSub.status === 'detected') return null;
                return (
                  <span
                    className="map-editor__obj-palette-warn"
                    data-testid="map-editor-ow-sprite-warn"
                    title={`Overworld sprite table not detected - NPCs render as colored markers.\nDetector reason: ${owSub.summary ?? '(no detail)'}.`}
                  >
                    ⚠ OW sprite table not detected - NPCs as markers
                  </span>
                );
              })()}
              {spriteStats && spriteStats.uncovered > 0 && (
                <span
                  className="map-editor__obj-palette-warn"
                  data-testid="map-editor-uncovered-warn"
                  title={`${String(spriteStats.uncovered)} object event(s) on this map have no sprite info on metadata. Re-scan after a detector update; if the gap persists, the OW sprite cross-ref likely missed those graphics IDs.`}
                >
                  ⚠ {spriteStats.uncovered} NPC{spriteStats.uncovered === 1 ? '' : 's'} no sprite info
                </span>
              )}
              {missingMetatileIds.length > 0 && (
                <span
                  className="map-editor__obj-palette-warn"
                  data-testid="map-editor-missing-metatiles-warn"
                  title={`${String(missingMetatileIds.length)} metatile id(s) used by this map have no composed pixels - they render as black/blank tiles. Usually means the primary/secondary tileset boundary differs from the family default (CFRU/Unbound relocate it), or a metatile spec the lifter couldn't decode.\n\nMissing ids (first 20): ${missingMetatileIds.slice(0, 20).join(', ')}${missingMetatileIds.length > 20 ? '…' : ''}`}
                >
                  ⚫ {missingMetatileIds.length} black tile{missingMetatileIds.length === 1 ? '' : 's'}
                </span>
              )}
              {hoveredCell && (
                <span
                  className="map-editor__cell-readout"
                  data-testid="map-editor-cell-readout"
                  title="Coordinates and metatile id under the cursor"
                >
                  ({hoveredCell.x}, {hoveredCell.y}) · Metatile #{hoveredCell.metatileId}
                </span>
              )}
            </div>
          </div>
          <MapPaintToolbar
            metatilePixels={metatilePixels}
            disabled={!isBinaryRomMap}
            manifest={manifest}
            sessionId={sessionId}
            currentMapPrimaryOffset={
              isBinaryRomMap ? binaryRomPrimaryTilesetOffset : undefined
            }
            onUndo={
              isBinaryRomMap && sessionId
                ? () => {
                    const edit = undoPaint();
                    if (!edit) return;
                    void (async () => {
                      try {
                        await editBinaryRomMapCells(sessionId, {
                          layoutOffset: binaryRomPrimaryBlocksOffset,
                          width: binaryRomMapDimsWidth,
                          height: binaryRomMapDimsHeight,
                          edits: [
                            { x: edit.x, y: edit.y, metatileId: edit.prevMetatileId },
                          ],
                        });
                        void refetchBinaryRomMap();
                      } catch (e) {
                         
                        console.error('undo failed:', e);
                      }
                    })();
                  }
                : undefined
            }
            onRedo={
              isBinaryRomMap && sessionId
                ? () => {
                    const edit = redoPaint();
                    if (!edit) return;
                    void (async () => {
                      try {
                        await editBinaryRomMapCells(sessionId, {
                          layoutOffset: binaryRomPrimaryBlocksOffset,
                          width: binaryRomMapDimsWidth,
                          height: binaryRomMapDimsHeight,
                          edits: [
                            { x: edit.x, y: edit.y, metatileId: edit.nextMetatileId },
                          ],
                        });
                        void refetchBinaryRomMap();
                      } catch (e) {
                         
                        console.error('redo failed:', e);
                      }
                    })();
                  }
                : undefined
            }
          />
        </div>
        <aside className="map-editor__inspector" data-testid="map-editor-inspector">
          <div className="map-editor__inspector-shortcuts" title="Keyboard shortcuts">
            <kbd>Esc</kbd> deselect · <kbd>Tab</kbd> cycle markers · scroll to zoom
          </div>
          <h3 className="map-editor__inspector-heading">Selection</h3>
          {selected ? (
            <SelectedInspector
              selected={selected}
              map={map}
              manifest={manifest}
              objectEvents={objectEvents}
              warps={warps}
              triggers={triggers}
              sessionId={sessionId}
              showInternalIds={showInternalIds}
              bounds={
                layout.kind === 'loaded'
                  ? { width: layout.data.width, height: layout.data.height }
                  : null
              }
              objectEventSprites={objectEventSprites}
            />
          ) : selectedTile && layout.kind === 'loaded' && isBinaryRomMap ? (
            // Phase 6.11 - when a tile is selected, render the tile
            // editor AND keep the map-header / encounter / route info
            // visible below it. Adds a "Deselect tile" affordance at
            // the top so the user can return to the default panel.
            (() => {
              const cellIdx = selectedTile.y * layout.data.width + selectedTile.x;
              const currentCell = layout.data.cells[cellIdx];
              const gameCode = manifest.identity.romHeader?.gameCode ?? '';
              const family: 'frlg' | 'rse' =
                gameCode === 'BPRE' || gameCode === 'BPGE' ? 'frlg' : 'rse';
              return (
                <>
                  <div
                    className="map-editor__tile-deselect-bar"
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: 8,
                      padding: '6px 8px',
                      marginBottom: 8,
                      borderRadius: 4,
                      background: 'rgba(74, 158, 255, 0.06)',
                      border: '1px solid rgba(74, 158, 255, 0.28)',
                    }}
                  >
                    <span style={{ fontSize: 12, color: 'var(--color-text-dim)' }}>
                      Tile selected · ({selectedTile.x}, {selectedTile.y})
                    </span>
                    <button
                      type="button"
                      className="btn btn--secondary"
                      data-testid="map-editor-tile-deselect"
                      style={{ height: 22, fontSize: 11, padding: '0 8px' }}
                      onClick={() => setSelectedTile(null)}
                      title="Clear tile selection - restores the route + encounter view."
                    >
                      Deselect tile
                    </button>
                  </div>
                  {currentCell ? (
                    <TilePropertiesEditor
                      mapId={map.id}
                      cell={selectedTile}
                      currentCell={currentCell}
                      layoutOffset={binaryRomPrimaryBlocksOffset}
                      mapWidth={layout.data.width}
                      mapHeight={layout.data.height}
                      mapCells={layout.data.cells}
                      metatilePixels={metatilePixels}
                      onSaved={() => void refetchBinaryRomMap()}
                      tilesetStructOffset={binaryRomPrimaryTilesetOffset}
                      secondaryTilesetStructOffset={
                        binaryRomSecondaryTilesetOffset > 0
                          ? binaryRomSecondaryTilesetOffset
                          : undefined
                      }
                      numMetatilesInPrimary={tilesetBoundaries.numMetatilesInPrimary}
                      family={family}
                    />
                  ) : (
                    <p className="map-editor__inspector-empty">
                      Tile out of bounds.
                    </p>
                  )}
                  <hr style={{ margin: '16px 0', borderColor: 'var(--color-border)', opacity: 0.5 }} />
                  <MapHeaderEditor
                    map={map}
                    manifest={manifest}
                    showInternalIds={showInternalIds}
                  />
                </>
              );
            })()
          ) : isBinaryRomMap ? (
            // Phase I.4 - when nothing is selected on a binary-ROM map,
            // surface the map-header editor so the operator can change
            // music / region map section / weather / battle type without
            // navigating away. This is also where the user fixes
            // "Unnamed area #188" - set the region map section id to a
            // detected slot and the name resolves at next scan.
            <MapHeaderEditor
              map={map}
              manifest={manifest}
              showInternalIds={showInternalIds}
            />
          ) : (
            <p className="map-editor__inspector-empty">
              {paintTool === 'pointer'
                ? `Click a marker or tile to inspect. ${objectEvents.length} object events, ${warps.length} outgoing warps, ${triggers.length} triggers on this map.`
                : `Paint mode active (${paintTool}). Switch to the pointer tool to inspect tiles.`}
            </p>
          )}
        </aside>
      </div>
      {resizeModalOpen && (
        <MapResizeModal map={map} onClose={() => setResizeModalOpen(false)} />
      )}
    </div>
  );
}

function inferMapDimensions(
  map: MapNode,
): { width: number; height: number; inferred: boolean } {
  if (map.dimensions.width > 0 && map.dimensions.height > 0) {
    return { ...map.dimensions, inferred: false };
  }
  // Layout dimensions aren't yet parsed (deeper layout-binary decoding lands in
  // P6 asset work); infer a usable canvas size from the marker spread so the
  // scene isn't empty. Honest fallback - never reports faked dims.
  const allCoords = [
    ...map.objectEventIds,
    ...map.warpIds,
    // Use a sensible minimum so the canvas has a frame even with no markers.
  ];
  const fallback = Math.max(32, Math.ceil(Math.sqrt(allCoords.length) * 8));
  return { width: fallback, height: fallback, inferred: true };
}

interface PixiSceneProps {
  readonly options: MapSceneOptions;
}

function PixiScene({ options }: PixiSceneProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const teardownRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    let cancelled = false;
    const host = hostRef.current;
    if (!host) return;
    void renderMapScene(host, options).then((teardown) => {
      if (cancelled) {
        teardown();
        return;
      }
      teardownRef.current = teardown;
    });
    return () => {
      cancelled = true;
      if (teardownRef.current) {
        teardownRef.current();
        teardownRef.current = null;
      }
    };
  }, [options]);

  return <div ref={hostRef} className="map-editor__canvas" data-testid="map-editor-canvas" />;
}

interface SelectedInspectorProps {
  readonly selected: SelectedMarker;
  readonly map: MapNode;
  readonly manifest: ProjectManifest;
  readonly objectEvents: ReadonlyArray<ObjectEvent>;
  readonly warps: ReadonlyArray<Warp>;
  readonly triggers: ReadonlyArray<Trigger>;
  readonly sessionId: string | null;
  readonly bounds: { width: number; height: number } | null;
  readonly showInternalIds: boolean;
  /** Phase O.5 - OW sprite cache keyed by spriteStructFileOffset.
   *  When present and the selected NPC has a matching struct offset,
   *  the inspector renders the decoded sprite as a preview thumbnail. */
  readonly objectEventSprites: ReadonlyMap<
    number,
    { readonly width: number; readonly height: number; readonly rgba: Uint8ClampedArray }
  > | null;
}

function SelectedInspector({
  selected,
  map,
  manifest,
  objectEvents,
  warps,
  triggers,
  sessionId,
  bounds,
  showInternalIds,
  objectEventSprites,
}: SelectedInspectorProps) {
  if (selected.kind === 'objectEvent') {
    const o = objectEvents.find((x) => x.id === selected.id);
    if (!o) return <p>This object event is no longer available.</p>;
    return (
      <div className="map-editor__selected" data-testid="map-editor-selected-objectEvent">
        <KindBadge label="object event" color="#b46aff" />
        <h4>{prettifyObjectName(o.name, o.id)}</h4>
        {/* Phase O.5 - small visual sprite preview pulled from the
            already-decoded objectEventSprites cache. Renders a 2× scaled
            canvas when the sprite is in the cache; falls back to a
            placeholder with the graphics-id label otherwise so the
            operator can at least see what graphics_id maps where. */}
        <ObjectEventSpritePreview objectEvent={o} cache={objectEventSprites} />
        <dl>
          <dt>Type</dt><dd>{prettifyObjectKind(o.kind)}</dd>
          <dt>Position</dt><dd>({o.coord.x}, {o.coord.y}), elevation {o.elevation}</dd>
          <dt>Sprite</dt><dd>{displayName(manifest, o.graphicsId, showInternalIds)}</dd>
          <dt>Movement</dt><dd>{displayName(manifest, o.movementType, showInternalIds)}</dd>
          <dt>Script</dt><dd>{displayName(manifest, o.scriptId, showInternalIds)}</dd>
          <dt>Flag</dt><dd>{displayName(manifest, o.flagId, showInternalIds)}</dd>
          {o.trainerType && o.trainerType !== 'TRAINER_TYPE_NONE' && (
            <>
              <dt>Trainer</dt><dd>{displayName(manifest, o.trainerType, showInternalIds)}</dd>
            </>
          )}
        </dl>
        <CoordEditor
          kind="objectEvent"
          entityId={o.id}
          initialX={o.coord.x}
          initialY={o.coord.y}
          sessionId={sessionId}
          bounds={bounds}
        />
        <ObjectEventFieldsEditor objectEvent={o} sessionId={sessionId} />
        {/* Phase J.6 - surface the trainer party (read-only) when this
            NPC is a trainer. We resolve trainerId by walking the
            decoded script for trainerbattle. */}
        <TrainerPartyView objectEvent={o} manifest={manifest} />
        {/* WP3 - Visual Script card list (plain-English summary of every
            step, click a card to open it in the right-rail inspector for
            editing). Renders above the legacy ScriptStepsList which is
            kept collapsed-by-default as the inline edit surface for
            power users who want all editors at once. */}
        {o.scriptId && (
          <>
            <VisualScriptEditor scriptId={o.scriptId} manifest={manifest} />
            <ScriptStepsList scriptId={o.scriptId} manifest={manifest} />
          </>
        )}
      </div>
    );
  }
  if (selected.kind === 'warp') {
    const w = warps.find((x) => x.id === selected.id);
    if (!w) return <p>This warp is no longer available.</p>;
    const toMapName = displayName(manifest, w.toMapId, showInternalIds);
    return (
      <div className="map-editor__selected" data-testid="map-editor-selected-warp">
        <KindBadge label="warp" color="#4a9eff" />
        <h4>{prettifyWarpName(w.name, w.id)}</h4>
        <dl>
          <dt>From</dt><dd>{prettifyMapName(map.name, map.id)} @ ({w.fromCoord.x}, {w.fromCoord.y})</dd>
          <dt>To</dt><dd>{toMapName} @ ({w.toCoord.x}, {w.toCoord.y})</dd>
        </dl>
        <CoordEditor
          kind="warp"
          entityId={w.id}
          initialX={w.fromCoord.x}
          initialY={w.fromCoord.y}
          sessionId={sessionId}
          bounds={bounds}
        />
        <WarpFieldsEditor warp={w} sessionId={sessionId} />
      </div>
    );
  }
  const t = triggers.find((x) => x.id === selected.id);
  if (!t) return <p>This trigger is no longer available.</p>;
  return (
    <div className="map-editor__selected" data-testid="map-editor-selected-trigger">
      <KindBadge label="trigger" color="#f0b429" />
      <h4>{prettifyTriggerName(t.name, t.id)}</h4>
      <dl>
        <dt>Behavior</dt><dd>{prettifyTriggerKind(t.kind)}</dd>
        <dt>Position</dt><dd>{t.coord ? `(${t.coord.x}, ${t.coord.y})` : ' - '}</dd>
        <dt>Condition</dt><dd>{t.conditionExpression ?? 'Always fires'}</dd>
        <dt>Script steps</dt><dd>{t.scriptStepIds.length}</dd>
      </dl>
      {t.coord && (
        <CoordEditor
          kind="trigger"
          entityId={t.id}
          initialX={t.coord.x}
          initialY={t.coord.y}
          sessionId={sessionId}
          bounds={bounds}
        />
      )}
      {/* Phase J.1 - editable trigger fields (sign Behavior, coord-trigger
          var/value, elevation). Only fires for binary-rom triggers that
          have a `structFileOffset` stashed on metadata; decomp triggers
          flow through EventsView's ConditionEditor. */}
      <TriggerFieldsEditor trigger={t} />
      {/* WP3 - Visual Script card list above the legacy ScriptStepsList.
          Same pattern as the ObjectEvent branch above: cards for clean
          plain-English summaries + click-to-inspect; the old surface
          stays as the always-available inline edit fallback. */}
      {t.scriptStepIds.length > 0 && (
        <>
          <VisualScriptEditor scriptId={t.scriptStepIds[0]!} manifest={manifest} />
          <ScriptStepsList scriptId={t.scriptStepIds[0]!} manifest={manifest} />
        </>
      )}
    </div>
  );
}

interface CoordEditorProps {
  readonly kind: 'objectEvent' | 'warp' | 'trigger';
  readonly entityId: string;
  readonly initialX: number;
  readonly initialY: number;
  readonly sessionId: string | null;
  readonly bounds: { width: number; height: number } | null;
}

type SaveState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'saving' }
  | { readonly kind: 'saved' }
  | { readonly kind: 'error'; readonly message: string };

function CoordEditor({
  kind,
  entityId,
  initialX,
  initialY,
  sessionId,
  bounds,
}: CoordEditorProps) {
  const scanCurrent = useProjectStore((s) => s.scanCurrentProject);
  const [x, setX] = useState(initialX);
  const [y, setY] = useState(initialY);
  const [state, setState] = useState<SaveState>({ kind: 'idle' });
  // Reset local form when the selection changes.
  useEffect(() => {
    setX(initialX);
    setY(initialY);
    setState({ kind: 'idle' });
  }, [initialX, initialY, entityId]);

  function validate(): string | null {
    if (!Number.isInteger(x) || x < 0) return 'X must be a non-negative integer';
    if (!Number.isInteger(y) || y < 0) return 'Y must be a non-negative integer';
    if (bounds && (x >= bounds.width || y >= bounds.height)) {
      return `Out of bounds (${bounds.width}×${bounds.height})`;
    }
    return null;
  }

  const validationError = validate();
  const dirty = x !== initialX || y !== initialY;

  async function save(): Promise<void> {
    if (!sessionId) return;
    if (validationError) return;
    setState({ kind: 'saving' });
    try {
      await apiMoveEvent(sessionId, kind, entityId, x, y);
      setState({ kind: 'saved' });
      await scanCurrent();
    } catch (e) {
      const msg =
        e instanceof ProjectApiError
          ? `${e.code}: ${e.message}`
          : e instanceof Error
            ? e.message
            : String(e);
      setState({ kind: 'error', message: msg });
    }
  }

  return (
    <div className="coord-editor" data-testid={`coord-editor-${kind}`}>
      <h5 className="coord-editor__heading">Move</h5>
      <div className="coord-editor__row">
        <label>
          x
          <input
            type="number"
            data-testid={`coord-editor-x-${kind}`}
            min={0}
            value={x}
            onChange={(e) => setX(Number.parseInt(e.target.value, 10))}
          />
        </label>
        <label>
          y
          <input
            type="number"
            data-testid={`coord-editor-y-${kind}`}
            min={0}
            value={y}
            onChange={(e) => setY(Number.parseInt(e.target.value, 10))}
          />
        </label>
        <button
          type="button"
          className="btn btn--primary"
          data-testid={`coord-editor-save-${kind}`}
          disabled={!dirty || !!validationError || state.kind === 'saving' || !sessionId}
          onClick={() => void save()}
        >
          {state.kind === 'saving' ? 'Saving…' : 'Save'}
        </button>
      </div>
      {validationError && dirty && (
        <div
          className="coord-editor__error"
          data-testid={`coord-editor-error-${kind}`}
        >
          {validationError}
        </div>
      )}
      {state.kind === 'error' && (
        <div className="coord-editor__error">{state.message}</div>
      )}
      {state.kind === 'saved' && !dirty && (
        <div className="coord-editor__ok">Saved · map.json rewritten + manifest re-scanned.</div>
      )}
    </div>
  );
}

function KindBadge({ label, color }: { label: string; color: string }) {
  return (
    <span className="map-editor__kind-badge" style={{ color }}>
      {label}
    </span>
  );
}

/** Phase O.5 - Sprite thumbnail for the NPC inspector. Pulls the
 *  already-decoded RGBA from the parent's `objectEventSprites` cache
 *  (the map-editor canvas decodes once per unique struct offset) and
 *  paints it into a 2×-scaled canvas. Falls back to a placeholder
 *  showing the graphics_id when the sprite isn't in the cache (e.g.
 *  OBJ palette detector returned not_detected → grayscale silhouette
 *  is still drawn, just without color). */
function ObjectEventSpritePreview({
  objectEvent,
  cache,
}: {
  objectEvent: ObjectEvent;
  cache: ReadonlyMap<
    number,
    { readonly width: number; readonly height: number; readonly rgba: Uint8ClampedArray }
  > | null;
}): JSX.Element {
  const structOff =
    typeof objectEvent.metadata['spriteStructFileOffset'] === 'number'
      ? (objectEvent.metadata['spriteStructFileOffset'] as number)
      : null;
  const sprite = structOff !== null && cache ? cache.get(structOff) ?? null : null;
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    if (!sprite || !canvasRef.current) return;
    const canvas = canvasRef.current;
    canvas.width = sprite.width;
    canvas.height = sprite.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const imageData = ctx.createImageData(sprite.width, sprite.height);
    imageData.data.set(sprite.rgba);
    ctx.putImageData(imageData, 0, 0);
  }, [sprite]);
  if (!sprite) {
    return (
      <div
        className="map-editor__sprite-preview map-editor__sprite-preview--missing"
        data-testid="sprite-preview-missing"
        title="No decoded sprite available for this NPC (re-scan after a detector update may surface it)"
      >
        <span style={{ fontSize: 10, color: 'var(--color-text-muted)' }}>
          {objectEvent.graphicsId ?? 'no graphics_id'}
        </span>
      </div>
    );
  }
  return (
    <div
      className="map-editor__sprite-preview"
      data-testid="sprite-preview"
      title={`Decoded OW sprite (${sprite.width}×${sprite.height}px)`}
    >
      <canvas
        ref={canvasRef}
        style={{
          imageRendering: 'pixelated',
          width: sprite.width * 2,
          height: sprite.height * 2,
        }}
      />
    </div>
  );
}
