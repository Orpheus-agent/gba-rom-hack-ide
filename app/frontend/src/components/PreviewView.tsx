import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import { BuildLauncher } from './BuildLauncher';
import { BreakpointsPanel } from './BreakpointsPanel';
import { RenderCostMeter } from './RenderCostMeter';
import {
  emptyBreakpointState,
  evaluateBreakpoints,
  recordHits,
  type BreakpointState,
} from '../lib/previewBreakpoints';
import { fetchLayout, fetchLayoutTiles } from '../api';
import { useProjectStore } from '../state';
import './PreviewView.css';

type OverlayKey = 'collision' | 'warps' | 'triggers' | 'flag_gates';

const DEFAULT_OVERLAYS: ReadonlyArray<OverlayKey> = ['warps', 'triggers'];

const TILE_SIZE_PX = 16;

interface PreviewViewProps {
  readonly manifest: ProjectManifest;
}

type LayoutState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'loading' }
  | { readonly kind: 'loaded'; readonly data: LayoutData }
  | { readonly kind: 'error'; readonly message: string };

export function PreviewView({ manifest }: PreviewViewProps) {
  const [selectedMapId, setSelectedMapId] = useState<string | null>(
    manifest.maps[0]?.id ?? null,
  );
  const [enabledOverlays, setEnabledOverlays] = useState<ReadonlySet<OverlayKey>>(
    new Set(DEFAULT_OVERLAYS),
  );
  const [playerPos, setPlayerPos] = useState<{ x: number; y: number } | null>(null);
  const [breakpointState, setBreakpointState] = useState<BreakpointState>(() =>
    emptyBreakpointState(),
  );

  // Reset player + overlay state when changing maps so stale coords don't leak.
  useEffect(() => {
    setPlayerPos(null);
  }, [selectedMapId]);

  // Evaluate armed breakpoints whenever the player moves on the selected map.
  useEffect(() => {
    if (!playerPos || !selectedMapId) return;
    const matches = evaluateBreakpoints(breakpointState, manifest, selectedMapId, playerPos);
    if (matches.length > 0) {
      setBreakpointState((s) => recordHits(s, matches));
    }
    // We intentionally do NOT re-run when breakpointState changes - only when
    // the player tile or manifest changes; otherwise recording a hit would
    // trigger an infinite recursion. The arm/disarm UI updates breakpoint
    // membership but evaluation re-fires on the next player move.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playerPos, selectedMapId, manifest]);

  const selectedMap = useMemo<MapNode | null>(
    () => manifest.maps.find((m) => m.id === selectedMapId) ?? null,
    [manifest.maps, selectedMapId],
  );

  const toggleOverlay = useCallback((key: OverlayKey): void => {
    setEnabledOverlays((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  if (manifest.maps.length === 0) {
    return (
      <div className="preview-view preview-view--empty" data-testid="preview-view-empty">
        <h2>No maps to preview</h2>
        <p>
          The project scan didn't produce any <code>MapNode</code> entries. Open a project with
          <code>data/maps/*/map.json</code> and scan it from the Project view.
        </p>
      </div>
    );
  }

  return (
    <div className="preview-view" data-testid="preview-view">
      <aside className="preview-view__rail" aria-label="Map picker">
        <h3 className="preview-view__rail-heading">
          Maps <span className="preview-view__rail-count">({manifest.maps.length})</span>
        </h3>
        <ul className="preview-view__map-list">
          {manifest.maps.map((m) => (
            <li key={m.id}>
              <button
                type="button"
                className={`preview-view__map-item${m.id === selectedMapId ? ' preview-view__map-item--selected' : ''}`}
                data-testid={`preview-map-${m.id}`}
                onClick={() => setSelectedMapId(m.id)}
                style={{ borderLeftColor: GROUP_COLORS[m.group] }}
              >
                <span className="preview-view__map-name">{m.name}</span>
                <span
                  className="preview-view__map-group"
                  style={{ color: GROUP_COLORS[m.group] }}
                >
                  {m.group}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </aside>
      <section className="preview-view__main">
        {selectedMap ? (
          <PreviewScene
            manifest={manifest}
            map={selectedMap}
            enabledOverlays={enabledOverlays}
            toggleOverlay={toggleOverlay}
            playerPos={playerPos}
            setPlayerPos={setPlayerPos}
            breakpointState={breakpointState}
            setBreakpointState={setBreakpointState}
          />
        ) : (
          <div className="preview-view__placeholder" data-testid="preview-view-placeholder">
            Pick a map from the left rail to preview it.
          </div>
        )}
      </section>
    </div>
  );
}

interface PreviewSceneProps {
  readonly manifest: ProjectManifest;
  readonly map: MapNode;
  readonly enabledOverlays: ReadonlySet<OverlayKey>;
  readonly toggleOverlay: (k: OverlayKey) => void;
  readonly playerPos: { x: number; y: number } | null;
  readonly setPlayerPos: (p: { x: number; y: number } | null) => void;
  readonly breakpointState: BreakpointState;
  readonly setBreakpointState: (next: BreakpointState) => void;
}

/** Outer (per-map-pane) toolbar - also carries the BuildLauncher so the writer
 *  can run the detected build without leaving the Preview tab. */
function PreviewToolbar({
  manifest,
  map,
  dims,
  enabledOverlays,
  toggleOverlay,
}: {
  manifest: ProjectManifest;
  map: MapNode;
  dims: { width: number; height: number };
  enabledOverlays: ReadonlySet<OverlayKey>;
  toggleOverlay: (k: OverlayKey) => void;
}) {
  return (
    <header className="preview-scene__toolbar">
      <div className="preview-scene__title">
        <span
          className="preview-scene__title-group"
          style={{ color: GROUP_COLORS[map.group] }}
        >
          {map.group}
        </span>
        <span className="preview-scene__title-name" data-testid="preview-scene-name">
          {map.name}
        </span>
        <span className="preview-scene__title-dim">
          {dims.width}×{dims.height}
        </span>
      </div>
      <div className="preview-scene__overlay-toggles" role="group" aria-label="Debug overlays">
        {(['collision', 'warps', 'triggers', 'flag_gates'] as const).map((key) => (
          <label key={key} className="preview-scene__overlay-toggle">
            <input
              type="checkbox"
              checked={enabledOverlays.has(key)}
              onChange={() => toggleOverlay(key)}
              data-testid={`preview-overlay-${key}`}
            />
            <span>{overlayLabel(key)}</span>
          </label>
        ))}
      </div>
      <div className="preview-scene__build">
        <BuildLauncher buildProfile={manifest.buildProfile} />
      </div>
    </header>
  );
}

function PreviewScene({
  manifest,
  map,
  enabledOverlays,
  toggleOverlay,
  playerPos,
  setPlayerPos,
  breakpointState,
  setBreakpointState,
}: PreviewSceneProps) {
  const sessionId = useProjectStore((s) =>
    s.load.kind === 'loaded' ? s.load.data.session.id : null,
  );
  const [layout, setLayout] = useState<LayoutState>({ kind: 'idle' });
  // Composed real-tile pixels (metatileId → 16×16 RGBA). Fed to the scene so
  // the map renders the actual world; null/empty falls back to placeholders.
  const [metatilePixels, setMetatilePixels] = useState<ReadonlyMap<number, Uint32Array> | null>(
    null,
  );

  const layoutName = layoutNameFor(map);

  useEffect(() => {
    let cancelled = false;
    if (!sessionId || !layoutName) {
      setLayout({ kind: 'idle' });
      setMetatilePixels(null);
      return;
    }
    setLayout({ kind: 'loading' });
    setMetatilePixels(null);
    void (async () => {
      try {
        const data = await fetchLayout(sessionId, layoutName);
        if (!cancelled) setLayout({ kind: 'loaded', data });
      } catch (e) {
        if (!cancelled) {
          setLayout({
            kind: 'error',
            message: e instanceof Error ? e.message : String(e),
          });
        }
        return;
      }
      // Best-effort: compose the real tiles. The map still works (markers,
      // collision, clicks) if this fails - it just shows placeholders.
      try {
        const tiles = await fetchLayoutTiles(sessionId, layoutName);
        if (!cancelled) setMetatilePixels(tiles);
      } catch {
        if (!cancelled) setMetatilePixels(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sessionId, layoutName]);

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

  const dims =
    layout.kind === 'loaded'
      ? { width: layout.data.width, height: layout.data.height }
      : { width: map.dimensions.width, height: map.dimensions.height };

  const tileGrid =
    layout.kind === 'loaded'
      ? { width: layout.data.width, height: layout.data.height, cells: layout.data.cells }
      : null;

  // Convert the React overlay toggles to the scene's layer set. Tiles always on.
  const sceneLayers = useMemo<MapSceneOptions['layers']>(() => {
    const s = new Set<'tiles' | 'collision' | 'objects' | 'warps' | 'triggers'>(['tiles', 'objects']);
    if (enabledOverlays.has('collision')) s.add('collision');
    if (enabledOverlays.has('warps')) s.add('warps');
    if (enabledOverlays.has('triggers')) s.add('triggers');
    return s;
  }, [enabledOverlays]);

  const [deriveMs, setDeriveMs] = useState<number | null>(null);
  const [mountMs, setMountMs] = useState<number | null>(null);

  const sceneOptions = useMemo<MapSceneOptions>(() => {
    const t0 = performance.now();
    const opts: MapSceneOptions = {
      width: dims.width * TILE_SIZE_PX,
      height: dims.height * TILE_SIZE_PX,
      tileSize: TILE_SIZE_PX,
      layers: sceneLayers,
      objectEvents,
      warps,
      triggers,
      tileGrid,
      metatilePixels,
      selectedId: null,
      groupColor: GROUP_COLORS[map.group],
      onSelect: () => {
        /* preview doesn't select markers - clicks place the player */
      },
    };
    // Measurement intentionally outside React render commit - schedules a
    // state update via setTimeout(0) to avoid setState-during-render warnings.
    const elapsed = performance.now() - t0;
    setTimeout(() => setDeriveMs(elapsed), 0);
    return opts;
  }, [
    dims.width,
    dims.height,
    sceneLayers,
    objectEvents,
    warps,
    triggers,
    tileGrid,
    metatilePixels,
    map.group,
  ]);

  const hostRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let teardown: (() => void) | undefined;
    let cancelled = false;
    const t0 = performance.now();
    void (async () => {
      const t = await renderMapScene(host, sceneOptions);
      const elapsed = performance.now() - t0;
      if (cancelled) {
        t();
        return;
      }
      teardown = t;
      setMountMs(elapsed);
    })();
    return () => {
      cancelled = true;
      if (teardown) teardown();
    };
  }, [sceneOptions]);

  function handleCanvasClick(e: React.MouseEvent<HTMLDivElement>): void {
    const wrap = e.currentTarget;
    const rect = wrap.getBoundingClientRect();
    const x = Math.floor((e.clientX - rect.left) / TILE_SIZE_PX);
    const y = Math.floor((e.clientY - rect.top) / TILE_SIZE_PX);
    if (x < 0 || y < 0 || x >= dims.width || y >= dims.height) return;
    setPlayerPos({ x, y });
  }

  // Compute "what's under the player" for the inspector.
  const playerCell =
    playerPos && tileGrid
      ? tileGrid.cells[playerPos.y * tileGrid.width + playerPos.x] ?? null
      : null;
  const playerObjectEvent =
    playerPos &&
    objectEvents.find((o) => o.coord.x === playerPos.x && o.coord.y === playerPos.y);
  const playerWarp =
    playerPos &&
    warps.find((w) => w.fromCoord.x === playerPos.x && w.fromCoord.y === playerPos.y);
  const playerTrigger =
    playerPos &&
    triggers.find(
      (t) => t.coord && t.coord.x === playerPos.x && t.coord.y === playerPos.y,
    );

  // Flag-gate overlay: which objects are gated by a flag?
  const gatedObjectIds = useMemo(() => {
    if (!enabledOverlays.has('flag_gates')) return new Set<string>();
    return new Set(objectEvents.filter((o) => o.flagId).map((o) => o.id));
  }, [enabledOverlays, objectEvents]);

  return (
    <div className="preview-scene" data-testid="preview-scene">
      <PreviewToolbar
        manifest={manifest}
        map={map}
        dims={dims}
        enabledOverlays={enabledOverlays}
        toggleOverlay={toggleOverlay}
      />
      <div className="preview-scene__body">
        <div
          className="preview-scene__canvas-wrap"
          onClick={handleCanvasClick}
          data-testid="preview-scene-canvas-wrap"
        >
          <div
            ref={hostRef}
            className="preview-scene__canvas"
            data-testid="preview-scene-canvas"
          />
          {playerPos && (
            <div
              className="preview-scene__player"
              data-testid="preview-scene-player"
              style={{
                left: `${playerPos.x * TILE_SIZE_PX}px`,
                top: `${playerPos.y * TILE_SIZE_PX}px`,
                width: `${TILE_SIZE_PX}px`,
                height: `${TILE_SIZE_PX}px`,
              }}
              title={`Player @ (${playerPos.x}, ${playerPos.y})`}
            />
          )}
          {/* Flag-gate halos rendered as HTML overlay (the pixi scene doesn't
              know about flag gating; this avoids touching mapEditorScene). */}
          {enabledOverlays.has('flag_gates') &&
            objectEvents
              .filter((o) => gatedObjectIds.has(o.id))
              .map((o) => (
                <div
                  key={o.id}
                  className="preview-scene__gate-halo"
                  data-testid={`preview-gate-halo-${o.id}`}
                  style={{
                    left: `${o.coord.x * TILE_SIZE_PX - 2}px`,
                    top: `${o.coord.y * TILE_SIZE_PX - 2}px`,
                    width: `${TILE_SIZE_PX + 4}px`,
                    height: `${TILE_SIZE_PX + 4}px`,
                  }}
                  title={`Gated by ${o.flagId}`}
                />
              ))}
        </div>
        <aside className="preview-scene__inspector" data-testid="preview-scene-inspector">
          {!playerPos ? (
            <div className="preview-scene__placeholder">
              Click on the canvas to drop the player marker. The inspector will show what's
              under it - tile collision, object events, warps, and triggers.
            </div>
          ) : (
            <PlayerInspector
              pos={playerPos}
              cell={playerCell}
              objectEvent={playerObjectEvent || null}
              warp={playerWarp || null}
              trigger={playerTrigger || null}
            />
          )}
          {layout.kind === 'error' && (
            <div className="preview-scene__layout-err" data-testid="preview-layout-error">
              Layout load failed: {layout.message}. Tile grid won't render; markers + overlays still work.
            </div>
          )}
          <BreakpointsPanel state={breakpointState} onChange={setBreakpointState} />
          <RenderCostMeter deriveMs={deriveMs} mountMs={mountMs} />
        </aside>
      </div>
    </div>
  );
}

function PlayerInspector({
  pos,
  cell,
  objectEvent,
  warp,
  trigger,
}: {
  pos: { x: number; y: number };
  cell: { metatileId: number; collision: number; elevation: number } | null;
  objectEvent: ObjectEvent | null;
  warp: Warp | null;
  trigger: Trigger | null;
}) {
  return (
    <div className="player-inspector">
      <h4 className="player-inspector__heading">Player @ ({pos.x}, {pos.y})</h4>
      <dl className="player-inspector__fields">
        {cell && (
          <span style={{ display: 'contents' }}>
            <dt>Tile</dt>
            <dd>
              metatile {cell.metatileId} · collision {cell.collision} · elev {cell.elevation}
            </dd>
          </span>
        )}
        {objectEvent && (
          <span style={{ display: 'contents' }}>
            <dt>Object</dt>
            <dd data-testid="player-inspector-object">
              {objectEvent.id} · {objectEvent.kind}
              {objectEvent.flagId && ` · gated by ${objectEvent.flagId}`}
            </dd>
          </span>
        )}
        {warp && (
          <span style={{ display: 'contents' }}>
            <dt>Warp</dt>
            <dd data-testid="player-inspector-warp">
              → {warp.toMapId} @ ({warp.toCoord.x}, {warp.toCoord.y})
            </dd>
          </span>
        )}
        {trigger && (
          <span style={{ display: 'contents' }}>
            <dt>Trigger</dt>
            <dd data-testid="player-inspector-trigger">
              {trigger.id} · {trigger.kind}
              {trigger.conditionExpression && ` · if ${trigger.conditionExpression}`}
            </dd>
          </span>
        )}
        {!cell && !objectEvent && !warp && !trigger && (
          <span style={{ display: 'contents' }}>
            <dt>Nothing</dt>
            <dd>This tile has no indexed event or warp.</dd>
          </span>
        )}
      </dl>
    </div>
  );
}

function overlayLabel(key: OverlayKey): string {
  switch (key) {
    case 'collision':
      return 'Collision';
    case 'warps':
      return 'Warps';
    case 'triggers':
      return 'Triggers';
    case 'flag_gates':
      return 'Flag gates';
  }
}

function layoutNameFor(map: MapNode): string | null {
  // pokeemerald convention: layout id like LAYOUT_LITTLEROOT_TOWN. Map metadata
  // typically carries it; if not present, fall back to deriving from the map id.
  const meta = map.metadata['layout'];
  if (typeof meta === 'string' && meta.length > 0) return meta;
  return null;
}
