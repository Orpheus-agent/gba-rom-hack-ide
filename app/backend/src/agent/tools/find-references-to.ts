import { z } from 'zod';
import type { ProjectManifest } from '@rom-editor/shared';
import { readManifest } from '../../scan/manifest-io.js';
import type {
  FindReferencesResult,
  ReferenceHit,
  ToolContext,
} from '../types.js';

export const FIND_REFERENCES_TO_TOOL_NAME = 'find_references_to';

export const FIND_REFERENCES_TO_DESCRIPTION =
  'Find every place in the manifest that references a given entity by id. ' +
  'Use this BEFORE proposing a rename, swap, or delete - it surfaces every ' +
  'NPC, dialogue line, map field, trigger, and script step that points at ' +
  'the target. Returns at most 500 hits; if truncated, narrow the search.';

const VALID_KINDS = [
  'map',
  'flag',
  'variable',
  'dialogue',
  'script',
  'asset',
  'trainer',
  'species',
  'encounterTable',
  'objectEvent',
  'warp',
  'trigger',
] as const;

export const findReferencesToInputShape = {
  kind: z.enum(VALID_KINDS),
  id: z.string().min(1),
  limit: z.number().int().positive().max(500).optional(),
} as const;

const MAX_DEFAULT = 200;

export async function findReferencesTo(
  ctx: ToolContext,
  args: { kind: (typeof VALID_KINDS)[number]; id: string; limit?: number },
): Promise<FindReferencesResult | { available: false; reason: 'manifest_not_found'; message: string }> {
  const manifest = await readManifest(ctx.projectRoot);
  if (!manifest) {
    return {
      available: false,
      reason: 'manifest_not_found',
      message: `No manifest at ${ctx.projectRoot}/.editor/manifest.json. Scan the project first.`,
    } as const;
  }

  const limit = args.limit ?? MAX_DEFAULT;
  const hits: ReferenceHit[] = [];
  const push = (hit: ReferenceHit): boolean => {
    if (hits.length >= limit) return false;
    hits.push(hit);
    return true;
  };

  const targetId = args.id;
  scan(manifest, args.kind, targetId, push);

  return {
    target: { kind: args.kind, id: targetId },
    references: hits,
    truncated: hits.length >= limit,
    summary: summarize(args.kind, targetId, hits),
  };
}

function summarize(kind: string, id: string, hits: ReadonlyArray<ReferenceHit>): string {
  if (hits.length === 0) return `No references to ${kind} \`${id}\` found in this workspace.`;
  const byKind = new Map<string, number>();
  for (const h of hits) byKind.set(h.referrerKind, (byKind.get(h.referrerKind) ?? 0) + 1);
  const parts = Array.from(byKind.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `${n} ${k}${n === 1 ? '' : 's'}`);
  return `Found ${hits.length} reference${hits.length === 1 ? '' : 's'} to ${kind} \`${id}\` (${parts.join(', ')}).`;
}

function scan(
  m: ProjectManifest,
  kind: string,
  id: string,
  push: (hit: ReferenceHit) => boolean,
): void {
  // Maps reference each other via connections.
  if (kind === 'map') {
    for (const map of m.maps) {
      for (const conn of map.connections ?? []) {
        if (conn.destMapId === id) {
          if (!push({
            referrerKind: 'map',
            referrerId: map.id,
            referrerName: map.name,
            field: `connections[direction=${conn.direction}].destMapId`,
            mapId: map.id,
          })) return;
        }
      }
    }
    for (const w of m.warps) {
      if (w.fromMapId === id) {
        if (!push({ referrerKind: 'warp', referrerId: w.id, referrerName: w.name, field: 'fromMapId', mapId: w.fromMapId })) return;
      }
      if (w.toMapId === id) {
        if (!push({ referrerKind: 'warp', referrerId: w.id, referrerName: w.name, field: 'toMapId', mapId: w.fromMapId })) return;
      }
    }
    for (const t of m.triggers) {
      if (t.mapId === id) {
        if (!push({ referrerKind: 'trigger', referrerId: t.id, referrerName: t.name, field: 'mapId', mapId: t.mapId })) return;
      }
    }
    for (const oe of m.objectEvents) {
      if (oe.mapId === id) {
        if (!push({ referrerKind: 'objectEvent', referrerId: oe.id, referrerName: oe.name, field: 'mapId', mapId: oe.mapId })) return;
      }
    }
    for (const e of m.encounterTables) {
      if (e.mapId === id) {
        if (!push({ referrerKind: 'encounterTable', referrerId: e.id, referrerName: e.name, field: 'mapId', mapId: e.mapId })) return;
      }
    }
    for (const tr of m.trainers) {
      if (tr.mapId === id) {
        if (!push({ referrerKind: 'trainer', referrerId: tr.id, referrerName: tr.name, field: 'mapId', mapId: tr.mapId })) return;
      }
    }
    return;
  }

  if (kind === 'flag') {
    for (const oe of m.objectEvents) {
      if (oe.flagId === id) {
        if (!push({ referrerKind: 'objectEvent', referrerId: oe.id, referrerName: oe.name, field: 'flagId', mapId: oe.mapId })) return;
      }
    }
    for (const d of m.dialogue) {
      for (const c of d.choices) {
        if (c.setsFlagIds.includes(id)) {
          if (!push({ referrerKind: 'dialogue', referrerId: d.id, referrerName: d.name, field: `choices[label=${JSON.stringify(c.label)}].setsFlagIds` })) return;
        }
      }
    }
    for (const s of m.scriptSteps) {
      if (s.kind === 'set_flag' || s.kind === 'clear_flag') {
        if (paramReferences(s.params, id)) {
          if (!push({ referrerKind: 'scriptStep', referrerId: s.id, referrerName: s.id, field: `${s.kind}.params` })) return;
        }
      }
    }
    return;
  }

  if (kind === 'variable') {
    for (const s of m.scriptSteps) {
      if (s.kind === 'set_variable' && paramReferences(s.params, id)) {
        if (!push({ referrerKind: 'scriptStep', referrerId: s.id, referrerName: s.id, field: 'set_variable.params' })) return;
      }
    }
    return;
  }

  if (kind === 'dialogue') {
    for (const d of m.dialogue) {
      for (const c of d.choices) {
        if (c.nextDialogueId === id) {
          if (!push({ referrerKind: 'dialogue', referrerId: d.id, referrerName: d.name, field: `choices[label=${JSON.stringify(c.label)}].nextDialogueId` })) return;
        }
      }
    }
    for (const s of m.scriptSteps) {
      if (s.kind === 'dialogue' && paramReferences(s.params, id)) {
        if (!push({ referrerKind: 'scriptStep', referrerId: s.id, referrerName: s.id, field: 'dialogue.params' })) return;
      }
    }
    return;
  }

  if (kind === 'script') {
    for (const oe of m.objectEvents) {
      if (oe.scriptId === id) {
        if (!push({ referrerKind: 'objectEvent', referrerId: oe.id, referrerName: oe.name, field: 'scriptId', mapId: oe.mapId })) return;
      }
    }
    for (const t of m.triggers) {
      if (t.scriptStepIds.includes(id)) {
        if (!push({ referrerKind: 'trigger', referrerId: t.id, referrerName: t.name, field: 'scriptStepIds', mapId: t.mapId })) return;
      }
    }
    for (const map of m.maps) {
      if (map.scriptIds.includes(id)) {
        if (!push({ referrerKind: 'map', referrerId: map.id, referrerName: map.name, field: 'scriptIds' })) return;
      }
    }
    return;
  }

  if (kind === 'asset') {
    for (const d of m.dialogue) {
      if (d.portraitAssetId === id) {
        if (!push({ referrerKind: 'dialogue', referrerId: d.id, referrerName: d.name, field: 'portraitAssetId' })) return;
      }
    }
    for (const map of m.maps) {
      if (map.tilesetIds.includes(id)) {
        if (!push({ referrerKind: 'map', referrerId: map.id, referrerName: map.name, field: 'tilesetIds' })) return;
      }
    }
    for (const oe of m.objectEvents) {
      if (oe.graphicsId === id) {
        if (!push({ referrerKind: 'objectEvent', referrerId: oe.id, referrerName: oe.name, field: 'graphicsId', mapId: oe.mapId })) return;
      }
    }
    return;
  }

  if (kind === 'trainer') {
    for (const s of m.scriptSteps) {
      if (s.kind === 'start_battle' && paramReferences(s.params, id)) {
        if (!push({ referrerKind: 'scriptStep', referrerId: s.id, referrerName: s.id, field: 'start_battle.params' })) return;
      }
    }
    return;
  }

  if (kind === 'species') {
    // Decomp-style speciesId strings (e.g. "SPECIES_WOOPER") reach into encounter slots + party members.
    for (const e of m.encounterTables) {
      for (let i = 0; i < e.slots.length; i++) {
        if (e.slots[i]!.speciesId === id) {
          if (!push({ referrerKind: 'encounterTable', referrerId: e.id, referrerName: e.name, field: `slots[${i}].speciesId`, mapId: e.mapId })) return;
        }
      }
    }
    for (const tr of m.trainers) {
      for (let i = 0; i < tr.party.length; i++) {
        if (tr.party[i]!.speciesId === id) {
          if (!push({ referrerKind: 'trainer', referrerId: tr.id, referrerName: tr.name, field: `party[${i}].speciesId`, mapId: tr.mapId })) return;
        }
      }
    }
    return;
  }

  if (kind === 'encounterTable') {
    for (const map of m.maps) {
      if (map.encounterTableIds.includes(id)) {
        if (!push({ referrerKind: 'map', referrerId: map.id, referrerName: map.name, field: 'encounterTableIds' })) return;
      }
    }
    return;
  }

  if (kind === 'objectEvent') {
    for (const map of m.maps) {
      if (map.objectEventIds.includes(id)) {
        if (!push({ referrerKind: 'map', referrerId: map.id, referrerName: map.name, field: 'objectEventIds' })) return;
      }
    }
    return;
  }

  if (kind === 'warp') {
    for (const map of m.maps) {
      if (map.warpIds.includes(id)) {
        if (!push({ referrerKind: 'map', referrerId: map.id, referrerName: map.name, field: 'warpIds' })) return;
      }
    }
    return;
  }

  // kind === 'trigger' - triggers are rarely referenced by id from elsewhere.
}

function paramReferences(params: Readonly<Record<string, unknown>>, id: string): boolean {
  for (const v of Object.values(params)) {
    if (typeof v === 'string' && v === id) return true;
    if (typeof v === 'number' && String(v) === id) return true;
  }
  return false;
}
