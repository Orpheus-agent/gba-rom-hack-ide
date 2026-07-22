import { z } from 'zod';
import { readManifest } from '../../scan/manifest-io.js';
import type { ReadMapResult, ReadMapUnavailable, ToolContext } from '../types.js';

export const READ_MAP_TOOL_NAME = 'read_map';

export const READ_MAP_DESCRIPTION =
  'Read everything in/on a single map: the header (dimensions, tilesets, music), ' +
  'all warps leading in or out, triggers, NPC and trainer object events, encounter ' +
  'tables, and resolved map-to-map connections. Use this to answer questions like ' +
  '"what NPCs are in Pallet Town?" or "what warps lead out of this gym?" without ' +
  'paginating through list_entities.';

export const readMapInputShape = {
  mapId: z.string().min(1),
} as const;

export async function readMap(
  ctx: ToolContext,
  args: { mapId: string },
): Promise<ReadMapResult | ReadMapUnavailable> {
  const manifest = await readManifest(ctx.projectRoot);
  if (!manifest) {
    return {
      available: false,
      mapId: args.mapId,
      reason: 'manifest_not_found',
      message: `No manifest at ${ctx.projectRoot}/.editor/manifest.json.`,
    };
  }

  const map = manifest.maps.find((m) => m.id === args.mapId);
  if (!map) {
    return {
      available: false,
      mapId: args.mapId,
      reason: 'map_not_found',
      message: `No map with id '${args.mapId}'. Use list_entities({kind: 'maps'}) to discover valid ids.`,
    };
  }

  const warps = manifest.warps
    .filter((w) => w.fromMapId === args.mapId)
    .map((w) => ({
      id: w.id,
      name: w.name,
      fromCoord: w.fromCoord,
      toMapId: w.toMapId,
      toCoord: w.toCoord,
    }));

  const triggers = manifest.triggers
    .filter((t) => t.mapId === args.mapId)
    .map((t) => ({
      id: t.id,
      name: t.name,
      kind: t.kind,
      coord: t.coord,
      scriptStepCount: t.scriptStepIds.length,
    }));

  const objectEvents = manifest.objectEvents
    .filter((o) => o.mapId === args.mapId)
    .map((o) => ({
      id: o.id,
      name: o.name,
      kind: o.kind,
      coord: o.coord,
      graphicsId: o.graphicsId,
      scriptId: o.scriptId,
      flagId: o.flagId,
      trainerType: o.trainerType,
    }));

  const encounterTables = manifest.encounterTables
    .filter((e) => e.mapId === args.mapId)
    .map((e) => ({
      id: e.id,
      name: e.name,
      type: e.type,
      slotCount: e.slots.length,
    }));

  const trainersOnMap = manifest.trainers
    .filter((tr) => tr.mapId === args.mapId)
    .map((tr) => ({
      id: tr.id,
      name: tr.name,
      className: tr.className,
      partySize: tr.party.length,
    }));

  const connections = (map.connections ?? []).map((c) => ({
    direction: c.direction,
    offset: c.offset,
    destMapId: c.destMapId,
  }));

  return {
    available: true,
    map: {
      id: map.id,
      name: map.name,
      group: map.group,
      dimensions: map.dimensions,
      tilesetIds: map.tilesetIds,
      musicId: map.musicId,
      metadata: map.metadata,
    },
    warps,
    triggers,
    objectEvents,
    encounterTables,
    trainersOnMap,
    connections,
  };
}
