"""Phase 8C-1 - Seed endpoint."""

from __future__ import annotations

from fastapi import APIRouter, Depends
from pydantic import BaseModel

from tile_intel.api.ingest import get_storage_factory_dependency
from tile_intel.ingest.ontology import seed_ontology
from tile_intel.ingest.structural_tags import apply_structural_tags
from tile_intel.storage.base import SqlAlchemyStorageFactory

router = APIRouter(prefix="/v1/seed", tags=["seed"])


class SeedOntologyResponse(BaseModel):
    behaviors_upserted: int
    tags_upserted: int
    metatile_tags_applied: int


@router.post("/ontology", response_model=SeedOntologyResponse)
async def seed_ontology_endpoint(
    factory: SqlAlchemyStorageFactory = Depends(get_storage_factory_dependency),
) -> SeedOntologyResponse:
    """Idempotent ontology seed.

    Loads `tile-intel-svc/data/{behaviors-frlg,behaviors-rse,
    tag-taxonomy,behavior-to-tags}.json` and upserts:
      - `behaviors` rows (one per (family, id))
      - `tag_taxonomy` rows (6-axis hierarchy)
      - `metatile_tags` rows derived from the curated
        behavior->tags mapping, applied to every existing
        Metatile row

    Returns the counts of each upsert kind.
    """

    report = seed_ontology(factory)
    return SeedOntologyResponse(
        behaviors_upserted=report.behaviors_upserted,
        tags_upserted=report.tags_upserted,
        metatile_tags_applied=report.metatile_tags_applied,
    )


class SeedStructuralResponse(BaseModel):
    metatiles_examined: int
    tags_emitted: int


@router.post("/structural", response_model=SeedStructuralResponse)
async def seed_structural_endpoint(
    factory: SqlAlchemyStorageFactory = Depends(get_storage_factory_dependency),
) -> SeedStructuralResponse:
    """Phase 8C-2 - Apply composition-based structural heuristics
    (filler / edge / corner_* / transition / anchor) to every metatile.

    Replaces existing heuristic tags but preserves behavior-inference,
    LLM, and human-curated tags. Run after `/v1/seed/ontology` so the
    taxonomy slugs are in place.
    """

    report = apply_structural_tags(factory)
    return SeedStructuralResponse(
        metatiles_examined=report.metatiles_examined,
        tags_emitted=report.tags_emitted,
    )
