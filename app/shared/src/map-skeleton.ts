/**
 * Phase 8F-3 - Map-grammar DSL (TypeScript interfaces).
 *
 * The intermediate representation between human intent and concrete
 * metatile placements. Phase 8G's resolver consumes one of these.
 *
 * MIRRORED by `tile-intel-svc/src/tile_intel/grammar/dsl.py`. A CI
 * parity check in a future phase diffs the Zod and Pydantic JSON
 * Schema exports.
 */

export interface MapSize {
  readonly w: number;
  readonly h: number;
}

export interface ElevationConfig {
  readonly layers: number;
  readonly default_layer: number;
}

export interface RectShape {
  readonly kind: 'rect';
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

export interface PolygonShape {
  readonly kind: 'polygon';
  readonly points: ReadonlyArray<readonly [number, number]>;
}

export interface PointShape {
  readonly kind: 'point';
  readonly x: number;
  readonly y: number;
}

export type Shape = RectShape | PolygonShape | PointShape;

export interface MapHeader {
  readonly name: string;
  readonly size: MapSize;
  readonly primary_tileset: string;
  readonly secondary_tileset: string;
  readonly default_biome: string;
  readonly elevation?: ElevationConfig;
}

export interface RegionTags {
  readonly terrain?: string;
  readonly density?: 'low' | 'medium' | 'high';
  readonly [extra: string]: string | undefined;
}

export interface Region {
  readonly id: string;
  readonly shape: Shape;
  readonly biome: string;
  readonly tags?: RegionTags;
  readonly elevation?: number;
  readonly priority?: number;
}

export interface PathEndpointRef {
  readonly ref: string;
}

export interface PathEndpointPoint {
  readonly x: number;
  readonly y: number;
}

export type PathEndpoint = PathEndpointRef | PathEndpointPoint;

export interface PathConstraints {
  readonly min_turns?: number;
  readonly max_turns?: number;
}

export interface Path {
  readonly id: string;
  readonly endpoints: ReadonlyArray<PathEndpoint>;
  readonly width_metatiles?: number;
  readonly tags?: Record<string, string>;
  readonly constraints?: PathConstraints;
}

export interface TemplateAnchor {
  readonly x: number;
  readonly y: number;
}

export interface TemplateRef {
  readonly ref: string;
  readonly anchor: TemplateAnchor;
  readonly tag_bindings?: Record<string, string>;
}

export type POIKind =
  | 'warp'
  | 'encounter_zone'
  | 'fly_destination'
  | 'trainer_spawn'
  | 'object_spawn'
  | 'sign';

export interface POI {
  readonly id: string;
  readonly kind: POIKind;
  readonly shape?: Shape;
  readonly x?: number;
  readonly y?: number;
  readonly metadata?: Record<string, string>;
}

export interface NoOverlapConstraint {
  readonly kind: 'no_overlap';
  readonly regions: ReadonlyArray<string>;
}

export interface ConnectivityConstraint {
  readonly kind: 'connectivity';
  readonly from: string;
  readonly to: string;
  readonly via_tag?: string;
}

export type Constraint = NoOverlapConstraint | ConnectivityConstraint;

export interface MapSkeleton {
  readonly version: '1.0';
  readonly map: MapHeader;
  readonly regions?: ReadonlyArray<Region>;
  readonly paths?: ReadonlyArray<Path>;
  readonly templates?: ReadonlyArray<TemplateRef>;
  readonly pois?: ReadonlyArray<POI>;
  readonly constraints?: ReadonlyArray<Constraint>;
}

export interface SkeletonValidationIssue {
  readonly severity: 'error' | 'warning';
  readonly field_path: string;
  readonly message: string;
}

/** Wire shape for POST /v1/grammar/parse response. */
export interface ParseSkeletonResponse {
  readonly ok: boolean;
  readonly issues: ReadonlyArray<SkeletonValidationIssue>;
  readonly map_name: string | null;
  readonly region_count: number;
  readonly path_count: number;
  readonly template_count: number;
  readonly poi_count: number;
  readonly constraint_count: number;
}
