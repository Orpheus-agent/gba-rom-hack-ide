/**
 * propose_browse_tileset_library - Phase 8H-3.
 *
 * Read-only browse of the tile-intel sidecar's global tileset
 * library. Useful for the agent to surface "what tilesets do we
 * know about?" or filter by family / source / license.
 *
 * No ROM access. No persistence. Just a thin wrapper around the
 * sidecar's `GET /v1/tilesets/library`.
 */

import { z } from 'zod';

import {
  getDefaultTileIntelSupervisor,
  type TileIntelSupervisor,
} from '../../tile-intel/supervisor.js';
import { TileIntelClient } from '../../tile-intel/client.js';
import type {
  TileIntelUnavailable,
  TilesetLibraryEntry,
} from '../../tile-intel/types.js';
import type { ToolContext } from '../types.js';

export const PROPOSE_BROWSE_TILESET_LIBRARY_TOOL_NAME =
  'propose_browse_tileset_library';

export const PROPOSE_BROWSE_TILESET_LIBRARY_DESCRIPTION =
  'List the tilesets the tile-intel sidecar knows about. Use this\n' +
  'to discover what\'s available before generating or resolving a\n' +
  'map (so the picked tileset slugs match real entries).\n\n' +
  'Inputs (all optional):\n' +
  '  - `family`: `frlg` | `rse` to filter by game family.\n' +
  '  - `isSecondary`: true to list only secondary tilesets.\n' +
  '  - `source`: e.g. `pret-firered`, `pret-emerald`, `cfru`.\n' +
  '  - `licenseSpdx`: e.g. `MIT`.\n' +
  '  - `limit` / `offset`: pagination (default 100 / 0).\n\n' +
  'Returns a paginated list with attribution + metatile/palette\n' +
  'counts per entry.';

export const proposeBrowseTilesetLibraryInputShape = {
  family: z.string().min(1).max(40).optional(),
  isSecondary: z.boolean().optional(),
  source: z.string().min(1).max(64).optional(),
  licenseSpdx: z.string().min(1).max(64).optional(),
  limit: z.number().int().min(1).max(500).optional(),
  offset: z.number().int().min(0).max(100_000).optional(),
} as const;

export type ProposeBrowseTilesetLibraryArgs = {
  family?: string;
  isSecondary?: boolean;
  source?: string;
  licenseSpdx?: string;
  limit?: number;
  offset?: number;
};

export interface ProposeBrowseTilesetLibrarySuccess {
  readonly ok: true;
  readonly totalTilesets: number;
  readonly entries: ReadonlyArray<TilesetLibraryEntry>;
  readonly summary: string;
}

export interface ProposeBrowseTilesetLibraryFailure {
  readonly ok: false;
  readonly message: string;
  readonly reason: 'sidecar_offline' | 'sidecar_error';
  readonly unavailable?: TileIntelUnavailable;
}

export type ProposeBrowseTilesetLibraryResult =
  | ProposeBrowseTilesetLibrarySuccess
  | ProposeBrowseTilesetLibraryFailure;

type SupervisorFactory = () => TileIntelSupervisor;

export interface ProposeBrowseTilesetLibraryDeps {
  readonly supervisorFactory?: SupervisorFactory;
  readonly clientForTests?: TileIntelClient;
}

function buildSummary(
  args: ProposeBrowseTilesetLibraryArgs,
  total: number,
  entries: ReadonlyArray<TilesetLibraryEntry>,
): string {
  const filters: string[] = [];
  if (args.family) filters.push(`family=${args.family}`);
  if (args.isSecondary !== undefined)
    filters.push(`secondary=${args.isSecondary}`);
  if (args.source) filters.push(`source=${args.source}`);
  if (args.licenseSpdx) filters.push(`license=${args.licenseSpdx}`);
  const filterClause = filters.length ? ` (filter: ${filters.join(', ')})` : '';
  const lines: string[] = [];
  lines.push(`Library has ${total} tileset${total === 1 ? '' : 's'}${filterClause}.`);
  if (entries.length > 0) {
    lines.push(`Showing ${entries.length}:`);
    for (const e of entries.slice(0, 8)) {
      const attrib = e.attribution ?? 'no attribution recorded';
      lines.push(
        `  - ${e.slug} (${e.family}${e.is_secondary ? ', secondary' : ''}) - ` +
          `${e.metatile_count} metatiles, ${attrib}`,
      );
    }
    if (entries.length > 8) {
      lines.push(`  - ... and ${entries.length - 8} more in this page.`);
    }
  }
  return lines.join('\n');
}

export async function proposeBrowseTilesetLibrary(
  ctx: ToolContext,
  args: ProposeBrowseTilesetLibraryArgs,
  deps: ProposeBrowseTilesetLibraryDeps = {},
): Promise<ProposeBrowseTilesetLibraryResult> {
  void ctx;

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
          'The tile-intelligence sidecar is offline. Tileset browsing needs ' +
          'it running.',
      };
    }
    client = new TileIntelClient(status.baseUrl);
  }

  try {
    const response = await client.browseTilesetLibrary(args);
    return {
      ok: true,
      totalTilesets: response.total_tilesets,
      entries: response.entries,
      summary: buildSummary(args, response.total_tilesets, response.entries),
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
