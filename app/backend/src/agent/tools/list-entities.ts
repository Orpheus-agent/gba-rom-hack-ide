import { z } from 'zod';
import type { ProjectManifest } from '@rom-editor/shared';
import { readManifest } from '../../scan/manifest-io.js';
import type {
  EntityKind,
  ListEntitiesItem,
  ListEntitiesResult,
  ListEntitiesUnavailable,
  ToolContext,
} from '../types.js';

export const LIST_ENTITIES_TOOL_NAME = 'list_entities';

export const LIST_ENTITIES_DESCRIPTION =
  'Paginated list of entities of a given kind (maps / warps / triggers / objectEvents / ' +
  'dialogue / flags / variables / encounterTables / trainers / scriptSteps / assets). ' +
  'Optional case-insensitive `filter` substring matches against id and name. Default ' +
  'limit 50, max 500. Use this to discover ids before calling read_map or read_decoded_script.';

const KINDS = [
  'map',
  'warp',
  'trigger',
  'objectEvent',
  'dialogue',
  'flag',
  'variable',
  'encounterTable',
  'trainer',
  'scriptStep',
  'asset',
] as const;

export const listEntitiesInputShape = {
  kind: z.enum(KINDS),
  filter: z.string().optional(),
  limit: z.number().int().positive().max(500).optional(),
  offset: z.number().int().nonnegative().optional(),
} as const;

export async function listEntities(
  ctx: ToolContext,
  args: { kind: EntityKind; filter?: string; limit?: number; offset?: number },
): Promise<ListEntitiesResult | ListEntitiesUnavailable> {
  const manifest = await readManifest(ctx.projectRoot);
  if (!manifest) {
    return {
      available: false,
      kind: args.kind,
      reason: 'manifest_not_found',
      message: `No manifest at ${ctx.projectRoot}/.editor/manifest.json.`,
    };
  }

  const limit = args.limit ?? 50;
  const offset = args.offset ?? 0;
  const filter = (args.filter ?? '').toLowerCase();

  const all = collect(manifest, args.kind);
  const filtered = filter
    ? all.filter((it) => it.id.toLowerCase().includes(filter) || it.name.toLowerCase().includes(filter))
    : all;
  const page = filtered.slice(offset, offset + limit);

  return {
    available: true,
    kind: args.kind,
    total: filtered.length,
    offset,
    limit,
    hasMore: offset + page.length < filtered.length,
    items: page,
  };
}

function collect(m: ProjectManifest, kind: EntityKind): ListEntitiesItem[] {
  switch (kind) {
    case 'map':
      return m.maps.map((it) => ({
        id: it.id,
        name: it.name,
        extras: { group: it.group, width: it.dimensions.width, height: it.dimensions.height },
      }));
    case 'warp':
      return m.warps.map((it) => ({
        id: it.id,
        name: it.name,
        extras: { fromMapId: it.fromMapId, toMapId: it.toMapId },
      }));
    case 'trigger':
      return m.triggers.map((it) => ({
        id: it.id,
        name: it.name,
        extras: { kind: it.kind, mapId: it.mapId },
      }));
    case 'objectEvent':
      return m.objectEvents.map((it) => ({
        id: it.id,
        name: it.name,
        extras: { kind: it.kind, mapId: it.mapId, graphicsId: it.graphicsId },
      }));
    case 'dialogue':
      return m.dialogue.map((it) => ({
        id: it.id,
        name: it.name,
        extras: { speakerName: it.speakerName, choiceCount: it.choices.length },
      }));
    case 'flag':
      return m.flags.map((it) => ({
        id: it.id,
        name: it.name,
        extras: { scope: it.scope, engineValue: it.engineValue, defaultValue: it.defaultValue },
      }));
    case 'variable':
      return m.variables.map((it) => ({
        id: it.id,
        name: it.name,
        extras: { scope: it.scope, engineValue: it.engineValue, defaultValue: it.defaultValue },
      }));
    case 'encounterTable':
      return m.encounterTables.map((it) => ({
        id: it.id,
        name: it.name,
        extras: { type: it.type, mapId: it.mapId, slotCount: it.slots.length },
      }));
    case 'trainer':
      return m.trainers.map((it) => ({
        id: it.id,
        name: it.name,
        extras: { className: it.className, mapId: it.mapId, partySize: it.party.length },
      }));
    case 'scriptStep':
      return m.scriptSteps.map((it) => ({
        id: it.id,
        name: it.id,
        extras: { kind: it.kind },
      }));
    case 'asset':
      return m.assets.map((it) => ({
        id: it.id,
        name: it.name,
        extras: { kind: it.kind, relativePath: it.relativePath },
      }));
  }
}
