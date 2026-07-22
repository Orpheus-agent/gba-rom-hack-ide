/**
 * Phase 8I - Frontend mirror of the tile-intel wire types.
 *
 * Hand-authored to match `app/backend/src/tile-intel/types.ts`.
 * Kept separate from the backend's types to avoid pulling backend-
 * internal deps into the React bundle.
 */

export type TileIntelUnavailable =
  | { readonly available: false; readonly reason: 'sidecar_offline'; readonly details: string }
  | { readonly available: false; readonly reason: 'sidecar_crashed'; readonly details: string }
  | { readonly available: false; readonly reason: 'storage_unhealthy'; readonly details: string }
  | {
      readonly available: false;
      readonly reason: 'version_mismatch';
      readonly expected: number;
      readonly observed: number;
    }
  | { readonly available: false; readonly reason: 'warming_up'; readonly etaSeconds: number }
  | { readonly available: false; readonly reason: 'embedding_unavailable'; readonly details: string };

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

export interface NeighborSuggestion {
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
  readonly suggestions: ReadonlyArray<NeighborSuggestion>;
}

export interface CompletedCell {
  readonly x: number;
  readonly y: number;
  readonly tileset_slug: string;
  readonly metatile_index: number;
}

export interface CompleteRegionResponse {
  readonly width: number;
  readonly height: number;
  readonly cells: ReadonlyArray<CompletedCell>;
  readonly unassigned_cells: number;
  readonly rule_violations: number;
  readonly rules_consulted: number;
}

export interface ApplyTemplateCell {
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
  readonly cells: ReadonlyArray<ApplyTemplateCell>;
  readonly cells_out_of_bounds: number;
}

export interface GenerateSkeletonReport {
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

export interface GenerateSkeletonResponse {
  readonly skeleton: Record<string, unknown>;
  readonly report: GenerateSkeletonReport;
}

export interface ResolvedCell {
  readonly tileset_slug: string;
  readonly metatile_index: number;
}

export interface ResolveSkeletonResponse {
  readonly primary_tileset_slug: string;
  readonly secondary_tileset_slug: string;
  readonly width: number;
  readonly height: number;
  readonly grid: ReadonlyArray<ReadonlyArray<ResolvedCell | null>>;
  readonly tag_grid: ReadonlyArray<ReadonlyArray<ReadonlyArray<string>>>;
  readonly border_blocks: ReadonlyArray<ReadonlyArray<ResolvedCell | null>>;
  readonly pois: ReadonlyArray<{
    readonly id: string;
    readonly kind: string;
    readonly x: number | null;
    readonly y: number | null;
    readonly rect: ReadonlyArray<number> | null;
  }>;
  readonly report: {
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
  };
}

export interface ValidateTraversalIssue {
  readonly severity: 'error' | 'warning' | 'info';
  readonly code: string;
  readonly message: string;
  readonly x?: number | null;
  readonly y?: number | null;
  readonly poi_id?: string | null;
}

export interface ValidateTraversalResponse {
  readonly ok: boolean;
  readonly summary: string;
  readonly width: number;
  readonly height: number;
  readonly issues: ReadonlyArray<ValidateTraversalIssue>;
  readonly poi_reachability: ReadonlyArray<{
    readonly poi_id: string;
    readonly walkable: boolean;
    readonly component_size: number;
    readonly reachable_pois: ReadonlyArray<string>;
  }>;
  readonly walkable_summary: {
    readonly walkable_cells: number;
    readonly component_count: number;
    readonly largest_component_size: number;
    readonly largest_component_share: number;
  };
}
