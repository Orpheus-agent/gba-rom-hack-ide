/**
 * Phase 8I - Frontend client for the tile-intel proxy routes.
 *
 * Single source of truth for everything the TileIntelligencePanel /
 * SkeletonEditor / map editor adjacency overlays read. Every call
 * returns a discriminated union mirroring the backend's:
 *
 *   - `{ available: true, ...body }` - sidecar reachable + payload
 *   - `{ available: false, reason }` - sidecar offline / warming
 *
 * Callers render the unavailable state inline; they never throw on
 * environmental failures. (Network 4xx still throws - that means
 * the caller passed bad inputs.)
 */

import type {
  ApplyTemplateResponse,
  CompleteRegionResponse,
  GenerateSkeletonResponse,
  ResolveSkeletonResponse,
  SuggestNeighborsResponse,
  TileIntelUnavailable,
  TilesetLibraryResponse,
  ValidateTraversalResponse,
} from './tileIntelTypes';

/** Reply shape - match the backend proxy's discriminated union. */
export type TileIntelClientResult<T> =
  | ({ readonly available: true } & T)
  | TileIntelUnavailable;

async function getJson<T>(path: string): Promise<TileIntelClientResult<T>> {
  const response = await fetch(path, {
    headers: { accept: 'application/json' },
  });
  if (!response.ok) {
    // 4xx / 5xx from the proxy itself - surface generic failure.
    return {
      available: false,
      reason: 'sidecar_offline',
      details: `HTTP ${response.status} from ${path}`,
    };
  }
  return (await response.json()) as TileIntelClientResult<T>;
}

async function postJson<T>(
  path: string,
  body: unknown,
): Promise<TileIntelClientResult<T>> {
  const response = await fetch(path, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    return {
      available: false,
      reason: 'sidecar_offline',
      details: `HTTP ${response.status} from ${path}`,
    };
  }
  return (await response.json()) as TileIntelClientResult<T>;
}

/** Health probe - also surfaces the version block when ready. */
export function fetchTileIntelHealth(): Promise<
  TileIntelClientResult<{
    readonly baseUrl: string;
    readonly health: { ok: boolean; schema_version: number; api_version: number };
    readonly version: {
      package_version: string;
      schema_version: number;
      api_version: number;
      test_mode: boolean;
    };
  }>
> {
  return getJson('/api/tile-intel/health');
}

/** Filterable library browse. Phase 8I-1. */
export function browseTilesetLibrary(filters: {
  family?: string;
  isSecondary?: boolean;
  source?: string;
  licenseSpdx?: string;
  limit?: number;
  offset?: number;
}): Promise<TileIntelClientResult<TilesetLibraryResponse>> {
  const params = new URLSearchParams();
  if (filters.family) params.set('family', filters.family);
  if (filters.isSecondary !== undefined)
    params.set('isSecondary', String(filters.isSecondary));
  if (filters.source) params.set('source', filters.source);
  if (filters.licenseSpdx) params.set('licenseSpdx', filters.licenseSpdx);
  if (filters.limit !== undefined) params.set('limit', String(filters.limit));
  if (filters.offset !== undefined) params.set('offset', String(filters.offset));
  const qs = params.toString();
  return getJson(`/api/tile-intel/library${qs ? `?${qs}` : ''}`);
}

/** List templates by role prefix. Phase 8I-1. */
export function listTemplates(filters: {
  role?: string;
  limit?: number;
}): Promise<
  TileIntelClientResult<{
    readonly templates: ReadonlyArray<{
      readonly slug: string;
      readonly role: string;
      readonly width: number;
      readonly height: number;
      readonly required_tags: ReadonlyArray<string>;
      readonly origin_tileset_id: number | null;
      readonly usage_count: number;
    }>;
  }>
> {
  const params = new URLSearchParams();
  if (filters.role) params.set('role', filters.role);
  if (filters.limit !== undefined) params.set('limit', String(filters.limit));
  const qs = params.toString();
  return getJson(`/api/tile-intel/templates${qs ? `?${qs}` : ''}`);
}

/** Templates appropriate for a biome. Phase 8I-1 / 8I-3. */
export function listTemplatesByBiome(
  biome: string,
  limit = 50,
): Promise<
  TileIntelClientResult<{
    readonly biome: string;
    readonly templates: ReadonlyArray<{
      readonly template_slug: string;
      readonly role: string;
      readonly required_tags: ReadonlyArray<string>;
      readonly biomes: ReadonlyArray<string>;
      readonly total_usage: number;
    }>;
  }>
> {
  const params = new URLSearchParams();
  params.set('biome', biome);
  params.set('limit', String(limit));
  return getJson(`/api/tile-intel/templates/by-biome?${params.toString()}`);
}

/** Biome coverage summary. Phase 8I-1. */
export function fetchBiomeCoverage(): Promise<
  TileIntelClientResult<{ readonly biomes: Record<string, number> }>
> {
  return getJson('/api/tile-intel/biome-coverage');
}

/** Neighbour suggestions. Phase 8I-2. */
export function suggestNeighbors(input: {
  tilesetSlug: string;
  metatileIndex: number;
  direction: number;
  limit?: number;
}): Promise<TileIntelClientResult<SuggestNeighborsResponse>> {
  return postJson('/api/tile-intel/neighbors', {
    tileset_slug: input.tilesetSlug,
    metatile_index: input.metatileIndex,
    direction: input.direction,
    limit: input.limit,
  });
}

/** Auto-fill a rect. Phase 8I-2. */
export function completeRegion(input: {
  width: number;
  height: number;
  tagGrid: string[][][];
  seedCells?: Record<
    string,
    { tilesetSlug: string; metatileIndex: number }
  >;
  primaryTilesetSlug: string;
  secondaryTilesetSlug: string;
  seed?: number;
}): Promise<TileIntelClientResult<CompleteRegionResponse>> {
  return postJson('/api/tile-intel/regions/complete', {
    width: input.width,
    height: input.height,
    tag_grid: input.tagGrid,
    seed_cells: input.seedCells
      ? Object.fromEntries(
          Object.entries(input.seedCells).map(([k, v]) => [
            k,
            { tileset_slug: v.tilesetSlug, metatile_index: v.metatileIndex },
          ]),
        )
      : undefined,
    primary_tileset_slug: input.primaryTilesetSlug,
    secondary_tileset_slug: input.secondaryTilesetSlug,
    seed: input.seed,
  });
}

/** Apply a template at an anchor. Phase 8I-2. */
export function applyTemplate(input: {
  templateSlug: string;
  anchor: { x: number; y: number };
  tagBindings?: Record<string, string>;
  mapWidth?: number;
  mapHeight?: number;
}): Promise<TileIntelClientResult<ApplyTemplateResponse>> {
  return postJson('/api/tile-intel/templates/apply', {
    template_slug: input.templateSlug,
    anchor: input.anchor,
    tag_bindings: input.tagBindings,
    map_width: input.mapWidth,
    map_height: input.mapHeight,
  });
}

/** Phase 8I-3 - skeleton authoring endpoints. */
export function generateSkeleton(input: {
  theme: string;
  biome: string;
  width?: number;
  height?: number;
  density?: 'low' | 'medium' | 'high';
  seed?: number;
  name?: string;
  primaryTileset?: string;
  secondaryTileset?: string;
}): Promise<TileIntelClientResult<GenerateSkeletonResponse>> {
  return postJson('/api/tile-intel/generate/skeleton', {
    theme: input.theme,
    biome: input.biome,
    width: input.width,
    height: input.height,
    density: input.density,
    seed: input.seed,
    name: input.name,
    primary_tileset: input.primaryTileset,
    secondary_tileset: input.secondaryTileset,
  });
}

export function resolveSkeleton(input: {
  skeleton: Record<string, unknown>;
  seed?: number;
}): Promise<TileIntelClientResult<ResolveSkeletonResponse>> {
  return postJson('/api/tile-intel/generate/resolve', input);
}

export function validateTraversal(input: {
  resolved: Record<string, unknown>;
}): Promise<TileIntelClientResult<ValidateTraversalResponse>> {
  return postJson('/api/tile-intel/generate/validate-traversal', input);
}

/** Phase 8J-1 - Validate a resolved-map's internal invariants. */
export interface HarnessIssue {
  readonly severity: 'error' | 'warning' | 'info';
  readonly code: string;
  readonly message: string;
}

export interface HarnessResponse {
  readonly ok: boolean;
  readonly fingerprint: string;
  readonly width: number;
  readonly height: number;
  readonly assigned_cells: number;
  readonly unassigned_cells: number;
  readonly distinct_tileset_slugs: ReadonlyArray<string>;
  readonly issues: ReadonlyArray<HarnessIssue>;
  readonly baseline_fingerprint: string | null;
  readonly baseline_match: boolean | null;
  readonly summary: string;
}

export function runHarness(input: {
  resolved: Record<string, unknown>;
  baseline_fingerprint?: string;
}): Promise<TileIntelClientResult<HarnessResponse>> {
  return postJson('/api/tile-intel/generate/harness', input);
}

/** Phase 8J-2 - Curation override types + endpoints. */
export type OverrideLabel = 'good' | 'bad' | 'neutral';
export type OverrideKind =
  | 'metatile_placement'
  | 'adjacency_pair'
  | 'template'
  | 'region';

export interface OverrideEntry {
  readonly id: number;
  readonly kind: string;
  readonly label: string;
  readonly weight: number;
  readonly payload: Record<string, unknown>;
  readonly note: string | null;
  readonly created_at: string;
  readonly scope: string;
  readonly project_id: string | null;
}

export interface ListOverridesResponse {
  readonly overrides: ReadonlyArray<OverrideEntry>;
  readonly total: number;
}

export interface OverridesSummary {
  readonly total: number;
  readonly good: number;
  readonly bad: number;
  readonly neutral: number;
  readonly by_kind: Record<string, number>;
}

export function listOverrides(filters: {
  kind?: OverrideKind;
  label?: OverrideLabel;
  projectId?: string;
  limit?: number;
  offset?: number;
}): Promise<TileIntelClientResult<ListOverridesResponse>> {
  const params = new URLSearchParams();
  if (filters.kind) params.set('kind', filters.kind);
  if (filters.label) params.set('label', filters.label);
  if (filters.projectId) params.set('project_id', filters.projectId);
  if (filters.limit !== undefined) params.set('limit', String(filters.limit));
  if (filters.offset !== undefined) params.set('offset', String(filters.offset));
  const qs = params.toString();
  return getJson(
    `/api/tile-intel/curation/overrides${qs ? `?${qs}` : ''}`,
  );
}

export function createOverride(input: {
  kind: OverrideKind;
  label: OverrideLabel;
  payload: Record<string, unknown>;
  weight?: number;
  note?: string;
  scope?: 'global' | 'project';
  projectId?: string;
}): Promise<TileIntelClientResult<OverrideEntry>> {
  return postJson('/api/tile-intel/curation/overrides', {
    kind: input.kind,
    label: input.label,
    payload: input.payload,
    weight: input.weight,
    note: input.note,
    scope: input.scope,
    project_id: input.projectId,
  });
}

export async function deleteOverride(
  id: number,
): Promise<TileIntelClientResult<{ readonly deleted: number }>> {
  const response = await fetch(`/api/tile-intel/curation/overrides/${id}`, {
    method: 'DELETE',
  });
  if (!response.ok) {
    return {
      available: false,
      reason: 'sidecar_offline',
      details: `HTTP ${response.status}`,
    };
  }
  return (await response.json()) as TileIntelClientResult<{
    readonly deleted: number;
  }>;
}

export function fetchOverridesSummary(projectId?: string): Promise<
  TileIntelClientResult<OverridesSummary>
> {
  const params = new URLSearchParams();
  if (projectId) params.set('project_id', projectId);
  const qs = params.toString();
  return getJson(`/api/tile-intel/curation/summary${qs ? `?${qs}` : ''}`);
}
