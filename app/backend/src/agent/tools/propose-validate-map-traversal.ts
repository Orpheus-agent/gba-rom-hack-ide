/**
 * propose_validate_map_traversal - Phase 8G-3.
 *
 * Read-only sanity check on a previously-resolved map (the
 * `<projectRoot>/.editor/resolved-maps/<slug>.resolved.json` file
 * produced by `propose_resolve_map_skeleton` in Phase 8G-2).
 *
 * The sidecar's traversal validator answers:
 *
 *   - Are entrance + exit reachable from each other?
 *   - Are any POIs sitting on unwalkable cells?
 *   - Are there isolated walkable pockets with no POI in them?
 *   - Do any water-tagged cells border non-walkable, non-water
 *     terrain (invalid shoreline transitions)?
 *
 * The tool is intentionally non-destructive - it never proposes
 * a patch. The user runs this BEFORE applying the resolver's plan
 * to catch problems that would crash the game or strand the player.
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
  TileIntelUnavailable,
  ValidateTraversalResponse,
} from '../../tile-intel/types.js';
import type { ToolContext } from '../types.js';

export const PROPOSE_VALIDATE_MAP_TRAVERSAL_TOOL_NAME =
  'propose_validate_map_traversal';

export const PROPOSE_VALIDATE_MAP_TRAVERSAL_DESCRIPTION =
  'Check a resolved map\'s traversal before applying it. Validates\n' +
  'that the entrance and exit are reachable from each other, that\n' +
  'every point of interest sits on a walkable cell, that there are\n' +
  'no isolated walkable pockets, and that water borders are sane.\n\n' +
  'Inputs:\n' +
  '  - `resolvedSlug`: the name of the resolved-map file under\n' +
  '    `<projectRoot>/.editor/resolved-maps/`. Most callers pass the\n' +
  '    `slug` from propose_resolve_map_skeleton verbatim.\n\n' +
  'Output: a structured report listing the issues by severity\n' +
  '(`error` blocks safe-to-apply; `warning` is advisory) + a per-POI\n' +
  'reachability summary + a plain-English summary the user can read\n' +
  'before deciding whether to apply the resolver\'s plan.';

export const proposeValidateMapTraversalInputShape = {
  resolvedSlug: z.string().min(1).max(120),
} as const;

export type ProposeValidateMapTraversalArgs = {
  resolvedSlug: string;
};

export interface ProposeValidateMapTraversalSuccess {
  readonly ok: true;
  /** True when no error-severity issues fired. */
  readonly traversalOk: boolean;
  readonly resolvedSlug: string;
  readonly summary: string;
  readonly issues: ValidateTraversalResponse['issues'];
  readonly poiReachability: ValidateTraversalResponse['poi_reachability'];
  readonly walkableSummary: ValidateTraversalResponse['walkable_summary'];
}

export interface ProposeValidateMapTraversalFailure {
  readonly ok: false;
  readonly reason:
    | 'invalid_input'
    | 'resolved_not_found'
    | 'sidecar_offline'
    | 'sidecar_error';
  readonly message: string;
  readonly unavailable?: TileIntelUnavailable;
}

export type ProposeValidateMapTraversalResult =
  | ProposeValidateMapTraversalSuccess
  | ProposeValidateMapTraversalFailure;

type SupervisorFactory = () => TileIntelSupervisor;

export interface ProposeValidateMapTraversalDeps {
  readonly supervisorFactory?: SupervisorFactory;
  readonly clientForTests?: TileIntelClient;
}

function safeSlug(slug: string): string {
  return slug.replace(/[^a-zA-Z0-9._-]/g, '');
}

export async function proposeValidateMapTraversal(
  ctx: ToolContext,
  args: ProposeValidateMapTraversalArgs,
  deps: ProposeValidateMapTraversalDeps = {},
): Promise<ProposeValidateMapTraversalResult> {
  const slug = safeSlug(args.resolvedSlug);
  if (!slug) {
    return {
      ok: false,
      reason: 'invalid_input',
      message:
        'The resolved-map slug must be alphanumeric / underscore / hyphen / dot only.',
    };
  }

  const resolvedPath = path.join(
    ctx.projectRoot,
    '.editor',
    'resolved-maps',
    `${slug}.resolved.json`,
  );
  let resolved: Record<string, unknown>;
  try {
    const raw = await fsp.readFile(resolvedPath, 'utf8');
    resolved = JSON.parse(raw) as Record<string, unknown>;
  } catch (e) {
    return {
      ok: false,
      reason: 'resolved_not_found',
      message:
        `Couldn't read the resolved-map file at ${resolvedPath}: ` +
        (e instanceof Error ? e.message : String(e)) +
        '. Run propose_resolve_map_skeleton first.',
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
          'The tile-intelligence sidecar is offline. Traversal validation ' +
          'needs it running.',
      };
    }
    client = new TileIntelClient(status.baseUrl);
  }

  let response: ValidateTraversalResponse;
  try {
    response = await client.validateTraversal({ resolved });
  } catch (e) {
    return {
      ok: false,
      reason: 'sidecar_error',
      message:
        'The tile-intelligence sidecar returned an error: ' +
        (e instanceof Error ? e.message : String(e)),
    };
  }

  return {
    ok: true,
    traversalOk: response.ok,
    resolvedSlug: slug,
    summary: response.summary,
    issues: response.issues,
    poiReachability: response.poi_reachability,
    walkableSummary: response.walkable_summary,
  };
}
