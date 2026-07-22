// The Real Game Editor Push - PixiJS region atlas scene.
//
// Replaces MapsGraph (ReactFlow node graph) with a PixiJS-rendered
// region map: each map appears as a colored rectangle positioned by
// its regionMapSection (x, y) tile coordinates from the manifest's
// region map sections table. Maps without a resolvable region coord
// fall to a force-directed-ish "Unlocated" grid below the region area.
//
// Structures (Silph Co = one expandable node) are collapsed via
// inferStructures so the atlas reads as buildings rather than dozens
// of floor stubs.
//
// Tile-graphics background (decoded region map tile sheet) is OUT OF
// SCOPE for this iteration - the engine has the section table scanner
// but not the graphics scanner yet. The scene draws a neutral PixiJS
// canvas with thin grid lines instead; this is strictly better than
// ReactFlow's free-floating boxes (positions actually correspond to
// in-game geography) and the graphics background is an additive
// follow-up that won't change the scene's API shape.

import type {
  MapNode as ProjectMapNode,
  ProjectManifest,
  RegionMapSectionEntry,
} from '@rom-editor/shared';
import type { Structure } from '../lib/structures';
import { prettifyMapName } from '../lib/displayName';
import { GROUP_COLORS } from '../components/MapsGraph';
import {
  describeMarker,
  markerGlyph,
  type StoryArcMarker,
} from '../lib/storyArcInference';

const REGION_TILE_PX = 24;
const ATLAS_BG = 0x1a1d24;
const GRID_COLOR = 0x2a2c33;
const GRID_STRONG_COLOR = 0x34363c;
const SELECTED_COLOR = 0xffffff;
const STRUCTURE_BORDER_COLOR = 0xf0b429;

export interface RegionAtlasOptions {
  readonly manifest: ProjectManifest;
  readonly structures: ReadonlyArray<Structure>;
  readonly selectedMapId: string | null;
  readonly onSelectMap: (mapId: string) => void;
  readonly onOpenMap: (mapId: string) => void;
  /** Optional story-arc markers (gym/rival/champion/key item) drawn as
   *  small badges anchored to each map's pin position. Defaults to none. */
  readonly storyMarkers?: ReadonlyArray<{
    readonly mapId: string;
    readonly marker: StoryArcMarker;
  }>;
}

/** Mount a PixiJS region atlas inside `host` and render `options`.
 *  Returns a teardown function. Lazy-loads PixiJS so the home view
 *  doesn't pay the cost until the user actually opens the atlas. */
export async function renderRegionAtlasScene(
  host: HTMLDivElement,
  options: RegionAtlasOptions,
): Promise<() => void> {
  let pixi: typeof import('pixi.js');
  try {
    pixi = await import('pixi.js');
  } catch (e) {
    host.innerHTML = `<div class="region-atlas__fallback">PixiJS unavailable: ${escapeHtml(stringifyError(e))}</div>`;
    return () => {
      host.innerHTML = '';
    };
  }

  const { Application, Container, Graphics, Text, Sprite, Texture } = pixi;
  void Sprite;
  void Texture;
  const hostRect = host.getBoundingClientRect();
  const canvasWidth = Math.max(200, Math.floor(hostRect.width));
  const canvasHeight = Math.max(200, Math.floor(hostRect.height));

  const app = new Application();
  try {
    await app.init({
      width: canvasWidth,
      height: canvasHeight,
      background: ATLAS_BG,
      antialias: true,
      autoDensity: true,
    });
  } catch (e) {
    host.innerHTML = `<div class="region-atlas__fallback">Canvas init failed: ${escapeHtml(stringifyError(e))}</div>`;
    return () => {
      host.innerHTML = '';
    };
  }

  host.innerHTML = '';
  host.appendChild(app.canvas);
  app.canvas.style.width = '100%';
  app.canvas.style.height = '100%';
  app.canvas.style.display = 'block';
  app.canvas.style.cursor = 'grab';

  const world = new Container();
  app.stage.addChild(world);

  // Sections + maps + structure clustering.
  const sectionsByIndex = new Map<number, RegionMapSectionEntry>();
  for (const s of options.manifest.regionMapSections ?? []) {
    sectionsByIndex.set(s.sectionIndex, s);
  }

  // For each map, figure out its (x, y, w, h) in the atlas. Three cases:
  //   1) Map belongs to a Structure - render under the structure cluster.
  //   2) Map has a resolvable regionMapSection → use that (x, y, w, h).
  //   3) Map has no region position → "Unlocated" grid below.
  const mapsById = new Map<string, ProjectMapNode>();
  for (const m of options.manifest.maps) mapsById.set(m.id, m);
  const mapIdsInStructure = new Set<string>();
  for (const st of options.structures) {
    for (const id of st.memberIds) mapIdsInStructure.add(id);
  }
  // Resolve each structure's memberIds → MapNode entries up-front.
  const structureMembers = new Map<string, ReadonlyArray<ProjectMapNode>>();
  for (const st of options.structures) {
    const members: ProjectMapNode[] = [];
    for (const id of st.memberIds) {
      const m = mapsById.get(id);
      if (m) members.push(m);
    }
    structureMembers.set(st.id, members);
  }

  // Compute the region bounding box so we can scale the canvas to fit.
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const standaloneMaps: Array<{
    map: ProjectMapNode;
    rect: { x: number; y: number; w: number; h: number };
  }> = [];
  for (const m of options.manifest.maps) {
    if (mapIdsInStructure.has(m.id)) continue;
    const sectionIdx = m.metadata?.['regionMapSection'] ?? m.metadata?.['regionMapSectionId'];
    const idx = typeof sectionIdx === 'number' ? sectionIdx : null;
    const section = idx !== null ? sectionsByIndex.get(idx) : undefined;
    if (section && section.x >= 0 && section.y >= 0) {
      const rect = {
        x: section.x * REGION_TILE_PX,
        y: section.y * REGION_TILE_PX,
        w: Math.max(1, section.width) * REGION_TILE_PX,
        h: Math.max(1, section.height) * REGION_TILE_PX,
      };
      standaloneMaps.push({ map: m, rect });
      minX = Math.min(minX, rect.x);
      minY = Math.min(minY, rect.y);
      maxX = Math.max(maxX, rect.x + rect.w);
      maxY = Math.max(maxY, rect.y + rect.h);
    }
  }

  // Maps with no resolvable region - pack into a grid below.
  const unplacedMaps: ProjectMapNode[] = [];
  for (const m of options.manifest.maps) {
    if (mapIdsInStructure.has(m.id)) continue;
    if (standaloneMaps.some((s) => s.map.id === m.id)) continue;
    unplacedMaps.push(m);
  }

  // Decide if we have ANY region-positioned maps. If not, draw a force-
  // directed layout (a simple grid) for ALL standalone maps as fallback.
  if (!Number.isFinite(minX)) {
    minX = 0;
    minY = 0;
    maxX = 0;
    maxY = 0;
  }

  // Structures occupy their own region area. Render each as a single
  // bigger rectangle at the average of its child maps' region coords
  // (if any), else under the unlocated grid.
  const structureRects: Array<{
    structure: Structure;
    rect: { x: number; y: number; w: number; h: number };
  }> = [];
  for (const st of options.structures) {
    const members = structureMembers.get(st.id) ?? [];
    const positions = members
      .map((m) => {
        const idx =
          m.metadata?.['regionMapSection'] ?? m.metadata?.['regionMapSectionId'];
        const i = typeof idx === 'number' ? idx : null;
        const sec = i !== null ? sectionsByIndex.get(i) : undefined;
        if (sec && sec.x >= 0 && sec.y >= 0) {
          return {
            x: sec.x * REGION_TILE_PX,
            y: sec.y * REGION_TILE_PX,
            w: Math.max(1, sec.width) * REGION_TILE_PX,
            h: Math.max(1, sec.height) * REGION_TILE_PX,
          };
        }
        return null;
      })
      .filter((p): p is { x: number; y: number; w: number; h: number } => p !== null);
    if (positions.length > 0) {
      const sx = Math.min(...positions.map((p) => p.x));
      const sy = Math.min(...positions.map((p) => p.y));
      const ex = Math.max(...positions.map((p) => p.x + p.w));
      const ey = Math.max(...positions.map((p) => p.y + p.h));
      const rect = { x: sx, y: sy, w: ex - sx, h: ey - sy };
      structureRects.push({ structure: st, rect });
      minX = Math.min(minX, rect.x);
      minY = Math.min(minY, rect.y);
      maxX = Math.max(maxX, rect.x + rect.w);
      maxY = Math.max(maxY, rect.y + rect.h);
    } else {
      // Unplaced structure - defer to grid pack below.
      structureRects.push({ structure: st, rect: { x: 0, y: 0, w: 0, h: 0 } });
    }
  }

  // Layout the unplaced things in a grid BELOW the region area.
  // Width: pack into rows of 6 entries (configurable). Height: stack rows.
  const UNPLACED_BOX = REGION_TILE_PX * 4;
  const UNPLACED_COLS = 8;
  let unplacedY = (Number.isFinite(maxY) ? maxY : 0) + REGION_TILE_PX * 2;
  let unplacedCol = 0;
  for (const m of unplacedMaps) {
    const rect = {
      x: minX + unplacedCol * (UNPLACED_BOX + 8),
      y: unplacedY,
      w: UNPLACED_BOX,
      h: UNPLACED_BOX * 0.6,
    };
    standaloneMaps.push({ map: m, rect });
    maxX = Math.max(maxX, rect.x + rect.w);
    maxY = Math.max(maxY, rect.y + rect.h);
    unplacedCol++;
    if (unplacedCol >= UNPLACED_COLS) {
      unplacedCol = 0;
      unplacedY += UNPLACED_BOX * 0.6 + 8;
    }
  }
  // Same for unplaced structures.
  for (const sr of structureRects) {
    if (sr.rect.w === 0) {
      const rect = {
        x: minX + unplacedCol * (UNPLACED_BOX + 8),
        y: unplacedY,
        w: UNPLACED_BOX * 1.5,
        h: UNPLACED_BOX * 0.7,
      };
      sr.rect = rect;
      maxX = Math.max(maxX, rect.x + rect.w);
      maxY = Math.max(maxY, rect.y + rect.h);
      unplacedCol++;
      if (unplacedCol >= UNPLACED_COLS) {
        unplacedCol = 0;
        unplacedY += UNPLACED_BOX * 0.7 + 8;
      }
    }
  }

  // Compute world width / height for the fit-to-canvas calculation.
  const worldW = Math.max(1, maxX - minX + REGION_TILE_PX * 2);
  const worldH = Math.max(1, maxY - minY + REGION_TILE_PX * 2);
  const fitScale = Math.min(canvasWidth / worldW, canvasHeight / worldH) * 0.92;
  const initialScale = Math.max(0.15, Math.min(3, fitScale));
  app.stage.scale.set(initialScale, initialScale);
  app.stage.position.set(
    (canvasWidth - worldW * initialScale) / 2 - minX * initialScale + REGION_TILE_PX * initialScale,
    (canvasHeight - worldH * initialScale) / 2 - minY * initialScale + REGION_TILE_PX * initialScale,
  );

  // Background grid - thin lines every REGION_TILE_PX, stronger every 8.
  const gridStep = REGION_TILE_PX;
  const grid = new Graphics();
  const gridLeft = minX - REGION_TILE_PX;
  const gridTop = minY - REGION_TILE_PX;
  const gridRight = maxX + REGION_TILE_PX;
  const gridBottom = maxY + REGION_TILE_PX;
  for (let x = Math.floor(gridLeft / gridStep) * gridStep; x <= gridRight; x += gridStep) {
    const xi = Math.round((x - gridLeft) / gridStep);
    grid.moveTo(x, gridTop);
    grid.lineTo(x, gridBottom);
    grid.stroke({
      color: xi % 8 === 0 ? GRID_STRONG_COLOR : GRID_COLOR,
      width: 1,
      alpha: 0.5,
    });
  }
  for (let y = Math.floor(gridTop / gridStep) * gridStep; y <= gridBottom; y += gridStep) {
    const yi = Math.round((y - gridTop) / gridStep);
    grid.moveTo(gridLeft, y);
    grid.lineTo(gridRight, y);
    grid.stroke({
      color: yi % 8 === 0 ? GRID_STRONG_COLOR : GRID_COLOR,
      width: 1,
      alpha: 0.5,
    });
  }
  world.addChild(grid);

  // Connections between maps - drawn as lines BENEATH the map sprites
  // so they don't obscure interactive nodes. Index map centers by id.
  const mapCenters = new Map<string, { x: number; y: number }>();
  for (const { map, rect } of standaloneMaps) {
    mapCenters.set(map.id, { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 });
  }
  for (const { structure, rect } of structureRects) {
    for (const id of structure.memberIds) {
      mapCenters.set(id, { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 });
    }
  }
  // Draw warps as lines between source and target map centers (when both
  // are known). De-dupe so each pair of maps gets a single line, not one
  // per warp. Connections often run both directions; we draw once.
  const connectionLines = new Graphics();
  const drawnPairs = new Set<string>();
  for (const w of options.manifest.warps) {
    if (!w.toMapId || w.fromMapId === w.toMapId) continue;
    const a = mapCenters.get(w.fromMapId);
    const b = mapCenters.get(w.toMapId);
    if (!a || !b) continue;
    const pairKey =
      w.fromMapId < w.toMapId
        ? `${w.fromMapId}|${w.toMapId}`
        : `${w.toMapId}|${w.fromMapId}`;
    if (drawnPairs.has(pairKey)) continue;
    drawnPairs.add(pairKey);
    connectionLines.moveTo(a.x, a.y);
    connectionLines.lineTo(b.x, b.y);
    connectionLines.stroke({ color: 0x4a9eff, width: 1, alpha: 0.25 });
  }
  world.addChild(connectionLines);

  // Render standalone maps.
  for (const { map, rect } of standaloneMaps) {
    drawMapNode(world, pixi, map, rect, options);
  }
  // Render structures (one bigger node, with floor count badge).
  for (const { structure, rect } of structureRects) {
    const members = structureMembers.get(structure.id) ?? [];
    drawStructureNode(world, pixi, structure, members, rect, options);
  }

  // Story-arc markers - semantic badges (gym order, rival ★, champion 👑,
  // key item 🎒) anchored to each map's pin top-right corner. The atlas
  // pin already shows the map; the badge says "something narratively
  // important happens here."
  if (options.storyMarkers && options.storyMarkers.length > 0) {
    const rectByMapId = new Map<string, { x: number; y: number; w: number; h: number }>();
    for (const { map, rect } of standaloneMaps) rectByMapId.set(map.id, rect);
    for (const { structure, rect } of structureRects) {
      // Markers can target any of the structure's member maps; index them
      // all so a marker for Saffron's gym map lands on the Silph Co
      // structure pin (or wherever the inner gym member rendered).
      const members = structureMembers.get(structure.id) ?? [];
      for (const m of members) rectByMapId.set(m.id, rect);
      rectByMapId.set(structure.id, rect);
    }
    for (const { mapId, marker } of options.storyMarkers) {
      const rect = rectByMapId.get(mapId);
      if (!rect) continue;
      drawStoryMarker(world, pixi, marker, rect);
    }
  }

  // Pan / zoom controls - wheel zoom, drag pan. Mirrors the
  // mapEditorScene.ts pattern but simplified.
  let isDragging = false;
  let dragStart: { x: number; y: number; stageX: number; stageY: number } | null = null;
  const onPointerDown = (evt: PointerEvent) => {
    if (evt.button !== 0) return;
    if (evt.target !== app.canvas) return;
    isDragging = true;
    dragStart = {
      x: evt.clientX,
      y: evt.clientY,
      stageX: app.stage.position.x,
      stageY: app.stage.position.y,
    };
    app.canvas.style.cursor = 'grabbing';
  };
  const onPointerMove = (evt: PointerEvent) => {
    if (!isDragging || !dragStart) return;
    app.stage.position.set(
      dragStart.stageX + (evt.clientX - dragStart.x),
      dragStart.stageY + (evt.clientY - dragStart.y),
    );
  };
  const onPointerUp = () => {
    isDragging = false;
    dragStart = null;
    app.canvas.style.cursor = 'grab';
  };
  const onWheel = (evt: WheelEvent) => {
    evt.preventDefault();
    const rect = app.canvas.getBoundingClientRect();
    const cx = evt.clientX - rect.left;
    const cy = evt.clientY - rect.top;
    const oldScale = app.stage.scale.x;
    const zoom = evt.deltaY < 0 ? 1.1 : 1 / 1.1;
    const newScale = Math.max(0.1, Math.min(6, oldScale * zoom));
    // Zoom toward the cursor.
    const worldX = (cx - app.stage.position.x) / oldScale;
    const worldY = (cy - app.stage.position.y) / oldScale;
    app.stage.scale.set(newScale, newScale);
    app.stage.position.set(cx - worldX * newScale, cy - worldY * newScale);
  };
  app.canvas.addEventListener('pointerdown', onPointerDown);
  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp);
  app.canvas.addEventListener('wheel', onWheel, { passive: false });

  // Resize observer.
  const resizeObserver = new ResizeObserver(() => {
    const r = host.getBoundingClientRect();
    const w = Math.max(200, Math.floor(r.width));
    const h = Math.max(200, Math.floor(r.height));
    app.renderer.resize(w, h);
  });
  resizeObserver.observe(host);

  return () => {
    app.canvas.removeEventListener('pointerdown', onPointerDown);
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', onPointerUp);
    app.canvas.removeEventListener('wheel', onWheel);
    resizeObserver.disconnect();
    app.destroy(true, { children: true });
    host.innerHTML = '';
  };
}

function drawMapNode(
  world: import('pixi.js').Container,
  pixi: typeof import('pixi.js'),
  map: ProjectMapNode,
  rect: { x: number; y: number; w: number; h: number },
  options: RegionAtlasOptions,
): void {
  const { Graphics, Text } = pixi;
  const color = parseHex(GROUP_COLORS[map.group] ?? '#7c8088');
  const isSelected = options.selectedMapId === map.id;

  const g = new Graphics();
  g.rect(rect.x, rect.y, rect.w, rect.h);
  g.fill({ color, alpha: 0.85 });
  g.stroke({ color: isSelected ? SELECTED_COLOR : 0x000000, width: isSelected ? 2 : 1, alpha: 0.6 });
  g.eventMode = 'static';
  (g as unknown as { cursor: string }).cursor = 'pointer';
  g.on('pointertap', () => options.onSelectMap(map.id));
  g.on('pointerdblclick', () => options.onOpenMap(map.id));
  world.addChild(g);

  // Label - semantic map name. Truncate to fit the box width.
  const label = prettifyMapName(map.name, map.id);
  try {
    const text = new Text({
      text: label,
      style: {
        fontFamily: 'system-ui, sans-serif',
        fontSize: 11,
        fontWeight: '500',
        fill: 0xffffff,
        align: 'center',
        wordWrap: true,
        wordWrapWidth: Math.max(40, rect.w - 6),
      },
    });
    text.x = rect.x + rect.w / 2 - text.width / 2;
    text.y = rect.y + rect.h / 2 - text.height / 2;
    world.addChild(text);
  } catch {
    // Text rendering failures (headless jsdom) - color block is enough
    // to communicate the map exists.
  }
}

function drawStructureNode(
  world: import('pixi.js').Container,
  pixi: typeof import('pixi.js'),
  structure: Structure,
  members: ReadonlyArray<ProjectMapNode>,
  rect: { x: number; y: number; w: number; h: number },
  options: RegionAtlasOptions,
): void {
  const { Graphics, Text } = pixi;
  const firstMap = members[0];
  const groupColor = firstMap ? GROUP_COLORS[firstMap.group] ?? '#7c8088' : '#7c8088';
  const color = parseHex(groupColor);
  const isSelected = options.selectedMapId === structure.id;

  const g = new Graphics();
  g.rect(rect.x, rect.y, rect.w, rect.h);
  g.fill({ color, alpha: 0.85 });
  // Yellow border to distinguish structures from individual maps.
  g.stroke({
    color: isSelected ? SELECTED_COLOR : STRUCTURE_BORDER_COLOR,
    width: 2,
    alpha: 0.9,
  });
  g.eventMode = 'static';
  (g as unknown as { cursor: string }).cursor = 'pointer';
  g.on('pointertap', () => {
    // Selecting a structure opens its first map for now; future:
    // overlay floor stack on double-click.
    if (firstMap) options.onSelectMap(firstMap.id);
  });
  g.on('pointerdblclick', () => {
    if (firstMap) options.onOpenMap(firstMap.id);
  });
  world.addChild(g);

  // Label: structure name + floor count badge.
  try {
    const label = `${structure.name}\n(${members.length} floors)`;
    const text = new Text({
      text: label,
      style: {
        fontFamily: 'system-ui, sans-serif',
        fontSize: 12,
        fontWeight: '600',
        fill: 0xffffff,
        align: 'center',
        wordWrap: true,
        wordWrapWidth: Math.max(40, rect.w - 6),
      },
    });
    text.x = rect.x + rect.w / 2 - text.width / 2;
    text.y = rect.y + rect.h / 2 - text.height / 2;
    world.addChild(text);
  } catch {
    // Text rendering may fail in test env; structure rect alone is fine.
  }
}

function parseHex(s: string): number {
  return Number.parseInt(s.startsWith('#') ? s.slice(1) : s, 16);
}

function stringifyError(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

/** Draw a single story-arc marker as a small badge in the top-right
 *  corner of the given pin rect. Gym = numbered orange circle, rival =
 *  yellow star, champion = gold crown, key item = green diamond. */
function drawStoryMarker(
  world: import('pixi.js').Container,
  pixi: typeof import('pixi.js'),
  marker: StoryArcMarker,
  rect: { x: number; y: number; w: number; h: number },
): void {
  const { Graphics, Text } = pixi;
  const radius = 9;
  const cx = rect.x + rect.w - radius - 2;
  const cy = rect.y + radius + 2;
  const fill =
    marker.kind === 'gym'
      ? 0xff8c00
      : marker.kind === 'rival'
        ? 0xffd54a
        : marker.kind === 'champion'
          ? 0xf5d76e
          : 0x4caf50;
  const g = new Graphics();
  g.circle(cx, cy, radius);
  g.fill({ color: fill, alpha: 0.95 });
  g.stroke({ color: 0x000000, width: 1, alpha: 0.6 });
  world.addChild(g);
  try {
    const text = new Text({
      text: markerGlyph(marker),
      style: {
        fontFamily: 'system-ui, sans-serif',
        fontSize: marker.kind === 'gym' ? 11 : 12,
        fontWeight: '700',
        fill: 0x1a1d24,
        align: 'center',
      },
    });
    text.x = cx - text.width / 2;
    text.y = cy - text.height / 2;
    // Pixi 8 doesn't have title prop on Text; tooltip handled via React layer.
    (text as unknown as { _markerDescription: string })._markerDescription =
      describeMarker(marker);
    world.addChild(text);
  } catch {
    // Headless / jsdom - circle alone is enough.
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
