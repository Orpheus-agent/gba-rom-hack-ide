/**
 * propose_complete_region - Phase 8H-2.
 *
 * Scoped resolver. The caller supplies a rect's tag layout (and
 * optionally the metatiles outside the rect) and the sidecar's
 * adjacency-aware filler picks metatile IDs that match.
 *
 * Output is a `propose_paint_map_blocks` plan, NOT an applied
 * patch. The user reviews the plan + applies it via the existing
 * paint tool to keep the audit trail consistent.
 */

import { z } from 'zod';

import {
  getDefaultTileIntelSupervisor,
  type TileIntelSupervisor,
} from '../../tile-intel/supervisor.js';
import { TileIntelClient } from '../../tile-intel/client.js';
import type {
  CompleteRegionRequest,
  CompleteRegionResponse,
  TileIntelUnavailable,
} from '../../tile-intel/types.js';
import type { ToolContext } from '../types.js';

export const PROPOSE_COMPLETE_REGION_TOOL_NAME = 'propose_complete_region';

export const PROPOSE_COMPLETE_REGION_DESCRIPTION =
  'Auto-fill a rectangular region of a map with metatiles consistent\n' +
  'with the surrounding tiles. The caller paints a "tag layout" - \n' +
  'which terrain each cell should carry - and the tile-intel sidecar\n' +
  'picks specific metatile IDs that satisfy the tags and the\n' +
  'adjacency rules learned from observed maps.\n\n' +
  'Inputs:\n' +
  '  - `width` / `height`: the rect size in tiles.\n' +
  '  - `tagGrid`: a `height × width` grid of tag lists; each cell\n' +
  '    declares the terrain(s) it wants (e.g. `["terrain.grass.tall"]`).\n' +
  '  - `seedCells`: optional dict mapping `"x,y" -> { tilesetSlug,\n' +
  '    metatileIndex }` for cells already known (the existing map\n' +
  '    surrounding the rect). These cells are treated as fixed.\n' +
  '  - `primaryTilesetSlug` / `secondaryTilesetSlug`: tileset\n' +
  '    preference (matches the surrounding map\'s tilesets).\n' +
  '  - `seed`: optional integer for deterministic output.\n\n' +
  'Returns a flat list of `(x, y, tilesetSlug, metatileIndex)` cells\n' +
  '(in the rect\'s local coordinates) ready to feed into a paint\n' +
  'proposal, plus the resolver\'s diagnostic counters.';

export const proposeCompleteRegionInputShape = {
  width: z.number().int().min(1).max(64),
  height: z.number().int().min(1).max(64),
  tagGrid: z
    .array(
      z.array(z.array(z.string().min(1).max(80)).max(16)).min(1).max(64),
    )
    .min(1)
    .max(64),
  seedCells: z
    .record(
      z.string(),
      z.object({
        tilesetSlug: z.string().min(1).max(200),
        metatileIndex: z.number().int().min(0).max(0x3ff),
      }),
    )
    .optional(),
  primaryTilesetSlug: z.string().min(1).max(200),
  secondaryTilesetSlug: z.string().min(1).max(200),
  seed: z.number().int().min(0).max(2_147_483_647).optional(),
} as const;

export type ProposeCompleteRegionArgs = {
  width: number;
  height: number;
  tagGrid: string[][][];
  seedCells?: Record<string, { tilesetSlug: string; metatileIndex: number }>;
  primaryTilesetSlug: string;
  secondaryTilesetSlug: string;
  seed?: number;
};

export interface ProposeCompleteRegionSuccess {
  readonly ok: true;
  readonly summary: string;
  readonly width: number;
  readonly height: number;
  readonly cells: CompleteRegionResponse['cells'];
  readonly unassignedCells: number;
  readonly ruleViolations: number;
  readonly rulesConsulted: number;
}

export interface ProposeCompleteRegionFailure {
  readonly ok: false;
  readonly message: string;
  readonly reason:
    | 'invalid_input'
    | 'sidecar_offline'
    | 'sidecar_error';
  readonly unavailable?: TileIntelUnavailable;
}

export type ProposeCompleteRegionResult =
  | ProposeCompleteRegionSuccess
  | ProposeCompleteRegionFailure;

type SupervisorFactory = () => TileIntelSupervisor;

export interface ProposeCompleteRegionDeps {
  readonly supervisorFactory?: SupervisorFactory;
  readonly clientForTests?: TileIntelClient;
}

function buildSummary(
  args: ProposeCompleteRegionArgs,
  response: CompleteRegionResponse,
): string {
  const total = args.width * args.height;
  const filled = response.cells.length;
  const lines: string[] = [];
  lines.push(
    `Region completed: ${filled} of ${total} cells filled ` +
      `(${response.unassigned_cells} left unassigned).`,
  );
  if (response.rules_consulted > 0) {
    const respect =
      100 -
      Math.round((response.rule_violations / response.rules_consulted) * 100);
    lines.push(
      `Adjacency rule respect: ${respect}% (consulted ${response.rules_consulted}).`,
    );
  }
  if (response.unassigned_cells > 0) {
    lines.push(
      `Notes: some cells didn\'t match a tagged metatile. Try a wider ` +
        `tileset binding, ingest more tilesets, or refine the tag layout.`,
    );
  } else {
    lines.push(`Pipe the cells into propose_paint_map_blocks to apply.`);
  }
  return lines.join('\n');
}

export async function proposeCompleteRegion(
  ctx: ToolContext,
  args: ProposeCompleteRegionArgs,
  deps: ProposeCompleteRegionDeps = {},
): Promise<ProposeCompleteRegionResult> {
  void ctx;

  // Validate tagGrid shape mirrors width/height.
  if (args.tagGrid.length !== args.height) {
    return {
      ok: false,
      reason: 'invalid_input',
      message: `tagGrid has ${args.tagGrid.length} rows but height is ${args.height}`,
    };
  }
  for (let i = 0; i < args.tagGrid.length; i++) {
    const row = args.tagGrid[i]!;
    if (row.length !== args.width) {
      return {
        ok: false,
        reason: 'invalid_input',
        message: `tagGrid row ${i} has ${row.length} cells but width is ${args.width}`,
      };
    }
  }

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
          'The tile-intelligence sidecar is offline. Region completion needs ' +
          'it running.',
      };
    }
    client = new TileIntelClient(status.baseUrl);
  }

  const request: CompleteRegionRequest = {
    width: args.width,
    height: args.height,
    tag_grid: args.tagGrid,
    seed_cells: args.seedCells
      ? Object.fromEntries(
          Object.entries(args.seedCells).map(([key, val]) => [
            key,
            { tileset_slug: val.tilesetSlug, metatile_index: val.metatileIndex },
          ]),
        )
      : undefined,
    primary_tileset_slug: args.primaryTilesetSlug,
    secondary_tileset_slug: args.secondaryTilesetSlug,
    seed: args.seed,
  };

  try {
    const response = await client.completeRegion(request);
    return {
      ok: true,
      summary: buildSummary(args, response),
      width: response.width,
      height: response.height,
      cells: response.cells,
      unassignedCells: response.unassigned_cells,
      ruleViolations: response.rule_violations,
      rulesConsulted: response.rules_consulted,
    };
  } catch (e) {
    return {
      ok: false,
      reason: 'sidecar_error',
      message:
        'The tile-intelligence sidecar returned an error: ' +
        (e instanceof Error ? e.message : String(e)),
    };
  }
}
