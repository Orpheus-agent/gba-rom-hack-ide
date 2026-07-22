"""Phase 8F - Map-grammar endpoints."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select

from tile_intel.api.ingest import get_storage_factory_dependency
from tile_intel.domain.models import Template, TemplateUsage
from tile_intel.grammar import (
    build_templates_from_patterns,
    list_biomes_for_templates,
    templates_by_biome,
)
from tile_intel.grammar.dsl import MapSkeleton, ValidationIssue, validate_skeleton
from tile_intel.storage.base import SqlAlchemyStorageFactory

router = APIRouter(prefix="/v1/grammar", tags=["grammar"])


class BuildTemplatesRequest(BaseModel):
    min_global_frequency: int = Field(default=3, ge=1, le=10_000)
    scope: str = Field(default="global", pattern="^(global|project|merged)$")
    project_id: str | None = None


class BuildTemplatesResponse(BaseModel):
    templates_built: int
    patterns_considered: int
    templates_with_role: int


@router.post("/templates/build", response_model=BuildTemplatesResponse)
async def build_templates_endpoint(
    request: BuildTemplatesRequest | None = None,
    factory: SqlAlchemyStorageFactory = Depends(get_storage_factory_dependency),
) -> BuildTemplatesResponse:
    """Phase 8F-1 - derive templates from aggregated 3x3
    adjacency_patterns. Templates with cross-source frequency >=
    threshold get persisted with a heuristic role classification
    derived from constituent metatile tags."""

    req = request or BuildTemplatesRequest()
    if req.scope in ("project", "merged") and not req.project_id:
        raise HTTPException(
            status_code=400,
            detail=f"scope={req.scope} requires project_id",
        )
    report = build_templates_from_patterns(
        factory,
        min_global_frequency=req.min_global_frequency,
        scope=req.scope,
        project_id=req.project_id,
    )
    return BuildTemplatesResponse(
        templates_built=report.templates_built,
        patterns_considered=report.patterns_considered,
        templates_with_role=report.templates_with_role,
    )


class TemplateEntry(BaseModel):
    slug: str
    role: str
    width: int
    height: int
    required_tags: list[str]
    origin_tileset_id: int | None
    usage_count: int


class TemplatesResponse(BaseModel):
    templates: list[TemplateEntry]


@router.get("/templates", response_model=TemplatesResponse)
async def list_templates_endpoint(
    role: str | None = None,
    limit: int = 100,
    factory: SqlAlchemyStorageFactory = Depends(get_storage_factory_dependency),
) -> TemplatesResponse:
    """List derived templates, optionally filtered by role
    (prefix-match: pass `uniform` to find every uniform_* role)."""

    with factory.session() as session:
        q = select(Template)
        if role is not None:
            q = q.where(Template.role.like(f"{role}%"))
        q = q.order_by(Template.role).limit(limit)
        rows = session.execute(q).scalars().all()
        # One total usage count per template.
        usage_by_template: dict[int, int] = {}
        for tid in [r.id for r in rows]:
            usage_q = session.execute(
                select(TemplateUsage.occurrence_count).where(
                    TemplateUsage.template_id == tid
                )
            ).all()
            usage_by_template[tid] = sum(int(u[0]) for u in usage_q)
        return TemplatesResponse(
            templates=[
                TemplateEntry(
                    slug=t.slug,
                    role=t.role,
                    width=t.width,
                    height=t.height,
                    required_tags=list(t.required_tags),
                    origin_tileset_id=t.origin_tileset_id,
                    usage_count=usage_by_template.get(t.id, 0),
                )
                for t in rows
            ]
        )


class TemplateByBiomeApiEntry(BaseModel):
    template_slug: str
    role: str
    required_tags: list[str]
    biomes: list[str]
    total_usage: int


class TemplatesByBiomeResponse(BaseModel):
    biome: str
    templates: list[TemplateByBiomeApiEntry]


@router.get("/templates/by-biome", response_model=TemplatesByBiomeResponse)
async def templates_by_biome_endpoint(
    biome: str,
    limit: int = 50,
    factory: SqlAlchemyStorageFactory = Depends(get_storage_factory_dependency),
) -> TemplatesByBiomeResponse:
    """Phase 8F-2 - list templates whose required_tags imply
    membership in the given biome. Sorted by total cross-source
    usage descending."""

    if limit < 1 or limit > 500:
        raise HTTPException(status_code=400, detail="limit must be in 1..500")
    rows = templates_by_biome(factory, biome, limit=limit)
    return TemplatesByBiomeResponse(
        biome=biome,
        templates=[
            TemplateByBiomeApiEntry(
                template_slug=r.template_slug,
                role=r.role,
                required_tags=r.required_tags,
                biomes=r.biomes,
                total_usage=r.total_usage,
            )
            for r in rows
        ],
    )


class BiomeCoverageResponse(BaseModel):
    biomes: dict[str, int]


@router.get("/templates/biome-coverage", response_model=BiomeCoverageResponse)
async def biome_coverage_endpoint(
    factory: SqlAlchemyStorageFactory = Depends(get_storage_factory_dependency),
) -> BiomeCoverageResponse:
    """Phase 8F-2 - summary view: how many templates does each
    biome have? Useful for the frontend to surface "we have 47
    forest templates but only 2 arctic ones" honesty."""

    return BiomeCoverageResponse(biomes=list_biomes_for_templates(factory))


class ParseSkeletonResponse(BaseModel):
    """Result of POST /v1/grammar/parse."""

    ok: bool
    issues: list[ValidationIssue]
    map_name: str | None = None
    region_count: int = 0
    path_count: int = 0
    template_count: int = 0
    poi_count: int = 0
    constraint_count: int = 0


@router.post("/parse", response_model=ParseSkeletonResponse)
async def parse_skeleton_endpoint(
    skeleton: dict,
) -> ParseSkeletonResponse:
    """Phase 8F-3 - validate a map-skeleton DSL document.

    Two layers of checks:
      1. Pydantic structural validation (types, ranges, required
         fields, discriminated-union shape consistency).
      2. Semantic validation: unique IDs, references resolve to
         existing POIs/regions, coordinates within map bounds.

    Returns issues by severity (`error` blocks generation;
    `warning` is advisory).
    """

    try:
        parsed = MapSkeleton.model_validate(skeleton)
    except Exception as e:
        return ParseSkeletonResponse(
            ok=False,
            issues=[
                ValidationIssue(
                    severity="error",
                    field_path="root",
                    message=f"schema validation failed: {e}",
                )
            ],
        )
    issues = validate_skeleton(parsed)
    has_error = any(i.severity == "error" for i in issues)
    return ParseSkeletonResponse(
        ok=not has_error,
        issues=issues,
        map_name=parsed.map.name,
        region_count=len(parsed.regions),
        path_count=len(parsed.paths),
        template_count=len(parsed.templates),
        poi_count=len(parsed.pois),
        constraint_count=len(parsed.constraints),
    )
