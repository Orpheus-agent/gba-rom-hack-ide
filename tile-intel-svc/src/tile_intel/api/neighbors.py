"""Phase 8H - Interactive co-design endpoints.

Currently exposes:

  - POST /v1/neighbors/suggest (Phase 8H-1) - given a seed metatile
    + direction, return top-N legal neighbours weighted by
    adjacency_rules probability.
  - POST /v1/regions/complete (Phase 8H-2) - fill a rect with
    metatiles consistent with the surrounding map cells.
  - GET  /v1/tilesets/library (Phase 8H-3) - filterable list of
    tilesets in the global library.
  - POST /v1/templates/apply (Phase 8H-4) - emit a paint plan for
    placing a template at an anchor with optional tag bindings.
"""

from __future__ import annotations

from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select

from tile_intel.api.ingest import get_storage_factory_dependency
from tile_intel.domain.models import (
    AdjacencyRule,
    Metatile,
    Template,
    Tileset,
)
from tile_intel.storage.base import SqlAlchemyStorageFactory

router = APIRouter(prefix="/v1", tags=["interactive"])


# ---------------------------------------------------------------------------
# 8H-2 - region completion
# ---------------------------------------------------------------------------


class RegionCompleteCell(BaseModel):
    """One known cell. `None` for cells the caller wants the resolver
    to FILL; populated for cells the resolver should constrain
    against."""

    tileset_slug: str
    metatile_index: int


class CompleteRegionRequest(BaseModel):
    """Inputs for POST /v1/regions/complete.

    The caller supplies:
      - `width` × `height`: the rectangle size.
      - `tag_grid`: per-cell tag list. Cells outside the rect should
        carry tag sets that reflect the surrounding map (the
        constraint solver uses these as anchors).
      - `seed_cells`: optional mapping `"x,y" -> RegionCompleteCell`
        for cells the caller already knows the metatile of (e.g.
        from existing map content surrounding the rect). The resolver
        treats these as fixed.
      - `primary_tileset_slug`, `secondary_tileset_slug`: preferences.
    """

    width: int = Field(ge=1, le=512)
    height: int = Field(ge=1, le=512)
    tag_grid: list[list[list[str]]]
    seed_cells: dict[str, RegionCompleteCell] = Field(default_factory=dict)
    primary_tileset_slug: str = Field(min_length=1, max_length=200)
    secondary_tileset_slug: str = Field(min_length=1, max_length=200)
    seed: int = Field(default=0, ge=0, le=2**31 - 1)


class CompletedCell(BaseModel):
    x: int
    y: int
    tileset_slug: str
    metatile_index: int


class CompleteRegionResponse(BaseModel):
    width: int
    height: int
    cells: list[CompletedCell]
    unassigned_cells: int
    rule_violations: int
    rules_consulted: int


@router.post("/regions/complete", response_model=CompleteRegionResponse)
async def complete_region_endpoint(
    request: CompleteRegionRequest,
    factory: SqlAlchemyStorageFactory = Depends(get_storage_factory_dependency),
) -> CompleteRegionResponse:
    """Phase 8H-2 - Greedy-fill a rect with metatiles consistent
    with the surrounding tag set + seed cells.

    Same algorithm as the resolver's `_fill_unassigned` pass, scoped
    to a single rect. Used by the visual map-editor "auto-complete"
    affordance: select a 5x5 region, mark it as `terrain.grass.tall`,
    and let the sidecar pick the metatiles.
    """

    if len(request.tag_grid) != request.height:
        raise HTTPException(
            status_code=400,
            detail=f"tag_grid height {len(request.tag_grid)} ≠ height {request.height}",
        )
    for row in request.tag_grid:
        if len(row) != request.width:
            raise HTTPException(
                status_code=400,
                detail=f"tag_grid row width != width {request.width}",
            )

    import random
    from tile_intel.generator.resolve import (
        TagIndex,
        _adjacency_lookup,
        _fill_unassigned,
    )
    from tile_intel.grammar.dsl import (
        MapHeader,
        MapSize,
        MapSkeleton,
        RectShape,
        Region,
        RegionTags,
    )

    # Build a synthetic MapSkeleton wrapper so we can reuse the
    # resolver's _fill_unassigned() verbatim. The skeleton has a
    # single full-map bg region (terrain becomes the most-common
    # tag we see) - the actual tag grid is what governs the fill.
    skel = MapSkeleton(
        version="1.0",
        map=MapHeader(
            name="<region>",
            size=MapSize(w=request.width, h=request.height),
            primary_tileset=request.primary_tileset_slug,
            secondary_tileset=request.secondary_tileset_slug,
            default_biome="biome.unknown",
        ),
        regions=[
            Region(
                id="bg",
                shape=RectShape(kind="rect", x=0, y=0, w=request.width, h=request.height),
                biome="biome.unknown",
                tags=RegionTags(terrain="terrain.unknown"),
                elevation=0,
                priority=0,
            )
        ],
    )

    # Sets-of-tags grid (resolver mutates this in-place).
    tag_grid: list[list[set[str]]] = [
        [set(request.tag_grid[y][x]) for x in range(request.width)]
        for y in range(request.height)
    ]

    # Seed cells become locked metatile placements.
    grid: list[list[tuple[str, int] | None]] = [
        [None] * request.width for _ in range(request.height)
    ]
    for key, cell in request.seed_cells.items():
        try:
            sx, sy = key.split(",")
            x, y = int(sx), int(sy)
        except ValueError:
            continue
        if not (0 <= x < request.width and 0 <= y < request.height):
            continue
        grid[y][x] = (cell.tileset_slug, cell.metatile_index)

    rng = random.Random(request.seed)

    with factory.session() as session:
        tag_index = TagIndex.from_db(session)
        rule_violations, rules_consulted = _fill_unassigned(
            session=session,
            skeleton=skel,
            grid=grid,
            tag_grid=tag_grid,
            tag_index=tag_index,
            primary_slug=request.primary_tileset_slug,
            secondary_slug=request.secondary_tileset_slug,
            rng=rng,
        )

    cells: list[CompletedCell] = []
    unassigned = 0
    for y in range(request.height):
        for x in range(request.width):
            cell = grid[y][x]
            if cell is None:
                unassigned += 1
                continue
            cells.append(
                CompletedCell(
                    x=x,
                    y=y,
                    tileset_slug=cell[0],
                    metatile_index=cell[1],
                )
            )

    return CompleteRegionResponse(
        width=request.width,
        height=request.height,
        cells=cells,
        unassigned_cells=unassigned,
        rule_violations=rule_violations,
        rules_consulted=rules_consulted,
    )


# ---------------------------------------------------------------------------
# 8H-1 - neighbor suggestions
# ---------------------------------------------------------------------------


Direction = Literal[0, 1, 2, 3, 4, 5, 6, 7]


class SuggestNeighborsRequest(BaseModel):
    """Inputs for POST /v1/neighbors/suggest."""

    tileset_slug: str = Field(min_length=1, max_length=200)
    metatile_index: int = Field(ge=0, le=0x3FF)
    direction: int = Field(ge=0, le=7)
    limit: int = Field(default=12, ge=1, le=100)


class NeighborSuggestion(BaseModel):
    tileset_slug: str
    metatile_index: int
    probability: float
    support_count: int
    behavior_id: int
    is_walkable: bool
    phash_hex: str
    # The seed metatile's tags (informational; the candidate's tags
    # join would be a per-candidate hit, expensive for v1).
    seed_tags_sample: list[str] = Field(default_factory=list)


class SuggestNeighborsResponse(BaseModel):
    seed_tileset_slug: str
    seed_metatile_index: int
    direction: int
    total_observations: int
    entropy: float
    suggestions: list[NeighborSuggestion]


@router.post("/neighbors/suggest", response_model=SuggestNeighborsResponse)
async def suggest_neighbors_endpoint(
    request: SuggestNeighborsRequest,
    factory: SqlAlchemyStorageFactory = Depends(get_storage_factory_dependency),
) -> SuggestNeighborsResponse:
    """Phase 8H-1 - Return top-N legal neighbours of a seed metatile
    in the given direction.

    Direction codes follow the 8-way convention used by the
    adjacency miner: 0=N, 1=NE, 2=E, 3=SE, 4=S, 5=SW, 6=W, 7=NW.
    For ordinary 4-way painting use 0, 2, 4, 6.
    """

    with factory.session() as session:
        # Resolve the seed metatile.
        seed_row = session.execute(
            select(Metatile.id, Metatile.behavior_id)
            .join(Tileset, Tileset.id == Metatile.tileset_id)
            .where(
                Tileset.slug == request.tileset_slug,
                Metatile.metatile_index == request.metatile_index,
            )
        ).first()
        if seed_row is None:
            raise HTTPException(
                status_code=404,
                detail=(
                    f"no metatile at tileset_slug={request.tileset_slug!r}, "
                    f"metatile_index={request.metatile_index}"
                ),
            )
        seed_id = int(seed_row[0])

        # Look up the adjacency rule for this seed + direction.
        rule = session.execute(
            select(
                AdjacencyRule.legal_neighbors,
                AdjacencyRule.total_observations,
                AdjacencyRule.entropy,
            ).where(
                AdjacencyRule.metatile_a == seed_id,
                AdjacencyRule.direction == request.direction,
                AdjacencyRule.scope == "global",
            )
        ).first()
        if rule is None:
            return SuggestNeighborsResponse(
                seed_tileset_slug=request.tileset_slug,
                seed_metatile_index=request.metatile_index,
                direction=request.direction,
                total_observations=0,
                entropy=0.0,
                suggestions=[],
            )
        legal_neighbors, total_observations, entropy = rule

        # Resolve the top-N candidates back into tileset_slug +
        # metatile_index pairs.
        ordered = list(legal_neighbors)[: request.limit]
        if not ordered:
            return SuggestNeighborsResponse(
                seed_tileset_slug=request.tileset_slug,
                seed_metatile_index=request.metatile_index,
                direction=request.direction,
                total_observations=int(total_observations),
                entropy=float(entropy),
                suggestions=[],
            )

        candidate_ids = [int(c["id"]) for c in ordered]
        candidates = session.execute(
            select(
                Metatile.id,
                Tileset.slug,
                Metatile.metatile_index,
                Metatile.behavior_id,
                Metatile.is_walkable,
                Metatile.phash,
            )
            .join(Tileset, Tileset.id == Metatile.tileset_id)
            .where(Metatile.id.in_(candidate_ids))
        ).all()
        by_id = {
            int(c[0]): {
                "tileset_slug": str(c[1]),
                "metatile_index": int(c[2]),
                "behavior_id": int(c[3]),
                "is_walkable": bool(c[4]),
                "phash_hex": (bytes(c[5]) if c[5] is not None else b"").hex(),
            }
            for c in candidates
        }

        suggestions: list[NeighborSuggestion] = []
        for entry in ordered:
            cand_id = int(entry["id"])
            data = by_id.get(cand_id)
            if data is None:
                continue
            suggestions.append(
                NeighborSuggestion(
                    tileset_slug=data["tileset_slug"],
                    metatile_index=data["metatile_index"],
                    probability=float(entry.get("probability", 0.0)),
                    support_count=int(entry.get("freq", 0)),
                    behavior_id=data["behavior_id"],
                    is_walkable=data["is_walkable"],
                    phash_hex=data["phash_hex"],
                    seed_tags_sample=[],
                )
            )

        return SuggestNeighborsResponse(
            seed_tileset_slug=request.tileset_slug,
            seed_metatile_index=request.metatile_index,
            direction=request.direction,
            total_observations=int(total_observations),
            entropy=float(entropy),
            suggestions=suggestions,
        )


# ---------------------------------------------------------------------------
# 8H-3 - tileset library (READ)
# ---------------------------------------------------------------------------


class LibraryEntry(BaseModel):
    slug: str
    display_name: str
    family: str
    is_secondary: bool
    source: str
    source_commit: str | None
    license_spdx: str | None
    attribution: str | None
    metatile_count: int
    palette_count: int


class LibraryResponse(BaseModel):
    total_tilesets: int
    entries: list[LibraryEntry]


@router.get("/tilesets/library", response_model=LibraryResponse)
async def tileset_library_endpoint(
    family: str | None = None,
    is_secondary: bool | None = None,
    source: str | None = None,
    license_spdx: str | None = None,
    limit: int = 100,
    offset: int = 0,
    factory: SqlAlchemyStorageFactory = Depends(get_storage_factory_dependency),
) -> LibraryResponse:
    """Phase 8H-3 - Filterable list of tilesets currently in the
    global library. Read-only. Pagination via `limit` + `offset`."""

    if limit < 1 or limit > 500:
        raise HTTPException(status_code=400, detail="limit must be in 1..500")
    if offset < 0:
        raise HTTPException(status_code=400, detail="offset must be >= 0")

    with factory.session() as session:
        q = select(Tileset).where(Tileset.scope == "global")
        if family is not None:
            q = q.where(Tileset.family == family)
        if is_secondary is not None:
            q = q.where(Tileset.is_secondary == is_secondary)
        if source is not None:
            q = q.where(Tileset.source == source)
        if license_spdx is not None:
            q = q.where(Tileset.license_spdx == license_spdx)

        total_q = q.order_by(None)
        total = sum(1 for _ in session.execute(total_q).scalars())

        q = q.order_by(Tileset.slug).limit(limit).offset(offset)
        rows = session.execute(q).scalars().all()

        entries: list[LibraryEntry] = []
        for ts in rows:
            # Per-tileset counts in two cheap queries.
            from tile_intel.domain.models import Metatile as MT, Palette as PL

            metatile_count = sum(
                1
                for _ in session.execute(
                    select(MT.id).where(MT.tileset_id == ts.id)
                ).scalars()
            )
            palette_count = sum(
                1
                for _ in session.execute(
                    select(PL.id).where(PL.tileset_id == ts.id)
                ).scalars()
            )
            entries.append(
                LibraryEntry(
                    slug=ts.slug,
                    display_name=ts.display_name,
                    family=ts.family,
                    is_secondary=ts.is_secondary,
                    source=ts.source,
                    source_commit=ts.source_commit,
                    license_spdx=ts.license_spdx,
                    attribution=ts.attribution,
                    metatile_count=metatile_count,
                    palette_count=palette_count,
                )
            )

        return LibraryResponse(total_tilesets=total, entries=entries)


# ---------------------------------------------------------------------------
# 8H-4 - template apply
# ---------------------------------------------------------------------------


class TemplateAnchor(BaseModel):
    x: int = Field(ge=0, le=1024)
    y: int = Field(ge=0, le=1024)


class ApplyTemplateRequest(BaseModel):
    template_slug: str = Field(min_length=1, max_length=200)
    anchor: TemplateAnchor
    # Optional bindings - slot name → tag substitution. The v1
    # resolver doesn't use these (templates have concrete metatile
    # IDs in `cells`); we accept them for forward-compat with the
    # tag-slotted template work in 8F-2b.
    tag_bindings: dict[str, str] = Field(default_factory=dict)
    # Where the user is applying - affects out-of-bounds checks.
    map_width: int = Field(default=0xFFFF, ge=1, le=1024)
    map_height: int = Field(default=0xFFFF, ge=1, le=1024)


class ApplyTemplateCell(BaseModel):
    x: int
    y: int
    tileset_slug: str
    metatile_index: int


class ApplyTemplateResponse(BaseModel):
    template_slug: str
    role: str
    width: int
    height: int
    cells: list[ApplyTemplateCell]
    cells_out_of_bounds: int


@router.post("/templates/apply", response_model=ApplyTemplateResponse)
async def apply_template_endpoint(
    request: ApplyTemplateRequest,
    factory: SqlAlchemyStorageFactory = Depends(get_storage_factory_dependency),
) -> ApplyTemplateResponse:
    """Phase 8H-4 - Emit the metatile placements implied by anchoring
    `template_slug` at `anchor.x`, `anchor.y`. The result is a flat
    list of `(x, y, tileset_slug, metatile_index)` records that the
    TS tool turns into a `propose_paint_map_blocks` proposal.

    Cells that would land outside the map's bounds are filtered out
    + counted in `cells_out_of_bounds`."""

    with factory.session() as session:
        template = (
            session.execute(
                select(Template).where(Template.slug == request.template_slug)
            )
            .scalars()
            .first()
        )
        if template is None:
            raise HTTPException(
                status_code=404,
                detail=f"template not found: {request.template_slug!r}",
            )

        cells: list[ApplyTemplateCell] = []
        out_of_bounds = 0
        for ty in range(template.height):
            for tx in range(template.width):
                gx, gy = request.anchor.x + tx, request.anchor.y + ty
                if not (0 <= gx < request.map_width and 0 <= gy < request.map_height):
                    out_of_bounds += 1
                    continue
                row = (
                    template.cells[ty] if ty < len(template.cells) else []
                )
                cell = row[tx] if tx < len(row) else {}
                ts_slug = cell.get("tilesetSlug")
                idx = cell.get("metatileIndex")
                if ts_slug is None or idx is None:
                    continue
                cells.append(
                    ApplyTemplateCell(
                        x=gx,
                        y=gy,
                        tileset_slug=str(ts_slug),
                        metatile_index=int(idx),
                    )
                )

        return ApplyTemplateResponse(
            template_slug=template.slug,
            role=template.role,
            width=template.width,
            height=template.height,
            cells=cells,
            cells_out_of_bounds=out_of_bounds,
        )
