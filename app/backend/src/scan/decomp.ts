import { promises as fsp } from 'node:fs';
import type { Dirent } from 'node:fs';
import path from 'node:path';
import type {
  EntityId,
  MapCoordinate,
  MapGroup,
  MapNode,
  ObjectEvent,
  ObjectEventKind,
  ProjectIdentity,
  ProjectManifest,
  Trigger,
  Warp,
} from '@rom-editor/shared';
import type { ProjectScanner, ScanResult } from './types.js';
import { parseFlagsAndVariables } from './flags-vars.js';
import { parseEncounters } from './encounters.js';
import { parseTrainers } from './trainers.js';
import { parseDialogue } from './dialogue.js';
import { parseAssets } from './assets.js';
import { parseScripts } from './scripts.js';
import { detectBuildProfile } from '../build/detect.js';

/** #2 Story-order navigation - read the ordered `MAPSEC_*` constants from
 *  `include/constants/region_map_sections.h`. The file declares them in a
 *  single `enum { … }` whose declaration order is the canonical in-game
 *  section index (Gen-3 orders this geographically / by story progression:
 *  Pallet → Viridian → Pewter → …, then Routes numerically). We collect the
 *  leading `MAPSEC_*` identifier of each enum line in first-seen order; the
 *  trailing `#define KANTO_MAPSEC_START …` aliases start with `#` and are
 *  skipped. Returns [] when the header is absent (older/custom layouts) - the
 *  Navigator then falls back to its category grouping. */
async function parseMapSectionOrder(projectRoot: string): Promise<string[]> {
  const headerPath = path.join(
    projectRoot,
    'include',
    'constants',
    'region_map_sections.h',
  );
  let text: string;
  try {
    text = await fsp.readFile(headerPath, 'utf8');
  } catch {
    return [];
  }
  const order: string[] = [];
  const seen = new Set<string>();
  // Match an enum entry: optional whitespace, a MAPSEC_ identifier, then a
  // boundary (comma, `=`, whitespace, or EOL). Anchored to line start so a
  // MAPSEC_ token used as an alias *value* (`= MAPSEC_FOO`) is not collected.
  const lineRe = /^\s*(MAPSEC_[A-Z0-9_]+)\s*(?:=|,|$)/;
  for (const rawLine of text.split(/\r?\n/)) {
    const m = lineRe.exec(rawLine);
    if (!m || !m[1]) continue;
    const name = m[1];
    if (seen.has(name)) continue;
    seen.add(name);
    order.push(name);
  }
  return order;
}

function mapTypeToGroup(mapType: unknown): MapGroup {
  if (typeof mapType !== 'string') return 'unknown';
  switch (mapType) {
    case 'MAP_TYPE_TOWN':
    case 'MAP_TYPE_CITY':
      return 'town';
    case 'MAP_TYPE_ROUTE':
      return 'route';
    case 'MAP_TYPE_INDOOR':
    case 'MAP_TYPE_SECRET_BASE':
      return 'interior';
    case 'MAP_TYPE_UNDERGROUND':
      return 'cave';
    case 'MAP_TYPE_UNDERWATER':
    case 'MAP_TYPE_OCEAN_ROUTE':
      return 'special';
    default:
      return 'unknown';
  }
}

function safeString(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function safeInt(v: unknown, fallback = 0): number {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v === 'string') {
    const n = Number.parseInt(v, 10);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

interface ParsedMapJson {
  readonly id: string | null;
  readonly name: string | null;
  readonly mapType: unknown;
  readonly music: string | null;
  readonly layout: string | null;
  readonly metadata: Readonly<Record<string, string | number | boolean>>;
  readonly objectEvents: ReadonlyArray<unknown>;
  readonly warpEvents: ReadonlyArray<unknown>;
  readonly coordEvents: ReadonlyArray<unknown>;
  readonly bgEvents: ReadonlyArray<unknown>;
}

function parseMapJson(raw: string): ParsedMapJson | { parseError: string } {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (e) {
    return { parseError: e instanceof Error ? e.message : String(e) };
  }
  if (typeof json !== 'object' || json === null) {
    return { parseError: 'map.json root is not an object' };
  }
  const obj = json as Record<string, unknown>;
  const metadata: Record<string, string | number | boolean> = {};
  for (const key of ['region_map_section', 'requires_flash', 'weather', 'battle_scene']) {
    const v = obj[key];
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
      metadata[key] = v;
    }
  }
  const arr = (v: unknown): ReadonlyArray<unknown> => (Array.isArray(v) ? v : []);
  return {
    id: safeString(obj.id),
    name: safeString(obj.name),
    mapType: obj.map_type,
    music: safeString(obj.music),
    layout: safeString(obj.layout),
    metadata,
    objectEvents: arr(obj.object_events),
    warpEvents: arr(obj.warp_events),
    coordEvents: arr(obj.coord_events),
    bgEvents: arr(obj.bg_events),
  };
}

interface RawMapEntry {
  readonly dirName: string;
  readonly mapId: EntityId;
  readonly mapName: string;
  readonly parsed: ParsedMapJson | null;
}

async function readMapJson(
  mapsDir: string,
  dirName: string,
  warnings: string[],
): Promise<ParsedMapJson | null> {
  const mapJsonPath = path.join(mapsDir, dirName, 'map.json');
  try {
    const content = await fsp.readFile(mapJsonPath, 'utf8');
    const result = parseMapJson(content);
    if ('parseError' in result) {
      warnings.push(`Could not parse data/maps/${dirName}/map.json: ${result.parseError}`);
      return null;
    }
    return result;
  } catch (e: unknown) {
    if (
      typeof e === 'object' &&
      e !== null &&
      'code' in e &&
      (e as { code: string }).code === 'ENOENT'
    ) {
      return null;
    }
    warnings.push(
      `Could not read data/maps/${dirName}/map.json: ${e instanceof Error ? e.message : String(e)}`,
    );
    return null;
  }
}

function objectEventKind(rawObj: Record<string, unknown>): ObjectEventKind {
  const trainerType = safeString(rawObj['trainer_type']);
  if (trainerType && trainerType !== 'TRAINER_TYPE_NONE') return 'trainer';
  const script = safeString(rawObj['script']);
  if (script && /Item|Berry|HiddenItem/i.test(script)) return 'item';
  return 'npc';
}

function buildObjectEvent(
  mapId: EntityId,
  index: number,
  raw: unknown,
): ObjectEvent | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const o = raw as Record<string, unknown>;
  const coord: MapCoordinate = { x: safeInt(o.x), y: safeInt(o.y) };
  const elevation = safeInt(o.elevation);
  const kind = objectEventKind(o);
  const scriptIdRaw = safeString(o.script);
  return {
    id: `${mapId}_obj_${index}`,
    name: scriptIdRaw ?? `${mapId} object ${index}`,
    mapId,
    coord,
    elevation,
    kind,
    graphicsId: safeString(o.graphics_id),
    movementType: safeString(o.movement_type),
    scriptId: scriptIdRaw,
    flagId: safeString(o.flag),
    trainerType: safeString(o.trainer_type),
    metadata: extractObjectEventMetadata(o),
  };
}

function extractObjectEventMetadata(o: Record<string, unknown>): Readonly<Record<string, string | number | boolean>> {
  const md: Record<string, string | number | boolean> = {};
  for (const key of [
    'movement_range_x',
    'movement_range_y',
    'trainer_sight_or_berry_tree_id',
  ]) {
    const v = o[key];
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
      md[key] = v;
    }
  }
  return md;
}

function buildCoordTrigger(mapId: EntityId, index: number, raw: unknown): Trigger | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const o = raw as Record<string, unknown>;
  const coord: MapCoordinate = { x: safeInt(o.x), y: safeInt(o.y) };
  const varName = safeString(o['var']);
  const varValue = safeString(o['var_value']);
  const conditionExpression =
    varName !== null && varValue !== null ? `${varName} == ${varValue}` : null;
  const script = safeString(o.script);
  return {
    id: `${mapId}_coord_${index}`,
    name: script ?? `${mapId} coord-event ${index}`,
    kind: 'on_enter',
    mapId,
    coord,
    conditionExpression,
    scriptStepIds: [],
  };
}

function buildBgTrigger(mapId: EntityId, index: number, raw: unknown): Trigger | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const o = raw as Record<string, unknown>;
  const coord: MapCoordinate = { x: safeInt(o.x), y: safeInt(o.y) };
  const script = safeString(o.script);
  const facing = safeString(o['player_facing_dir']);
  return {
    id: `${mapId}_bg_${index}`,
    name: script ?? `${mapId} bg-event ${index}`,
    kind: 'on_interact',
    mapId,
    coord,
    conditionExpression: facing && facing !== 'BG_EVENT_PLAYER_FACING_ANY' ? `facing == ${facing}` : null,
    scriptStepIds: [],
  };
}

interface RawWarp {
  readonly fromMapId: EntityId;
  readonly fromIndex: number;
  readonly fromCoord: MapCoordinate;
  readonly destMapId: EntityId | null;
  readonly destWarpIndex: number;
}

function collectRawWarps(mapId: EntityId, warpEvents: ReadonlyArray<unknown>): RawWarp[] {
  const out: RawWarp[] = [];
  warpEvents.forEach((raw, index) => {
    if (typeof raw !== 'object' || raw === null) return;
    const o = raw as Record<string, unknown>;
    out.push({
      fromMapId: mapId,
      fromIndex: index,
      fromCoord: { x: safeInt(o.x), y: safeInt(o.y) },
      destMapId: safeString(o['dest_map']),
      destWarpIndex: safeInt(o['dest_warp_id'], -1),
    });
  });
  return out;
}

function deriveMapId(parsed: ParsedMapJson | null, dirName: string): EntityId {
  return parsed?.id ?? `MAP_${dirName.toUpperCase()}`;
}

function deriveMapName(parsed: ParsedMapJson | null, dirName: string): string {
  return parsed?.name ?? dirName;
}

interface MapNodeRefs {
  readonly warpIds: ReadonlyArray<EntityId>;
  readonly objectEventIds: ReadonlyArray<EntityId>;
  readonly encounterTableIds: ReadonlyArray<EntityId>;
}

function buildMapNode(entry: RawMapEntry, refs: MapNodeRefs): MapNode {
  const parsed = entry.parsed;
  const group = mapTypeToGroup(parsed?.mapType);
  const metadata: Record<string, string | number | boolean> = {
    sourceDir: `data/maps/${entry.dirName}`,
    ...(parsed?.metadata ?? {}),
  };
  if (parsed?.layout) metadata['layout'] = parsed.layout;
  if (parsed) {
    metadata['object_event_count'] = parsed.objectEvents.length;
    metadata['warp_event_count'] = parsed.warpEvents.length;
    metadata['coord_event_count'] = parsed.coordEvents.length;
    metadata['bg_event_count'] = parsed.bgEvents.length;
  }
  return {
    id: entry.mapId,
    name: entry.mapName,
    group,
    dimensions: { width: 0, height: 0 },
    tilesetIds: [],
    warpIds: refs.warpIds,
    scriptIds: [],
    objectEventIds: refs.objectEventIds,
    encounterTableIds: refs.encounterTableIds,
    musicId: parsed?.music ?? null,
    metadata,
  };
}

export const decompScanner: ProjectScanner = {
  name: 'DecompScanner',

  supports(identity: ProjectIdentity): boolean {
    return identity.kind === 'decomp' || identity.kind === 'hybrid';
  },

  async scan(projectRoot: string, identity: ProjectIdentity): Promise<ScanResult> {
    const warnings: string[] = [];
    const mapsDir = path.join(projectRoot, 'data', 'maps');

    let dirents: Dirent[] = [];
    try {
      dirents = await fsp.readdir(mapsDir, { withFileTypes: true });
    } catch (e: unknown) {
      if (
        typeof e === 'object' &&
        e !== null &&
        'code' in e &&
        (e as { code: string }).code === 'ENOENT'
      ) {
        warnings.push(
          `No data/maps/ directory at ${mapsDir} - this decomp tree has no maps to index yet, or uses a non-standard layout.`,
        );
      } else {
        throw e;
      }
    }

    // Pass 1: read every map.json (or note its absence) and remember the raw fields.
    const rawEntries: RawMapEntry[] = [];
    for (const d of dirents) {
      if (!d.isDirectory()) continue;
      const parsed = await readMapJson(mapsDir, d.name, warnings);
      rawEntries.push({
        dirName: d.name,
        mapId: deriveMapId(parsed, d.name),
        mapName: deriveMapName(parsed, d.name),
        parsed,
      });
    }
    rawEntries.sort((a, b) => a.mapId.localeCompare(b.mapId));

    // Pass 2: gather raw warps per map and resolve toCoord against the destination
    // map's own warp_events[dest_warp_id] (pokeemerald's canonical resolution rule).
    const rawWarpsByMap = new Map<EntityId, RawWarp[]>();
    for (const e of rawEntries) {
      const rws = collectRawWarps(e.mapId, e.parsed?.warpEvents ?? []);
      rawWarpsByMap.set(e.mapId, rws);
    }
    const entriesByMapId = new Map<EntityId, RawMapEntry>();
    for (const e of rawEntries) entriesByMapId.set(e.mapId, e);

    const allWarps: Warp[] = [];
    const allTriggers: Trigger[] = [];
    const allObjectEvents: ObjectEvent[] = [];
    const warpIdsByMap = new Map<EntityId, EntityId[]>();
    const triggerIdsByMap = new Map<EntityId, EntityId[]>();
    const objectEventIdsByMap = new Map<EntityId, EntityId[]>();

    for (const entry of rawEntries) {
      const mapId = entry.mapId;
      const warpIdsHere: EntityId[] = [];
      const triggerIdsHere: EntityId[] = [];
      const objectEventIdsHere: EntityId[] = [];

      const rws = rawWarpsByMap.get(mapId) ?? [];
      for (const rw of rws) {
        const destEntry = rw.destMapId ? entriesByMapId.get(rw.destMapId) : null;
        let toCoord: MapCoordinate = { x: 0, y: 0 };
        let resolvedDestId: EntityId = rw.destMapId ?? 'MAP_UNKNOWN';
        if (destEntry && rw.destWarpIndex >= 0) {
          const destRaws = rawWarpsByMap.get(destEntry.mapId) ?? [];
          const destRaw = destRaws[rw.destWarpIndex];
          if (destRaw) {
            toCoord = destRaw.fromCoord;
          } else {
            warnings.push(
              `Warp ${mapId} → ${rw.destMapId}[#${rw.destWarpIndex}] could not resolve its destination warp index (destination has ${destRaws.length} warps).`,
            );
          }
        } else if (rw.destMapId && !destEntry) {
          warnings.push(
            `Warp ${mapId} → ${rw.destMapId} references an unknown map id (destination is not in this project tree).`,
          );
        }
        const warpId = `${mapId}_warp_${rw.fromIndex}`;
        allWarps.push({
          id: warpId,
          name: `${mapId} → ${resolvedDestId}`,
          fromMapId: mapId,
          fromCoord: rw.fromCoord,
          toMapId: resolvedDestId,
          toCoord,
        });
        warpIdsHere.push(warpId);
      }

      (entry.parsed?.coordEvents ?? []).forEach((raw, i) => {
        const t = buildCoordTrigger(mapId, i, raw);
        if (t) {
          allTriggers.push(t);
          triggerIdsHere.push(t.id);
        }
      });
      (entry.parsed?.bgEvents ?? []).forEach((raw, i) => {
        const t = buildBgTrigger(mapId, i, raw);
        if (t) {
          allTriggers.push(t);
          triggerIdsHere.push(t.id);
        }
      });
      (entry.parsed?.objectEvents ?? []).forEach((raw, i) => {
        const obj = buildObjectEvent(mapId, i, raw);
        if (obj) {
          allObjectEvents.push(obj);
          objectEventIdsHere.push(obj.id);
        }
      });

      warpIdsByMap.set(mapId, warpIdsHere);
      triggerIdsByMap.set(mapId, triggerIdsHere);
      objectEventIdsByMap.set(mapId, objectEventIdsHere);
    }

    allWarps.sort((a, b) => a.id.localeCompare(b.id));
    allTriggers.sort((a, b) => a.id.localeCompare(b.id));
    allObjectEvents.sort((a, b) => a.id.localeCompare(b.id));

    const flagsVars = await parseFlagsAndVariables(projectRoot);
    for (const w of flagsVars.warnings) warnings.push(w);

    const encounters = await parseEncounters(projectRoot);
    for (const w of encounters.warnings) warnings.push(w);

    const trainers = await parseTrainers(projectRoot);
    for (const w of trainers.warnings) warnings.push(w);

    const dialogue = await parseDialogue(
      projectRoot,
      rawEntries.map((e) => e.mapId),
    );
    for (const w of dialogue.warnings) warnings.push(w);

    const assets = await parseAssets(projectRoot);
    for (const w of assets.warnings) warnings.push(w);

    const scripts = await parseScripts(projectRoot);
    for (const w of scripts.warnings) warnings.push(w);

    const mapSectionOrder = await parseMapSectionOrder(projectRoot);

    const buildProfile = await detectBuildProfile(projectRoot, { identity });

    // Resolve trigger.scriptStepIds - for coord/bg-event triggers, `name` was
    // initially set to the script label from map.json. Look it up in the
    // label→stepIds index and produce updated triggers.
    const resolvedTriggers = allTriggers.map((t) => {
      const stepIds = scripts.labelToStepIds.get(t.name);
      if (!stepIds || stepIds.length === 0) return t;
      return { ...t, scriptStepIds: [...stepIds] };
    });

    const maps: MapNode[] = rawEntries.map((e) =>
      buildMapNode(e, {
        warpIds: warpIdsByMap.get(e.mapId) ?? [],
        objectEventIds: objectEventIdsByMap.get(e.mapId) ?? [],
        encounterTableIds: encounters.tablesByMap.get(e.mapId) ?? [],
      }),
    );
    // triggerIdsByMap kept for upcoming Trigger-wiring in MapNode; references
    // via top-level Trigger.mapId are already populated this iteration.
    void triggerIdsByMap;

    const manifest: ProjectManifest = {
      schemaVersion: 1,
      generatedAtUtc: new Date().toISOString(),
      projectRoot,
      identity,
      buildProfile,
      maps,
      warps: allWarps,
      triggers: resolvedTriggers,
      objectEvents: allObjectEvents,
      dialogue: [...dialogue.dialogue],
      flags: [...flagsVars.flags],
      variables: [...flagsVars.variables],
      encounterTables: [...encounters.tables],
      trainers: [...trainers.trainers],
      scriptSteps: [...scripts.steps],
      assets: [...assets.assets],
      ...(mapSectionOrder.length > 0 ? { mapSectionOrder } : {}),
    };

    return {
      manifest,
      scannerName: 'DecompScanner',
      warnings,
    };
  },
};
