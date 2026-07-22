"""Phase 8C-3 - Rules endpoints.

  POST /v1/rules/rebuild - derive adjacency_rules from observations.
  GET  /v1/rules/neighbors - query the derived rules: "what metatiles
                             legally go in direction D after metatile A?".
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select

from tile_intel.api.ingest import get_storage_factory_dependency
from tile_intel.domain.models import AdjacencyPattern, AdjacencyRule
from tile_intel.ingest.adjacency_rules import rebuild_adjacency_rules
from tile_intel.storage.base import SqlAlchemyStorageFactory

router = APIRouter(prefix="/v1/rules", tags=["rules"])


class RebuildAdjacencyRulesRequest(BaseModel):
    """Inputs for the rebuild endpoint."""

    threshold: float = Field(default=0.005, ge=0.0, le=1.0)
    scope: str = Field(default="global", pattern="^(global|project|merged)$")
    project_id: str | None = None


class RebuildAdjacencyRulesResponse(BaseModel):
    rules_built: int
    observations_aggregated: int
    threshold: float


@router.post("/rebuild", response_model=RebuildAdjacencyRulesResponse)
async def rebuild_endpoint(
    request: RebuildAdjacencyRulesRequest | None = None,
    factory: SqlAlchemyStorageFactory = Depends(get_storage_factory_dependency),
) -> RebuildAdjacencyRulesResponse:
    """Re-derive adjacency_rules from adjacency_observations. Idempotent.

    `scope='global'` aggregates over only the pret-derived vanilla
    observations. `scope='project'` requires `project_id` and aggregates
    that project's own observations. `scope='merged'` does both."""

    req = request or RebuildAdjacencyRulesRequest()
    if req.scope in ("project", "merged") and not req.project_id:
        raise HTTPException(
            status_code=400,
            detail=f"scope={req.scope} requires project_id",
        )
    report = rebuild_adjacency_rules(
        factory,
        threshold=req.threshold,
        scope=req.scope,
        project_id=req.project_id,
    )
    return RebuildAdjacencyRulesResponse(
        rules_built=report.rules_built,
        observations_aggregated=report.observations_aggregated,
        threshold=report.threshold,
    )


class LegalNeighborEntry(BaseModel):
    metatile_b: int
    probability: float
    freq: int


class NeighborsResponse(BaseModel):
    metatile_a: int
    direction: int
    scope: str
    total_observations: int
    entropy: float
    legal_neighbors: list[LegalNeighborEntry]
    hard_legal_set: list[int]


@router.get("/neighbors", response_model=NeighborsResponse)
async def neighbors_endpoint(
    metatile_a: int,
    direction: int,
    scope: str = "global",
    project_id: str | None = None,
    factory: SqlAlchemyStorageFactory = Depends(get_storage_factory_dependency),
) -> NeighborsResponse:
    """Phase 8C-3 - query the derived rules.

    Returns the full legal_neighbors distribution + hard_legal_set
    + entropy for one (metatile_a, direction) pair at the given scope.

    Direction encoding: N=0, NE=1, E=2, SE=3, S=4, SW=5, W=6, NW=7
    (matches the corpus builder's enum)."""

    if direction < 0 or direction > 7:
        raise HTTPException(status_code=400, detail="direction must be 0..7")
    with factory.session() as session:
        row = session.execute(
            select(AdjacencyRule).where(
                AdjacencyRule.metatile_a == metatile_a,
                AdjacencyRule.direction == direction,
                AdjacencyRule.scope == scope,
                AdjacencyRule.project_id == project_id,
            )
        ).scalar_one_or_none()
        if row is None:
            raise HTTPException(
                status_code=404,
                detail=(
                    f"no rule for metatile_a={metatile_a} direction={direction} "
                    f"scope={scope} project_id={project_id}. Run "
                    f"POST /v1/rules/rebuild first."
                ),
            )
        return NeighborsResponse(
            metatile_a=row.metatile_a,
            direction=row.direction,
            scope=row.scope,
            total_observations=row.total_observations,
            entropy=float(row.entropy),
            legal_neighbors=[
                LegalNeighborEntry(**entry) for entry in row.legal_neighbors
            ],
            hard_legal_set=list(row.hard_legal_set),
        )


class PatternEntry(BaseModel):
    """One aggregated 3x3 pattern."""

    pattern_shape: str
    cells: list[dict]
    role: str
    total_frequency: int
    source_corpora: list[str]


class PatternsResponse(BaseModel):
    patterns: list[PatternEntry]


@router.get("/patterns", response_model=PatternsResponse)
async def patterns_endpoint(
    min_frequency: int = 5,
    limit: int = 100,
    scope: str = "global",
    factory: SqlAlchemyStorageFactory = Depends(get_storage_factory_dependency),
) -> PatternsResponse:
    """Phase 8C-4 - query 3x3 patterns whose CROSS-SOURCE summed
    frequency meets `min_frequency`. Aggregates across all
    source_corpus rows for the same pattern_hash at query time.

    Default threshold of 5 matches the Phase 8 plan
    ("Patterns appearing >= 5 times become adjacency_patterns rows").
    """

    with factory.session() as session:
        # Aggregate cross-source in Python - SQLite + Postgres differ
        # on string_agg vs group_concat and the corpora list is small
        # (≤ 10 distinct sources) so the cost is negligible compared to
        # the pattern-row count cap (limit ≤ 100 typical).
        rows = session.execute(
            select(
                AdjacencyPattern.pattern_hash,
                AdjacencyPattern.pattern_shape,
                AdjacencyPattern.cells,
                AdjacencyPattern.role,
                AdjacencyPattern.frequency,
                AdjacencyPattern.source_corpus,
            ).where(AdjacencyPattern.scope == scope)
        ).all()

        bucket: dict[bytes, dict] = {}
        for pattern_hash, shape, cells, role, freq, source_corpus in rows:
            existing = bucket.get(pattern_hash)
            if existing is None:
                bucket[pattern_hash] = {
                    "shape": shape,
                    "cells": cells,
                    "role": role,
                    "total_freq": int(freq),
                    "sources": {source_corpus},
                }
            else:
                existing["total_freq"] += int(freq)
                existing["sources"].add(source_corpus)

        entries = [
            PatternEntry(
                pattern_shape=v["shape"],
                cells=list(v["cells"]),
                role=v["role"],
                total_frequency=v["total_freq"],
                source_corpora=sorted(v["sources"]),
            )
            for v in bucket.values()
            if v["total_freq"] >= min_frequency
        ]
        entries.sort(key=lambda e: -e.total_frequency)
        return PatternsResponse(patterns=entries[:limit])
