/**
 * Phase 8A-4 - Tile-intel Node-side type definitions.
 *
 * Mirror of the Python sidecar's wire shapes. We DON'T regenerate
 * these from the FastAPI OpenAPI - the contract is small enough to
 * hand-author, and CI parity for the IR (Phase 8A-3) is handled
 * separately via JSON Schema diffing. These types reflect ONLY the
 * tile-intel-svc HTTP surface.
 */

/** What the sidecar's GET /health returns. */
export interface SidecarHealthResponse {
  readonly ok: boolean;
  readonly schema_version: number;
  readonly api_version: number;
}

/** What the sidecar's GET /v1/version returns. */
export interface SidecarVersionResponse {
  readonly package_version: string;
  readonly schema_version: number;
  readonly api_version: number;
  readonly test_mode: boolean;
}

/** Discriminated union the supervisor returns whenever the sidecar
 *  isn't ready for tool invocation. Every tile-intel tool's result
 *  type includes this as a top-level union with the success case so
 *  the agent never sees an exception path for environmental
 *  conditions - only structured `{available:false, reason}` payloads.
 *
 *  See `app/backend/src/agent/types.ts` for the established
 *  `WorkspaceSummaryUnavailable` pattern this mirrors. */
export type TileIntelUnavailable =
  /** Sidecar not running and supervisor isn't trying to start it. */
  | { readonly available: false; readonly reason: 'sidecar_offline'; readonly details: string }
  /** Sidecar started but crashed; supervisor logged details to disk. */
  | { readonly available: false; readonly reason: 'sidecar_crashed'; readonly details: string }
  /** Sidecar up but Postgres or Qdrant unreachable. */
  | { readonly available: false; readonly reason: 'storage_unhealthy'; readonly details: string }
  /** Sidecar API version doesn't match what this backend expects. */
  | {
      readonly available: false;
      readonly reason: 'version_mismatch';
      readonly expected: number;
      readonly observed: number;
    }
  /** Sidecar is in startup window; retry recommended. */
  | { readonly available: false; readonly reason: 'warming_up'; readonly etaSeconds: number }
  /** Sidecar dependency (CLIP model, etc.) is missing - operation
   *  CAN be retried after the user installs/downloads what's needed. */
  | { readonly available: false; readonly reason: 'embedding_unavailable'; readonly details: string };

/** A successful client handle. */
export interface TileIntelReady {
  readonly available: true;
  readonly baseUrl: string;
  readonly health: SidecarHealthResponse;
  readonly version: SidecarVersionResponse;
}

/** What the supervisor returns from `ensureReady()`. */
export type TileIntelStatus = TileIntelReady | TileIntelUnavailable;

/** API version this backend was built against. Bumped only on
 *  breaking changes to the wire contract; the supervisor refuses
 *  to invoke tools when the sidecar reports a different value. */
export const EXPECTED_SIDECAR_API_VERSION = 1 as const;

// ---------------------------------------------------------------------------
// Generation API (Phase 8G)
// ---------------------------------------------------------------------------

/** Inputs for POST /v1/generate/skeleton. Lifted from the sidecar's
 *  Pydantic model; keep in sync. */
export interface GenerateSkeletonRequest {
  readonly theme:
    | 'route'
    | 'forest'
    | 'cave'
    | 'town'
    | 'beach'
    | 'mountain'
    | 'dungeon'
    | 'arctic'
    | 'tropical'
    | 'urban'
    | 'indoor'
    | 'plains';
  readonly biome: string;
  readonly width?: number;
  readonly height?: number;
  readonly density?: 'low' | 'medium' | 'high';
  readonly elevation_layers?: number;
  readonly seed?: number;
  readonly name?: string;
  readonly primary_tileset?: string;
  readonly secondary_tileset?: string;
  readonly skip_templates?: boolean;
}

/** Diagnostic block the sidecar returns alongside the skeleton. */
export interface GenerateSkeletonReportPayload {
  readonly seed: number;
  readonly chosen_templates: ReadonlyArray<string>;
  readonly chosen_primary_tileset: string;
  readonly chosen_secondary_tileset: string;
  readonly warnings: ReadonlyArray<string>;
  readonly region_count: number;
  readonly poi_count: number;
  readonly path_count: number;
  readonly template_anchor_count: number;
  readonly constraint_count: number;
}

/** The sidecar's full reply. `skeleton` is opaque-JSON intentionally
 * - we don't re-validate against the Zod MapSkeleton schema until
 *  the TS-side propose tool needs to render it, keeping the client
 *  thin. */
export interface GenerateSkeletonResponse {
  readonly skeleton: Record<string, unknown>;
  readonly report: GenerateSkeletonReportPayload;
}

/** Inputs for POST /v1/generate/resolve. */
export interface ResolveSkeletonRequest {
  /** The full MapSkeleton document (per `MapSkeleton` schema). */
  readonly skeleton: Record<string, unknown>;
  /** Seed for the resolver's internal RNG. Same skeleton + seed
   *  yields byte-identical output. */
  readonly seed?: number;
}

/** A placed metatile. `null` when the resolver couldn't fill a cell. */
export interface ResolvedCell {
  readonly tileset_slug: string;
  readonly metatile_index: number;
}

/** POI carried through the resolved response so the 8G-3 validator
 *  can find POI cells without re-reading the skeleton. */
export interface ResolvedPoiPayload {
  readonly id: string;
  readonly kind: string;
  readonly x: number | null;
  readonly y: number | null;
  /** When the POI was shape-bound: [x, y, w, h]. */
  readonly rect: ReadonlyArray<number> | null;
}

export interface ResolvedReportPayload {
  readonly seed: number;
  readonly width: number;
  readonly height: number;
  readonly assigned_cells: number;
  readonly unassigned_cells: number;
  readonly template_anchors_placed: number;
  readonly template_anchors_skipped: number;
  readonly rule_violations: number;
  readonly rules_consulted: number;
  readonly paths_solved: number;
  readonly paths_failed: number;
  readonly warnings: ReadonlyArray<string>;
}

export interface ResolveSkeletonResponse {
  readonly primary_tileset_slug: string;
  readonly secondary_tileset_slug: string;
  readonly width: number;
  readonly height: number;
  /** Row-major: `grid[y][x]` is the cell at (x, y). `null` for
   *  unassigned cells. */
  readonly grid: ReadonlyArray<ReadonlyArray<ResolvedCell | null>>;
  /** Per-cell sorted tag list. Same shape as `grid`. */
  readonly tag_grid: ReadonlyArray<ReadonlyArray<ReadonlyArray<string>>>;
  /** 2 × 2 border block. */
  readonly border_blocks: ReadonlyArray<ReadonlyArray<ResolvedCell | null>>;
  /** POIs carried from the original skeleton (so the 8G-3 validator
   *  can reach them without re-reading the skeleton file). */
  readonly pois: ReadonlyArray<ResolvedPoiPayload>;
  readonly report: ResolvedReportPayload;
}

/** Inputs for POST /v1/generate/validate-traversal. */
export interface ValidateTraversalRequest {
  /** A `ResolveSkeletonResponse` body verbatim (typically read from
   *  `<projectRoot>/.editor/resolved-maps/<slug>.resolved.json`). */
  readonly resolved: Record<string, unknown>;
}

export interface TraversalIssuePayload {
  readonly severity: 'error' | 'warning' | 'info';
  readonly code: string;
  readonly message: string;
  readonly x?: number | null;
  readonly y?: number | null;
  readonly poi_id?: string | null;
}

export interface PoiReachabilityPayload {
  readonly poi_id: string;
  readonly walkable: boolean;
  readonly component_size: number;
  readonly reachable_pois: ReadonlyArray<string>;
}

export interface WalkableMaskSummaryPayload {
  readonly walkable_cells: number;
  readonly component_count: number;
  readonly largest_component_size: number;
  readonly largest_component_share: number;
}

export interface ValidateTraversalResponse {
  readonly ok: boolean;
  readonly summary: string;
  readonly width: number;
  readonly height: number;
  readonly issues: ReadonlyArray<TraversalIssuePayload>;
  readonly poi_reachability: ReadonlyArray<PoiReachabilityPayload>;
  readonly walkable_summary: WalkableMaskSummaryPayload;
}

// ---------------------------------------------------------------------------
// Phase 8H - Interactive co-design endpoints
// ---------------------------------------------------------------------------

/** Inputs for POST /v1/neighbors/suggest. */
export interface SuggestNeighborsRequest {
  readonly tileset_slug: string;
  readonly metatile_index: number;
  /** 8-way direction code: 0=N, 1=NE, 2=E, 3=SE, 4=S, 5=SW, 6=W, 7=NW. */
  readonly direction: number;
  readonly limit?: number;
}

export interface NeighborSuggestionPayload {
  readonly tileset_slug: string;
  readonly metatile_index: number;
  readonly probability: number;
  readonly support_count: number;
  readonly behavior_id: number;
  readonly is_walkable: boolean;
  readonly phash_hex: string;
  readonly seed_tags_sample: ReadonlyArray<string>;
}

export interface SuggestNeighborsResponse {
  readonly seed_tileset_slug: string;
  readonly seed_metatile_index: number;
  readonly direction: number;
  readonly total_observations: number;
  readonly entropy: number;
  readonly suggestions: ReadonlyArray<NeighborSuggestionPayload>;
}

/** Inputs for POST /v1/regions/complete. */
export interface CompleteRegionRequest {
  readonly width: number;
  readonly height: number;
  /** Per-cell tag list. Cells outside the rect can be passed with
   *  surrounding tags to constrain the resolver. */
  readonly tag_grid: ReadonlyArray<ReadonlyArray<ReadonlyArray<string>>>;
  /** Optional `"x,y" -> { tileset_slug, metatile_index }` map for
   *  cells the caller already knows. */
  readonly seed_cells?: Record<
    string,
    { readonly tileset_slug: string; readonly metatile_index: number }
  >;
  readonly primary_tileset_slug: string;
  readonly secondary_tileset_slug: string;
  readonly seed?: number;
}

export interface CompletedCellPayload {
  readonly x: number;
  readonly y: number;
  readonly tileset_slug: string;
  readonly metatile_index: number;
}

export interface CompleteRegionResponse {
  readonly width: number;
  readonly height: number;
  readonly cells: ReadonlyArray<CompletedCellPayload>;
  readonly unassigned_cells: number;
  readonly rule_violations: number;
  readonly rules_consulted: number;
}

/** Query params for GET /v1/tilesets/library. */
export interface TilesetLibraryQuery {
  readonly family?: string;
  readonly isSecondary?: boolean;
  readonly source?: string;
  readonly licenseSpdx?: string;
  readonly limit?: number;
  readonly offset?: number;
}

export interface TilesetLibraryEntry {
  readonly slug: string;
  readonly display_name: string;
  readonly family: string;
  readonly is_secondary: boolean;
  readonly source: string;
  readonly source_commit: string | null;
  readonly license_spdx: string | null;
  readonly attribution: string | null;
  readonly metatile_count: number;
  readonly palette_count: number;
}

export interface TilesetLibraryResponse {
  readonly total_tilesets: number;
  readonly entries: ReadonlyArray<TilesetLibraryEntry>;
}

/** Inputs for POST /v1/templates/apply. */
export interface ApplyTemplateRequest {
  readonly template_slug: string;
  readonly anchor: { readonly x: number; readonly y: number };
  readonly tag_bindings?: Record<string, string>;
  readonly map_width?: number;
  readonly map_height?: number;
}

export interface ApplyTemplateCellPayload {
  readonly x: number;
  readonly y: number;
  readonly tileset_slug: string;
  readonly metatile_index: number;
}

export interface ApplyTemplateResponse {
  readonly template_slug: string;
  readonly role: string;
  readonly width: number;
  readonly height: number;
  readonly cells: ReadonlyArray<ApplyTemplateCellPayload>;
  readonly cells_out_of_bounds: number;
}
