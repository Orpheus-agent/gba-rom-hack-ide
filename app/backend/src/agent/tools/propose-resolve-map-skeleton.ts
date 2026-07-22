/**
 * propose_resolve_map_skeleton - Phase 8G-2.
 *
 * The "bytes-first" half of the two-stage map-generation pipeline.
 * Walks a previously-authored MapSkeleton (`.editor/skeletons/<slug>.map.json`,
 * produced by `propose_generate_map_skeleton` in 8G-1, or hand-edited
 * by the user) and emits a structured PLAN of `propose_create_map` +
 * `propose_paint_map_blocks` sub-calls that, when applied together,
 * stand up a brand-new playable map.
 *
 * What the tool does NOT do (intentionally):
 *
 *   - **It does not apply anything by default.** The plan is a
 *     review surface. The user (or a follow-up `propose_batch_apply`
 *     call) decides what gets executed.
 *
 *   - **It does not bind tile-intel slugs to ROM tileset offsets.**
 *     The resolver returns slugs like `pret-frlg-route1` that
 *     reference the tile-intel library's view of vanilla pret. The
 *     user supplies `primaryTilesetOffset` + `secondaryTilesetOffset`
 *     (file offsets into their actual ROM) per call. A future Phase
 *     8I component will offer a slug-→-offset picker so the agent
 *     doesn't have to ask the user every time.
 *
 *   - **It does not relocate the project manifest.** Persistence to
 *     disk is best-effort to `.editor/resolved-maps/<slug>.resolved.json`
 *     so future tools (Phase 8H's validators, Phase 8I's previews)
 *     can read the resolver's output without re-running it.
 *
 * The resolver runs on the sidecar (`POST /v1/generate/resolve`),
 * which owns the templates / adjacency rules / tag-index it needs to
 * pick metatile IDs.  When the sidecar is offline this tool
 * surfaces `{ ok: false, reason: 'sidecar_offline' }` (it does NOT
 * fall back to a Node-side resolver).
 */

import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

import {
  getDefaultTileIntelSupervisor,
  type TileIntelSupervisor,
} from '../../tile-intel/supervisor.js';
import { TileIntelClient } from '../../tile-intel/client.js';
import type {
  ResolveSkeletonResponse,
  TileIntelUnavailable,
} from '../../tile-intel/types.js';
import type { ToolContext } from '../types.js';

export const PROPOSE_RESOLVE_MAP_SKELETON_TOOL_NAME =
  'propose_resolve_map_skeleton';

export const PROPOSE_RESOLVE_MAP_SKELETON_DESCRIPTION =
  'Resolve a previously-authored map outline (skeleton) into a\n' +
  'concrete plan of `propose_create_map` + `propose_paint_map_blocks`\n' +
  'sub-calls.  The output is a STRUCTURED PLAN by default - nothing\n' +
  'is written to the ROM unless you opt in.\n\n' +
  'Inputs:\n' +
  '  - `skeletonSlug`: name of the skeleton file under\n' +
  '    `.editor/skeletons/` (without the `.map.json` suffix). Most\n' +
  '    callers pass the `slug` returned by\n' +
  '    propose_generate_map_skeleton verbatim.\n' +
  '  - `mapGroup`: u8 - the existing map group the new map should\n' +
  '    belong to. The group must already contain at least one map\n' +
  '    (we do not grow the outer bank table here; the existing\n' +
  '    propose_create_map keeps that as a future enhancement).\n' +
  '  - `mapNum`: optional u8 - when omitted, propose_create_map\n' +
  '    picks the lowest unused slot in the group.\n' +
  '  - `primaryTilesetOffset` / `secondaryTilesetOffset`: file\n' +
  '    offsets of EXISTING tileset structs in the user\'s ROM. The\n' +
  '    resolver speaks in slugs (e.g. `pret-frlg-route1`); the user\n' +
  '    supplies the actual offset to bind to.\n' +
  '  - `mapType`: 1..9 - 3 (Route) is the most common.\n' +
  '  - `weather` / `musicId` / `regionMapSection`: optional u8 / u16\n' +
  '    per the propose_create_map docs.\n' +
  '  - `defaultBlockId`: u16 - the block id used for any cells the\n' +
  '    resolver couldn\'t fill (and as a temporary placeholder for\n' +
  '    cells whose tile-intel slug doesn\'t match the supplied tileset\n' +
  '    offsets). Default 0x001.\n' +
  '  - `seed`: optional integer passed to the resolver for\n' +
  '    deterministic output.\n\n' +
  'Returns a JSON document with: a `plan` array describing the\n' +
  'planned tool calls in order; a `report` block with diagnostics\n' +
  '(unassigned cells, rule respect rate, path solver results);\n' +
  'warnings; and a `resolvedPath` pointing at the persisted\n' +
  '`.editor/resolved-maps/<slug>.resolved.json`.';

const u16 = z.number().int().min(0).max(0xffff);
const u32 = z.number().int().min(0).max(0xffffffff);

export const proposeResolveMapSkeletonInputShape = {
  skeletonSlug: z.string().min(1).max(120),
  mapGroup: z.number().int().min(0).max(0xff),
  mapNum: z.number().int().min(0).max(0xff).optional(),
  primaryTilesetOffset: u32,
  secondaryTilesetOffset: u32,
  mapType: z.number().int().min(1).max(9).optional(),
  weather: z.number().int().min(0).max(0xff).optional(),
  musicId: u16.optional(),
  regionMapSection: z.number().int().min(0).max(0xff).optional(),
  defaultBlockId: u16.optional(),
  seed: z.number().int().min(0).max(2_147_483_647).optional(),
} as const;

export type ProposeResolveMapSkeletonArgs = {
  skeletonSlug: string;
  mapGroup: number;
  mapNum?: number;
  primaryTilesetOffset: number;
  secondaryTilesetOffset: number;
  mapType?: number;
  weather?: number;
  musicId?: number;
  regionMapSection?: number;
  defaultBlockId?: number;
  seed?: number;
};

/** One planned tool call in the result. Tools are described as
 *  `{ name, args }` so the user / the agent can review before
 *  applying - same shape as the propose_author_scene plans. */
export interface PlannedToolCall {
  readonly tool: 'propose_create_map' | 'propose_paint_map_blocks';
  readonly args: Record<string, unknown>;
  /** Human-friendly description for the chat preview. */
  readonly description: string;
}

export interface ProposeResolveMapSkeletonSuccess {
  readonly ok: true;
  readonly skeletonSlug: string;
  readonly plan: ReadonlyArray<PlannedToolCall>;
  readonly resolvedPath: string | null;
  readonly summary: string;
  readonly report: ResolveSkeletonResponse['report'];
  readonly width: number;
  readonly height: number;
  readonly unassignedCells: number;
  readonly primaryTilesetSlug: string;
  readonly secondaryTilesetSlug: string;
}

export interface ProposeResolveMapSkeletonFailure {
  readonly ok: false;
  readonly message: string;
  readonly reason:
    | 'invalid_input'
    | 'skeleton_not_found'
    | 'sidecar_offline'
    | 'sidecar_error'
    | 'persist_failed';
  readonly unavailable?: TileIntelUnavailable;
}

export type ProposeResolveMapSkeletonResult =
  | ProposeResolveMapSkeletonSuccess
  | ProposeResolveMapSkeletonFailure;

type SupervisorFactory = () => TileIntelSupervisor;

export interface ProposeResolveMapSkeletonDeps {
  readonly supervisorFactory?: SupervisorFactory;
  readonly clientForTests?: TileIntelClient;
}

/** Sanitize a skeleton slug to a relative path under the
 *  `.editor/skeletons/` directory - defence against the agent
 *  accidentally pointing at unrelated files. */
function safeSlug(slug: string): string {
  return slug.replace(/[^a-zA-Z0-9._-]/g, '');
}

/** Render the resolver's grid into a flat row-major u16 array
 *  suitable for `propose_paint_map_blocks` explicit mode. Cells the
 *  resolver couldn't fill fall back to `defaultBlockId`. */
function gridToFlatBlockIds(
  grid: ResolveSkeletonResponse['grid'],
  primaryTilesetSlug: string,
  primaryOffset: number,
  secondaryTilesetSlug: string,
  secondaryOffset: number,
  defaultBlockId: number,
): { blockIds: number[]; unbound: number } {
  // For v1 we don't have a slug→ROM-offset binding table - the user
  // supplies one (primaryTilesetOffset/secondaryTilesetOffset)
  // per-call. We re-use the metatile_index as the metatile ID in the
  // target ROM IF the cell's tileset_slug matches one of those two.
  // Otherwise we fall back to defaultBlockId and increment `unbound`.
  // This is intentionally conservative - a future Phase 8H tool
  // (`propose_browse_tileset_library`) will expose a slug-↔-offset
  // map so the resolver can target multiple tilesets.
  const blockIds: number[] = [];
  let unbound = 0;
  for (const row of grid) {
    for (const cell of row) {
      if (cell === null) {
        blockIds.push(defaultBlockId);
        continue;
      }
      if (cell.tileset_slug === primaryTilesetSlug || cell.tileset_slug === secondaryTilesetSlug) {
        // u16 metatile id, no extra collision/elevation bits.
        const idx = cell.metatile_index & 0x3ff;
        blockIds.push(idx);
      } else {
        unbound += 1;
        blockIds.push(defaultBlockId);
      }
    }
  }
  return { blockIds, unbound };
}

/** Compose the plain-English summary the agent surfaces in chat. */
function buildSummary(
  args: ProposeResolveMapSkeletonArgs,
  resolved: ResolveSkeletonResponse,
  unbound: number,
  resolvedPath: string | null,
): string {
  const lines: string[] = [];
  lines.push(
    `Map plan ready - ${resolved.width} × ${resolved.height} tiles, ` +
      `target group ${args.mapGroup}${args.mapNum !== undefined ? `, slot ${args.mapNum}` : ''}.`,
  );
  lines.push(
    `Cells filled: ${resolved.report.assigned_cells} / ${
      resolved.width * resolved.height
    }. Unassigned: ${resolved.report.unassigned_cells}.`,
  );
  if (unbound > 0) {
    lines.push(
      `Note: ${unbound} cell${unbound === 1 ? '' : 's'} referenced a tileset ` +
        `outside the two you bound (primary + secondary). Those cells fell ` +
        `back to the default block id. Re-running with a wider tileset ` +
        `binding (or a different skeleton tileset choice) is recommended.`,
    );
  }
  lines.push(
    `Templates placed: ${resolved.report.template_anchors_placed}. ` +
      `Paths solved: ${resolved.report.paths_solved} ` +
      `(${resolved.report.paths_failed} failed).`,
  );
  if (resolved.report.rules_consulted > 0) {
    const respect =
      100 -
      Math.round(
        (resolved.report.rule_violations /
          Math.max(1, resolved.report.rules_consulted)) *
          100,
      );
    lines.push(
      `Adjacency rule respect: ${respect}% (consulted ${resolved.report.rules_consulted}).`,
    );
  }
  if (resolved.report.warnings.length > 0) {
    lines.push('Resolver notes:');
    for (const w of resolved.report.warnings) lines.push(`  - ${w}`);
  }
  if (resolvedPath) lines.push(`Resolved grid persisted to ${resolvedPath}.`);
  lines.push('');
  lines.push(
    'Next step: review the plan above. Apply via `propose_batch_apply` ' +
      'with the listed plan entries (in order) to actually create the map ' +
      'and paint its blocks.',
  );
  return lines.join('\n');
}

export async function proposeResolveMapSkeleton(
  ctx: ToolContext,
  args: ProposeResolveMapSkeletonArgs,
  deps: ProposeResolveMapSkeletonDeps = {},
): Promise<ProposeResolveMapSkeletonResult> {
  const slug = safeSlug(args.skeletonSlug);
  if (!slug) {
    return {
      ok: false,
      reason: 'invalid_input',
      message:
        'The skeleton slug must be alphanumeric / underscore / hyphen / dot only.',
    };
  }

  // Load the skeleton.
  const skeletonPath = path.join(
    ctx.projectRoot,
    '.editor',
    'skeletons',
    `${slug}.map.json`,
  );
  let skeletonJson: Record<string, unknown>;
  try {
    const raw = await fsp.readFile(skeletonPath, 'utf8');
    skeletonJson = JSON.parse(raw) as Record<string, unknown>;
  } catch (e) {
    return {
      ok: false,
      reason: 'skeleton_not_found',
      message:
        `Couldn't read the skeleton file at ${skeletonPath}: ` +
        (e instanceof Error ? e.message : String(e)) +
        '. Run propose_generate_map_skeleton first, or check the slug.',
    };
  }

  // Open the sidecar.
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
          'The tile-intelligence sidecar is offline. Map resolving needs ' +
          'it running. Start the editor (npm run start) and retry.',
      };
    }
    client = new TileIntelClient(status.baseUrl);
  }

  // Resolve.
  let resolved: ResolveSkeletonResponse;
  try {
    resolved = await client.resolveSkeleton({
      skeleton: skeletonJson,
      seed: args.seed,
    });
  } catch (e) {
    return {
      ok: false,
      reason: 'sidecar_error',
      message:
        'The tile-intelligence sidecar returned an error while resolving ' +
        'your skeleton: ' +
        (e instanceof Error ? e.message : String(e)),
    };
  }

  // Persist resolved grid for downstream tools.
  let resolvedPath: string | null = null;
  try {
    const dir = path.join(ctx.projectRoot, '.editor', 'resolved-maps');
    await fsp.mkdir(dir, { recursive: true });
    resolvedPath = path.join(dir, `${slug}.resolved.json`);
    await fsp.writeFile(resolvedPath, JSON.stringify(resolved, null, 2), 'utf8');
  } catch {
    // Persistence is best-effort.
  }

  // Translate the grid into a sequence of planned tool calls.
  const defaultBlockId = args.defaultBlockId ?? 0x001;
  const { blockIds, unbound } = gridToFlatBlockIds(
    resolved.grid,
    resolved.primary_tileset_slug,
    args.primaryTilesetOffset,
    resolved.secondary_tileset_slug,
    args.secondaryTilesetOffset,
    defaultBlockId,
  );

  // Pick a friendly border block id - first non-null cell of the
  // 2x2 border, else fallback to defaultBlockId.
  const borderCandidates = resolved.border_blocks.flatMap((row) =>
    row.filter((cell) => cell !== null),
  );
  const borderBlockId =
    borderCandidates.length > 0
      ? (borderCandidates[0] as { metatile_index: number }).metatile_index & 0x3ff
      : defaultBlockId;

  const plan: PlannedToolCall[] = [
    {
      tool: 'propose_create_map',
      args: {
        width: resolved.width,
        height: resolved.height,
        mapGroup: args.mapGroup,
        ...(args.mapNum !== undefined ? { mapNum: args.mapNum } : {}),
        primaryTilesetOffset: args.primaryTilesetOffset,
        secondaryTilesetOffset: args.secondaryTilesetOffset,
        mapType: args.mapType ?? 3,
        weather: args.weather ?? 0,
        musicId: args.musicId ?? 0,
        regionMapSection: args.regionMapSection ?? 0x58,
        defaultBlockId,
        borderBlockIds: [borderBlockId, borderBlockId, borderBlockId, borderBlockId],
      },
      description:
        `Create the empty ${resolved.width}×${resolved.height} map at ` +
        `group ${args.mapGroup}.`,
    },
    {
      tool: 'propose_paint_map_blocks',
      args: {
        // mapId will be filled in by the orchestrator once create_map
        // returns. Until then we record a placeholder the user can
        // resolve manually.
        mapId: '<created-by-step-1>',
        rect: { x: 0, y: 0, w: resolved.width, h: resolved.height },
        mode: 'explicit',
        blockIds,
        description: `Paint resolver-generated grid (${blockIds.length} cells).`,
      },
      description: `Paint the ${blockIds.length}-cell grid produced by the resolver.`,
    },
  ];

  const summary = buildSummary(args, resolved, unbound, resolvedPath);

  return {
    ok: true,
    skeletonSlug: slug,
    plan,
    resolvedPath,
    summary,
    report: resolved.report,
    width: resolved.width,
    height: resolved.height,
    unassignedCells: resolved.report.unassigned_cells,
    primaryTilesetSlug: resolved.primary_tileset_slug,
    secondaryTilesetSlug: resolved.secondary_tileset_slug,
  };
}
