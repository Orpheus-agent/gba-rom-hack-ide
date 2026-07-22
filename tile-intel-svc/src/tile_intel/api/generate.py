"""Phase 8G - Generation endpoints.

Two POST endpoints today:
  - `/v1/generate/skeleton` (Phase 8G-1) composes a MapSkeleton DSL
    document from theme + biome + size + density.
  - `/v1/generate/resolve` (Phase 8G-2) walks a skeleton and emits a
    plan of metatile placements.

Future:
  - `/v1/generate/validate-traversal` (Phase 8G-3) - A* / flood-fill.
"""

from __future__ import annotations

from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field, ValidationError

from tile_intel.api.ingest import get_storage_factory_dependency
from tile_intel.generator.resolve import (
    ResolvedMap,
    ResolvedPOI,
    resolve_skeleton,
)
from tile_intel.generator.skeleton import (
    SkeletonGenerationInput,
    generate_skeleton,
)
from tile_intel.generator.harness import (
    HarnessIssue,
    check_resolved_map,
)
from tile_intel.generator.traversal import (
    TraversalReport,
    validate_traversal,
)
from tile_intel.grammar.dsl import MapSkeleton
from tile_intel.storage.base import SqlAlchemyStorageFactory

router = APIRouter(prefix="/v1/generate", tags=["generate"])


Density = Literal["low", "medium", "high"]
Theme = Literal[
    "route",
    "forest",
    "cave",
    "town",
    "beach",
    "mountain",
    "dungeon",
    "arctic",
    "tropical",
    "urban",
    "indoor",
    "plains",
]


class GenerateSkeletonRequest(BaseModel):
    """Inputs for POST /v1/generate/skeleton."""

    theme: Theme
    biome: str = Field(min_length=1, max_length=80)
    width: int | None = Field(default=None, ge=8, le=512)
    height: int | None = Field(default=None, ge=8, le=512)
    density: Density = "medium"
    elevation_layers: int = Field(default=1, ge=1, le=4)
    seed: int = Field(default=0, ge=0, le=2**31 - 1)
    name: str | None = Field(default=None, min_length=1, max_length=120)
    primary_tileset: str | None = Field(default=None, min_length=1, max_length=200)
    secondary_tileset: str | None = Field(default=None, min_length=1, max_length=200)
    skip_templates: bool = False


class GenerateSkeletonReportPayload(BaseModel):
    seed: int
    chosen_templates: list[str]
    chosen_primary_tileset: str
    chosen_secondary_tileset: str
    warnings: list[str]
    region_count: int
    poi_count: int
    path_count: int
    template_anchor_count: int
    constraint_count: int


class GenerateSkeletonResponse(BaseModel):
    skeleton: dict
    report: GenerateSkeletonReportPayload


@router.post("/skeleton", response_model=GenerateSkeletonResponse)
async def generate_skeleton_endpoint(
    request: GenerateSkeletonRequest,
    factory: SqlAlchemyStorageFactory = Depends(get_storage_factory_dependency),
) -> GenerateSkeletonResponse:
    """Phase 8G-1 - Compose a MapSkeleton DSL document.

    Deterministic given the same `seed`. Inputs that omit `width` /
    `height` get a per-theme default. The returned `skeleton` is a
    JSON object validated against the `MapSkeleton` Pydantic schema
 - clients can post it back to `/v1/grammar/parse` to confirm.
    """

    size = None
    if request.width is not None and request.height is not None:
        size = (request.width, request.height)
    elif (request.width is None) != (request.height is None):
        raise HTTPException(
            status_code=400,
            detail="Either set both width+height or neither (theme default).",
        )

    inputs = SkeletonGenerationInput(
        theme=request.theme,  # type: ignore[arg-type]
        biome=request.biome,
        size=size,
        density=request.density,
        elevation_layers=request.elevation_layers,
        seed=request.seed,
        name=request.name,
        primary_tileset=request.primary_tileset,
        secondary_tileset=request.secondary_tileset,
        skip_templates=request.skip_templates,
    )
    skeleton, report = generate_skeleton(inputs, factory=factory)

    # Validate the skeleton against MapSkeleton schema as a final
    # sanity check. If this fails the generator has a bug - surface
    # it as 500.
    try:
        MapSkeleton.model_validate(skeleton.model_dump(by_alias=True))
    except ValidationError as e:
        raise HTTPException(
            status_code=500, detail=f"generator produced invalid skeleton: {e!s}"
        ) from e

    return GenerateSkeletonResponse(
        skeleton=skeleton.model_dump(by_alias=True),
        report=GenerateSkeletonReportPayload(
            seed=report.seed,
            chosen_templates=report.chosen_templates,
            chosen_primary_tileset=report.chosen_primary_tileset,
            chosen_secondary_tileset=report.chosen_secondary_tileset,
            warnings=report.warnings,
            region_count=report.region_count,
            poi_count=report.poi_count,
            path_count=report.path_count,
            template_anchor_count=report.template_anchor_count,
            constraint_count=report.constraint_count,
        ),
    )


# ---------------------------------------------------------------------------
# Resolver - Phase 8G-2
# ---------------------------------------------------------------------------


class ResolveSkeletonRequest(BaseModel):
    """Inputs for POST /v1/generate/resolve. The skeleton arrives as
    opaque JSON so callers can post a skeleton produced by 8G-1
    verbatim - Pydantic re-validates it on this side."""

    skeleton: dict
    seed: int = Field(default=0, ge=0, le=2**31 - 1)


class ResolvedCell(BaseModel):
    """One placed metatile. `None` slots in the response indicate
    cells the resolver couldn't fill (rendered as `null` in JSON)."""

    tileset_slug: str
    metatile_index: int


class ResolvedReportPayload(BaseModel):
    seed: int
    width: int
    height: int
    assigned_cells: int
    unassigned_cells: int
    template_anchors_placed: int
    template_anchors_skipped: int
    rule_violations: int
    rules_consulted: int
    paths_solved: int
    paths_failed: int
    warnings: list[str]


class ResolvedPoiPayload(BaseModel):
    """POI metadata carried through the resolved response so the
    8G-3 validator can find POI cells without re-reading the
    skeleton."""

    id: str
    kind: str
    x: int | None = None
    y: int | None = None
    rect: list[int] | None = None  # [x, y, w, h] when shape is a rect


class ResolveSkeletonResponse(BaseModel):
    primary_tileset_slug: str
    secondary_tileset_slug: str
    width: int
    height: int
    # Row-major: response.grid[y][x] is the cell at (x, y).
    grid: list[list[ResolvedCell | None]]
    # Per-cell tag list (sorted, JSON-friendly).
    tag_grid: list[list[list[str]]]
    # 2x2 border block.
    border_blocks: list[list[ResolvedCell | None]]
    # POIs from the skeleton, copied through.
    pois: list[ResolvedPoiPayload]
    report: ResolvedReportPayload


def _placement_to_cell(
    placement: tuple[str, int] | None,
) -> ResolvedCell | None:
    if placement is None:
        return None
    return ResolvedCell(tileset_slug=placement[0], metatile_index=placement[1])


@router.post("/resolve", response_model=ResolveSkeletonResponse)
async def resolve_skeleton_endpoint(
    request: ResolveSkeletonRequest,
    factory: SqlAlchemyStorageFactory = Depends(get_storage_factory_dependency),
) -> ResolveSkeletonResponse:
    """Phase 8G-2 - Walk a MapSkeleton and emit a concrete metatile
    grid.

    The skeleton may come from `/v1/generate/skeleton` (8G-1) or
    from a hand-edited `.editor/skeletons/<slug>.map.json` file.
    Either way it must pass `MapSkeleton.model_validate` - 
    otherwise a 400 surfaces with the Pydantic errors."""

    try:
        parsed = MapSkeleton.model_validate(request.skeleton)
    except ValidationError as e:
        raise HTTPException(
            status_code=400,
            detail=f"skeleton failed schema validation: {e!s}",
        ) from e

    try:
        resolved: ResolvedMap = resolve_skeleton(
            parsed, factory=factory, seed=request.seed
        )
    except Exception as e:  # noqa: BLE001 - surface as 500 instead of 200.
        raise HTTPException(
            status_code=500,
            detail=f"resolver crashed: {e!s}",
        ) from e

    grid_payload = [
        [_placement_to_cell(resolved.grid[y][x]) for x in range(resolved.width)]
        for y in range(resolved.height)
    ]
    border_payload = [
        [_placement_to_cell(resolved.border_blocks[y][x]) for x in range(2)]
        for y in range(2)
    ]

    pois_payload = [
        ResolvedPoiPayload(
            id=p.id,
            kind=p.kind,
            x=p.x,
            y=p.y,
            rect=list(p.rect) if p.rect is not None else None,
        )
        for p in resolved.pois
    ]

    return ResolveSkeletonResponse(
        primary_tileset_slug=resolved.primary_tileset_slug,
        secondary_tileset_slug=resolved.secondary_tileset_slug,
        width=resolved.width,
        height=resolved.height,
        grid=grid_payload,
        tag_grid=resolved.tag_grid,
        border_blocks=border_payload,
        pois=pois_payload,
        report=ResolvedReportPayload(
            seed=resolved.report.seed,
            width=resolved.report.width,
            height=resolved.report.height,
            assigned_cells=resolved.report.assigned_cells,
            unassigned_cells=resolved.report.unassigned_cells,
            template_anchors_placed=resolved.report.template_anchors_placed,
            template_anchors_skipped=resolved.report.template_anchors_skipped,
            rule_violations=resolved.report.rule_violations,
            rules_consulted=resolved.report.rules_consulted,
            paths_solved=resolved.report.paths_solved,
            paths_failed=resolved.report.paths_failed,
            warnings=resolved.report.warnings,
        ),
    )


# ---------------------------------------------------------------------------
# Traversal validator - Phase 8G-3
# ---------------------------------------------------------------------------


class ValidateTraversalRequest(BaseModel):
    """Input for POST /v1/generate/validate-traversal.

    Pass the full `ResolveSkeletonResponse` body verbatim (the
    `.editor/resolved-maps/<slug>.resolved.json` file the
    propose_resolve_map_skeleton tool persists). The validator
    re-parses it on this side.
    """

    resolved: dict


class TraversalIssuePayload(BaseModel):
    severity: str
    code: str
    message: str
    x: int | None = None
    y: int | None = None
    poi_id: str | None = None


class PoiReachabilityPayload(BaseModel):
    poi_id: str
    walkable: bool
    component_size: int
    reachable_pois: list[str]


class WalkableMaskSummaryPayload(BaseModel):
    walkable_cells: int
    component_count: int
    largest_component_size: int
    largest_component_share: float


class ValidateTraversalResponse(BaseModel):
    ok: bool
    summary: str
    width: int
    height: int
    issues: list[TraversalIssuePayload]
    poi_reachability: list[PoiReachabilityPayload]
    walkable_summary: WalkableMaskSummaryPayload


def _resolved_from_payload(resolved_dict: dict) -> ResolvedMap:
    """Re-hydrate the dataclass shape from the JSON payload. The
    payload comes from `/v1/generate/resolve` so the shape is
    known; this function maps the dict-of-dicts back into
    ResolvedMap + ResolvedPOI instances."""

    from tile_intel.generator.resolve import ResolvedMapReport

    grid_in = resolved_dict.get("grid", [])
    grid: list[list[tuple[str, int] | None]] = []
    for row in grid_in:
        row_out: list[tuple[str, int] | None] = []
        for cell in row:
            if cell is None:
                row_out.append(None)
            else:
                row_out.append((str(cell["tileset_slug"]), int(cell["metatile_index"])))
        grid.append(row_out)
    tag_grid = [
        [list(row[x]) for x in range(len(row))]
        for row in resolved_dict.get("tag_grid", [])
    ]
    border_in = resolved_dict.get("border_blocks", [[None, None], [None, None]])
    border: list[list[tuple[str, int] | None]] = []
    for row in border_in:
        row_out2: list[tuple[str, int] | None] = []
        for cell in row:
            if cell is None:
                row_out2.append(None)
            else:
                row_out2.append((str(cell["tileset_slug"]), int(cell["metatile_index"])))
        border.append(row_out2)
    pois: list[ResolvedPOI] = []
    for raw in resolved_dict.get("pois", []):
        rect = raw.get("rect")
        rect_tuple: tuple[int, int, int, int] | None = (
            (int(rect[0]), int(rect[1]), int(rect[2]), int(rect[3]))
            if rect is not None
            else None
        )
        pois.append(
            ResolvedPOI(
                id=str(raw["id"]),
                kind=str(raw["kind"]),
                x=int(raw["x"]) if raw.get("x") is not None else None,
                y=int(raw["y"]) if raw.get("y") is not None else None,
                rect=rect_tuple,
            )
        )
    report_in = resolved_dict.get("report", {})
    report = ResolvedMapReport(
        seed=int(report_in.get("seed", 0)),
        width=int(report_in.get("width", 0)),
        height=int(report_in.get("height", 0)),
        assigned_cells=int(report_in.get("assigned_cells", 0)),
        unassigned_cells=int(report_in.get("unassigned_cells", 0)),
        template_anchors_placed=int(report_in.get("template_anchors_placed", 0)),
        template_anchors_skipped=int(report_in.get("template_anchors_skipped", 0)),
        rule_violations=int(report_in.get("rule_violations", 0)),
        rules_consulted=int(report_in.get("rules_consulted", 0)),
        paths_solved=int(report_in.get("paths_solved", 0)),
        paths_failed=int(report_in.get("paths_failed", 0)),
        warnings=list(report_in.get("warnings", [])),
    )
    return ResolvedMap(
        width=int(resolved_dict.get("width", 0)),
        height=int(resolved_dict.get("height", 0)),
        grid=grid,
        tag_grid=tag_grid,
        primary_tileset_slug=str(resolved_dict.get("primary_tileset_slug", "")),
        secondary_tileset_slug=str(resolved_dict.get("secondary_tileset_slug", "")),
        border_blocks=border,
        report=report,
        pois=pois,
    )


@router.post("/validate-traversal", response_model=ValidateTraversalResponse)
async def validate_traversal_endpoint(
    request: ValidateTraversalRequest,
) -> ValidateTraversalResponse:
    """Phase 8G-3 - Validate a resolved map's traversal.

    Runs the connected-component / POI-reachability /
    water-transition checks documented in
    `tile_intel/generator/traversal.py`. The endpoint is pure
    (no DB access) - it operates entirely on the resolved payload.
    """

    try:
        resolved = _resolved_from_payload(request.resolved)
    except (KeyError, ValueError, TypeError) as e:
        raise HTTPException(
            status_code=400,
            detail=f"resolved payload could not be parsed: {e!s}",
        ) from e

    report: TraversalReport = validate_traversal(resolved)
    return ValidateTraversalResponse(
        ok=report.ok,
        summary=report.summary,
        width=report.width,
        height=report.height,
        issues=[
            TraversalIssuePayload(
                severity=i.severity,
                code=i.code,
                message=i.message,
                x=i.x,
                y=i.y,
                poi_id=i.poi_id,
            )
            for i in report.issues
        ],
        poi_reachability=[
            PoiReachabilityPayload(
                poi_id=p.poi_id,
                walkable=p.walkable,
                component_size=p.component_size,
                reachable_pois=p.reachable_pois,
            )
            for p in report.poi_reachability
        ],
        walkable_summary=WalkableMaskSummaryPayload(
            walkable_cells=report.walkable_summary.walkable_cells,
            component_count=report.walkable_summary.component_count,
            largest_component_size=report.walkable_summary.largest_component_size,
            largest_component_share=report.walkable_summary.largest_component_share,
        ),
    )


# ---------------------------------------------------------------------------
# Phase 8J-1 - Generated-map harness
# ---------------------------------------------------------------------------


class HarnessRequest(BaseModel):
    """Inputs for POST /v1/generate/harness.

    `resolved` is the full ResolveSkeletonResponse body (verbatim).
    `baseline_fingerprint` is optional - when supplied, the harness
    compares the new fingerprint to detect drift.
    """

    resolved: dict
    baseline_fingerprint: str | None = None


class HarnessIssuePayload(BaseModel):
    severity: str
    code: str
    message: str


class HarnessResponse(BaseModel):
    ok: bool
    fingerprint: str
    width: int
    height: int
    assigned_cells: int
    unassigned_cells: int
    distinct_tileset_slugs: list[str]
    issues: list[HarnessIssuePayload]
    baseline_fingerprint: str | None
    baseline_match: bool | None
    summary: str


@router.post("/harness", response_model=HarnessResponse)
async def harness_endpoint(request: HarnessRequest) -> HarnessResponse:
    """Phase 8J-1 - Validate a resolved-map's internal invariants
    + compute its fingerprint.

    The fingerprint is deterministic: same resolved-map yields the
    same fingerprint regardless of when/where it's computed. The
    editor persists baselines under `<projectRoot>/.editor/tile-intel-baselines/`
    and surfaces drift as a warning when a fresh resolve disagrees
    with the last-confirmed-good state.
    """

    report = check_resolved_map(
        request.resolved, baseline_fingerprint=request.baseline_fingerprint
    )
    return HarnessResponse(
        ok=report.ok,
        fingerprint=report.fingerprint,
        width=report.width,
        height=report.height,
        assigned_cells=report.assigned_cells,
        unassigned_cells=report.unassigned_cells,
        distinct_tileset_slugs=report.distinct_tileset_slugs,
        issues=[
            HarnessIssuePayload(
                severity=i.severity, code=i.code, message=i.message
            )
            for i in report.issues
        ],
        baseline_fingerprint=report.baseline_fingerprint,
        baseline_match=report.baseline_match,
        summary=report.summary,
    )
