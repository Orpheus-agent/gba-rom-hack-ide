/**
 * propose_generate_map_skeleton - Phase 8G-1.
 *
 * The "outline-first" half of the two-stage map-generation pipeline.
 * The agent describes the scene at a high level ("a forest route,
 * medium density, with two trainer patrols"); this tool composes a
 * structured MapSkeleton document - regions, paths, POIs, template
 * anchors - that captures intent without committing to specific
 * metatile placements.
 *
 * Resolution (turning the skeleton into actual block IDs) is a
 * separate step the user reviews and can iterate on without
 * re-prompting the agent.  See `propose_resolve_map_skeleton`
 * (Phase 8G-2).
 *
 * Persistence
 * -----------
 *
 * Skeletons land at `<projectRoot>/.editor/skeletons/<slug>.map.json`.
 * Re-running this tool with the same `name` overwrites the existing
 * file (drafts are meant to be iterated). Removing a skeleton is a
 * filesystem operation, not a tool action.
 *
 * Sidecar contract
 * ----------------
 *
 * Calls the tile-intel sidecar's `POST /v1/generate/skeleton`. When
 * the sidecar is offline, this tool returns a structured
 * `{ ok: false, reason: 'sidecar_offline' }` (it does NOT fall
 * back to a Node-side generator - the sidecar OWNS the biome /
 * template knowledge).
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
  GenerateSkeletonRequest,
  GenerateSkeletonResponse,
  TileIntelUnavailable,
} from '../../tile-intel/types.js';
import type { ToolContext } from '../types.js';

export const PROPOSE_GENERATE_MAP_SKELETON_TOOL_NAME =
  'propose_generate_map_skeleton';

export const PROPOSE_GENERATE_MAP_SKELETON_DESCRIPTION =
  'Compose a high-level map outline ("skeleton") from theme + biome +\n' +
  'density. The result captures regions (grass patches, walls, water),\n' +
  'points of interest (entrance, exit, trainer patrols, encounter\n' +
  'zones), connecting paths, and template anchors - but does NOT\n' +
  'commit to specific tile placements. Use propose_resolve_map_skeleton\n' +
  'afterwards to turn this outline into a paintable map.\n\n' +
  'Inputs:\n' +
  '  - `theme`: one of `route | forest | cave | town | beach |\n' +
  '    mountain | dungeon | arctic | tropical | urban | indoor |\n' +
  '    plains`. Controls default size + region layout.\n' +
  '  - `biome`: tag-vocabulary biome (e.g. `biome.forest`,\n' +
  '    `biome.route`, `biome.cave`). Determines which templates\n' +
  '    the sidecar picks from its library.\n' +
  '  - `width` / `height`: optional; per-theme default if omitted.\n' +
  '    Pass both or neither.\n' +
  '  - `density`: `low | medium | high`. Sets POI + template counts.\n' +
  '  - `seed`: integer; same seed reproduces the same skeleton.\n' +
  '  - `name`: friendly map name (auto-derived from theme otherwise).\n' +
  '  - `primaryTileset` / `secondaryTileset`: override tileset auto-\n' +
  '    selection. Slug from the tile-intel library.\n\n' +
  'Skeleton persisted to `<projectRoot>/.editor/skeletons/<slug>.map.json`.\n' +
  'The user reviews + iterates the skeleton before resolving.';

const THEMES = [
  'route',
  'forest',
  'cave',
  'town',
  'beach',
  'mountain',
  'dungeon',
  'arctic',
  'tropical',
  'urban',
  'indoor',
  'plains',
] as const;

export const proposeGenerateMapSkeletonInputShape = {
  theme: z.enum(THEMES),
  biome: z.string().min(1).max(80),
  width: z.number().int().min(8).max(512).optional(),
  height: z.number().int().min(8).max(512).optional(),
  density: z.enum(['low', 'medium', 'high']).optional(),
  elevationLayers: z.number().int().min(1).max(4).optional(),
  seed: z
    .number()
    .int()
    .min(0)
    .max(2_147_483_647)
    .optional(),
  name: z.string().min(1).max(120).optional(),
  primaryTileset: z.string().min(1).max(200).optional(),
  secondaryTileset: z.string().min(1).max(200).optional(),
  skipTemplates: z.boolean().optional(),
} as const;

export type ProposeGenerateMapSkeletonArgs = {
  theme: (typeof THEMES)[number];
  biome: string;
  width?: number;
  height?: number;
  density?: 'low' | 'medium' | 'high';
  elevationLayers?: number;
  seed?: number;
  name?: string;
  primaryTileset?: string;
  secondaryTileset?: string;
  skipTemplates?: boolean;
};

export interface ProposeGenerateMapSkeletonSuccess {
  readonly ok: true;
  readonly persistedPath: string | null;
  readonly slug: string;
  readonly mapName: string;
  readonly summary: string;
  readonly skeleton: Record<string, unknown>;
  readonly report: GenerateSkeletonResponse['report'];
}

export interface ProposeGenerateMapSkeletonFailure {
  readonly ok: false;
  /** Friendly explanation rendered to the agent. */
  readonly message: string;
  readonly reason:
    | 'invalid_input'
    | 'sidecar_offline'
    | 'sidecar_error'
    | 'persist_failed';
  readonly unavailable?: TileIntelUnavailable;
}

export type ProposeGenerateMapSkeletonResult =
  | ProposeGenerateMapSkeletonSuccess
  | ProposeGenerateMapSkeletonFailure;

/** Slugify a map name for filesystem persistence. Plain-English in,
 *  filesystem-safe out. */
function nameToSlug(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return slug || 'unnamed-skeleton';
}

/** Compose the friendly summary the agent sees in chat. Plain
 *  English, no slugs / IDs / opcodes. */
function buildSummary(
  args: ProposeGenerateMapSkeletonArgs,
  response: GenerateSkeletonResponse,
): string {
  const r = response.report;
  const skel = response.skeleton as {
    map?: { name?: string; size?: { w?: number; h?: number } };
  };
  const w = skel.map?.size?.w ?? 0;
  const h = skel.map?.size?.h ?? 0;
  const name = skel.map?.name ?? args.name ?? 'Untitled';
  const themeLabel = args.theme.replace(/_/g, ' ');
  const lines: string[] = [];
  lines.push(`Map outline ready - “${name}” (${themeLabel}).`);
  lines.push(`Size: ${w} × ${h} tiles.`);
  lines.push(
    `Layout: ${r.region_count} region${r.region_count === 1 ? '' : 's'}, ` +
      `${r.poi_count} point${r.poi_count === 1 ? '' : 's'} of interest, ` +
      `${r.path_count} path${r.path_count === 1 ? '' : 's'}.`,
  );
  if (r.template_anchor_count > 0) {
    lines.push(
      `Template anchors placed: ${r.template_anchor_count}.`,
    );
  }
  lines.push(
    `Primary tileset: ${r.chosen_primary_tileset}. ` +
      `Secondary: ${r.chosen_secondary_tileset}.`,
  );
  if (r.warnings.length > 0) {
    lines.push(`Notes:`);
    for (const w of r.warnings) lines.push(`  - ${w}`);
  }
  lines.push('');
  lines.push(
    'Next step: review the skeleton, then call `propose_resolve_map_skeleton` ' +
      'to turn it into a paintable map. The skeleton file is editable on ' +
      'disk if you want to tweak shapes by hand before resolving.',
  );
  return lines.join('\n');
}

type SupervisorFactory = () => TileIntelSupervisor;

export interface ProposeGenerateMapSkeletonDeps {
  readonly supervisorFactory?: SupervisorFactory;
  /** Inject a TileIntelClient for tests so we don't need a live
   *  sidecar process. */
  readonly clientForTests?: TileIntelClient;
}

export async function proposeGenerateMapSkeleton(
  ctx: ToolContext,
  args: ProposeGenerateMapSkeletonArgs,
  deps: ProposeGenerateMapSkeletonDeps = {},
): Promise<ProposeGenerateMapSkeletonResult> {
  // Quick input policing beyond what Zod handles (size pairing
  // mirrors the sidecar's check; we duplicate it here so the agent
  // sees a clean error before a network round-trip).
  if ((args.width === undefined) !== (args.height === undefined)) {
    return {
      ok: false,
      reason: 'invalid_input',
      message:
        'Map size must be a complete pair - pass both width and height, or ' +
        'neither (theme default).',
    };
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
          'The tile-intelligence sidecar is offline. Map generation needs ' +
          'it running. Start it (npm run start) and retry.',
      };
    }
    client = new TileIntelClient(status.baseUrl);
  }

  const request: GenerateSkeletonRequest = {
    theme: args.theme,
    biome: args.biome,
    width: args.width,
    height: args.height,
    density: args.density,
    elevation_layers: args.elevationLayers,
    seed: args.seed,
    name: args.name,
    primary_tileset: args.primaryTileset,
    secondary_tileset: args.secondaryTileset,
    skip_templates: args.skipTemplates,
  };

  let response: GenerateSkeletonResponse;
  try {
    response = await client.generateSkeleton(request);
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      reason: 'sidecar_error',
      message:
        'The tile-intelligence sidecar returned an error while building ' +
        `your map outline: ${detail}`,
    };
  }

  // Persist to disk.
  const skeletonObj = response.skeleton as {
    map?: { name?: string };
  };
  const mapName =
    typeof skeletonObj.map?.name === 'string'
      ? skeletonObj.map.name
      : args.name ?? `${args.theme} (auto-generated)`;
  const slug = nameToSlug(mapName);
  let persistedPath: string | null = null;
  try {
    const dir = path.join(ctx.projectRoot, '.editor', 'skeletons');
    await fsp.mkdir(dir, { recursive: true });
    persistedPath = path.join(dir, `${slug}.map.json`);
    await fsp.writeFile(
      persistedPath,
      JSON.stringify(response.skeleton, null, 2),
      'utf8',
    );
  } catch (e) {
    return {
      ok: false,
      reason: 'persist_failed',
      message:
        'The map outline was generated, but writing it to disk failed: ' +
        (e instanceof Error ? e.message : String(e)),
    };
  }

  return {
    ok: true,
    persistedPath,
    slug,
    mapName,
    summary: buildSummary(args, response),
    skeleton: response.skeleton,
    report: response.report,
  };
}
