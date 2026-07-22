/**
 * propose_suggest_tile_neighbors - Phase 8H-1.
 *
 * Read-only tile co-design aid: given a seed metatile + direction,
 * return the top-N legal neighbours ranked by adjacency-rule
 * probability + support count. The user (or a UI affordance like
 * "right-click → show legal neighbours") consumes the result to
 * pick a metatile that visually fits.
 *
 * The tool does NOT mutate the ROM; it's a query. Pair it with
 * propose_paint_map_blocks to actually paint a chosen suggestion.
 */

import { z } from 'zod';

import {
  getDefaultTileIntelSupervisor,
  type TileIntelSupervisor,
} from '../../tile-intel/supervisor.js';
import { TileIntelClient } from '../../tile-intel/client.js';
import type {
  SuggestNeighborsResponse,
  TileIntelUnavailable,
} from '../../tile-intel/types.js';
import type { ToolContext } from '../types.js';

export const PROPOSE_SUGGEST_TILE_NEIGHBORS_TOOL_NAME =
  'propose_suggest_tile_neighbors';

export const PROPOSE_SUGGEST_TILE_NEIGHBORS_DESCRIPTION =
  'Suggest the top-N metatiles that legally sit next to a seed\n' +
  'metatile in a given direction, ranked by observed-adjacency\n' +
  'frequency from the tile-intel library.\n\n' +
  'Inputs:\n' +
  '  - `tilesetSlug`: the seed metatile\'s tileset slug (e.g.\n' +
  '    `pret-frlg-route1`).\n' +
  '  - `metatileIndex`: 0..1023, the seed metatile\'s index in that\n' +
  '    tileset.\n' +
  '  - `direction`: one of `north`, `northeast`, `east`, `southeast`,\n' +
  '    `south`, `southwest`, `west`, `northwest` - which side of the\n' +
  '    seed the neighbour sits on.\n' +
  '  - `limit`: how many suggestions to return (default 12, max 100).\n\n' +
  'Returns each suggestion with its tileset slug, metatile index,\n' +
  'probability (how often it appeared next to this seed in observed\n' +
  'maps), and walkability flag.';

const DIRECTION_NAMES = [
  'north',
  'northeast',
  'east',
  'southeast',
  'south',
  'southwest',
  'west',
  'northwest',
] as const;

const DIRECTION_TO_CODE: Record<(typeof DIRECTION_NAMES)[number], number> = {
  north: 0,
  northeast: 1,
  east: 2,
  southeast: 3,
  south: 4,
  southwest: 5,
  west: 6,
  northwest: 7,
};

export const proposeSuggestTileNeighborsInputShape = {
  tilesetSlug: z.string().min(1).max(200),
  metatileIndex: z.number().int().min(0).max(0x3ff),
  direction: z.enum(DIRECTION_NAMES),
  limit: z.number().int().min(1).max(100).optional(),
} as const;

export type ProposeSuggestTileNeighborsArgs = {
  tilesetSlug: string;
  metatileIndex: number;
  direction: (typeof DIRECTION_NAMES)[number];
  limit?: number;
};

export interface ProposeSuggestTileNeighborsSuccess {
  readonly ok: true;
  readonly summary: string;
  readonly direction: (typeof DIRECTION_NAMES)[number];
  readonly totalObservations: number;
  readonly entropy: number;
  readonly suggestions: SuggestNeighborsResponse['suggestions'];
}

export interface ProposeSuggestTileNeighborsFailure {
  readonly ok: false;
  readonly message: string;
  readonly reason:
    | 'sidecar_offline'
    | 'sidecar_error'
    | 'seed_not_found';
  readonly unavailable?: TileIntelUnavailable;
}

export type ProposeSuggestTileNeighborsResult =
  | ProposeSuggestTileNeighborsSuccess
  | ProposeSuggestTileNeighborsFailure;

type SupervisorFactory = () => TileIntelSupervisor;

export interface ProposeSuggestTileNeighborsDeps {
  readonly supervisorFactory?: SupervisorFactory;
  readonly clientForTests?: TileIntelClient;
}

function buildSummary(
  args: ProposeSuggestTileNeighborsArgs,
  response: SuggestNeighborsResponse,
): string {
  if (response.suggestions.length === 0) {
    return (
      `No observed neighbours to the ${args.direction} of ` +
      `${args.tilesetSlug} / metatile ${args.metatileIndex}. ` +
      `Try a different direction, or pick a metatile that appears in ` +
      `more maps.`
    );
  }
  const lines: string[] = [];
  lines.push(
    `Top ${response.suggestions.length} neighbours to the ${args.direction} ` +
      `of ${args.tilesetSlug} / metatile ${args.metatileIndex} ` +
      `(${response.total_observations} total observations):`,
  );
  for (const s of response.suggestions.slice(0, 5)) {
    const pct = Math.round(s.probability * 100);
    const walk = s.is_walkable ? 'walkable' : 'blocked';
    lines.push(
      `  - ${s.tileset_slug} / ${s.metatile_index} - ${pct}% (${s.support_count} maps, ${walk})`,
    );
  }
  if (response.suggestions.length > 5) {
    lines.push(`  - ... and ${response.suggestions.length - 5} more.`);
  }
  return lines.join('\n');
}

export async function proposeSuggestTileNeighbors(
  ctx: ToolContext,
  args: ProposeSuggestTileNeighborsArgs,
  deps: ProposeSuggestTileNeighborsDeps = {},
): Promise<ProposeSuggestTileNeighborsResult> {
  void ctx; // currently unused - exists for future per-project scope work

  let client: TileIntelClient;
  if (deps.clientForTests) {
    client = deps.clientForTests;
  } else {
    const factory = deps.supervisorFactory ?? (() => getDefaultTileIntelSupervisor());
    const supervisor = factory();
    const status = await supervisor.ensureReady();
    if (!status.available) {
      return {
        ok: false,
        reason: 'sidecar_offline',
        unavailable: status,
        message:
          'The tile-intelligence sidecar is offline. Neighbour suggestions ' +
          'need it running.',
      };
    }
    client = new TileIntelClient(status.baseUrl);
  }

  try {
    const response = await client.suggestNeighbors({
      tileset_slug: args.tilesetSlug,
      metatile_index: args.metatileIndex,
      direction: DIRECTION_TO_CODE[args.direction],
      limit: args.limit,
    });
    return {
      ok: true,
      summary: buildSummary(args, response),
      direction: args.direction,
      totalObservations: response.total_observations,
      entropy: response.entropy,
      suggestions: response.suggestions,
    };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    // The sidecar returns 404 for unknown seeds - surface that as a
    // distinct reason so the agent can guide the user.
    if (message.includes('404')) {
      return {
        ok: false,
        reason: 'seed_not_found',
        message:
          `The tile-intelligence sidecar doesn't know about ` +
          `${args.tilesetSlug} / metatile ${args.metatileIndex}. ` +
          `Re-ingest the tileset, or pick a known one.`,
      };
    }
    return {
      ok: false,
      reason: 'sidecar_error',
      message:
        'The tile-intelligence sidecar returned an error: ' + message,
    };
  }
}
