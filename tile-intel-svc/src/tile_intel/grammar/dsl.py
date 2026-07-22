"""Phase 8F-3 - Map-grammar DSL.

The intermediate representation that sits between human/agent
intent ("build a forest route with two clearings, two patrols, and
a south exit") and concrete metatile placements. Phase 8G's
skeleton-resolve generator consumes one of these.

The DSL is intentionally declarative:
  - You DECLARE regions / paths / POIs / constraints.
  - The resolver figures out WHICH metatiles go where.

The Pydantic models below mirror the Zod schemas in
`app/shared/src/map-skeleton.ts` (Phase 8F-3 ships both halves).
A future CI parity check (Phase 8I-2) diffs the JSON Schema
exports so the two stay in lock-step.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

# ---------------------------------------------------------------------------
# Shapes (tagged union)
# ---------------------------------------------------------------------------


class RectShape(BaseModel):
    """Axis-aligned rectangle. Inclusive of the top-left, exclusive
    of the bottom-right - same convention as the existing map editor."""

    model_config = ConfigDict(extra="forbid")
    kind: Literal["rect"]
    x: int = Field(ge=0, le=1024)
    y: int = Field(ge=0, le=1024)
    w: int = Field(ge=1, le=1024)
    h: int = Field(ge=1, le=1024)


class PolygonShape(BaseModel):
    """Closed polygon defined by an ordered list of (x, y) points.
    The resolver fills the interior."""

    model_config = ConfigDict(extra="forbid")
    kind: Literal["polygon"]
    points: list[tuple[int, int]] = Field(min_length=3, max_length=64)


class PointShape(BaseModel):
    """Single tile coordinate. Used by POIs that don't have area."""

    model_config = ConfigDict(extra="forbid")
    kind: Literal["point"]
    x: int = Field(ge=0, le=1024)
    y: int = Field(ge=0, le=1024)


Shape = RectShape | PolygonShape | PointShape


# ---------------------------------------------------------------------------
# Header
# ---------------------------------------------------------------------------


class MapSize(BaseModel):
    model_config = ConfigDict(extra="forbid")
    w: int = Field(ge=1, le=1024)
    h: int = Field(ge=1, le=1024)


class ElevationConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")
    layers: int = Field(default=1, ge=1, le=4)
    default_layer: int = Field(default=0, ge=0, le=3)


class MapHeader(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str = Field(min_length=1, max_length=120)
    size: MapSize
    primary_tileset: str = Field(min_length=1, max_length=200)
    secondary_tileset: str = Field(min_length=1, max_length=200)
    default_biome: str = Field(min_length=1, max_length=120)
    elevation: ElevationConfig = Field(default_factory=ElevationConfig)


# ---------------------------------------------------------------------------
# Regions
# ---------------------------------------------------------------------------


class RegionTags(BaseModel):
    """Free-form region tags. The resolver interprets `terrain` and
    `density`; other keys are passthrough for human readability."""

    model_config = ConfigDict(extra="allow")
    terrain: str | None = None
    density: Literal["low", "medium", "high"] | None = None


class Region(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: str = Field(min_length=1, max_length=80)
    shape: Shape
    biome: str = Field(min_length=1, max_length=120)
    tags: RegionTags = Field(default_factory=RegionTags)
    elevation: int = Field(default=0, ge=0, le=3)
    priority: int = Field(default=0, ge=-100, le=1000)


# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------


class PathEndpointRef(BaseModel):
    """Reference to a POI by id (e.g. `poi:entrance_north`)."""

    model_config = ConfigDict(extra="forbid")
    ref: str = Field(min_length=4, max_length=120)


class PathEndpointPoint(BaseModel):
    """Direct coordinate, no POI lookup."""

    model_config = ConfigDict(extra="forbid")
    x: int = Field(ge=0, le=1024)
    y: int = Field(ge=0, le=1024)


PathEndpoint = PathEndpointRef | PathEndpointPoint


class PathConstraints(BaseModel):
    model_config = ConfigDict(extra="forbid")
    min_turns: int = Field(default=0, ge=0, le=20)
    max_turns: int = Field(default=20, ge=0, le=20)


class Path(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: str = Field(min_length=1, max_length=80)
    endpoints: list[PathEndpoint] = Field(min_length=2, max_length=16)
    width_metatiles: int = Field(default=1, ge=1, le=8)
    tags: dict[str, str] = Field(default_factory=dict)
    constraints: PathConstraints = Field(default_factory=PathConstraints)


# ---------------------------------------------------------------------------
# Templates
# ---------------------------------------------------------------------------


class TemplateAnchor(BaseModel):
    model_config = ConfigDict(extra="forbid")
    x: int = Field(ge=0, le=1024)
    y: int = Field(ge=0, le=1024)


class TemplateRef(BaseModel):
    """Reference to a Template by slug (Phase 8F-1's `templates.slug`).
    `tag_bindings` lets the same template adapt to different host
    terrains: a `house.facade.small` template might bind `filler` →
    `terrain.dirt` in a town context, `terrain.cave.floor` in a
    cave context."""

    model_config = ConfigDict(extra="forbid")
    ref: str = Field(min_length=1, max_length=200)
    anchor: TemplateAnchor
    tag_bindings: dict[str, str] = Field(default_factory=dict)


# ---------------------------------------------------------------------------
# POIs
# ---------------------------------------------------------------------------


class POI(BaseModel):
    """Point of interest: warp, encounter zone, fly destination, etc.
    `metadata` is free-form because each POI kind needs different
    fields (warps need target_map; encounter zones need an
    encounter_table; fly_destinations need a section_id)."""

    model_config = ConfigDict(extra="forbid")
    id: str = Field(min_length=1, max_length=80)
    kind: Literal[
        "warp",
        "encounter_zone",
        "fly_destination",
        "trainer_spawn",
        "object_spawn",
        "sign",
    ]
    shape: Shape | None = None
    x: int | None = Field(default=None, ge=0, le=1024)
    y: int | None = Field(default=None, ge=0, le=1024)
    metadata: dict[str, str] = Field(default_factory=dict)


# ---------------------------------------------------------------------------
# Constraints
# ---------------------------------------------------------------------------


class NoOverlapConstraint(BaseModel):
    model_config = ConfigDict(extra="forbid")
    kind: Literal["no_overlap"]
    regions: list[str] = Field(min_length=2, max_length=32)


class ConnectivityConstraint(BaseModel):
    """Resolver-time assertion that there's a walkable path between
    two POIs (or coordinates) traversing only cells with a given tag."""

    # `populate_by_name=True` lets Python code construct this with
    # `from_="..."` while JSON deserialisation still accepts the
    # JSON-friendly `"from"` key. Both produce the same object.
    model_config = ConfigDict(extra="forbid", populate_by_name=True)
    kind: Literal["connectivity"]
    from_: str = Field(alias="from", min_length=1, max_length=120)
    to: str = Field(min_length=1, max_length=120)
    via_tag: str = Field(default="traversal.walkable", min_length=1, max_length=120)


Constraint = NoOverlapConstraint | ConnectivityConstraint


# ---------------------------------------------------------------------------
# Top-level skeleton
# ---------------------------------------------------------------------------


class MapSkeleton(BaseModel):
    """The whole DSL document."""

    model_config = ConfigDict(extra="forbid")
    version: Literal["1.0"]
    map: MapHeader
    regions: list[Region] = Field(default_factory=list)
    paths: list[Path] = Field(default_factory=list)
    templates: list[TemplateRef] = Field(default_factory=list)
    pois: list[POI] = Field(default_factory=list)
    constraints: list[Constraint] = Field(default_factory=list)


# ---------------------------------------------------------------------------
# Validation beyond Pydantic schema
# ---------------------------------------------------------------------------


class ValidationIssue(BaseModel):
    """One semantic issue surfaced by `validate_skeleton`."""

    severity: Literal["error", "warning"]
    field_path: str
    message: str


def validate_skeleton(skel: MapSkeleton) -> list[ValidationIssue]:
    """Run semantic checks that the schema can't express:
      - region IDs unique
      - POI IDs unique
      - path id unique
      - path endpoint refs resolve to existing POIs
      - constraint `regions` / `from` / `to` references resolve
      - regions don't exceed the map bounds
      - POI coordinates within bounds (or POI has shape)
    """

    issues: list[ValidationIssue] = []
    w = skel.map.size.w
    h = skel.map.size.h

    region_ids = [r.id for r in skel.regions]
    if len(region_ids) != len(set(region_ids)):
        dupes = {x for x in region_ids if region_ids.count(x) > 1}
        for d in dupes:
            issues.append(
                ValidationIssue(
                    severity="error", field_path="regions[].id",
                    message=f"duplicate region id: {d!r}",
                )
            )
    poi_ids = [p.id for p in skel.pois]
    if len(poi_ids) != len(set(poi_ids)):
        dupes = {x for x in poi_ids if poi_ids.count(x) > 1}
        for d in dupes:
            issues.append(
                ValidationIssue(
                    severity="error", field_path="pois[].id",
                    message=f"duplicate POI id: {d!r}",
                )
            )
    path_ids = [p.id for p in skel.paths]
    if len(path_ids) != len(set(path_ids)):
        dupes = {x for x in path_ids if path_ids.count(x) > 1}
        for d in dupes:
            issues.append(
                ValidationIssue(
                    severity="error", field_path="paths[].id",
                    message=f"duplicate path id: {d!r}",
                )
            )

    poi_id_set = set(poi_ids)
    region_id_set = set(region_ids)

    for i, region in enumerate(skel.regions):
        # Bound-check rect/point shapes.
        if region.shape.kind == "rect":
            r = region.shape
            if r.x + r.w > w or r.y + r.h > h:
                issues.append(
                    ValidationIssue(
                        severity="error",
                        field_path=f"regions[{i}].shape",
                        message=(
                            f"rect extends outside map bounds (rect="
                            f"{r.x},{r.y}+{r.w}x{r.h}, map={w}x{h})"
                        ),
                    )
                )
        elif region.shape.kind == "point":
            if region.shape.x >= w or region.shape.y >= h:
                issues.append(
                    ValidationIssue(
                        severity="error", field_path=f"regions[{i}].shape",
                        message="point outside map bounds",
                    )
                )

    for i, poi in enumerate(skel.pois):
        if poi.shape is None and poi.x is None:
            issues.append(
                ValidationIssue(
                    severity="error", field_path=f"pois[{i}]",
                    message="POI must have either shape or (x, y)",
                )
            )
        if poi.x is not None and (poi.x >= w or (poi.y or 0) >= h):
            issues.append(
                ValidationIssue(
                    severity="error", field_path=f"pois[{i}]",
                    message="POI coords outside map bounds",
                )
            )

    for i, path in enumerate(skel.paths):
        for j, ep in enumerate(path.endpoints):
            if isinstance(ep, PathEndpointRef):
                if not ep.ref.startswith("poi:"):
                    issues.append(
                        ValidationIssue(
                            severity="warning",
                            field_path=f"paths[{i}].endpoints[{j}].ref",
                            message="endpoint refs should start with `poi:`",
                        )
                    )
                else:
                    target_id = ep.ref.removeprefix("poi:")
                    if target_id not in poi_id_set:
                        issues.append(
                            ValidationIssue(
                                severity="error",
                                field_path=f"paths[{i}].endpoints[{j}].ref",
                                message=f"unresolved POI ref: {target_id!r}",
                            )
                        )
            elif isinstance(ep, PathEndpointPoint):
                if ep.x >= w or ep.y >= h:
                    issues.append(
                        ValidationIssue(
                            severity="error",
                            field_path=f"paths[{i}].endpoints[{j}]",
                            message="endpoint coords outside map bounds",
                        )
                    )

    for i, constraint in enumerate(skel.constraints):
        if isinstance(constraint, NoOverlapConstraint):
            for r in constraint.regions:
                if r not in region_id_set:
                    issues.append(
                        ValidationIssue(
                            severity="error",
                            field_path=f"constraints[{i}].regions",
                            message=f"unknown region id: {r!r}",
                        )
                    )
        elif isinstance(constraint, ConnectivityConstraint):
            for end, name in ((constraint.from_, "from"), (constraint.to, "to")):
                if end.startswith("poi:"):
                    if end.removeprefix("poi:") not in poi_id_set:
                        issues.append(
                            ValidationIssue(
                                severity="error",
                                field_path=f"constraints[{i}].{name}",
                                message=f"unresolved POI ref: {end!r}",
                            )
                        )
                elif end.startswith("region:"):
                    if end.removeprefix("region:") not in region_id_set:
                        issues.append(
                            ValidationIssue(
                                severity="error",
                                field_path=f"constraints[{i}].{name}",
                                message=f"unresolved region id: {end!r}",
                            )
                        )

    return issues
